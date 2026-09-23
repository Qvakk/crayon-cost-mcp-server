/**
 * Environment configuration with validation and defaults
 */
export interface AppConfig {
  // Server
  port: number;
  host: string;
  nodeEnv: string;
  
  // Authentication
  authEnabled: boolean;
  authMode: AuthMode;
  authToken: string | null;

  // Entra ID (Azure AD) token validation
  entraTenantId: string | null;
  /** Authority host. Override for sovereign clouds (e.g. login.microsoftonline.us). */
  entraAuthorityHost: string;
  /** Explicit JWKS URL. Overrides the URL derived from the authority host. */
  entraJwksUri: string | null;
  entraAudience: string | null;
  entraRequiredScope: string | null;
  /** App role required for read-only tool calls. */
  entraReadRole: string;
  /** App role required for mutating (write/edit) tool calls. */
  entraWriteRole: string;

  allowedOrganizations: number[];
  /** Organization IDs a write-capable caller may mutate. Empty = all allowed orgs. */
  allowedWriteOrganizations: number[];
  
  // Crayon API
  crayonClientId: string;
  crayonClientSecret: string;
  crayonUsername: string;
  crayonPassword: string;
  crayonApiBaseUrl: string;
  
  // Rate Limiting
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  
  // Circuit Breaker
  apiTimeoutMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerTimeoutMs: number;
  
  // Session
  /**
   * Interval for periodic housekeeping (currently: pruning expired circuit-breaker
   * metric snapshots is handled internally by opossum). Kept as a named knob so
   * operators can tune housekeeping frequency without a code change.
   */
  sessionCleanupIntervalMs: number;
  
  // Request
  requestTimeoutMs: number;
  
  // Logging
  logLevel: string;
}

/**
 * Authentication strategies.
 *
 * - `none`  : auth disabled (local development only).
 * - `token` : legacy single shared `AUTH_TOKEN`, compared in constant time.
 *             Kept for local/compose use; not suitable for the APIM-fronted
 *             Container App deployment.
 * - `entra` : Entra ID (Azure AD) OAuth2 access tokens with app-role and
 *             scope validation. This is the mode used behind APIM.
 */
export type AuthMode = 'none' | 'token' | 'entra';

/**
 * Configuration validation errors
 */
