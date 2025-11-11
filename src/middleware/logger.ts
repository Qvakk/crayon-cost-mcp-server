import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, '../../logs');

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
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
    // Combined log
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    // Audit log (for sensitive operations)
    new winston.transports.File({
      filename: path.join(logDir, 'audit.log'),
      level: 'info',
      maxsize: 10485760, // 10MB
      maxFiles: 10,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json()
      ),
    }),
  ],
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
        })
      ),
    })
  );
}

/**
 * Log audit trail for data access and modifications
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
  logger.info('AUDIT_EVENT', {
    ...event,
    timestamp: event.timestamp.toISOString(),
  });
}

/**
 * Log tool execution
 */
export function logToolExecution(details: {
  tool: string;
  userId?: string;
  organizationId?: number;
  duration: number;
  status: 'success' | 'failure';
  error?: string;
}): void {
  logger.info('TOOL_EXECUTION', details);
}

/**
 * Log security events
 */
export function logSecurityEvent(event: {
  type: 'auth_failure' | 'unauthorized_access' | 'rate_limit' | 'injection_attempt';
  userId?: string;
  ip: string;
  details: any;
}): void {
  logger.warn('SECURITY_EVENT', event);
}
