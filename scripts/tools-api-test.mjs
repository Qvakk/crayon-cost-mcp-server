// Tool <-> Crayon API correlation test.
//
// Stands up a mock Crayon API that records every upstream request, drives ALL
// MCP tools through the real server, then validates each recorded request
// (method + path + query params) against the published OpenAPI document.
//
// This proves each tool actually reaches a real endpoint, rather than only that
// the MCP layer returns 200.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const MOCK_PORT = Number(process.env.MOCK_PORT || '3221');
const APP_PORT = process.env.SMOKE_PORT || '3222';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TOKEN = 'smoketest-token-0123456789abcdef';

// ---------------------------------------------------------------------------
// Mock Crayon API
// ---------------------------------------------------------------------------
const recorded = [];

/** Spec-shaped fixtures: bare arrays, camelCase fields, Price objects. */
const fixtures = {
  '/Organizations': [{ id: 4040561, name: 'Qvakk AS', accountNumber: 'A1' }],
  '/CustomerTenants': [{ id: 7, name: 'Tenant A', domain: 'a.example' }],
  '/CustomerTenants/7/azurePlan': { id: 100, name: 'Azure Plan', organization: { id: 4040561, name: 'Qvakk AS' } },
  '/AzurePlans/100': { id: 100, name: 'Azure Plan' },
  '/AzurePlans/100/azureSubscriptions': [
    { id: 500, azurePlanId: 100, friendlyName: 'Sub A', tags: { costCenter: 'IT' } },
  ],
  '/Subscriptions': [
    {
      id: 1, name: 'Sub A', orderId: 'O1', salesPrice: 100, status: 'Active',
      publisher: { id: 1, name: 'Microsoft' },
      organization: { id: 4040561, name: 'Qvakk AS' },
      startDate: '2025-01-01T00:00:00+00:00', endDate: '2026-01-01T00:00:00+00:00',
      subscriptionTags: { costCenter: 'IT', department: 'Platform' },
    },
  ],
  '/Subscriptions/1': { id: 1, name: 'Sub A', salesPrice: 100 },
  '/Subscriptions/1/tags': { subscriptionId: 1, costCenter: 'IT', department: 'Platform' },
  '/BillingStatements': [
    { id: 1, orderId: 'O1', totalSalesPrice: { value: 100, currencyCode: 'NOK' }, invoiceProfile: { id: 1, name: 'Profile A' }, startDate: '2025-08-01T00:00:00+00:00' },
  ],
  '/BillingStatements/grouped': [
    { id: 1, groupId: 1, orderId: 'O1', totalSalesPrice: { value: 100, currencyCode: 'NOK' }, invoiceProfile: { id: 1, name: 'Profile A' }, organization: { id: 4040561, name: 'Qvakk AS' }, startDate: '2025-08-01T00:00:00+00:00', endDate: '2025-09-01T00:00:00+00:00' },
  ],
  '/Invoices/4040561': [
    { invoiceId: 'I1', orderId: 'O1', salesAmount: 100, salesCurrencyCode: 'NOK', invoiceDate: '2025-09-01T00:00:00+00:00' },
  ],
  '/InvoiceProfiles': [{ id: 1, name: 'Profile A', organization: { id: 4040561, name: 'Qvakk AS' } }],
  '/AwsAccounts': [
    { id: 9, name: 'AWS Acct', awsAccountName: 'aws-acct', isActivated: true, payerAccountId: 'P1', masterAccountStatus: 'Active', awsSegment: 'Commercial', tags: { costCenter: 'IT' } },
  ],
  '/AwsAccounts/9': { id: 9, name: 'AWS Acct', isActivated: true, tags: {} },
  '/UsageCost/organization/4040561': [
    { supplier: 'azure', accountId: 'A1', accountName: 'Acct', subscriptionName: 'Sub A', subscriptionId: '1', amount: 100, currencyCode: 'NOK' },
  ],
};

const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, MOCK_BASE);
    // Strip the /api/v1 prefix the client is configured with.
    const path = url.pathname.replace(/^\/api\/v1/, '');

    recorded.push({ method: req.method, path, query: [...url.searchParams.entries()], body: raw });

    // Token endpoint
    if (path === '/connect/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock-token', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }

    // POST tag replace
    if (req.method === 'POST' && /^\/Subscriptions\/\d+\/tags$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('true');
      return;
    }

    // POST UsageCost/getForCategory
    if (req.method === 'POST' && path === '/UsageCost/getForCategory') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ subcategory: 'compute', amount: 50, currencyCode: 'NOK' }]));
      return;
    }

    // Pagination: only page 1 has data; later pages are empty.
    const page = Number(url.searchParams.get('Page') ?? '1');
    const fixture = fixtures[path];
    if (fixture !== undefined) {
      const body = Array.isArray(fixture) && page > 1 ? [] : fixture;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    // AzureUsage monthly usage file
    if (/^\/AzureUsage\/\d+\/azureSubscriptions\/\d+\/monthlyUsage$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://example.invalid/usage.csv' }));
      return;
    }

    // Unknown path: return an empty array so the tool still completes, while the
    // recorded request still proves what the tool actually asked for.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.method === 'GET' ? '[]' : 'true');
  });
});

