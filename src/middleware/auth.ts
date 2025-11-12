import { Request, Response, NextFunction } from 'express';
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
 * Authentication middleware - validates Bearer token
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

  const authHeader = req.headers.authorization;
  
  // For MCP initialize requests without auth, create a session without user context
  // This allows VS Code's MCP client discovery to work
  if (!authHeader && req.method === 'POST' && req.body?.method === 'initialize') {
    req.user = {
      id: 'anonymous',
      email: 'anonymous@crayon-cost-mcp.local',
      organizations: [4040561, 4019092], // All orgs for now
      roles: ['viewer'],
    };
    return next();
  }

  if (!authHeader) {
    logger.warn('Unauthorized: Missing authorization header');
    res.status(401).json({ error: 'Unauthorized: Missing authorization header' });
    return;
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;

  if (!token) {
    logger.warn('Unauthorized: Missing authentication token');
    res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
    return;
  }

  // Simple token validation against AUTH_TOKEN
  const validToken = process.env.AUTH_TOKEN;
  
  if (!validToken) {
    logger.error('Server misconfiguration: AUTH_TOKEN not set');
    res.status(500).json({ error: 'Server authentication not configured' });
    return;
  }

  if (token !== validToken) {
    logger.warn('Invalid token provided');
    res.status(401).json({ error: 'Invalid authentication token' });
    return;
  }

  // Token is valid - set default user with admin access to all orgs
  req.user = {
    id: 'api-user',
    email: 'api@crayon-cost-mcp.local',
    organizations: [4040561, 4019092], // All orgs
    roles: ['admin'],
  };

  next();
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
