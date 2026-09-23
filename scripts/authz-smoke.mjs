// Temporary smoke test: app-role gating (user.read / user.write) in token mode.
//
// Exercises the authorization gate end to end over HTTP without needing an
// Entra tenant: AUTH_MODE=token yields a caller holding both app roles, and we
// assert that read tools and the mutating tool are both reachable, plus that
// the organization allowlists are enforced.
import { spawn } from 'node:child_process';

const PORT = process.env.SMOKE_PORT || '3114';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'smoketest-token-0123456789abcdef';

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT,
    HOST: '127.0.0.1',
    AUTH_MODE: 'token',
    AUTH_TOKEN: TOKEN,
    ALLOWED_ORGANIZATIONS: '4040561,4019092',
    // Only 4040561 may be written to; 4019092 is read-only.
    ALLOWED_WRITE_ORGANIZATIONS: '4040561',
    ENTRA_READ_ROLE: 'user.read',
    ENTRA_WRITE_ROLE: 'user.write',
    CRAYON_CLIENT_ID: 'dummy',
    CRAYON_CLIENT_SECRET: 'dummy',
    CRAYON_USERNAME: 'dummy',
    CRAYON_PASSWORD: 'dummy',
    LOG_LEVEL: 'error',
  },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

// Surface child startup failures instead of a bare "fetch failed".
let childStderr = '';
child.stderr.on('data', (d) => { childStderr += d.toString(); });
child.on('exit', (code, signal) => {
  if (code !== null && code !== 0) {
    console.log(`CHILD EXITED code=${code} signal=${signal ?? '-'}\n${childStderr}`);
  }
});

async function check(label, fn) {
  try {
    results.push(`${label}: ${await fn()}`);
  } catch (err) {
    results.push(`${label}: THREW ${err.message}`);
  }
}

// Modern responses may be an SSE stream or a single JSON body, depending on
// whether the handler emits related messages before its result.
const parseSse = (text) => {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (line) return JSON.parse(line.slice(6));
  try { return JSON.parse(text); } catch { return null; }
};

async function main() {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await wait(250);
    try { await fetch(`${BASE}/health`); up = true; break; } catch { /* retry */ }
  }
  if (!up) {
    console.log(`SERVER NEVER CAME UP on ${BASE}\n${childStderr}`);
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    Authorization: `Bearer ${TOKEN}`,
  };

  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'smoke', version: '1.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  await check('SERVER/DISCOVER', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'Mcp-Method': 'server/discover' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope } }),
    });
    const j = parseSse(await r.text());
    const meta = j?.result?._meta?.['io.modelcontextprotocol/serverInfo'];
    return `status=${r.status} serverInfoMeta=${JSON.stringify(meta)}`;
  });

  const call = async (id, tool, args) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'Mcp-Method': 'tools/call', 'Mcp-Name': tool },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args, _meta: envelope } }),
    });
    const j = parseSse(await r.text());
    return { status: r.status, result: j?.result, error: j?.error };
  };

  // Read tool with an allowed organization -> reaches the Crayon client
  // (dummy creds fail upstream, which proves the gate let it through).
  await check('READ tool (allowed org)', async () => {
    const { result } = await call(10, 'get_invoices', { organizationId: 4040561 });
    const text = result?.content?.[0]?.text ?? '';
    return `isError=${result?.isError} passedGate=${!text.includes('Forbidden')}`;
  });

  // Write tool with a write-enabled organization -> passes the role gate.
  await check('WRITE tool (write-enabled org)', async () => {
    const { result } = await call(11, 'update_subscription_tags', { subscriptionId: 1, tags: { Env: 'test' } });
    const text = result?.content?.[0]?.text ?? '';
    return `isError=${result?.isError} passedGate=${!text.includes('Forbidden')}`;
  });

  // Write tool against a read-only organization -> denied by allowlist.
  await check('WRITE tool (read-only org)', async () => {
    const { result } = await call(12, 'update_subscription_tags', {
      subscriptionId: 1, tags: { Env: 'test' }, organizationId: 4019092,
    });
    const text = result?.content?.[0]?.text ?? '';
    return `isError=${result?.isError} denied=${text.includes('read-only')}`;
  });

  // Read tool against an organization outside the allowlist -> denied.
  await check('READ tool (org not allowlisted)', async () => {
    const { result } = await call(13, 'get_invoices', { organizationId: 9999999 });
    const text = result?.content?.[0]?.text ?? '';
    return `isError=${result?.isError} denied=${text.includes('no access to organization')}`;
  });
}

try {
  await main();
} finally {
  child.kill();
}

console.log(results.join('\n'));
