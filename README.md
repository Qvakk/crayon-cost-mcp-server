# Crayon Cost MCP Server

MCP server exposing Crayon CloudIQ cost and billing data as **31 tools**, over
Streamable HTTP using the latest MCP protocol revision (**2026-07-28**).

Callers are authorized with **Entra ID app roles**; the Crayon API is always
called with the server's own credentials.

---

## Architecture

```mermaid
flowchart LR
  C[MCP client] -->|Bearer token| AG[Application Gateway]
  AG --> APIM[API Management<br/>validates JWT + app roles]
  APIM -->|user token forwarded| CA[Container App<br/>crayon-cost-mcp]
  CA -->|service credentials| CR[Crayon CloudIQ API]
```

| Component | Responsibility |
| --- | --- |
| **Application Gateway** | WAF, TLS, ingress |
| **API Management** | Validates the caller's Entra JWT and gates on app roles; forwards the user token via `X-Inbound-Authorization` |
| **Container App** | Re-validates the token itself, applies the app-role gate per tool, then calls Crayon with its own credentials |

The container **re-validates every token independently**. APIM is not treated as
a sufficient trust boundary — a bypassed or misrouted gateway must not become
unauthenticated access to cost data.

---

## Configuration

### 1. Crayon API credentials — always required

These identify the server to Crayon CloudIQ and are needed in **every** auth
mode. The caller never supplies them; all Crayon calls run under this service
identity.

| Variable | Description |
| --- | --- |
| `CRAYON_CLIENT_ID` | OAuth client ID |
| `CRAYON_CLIENT_SECRET` | OAuth client secret |
| `CRAYON_USERNAME` | Delegated username |
| `CRAYON_PASSWORD` | Delegated password |
| `CRAYON_API_BASE_URL` | Optional, defaults to `https://api.crayon.com/api/v1` |

Obtain these from your Crayon account team. In Azure Container Apps they must be
stored as **container secrets**, never as plain environment values.

### 2. Entra ID app roles — required for the APIM deployment

**Exactly two app roles** are defined on the **API app registration** and
surfaced in the token's `roles` claim:

| App role | Grants | Applied to |
| --- | --- | --- |
| `user.read` | All read/analytics tools | 30 tools (the default policy) |
| `user.write` | Mutating tools | `update_subscription_tags` |

A caller needs `user.read` for reads and `user.write` for writes. **`user.write`
does not imply `user.read`** — grant both to an editor. Tools with no explicit
policy default to `user.read`.

> **There is deliberately no `user.mcp` role here.** That role exists on
> `ipam-mcp` to separate MCP-surface access from REST-surface access on the same
> container. This server exposes a single MCP surface (`POST /mcp`), so such a
> role would gate nothing that the two data roles do not — see the APIM note in
> §Authorization for how the edge gate is expressed without it.

| Variable | Required | Default |
| --- | --- | --- |
| `AUTH_MODE` | yes (in Azure: `entra`) | inferred from `ENTRA_*` |
| `ENTRA_TENANT_ID` | yes | — |
| `ENTRA_AUDIENCES` | yes — **space-separated list** (see below) | — |
| `ENTRA_READ_ROLE` | optional | `user.read` |
| `ENTRA_WRITE_ROLE` | optional | `user.write` |
| `ENTRA_REQUIRED_SCOPE` | optional | — |
| `ENTRA_JWKS_URI` | optional (private endpoints / tests) | derived |

**`ENTRA_AUDIENCES` must list every accepted `aud` form.** Entra stamps `aud`
with the identifier URI the client used as its OAuth `resource` (RFC 8707),
and MCP clients request the **public MCP URL**. Both the public URL and the
`api://` identifier URI must therefore be listed, and each must exist as an
identifier URI on the app registration:

```
ENTRA_AUDIENCES="api://<api-client-id> https://mcp.frid-iks.no/crayon-mcp"
```

Omitting the public URL 401s every MCP client (`AADSTS500011` on the client
side, `invalid audience` on the server side); omitting the `api://` form 401s
service/legacy callers. `ENTRA_AUDIENCE` (singular) is still read as a
single-value alias for existing deployments and `docker-compose.yml`.

The role **names** must match the app registration manifest; the environment
variables only need setting if you rename them.

### 3. Access scope

| Variable | Purpose |
| --- | --- |
| `ALLOWED_ORGANIZATIONS` | Comma-separated organization IDs callers may read |
| `ALLOWED_WRITE_ORGANIZATIONS` | Organizations that may be mutated (empty = all readable ones) |

See `.env.example` for the full set, including rate limits, timeouts and
circuit-breaker thresholds.

---

## Authorization

Two independent checks, both required:

1. **Transport** — validates the Entra token (signature, issuer, audience,
   expiry) and publishes the caller's app roles.
2. **Tool dispatch** — one gate for every invocation, run *before* validation and
   before any Crayon call: app role → organization allowlist → write-organization
   allowlist. Denials return a normal MCP tool error.

> **Adding a mutating tool?** Register it in `TOOL_POLICIES` in
> `src/middleware/auth.ts`. The default policy is read-only, so an unreviewed
> tool can never silently become write-capable.
### Gateway edge gate

Behind APIM/App Gateway the per-API `validate-jwt` policy requires **any one**
of the two app roles:

```hcl
required_scopes = ["user.read", "user.write"]   # match="any" → ORed
```

Because this server has a single surface, the edge gate is an *app-access* gate
("is this caller provisioned for this API at all?"), not an operation gate. The
container then enforces the precise per-tool role on top.

> Do **not** narrow the edge to `["user.read"]`. A caller holding only
> `user.write` would then be refused at the gateway and could never reach the
> very tool that role exists for — even though the container would have allowed
> it. `match="any"` ORs the values, so listing both is what keeps the gate
> equivalent to "has at least one role of this API".

Both roles must exist in the app registration manifest and be assigned via
groups. Editors need **both** roles — `user.write` does not imply `user.read`.

---

## Deployment (Azure Container Apps)

| Property | Value |
| --- | --- |
| Image payload | `dist/`, production `node_modules/`, `package.json` (~69 MB) |
| Port | `3003` on `0.0.0.0` — set `ingress.targetPort` to match |
| User | non-root `nodejs` (uid/gid 1001) |
| Protocols | `2026-07-28` only; 2025-era clients are rejected |
| Logs | **stderr** only |
| Shutdown | handles `SIGTERM` (revision restart / scale-in) |

**Probes** — ACA ignores the Dockerfile `HEALTHCHECK`, so configure these on the
container app. `GET /health` is unauthenticated by design so probes pass:

- **Startup** `/health` — initial delay 5s, period 5s, failure threshold 12
- **Liveness** `/health` — period 30s
- **Readiness** `/health` — period 10s

**Endpoints** — `POST /mcp` (MCP), `GET /health` (probes), `GET /metrics` (auth required).

```bash
docker build -t <registry>/crayon-cost-mcp:<tag> .
```

The build **fails** if source, test tooling, or build-only dependencies ever reach
the runtime image, so a `.dockerignore` drift cannot silently ship.

---

## Development

```bash
npm install
npm run build          # compile TypeScript
npm run test:smoke     # HTTP, auth-gate and Entra JWT checks
npm run test:tools     # drives all 31 tools, validates calls against the Crayon OpenAPI spec
```

Both suites run without a Crayon account or Entra tenant: the tool suite serves a
mock Crayon API and asserts every tool reaches a spec-valid endpoint.

---

## Support

- Crayon CloudIQ API: <https://apidocs.crayon.com/>
- MCP protocol: <https://modelcontextprotocol.io/>
