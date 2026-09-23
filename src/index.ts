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
import { authenticateRequest, callerFromAuthInfo, canInvokeTool, enforceToolPolicy } from './middleware/auth.js';
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
const SERVER_VERSION = '1.2.0';

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

// Define MCP tools.
//
// Descriptions are written for non-technical business users: they explain the
// Crayon vocabulary (organization, invoice profile, Azure Plan, provision type)
// in plain words, give an example question the tool answers, and point to the
// tool that discovers a required ID. `title` is the short human-readable name
// clients can display instead of the snake_case tool name.
const tools: Tool[] = [
  {
    name: 'get_billing_statements',
    title: 'Billing history',
    description: 'Show the monthly billing statements for an organization — what was billed each month and through which invoice profile. Use this for questions like "what did we spend in total last month?" or "how has the monthly bill changed since January?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Only include one invoice profile (the subscriptions billed together, often a department or contract). Find IDs with get_invoice_profiles.',
        },
        provisionType: {
          type: 'string',
          enum: ['None', 'Seat', 'Usage', 'OneTime', 'Crayon', 'AzureMarketplace'],
          description: 'Only count one kind of billing: "Seat" (per-user licences), "Usage" (pay-as-you-go consumption), "OneTime" (one-off purchases), "Crayon" (Crayon-managed services) or "AzureMarketplace" (third-party marketplace products). Omit to include everything.',
        },
        from: {
          type: 'string',
          description: 'Only include statements from this date, YYYY-MM-DD (e.g. 2026-01-01).',
        },
        to: {
          type: 'string',
          description: 'Only include statements up to this date, YYYY-MM-DD (e.g. 2026-06-30).',
        },
        page: {
          type: 'number',
          description: 'Page number to fetch, for large result sets (default: 1).',
        },
        pageSize: {
          type: 'number',
          description: 'Results per page, 1-500 (default: 100).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_grouped_billing_statements',
    title: 'Billing totals per cycle',
    description: 'The same billing data as get_billing_statements, grouped per billing cycle so you get one total per month/period instead of row after row. Use it for a quick "how much did we spend each month?" answer.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Only include one invoice profile (the subscriptions billed together, often a department or contract). Find IDs with get_invoice_profiles.',
        },
        provisionType: {
          type: 'string',
          enum: ['None', 'Seat', 'Usage', 'OneTime', 'Crayon', 'AzureMarketplace'],
          description: 'Only count one kind of billing: "Seat" (per-user licences), "Usage" (pay-as-you-go consumption), "OneTime" (one-off purchases), "Crayon" (Crayon-managed services) or "AzureMarketplace" (third-party marketplace products). Omit to include everything.',
        },
        from: {
          type: 'string',
          description: 'Only include from this date, YYYY-MM-DD (e.g. 2026-01-01).',
        },
        to: {
          type: 'string',
          description: 'Only include up to this date, YYYY-MM-DD (e.g. 2026-06-30).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_azure_usage',
    title: 'Download Azure usage details',
    description: 'Get a temporary, secure download link (SAS URI) to a CSV file with the detailed Azure usage for one Azure subscription in one month — every resource and its measured consumption. Open the link in Excel to drill down. Needs the numeric Azure plan ID and Crayon subscription ID (see get_azure_plan_details and get_azure_plan_subscriptions).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'ID of the Azure Plan — in Crayon terms the agreement under which a customer buys its Azure consumption. Find it with get_customer_tenants or get_azure_plan_details.',
        },
        subscriptionId: {
          type: 'number',
          description: 'Crayon ID of the subscription (an individual Azure account). Find it with get_azure_plan_subscriptions.',
        },
        year: {
          type: 'number',
          description: 'Year of the usage period (e.g. 2026).',
        },
        month: {
          type: 'number',
          description: 'Month of the usage period, 1-12 (e.g. 8 for August).',
        },
        includeBom: {
          type: 'boolean',
          description: 'Add a byte-order mark so Excel opens the CSV cleanly (recommended for Excel users).',
        },
      },
      required: ['azurePlanId', 'subscriptionId', 'year', 'month'],
    },
  },
  {
    name: 'get_invoices',
    title: 'Issued invoices',
    description: 'List the invoices actually issued to an organization, with amounts, dates and status. Use it for questions like "has the invoice for June arrived, and how much was it?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        page: {
          type: 'number',
          description: 'Page number to fetch, for large result sets (default: 1).',
        },
        pageSize: {
          type: 'number',
          description: 'Results per page, 1-500 (default: 100).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_invoice_profiles',
    title: 'Invoice profiles',
    description: 'List the invoice profiles of an organization. An invoice profile groups the subscriptions that are billed together — think of it as a section on the invoice, often one department, contract or agreement. Most cost questions are easiest to answer per invoice profile.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_organizations',
    title: 'List organizations',
    description: 'List every organization (the company account in Crayon that owns the billing) your credentials can see. Always start here when you do not know any IDs — every other tool needs the organization ID this returns.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_historical_costs',
    title: 'Cost history (monthly)',
    description: 'Pull the billing history for the last months, one total per month, for an organization. Use it to compare periods, e.g. "compare this quarter with the previous one".',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        monthsBack: {
          type: 'number',
          description: 'How many months back to include (default: 6, max: 24).',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Only include one invoice profile (a billing group, often a department or contract). Find IDs with get_invoice_profiles.',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_customer_tenants',
    title: 'List customers',
    description: 'List the customer tenants — the customer companies (for example a municipality or a business) that the organization manages or bills for. Each customer can have its own Azure Plan. Use it to find the customer tenant ID needed for subscription lookups.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Only include customers of one organization (a Crayon company account). Omit to include all organizations you can see.',
        },
      },
    },
  },
  {
    name: 'get_azure_subscriptions',
    title: 'Azure subscriptions for one customer',
    description: 'List the Azure subscriptions that belong to one customer tenant, resolved through the Azure Plan of that customer. Use it to answer "which Azure subscriptions does this customer have?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        customerTenantId: {
          type: 'number',
          description: 'ID of the customer tenant (the customer company). Find it with get_customer_tenants.',
        },
      },
      required: ['customerTenantId'],
    },
  },
  {
    name: 'get_subscriptions',
    title: 'All cloud subscriptions',
    description: 'List cloud subscriptions across Azure, AWS and other publishers, with names, statuses and tags. Works for one organization or all of them, so it is the best starting point to identify a subscription by name before digging into its costs.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Only include subscriptions of one organization (a Crayon company account). Omit to include all organizations you can see.',
        },
        page: {
          type: 'number',
          description: 'Page number to fetch (when omitted, everything is returned).',
        },
        pageSize: {
          type: 'number',
          description: 'Results per page, 1-500 (used together with page).',
        },
      },
    },
  },
  {
    name: 'get_cost_by_subscription',
    title: 'Cost per subscription',
    description: 'Combine the billing history with the subscription list so costs can be compared side by side per subscription. Use it for "which subscriptions cost the most over the last 3 months?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        invoiceProfileId: {
          type: 'number',
          description: 'Only include one invoice profile (a billing group, often a department or contract). Find IDs with get_invoice_profiles.',
        },
        monthsBack: {
          type: 'number',
          description: 'How many months back to include (default: 3, max: 24).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_subscription_details',
    title: 'Subscription details',
    description: 'Show everything Crayon knows about one subscription: name, offer, status, publisher and its cost-allocation tags. Use it to identify what a subscription actually is before attributing cost to it.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: {
          type: 'number',
          description: 'Crayon ID of the subscription (an individual Azure or AWS account). Find it with get_subscriptions.',
        },
      },
      required: ['subscriptionId'],
    },
  },
  {
    name: 'get_subscription_tags',
    title: 'Read subscription tags',
    description: 'Read the cost-allocation tags of one subscription: costCenter, department, project, custom and owner. Use it to check how a subscription is set up for cost tracking, for example before allocating its costs.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: {
          type: 'number',
          description: 'Crayon ID of the subscription (an individual Azure or AWS account). Find it with get_subscriptions.',
        },
      },
      required: ['subscriptionId'],
    },
  },
  {
    name: 'update_subscription_tags',
    title: 'Replace subscription tags',
    description: 'Set the cost-allocation tags on one subscription: costCenter, department, project, custom and owner. Crayon only accepts these five fields, and the update REPLACES the whole tag set — any field you leave out is cleared, so read the current tags with get_subscription_tags first. Requires the user.write app role.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: {
          type: 'number',
          description: 'Crayon ID of the subscription (an individual Azure or AWS account). Find it with get_subscriptions.',
        },
        tags: {
          type: 'object',
          description: 'The five Crayon tag fields, e.g. {"costCenter": "IT-100", "department": "IT", "project": "Cloud migration", "owner": "anna@example.com"}. Fields you leave out are cleared.',
        },
      },
      required: ['subscriptionId', 'tags'],
    },
  },
  {
    name: 'get_azure_plan_details',
    title: 'Azure Plan details',
    description: 'Show the details of one Azure Plan — in Crayon terms the agreement under which a customer buys its modern Azure consumption, identified by a numeric plan ID — including everything attached to it.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'ID of the Azure Plan. Find plan IDs per customer with get_customer_tenants, or via get_azure_plan_subscriptions.',
        },
      },
      required: ['azurePlanId'],
    },
  },
  {
    name: 'get_azure_plan_subscriptions',
    title: 'Subscriptions in an Azure Plan',
    description: 'List all Azure subscriptions under one Azure Plan. Use it to go from a plan ID to the concrete subscriptions that generate usage and cost.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'ID of the Azure Plan. Find plan IDs per customer with get_customer_tenants, or via get_azure_plan_details.',
        },
      },
      required: ['azurePlanId'],
    },
  },
  {
    name: 'track_costs_by_tags',
    title: 'Cost by tags over time',
    description: 'Track costs over the last months grouped by the subscription tags, so spending can be followed per department, project or cost center. Use it for "how much of our spend is the IT department this quarter?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        monthsBack: {
          type: 'number',
          description: 'How many months back to analyze (default: 3, max: 24).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_azure_costs_by_date_range',
    title: 'Azure spend in a period',
    description: 'Total Azure cost for an organization between two dates, aggregated across all its Azure subscriptions. Use it for "what did Azure cost between March and May?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        from: {
          type: 'string',
          description: 'Start of the period, YYYY-MM-DD (e.g. 2026-03-01).',
        },
        to: {
          type: 'string',
          description: 'End of the period, YYYY-MM-DD (e.g. 2026-05-31).',
        },
      },
      required: ['organizationId', 'from', 'to'],
    },
  },
  {
    name: 'get_azure_costs_by_subscription',
    title: 'Azure spend for one subscription',
    description: 'Azure cost for a single subscription between two dates. Use it to drill into one subscription, for example "what did subscription X cost in August?". Needs the numeric Azure plan ID and Crayon subscription ID (see get_azure_plan_subscriptions).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        azurePlanId: {
          type: 'number',
          description: 'ID of the Azure Plan — in Crayon terms the agreement under which a customer buys its Azure consumption. Find it with get_customer_tenants or get_azure_plan_details.',
        },
        subscriptionId: {
          type: 'number',
          description: 'Crayon ID of the subscription (an individual Azure account). Find it with get_azure_plan_subscriptions.',
        },
        from: {
          type: 'string',
          description: 'Start of the period, YYYY-MM-DD (e.g. 2026-08-01).',
        },
        to: {
          type: 'string',
          description: 'End of the period, YYYY-MM-DD (e.g. 2026-08-31).',
        },
      },
      required: ['azurePlanId', 'subscriptionId', 'from', 'to'],
    },
  },
  {
    name: 'get_cost_trends',
    title: 'Cost trend chart',
    description: 'Analyze how costs moved month by month, and get a line chart plus a short summary (average, highest and lowest month, percent changes). Use it for "is our cloud bill going up?" — good for reports to management.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        monthsBack: {
          type: 'number',
          description: 'How many months back to analyze (default: 6, max: 24).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'detect_cost_anomalies',
    title: 'Find cost spikes',
    description: 'Detect subscriptions whose cost changed significantly from one month to the next, and show what changed and by how much. Use it for "why did the bill jump last month?" or to catch surprises before the invoice arrives.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        monthsBack: {
          type: 'number',
          description: 'How many months back to analyze (default: 3, max: 24).',
        },
        changeThresholdPercent: {
          type: 'number',
          description: 'How big a month-over-month change (in percent) counts as an anomaly (default: 25).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'analyze_costs_by_tags',
    title: 'Cost split by tag',
    description: 'Break costs down per tag value (costCenter, department, project, owner) for a period, showing the total per value. Use it for "how much did each department spend?" when tags are maintained.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        monthsBack: {
          type: 'number',
          description: 'How many months back to analyze (default: 3, max: 24).',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'find_similar_subscriptions_and_invoices',
    title: 'Find subscriptions by name',
    description: 'Find subscriptions whose name matches a text pattern and fetch their latest invoices. Use it to gather related subscriptions, e.g. all production ones (pattern "sub-prod.*") or everything for one customer (pattern "viken.*").',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        namePattern: {
          type: 'string',
          description: 'Text the subscription name should match (regex, case-insensitive, max 100 chars). Examples: "sub-prod.*", ".*-prod", "viken.*".',
        },
      },
      required: ['organizationId', 'namePattern'],
    },
  },
  {
    name: 'list_all_subscriptions_with_tags',
    title: 'Audit subscription tags',
    description: 'List every subscription with its full tag set (costCenter, department, project, custom, owner). Use it to audit tagging accuracy — for example to find subscriptions missing a cost center before running a cost-by-tag report.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Only include subscriptions of one organization (a Crayon company account). Omit to include all organizations you can see.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_last_month_costs_by_organization',
    title: 'Last month total',
    description: 'Total cost for last month for one organization. The quickest answer to "what did we spend last month?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_last_month_costs_by_invoice_profile',
    title: 'Last month per billing group',
    description: 'Last month costs split per invoice profile (the billing groups, often departments or contracts), so you can see which one generated the most cost. Use it for "which part of the company drove the bill last month?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_last_month_costs_by_tags',
    title: 'Last month per tag',
    description: 'Last month costs split per tag value (costCenter, department, project, owner). Use it for "how did last month split across departments/projects?" — requires that tags are maintained.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'visualize_costs_pie_chart',
    title: 'Cost distribution chart',
    description: 'Generate a pie or doughnut chart image showing how cost is distributed across the biggest invoice profiles, with the numbers listed next to it. Use it when a picture is wanted, e.g. for a slide or a status update.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
        },
        monthsBack: {
          type: 'number',
          description: 'How many months to include (default: 3, max: 24).',
        },
        topN: {
          type: 'number',
          description: 'How many of the largest profiles to show (default: 10, max: 50).',
        },
        chartStyle: {
          type: 'string',
          enum: ['pie', 'doughnut'],
          description: 'Chart style: "pie" (filled circle) or "doughnut" (with a hole). Default: pie.',
        },
      },
      required: ['organizationId'],
    },
  },
  {
    name: 'get_aws_accounts',
    title: 'AWS accounts',
    description: 'List AWS accounts managed through Crayon — the AWS equivalent of an Azure subscription — with their tags, payer account and status. Use it to see which AWS accounts exist and how they are tagged, optionally filtered by organization, customer or free-text search.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'Only include accounts of one organization (a Crayon company account). Omit to include all organizations you can see.',
        },
        customerTenantId: {
          type: 'number',
          description: 'Only include accounts of one customer tenant (the customer company). Find it with get_customer_tenants.',
        },
        search: {
          type: 'string',
          description: 'Free-text search, for example an account name (max 100 characters).',
        },
        page: {
          type: 'number',
          description: 'Page number to fetch (default: 1).',
        },
        pageSize: {
          type: 'number',
          description: 'Results per page, 1-500 (default: 100).',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_aws_account_details',
    title: 'AWS account details',
    description: 'Show everything Crayon knows about one AWS account: name, payer account, activation state and its cost-allocation tags. Use it to identify what an AWS account is before attributing cost to it.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'number',
          description: 'Crayon ID of the AWS account. Find it with get_aws_accounts.',
        },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'get_spend_by_cloud_provider',
    title: 'Azure vs AWS overview',
    description: 'Summarize spend and subscription counts per cloud provider (Microsoft Azure, AWS, and others) for an organization, so you can compare clouds side by side. Use it for "how much do we spend on Azure versus AWS?"',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: {
          type: 'number',
          description: 'ID of the organization (your Crayon company account). Find it with get_organizations.',
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
//
// `instructions` is a Crayon-vocabulary glossary returned to clients at the
// initialize handshake. It teaches non-technical callers how the Crayon terms
// map to everyday questions, so the model picks the right tool and the right
// ID chain (organization -> invoice profile / customer tenant -> Azure Plan ->
// subscription) without guesswork.
const SERVER_INSTRUCTIONS = `
This server answers cost and billing questions about Crayon-managed cloud (Azure, AWS and other publishers).

Crayon vocabulary, in plain words:
- organization: the company account in Crayon that owns the billing. Every query needs its numeric ID; discover it with get_organizations.
- invoice profile: a group of subscriptions that are billed together — like a section on the invoice, often one department, contract or agreement. Discover with get_invoice_profiles.
- customer tenant: the customer company that is billed, e.g. a municipality or business. Discover with get_customer_tenants.
- Azure Plan: the agreement under which a customer buys its modern Azure consumption; identified by a numeric plan ID. Discover per customer with get_customer_tenants, and inspect with get_azure_plan_details / get_azure_plan_subscriptions.
- subscription: one Azure or AWS account that generates usage and cost. Discover with get_subscriptions or get_azure_plan_subscriptions.
- tags: the cost-allocation fields on a subscription (costCenter, department, project, custom, owner). Crayon only supports these five; update_subscription_tags REPLACES the whole set, so read tags first with get_subscription_tags.
- provision type: the kind of billing — Seat (per-user licences), Usage (pay-as-you-go), OneTime (one-off purchases), Crayon (Crayon-managed services) or AzureMarketplace (third-party marketplace products).

Typical chains:
- "What did we spend last month?" -> get_organizations, then get_last_month_costs_by_organization.
- Cost split per department/contract -> use the ..._by_invoice_profile or ..._by_tags tools.
- Cost for one Azure subscription -> get_customer_tenants (plan IDs), get_azure_plan_subscriptions, then get_azure_costs_by_subscription or get_azure_usage.
- All dates are YYYY-MM-DD. Money is returned as a Price object with value and currencyCode.
`.trim();

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
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Handle list tools request.
  //
  // The advertised surface is filtered to the tools the caller's app roles
  // permit, so a read-only caller is never shown `update_subscription_tags`
  // (which it could not invoke). Callers therefore see 30 or 31 tools depending
  // on their roles. This is discovery-only — `enforceToolPolicy` at dispatch
  // time remains the authoritative gate, so a tool invoked by name despite being
  // hidden is still refused.
  server.setRequestHandler('tools/list', async (_request: unknown, ctx: ServerContext) => {
    const caller = callerFromAuthInfo(ctx.http?.authInfo);
    return {
      tools: tools.filter((tool) => canInvokeTool(tool.name, caller)),
    };
  });

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
// `legacy: 'stateless'` additionally serves 2025-era clients through the SDK's
// built-in stateless fallback (no mcp-session-id issued; GET/DELETE answered
// 405). VS Code's MCP client currently speaks the 2025-era handshake and falls
// back to it after a 400 on the modern path, so 'reject' breaks every VS Code
// connection with a 405 SSE error. Verbatim JSON-RPC passthrough is identical
// for both eras — the gate is the JWT, not the protocol era.
const mcpHandler = createMcpHandler(createServer, {
  legacy: 'stateless',
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
      console.error(`  audiences: ${config.entraAudiences.join(' ')}`);
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