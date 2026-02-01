/**
 * Environment configuration with validation and defaults
 */
export interface AppConfig {
  // Server
  port: number;
  host: string;
  nodeEnv: string;
  transportMode: 'http' | 'stdio';
  
  // Authentication
  authEnabled: boolean;
  authToken: string | null;
  allowedOrganizations: number[];
  
  // Crayon API
  crayonClientId: string;
  crayonClientSecret: string;
  crayonUsername: string;
  crayonPassword: string;
  crayonApiBaseUrl: string;
  
  // Rate Limiting
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  
  // Circuit Breaker
  apiTimeoutMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerTimeoutMs: number;
  
  // Session
  sessionTimeoutMs: number;
  sessionCleanupIntervalMs: number;
  
  // Cache
  cacheEnabled: boolean;
  cacheTtlMs: number;
  cacheMaxSize: number;
  
  // Request
  requestTimeoutMs: number;
  
  // Logging
  logLevel: string;
}

/**
 * Configuration validation errors
 */
class ConfigValidationError extends Error {
  constructor(
    public readonly errors: string[]
  ) {
    super(`Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parse and validate environment configuration
 */
export function loadConfig(): AppConfig {
  const errors: string[] = [];
  
  // Helper functions
  const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      errors.push(`Missing required environment variable: ${name}`);
      return '';
    }
    return value;
  };
  
  const optionalEnv = (name: string, defaultValue: string): string => {
    return process.env[name] || defaultValue;
  };
  
  const parseIntEnv = (name: string, defaultValue: number): number => {
    const value = process.env[name];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      errors.push(`Invalid integer for ${name}: ${value}`);
      return defaultValue;
    }
    return parsed;
  };
  
  const parseBoolEnv = (name: string, defaultValue: boolean): boolean => {
    const value = process.env[name];
    if (!value) return defaultValue;
    return value.toLowerCase() !== 'false';
  };
  
  const parseArrayEnv = (name: string): number[] => {
    const value = process.env[name];
    if (!value) return [];
    return value.split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  };

  // Auth configuration
  const authEnabled = parseBoolEnv('AUTH_ENABLED', true);
  const authToken = process.env.AUTH_TOKEN || null;
  
  if (authEnabled && !authToken) {
    errors.push('AUTH_TOKEN is required when AUTH_ENABLED is true');
  }
  
  // Build configuration
  const config: AppConfig = {
    // Server
    port: parseIntEnv('PORT', 3003),
    host: optionalEnv('HOST', '0.0.0.0'),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    transportMode: (optionalEnv('TRANSPORT_MODE', 'http') as 'http' | 'stdio'),
    
    // Authentication
    authEnabled,
    authToken,
    allowedOrganizations: parseArrayEnv('ALLOWED_ORGANIZATIONS'),
    
    // Crayon API
    crayonClientId: requireEnv('CRAYON_CLIENT_ID'),
    crayonClientSecret: requireEnv('CRAYON_CLIENT_SECRET'),
    crayonUsername: requireEnv('CRAYON_USERNAME'),
    crayonPassword: requireEnv('CRAYON_PASSWORD'),
    crayonApiBaseUrl: optionalEnv('CRAYON_API_BASE_URL', 'https://api.crayon.com/api/v1'),
    
    // Rate Limiting
    rateLimitWindowMs: parseIntEnv('RATE_LIMIT_WINDOW_MS', 60000),
    rateLimitMaxRequests: parseIntEnv('RATE_LIMIT_MAX_REQUESTS', 100),
    
    // Circuit Breaker
    apiTimeoutMs: parseIntEnv('API_TIMEOUT_MS', 30000),
    circuitBreakerThreshold: parseIntEnv('CIRCUIT_BREAKER_THRESHOLD', 50),
    circuitBreakerTimeoutMs: parseIntEnv('CIRCUIT_BREAKER_TIMEOUT_MS', 30000),
    
    // Session
    sessionTimeoutMs: parseIntEnv('SESSION_TIMEOUT_MS', 1800000),
    sessionCleanupIntervalMs: parseIntEnv('SESSION_CLEANUP_INTERVAL_MS', 60000),
    
    // Cache
    cacheEnabled: parseBoolEnv('CACHE_ENABLED', true),
    cacheTtlMs: parseIntEnv('CACHE_TTL_MS', 300000), // 5 minutes
    cacheMaxSize: parseIntEnv('CACHE_MAX_SIZE', 100),
    
    // Request
    requestTimeoutMs: parseIntEnv('REQUEST_TIMEOUT_MS', 60000),
    
    // Logging
    logLevel: optionalEnv('LOG_LEVEL', 'error'),
  };
  
  // Validate transport mode
  if (!['http', 'stdio'].includes(config.transportMode)) {
    errors.push(`Invalid TRANSPORT_MODE: ${config.transportMode}. Must be 'http' or 'stdio'`);
  }
  
  // Validate port range
  if (config.port < 1 || config.port > 65535) {
    errors.push(`Invalid PORT: ${config.port}. Must be between 1 and 65535`);
  }
  
  // Validate percentage
  if (config.circuitBreakerThreshold < 0 || config.circuitBreakerThreshold > 100) {
    errors.push(`Invalid CIRCUIT_BREAKER_THRESHOLD: ${config.circuitBreakerThreshold}. Must be 0-100`);
  }
  
  // Throw if validation errors
  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }
  
  return config;
}

/**
 * Global application metrics
 */
export interface AppMetrics {
  startTime: number;
  requestCount: number;
  errorCount: number;
  toolCalls: Record<string, number>;
  circuitBreakerTrips: number;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Create initial metrics object
 */
export function createMetrics(): AppMetrics {
  return {
    startTime: Date.now(),
    requestCount: 0,
    errorCount: 0,
    toolCalls: {},
    circuitBreakerTrips: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
}

/**
 * Simple in-memory cache with TTL
 */
export class SimpleCache<T> {
  private cache = new Map<string, { value: T; expiry: number }>();
  
  constructor(
    private ttlMs: number,
    private maxSize: number
  ) {}
  
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    
    return entry.value;
  }
  
  set(key: string, value: T): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    
    this.cache.set(key, {
      value,
      expiry: Date.now() + this.ttlMs,
    });
  }
  
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
  
  clear(): void {
    this.cache.clear();
  }
  
  size(): number {
    return this.cache.size;
  }
  
  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}