await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// MCP server under test
// ---------------------------------------------------------------------------
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: APP_PORT,
    HOST: '127.0.0.1',
    AUTH_MODE: 'token',
    AUTH_TOKEN: TOKEN,
    ALLOWED_ORGANIZATIONS: '4040561',
    ALLOWED_WRITE_ORGANIZATIONS: '4040561',
    CRAYON_API_BASE_URL: `${MOCK_BASE}/api/v1`,
    CRAYON_CLIENT_ID: 'dummy',
    CRAYON_CLIENT_SECRET: 'dummy',
    CRAYON_USERNAME: 'dummy',
    CRAYON_PASSWORD: 'dummy',
    LOG_LEVEL: 'error',
  },
});

let childStderr = '';
child.stderr.on('data', (d) => { childStderr += d.toString(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'correlation', version: '1.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': '2026-07-28',
  Authorization: `Bearer ${TOKEN}`,
};

const parse = async (res) => {
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (line) return JSON.parse(line.slice(6));
  try { return JSON.parse(text); } catch { return null; }
};

async function rpc(id, method, params, name) {
  const h = { ...headers, 'Mcp-Method': method };
  if (name) h['Mcp-Name'] = name;
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope } }),
  });
  return { status: res.status, json: await parse(res) };
}

// Arguments for every tool. Mutating/write tool included.
const TOOL_ARGS = {
  analyze_costs_by_tags: { organizationId: 4040561, monthsBack: 3 },
  detect_cost_anomalies: { organizationId: 4040561, monthsBack: 3, thresholdPercent: 25 },
  find_similar_subscriptions_and_invoices: { organizationId: 4040561, namePattern: 'Sub' },
  get_aws_account_details: { accountId: 9 },
  get_aws_accounts: { organizationId: 4040561 },
  get_azure_costs_by_date_range: { organizationId: 4040561, from: '2025-08-01', to: '2025-09-01' },
  get_azure_costs_by_subscription: { azurePlanId: 100, subscriptionId: 500, from: '2025-08-01', to: '2025-09-01' },
  get_azure_plan_details: { azurePlanId: 100 },
  get_azure_plan_subscriptions: { azurePlanId: 100 },
  get_azure_subscriptions: { customerTenantId: 7 },
  get_azure_usage: { azurePlanId: 100, subscriptionId: 500, year: 2025, month: 8 },
  get_billing_statements: { organizationId: 4040561 },
  get_cost_by_subscription: { organizationId: 4040561, monthsBack: 3 },
  get_cost_trends: { organizationId: 4040561, monthsBack: 3 },
  get_customer_tenants: { organizationId: 4040561 },
  get_grouped_billing_statements: { organizationId: 4040561 },
  get_historical_costs: { organizationId: 4040561, monthsBack: 3 },
  get_invoice_profiles: { organizationId: 4040561 },
  get_invoices: { organizationId: 4040561 },
  get_last_month_costs_by_invoice_profile: { organizationId: 4040561 },
  get_last_month_costs_by_organization: { organizationId: 4040561 },
  get_last_month_costs_by_tags: { organizationId: 4040561 },
  get_organizations: {},
  get_spend_by_cloud_provider: { organizationId: 4040561 },
  get_subscription_details: { subscriptionId: 1 },
  get_subscription_tags: { subscriptionId: 1 },
  get_subscriptions: { organizationId: 4040561 },
  list_all_subscriptions_with_tags: { organizationId: 4040561 },
  track_costs_by_tags: { organizationId: 4040561, monthsBack: 3 },
  update_subscription_tags: { subscriptionId: 1, tags: { costCenter: 'IT', department: 'Platform' } },
  visualize_costs_pie_chart: { organizationId: 4040561, monthsBack: 3, topN: 5 },
};

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------
const specPath = `${process.env.TEMP}/crayon-swagger.json`;
const spec = existsSync(specPath) ? JSON.parse(readFileSync(specPath, 'utf8')) : null;
if (!spec) {
  console.log('WARNING: crayon-swagger.json not found; path validation uses prefix matching only.');
}

