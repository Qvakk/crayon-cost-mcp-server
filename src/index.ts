#!/usr/bin/env node
import {
  createMcpHandler,
  Server,
  type CallToolRequest,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CrayonApiClient, priceValue, priceCurrency } from './crayon-client.js';
import { logger, logToolExecution, logSecurityEvent } from './middleware/logger.js';
import { authenticateRequest, callerFromAuthInfo, enforceToolPolicy } from './middleware/auth.js';
import { validateToolInput } from './middleware/validation.js';
import { sanitizeErrorMessage, createCircuitBreakerWrapper } from './middleware/security.js';
import { chartGenerator } from './utils/chart-generator.js';
import { formatMonthYear, getCurrentLocale } from './utils/localization.js';
import { loadConfig, createMetrics, AppConfig, AppMetrics } from './utils/config.js';

// Load .env for local development / docker-compose.
// In the Container App deployment the platform injects the environment
// directly, so a missing file is expected and must not be fatal.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Load and validate configuration
let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration error');
  process.exit(1);
}

/** Server name/version advertised to MCP clients and exposed on /health. */
const SERVER_NAME = 'crayon-cost-mcp';
const SERVER_VERSION = '1.1.0';

// Initialize metrics
const metrics: AppMetrics = createMetrics();

// Initialize Crayon API client
const crayonClient = new CrayonApiClient(
  config.crayonClientId,
  config.crayonClientSecret,
  config.crayonUsername,
  config.crayonPassword,
  config.crayonApiBaseUrl,
  // Per-request HTTP timeout: bounded below the circuit breaker timeout so a
  // stalled connection fails fast instead of hanging until the breaker fires.
  Math.min(config.apiTimeoutMs, config.requestTimeoutMs)
);

// Initialize circuit breaker for API calls
const circuitBreaker = createCircuitBreakerWrapper(() => {
  metrics.circuitBreakerTrips++;
});

// Rate limiting configuration
const rateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  // `limit` is the current option name (`max` remains a deprecated alias).
  limit: config.rateLimitMaxRequests,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Helper function to create standard tool responses
 */
function createToolResponse(data: any, message?: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(message ? { message, data } : data, null, 2),
    }],
  };
}

/**
 * Executes a Crayon API call behind the circuit breaker.
 *
 * Read responses are deliberately NOT cached: the cache key would need to carry
 * the caller's identity and every query parameter to avoid serving one caller's
 * cost data to another, and stale billing figures are worse than a repeat call.
 */
async function executeWithCircuitBreaker<T>(apiCall: () => Promise<T>): Promise<T> {
  return circuitBreaker.execute(apiCall);
}