class ConfigValidationError extends Error {
  constructor(
    public readonly errors: string[]
  ) {
    super(`Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parse and validate environment configuration
 */
export function loadConfig(): AppConfig {
  const errors: string[] = [];
  // Helper functions
  const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      errors.push(`Missing required environment variable: ${name}`);
      return '';
    }
    return value;
  };
  
  const optionalEnv = (name: string, defaultValue: string): string => {
    return process.env[name] || defaultValue;
  };
  
  const parseIntEnv = (name: string, defaultValue: number): number => {
    const value = process.env[name];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      errors.push(`Invalid integer for ${name}: ${value}`);
      return defaultValue;
    }
    return parsed;
  };
  
  const parseBoolEnv = (name: string, defaultValue: boolean): boolean => {
    const value = process.env[name];
    if (!value) return defaultValue;
    return value.toLowerCase() !== 'false';
  };
  
  const parseArrayEnv = (name: string): number[] => {
    const value = process.env[name];
    if (!value) return [];
    return value.split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  };

  // Auth configuration
  const authEnabled = parseBoolEnv('AUTH_ENABLED', true);
  const authToken = process.env.AUTH_TOKEN || null;

  // Explicit AUTH_MODE wins; otherwise infer from what has been configured so
  // existing deployments (AUTH_TOKEN only) keep working unchanged.
  const configuredAuthMode = (process.env.AUTH_MODE || '').toLowerCase();
  const entraConfigured = Boolean(process.env.ENTRA_TENANT_ID || process.env.ENTRA_AUDIENCE);

  let authMode: AuthMode;
  if (!authEnabled) {
    authMode = 'none';
  } else if (configuredAuthMode === 'entra' || (configuredAuthMode === '' && entraConfigured)) {
    authMode = 'entra';
  } else if (configuredAuthMode === 'token' || configuredAuthMode === '' || configuredAuthMode === 'none') {
    // `AUTH_ENABLED=true` with no Entra config means the legacy shared token.
    authMode = configuredAuthMode === 'none' ? 'none' : 'token';
  } else {
    errors.push(`Invalid AUTH_MODE: ${configuredAuthMode}. Must be 'entra', 'token' or 'none'`);
    authMode = 'token';
  }

  const entraTenantId = process.env.ENTRA_TENANT_ID || null;
  // Sovereign clouds use a different authority host (e.g. login.microsoftonline.us).
  const entraAuthorityHost = optionalEnv('ENTRA_AUTHORITY_HOST', 'login.microsoftonline.com');
  // Explicit JWKS URL: needed behind private endpoints / proxies, and for testing.
  const entraJwksUri = process.env.ENTRA_JWKS_URI || null;
  const entraAudience = process.env.ENTRA_AUDIENCE || null;
  const entraRequiredScope = process.env.ENTRA_REQUIRED_SCOPE || null;
  const entraReadRole = optionalEnv('ENTRA_READ_ROLE', 'user.read');
  const entraWriteRole = optionalEnv('ENTRA_WRITE_ROLE', 'user.write');

  // Per-mode requirements
  if (authMode === 'token' && !authToken) {
    errors.push('AUTH_TOKEN is required when AUTH_MODE is "token" (or set AUTH_MODE=entra)');
  }

  if (authMode === 'entra') {
    if (!entraTenantId) {
      errors.push('ENTRA_TENANT_ID is required when AUTH_MODE is "entra"');
    } else if (!/^[0-9a-fA-F-]{36}$|^[a-zA-Z0-9.-]+$/.test(entraTenantId)) {
      errors.push(`Invalid ENTRA_TENANT_ID: ${entraTenantId}. Expected a tenant GUID or domain`);
    }
    // Accept both a bare client id and the `api://<client-id>` form.
    if (!entraAudience) {
      errors.push('ENTRA_AUDIENCE is required when AUTH_MODE is "entra" (e.g. api://<api-client-id>)');
    }
    if (!entraReadRole) {
      errors.push('ENTRA_READ_ROLE must not be empty when AUTH_MODE is "entra"');
    }
    if (!entraWriteRole) {
      errors.push('ENTRA_WRITE_ROLE must not be empty when AUTH_MODE is "entra"');
    }
  }

  const allowedOrganizations = parseArrayEnv('ALLOWED_ORGANIZATIONS');
  const allowedWriteOrganizations = parseArrayEnv('ALLOWED_WRITE_ORGANIZATIONS');

  // Warn (don't fail) if write orgs are not a subset of read orgs — that would
  // grant write access to an organization the caller cannot even read.
  if (
    allowedWriteOrganizations.length > 0 &&
    allowedOrganizations.length > 0 &&
    allowedWriteOrganizations.some((id) => !allowedOrganizations.includes(id))
  ) {
    console.warn(
      'WARNING: ALLOWED_WRITE_ORGANIZATIONS contains organization IDs not present in ALLOWED_ORGANIZATIONS'
    );
  }
  
  // Build configuration
  const config: AppConfig = {
    // Server
    port: parseIntEnv('PORT', 3003),
    host: optionalEnv('HOST', '0.0.0.0'),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    
    // Authentication
    authEnabled,
    authMode,
    authToken,

    // Entra ID (Azure AD)
    entraTenantId,
    entraAuthorityHost,
    entraJwksUri,
    entraAudience,
    entraRequiredScope,
    entraReadRole,
    entraWriteRole,

    allowedOrganizations,
    allowedWriteOrganizations,
    
    // Crayon API
    crayonClientId: requireEnv('CRAYON_CLIENT_ID'),
    crayonClientSecret: requireEnv('CRAYON_CLIENT_SECRET'),
    crayonUsername: requireEnv('CRAYON_USERNAME'),
    crayonPassword: requireEnv('CRAYON_PASSWORD'),
    crayonApiBaseUrl: optionalEnv('CRAYON_API_BASE_URL', 'https://api.crayon.com/api/v1'),
    
    // Rate Limiting
    rateLimitWindowMs: parseIntEnv('RATE_LIMIT_WINDOW_MS', 60000),
    rateLimitMaxRequests: parseIntEnv('RATE_LIMIT_MAX_REQUESTS', 100),
    
    // Circuit Breaker
    apiTimeoutMs: parseIntEnv('API_TIMEOUT_MS', 30000),
    circuitBreakerThreshold: parseIntEnv('CIRCUIT_BREAKER_THRESHOLD', 50),
    circuitBreakerTimeoutMs: parseIntEnv('CIRCUIT_BREAKER_TIMEOUT_MS', 30000),
    
    // Session
    /** Interval for periodic housekeeping, in milliseconds. */
    sessionCleanupIntervalMs: parseIntEnv('SESSION_CLEANUP_INTERVAL_MS', 60000),
    
    // Request
    requestTimeoutMs: parseIntEnv('REQUEST_TIMEOUT_MS', 60000),
    
    // Logging
    logLevel: optionalEnv('LOG_LEVEL', 'error'),
  };
  
  // Validate port range
  if (config.port < 1 || config.port > 65535) {
    errors.push(`Invalid PORT: ${config.port}. Must be between 1 and 65535`);
  }
  
  // Validate percentage
  if (config.circuitBreakerThreshold < 0 || config.circuitBreakerThreshold > 100) {
    errors.push(`Invalid CIRCUIT_BREAKER_THRESHOLD: ${config.circuitBreakerThreshold}. Must be 0-100`);
  }
  
  // Throw if validation errors
  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }
  
  return config;
}

/**
 * Global application metrics
 */
export interface AppMetrics {
  startTime: number;
  requestCount: number;
  errorCount: number;
  /** Invocation count per tool name. */
  toolCalls: Record<string, number>;
  circuitBreakerTrips: number;
}

/**
 * Create initial metrics object
 */
export function createMetrics(): AppMetrics {
  return {
    startTime: Date.now(),
    requestCount: 0,
    errorCount: 0,
    toolCalls: {},
    circuitBreakerTrips: 0,
  };
}

/**
 * Memoized configuration.
 *
 * `loadConfig()` is called at import time in more than one module; caching the
 * result keeps validation a one-time cost and guarantees every module sees the
 * identical, already-validated configuration object.
 */
let cachedConfig: AppConfig | null = null;

export function resolveConfig(): AppConfig {
  if (cachedConfig === null) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}
