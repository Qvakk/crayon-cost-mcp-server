import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { logger } from './logger.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        organizations: number[];
        roles: string[];
      };
    }
  }
}

/**
 * Authentication middleware - validates JWT token
 */
export function authenticateRequest(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if disabled (development only)
  if (process.env.AUTH_ENABLED === 'false') {
    req.user = {
      id: 'dev-user',
      email: 'dev@example.com',
      organizations: [4040561, 4019092], // All orgs for dev
      roles: ['admin'],
    };
    return next();
  }

  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    logger.warn('Unauthorized: Missing authentication token');
    res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    
    // Validate token structure
    if (!decoded.id || !decoded.email || !decoded.organizations) {
      logger.warn('Invalid token structure', { decoded });
      res.status(401).json({ error: 'Invalid token structure' });
      return;
    }

    req.user = {
      id: decoded.id,
      email: decoded.email,
      organizations: decoded.organizations,
      roles: decoded.roles || ['viewer'],
    };

    next();
  } catch (error) {
    logger.warn('Token verification failed', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Authorization middleware - checks if user has access to organization
 */
export function authorizeOrganization(requiredRole: string = 'viewer') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    // Extract organizationId from request body or query
    const organizationId = req.body?.organizationId || req.query?.organizationId;

    if (!organizationId) {
      res.status(400).json({ error: 'Missing organizationId' });
      return;
    }

    // Check if user has access to this organization
    if (!req.user.organizations.includes(parseInt(organizationId))) {
      logger.warn('Unauthorized access attempt', {
        userId: req.user.id,
        attemptedOrgId: organizationId,
        allowedOrgs: req.user.organizations,
      });
      res.status(403).json({ error: `Forbidden: No access to organization ${organizationId}` });
      return;
    }

    // Check role requirements
    const hasRole = req.user.roles.includes(requiredRole) || req.user.roles.includes('admin');
    if (!hasRole) {
      logger.warn('Insufficient role', {
        userId: req.user.id,
        requiredRole,
        userRoles: req.user.roles,
      });
      res.status(403).json({ error: `Forbidden: Requires ${requiredRole} role` });
      return;
    }

    next();
  };
}

/**
 * Generate JWT token for testing/development
 */
export function generateTestToken(userId: string, email: string, organizations: number[], roles: string[] = ['viewer']): string {
  const payload = {
    id: userId,
    email,
    organizations,
    roles,
  };

  const secret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  const signOptions: SignOptions = {
    expiresIn: '24h',
    issuer: 'crayon-cost-mcp',
  };
  return jwt.sign(payload, secret, signOptions);
}
