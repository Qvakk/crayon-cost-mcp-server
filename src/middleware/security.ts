import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import { resolveConfig, type AppConfig } from '../utils/config.js';

/** Memoized so repeated wrapper creation still resolves configuration once. */
const config: AppConfig = resolveConfig();

/**
 * Wraps API calls with circuit breaker and timeout.
 *
 * Reads its thresholds from the validated `AppConfig` (not raw env) so the
 * documented settings and the runtime behaviour cannot drift apart.
 */
export function createCircuitBreakerWrapper(
  onCircuitOpen?: () => void
) {
  const breaker = new CircuitBreaker(
    async (fn: () => Promise<any>) => fn(),
    {
      timeout: config.apiTimeoutMs,
      errorThresholdPercentage: config.circuitBreakerThreshold,
      resetTimeout: config.circuitBreakerTimeoutMs,
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

  return {
    /**
     * Execute API call with circuit breaker protection.
     *
     * Failures propagate to the caller: returning fabricated "zero cost" data on
     * a circuit-open condition would be worse than surfacing the error, so no
     * fallback is offered.
     */
    async execute<T>(apiCall: () => Promise<T>): Promise<T> {
      try {
        return await breaker.fire(async () => apiCall());
      } catch (error) {
        logger.error('API call failed', {
          error: error instanceof Error ? error.message : 'Unknown',
          circuitBreakerState: breaker.opened ? 'open' : 'closed',
        });

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
 * Maps a caught error to a generic, client-safe message.
 *
 * Pure mapping only: the caller is responsible for logging the failure (with the
 * tool and caller context) before invoking this, so the error is recorded once
 * with full context rather than twice with partial context.
 */
export function sanitizeErrorMessage(error: any, _toolName: string): string {
  const message = error instanceof Error ? error.message : 'Unknown error';

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
