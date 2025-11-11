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
export function validateRegexPattern(pattern: string): { error?: string; value?: string } {
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
export const schemas = {
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
    tags: Joi.object().pattern(Joi.string(), Joi.string()).required(),
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
    organizationId: positiveInteger,
    page: pageNumber,
    pageSize: pageSize,
  }),

  get_historical_costs: Joi.object({
    organizationId: positiveInteger,
    monthsBack: Joi.number().integer().min(1).max(24).default(6),
  }),

  get_last_month_costs_by_tags: Joi.object({
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
    const { value, error } = await schema.validateAsync(args, {
      abortEarly: false,
      convert: true,
      stripUnknown: true,
    });

    if (error) {
      const messages = error.details.map((d) => `${d.path.join('.')}: ${d.message}`).join(', ');
      throw new Error(`Validation error: ${messages}`);
    }

    return value;
  } catch (e) {
    throw new Error(`Invalid input: ${e instanceof Error ? e.message : 'Unknown validation error'}`);
  }
}
