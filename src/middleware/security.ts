import CircuitBreaker from 'opossum';
import { logger } from './logger.js';

/**
 * Wraps API calls with circuit breaker and timeout
 */
export function createCircuitBreakerWrapper(
  onCircuitOpen?: () => void
) {
  const breaker = new CircuitBreaker(
    async (fn: () => Promise<any>) => fn(),
    {
      timeout: parseInt(process.env.API_TIMEOUT_MS || '30000'), // 30 seconds
      errorThresholdPercentage: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '50'),
      resetTimeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT_MS || '30000'),
      name: 'crayon-api',
      rollingCountBuckets: 10,
      rollingCountTimeout: 10000,
      volumeThreshold: 10, // minimum number of requests before opening circuit
    }
  );

  // Log circuit breaker state changes
  breaker.on('open', () => {
    logger.error('Circuit breaker OPENED - Crayon API appears to be down');
    onCircuitOpen?.();
  });

  breaker.on('halfOpen', () => {
    // Only log at error level per requirements
  });

  breaker.on('close', () => {
    // Only log at error level per requirements
  });

  breaker.on('fallback', (_result: any) => {
    // Only log at error level per requirements
  });

  return {
    /**
     * Execute API call with circuit breaker protection
     */
    async execute<T>(apiCall: () => Promise<T>, fallback?: T): Promise<T> {
      try {
        return await breaker.fire(async () => apiCall());
      } catch (error) {
        logger.error('API call failed', {
          error: error instanceof Error ? error.message : 'Unknown',
          circuitBreakerState: breaker.opened ? 'open' : 'closed',
        });

        if (fallback !== undefined) {
          return fallback;
        }

        throw error;
      }
    },

    /**
     * Get circuit breaker status
     */
    getStatus() {
      const stats = (breaker as any).stats || {};
      return {
        state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
        successCount: stats.successes || 0,
        failureCount: stats.failures || 0,
        timeoutCount: stats.timeouts || 0,
        fallbackCount: stats.fallbacks || 0,
      };
    },
  };
}

/**
 * Sanitize error message to prevent information disclosure
 */
export function sanitizeErrorMessage(error: any, toolName: string): string {
  const message = error instanceof Error ? error.message : 'Unknown error';

  // Log full error for debugging
  logger.error('Tool execution error details', {
    tool: toolName,
    error: message,
    stack: error instanceof Error ? error.stack : undefined,
  });

  // Return generic message to client
  if (message.includes('token')) return 'Authentication error';
  if (message.includes('credential')) return 'Authentication failed';
  if (message.includes('401') || message.includes('Unauthorized')) return 'Authentication failed';
  if (message.includes('403') || message.includes('Forbidden')) return 'Access denied';
  if (message.includes('404') || message.includes('not found')) return 'Resource not found';
  if (message.includes('timeout')) return 'Request timeout - service took too long to respond';
  if (message.includes('Circuit')) return 'Service temporarily unavailable';
  if (message.includes('ECONNREFUSED')) return 'Service connection failed';

  return 'An error occurred processing your request';
}

/**
 * List of expensive operations for monitoring
 */
export const expensiveOperations = [
  'get_azure_usage',          // Downloads CSV files
  'get_billing_statements',   // Large data sets
  'get_grouped_billing_statements',  // Large data sets
  'get_historical_costs',     // Multiple months of data
  'detect_cost_anomalies',    // Complex calculations
  'analyze_costs_by_tags',    // Complex aggregations
];