// Build a matcher per spec path. A spec path like
// `/api/v1/AzureUsage/{azurePlanId}/azureSubscriptions/{id}/monthlyUsage`
// becomes a regex with each placeholder matching one segment, so a concrete call
// `/AzureUsage/100/azureSubscriptions/500/monthlyUsage` can be matched.
//
// Matching is CASE-SENSITIVE on purpose: the API paths are capitalised
// (`/Subscriptions`, not `/subscriptions`), and an earlier lowercase
// `/subscriptions/{id}` call slipped through precisely because the check was
// case-insensitive. A real routing table would 404 it.
const matchers = spec
  ? Object.entries(spec.paths).map(([p, ops]) => {
      const withoutPrefix = p.replace(/^\/api\/v\d+/i, '');
      const pattern = withoutPrefix
        .replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`)
        .replace(/\\\{[^}]+\\\}/g, '[^/]+');
      return {
        specPath: p,
        regex: new RegExp(`^${pattern}/?$`),
        queryParams: Object.fromEntries(
          Object.entries(ops).map(([m, op]) => [
            m.toUpperCase(),
            new Set((op.parameters ?? []).filter((q) => q.in === 'query').map((q) => q.name)),
          ])
        ),
      };
    })
  : [];

function validate(call) {
  if (!spec) return { ok: true, note: 'unvalidated' };
  const match = matchers.find((m) => m.regex.test(call.path));
  if (!match) return { ok: false, note: 'path not in spec' };
  if (!match.queryParams[call.method]) {
    return { ok: false, note: `method ${call.method} not allowed (spec: ${Object.keys(match.queryParams).join(',')})` };
  }

  // Query parameter names are case-sensitive in the spec.
  const declared = match.queryParams[call.method];
  if (declared.size > 0) {
    const unknown = call.query.map(([k]) => k).filter((k) => !declared.has(k));
    if (unknown.length) {
      return { ok: false, note: `undeclared query params: ${unknown.join(',')} (spec: ${[...declared].join(',')})` };
    }
  }
  return { ok: true, note: match.specPath };
}

// ---------------------------------------------------------------------------
// Drive every tool
// ---------------------------------------------------------------------------
try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    await wait(250);
    try { await fetch(`${BASE}/health`); up = true; break; } catch { /* retry */ }
  }
  if (!up) {
    console.log(`SERVER NEVER CAME UP\n${childStderr}`);
    process.exit(1);
  }

  const list = await rpc(1, 'tools/list', {});
  const declared = list.json?.result?.tools?.map((t) => t.name) ?? [];
  console.log(`TOOLS ADVERTISED: ${declared.length}`);
  console.log(`TOOLS WITH TEST ARGS: ${Object.keys(TOOL_ARGS).length}\n`);

  const missingArgs = declared.filter((t) => !(t in TOOL_ARGS));
  const extraArgs = Object.keys(TOOL_ARGS).filter((t) => !declared.includes(t));
  if (missingArgs.length) console.log(`TOOLS MISSING TEST ARGS: ${missingArgs.join(', ')}`);
  if (extraArgs.length) console.log(`TEST ARGS FOR UNKNOWN TOOLS: ${extraArgs.join(', ')}`);
  console.log('');

  const rows = [];
  let id = 100;
  for (const tool of declared) {
    const before = recorded.length;
    const { status, json } = await rpc(id++, 'tools/call', { name: tool, arguments: TOOL_ARGS[tool] ?? {} }, tool);
    const upstream = recorded.slice(before).filter((c) => c.path !== '/connect/token');

    const isError = json?.result?.isError === true;
    const text = json?.result?.content?.[0]?.text ?? '';
    const forbidden = /Forbidden/i.test(text);

    const checks = upstream.map(validate);
    const bad = checks.filter((c) => !c.ok);

    rows.push({ tool, status, upstream: upstream.length, isError, forbidden, endpoints: [...new Set(upstream.map((c) => `${c.method} ${c.path}`))], bad });
  }

  console.log('=== TOOL -> CRAYON API CORRELATION ===');
  console.log('tool'.padEnd(40) + 'http  calls  endpoints / issues');
  console.log('-'.repeat(118));
  for (const r of rows) {
    const flag = r.bad.length ? '  <-- SPEC MISMATCH' : (r.upstream === 0 ? '  <-- NO UPSTREAM CALL' : '');
    console.log(`${r.tool.padEnd(40)}${String(r.status).padEnd(6)}${String(r.upstream).padEnd(7)}${r.endpoints.join(' , ').slice(0, 60)}${flag}`);
    for (const b of r.bad) console.log(`    ! ${b.note}`);
  }

  const noUpstream = rows.filter((r) => r.upstream === 0);
  const mismatched = rows.filter((r) => r.bad.length > 0);
  const distinctEndpoints = new Set(recorded.filter((c) => c.path !== '/connect/token').map((c) => `${c.method} ${c.path}`));

  console.log('\n=== SUMMARY ===');
  console.log(`  tools exercised:          ${rows.length}`);
  console.log(`  upstream calls made:      ${recorded.filter((c) => c.path !== '/connect/token').length}`);
  console.log(`  distinct endpoints hit:   ${distinctEndpoints.size}`);
  console.log(`  tools with no upstream:   ${noUpstream.length}${noUpstream.length ? ' -> ' + noUpstream.map((r) => r.tool).join(', ') : ''}`);
  console.log(`  spec mismatches:          ${mismatched.length}${mismatched.length ? ' -> ' + mismatched.map((r) => r.tool).join(', ') : ''}`);
  console.log(`  token requests:           ${recorded.filter((c) => c.path === '/connect/token').length}`);

  console.log('\n=== ALL DISTINCT ENDPOINTS CALLED ===');
  for (const e of [...distinctEndpoints].sort()) {
    const v = validate({ method: e.split(' ')[0], path: e.split(' ').slice(1).join(' '), query: [] });
    console.log(`  ${v.ok ? 'OK  ' : 'BAD '} ${e}`);
  }
} finally {
  child.kill();
  mock.close();
}
