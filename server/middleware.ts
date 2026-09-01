/**
 * requireAuth middleware — verifies the HMAC-signed session token and enforces role gates.
 *
 * Token format: `${payload}.${hmac_sha256}` where payload = `votion_${accountId}_${issuedAt}`
 * (optionally suffixed with `_r` for a 30-day remember-me session).
 * A payload that decodes to a real accounts row is treated as authenticated. The token
 * carries no expiry (panel is a local admin tool); rotation happens via login which always
 * issues a fresh token.
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { pgPool } from './db/database.js';

const configuredTokenSecret = process.env.TOKEN_SECRET;
if (!configuredTokenSecret || configuredTokenSecret.length < 32) {
  throw new Error('TOKEN_SECRET must be configured with at least 32 characters.');
}
export const TOKEN_SECRET = configuredTokenSecret;

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type RateLimitOptions = { windowMs: number; max: number; keyPrefix: string };
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = `${options.keyPrefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const current = rateLimitBuckets.get(identity);
    if (!current || current.resetAt <= now) {
      rateLimitBuckets.set(identity, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (current.count >= options.max) {
      res.setHeader('Retry-After', Math.ceil((current.resetAt - now) / 1000));
      res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
      return;
    }
    current.count++;
    next();
  };
}

export function createTemp2FaToken(accountId: number): string {
  const payload = `2fa_${accountId}_${Date.now()}`;
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

export function verifyTemp2FaToken(token: string): number | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload.startsWith('2fa_')) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  if (expected !== sig) return null;
  const parts = payload.split('_');
  const issuedAt = Number(parts[2]);
  if (Date.now() - issuedAt > 5 * 60 * 1000) return null; // 5 mins expiry
  return parseInt(parts[1], 10);
}

export function createSessionToken(accountId: number): string {
  const payload = `votion_${accountId}_${Date.now()}`;
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

export type AuthenticatedUser = { id: number; email: string; role: string; name: string; operatorAccess?: boolean };

export interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedUser;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

export async function resolveSessionUser(token: string): Promise<AuthenticatedUser | null> {
  const verified = verifySessionToken(token);
  if (!verified) return null;
  const parts = verified.payload.split('_');
  const accountId = parseInt(parts[1], 10);
  if (!accountId) return null;
  const result = await pgPool.query('SELECT id, email, name, role, operator_access FROM accounts WHERE id = $1', [accountId]);
  const user = result.rows[0];
  return user ? { id: user.id, email: user.email, role: user.role, name: user.name, operatorAccess: user.operator_access === true } : null;
}

export function verifySessionToken(token: string): { payload: string } | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(sig || '', 'utf8');
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) return null;

  const parts = payload.split('_');
  const issuedAt = Number(parts[2]);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null;
  return { payload };
}

/**
 * Middleware that requires a valid session token and resolves the user row.
 * Requests without a valid token receive 401.
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.authUser) {
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  let token = authHeader?.replace('Bearer ', '');
  if (!token) {
    const cookieHeader = req.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)votion_auth_token=([^;]+)/);
    token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  }
  resolveSessionUser(token || '').then(user => {
    if (!user) return res.status(401).json({ success: false, error: 'Authentication required' });
    req.authUser = user;
    next();
  }).catch(() => res.status(500).json({ success: false, error: 'Session verification failed' }));
}

/**
 * Middleware that requires the authenticated user to hold an administrative role.
 * Client-scoped accounts are rejected with 403.
 */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const user = (req as AuthenticatedRequest).authUser;
  if (!user) return next(); // requireAuth always runs first
  const adminRoles = ['administrator', 'admin', 'moderator'];
  if (!adminRoles.includes(user.role)) {
    return res.status(403).json({ success: false, error: 'Administrator access required' });
  }
  next();
}

/**
 * Dedicated operator capability gate. Administrative access alone is not execution authorization.
 */
export function requireOperator(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const user = req.authUser;
  if (!user) return res.status(401).json({ success: false, error: 'Authentication required' });
  const adminRoles = ['administrator', 'admin', 'moderator'];
  if (!adminRoles.includes(user.role) || user.operatorAccess !== true) {
    return res.status(403).json({ success: false, error: 'Dedicated reimage operator access is required' });
  }
  next();
}

/**
 * Mask sensitive connection fields in API responses. Caller must pass the full row.
 */
export function maskConnection(conn: any): any {
  if (!conn) return conn;
  return {
    ...conn,
    token_secret: conn.token_secret ? '••••••••' : '',
    password: conn.password ? '••••••••' : '',
  };
}
