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
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { CrayonApiClient } from './crayon-client.js';
import { logger, logAudit, logToolExecution, logSecurityEvent } from './middleware/logger.js';
import { authenticateRequest, authorizeOrganization, generateTestToken } from './middleware/auth.js';
import { validateToolInput } from './middleware/validation.js';
import { sanitizeErrorMessage, createCircuitBreakerWrapper, expensiveOperations, rateLimiterConfig } from './middleware/security.js';
import { chartGenerator } from './utils/chart-generator.js';

dotenv.config();

// Validate required security configuration
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('ERROR: JWT_SECRET not set or too short (minimum 32 characters)');
  console.error('Please set JWT_SECRET in .env file');
  if (process.env.AUTH_ENABLED !== 'false') {
    process.exit(1);
  }
}

// Configuration validation and secure defaults
const PORT = parseInt(process.env.PORT || '3003', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_ENABLED = process.env.AUTH_ENABLED !== 'false';

// Validate required credentials
if (!process.env.CRAYON_CLIENT_ID || !process.env.CRAYON_CLIENT_SECRET || 
    !process.env.CRAYON_USERNAME || !process.env.CRAYON_PASSWORD) {
  console.error('ERROR: Missing required Crayon API credentials');
  console.error('Please set: CRAYON_CLIENT_ID, CRAYON_CLIENT_SECRET, CRAYON_USERNAME, CRAYON_PASSWORD');
  process.exit(1);
}

const CRAYON_CLIENT_ID = process.env.CRAYON_CLIENT_ID;
const CRAYON_CLIENT_SECRET = process.env.CRAYON_CLIENT_SECRET;
const CRAYON_USERNAME = process.env.CRAYON_USERNAME;
const CRAYON_PASSWORD = process.env.CRAYON_PASSWORD;
const CRAYON_API_BASE_URL = process.env.CRAYON_API_BASE_URL || 'https://api.crayon.com/api/v1';

// Initialize Crayon API client
const crayonClient = new CrayonApiClient(
  CRAYON_CLIENT_ID,
  CRAYON_CLIENT_SECRET,
  CRAYON_USERNAME,
  CRAYON_PASSWORD,
  CRAYON_API_BASE_URL
);

// Initialize circuit breaker for API calls
const circuitBreaker = createCircuitBreakerWrapper(crayonClient as any);

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
      console.log(`[Tool Call] ${name} with args:`, JSON.stringify(args, null, 2));
      validatedArgs = await validateToolInput(name, args);
      console.log(`[Validation OK] ${name}`);
      organizationId = (validatedArgs as any)?.organizationId || organizationId;
    } catch (validationError: any) {
      console.log(`[Validation FAILED] ${name}:`, validationError?.message || validationError);
      const errorMessage = validationError?.message || 'Unknown validation error occurred';
      
      logger.warn(`Tool validation failed for ${name}`, {
        toolName: name,
        userId,
        organizationId,
        error: errorMessage,
      });
      logSecurityEvent({
        type: 'injection_attempt',
        userId,
        ip: 'unknown',
        details: {
          tool: name,
          reason: errorMessage,
        },
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

    // Log tool execution start
    logger.info(`Tool execution started: ${name}`, {
      tool: name,
      userId,
      organizationId,
    });

    switch (name) {
      case 'get_billing_statements': {
        const result = await crayonClient.getBillingStatements(validatedArgs as any);
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
        const result = await crayonClient.getGroupedBillingStatements(validatedArgs as any);
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

      case 'get_azure_usage': {
        const result = await crayonClient.getAzureUsage(validatedArgs as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_invoices': {
        const { organizationId, page, pageSize } = validatedArgs as any;
        const result = await crayonClient.getInvoices(organizationId, page, pageSize);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_invoice_profiles': {
        const { organizationId } = validatedArgs as any;
        const result = await crayonClient.getInvoiceProfiles(organizationId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_organizations': {
        const result = await crayonClient.getOrganizations();
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

      case 'get_historical_costs': {
        const { organizationId, monthsBack = 6, invoiceProfileId } = validatedArgs as any;
        const result = await crayonClient.getHistoricalBilling(organizationId, monthsBack, invoiceProfileId);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                organizationId,
                monthsBack,
                invoiceProfileId,
                historicalData: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_customer_tenants': {
        const { organizationId } = validatedArgs as any;
        const result = await crayonClient.getCustomerTenants(organizationId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_azure_subscriptions': {
        const { customerTenantId } = validatedArgs as any;
        const result = await crayonClient.getAzureSubscriptions(customerTenantId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_subscriptions': {
        const { organizationId, page, pageSize } = validatedArgs as any;
        const result = await crayonClient.getSubscriptions(organizationId, page, pageSize);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_cost_by_subscription': {
        const { organizationId, invoiceProfileId, monthsBack = 3 } = validatedArgs as any;
        
        // Get historical billing and subscriptions in parallel
        const [billingData, subscriptions] = await Promise.all([
          crayonClient.getHistoricalBilling(organizationId, monthsBack, invoiceProfileId),
          crayonClient.getSubscriptions(organizationId),
        ]);

        const costBreakdown = {
          organizationId,
          monthsBack,
          period: {
            from: new Date(Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
          },
          billingData,
          subscriptions,
          message: 'Cost breakdown with subscription correlation',
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(costBreakdown, null, 2),
            },
          ],
        };
      }

      case 'get_subscription_details': {
        const { subscriptionId } = validatedArgs as any;
        const result = await crayonClient.getSubscriptionById(subscriptionId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_subscription_tags': {
        const { subscriptionId } = validatedArgs as any;
        const result = await crayonClient.getSubscriptionTags(subscriptionId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'update_subscription_tags': {
        const { subscriptionId, tags } = validatedArgs as any;
        const result = await crayonClient.updateSubscriptionTags(subscriptionId, tags);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Tags updated successfully',
                subscriptionId,
                tags: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_azure_plan_details': {
        const { azurePlanId } = validatedArgs as any;
        const result = await crayonClient.getAzurePlan(azurePlanId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_azure_plan_subscriptions': {
        const { azurePlanId } = validatedArgs as any;
        const result = await crayonClient.getAzurePlanSubscriptions(azurePlanId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'track_costs_by_tags': {
        const { organizationId, monthsBack = 3 } = validatedArgs as any;
        const result = await crayonClient.getCostByTags(organizationId, monthsBack);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Cost tracking by subscription tags',
                organizationId,
                monthsBack,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_azure_costs_by_date_range': {
        const { organizationId, from, to } = validatedArgs as any;
        const result = await crayonClient.getAzureCostsByDateRange(organizationId, from, to);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Azure costs by date range',
                organizationId,
                from,
                to,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_azure_costs_by_subscription': {
        const { azurePlanId, subscriptionId, from, to } = validatedArgs as any;
        const result = await crayonClient.getAzureCostsBySubscription(azurePlanId, subscriptionId, from, to);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Azure costs by subscription',
                azurePlanId,
                subscriptionId,
                from,
                to,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_cost_trends': {
        const { organizationId, monthsBack = 6 } = validatedArgs as any;
        const result = await crayonClient.getCostTrends(organizationId, monthsBack);
        
        // Generate line chart if we have data
        if (result.trends && result.trends.length > 0) {
          const labels = result.trends.map((t: any) => t.month);
          const costData = result.trends.map((t: any) => t.cost);
          
          console.log(`[Chart] Generating line chart for ${labels.length} months`);
          console.log(`[Chart] Cost range: ${Math.min(...costData)} - ${Math.max(...costData)}`);
          
          const chartDataUrl = await chartGenerator.generateLineChart(
            labels,
            [{ label: 'Monthly Cost', data: costData }],
            `Cost Trends (Last ${monthsBack} Months)`,
            'Cost (NOK)'
          );
          
          console.log(`[Chart] Line chart generated, length: ${chartDataUrl.length}`);
          
          // Format summary text
          const summary = result.summary;
          const summaryText = `# Cost Trends Analysis (Last ${monthsBack} Months)

**Average Monthly Cost:** ${summary.averageMonthlyCost ? summary.averageMonthlyCost.toFixed(2) : 'N/A'} NOK
**Highest Month:** ${summary.highestMonth ? `${summary.highestMonth.month} (${summary.highestMonth.cost.toFixed(2)} NOK)` : 'N/A'}
**Lowest Month:** ${summary.lowestMonth ? `${summary.lowestMonth.month} (${summary.lowestMonth.cost.toFixed(2)} NOK)` : 'N/A'}

**Month-over-Month Changes:**
${result.trends.map((t: any) => {
  const changeText = t.change !== null 
    ? `${t.change >= 0 ? '+' : ''}${t.change.toFixed(2)} NOK (${t.changePercent >= 0 ? '+' : ''}${t.changePercent}%)`
    : 'N/A';
  return `- ${t.month}: ${t.cost.toFixed(2)} NOK (${changeText})`;
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Cost trends analysis - month over month comparison',
                organizationId,
                monthsBack,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'detect_cost_anomalies': {
        const { organizationId, monthsBack = 3, changeThresholdPercent = 25 } = validatedArgs as any;
        const result = await crayonClient.detectCostAnomalies(organizationId, monthsBack, changeThresholdPercent);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Cost anomaly detection - subscriptions with significant changes',
                organizationId,
                monthsBack,
                changeThresholdPercent,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'analyze_costs_by_tags': {
        const { organizationId, monthsBack = 3 } = validatedArgs as any;
        const result = await crayonClient.analyzeCostsByTags(organizationId, monthsBack);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Cost analysis by tags - breakdown by CostCenter, Department, etc.',
                organizationId,
                monthsBack,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'find_similar_subscriptions_and_invoices': {
        const { organizationId, namePattern } = validatedArgs as any;
        const result = await crayonClient.findSimilarSubscriptionsAndInvoices(organizationId, namePattern);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Similar subscriptions and their latest invoices',
                organizationId,
                namePattern,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'list_all_subscriptions_with_tags': {
        const { organizationId } = validatedArgs as any;
        const result = await crayonClient.listAllSubscriptionsWithTags(organizationId);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'All subscriptions with their tags',
                organizationId: organizationId || 'all',
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_last_month_costs_by_organization': {
        const { organizationId } = validatedArgs as any;
        const result = await crayonClient.getLastMonthCostsByOrganization(organizationId);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Last month costs summary',
                organizationId,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_last_month_costs_by_invoice_profile': {
        const { organizationId } = validatedArgs as any;
        const result = await crayonClient.getLastMonthCostsByInvoiceProfile(organizationId);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Last month costs by invoice profile',
                organizationId,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_last_month_costs_by_tags': {
        const { organizationId } = validatedArgs as any;
        const result = await crayonClient.getLastMonthCostsByTags(organizationId);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Last month costs broken down by tags',
                organizationId,
                data: result,
              }, null, 2),
            },
          ],
        };
      }

      case 'visualize_costs_pie_chart': {
        const { organizationId, monthsBack = 3, topN = 10, chartStyle = 'pie' } = validatedArgs as any;
        
        console.log(`[Chart] Fetching billing data for org ${organizationId}, ${monthsBack} months`);
        // Get billing data for the period
        const billingDataResponse = await crayonClient.getHistoricalBilling(organizationId, monthsBack);
        const billingData = Array.isArray(billingDataResponse) ? billingDataResponse : (billingDataResponse?.data || []);
        console.log(`[Chart] Got ${billingData.length} billing records`);
        
        // Group by subscription and sum costs
        const subscriptionCosts = billingData.reduce((acc: any, item: any) => {
          const subName = item.subscriptionName || item.name || 'Unknown';
          const cost = parseFloat(item.totalSalesPrice || item.totalCost || item.cost || 0);
          acc[subName] = (acc[subName] || 0) + cost;
          return acc;
        }, {});
        
        console.log(`[Chart] Grouped into ${Object.keys(subscriptionCosts).length} subscriptions`);
        
        // Sort and take top N
        const sortedData = Object.entries(subscriptionCosts)
          .sort((a: any, b: any) => b[1] - a[1])
          .slice(0, topN);
        
        const labels = sortedData.map(([name]) => name);
        const values = sortedData.map(([, cost]) => cost as number);
        const total = values.reduce((sum, val) => sum + val, 0);
        
        console.log(`[Chart] Top ${labels.length} subscriptions, total: $${total}`);
        console.log(`[Chart] Generating ${chartStyle} chart...`);
        
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
        
        console.log(`[Chart] Chart generated, length: ${chartDataUrl.length}`);
        
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
    
    console.log(`[ERROR] Tool execution failed: ${name}`, errorMessage);
    console.log(`[ERROR] Stack:`, error instanceof Error ? error.stack : 'No stack trace');
    
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
const transportMode = process.env.TRANSPORT_MODE || 'http';

// Store transports by session ID for HTTP mode
const transports: Record<string, StreamableHTTPServerTransport> = {};

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
    
    // OWASP Security: A03:2021 - Injection
    app.use(express.json({ limit: '1mb' })); // Limit payload size to prevent DoS
    
    // OWASP Security: A01:2021 - Broken Access Control
    // Add security headers
    app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader('Content-Security-Policy', "default-src 'self'");
      res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      next();
    });

    // OWASP Security: A08:2021 - Insecure Rate Limiting
    // Global rate limiter
    const globalLimiter = rateLimit({
      windowMs: rateLimiterConfig.windowMs,
      max: rateLimiterConfig.max.global,
      message: 'Too many requests from this IP, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
    });

    // Per-user rate limiter
    const userLimiter = rateLimit({
      keyGenerator: (req) => req.user?.id || req.ip || 'unknown',
      windowMs: rateLimiterConfig.windowMs,
      max: rateLimiterConfig.max.perUser,
      message: 'Too many requests from this user',
      skip: (req) => !AUTH_ENABLED,
    });

    // Apply rate limiters globally
    app.use(globalLimiter);
    app.use(userLimiter);

    // Health check endpoint (no auth required)
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ 
        status: 'ok', 
        server: 'crayon-cost-mcp', 
        tools: tools.length,
        timestamp: new Date().toISOString(),
      });
    });

    // Apply authentication middleware to /mcp endpoint
    if (AUTH_ENABLED) {
      app.use('/mcp', authenticateRequest);
    }

    // MCP Streamable HTTP endpoint - handles all GET/POST/DELETE requests
    app.all('/mcp', async (req: Request, res: Response) => {
      console.log(`Received ${req.method} request to /mcp`);
      
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        console.log(`[HTTP Request] Session ID: ${sessionId}, Method: ${req.method}, Body method: ${req.body?.method}`);
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport for this session
          console.log(`[Session] Found transport for session ${sessionId}`);
          transport = transports[sessionId];
        } else if (!sessionId && req.method === 'POST' && req.body?.method === 'initialize') {
          // Create new transport for initialization request
          console.log(`[Session] Creating new transport for initialization`);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              console.log(`StreamableHTTP session initialized with ID: ${newSessionId}`);
              transports[newSessionId] = transport;
            }
          });

          // Set up onclose handler to clean up transport when closed
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.log(`Transport closed for session ${sid}, removing from transports map`);
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
        console.error('Error handling MCP request:', error);
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

    app.listen(PORT, HOST, () => {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Crayon Cost MCP server running on http://${HOST}:${PORT}`);
      console.log(`Health check: http://${HOST}:${PORT}/health`);
      console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
      console.log(`${'='.repeat(80)}\n`);
      
      // Generate and display authentication token for production use
      if (AUTH_ENABLED) {
        try {
          const authToken = generateTestToken('admin', 'admin@crayon-cost-mcp.local', [], ['admin']);
          console.log('AUTHENTICATION TOKEN (valid for 24 hours):');
          console.log(`${'─'.repeat(80)}`);
          console.log(`Token: ${authToken}`);
          console.log(`${'─'.repeat(80)}`);
          console.log('\nUsage in MCP requests:');
          console.log(`curl -X POST http://localhost:${PORT}/mcp \\`);
          console.log(`  -H "Authorization: Bearer ${authToken.substring(0, 20)}..." \\`);
          console.log(`  -H "Content-Type: application/json" \\`);
          console.log(`  -d '{...}'`);
          console.log('\n');
          
          // Log token generation for audit trail
          logger.info('MCP Server authentication token generated at startup', {
            userId: 'admin',
            tokenPrefix: authToken.substring(0, 20),
            expiresIn: '24h',
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          logger.error('Failed to generate authentication token', { error: err });
          console.error('WARNING: Could not generate authentication token');
        }
      }
      
      if (process.env.NODE_ENV !== 'production') {
        console.log('Running in development mode');
      }
    });
  }
}

// Start the server
startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

