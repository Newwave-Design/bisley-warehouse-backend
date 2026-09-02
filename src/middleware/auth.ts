/**
 * Authentication Middleware
 * Validates JWT tokens from Medusa Admin or accepts demo tokens
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

// Exact-match demo token used by internal scripts/tests (JWT_SECRET is not
// known to callers using this). NOT a wildcard — any other token must pass
// real jwt.verify() below. Overridable per-environment via DEMO_AUTH_TOKEN.
const DEMO_TOKEN = process.env.DEMO_AUTH_TOKEN
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBiaXNsZXkuY29tIiwicm9sZSI6Ik1BTkFHRVIifQ.demo';

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      // In development, allow requests without token
      if (process.env.NODE_ENV !== 'production') {
        req.user = { id: '1', email: 'dev@bisley.com', role: 'MANAGER' };
        return next();
      }
      return res.status(401).json({ error: 'No token provided' });
    }

    // Exact-match demo token — not a shape-based bypass. Every other token,
    // including any other 3-part string, must pass signature verification.
    if (token === DEMO_TOKEN) {
      req.user = { id: '1', email: 'admin@bisley.com', role: 'MANAGER' };
      return next();
    }

    // Standard JWT verification — validates the signature against JWT_SECRET
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_secret') as any;

    // Attach user to request
    req.user = {
      id: decoded.id || decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    // In development/non-production, allow the request to proceed without valid auth
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Auth error (allowed in dev):', error);
      req.user = { id: '1', email: 'dev@bisley.com', role: 'MANAGER' };
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Role-based access control middleware
 * Restricts endpoints to specific user roles
 */
export function requireRole(allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user?.role || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
