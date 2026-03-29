#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { CrayonApiClient } from './crayon-client.js';
import { logger, logToolExecution } from './middleware/logger.js';
import { authenticateRequest } from './middleware/auth.js';
import { validateToolInput } from './middleware/validation.js';
import { sanitizeErrorMessage, createCircuitBreakerWrapper } from './middleware/security.js';
import { chartGenerator } from './utils/chart-generator.js';
import { formatMonthYear, getCurrentLocale } from './utils/localization.js';
import { loadConfig, createMetrics, SimpleCache, AppConfig, AppMetrics } from './utils/config.js';

dotenv.config();

// Load and validate configuration
let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration error');
  process.exit(1);
}

// Initialize metrics
const metrics: AppMetrics = createMetrics();

// Initialize response cache
const responseCache = new SimpleCache<any>(config.cacheTtlMs, config.cacheMaxSize);

// Initialize Crayon API client
const crayonClient = new CrayonApiClient(
  config.crayonClientId,
  config.crayonClientSecret,
  config.crayonUsername,
  config.crayonPassword,
  config.crayonApiBaseUrl
);

// Initialize circuit breaker for API calls
const circuitBreaker = createCircuitBreakerWrapper(() => {
  metrics.circuitBreakerTrips++;
});

// Rate limiting configuration
const rateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
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
 * Helper function to execute API calls with circuit breaker protection and optional caching
 */
async function executeWithCircuitBreaker<T>(
  apiCall: () => Promise<T>, 
  cacheKey?: string,
  fallback?: T
): Promise<T> {
  // Check cache first if key provided
  if (cacheKey && config.cacheEnabled) {
    const cached = responseCache.get(cacheKey);
    if (cached !== undefined) {
      metrics.cacheHits++;
      return cached;
    }
    metrics.cacheMisses++;
  }
  
  const result = await circuitBreaker.execute(apiCall, fallback);
  
  // Cache result if key provided
  if (cacheKey && config.cacheEnabled && result !== undefined) {
    responseCache.set(cacheKey, result);
  }
  
  return result;
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
];

