/**
 * Authentication & authorization middleware.
 *
 * Supported strategies (selected by `AUTH_MODE`):
 *
 * - `entra`  — Entra ID (Azure AD) OAuth2 access tokens. Signature, issuer,
 *              audience, expiry and (optionally) scope are validated locally
 *              against the tenant JWKS, and the `roles` claim is mapped to the
 *              `user.read` / `user.write` app roles.
 * - `token`  — legacy single shared `AUTH_TOKEN`, compared in constant time.
 *              Retained for local/docker-compose use.
 * - `none`   — auth disabled; development only.
 *
 * In the production topology (Azure Container Apps behind Application Gateway
 * and API Management) the `entra` mode is authoritative. APIM validates the
 * incoming user token and gates on scopes/app roles, but the container must
 * still validate independently: a misconfigured or bypassed gateway must not
 * turn into unauthenticated access to Crayon cost data.
 */
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { logger } from './logger.js';
import { resolveConfig, type AppConfig } from '../utils/config.js';

/**
 * Memoized, pre-validated configuration shared across the process.
 */
const config: AppConfig = resolveConfig();

// Allowed organizations (comma-separated IDs, e.g. "4040561,4019092").
const ALLOWED_ORGANIZATIONS = config.allowedOrganizations;

if (ALLOWED_ORGANIZATIONS.length === 0 && config.authMode !== 'none') {
  console.warn('WARNING: ALLOWED_ORGANIZATIONS not set. Access will be restricted.');
}

/** App role names as they appear in the token's `roles` claim. */
const APP_ROLE_READ = config.entraReadRole;
const APP_ROLE_WRITE = config.entraWriteRole;