// Define MCP tools
const tools: Tool[] = [
  {
    name: 'get_billing_statements',
    description: 'Get billing statements for an organization with optional filters. Returns monthly billing data including total sales prices and invoice profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Invoice Profile ID (optional)',
        },
        provisionType: {
          type: 'string',
          enum: ['None', 'Seat', 'Usage', 'OneTime', 'Crayon', 'AzureMarketplace'],
          description: 'Provision type filter (optional)',
        },
        from: {
          type: 'string',
          description: 'Start date in ISO format (optional)',
        },
        to: {
          type: 'string',
          description: 'End date in ISO format (optional)',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (optional)',
        },
        pageSize: {
          type: 'number',
          description: 'Number of items per page (optional)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_grouped_billing_statements',
    description: 'Get grouped billing statements by billing cycles for an organization. Useful for aggregated cost analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Invoice Profile ID (optional)',
        },
        provisionType: {
          type: 'string',
          enum: ['None', 'Seat', 'Usage', 'OneTime', 'Crayon', 'AzureMarketplace'],
          description: 'Provision type filter (optional)',
        },
        from: {
          type: 'string',
          description: 'Start date in ISO format (optional)',
        },
        to: {
          type: 'string',
          description: 'End date in ISO format (optional)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_azure_usage',
    description: 'Get detailed Azure usage data for a specific subscription and time period. Returns a SAS URI to download CSV file with usage details.',
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'Azure Plan ID (required)',
        },
        subscriptionId: {
          type: 'number',
          description: 'Azure Subscription ID (required)',
        },
        year: {
          type: 'number',
          description: 'Year of usage period (required)',
        },
        month: {
          type: 'number',
          description: 'Month of usage period (1-12, required)',
        },
        includeBom: {
          type: 'boolean',
          description: 'Include byte-order mark for Excel compatibility (optional)',
        },
      },
      required: ['azurePlanId', 'subscriptionId', 'year', 'month'],
    },
  },
  {
    name: 'get_invoices',
    description: 'Get invoices for an organization. Returns invoice details including amounts, dates, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (optional)',
        },
        pageSize: {
          type: 'number',
          description: 'Number of items per page (optional)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_invoice_profiles',
    description: 'Get invoice profiles for an organization. Invoice profiles are used to group subscriptions for billing purposes.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_organizations',
    description: 'List all organizations accessible with current credentials. Use this to discover organization IDs for other queries.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_historical_costs',
    description: 'Get historical billing data over multiple months. Useful for cost trend analysis and forecasting.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        monthsBack: {
          type: 'number',
          description: 'Number of months to look back (default: 6, max: 24)',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Invoice Profile ID to filter by (optional)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_customer_tenants',
    description: 'Get customer tenants (Azure/AWS customers) for resource correlation. Use this to discover tenant IDs for subscription queries.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (optional - returns all if omitted)',
        },
      },
    },
  },
  {
    name: 'get_azure_subscriptions',
    description: 'Get Azure subscriptions for a customer tenant. Use this to correlate costs with specific Azure resources.',
    inputSchema: {
      type: 'object',
      properties: {
        customerTenantId: {
          type: 'number',
          description: 'Customer Tenant ID (required)',
        },
      },
      required: ['customerTenantId'],
    },
  },
  {
    name: 'get_subscriptions',
    description: 'Get all cloud subscriptions (Azure, AWS, etc.) to correlate with billing data and resources.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (optional)',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (optional)',
        },
        pageSize: {
          type: 'number',
          description: 'Number of items per page (optional)',
        },
      },
    },
  },
  {
    name: 'get_cost_by_subscription',
    description: 'Get detailed cost breakdown by subscription with resource correlation. Combines billing data with subscription details.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Invoice Profile ID (optional)',
        },
        monthsBack: {
          type: 'number',
          description: 'Number of months to look back (default: 3)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_subscription_details',
    description: 'Get detailed information about a specific subscription including tags and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: {
          type: 'number',
          description: 'Subscription ID (required)',
        },
      },
      required: ['subscriptionId'],
    },
  },
  {
    name: 'get_subscription_tags',
    description: 'Get tags for a specific subscription. Tags are used for cost allocation, tracking, and organization.',
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: {
          type: 'number',
          description: 'Subscription ID (required)',
        },
      },
      required: ['subscriptionId'],
    },
  },
  {
    name: 'update_subscription_tags',
    description: 'Update or add tags to a subscription for better cost tracking and organization.',
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: {
          type: 'number',
          description: 'Subscription ID (required)',
        },
        tags: {
          type: 'object',
          description: 'Key-value pairs of tags (e.g., {"Environment": "Production", "CostCenter": "IT"})',
        },
      },
      required: ['subscriptionId', 'tags'],
    },
  },
  {
    name: 'get_azure_plan_details',
    description: 'Get detailed information about an Azure Plan including all associated subscriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'Azure Plan ID (required)',
        },
      },
      required: ['azurePlanId'],
    },
  },
  {
    name: 'get_azure_plan_subscriptions',
    description: 'Get all Azure subscriptions associated with an Azure Plan.',
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'Azure Plan ID (required)',
        },
      },
      required: ['azurePlanId'],
    },
  },
  {
    name: 'track_costs_by_tags',
    description: 'Track and analyze costs grouped by subscription tags. Perfect for cost allocation by department, project, or environment.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        monthsBack: {
          type: 'number',
          description: 'Number of months to analyze (default: 3)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_azure_costs_by_date_range',
    description: 'Get total Azure costs for an organization within a specific date range. Aggregates all Azure subscriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        from: {
          type: 'string',
          description: 'Start date in ISO format YYYY-MM-DD (required)',
        },
        to: {
          type: 'string',
          description: 'End date in ISO format YYYY-MM-DD (required)',
        },
      },
      required: ['organizationId', 'from', 'to'],
    },
  },
  {
    name: 'get_azure_costs_by_subscription',
    description: 'Get Azure costs for a specific subscription within a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'Azure Plan ID (required)',
        },
        subscriptionId: {
          type: 'number',
          description: 'Azure Subscription ID (required)',
        },
        from: {
          type: 'string',
          description: 'Start date in ISO format YYYY-MM-DD (required)',
        },
        to: {
          type: 'string',
          description: 'End date in ISO format YYYY-MM-DD (required)',
        },
      },
      required: ['azurePlanId', 'subscriptionId', 'from', 'to'],
    },
  },
  {
    name: 'get_cost_trends',
    description: 'Analyze cost trends over multiple months. Shows month-over-month changes, highest/lowest months, and average costs.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        monthsBack: {
          type: 'number',
          description: 'Number of months to analyze (default: 6)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'detect_cost_anomalies',
    description: 'Detect subscriptions with significant cost changes. Identifies what changed and by how much, useful for finding unexpected costs.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        monthsBack: {
          type: 'number',
          description: 'Number of months to analyze (default: 3)',
        },
        changeThresholdPercent: {
          type: 'number',
          description: 'Percentage threshold to flag as anomaly (default: 25)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'analyze_costs_by_tags',
    description: 'Analyze and breakdown costs by tags (CostCenter, Department, Project, etc.). Shows total cost per tag value.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        monthsBack: {
          type: 'number',
          description: 'Number of months to analyze (default: 3)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'find_similar_subscriptions_and_invoices',
    description: 'Find subscriptions matching a name pattern (e.g., "sub-prod-*") and get their latest invoices. Useful for finding related resources.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        namePattern: {
          type: 'string',
          description: 'Subscription name pattern (regex, case-insensitive). Examples: "sub-prod.*", ".*-prod", "viken.*"',
        },
      },
      required: ['organizationId', 'namePattern'],
    },
  },
  {
    name: 'list_all_subscriptions_with_tags',
    description: 'List all subscriptions with their complete tag information. Useful for auditing and verification of tagging accuracy.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (optional - returns all if omitted)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_last_month_costs_by_organization',
    description: 'Get total costs for last month broken down by organization.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_last_month_costs_by_invoice_profile',
    description: 'Get last month costs broken down by invoice profile. Shows which profile generated the most cost.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_last_month_costs_by_tags',
    description: 'Get last month costs broken down by tags (CostCenter, Department, Project, etc.). Shows which tag values had the most cost.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'visualize_costs_pie_chart',
    description: 'Generate a pie or doughnut chart showing the cost distribution across the top subscriptions for the last N months.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
        monthsBack: {
          type: 'number',
          description: 'Number of months to analyze (default: 3)',
        },
        topN: {
          type: 'number',
          description: 'Number of top subscriptions to include (default: 10, max: 50)',
        },
        chartStyle: {
          type: 'string',
          enum: ['pie', 'doughnut'],
          description: 'Chart style (default: pie)',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_aws_accounts',
    description: 'List AWS accounts managed through Crayon, with their embedded tags, payer account, master-account status and AWS segment.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (optional - returns all accessible if omitted)',
        },
        customerTenantId: {
          type: 'number',
          description: 'Customer tenant ID to filter by (optional)',
        },
        search: {
          type: 'string',
          description: 'Free-text search filter (optional)',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (optional)',
        },
        pageSize: {
          type: 'number',
          description: 'Number of items per page (optional, default 100)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_aws_account_details',
    description: 'Get a single AWS account by its Crayon account ID, including tags and activation state.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'number',
          description: 'Crayon AWS account ID (required)',
        },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'get_spend_by_cloud_provider',
    description: 'Summarise spend and subscription counts per cloud publisher (Microsoft/Azure, AWS, etc.) and list AWS accounts. Use this for a multi-cloud overview.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Organization ID (required)',
        },
      },
      required: ['organizationId'],
    },
  },
];

