# Crayon Cost MCP Server

Enterprise-grade MCP server providing cost and billing analytics from Crayon CloudIQ APIs.

## Quick Start (5 Minutes)

### 1. Get Credentials
Contact your Crayon account team to obtain:
- Client ID
- Client Secret
- Username
- Password

### 2. Setup Environment

**Linux/Mac:**
```bash
# Clone repository
git clone <your-repo-url>
cd crayon-cost-mcp-server

# Copy environment template
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
# Clone repository
git clone <your-repo-url>
cd crayon-cost-mcp-server

# Copy environment template
Copy-Item .env.example .env
```

### 3. Configure Credentials

Edit `.env` file and add your credentials:

```bash
# Required - Get from Crayon account team
CRAYON_CLIENT_ID=your_client_id_here
CRAYON_CLIENT_SECRET=your_client_secret_here
CRAYON_USERNAME=your_username_here
CRAYON_PASSWORD=your_password_here

# Generate secure JWT secret
# Linux/Mac: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Windows:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=paste_generated_64_char_hex_string_here

# Optional - defaults work fine
CRAYON_API_BASE_URL=https://api.crayon.com/api/v1
PORT=3003
NODE_ENV=production
AUTH_ENABLED=false  # Set to true in production
```

**⚠️ IMPORTANT:** Never commit the `.env` file to git! It's already in `.gitignore`.

### 4. Run Locally with Docker

```bash
docker-compose up -d
```

### 5. Verify It's Running

```bash
# Test health endpoint
curl http://localhost:3003/health

# Expected: {"status":"ok","timestamp":"2025-11-11T..."}
```

### 6. Deploy to Azure (Production)

```bash
# Make script executable
chmod +x deploy-azure.sh

# Deploy (script will prompt for credentials)
./deploy-azure.sh

# Takes ~5-10 minutes
# You'll get a public HTTPS URL when done
```

---

## Available MCP Tools

The server provides **22 tools** for comprehensive cost analysis:

### Core Tools
- **`get_organizations`** - List all accessible organizations
- **`get_billing_statements`** - Monthly billing data with filters
- **`get_grouped_billing_statements`** - Aggregated billing by cycles
- **`get_invoices`** - Invoice details and status
- **`get_invoice_profiles`** - Billing group profiles
- **`get_cost_summary`** - Combined cost analysis

### Azure-Specific Tools
- **`get_azure_usage`** - Detailed Azure consumption (CSV download)
- **`get_azure_subscriptions`** - Azure subscriptions by tenant
- **`get_azure_plan_details`** - Azure plan information with subscriptions
- **`get_azure_plan_subscriptions`** - All subscriptions in an Azure plan
- **`get_azure_costs_by_date_range`** - Total Azure costs for date range
- **`get_azure_costs_by_subscription`** - Subscription-specific Azure costs

### Subscription Management
- **`get_subscriptions`** - All cloud subscriptions (Azure, AWS, etc.)
- **`get_subscription_details`** - Detailed subscription info with metadata
- **`get_subscription_tags`** - Tags for cost allocation
- **`update_subscription_tags`** - Update subscription tags

### Advanced Analytics
- **`get_historical_costs`** - Multi-month cost history for trends
- **`get_cost_by_subscription`** - Cost breakdown by subscription
- **`track_costs_by_tags`** - Cost allocation by tags (department, project, etc.)
- **`get_cost_trends`** - Month-over-month trends and averages
- **`detect_cost_anomalies`** - Identify unexpected cost spikes

## Support

For Crayon CloudIQ API documentation:
https://apidocs.crayon.com/

For MCP protocol documentation:
https://modelcontextprotocol.io/
