// Temporary smoke test: Entra ID JWT validation and app-role gating.
//
// Stands up a local JWKS endpoint and signs tokens with a generated key so the
// real signature/issuer/audience/role validation runs without an Entra tenant.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const JWKS_PORT = Number(process.env.JWKS_PORT || '3210');
const APP_PORT = process.env.SMOKE_PORT || '3115';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const TENANT = '11111111-2222-3333-4444-555555555555';
const AUDIENCE = 'api://crayon-cost-mcp';
const AUTHORITY_HOST = `127.0.0.1:${JWKS_PORT}`;
const ISSUER = `https://${AUTHORITY_HOST}/${TENANT}/v2.0`;

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };

// Minimal JWKS endpoint standing in for Entra's discovery document.
const jwksServer = createServer((req, res) => {
  if (req.url?.includes('/discovery/v2.0/keys')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => jwksServer.listen(JWKS_PORT, '127.0.0.1', r));

async function signToken({ roles = [], scopes, audience = AUDIENCE } = {}) {
  const payload = { oid: 'user-object-id', preferred_username: 'user@example.com' };
  if (roles.length) payload.roles = roles;
  if (scopes) payload.scp = scopes;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: APP_PORT,
    HOST: '127.0.0.1',
    AUTH_MODE: 'entra',
    ENTRA_TENANT_ID: TENANT,
    ENTRA_AUTHORITY_HOST: AUTHORITY_HOST,
    ENTRA_JWKS_URI: `http://${AUTHORITY_HOST}/discovery/v2.0/keys`,
    ENTRA_AUDIENCE: AUDIENCE,
    ENTRA_READ_ROLE: 'user.read',
    ENTRA_WRITE_ROLE: 'user.write',
    ALLOWED_ORGANIZATIONS: '4040561',
    ALLOWED_WRITE_ORGANIZATIONS: '4040561',
    CRAYON_CLIENT_ID: 'dummy',
    CRAYON_CLIENT_SECRET: 'dummy',
    CRAYON_USERNAME: 'dummy',
    CRAYON_PASSWORD: 'dummy',
    LOG_LEVEL: 'error',
  },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (label, fn) => {
  try { results.push(`${label}: ${await fn()}`); }
  catch (err) { results.push(`${label}: THREW ${err.message}`); }
};
const parseSse = (t) => {
  const line = t.split('\n').find((l) => l.startsWith('data: '));
  return line ? JSON.parse(line.slice(6)) : null;
};

async function main() {
  for (let i = 0; i < 40; i++) {
    await wait(250);
    try { await fetch(`${BASE}/health`); break; } catch { /* retry */ }
  }

  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'smoke', version: '1.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  const callTool = async (token, tool, args) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': tool,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args, _meta: envelope } }),
    });
    const text = await r.text();
    return { status: r.status, json: parseSse(text) ?? (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };

  const readOnly = await signToken({ roles: ['user.read'] });
  const readWrite = await signToken({ roles: ['user.read', 'user.write'] });
  const noRoles = await signToken({});
  const wrongAudience = await signToken({ roles: ['user.read'], audience: 'api://someone-else' });

  await check('READ with user.read', async () => {
    const { json } = await callTool(readOnly, 'get_invoices', { organizationId: 4040561 });
    const text = json?.result?.content?.[0]?.text ?? '';
    return `passedGate=${!text.includes('Forbidden')} notAuthError=${json?.error === undefined}`;
  });

  await check('WRITE with user.read only (denied)', async () => {
    const { json } = await callTool(readOnly, 'update_subscription_tags', { subscriptionId: 1, tags: { a: 'b' }, organizationId: 4040561 });
    const text = json?.result?.content?.[0]?.text ?? '';
    return `isError=${json?.result?.isError} denied=${text.includes("user.write")} raw=${JSON.stringify(json).slice(0, 300)}`;
  });

  await check('WRITE with user.write (allowed)', async () => {
    const { json } = await callTool(readWrite, 'update_subscription_tags', { subscriptionId: 1, tags: { a: 'b' }, organizationId: 4040561 });
    const text = json?.result?.content?.[0]?.text ?? '';
    return `passedGate=${!text.includes('Forbidden')} notAuthError=${json?.error === undefined}`;
  });

  await check('READ with no roles (denied)', async () => {
    const { json } = await callTool(noRoles, 'get_invoices', { organizationId: 4040561 });
    const text = json?.result?.content?.[0]?.text ?? '';
    return `isError=${json?.result?.isError} denied=${text.includes("user.read")} raw=${JSON.stringify(json).slice(0, 300)}`;
  });

  await check('WRONG AUDIENCE token rejected (401)', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${wrongAudience}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    return `status=${r.status}`;
  });

  await check('GARBAGE token rejected (401)', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-jwt',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    return `status=${r.status}`;
  });

  await check('NO token rejected (401)', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    return `status=${r.status}`;
  });
}

try {
  await main();
} finally {
  child.kill();
  jwksServer.close();
}

console.log(results.join('\n'));
