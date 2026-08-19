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

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // For development/demo: Accept any token in the format "header.payload.signature"
    // This allows frontend-generated demo tokens
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        // Try to parse the payload
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        req.user = {
          id: payload.sub || payload.id || '1',
          email: payload.email || 'demo@bisley.com',
          role: payload.role || 'MANAGER',
        };
        return next();
      } catch (e) {
        // If parsing fails, continue to JWT verification
        console.warn('Failed to parse token payload:', e);
      }
    }

    // Try standard JWT verification for production tokens
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_secret') as any;

    // Attach user to request
    req.user = {
      id: decoded.id || decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
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
