import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, '../../logs');

/**
 * PII patterns to redact from logs
 */
const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Email addresses
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi, replacement: '[EMAIL_REDACTED]' },
  // Norwegian national ID (fødselsnummer) - 11 digits
  { pattern: /\b\d{6}\s?\d{5}\b/g, replacement: '[NATIONAL_ID_REDACTED]' },
  // Credit card numbers (13-19 digits, possibly with spaces/dashes)
  { pattern: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g, replacement: '[CARD_REDACTED]' },
  // Phone numbers (Norwegian and international formats)
  { pattern: /\b(?:\+47|0047)?\s*[2-9]\d{7}\b/g, replacement: '[PHONE_REDACTED]' },
  { pattern: /\b(?:\+\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g, replacement: '[PHONE_REDACTED]' },
  // IP addresses
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[IP_REDACTED]' },
  // Bearer tokens / API keys (common patterns)
  { pattern: /Bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.?[A-Za-z0-9\-_.+/=]*/gi, replacement: 'Bearer [TOKEN_REDACTED]' },
  { pattern: /\b[A-Za-z0-9]{32,}\b/g, replacement: '[KEY_REDACTED]' },
  // Passwords in common formats
  { pattern: /password["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, replacement: 'password: [REDACTED]' },
  { pattern: /secret["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, replacement: 'secret: [REDACTED]' },
  // Azure subscription IDs (GUID format)
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '[GUID_REDACTED]' },
];

/**
 * Redact PII from a string
 */
function redactPII(value: string): string {
  let result = value;
  for (const { pattern, replacement } of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Recursively redact PII from an object
 */
function redactPIIFromObject(obj: any, depth: number = 0): any {
  // Prevent infinite recursion
  if (depth > 10) return '[MAX_DEPTH_EXCEEDED]';
  
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === 'string') {
    return redactPII(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => redactPIIFromObject(item, depth + 1));
  }
  
  if (typeof obj === 'object') {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Redact entire value for sensitive field names
      const lowerKey = key.toLowerCase();
      if (['password', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'credential', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token'].includes(lowerKey)) {
        redacted[key] = '[REDACTED]';
      } else if (['email', 'mail', 'phone', 'mobile', 'ssn', 'nationalid', 'personnummer', 'fodselsnummer'].includes(lowerKey)) {
        redacted[key] = '[PII_REDACTED]';
      } else {
        redacted[key] = redactPIIFromObject(value, depth + 1);
      }
    }
    return redacted;
  }
  
  return obj;
}

/**
 * Custom format that redacts PII from log messages
 */
const piiRedactionFormat = winston.format((info) => {
  // Redact message
  if (typeof info.message === 'string') {
    info.message = redactPII(info.message);
  }
  
  // Redact metadata
  const { level, message, timestamp, service, ...meta } = info;
  if (Object.keys(meta).length > 0) {
    const redactedMeta = redactPIIFromObject(meta);
    Object.assign(info, { level, message, timestamp, service }, redactedMeta);
  }
  
  return info;
});

// Create logger instance - default to 'error' level for production safety
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'error',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    piiRedactionFormat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'crayon-cost-mcp' },
  transports: [
    // Error log
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  ],
});

// Add console transport in development (also error-only by default)
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      level: process.env.LOG_LEVEL || 'error',
      format: winston.format.combine(
        winston.format.colorize(),
        piiRedactionFormat(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const redactedMeta = redactPIIFromObject(meta);
          return `${timestamp} [${level}]: ${message} ${Object.keys(redactedMeta).length > 1 ? JSON.stringify(redactedMeta, null, 2) : ''}`;
        })
      ),
    })
  );
}

/**
 * Log audit trail for data access and modifications (only on error)
 */
export function logAudit(event: {
  action: string;
  userId: string;
  organizationId: number;
  resource: string;
  status: 'success' | 'failure';
  timestamp: Date;
  details?: any;
}): void {
  // Only log audit events on failure
  if (event.status === 'failure') {
    logger.error('AUDIT_EVENT', redactPIIFromObject({
      ...event,
      timestamp: event.timestamp.toISOString(),
    }));
  }
}

/**
 * Log tool execution (only on error/failure)
 */
export function logToolExecution(details: {
  tool: string;
  userId?: string;
  organizationId?: number;
  duration: number;
  status: 'success' | 'failure';
  error?: string;
}): void {
  // Only log on failure
  if (details.status === 'failure') {
    logger.error('TOOL_EXECUTION_FAILED', redactPIIFromObject(details));
  }
}

/**
 * Log security events (always log as these are security-relevant)
 */
export function logSecurityEvent(event: {
  type: 'auth_failure' | 'unauthorized_access' | 'rate_limit' | 'injection_attempt';
  userId?: string;
  ip: string;
  details: any;
}): void {
  logger.error('SECURITY_EVENT', redactPIIFromObject(event));
}
