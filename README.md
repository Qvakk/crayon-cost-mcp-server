# Crayon Cost MCP Server

MCP server providing cost and billing analytics from Crayon CloudIQ APIs.

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

Edit `.env` file and fill in your Crayon credentials:

```bash
# Required - Get from Crayon account team
CRAYON_CLIENT_ID=your_client_id_here
CRAYON_CLIENT_SECRET=your_client_secret_here
CRAYON_USERNAME=your_username_here
CRAYON_PASSWORD=your_password_here

# Required - Generate secure JWT secret (64 characters)
# Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=paste_generated_64_char_hex_string_here
```

**Note:** The `.env.example` file contains all available configuration options with detailed comments. The above are the minimum required settings to get started.

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

## Available MCP Tools

The server provides **26 tools** for comprehensive cost analysis:

### Core Tools
- **`get_organizations`** - List all accessible organizations
- **`get_billing_statements`** - Monthly billing data with filters
- **`get_grouped_billing_statements`** - Aggregated billing by cycles
- **`get_invoices`** - Invoice details and status
- **`get_invoice_profiles`** - Billing group profiles
- **`get_cost_summary`** - Combined cost analysis
- **`get_customer_tenants`** - Customer tenant information for correlation

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
- **`get_subscription_tags`** - Tags for cost allocation and tracking
- **`update_subscription_tags`** - Update subscription tags for organization
- **`list_all_subscriptions_with_tags`** - Complete subscription and tag inventory

### Advanced Analytics & Visualization
- **`get_historical_costs`** - Multi-month cost history for forecasting
- **`get_cost_by_subscription`** - 📊 Cost breakdown by subscription with **pie/doughnut chart**
- **`track_costs_by_tags`** - Cost allocation by tags (department, project, environment)
- **`get_cost_trends`** - 📈 Month-over-month trends with **line chart visualization**
- **`detect_cost_anomalies`** - Identify subscriptions with unexpected cost spikes
- **`analyze_costs_by_tags`** - Breakdown costs by CostCenter, Department, Project, etc.
- **`find_similar_subscriptions_and_invoices`** - Find related subscriptions by name pattern
- **`get_last_month_costs_by_tags`** - Last month cost breakdown by tags
- **`get_last_month_costs_by_invoice_profile`** - Last month costs per invoice profile
- **`get_last_month_costs_by_organization`** - Last month total by organization

### Key Features
- ✅ All historical cost tools use **complete billing months** (start from 1st of month)
- 📊 **Chart visualization** for trend analysis and cost distribution
- 🔤 **Proper font rendering** with DejaVu Sans, Liberation, and Noto fonts
- 🔍 **Correlation tools** to link billing data with Azure/AWS resources
- 🏷️ **Tag-based analytics** for departmental cost allocation

## Support

For Crayon CloudIQ API documentation:
https://apidocs.crayon.com/

For MCP protocol documentation:
https://modelcontextprotocol.io/
