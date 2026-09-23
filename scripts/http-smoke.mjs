// Smoke-test client: drives the built MCP server over Streamable HTTP using the
// latest (2026-07-28) protocol revision.
//
// Modern requests carry:
//   - `MCP-Protocol-Version: 2026-07-28`
//   - `Mcp-Method: <method>` (and `Mcp-Name` for tools/call)
//   - a per-request `_meta` envelope claiming the protocol revision
//
// Legacy (2025-era) clients are rejected by design; that is asserted here too.
import { spawn } from 'node:child_process';

const PORT = process.env.SMOKE_PORT || '3112';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'smoketest-token-0123456789abcdef';
const REVISION = '2026-07-28';

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT,
    HOST: '127.0.0.1',
    AUTH_MODE: 'token',
    AUTH_TOKEN: TOKEN,
    ALLOWED_ORGANIZATIONS: '4040561',
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

const envelope = {
  'io.modelcontextprotocol/protocolVersion': REVISION,
  'io.modelcontextprotocol/clientInfo': { name: 'smoke', version: '1.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const baseHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': REVISION,
  Authorization: `Bearer ${TOKEN}`,
};

const readResponse = async (res) => {
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (line) return JSON.parse(line.slice(6));
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
};

/** Modern JSON-RPC call with the headers required for `method`. */
async function rpc(id, method, params, { name } = {}) {
  const headers = { ...baseHeaders, 'Mcp-Method': method };
  if (name) headers['Mcp-Name'] = name;

  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope } }),
  });
  return { status: res.status, json: await readResponse(res) };
}

const callTool = (id, tool, args) => rpc(id, 'tools/call', { name: tool, arguments: args }, { name: tool });

async function main() {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await wait(250);
    try { await fetch(`${BASE}/health`); up = true; break; } catch { /* not up yet */ }
  }
  if (!up) {
    console.log(`SERVER NEVER CAME UP on ${BASE}\n${childStderr}`);
    return;
  }

  await check('HEALTH', async () => {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    return `${r.status} tools=${j.tools} version=${j.version}`;
  });

  await check('AUTH (no token)', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: envelope } }),
    });
    return `status=${r.status}`;
  });

  await check('SERVER/DISCOVER (latest revision)', async () => {
    const { status, json } = await rpc(1, 'server/discover', {});
    const meta = json?.result?._meta?.['io.modelcontextprotocol/serverInfo'];
    return `status=${status} serverInfoMeta=${JSON.stringify(meta)}`;
  });

  await check('TOOLS/LIST', async () => {
    const { status, json } = await rpc(2, 'tools/list', {});
    const names = json?.result?.tools?.map((t) => t.name) ?? [];
    return `status=${status} count=${names.length} hasVisualize=${names.includes('visualize_costs_pie_chart')}`;
  });

  await check('TOOLS/CALL (chart tool reachable)', async () => {
    const { status, json } = await callTool(3, 'visualize_costs_pie_chart', {
      organizationId: 4040561, monthsBack: 1, topN: 3,
    });
    const text = json?.result?.content?.[0]?.text ?? '';
    return `status=${status} isError=${json?.result?.isError} reachedHandler=${text.includes('visualize_costs_pie_chart')}`;
  });

  await check('TOOLS/CALL (validation error path)', async () => {
    const { status, json } = await callTool(4, 'get_billing_statements', {});
    const text = json?.result?.content?.[0]?.text ?? '';
    return `status=${status} isError=${json?.result?.isError} mentionsValidation=${/Invalid input|organizationId/i.test(text)}`;
  });

  await check('TOOLS/CALL (upstream error sanitized)', async () => {
    const { status, json } = await callTool(5, 'get_organizations', {});
    const text = json?.result?.content?.[0]?.text ?? '';
    return `status=${status} isError=${json?.result?.isError} sanitized=${text.includes('An error occurred processing your request')}`;
  });

  // Legacy clients must be declined with an explicit version error, not served.
  await check('LEGACY initialize rejected', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 6, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
      }),
    });
    const json = await readResponse(r);
    return `status=${r.status} rejected=${/unsupported protocol version/i.test(json?.error?.message ?? '')}`;
  });

  await check('MISSING Mcp-Method rejected', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': REVISION, Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: envelope } }),
    });
    return `status=${r.status}`;
  });

  await check('BAD CONTENT-TYPE (415)', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
      body: 'not json',
    });
    return `status=${r.status}`;
  });

  await check('METRICS', async () => {
    const r = await fetch(`${BASE}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json();
    return `status=${r.status} requests=${j.requests}`;
  });
}

try {
  await main();
} finally {
  child.kill();
}

console.log(results.join('\n'));
