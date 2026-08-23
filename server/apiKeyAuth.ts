import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { dbService } from './db/database.js';
import { requireAuth } from './middleware.js';
import { KeyedRequest } from './types/apiKey.js';


/**
 * Accepts either an HMAC session token (Authorization: Bearer) or an API key
 * (X-API-Key). Session users are resolved by requireAuth; API key users are
 * hashed (sha256) and matched against stellar_api_keys, attaching req.apiKeyUser.
 */
export async function authOrApiKey(req: KeyedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    // Reuse the standard session token resolution
    return requireAuth(req as any, res, next);
  }

  const rawKey = String(req.headers['x-api-key'] || '').trim();
  if (rawKey) {
    try {
      const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const row = await dbService.getApiKeyByHash(hash);
      if (row) {
        (req as any).authUser = { id: row.id, email: row.user_email, role: 'client', name: row.name };
        req.apiKeyUser = { email: row.user_email, name: row.name, scope: row.scope as 'read' | 'power' | 'full', keyId: row.id };
        dbService.touchApiKey(row.id).catch(() => {});
        return next();
      }
    } catch { /* fall through to 401 */ }
  }

  res.status(401).json({ success: false, error: 'Authentication required. Provide a session token (Authorization: Bearer) or an API key (X-API-Key).' });
}

/** Require a minimum API key scope: read < power < full. Session users pass through. */
export function requireScope(minScope: 'read' | 'power' | 'full') {
  const order = { read: 0, power: 1, full: 2 };
  return (req: KeyedRequest, res: Response, next: NextFunction) => {
    const ak = req.apiKeyUser;
    if (!ak) return next();
    if (order[ak.scope] < order[minScope]) {
      return res.status(403).json({ success: false, error: `This action requires '${minScope}' API key scope. Your key is '${ak.scope}'.` });
    }
    next();
  };
}
