import Joi from 'joi';

// Common schemas
const positiveInteger = Joi.number().integer().positive().required();
const optionalInteger = Joi.number().integer().positive();
const isoDate = Joi.date().iso();
const pageSize = Joi.number().integer().min(1).max(500).default(100);
const pageNumber = Joi.number().integer().min(1).default(1);

/**
 * Validate regex pattern to prevent ReDoS attacks
 */
function validateRegexPattern(pattern: string): { error?: string; value?: string } {
  // Limit pattern length
  if (pattern.length > 100) {
    return { error: 'Pattern too long (max 100 characters)' };
  }

  // Block dangerous quantifier patterns
  const dangerousPatterns = [
    /(\w\+)+\$/,           // Multiple quantifiers
    /\(\.\*\)\+/,          // Nested quantifiers
    /(\[\w\-\]\+)+/,       // Repeated character classes
    /(\.\*){2,}/,          // Multiple .* patterns
    /\(.*\)\*/,            // Grouped wildcards
  ];

  for (const dangerous of dangerousPatterns) {
    if (dangerous.test(pattern)) {
      return { error: 'Pattern contains potentially dangerous regex constructs (possible ReDoS)' };
    }
  }

  // Try to compile with timeout
  try {
    new RegExp(pattern, 'i');
    return { value: pattern };
  } catch (e) {
    return { error: 'Invalid regex pattern' };
  }
}

// Tool input schemas
const schemas = {
  get_organizations: Joi.object({}),

  get_invoice_profiles: Joi.object({
    organizationId: positiveInteger,
  }),

  get_billing_statements: Joi.object({
    organizationId: positiveInteger,
    invoiceProfileId: optionalInteger,
    provisionType: Joi.string()
      .valid('None', 'Seat', 'Usage', 'OneTime', 'Crayon', 'AzureMarketplace')
      .optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    page: pageNumber,
    pageSize: pageSize,
  }),

  get_grouped_billing_statements: Joi.object({
    organizationId: positiveInteger,
    invoiceProfileId: optionalInteger,
    provisionType: Joi.string()
      .valid('None', 'Seat', 'Usage', 'OneTime', 'Crayon', 'AzureMarketplace')
      .optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  }),

  get_invoices: Joi.object({
    organizationId: positiveInteger,
    page: pageNumber,
    pageSize: pageSize,
  }),

  get_subscriptions: Joi.object({
    organizationId: optionalInteger,
    page: pageNumber,
    pageSize: pageSize,
  }),

  get_cost_by_subscription: Joi.object({
    organizationId: positiveInteger,
    invoiceProfileId: optionalInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(3),
  }),

  get_subscription_details: Joi.object({
    subscriptionId: positiveInteger,
  }),

  get_subscription_tags: Joi.object({
    subscriptionId: positiveInteger,
  }),

  update_subscription_tags: Joi.object({
    subscriptionId: positiveInteger,
    // The Crayon endpoint replaces the whole tag object with these fixed fields,
    // so an arbitrary key/value map is rejected by the API.
    tags: Joi.object({
      costCenter: Joi.string().max(255).allow(null, '').optional(),
      department: Joi.string().max(255).allow(null, '').optional(),
      project: Joi.string().max(255).allow(null, '').optional(),
      custom: Joi.string().max(255).allow(null, '').optional(),
      owner: Joi.string().max(255).allow(null, '').optional(),
    }).min(1).required(),
  }),

  track_costs_by_tags: Joi.object({
    organizationId: positiveInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(3),
  }),

  get_customer_tenants: Joi.object({
    organizationId: optionalInteger,
  }),

  get_azure_subscriptions: Joi.object({
    customerTenantId: positiveInteger,
  }),

  get_azure_plan_details: Joi.object({
    azurePlanId: positiveInteger,
  }),

  get_azure_plan_subscriptions: Joi.object({
    azurePlanId: positiveInteger,
  }),

  get_azure_usage: Joi.object({
    azurePlanId: positiveInteger,
    subscriptionId: positiveInteger,
    year: Joi.number().integer().min(2020).max(2100).required(),
    month: Joi.number().integer().min(1).max(12).required(),
    includeBom: Joi.boolean().default(false),
  }),

  get_cost_trends: Joi.object({
    organizationId: positiveInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(6),
  }),

  detect_cost_anomalies: Joi.object({
    organizationId: positiveInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(3),
    changeThresholdPercent: Joi.number().min(1).max(100).default(25),
  }),

  analyze_costs_by_tags: Joi.object({
    organizationId: positiveInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(3),
  }),

  find_similar_subscriptions_and_invoices: Joi.object({
    organizationId: positiveInteger,
    namePattern: Joi.string().max(100).required().external(async (value) => {
      const validation = validateRegexPattern(value);
      if (validation.error) {
        throw new Error(validation.error);
      }
    }),
  }),

  list_all_subscriptions_with_tags: Joi.object({
    organizationId: optionalInteger,
    page: pageNumber,
    pageSize: pageSize,
  }),

  get_historical_costs: Joi.object({
    organizationId: positiveInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(6),
  }),

  get_azure_costs_by_date_range: Joi.object({
    organizationId: positiveInteger,
    from: isoDate.required(),
    to: isoDate.required(),
  }),

  get_azure_costs_by_subscription: Joi.object({
    azurePlanId: positiveInteger,
    subscriptionId: positiveInteger,
    from: isoDate.required(),
    to: isoDate.required(),
  }),

  get_last_month_costs_by_tags: Joi.object({
    organizationId: positiveInteger,
  }),

  get_last_month_costs_by_organization: Joi.object({
    organizationId: positiveInteger,
  }),

  get_last_month_costs_by_invoice_profile: Joi.object({
    organizationId: positiveInteger,
  }),

  visualize_costs_pie_chart: Joi.object({
    organizationId: positiveInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(3),
    topN: Joi.number().integer().min(1).max(50).default(10),
    chartStyle: Joi.string().valid('pie', 'doughnut').default('pie'),
  }),

  get_aws_accounts: Joi.object({
    organizationId: optionalInteger,
    customerTenantId: optionalInteger,
    search: Joi.string().max(100).optional(),
    page: pageNumber,
    pageSize: pageSize,
  }),

  get_aws_account_details: Joi.object({
    accountId: positiveInteger,
  }),

  get_spend_by_cloud_provider: Joi.object({
    organizationId: positiveInteger,
  }),
};

/**
 * Validate tool input against schema
 */
export async function validateToolInput(toolName: string, args: any): Promise<any> {
  const schema = schemas[toolName as keyof typeof schemas];

  if (!schema) {
    throw new Error(`No validation schema for tool: ${toolName}`);
  }

  try {
    // Joi.validateAsync() returns the validated value directly and throws on validation error
    const validated = await schema.validateAsync(args, {
      abortEarly: false,
      convert: true,
      stripUnknown: true,
    });
    return validated;
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown validation error';
    throw new Error(`Invalid input: ${errorMsg}`);
  }
}