// Extend Express Request with the MCP SDK's auth pass-through slot. The Node
// Streamable HTTP transport reads `req.auth` and surfaces it to tool handlers as
// `ctx.http.authInfo` — that is the only identity channel the gate uses.
declare global {
  namespace Express {
    interface Request {
      auth?: {
        token: string;
        clientId: string;
        scopes: string[];
        extra?: Record<string, unknown>;
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Entra ID token validation
// ---------------------------------------------------------------------------

/**
 * JWKS clients are cached per tenant. `createRemoteJWKSet` already caches keys
 * in memory and refreshes on key rotation; we only memoize the client itself so
 * it is not re-created per request.
 */
const jwksByTenant = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(tenantId: string) {
  let jwks = jwksByTenant.get(tenantId);
  if (!jwks) {
    const uri =
      config.entraJwksUri ??
      `https://${config.entraAuthorityHost}/${tenantId}/discovery/v2.0/keys`;
    jwks = createRemoteJWKSet(new URL(uri));
    jwksByTenant.set(tenantId, jwks);
  }
  return jwks;
}

/**
 * Accepted `aud` values. Entra emits the bare client id for v1-style tokens and
 * `api://<client-id>` for v2 tokens, so accept both forms of the configured
 * audience.
 */
function acceptedAudiences(audience: string): string[] {
  const bare = audience.startsWith('api://') ? audience.slice('api://'.length) : audience;
  return [...new Set([audience, bare, `api://${bare}`])];
}

/** Stable, non-reversible identifier for logging (never log raw tokens). */
function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

interface EntraIdentity {
  objectId: string;
  email: string;
  roles: string[];
  scopes: string[];
}

/**
 * Verifies an Entra ID access token and extracts identity, roles and scopes.
 * Throws on any validation failure — never returns a partially trusted result.
 */
async function verifyEntraToken(token: string): Promise<EntraIdentity> {
  const { entraTenantId, entraAuthorityHost, entraAudience, entraRequiredScope } = config;

  if (!entraTenantId || !entraAudience) {
    // loadConfig() enforces this in entra mode; defensive guard for clarity.
    throw new Error('Entra authentication is not fully configured');
  }

  const { payload } = await jwtVerify(token, getJwks(entraTenantId), {
    // v2 endpoints emit the v2.0 issuer; v1 tokens use sts.windows.net.
    issuer: [
      `https://${entraAuthorityHost}/${entraTenantId}/v2.0`,
      `https://sts.windows.net/${entraTenantId}/`,
    ],
    audience: acceptedAudiences(entraAudience),
  });

  const claims = payload as JWTPayload & {
    roles?: unknown;
    scp?: unknown;
    oid?: unknown;
    preferred_username?: unknown;
    upn?: unknown;
  };

  // `roles` is only present for app-role assignments. `scp` carries delegated
  // scopes — a token carries one or the other, never both.
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((r): r is string => typeof r === 'string')
    : [];
  const scopes = typeof claims.scp === 'string' ? claims.scp.split(' ').filter(Boolean) : [];

  // Optional scope requirement. App-only (client-credentials) tokens carry
  // `roles` and no `scp`, so skip the check there to keep service-to-service
  // calls working.
  if (entraRequiredScope) {
    const isAppOnly = roles.length > 0 && scopes.length === 0;
    if (!isAppOnly && !scopes.includes(entraRequiredScope)) {
      throw new Error(`Token is missing the required scope '${entraRequiredScope}'`);
    }
  }

  const objectId =
    typeof claims.oid === 'string' ? claims.oid : typeof claims.sub === 'string' ? claims.sub : 'unknown';
  const email =
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    (typeof claims.upn === 'string' && claims.upn) ||
    'unknown';

  return { objectId, email: email || 'unknown', roles, scopes };
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the caller token.
 *
 * `X-Inbound-Authorization` is preferred when present because APIM can be
 * configured to place the validated user token there, leaving `Authorization`
 * free for the gateway's own credential. `X-Forwarded-*` headers are
 * deliberately NOT trusted — they are client-spoofable.
 */
function extractToken(req: Request): string | null {
  const inbound = req.headers['x-inbound-authorization'];
  const header = (Array.isArray(inbound) ? inbound[0] : inbound) || req.headers.authorization;
  if (!header) return null;

  const value = header.trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : value || null;
}

/**
 * Publishes the authenticated caller into the MCP SDK's auth pass-through slot
 * (`req.auth`), which the Node transport forwards to tool handlers as
 * `ctx.http.authInfo`.
 */
function setAuthenticatedIdentity(
  req: Request,
  identity: { id: string; email: string; roles: string[]; scopes: string[]; token: string }
): void {
  req.auth = {
    token: identity.token,
    clientId: identity.id,
    scopes: identity.scopes,
    extra: {
      email: identity.email,
      organizations: ALLOWED_ORGANIZATIONS,
      roles: identity.roles,
      authMode: config.authMode,
    },
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Development-only identity. Deliberately grants read+write so local runs are
 * not silently degraded; unreachable unless the operator explicitly sets
 * `AUTH_ENABLED=false` or `AUTH_MODE=none`.
 */
function setDevelopmentIdentity(req: Request): void {
  setAuthenticatedIdentity(req, {
    id: 'dev-user',
    email: 'dev@example.com',
    roles: [APP_ROLE_READ, APP_ROLE_WRITE],
    scopes: [APP_ROLE_READ, APP_ROLE_WRITE],
    token: 'dev-token',
  });
}

/** Legacy shared-secret authentication. */
function authenticateWithSharedToken(req: Request, res: Response, next: NextFunction, token: string): void {
  const validToken = config.authToken;

  if (!validToken) {
    logger.error('Server misconfiguration: AUTH_TOKEN not set');
    res.status(500).json({ error: 'Server authentication not configured' });
    return;
  }

  // Constant-time comparison to prevent timing attacks.
  const tokenBuffer = Buffer.from(token);
  const validBuffer = Buffer.from(validToken);
  if (tokenBuffer.length !== validBuffer.length || !timingSafeEqual(tokenBuffer, validBuffer)) {
    logger.error('Authentication failed: Invalid token');
    res.status(401).json({ error: 'Invalid authentication token' });
    return;
  }

  // The shared token is a trusted service identity and carries both roles.
  setAuthenticatedIdentity(req, {
    id: 'api-user',
    email: 'api@crayon-cost-mcp.local',
    roles: [APP_ROLE_READ, APP_ROLE_WRITE],
    scopes: [APP_ROLE_READ, APP_ROLE_WRITE],
    token,
  });
  next();
}

/** Entra ID JWT authentication with app-role mapping. */
function authenticateWithEntra(req: Request, res: Response, next: NextFunction, token: string): void {
  verifyEntraToken(token)
    .then((identity) => {
      setAuthenticatedIdentity(req, {
        id: identity.objectId,
        email: identity.email,
        // Only advertise roles this deployment recognises, so a caller cannot
        // smuggle an unrecognised role name past a gate.
        roles: identity.roles.filter((r) => r === APP_ROLE_READ || r === APP_ROLE_WRITE),
        scopes: identity.scopes,
        token,
      });
      next();
    })
    .catch((error: unknown) => {
      // A rejected token is a routine client condition (expiry, wrong tenant),
      // but it is still security-relevant so it is logged (fingerprint only).
      const reason = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Authentication failed: Entra token rejected', {
        reason,
        tokenFingerprint: tokenFingerprint(token),
        path: req.path,
      });

      res
        .status(401)
        .setHeader('WWW-Authenticate', 'Bearer error="invalid_token"')
        .json({ error: 'Unauthorized: Invalid or expired access token' });
    });
}

/**
 * Authentication middleware — validates the caller token per `AUTH_MODE`.
 */
export function authenticateRequest(req: Request, res: Response, next: NextFunction): void {
  // Development bypass. Unreachable unless explicitly configured.
  if (config.authMode === 'none') {
    setDevelopmentIdentity(req);
    return next();
  }

  const token = extractToken(req);

  // MCP clients probe the endpoint before they hold a token, so let the
  // initialize handshake through anonymously to keep discovery working. Every
  // tool call still requires a token, and write tools require `user.write`.
  if (!token) {
    if (req.method === 'POST' && req.body?.method === 'initialize') {
      setAuthenticatedIdentity(req, {
        id: 'anonymous',
        email: 'anonymous@crayon-cost-mcp.local',
        roles: [],
        scopes: [],
        token: '',
      });
      return next();
    }

    logger.error('Authentication failed: Missing authorization header');
    res.status(401).json({ error: 'Unauthorized: Missing authorization header' });
    return;
  }

  if (config.authMode === 'token') {
    authenticateWithSharedToken(req, res, next, token);
    return;
  }

  authenticateWithEntra(req, res, next, token);
}

// ---------------------------------------------------------------------------
// Tool-level authorization
// ---------------------------------------------------------------------------

/**
 * Authorization requirements for a tool, derived from its HTTP semantics.
 *
 * Declared per tool rather than inferred from the name so an unreviewed tool
 * cannot silently become write-capable just by being named suggestively.
 */
export interface ToolPolicy {
  /** App role required to invoke the tool. */
  role: string;
  /** True when the tool mutates remote state. */
  mutation: boolean;
}

const TOOL_POLICIES: Record<string, ToolPolicy> = Object.freeze({
  // Mutating tools (Crayon PUT/POST/DELETE).
  update_subscription_tags: { role: APP_ROLE_WRITE, mutation: true },
});

/** Conservative default for tools with no explicit policy. */
const DEFAULT_TOOL_POLICY: ToolPolicy = { role: APP_ROLE_READ, mutation: false };

/** Resolves the effective policy for a tool name. */
function resolveToolPolicy(toolName: string): ToolPolicy {
  return TOOL_POLICIES[toolName] ?? DEFAULT_TOOL_POLICY;
}

/** Caller identity for an MCP tool invocation. */
export interface Caller {
  id: string;
  roles: string[];
}

/**
 * Resolves the caller identity for an MCP tool invocation.
 *
 * Identity arrives through the SDK's auth pass-through (`ctx.http.authInfo`),
 * which the Node transport populates from `req.auth`.
 *
 * A missing auth context is only legitimate when authentication is switched off
 * (`AUTH_MODE=none`, development only) — the middleware is not registered in
 * that mode, so nothing populates `req.auth`. In any authenticated mode a
 * missing context is a bug or a bypass attempt, so it resolves to a role-less
 * caller and the tool gate denies it (fail closed).
 */
export function callerFromAuthInfo(
  authInfo: { clientId?: string; extra?: Record<string, unknown> } | undefined
): Caller {
  if (!authInfo) {
    if (config.authMode === 'none') {
      return { id: 'dev-user', roles: [APP_ROLE_READ, APP_ROLE_WRITE] };
    }
    // Fail closed: never treat a lost auth context as a privileged identity.
    return { id: 'unknown', roles: [] };
  }

  const roles = Array.isArray(authInfo.extra?.roles)
    ? (authInfo.extra.roles as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  return { id: authInfo.clientId || 'unknown', roles };
}

/** MCP tool error shape returned by {@link enforceToolPolicy}. */
export interface ToolDenial {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

/** Builds the sanitized MCP error a denied caller receives. */
function deny(
  toolName: string,
  reason: string,
  meta: Record<string, unknown>
): ToolDenial {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: reason, tool: toolName, ...meta }),
      },
    ],
  };
}

/**
 * The single authorization gate for tool invocations.
 *
 * Enforces, in order:
 *  1. the tool's required app role (`user.read`, or `user.write` for mutations)
 *  2. organization allowlist membership, when `ALLOWED_ORGANIZATIONS` is set
 *  3. write-organization allowlist membership for mutations, when
 *     `ALLOWED_WRITE_ORGANIZATIONS` is set
 *
 * Returns `null` when the call is permitted, otherwise a ready-to-return MCP
 * tool error. Every denial is passed to `log` for the security audit trail.
 */
export function enforceToolPolicy(
  toolName: string,
  caller: Caller,
  organizationId: number | null | undefined,
  log: (message: string, meta: Record<string, unknown>) => void
): ToolDenial | null {
  const policy = resolveToolPolicy(toolName);
  const operation = policy.mutation ? 'write' : 'read';

  // 1. App role
  if (!caller.roles.includes(policy.role)) {
    log('Authorization failed: tool denied by app role', {
      tool: toolName,
      userId: caller.id,
      operation,
      requiredRole: policy.role,
      heldRoles: caller.roles,
    });
    return deny(toolName, `Forbidden: tool '${toolName}' requires the '${policy.role}' app role`, {
      requiredRole: policy.role,
      operation,
    });
  }

  // Organization-scoped checks only apply when the tool targets one.
  if (organizationId == null) {
    return null;
  }

  // 2. Organization allowlist
  if (ALLOWED_ORGANIZATIONS.length > 0 && !ALLOWED_ORGANIZATIONS.includes(organizationId)) {
    log('Authorization failed: organization not allowed', {
      tool: toolName,
      userId: caller.id,
      operation,
      organizationId,
    });
    return deny(toolName, `Forbidden: no access to organization ${organizationId}`, { organizationId });
  }

  // 3. Write-organization allowlist (mutations only)
  if (
    policy.mutation &&
    config.allowedWriteOrganizations.length > 0 &&
    !config.allowedWriteOrganizations.includes(organizationId)
  ) {
    log('Authorization failed: organization is not write-enabled', {
      tool: toolName,
      userId: caller.id,
      operation,
      organizationId,
    });
    return deny(toolName, `Forbidden: organization ${organizationId} is read-only`, {
      organizationId,
      operation: 'write',
    });
  }

  return null;
}