// Create MCP server
const server = new Server(
  {
    name: 'crayon-cost-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const userId = (request as any).user?.id || 'unknown';
  let organizationId = (args as any)?.organizationId || null;
  const startTime = Date.now();

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

      case 'get_subscriptions': {
        const { organizationId, page, pageSize } = validatedArgs as any;
        const result = await executeWithCircuitBreaker(
          () => crayonClient.getSubscriptions(organizationId, page, pageSize)
        );
        return createToolResponse(result);
      }

      case 'get_cost_by_subscription': {
        const { organizationId, invoiceProfileId, monthsBack = 3 } = validatedArgs as any;
        
        // Get historical billing and subscriptions in parallel with circuit breaker
        const [billingData, subscriptions] = await Promise.all([
          executeWithCircuitBreaker(() => crayonClient.getHistoricalBilling(organizationId, monthsBack, invoiceProfileId)),
          executeWithCircuitBreaker(() => crayonClient.getSubscriptions(organizationId)),
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
        
        // Get billing data for the period with circuit breaker
        const billingDataResponse = await executeWithCircuitBreaker(
          () => crayonClient.getHistoricalBilling(organizationId, monthsBack)
        );
        const billingData = Array.isArray(billingDataResponse) ? billingDataResponse : (billingDataResponse?.data || []);
        
        // Group by subscription and sum costs
        const subscriptionCosts = billingData.reduce((acc: any, item: any) => {
          const subName = item.subscriptionName || item.name || 'Unknown';
          const cost = parseFloat(item.totalSalesPrice || item.totalCost || item.cost || 0);
          acc[subName] = (acc[subName] || 0) + cost;
          return acc;
        }, {});
        
        // Sort and take top N
        const sortedData = Object.entries(subscriptionCosts)
          .sort((a: any, b: any) => b[1] - a[1])
          .slice(0, topN);
        
        const labels = sortedData.map(([name]) => name);
        const values = sortedData.map(([, cost]) => cost as number);
        const total = values.reduce((sum, val) => sum + val, 0);
        
        // Generate chart
        const chartDataUrl = chartStyle === 'doughnut'
          ? await chartGenerator.generateDoughnutChart(
              labels,
              values,
              `Cost Distribution by Subscription (Last ${monthsBack} Months)`,
              'USD'
            )
          : await chartGenerator.generatePieChart(
              labels,
              values,
              `Cost Distribution by Subscription (Last ${monthsBack} Months)`,
              'USD'
            );
        
        return {
          content: [
            {
              type: 'text',
              text: `# Cost Distribution (Last ${monthsBack} Months)\n\n**Total Cost:** $${total.toFixed(2)}\n**Top ${labels.length} Subscriptions:**\n${sortedData.map(([name, cost], idx) => `${idx + 1}. ${name}: $${(cost as number).toFixed(2)} (${((cost as number / total) * 100).toFixed(1)}%)`).join('\n')}\n\n`,
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
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const axiosError = error instanceof Error && (error as any).response;
    const statusCode = axiosError ? (error as any).response.status : 'unknown';
    
    logger.error(`Tool execution failed: ${name}`, { errorMessage, stack: error instanceof Error ? error.stack : undefined });
    
    // Log full error for audit trail
    logger.error(`Tool execution error [${name}]`, {
      tool: name,
      userId,
      organizationId,
      statusCode,
      errorMessage,
      duration,
    });

    // Log tool execution end
    logToolExecution({
      tool: name,
      userId,
      organizationId,
      duration,
      status: 'failure',
      error: errorMessage,
    });

    // OWASP Security: A03:2021 - Sensitive Data Exposure
    // Sanitize error message before returning to client
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

// Determine transport mode
const transportMode = config.transportMode;

// Store transports by session ID for HTTP mode
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Graceful shutdown handler
let isShuttingDown = false;
let httpServer: ReturnType<typeof import('http').createServer> | null = null;
let sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  // Stop accepting new connections
  if (httpServer) {
    httpServer.close(() => {
      console.log('HTTP server closed');
    });
  }
  
  // Clear cleanup interval
  if (sessionCleanupInterval) {
    clearInterval(sessionCleanupInterval);
    sessionCleanupInterval = null;
  }
  
  // Close all MCP sessions
  const sessionIds = Object.keys(transports);
  console.log(`Closing ${sessionIds.length} active sessions...`);
  
  for (const sessionId of sessionIds) {
    try {
      transports[sessionId].close();
      delete transports[sessionId];
    } catch (e) {
      // Ignore close errors
    }
  }
  
  // Clear cache
  responseCache.clear();
  
  console.log('Graceful shutdown complete');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function startServer() {
  if (transportMode === 'stdio') {
    console.error('Starting Crayon Cost MCP server in stdio mode...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Crayon Cost MCP server running in stdio mode');
  } else {
    // HTTP mode with StreamableHTTPServerTransport
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
        server: 'crayon-cost-mcp',
        version: '1.0.0',
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
        cache: {
          hits: metrics.cacheHits,
          misses: metrics.cacheMisses,
          size: responseCache.size(),
          hitRate: metrics.cacheHits + metrics.cacheMisses > 0 
            ? (metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses) * 100).toFixed(1) + '%'
            : 'N/A',
        },
        sessions: Object.keys(transports).length,
        toolCalls: metrics.toolCalls,
      });
    });

    // Apply authentication middleware to /mcp and /metrics endpoints
    if (config.authEnabled) {
      app.use('/mcp', authenticateRequest);
      app.use('/metrics', authenticateRequest);
    }

    // MCP Streamable HTTP endpoint - handles all GET/POST/DELETE requests
    app.all('/mcp', async (req: Request, res: Response) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport for this session
          transport = transports[sessionId];
          // Update last activity timestamp for session cleanup
          (transport as any).lastActivity = Date.now();
        } else if (!sessionId && req.method === 'POST' && req.body?.method === 'initialize') {
          // Create new transport for initialization request
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports[newSessionId] = transport;
              (transport as any).lastActivity = Date.now();
            }
          });

          // Set up onclose handler to clean up transport when closed
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              delete transports[sid];
            }
          };

          // Connect the transport to the MCP server
          await server.connect(transport);
        } else {
          // Invalid request - no session ID or not initialization request
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided'
            },
            id: null
          });
          return;
        }

        // Let the transport handle the request according to MCP protocol
        await transport.handleRequest(req, res, req.body);
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
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Crayon Cost MCP server running on http://${config.host}:${config.port}`);
      console.log(`Health check: http://${config.host}:${config.port}/health`);
      console.log(`Metrics:      http://${config.host}:${config.port}/metrics`);
      console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
      console.log(`${'='.repeat(80)}\n`);
      
      // Display authentication instructions for production use
      if (config.authEnabled) {
        const authToken = config.authToken || 'NOT_SET';
        // Only show partial token for security
        const maskedToken = authToken.length > 8 
          ? `${authToken.substring(0, 4)}...${authToken.substring(authToken.length - 4)}`
          : '****';
        console.log('AUTHENTICATION ENABLED');
        console.log(`${'─'.repeat(80)}`);
        console.log(`Token (masked): ${maskedToken}`);
        console.log(`Full token available in AUTH_TOKEN environment variable`);
        console.log(`${'─'.repeat(80)}`);
        console.log('\nUsage in MCP requests:');
        console.log(`curl -X POST http://localhost:${config.port}/mcp \\`);
        console.log(`  -H "Authorization: Bearer $AUTH_TOKEN" \\`);
        console.log(`  -H "Content-Type: application/json" \\`);
        console.log(`  -d '{...}'`);
        console.log('\n');
      }
      
      if (config.nodeEnv !== 'production') {
        console.log('Running in development mode');
      }
      
      // Start session cleanup interval
      sessionCleanupInterval = setInterval(() => {
        if (isShuttingDown) return;
        
        const now = Date.now();
        for (const [sessionId, transport] of Object.entries(transports)) {
          const lastActivity = (transport as any).lastActivity || 0;
          if (now - lastActivity > config.sessionTimeoutMs) {
            try {
              transport.close();
            } catch (e) {
              // Ignore close errors
            }
            delete transports[sessionId];
          }
        }
        
        // Also cleanup expired cache entries
        responseCache.cleanup();
      }, config.sessionCleanupIntervalMs);
    });
  }
}

// Start the server
startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});