// Create MCP server factory.
//
// The handler invokes this once per HTTP request, so request-scoped state must
// live inside the factory rather than at module scope.
function createServer(): Server {
  const server = new Server(
    {
      name: 'crayon-cost-mcp',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list tools request
  server.setRequestHandler('tools/list', async () => ({
    tools,
  }));

  // Handle tool execution
  server.setRequestHandler('tools/call', async (request: CallToolRequest, ctx: ServerContext) => {
    const { name, arguments: args } = request.params;
    // v2 passes request-scoped identity through the transport context (the HTTP
    // auth middleware attaches it to `req.auth`, surfaced here as `ctx.http.authInfo`).
    const caller = callerFromAuthInfo(ctx.http?.authInfo);
    const userId = caller.id;
    let organizationId = (args as any)?.organizationId || null;
    const startTime = Date.now();

    // Per-tool invocation counter, surfaced on /metrics.
    metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;

    // OWASP Security: A01:2021 - Broken Access Control
    // Single authorization gate: app role (user.read / user.write), the
    // organization allowlist, and the write-organization allowlist. Runs before
    // validation so an unauthorized caller never reaches the Crayon API or
    // receives schema feedback.
    const denial = enforceToolPolicy(
      name,
      caller,
      typeof organizationId === 'number' ? organizationId : null,
      (message, meta) => {
        logger.error(message, meta);
        logSecurityEvent({
          type: 'unauthorized_access',
          userId,
          ip: 'unknown',
          details: meta,
        });
      }
    );
    if (denial) {
      return denial;
    }

    try {
      // OWASP Security: A02:2021 - Prompt Injection & A09:2021 - Weak Validation
      // Validate tool input against schema
      let validatedArgs: any = args;
      try {
        validatedArgs = await validateToolInput(name, args);
        organizationId = (validatedArgs as any)?.organizationId || organizationId;
      } catch (validationError: any) {
        const errorMessage = validationError?.message || 'Unknown validation error occurred';
      
        logger.error(`Tool validation failed for ${name}`, {
          toolName: name,
          error: errorMessage,
        });
      
        return {
          content: [
            {
              type: 'text',
              text: errorMessage || 'Validation failed with no details available',
            },
          ],
          isError: true,
        };
      }

      switch (name) {
        case 'get_billing_statements': {
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getBillingStatements(validatedArgs as any)
          );
          const duration = Date.now() - startTime;
          logToolExecution({
            tool: name,
            userId,
            organizationId,
            duration,
            status: 'success',
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'get_grouped_billing_statements': {
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getGroupedBillingStatements(validatedArgs as any)
          );
          const duration = Date.now() - startTime;
          logToolExecution({
            tool: name,
            userId,
            organizationId,
            duration,
            status: 'success',
          });
          return createToolResponse(result);
        }

        case 'get_azure_usage': {
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAzureUsage(validatedArgs as any)
          );
          return createToolResponse(result);
        }

        case 'get_invoices': {
          const { organizationId, page, pageSize } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getInvoices(organizationId, page, pageSize)
          );
          return createToolResponse(result);
        }

        case 'get_invoice_profiles': {
          const { organizationId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getInvoiceProfiles(organizationId)
          );
          return createToolResponse(result);
        }

        case 'get_organizations': {
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getOrganizations()
          );
          const duration = Date.now() - startTime;
          logToolExecution({
            tool: name,
            userId,
            organizationId,
            duration,
            status: 'success',
          });
          return createToolResponse(result);
        }

        case 'get_historical_costs': {
          const { organizationId, monthsBack = 6, invoiceProfileId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getHistoricalBilling(organizationId, monthsBack, invoiceProfileId)
          );
        
          return createToolResponse({
            organizationId,
            monthsBack,
            invoiceProfileId,
            historicalData: result,
          });
        }

        case 'get_customer_tenants': {
          const { organizationId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getCustomerTenants(organizationId)
          );
          return createToolResponse(result);
        }

        case 'get_azure_subscriptions': {
          const { customerTenantId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAzureSubscriptions(customerTenantId)
          );
          return createToolResponse(result);
        }

        case 'get_aws_accounts': {
          const { organizationId, customerTenantId, search, page, pageSize } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAwsAccounts({ organizationId, customerTenantId, search, page, pageSize })
          );
          return createToolResponse({ count: result.length, accounts: result });
        }

        case 'get_aws_account_details': {
          const { accountId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAwsAccountById(accountId)
          );
          return createToolResponse(result);
        }

        case 'get_spend_by_cloud_provider': {
          const { organizationId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getCloudSpendByPublisher(organizationId)
          );
          return createToolResponse(result, 'Spend and subscriptions by cloud publisher');
        }

        case 'get_subscriptions': {
          const { organizationId, customerTenantId, page, pageSize } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getSubscriptions({ organizationId, customerTenantId, page, pageSize })
          );
          return createToolResponse(result);
        }

        case 'get_cost_by_subscription': {
          const { organizationId, invoiceProfileId, monthsBack = 3 } = validatedArgs as any;
        
          // Get historical billing and subscriptions in parallel with circuit breaker
          const [billingData, subscriptions] = await Promise.all([
            executeWithCircuitBreaker(() => crayonClient.getHistoricalBilling(organizationId, monthsBack, invoiceProfileId)),
            executeWithCircuitBreaker(() => crayonClient.getSubscriptions({ organizationId })),
          ]);

          return createToolResponse({
            organizationId,
            monthsBack,
            period: {
              from: new Date(Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000).toISOString(),
              to: new Date().toISOString(),
            },
            billingData,
            subscriptions,
          }, 'Cost breakdown with subscription correlation');
        }

        case 'get_subscription_details': {
          const { subscriptionId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getSubscriptionById(subscriptionId)
          );
          return createToolResponse(result);
        }

        case 'get_subscription_tags': {
          const { subscriptionId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getSubscriptionTags(subscriptionId)
          );
          return createToolResponse(result);
        }

        case 'update_subscription_tags': {
          const { subscriptionId, tags } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.updateSubscriptionTags(subscriptionId, tags)
          );
          return createToolResponse({ subscriptionId, tags: result }, 'Tags updated successfully');
        }

        case 'get_azure_plan_details': {
          const { azurePlanId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAzurePlan(azurePlanId)
          );
          return createToolResponse(result);
        }

        case 'get_azure_plan_subscriptions': {
          const { azurePlanId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAzurePlanSubscriptions(azurePlanId)
          );
          return createToolResponse(result);
        }

        case 'track_costs_by_tags': {
          const { organizationId, monthsBack = 3 } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getCostByTags(organizationId, monthsBack)
          );
        
          return createToolResponse({ organizationId, monthsBack, data: result }, 'Cost tracking by subscription tags');
        }

        case 'get_azure_costs_by_date_range': {
          const { organizationId, from, to } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAzureCostsByDateRange(organizationId, from, to)
          );
        
          return createToolResponse({ organizationId, from, to, data: result }, 'Azure costs by date range');
        }

        case 'get_azure_costs_by_subscription': {
          const { azurePlanId, subscriptionId, from, to } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getAzureCostsBySubscription(azurePlanId, subscriptionId, from, to)
          );
        
          return createToolResponse({ azurePlanId, subscriptionId, from, to, data: result }, 'Azure costs by subscription');
        }

        case 'get_cost_trends': {
          const { organizationId, monthsBack = 6 } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getCostTrends(organizationId, monthsBack)
          );
        
          // Generate line chart if we have data
          if (result.trends && result.trends.length > 0) {
            const locale = getCurrentLocale();
            const monthLabels = result.trends.map((t: any) => t.month);
            const formattedLabels = monthLabels.map((m: string) => formatMonthYear(m, locale));
            const costData = result.trends.map((t: any) => t.cost);
          
            const chartDataUrl = await chartGenerator.generateLineChart(
              formattedLabels,
              [{ label: 'Monthly Cost', data: costData }],
              `Cost Trends (Last ${monthsBack} Months)`,
              'Cost (NOK)'
            );
          
            // Format summary text with localized month names
            const summary = result.summary;
            const summaryText = `# Cost Trends Analysis (Last ${monthsBack} Months)

  **Average Monthly Cost:** ${summary.averageMonthlyCost ? summary.averageMonthlyCost.toFixed(2) : 'N/A'} NOK
  **Highest Month:** ${summary.highestMonth ? `${formatMonthYear(summary.highestMonth.month, locale)} (${summary.highestMonth.cost.toFixed(2)} NOK)` : 'N/A'}
  **Lowest Month:** ${summary.lowestMonth ? `${formatMonthYear(summary.lowestMonth.month, locale)} (${summary.lowestMonth.cost.toFixed(2)} NOK)` : 'N/A'}

  **Month-over-Month Changes:**
  ${result.trends.map((t: any) => {
    const changeText = t.change !== null 
      ? `${t.change >= 0 ? '+' : ''}${t.change.toFixed(2)} NOK (${t.changePercent >= 0 ? '+' : ''}${t.changePercent}%)`
      : 'N/A';
    return `- ${formatMonthYear(t.month, locale)}: ${t.cost.toFixed(2)} NOK (${changeText})`;
  }).join('\n')}
  `;

            return {
              content: [
                {
                  type: 'text',
                  text: summaryText,
                },
                {
                  type: 'image',
                  data: chartDataUrl.split(',')[1],
                  mimeType: 'image/png',
                },
              ],
            };
          }
        
          // Fallback: return JSON if no data for chart
          return createToolResponse({ organizationId, monthsBack, data: result }, 'Cost trends analysis - month over month comparison');
        }

        case 'detect_cost_anomalies': {
          const { organizationId, monthsBack = 3, changeThresholdPercent = 25 } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.detectCostAnomalies(organizationId, monthsBack, changeThresholdPercent)
          );
        
          return createToolResponse({ organizationId, monthsBack, changeThresholdPercent, data: result }, 'Cost anomaly detection - subscriptions with significant changes');
        }

        case 'analyze_costs_by_tags': {
          const { organizationId, monthsBack = 3 } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.analyzeCostsByTags(organizationId, monthsBack)
          );
        
          return createToolResponse({ organizationId, monthsBack, data: result }, 'Cost analysis by tags - breakdown by CostCenter, Department, etc.');
        }

        case 'find_similar_subscriptions_and_invoices': {
          const { organizationId, namePattern } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.findSimilarSubscriptionsAndInvoices(organizationId, namePattern)
          );
        
          return createToolResponse({ organizationId, namePattern, data: result }, 'Similar subscriptions and their latest invoices');
        }

        case 'list_all_subscriptions_with_tags': {
          const { organizationId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.listAllSubscriptionsWithTags(organizationId)
          );
        
          return createToolResponse({ organizationId: organizationId || 'all', data: result }, 'All subscriptions with their tags');
        }

        case 'get_last_month_costs_by_organization': {
          const { organizationId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getLastMonthCostsByOrganization(organizationId)
          );
        
          return createToolResponse({ organizationId, data: result }, 'Last month costs summary');
        }

        case 'get_last_month_costs_by_invoice_profile': {
          const { organizationId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getLastMonthCostsByInvoiceProfile(organizationId)
          );
        
          return createToolResponse({ organizationId, data: result }, 'Last month costs by invoice profile');
        }

        case 'get_last_month_costs_by_tags': {
          const { organizationId } = validatedArgs as any;
          const result = await executeWithCircuitBreaker(
            () => crayonClient.getLastMonthCostsByTags(organizationId)
          );
        
          return createToolResponse({ organizationId, data: result }, 'Last month costs broken down by tags');
        }

        case 'visualize_costs_pie_chart': {
          const { organizationId, monthsBack = 3, topN = 10, chartStyle = 'pie' } = validatedArgs as any;
        
          // Billing statements always return a flat array (see unwrapList).
          const billingData = await executeWithCircuitBreaker(
            () => crayonClient.getHistoricalBilling(organizationId, monthsBack)
          );
        
          // Group by invoice profile and sum costs. Grouped statements are keyed by
          // invoice profile, not subscription name, so that is the honest label.
          const profileCosts = billingData.reduce((acc: any, item: any) => {
            const label = item?.invoiceProfile?.name ?? 'Unallocated';
            acc[label] = (acc[label] || 0) + priceValue(item?.totalSalesPrice);
            return acc;
          }, {});
        
          // Sort and take top N
          const sortedData = Object.entries(profileCosts)
            .sort((a: any, b: any) => b[1] - a[1])
            .slice(0, topN);

          const labels = sortedData.map(([name]) => name);
          const values = sortedData.map(([, cost]) => cost as number);
          const total = values.reduce((sum, val) => sum + val, 0);

          const currency = billingData.length
            ? priceCurrency(billingData[0]?.totalSalesPrice)
            : 'NOK';
          const title = `Cost Distribution by Invoice Profile (Last ${monthsBack} Months)`;
        
          // Generate chart
          const chartDataUrl = chartStyle === 'doughnut'
            ? await chartGenerator.generateDoughnutChart(labels, values, title, currency)
            : await chartGenerator.generatePieChart(labels, values, title, currency);
        
          const share = (cost: number) => (total > 0 ? ((cost / total) * 100).toFixed(1) : '0.0');

          return {
            content: [
              {
                type: 'text',
                text: `# Cost Distribution (Last ${monthsBack} Months)\n\n**Total Cost:** ${total.toFixed(2)} ${currency}\n**Top ${labels.length} Profiles:**\n${sortedData.map(([name, cost], idx) => `${idx + 1}. ${name}: ${(cost as number).toFixed(2)} ${currency} (${share(cost as number)}%)`).join('\n')}\n\n`,
              },
              {
                type: 'image',
                data: chartDataUrl.split(',')[1],
                mimeType: 'image/png',
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      // OWASP Security: A03:2021 - Injection & A09:2021 - Security Logging
      //
      // One consolidated failure log: the tool, caller, org, duration, status and
      // stack all land in a single structured entry. (The previous code logged
      // the same failure three times here plus once more inside
      // sanitizeErrorMessage, which inflated log volume ~4x per failed call.)
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const statusCode = (error as any)?.response?.status ?? 'unknown';

      logger.error(`Tool execution failed: ${name}`, {
        tool: name,
        userId,
        organizationId,
        statusCode,
        errorMessage,
        duration,
        stack: error instanceof Error ? error.stack : undefined,
      });

      logToolExecution({
        tool: name,
        userId,
        organizationId,
        duration,
        status: 'failure',
        error: errorMessage,
      });

      // OWASP Security: A03:2021 - Sensitive Data Exposure
      // Sanitized message for the client; the full detail stays in the log above.
      const sanitizedMessage = sanitizeErrorMessage(error, name);
    
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: sanitizedMessage,
              tool: name,
              requestId: randomUUID(),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// MCP entry serving the latest (2026-07-28) protocol revision.
// `legacy: 'reject'` declines 2025-era clients with an explicit
// "Unsupported protocol version" error rather than silently serving them, so
// every caller speaks the same, current wire contract.
const mcpHandler = createMcpHandler(createServer, {
  legacy: 'reject',
  onerror: (error) => {
    metrics.errorCount++;
    logger.error('MCP handler error', { error: error.message });
  },
});

// Node adapter for Express: forwards `req.auth` to tool handlers as `ctx.http.authInfo`.
const mcpNodeHandler = toNodeHandler(mcpHandler, {
  onerror: (error) => {
    metrics.errorCount++;
    logger.error('MCP node adapter error', { error: error.message });
  },
});

// Graceful shutdown handler
let isShuttingDown = false;
let httpServer: ReturnType<typeof import('http').createServer> | null = null;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  // All status output goes to stderr, which is where container platforms
  // (Azure Container Apps) collect logs from. stdout is left untouched so it can
  // never interfere with any protocol output.
  console.error(`\n${signal} received. Starting graceful shutdown...`);
  
  // Stop accepting new connections
  if (httpServer) {
    httpServer.close(() => {
      console.error('HTTP server closed');
    });
  }
  
  // Abort in-flight MCP exchanges and close their per-request server instances
  try {
    await mcpHandler.close();
    console.error('MCP handler closed');
  } catch (e) {
    // Failure to close in-flight exchanges must not prevent shutdown, but it
    // still needs to be visible in container logs.
    console.error('Error closing MCP handler during shutdown:', e instanceof Error ? e.message : e);
  }
  
  console.error('Graceful shutdown complete');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * Starts the Streamable HTTP server. HTTP is the only supported transport:
 * the deployment target is Azure Container Apps reached through Application
 * Gateway and API Management.
 */
async function startServer(): Promise<void> {
  const app = express();

  // OWASP Security: A05:2021 - Security Misconfiguration
  app.disable('x-powered-by'); // Hide Express fingerprint

  // Helmet for comprehensive security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
  }));

  // Compression middleware
  app.use(compression());

  // OWASP Security: A03:2021 - Injection
  app.use(express.json({ limit: '1mb' })); // Limit payload size to prevent DoS

  // Apply rate limiting
  app.use(rateLimiter);

  // Request ID middleware for tracing
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers['x-request-id'] as string || randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
  });

  // Request timeout middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.setTimeout(config.requestTimeoutMs, () => {
      if (!res.headersSent) {
        res.status(408).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Request timeout' },
          id: null,
        });
      }
    });
    next();
  });

  // Metrics tracking middleware
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    metrics.requestCount++;
    next();
  });

  // Health check endpoint (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    const uptime = Date.now() - metrics.startTime;
    res.json({ 
      status: isShuttingDown ? 'shutting_down' : 'ok', 
      server: SERVER_NAME,
      version: SERVER_VERSION,
      tools: tools.length,
      uptime: Math.floor(uptime / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  // Metrics endpoint for observability
  app.get('/metrics', (_req: Request, res: Response) => {
    const uptime = Date.now() - metrics.startTime;
    res.json({
      uptime: Math.floor(uptime / 1000),
      requests: metrics.requestCount,
      errors: metrics.errorCount,
      circuitBreaker: {
        trips: metrics.circuitBreakerTrips,
        status: circuitBreaker.getStatus(),
      },
      toolCalls: metrics.toolCalls,
    });
  });

  // Apply authentication middleware to /mcp and /metrics endpoints
  if (config.authMode !== 'none') {
    app.use('/mcp', authenticateRequest);
    app.use('/metrics', authenticateRequest);
  }

  // MCP Streamable HTTP endpoint.
  //
  // `toNodeHandler` adapts the web-standard handler to a Node (req, res)
  // handler and forwards `req.auth` through as pass-through `authInfo`.
  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      await mcpNodeHandler(req, res, req.body);
    } catch (error) {
      logger.error('Error handling MCP request', { error: error instanceof Error ? error.message : 'Unknown' });
      metrics.errorCount++;
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  httpServer = app.listen(config.port, config.host, () => {
    // Startup info goes to stderr (see gracefulShutdown note). Kept concise
    // and single-line-friendly so container log forwarding stays greppable.
    const endpoints = {
      mcp: `http://${config.host}:${config.port}/mcp`,
      health: `http://${config.host}:${config.port}/health`,
      metrics: `http://${config.host}:${config.port}/metrics`,
    };

    console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${config.host}:${config.port}`);
    console.error(`  protocol:  2026-07-28 (Streamable HTTP)`);
    console.error(`  mcp:       ${endpoints.mcp}`);
    console.error(`  health:    ${endpoints.health}`);
    console.error(`  metrics:   ${endpoints.metrics}`);
    console.error(`  tools:     ${tools.length}`);
    console.error(`  auth mode: ${config.authMode}`);

    if (config.authMode === 'entra') {
      console.error(`  tenant:    ${config.entraTenantId}`);
      console.error(`  audience:  ${config.entraAudience}`);
      console.error(`  roles:     ${config.entraReadRole} (read), ${config.entraWriteRole} (write)`);
    } else if (config.authMode === 'token') {
      // Never print the token itself; note only that one is configured.
      console.error('  note:      AUTH_MODE=token is for local use; use entra in Azure');
    }

    if (config.nodeEnv !== 'production') {
      console.error('  mode:      development');
    }
  });
}

// Start the HTTP server (Streamable HTTP) directly.
startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});