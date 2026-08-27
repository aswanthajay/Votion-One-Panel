/**
 * Auth Key File router
 * =========
 * "Sign in with key file" — instant, modern, secure login using a downloadable
 * Stellar Engine key file (.stk). The file carries a key id + a random secret
 * bound to the owner account. Server never stores the secret in plain text
 * (SHA-256 hash only), so a stolen database cannot mint sessions, and files
 * can be revoked instantly from User Settings.
 *
 * Endpoints (mounted at /api/auth and /api/v1/auth BEFORE the broad apiRouter):
 *   POST   /auth/key-file/create          [auth] generate + return key material
 *   GET    /auth/key-file/download        [auth] stream the .stk key file
 *   GET    /auth/key-files                [auth] list own key files (usage info)
 *   POST   /auth/key-files/:kid/revoke    [auth] revoke a key file
 *   POST   /auth/login-key                [public] verify key file and sign a session
 */
import { Router } from 'express';
import crypto from 'crypto';
import { pgPool } from '../db/database.js';
import { rateLimit, requireAuth, TOKEN_SECRET, type AuthenticatedRequest } from '../middleware.js';

function signToken(payload: string): string {
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function createToken(accountId: number): string {
  return signToken(`votion_${accountId}_${Date.now()}`);
}

const KEY_FILE_VERSION = 'stk1';
const KEY_FILE_VALIDITY_HOURS = 24 * 90; // 90 days default validity window

export const authKeyRouter = Router();

// Ensure the key_files table exists (self-migrating)
async function ensureKeyFilesTable(): Promise<void> {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS key_files (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      kid VARCHAR(64) UNIQUE NOT NULL,
      secret_hash VARCHAR(64) NOT NULL,
      file_name VARCHAR(120) NOT NULL DEFAULT 'stellar-key.stk',
      revoked BOOLEAN NOT NULL DEFAULT false,
      last_used_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
ensureKeyFilesTable().catch(err => console.error('[authKey] table init failed:', err?.message || err));

/** POST /auth/key-file/create — generate a new key file bound to the session owner */
authKeyRouter.post('/key-file/create', requireAuth, async (req, res) => {
  const user = (req as AuthenticatedRequest).authUser!;
  const name = (typeof req.body?.name === 'string' && req.body.name.trim()) || '';

  const kid = crypto.randomBytes(16).toString('hex'); // 32-char hex key id
  const secret = crypto.randomBytes(32).toString('hex'); // 64-char hex secret
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  const fileLabel = name ? name.replace(/[^\w\- .]/g, '').slice(0, 60) : `stellar-key-${kid.slice(0, 8)}`;

  try {
    await pgPool.query(
      'INSERT INTO key_files (account_id, kid, secret_hash, file_name) VALUES ($1, $2, $3, $4)',
      [user.id, kid, secretHash, fileLabel],
    );
    // Secret is returned EXACTLY once, at creation time. It is never stored
    // plain on the server and cannot be retrieved again.
    res.json({
      success: true,
      message: 'Key file generated. Save the secret — it will not be shown again.',
      keyFile: {
        version: KEY_FILE_VERSION,
        accountEmail: user.email,
        kid,
        secret,
        createdAt: Date.now(),
        validityHours: KEY_FILE_VALIDITY_HOURS,
      },
    });
  } catch (err: any) {
    console.error('[authKey] create failed:', err?.message || err);
    res.status(500).json({ success: false, error: 'Failed to create key file' });
  }
});

/** GET /auth/key-files — list key files owned by the session user (metadata only) */
authKeyRouter.get('/key-files', requireAuth, async (req, res) => {
  const user = (req as AuthenticatedRequest).authUser!;
  try {
    const rows = await pgPool.query(
      'SELECT kid, file_name, revoked, last_used_at, created_at FROM key_files WHERE account_id = $1 ORDER BY created_at DESC',
      [user.id],
    );
    res.json({ success: true, keyFiles: rows.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to list key files' });
  }
});

/** POST /auth/key-files/:kid/revoke — revoke a key file */
authKeyRouter.post('/key-files/:kid/revoke', requireAuth, async (req, res) => {
  const user = (req as AuthenticatedRequest).authUser!;
  const { kid } = req.params;
  try {
    const result = await pgPool.query(
      'UPDATE key_files SET revoked = true WHERE kid = $1 AND account_id = $2 AND revoked = false RETURNING kid',
      [kid, user.id],
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Key file not found or already revoked' });
    }
    res.json({ success: true, message: 'Key file revoked. It can no longer be used to sign in.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to revoke key file' });
  }
});

/** GET /auth/key-file/download?kid=...&secret=... — download the .stk file (owners only) */
authKeyRouter.get('/key-file/download', requireAuth, async (req, res) => {
  const user = (req as AuthenticatedRequest).authUser!;
  const kid = typeof req.query.kid === 'string' ? req.query.kid.trim() : '';
  const secret = typeof req.query.secret === 'string' ? req.query.secret.trim() : '';

  if (!kid || !secret) {
    return res.status(400).json({ success: false, error: 'Missing kid or secret' });
  }
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

  try {
    const row = (
      await pgPool.query(
        'SELECT file_name FROM key_files WHERE account_id = $1 AND kid = $2 AND secret_hash = $3 AND revoked = false',
        [user.id, kid, secretHash],
      )
    ).rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Key file not found' });
    }
    const payload: Record<string, unknown> = {
      version: KEY_FILE_VERSION,
      engine: 'Stellar Engine',
      product: 'Votion One™ Platform',
      accountEmail: user.email,
      kid,
      secret,
      createdAt: Date.now(),
      validityHours: KEY_FILE_VALIDITY_HOURS,
      notice:
        'Keep this file private. Anyone holding it can sign in as this account until it is revoked from User Settings.',
    };
    const safeName = row.file_name.replace(/[^\w\- .]/g, '').slice(0, 80) || 'stellar-key.stk';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.stk"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload, null, 2));
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to prepare key file' });
  }
});

/** POST /auth/login-key — public endpoint: verify a key file and mint a session */
authKeyRouter.post('/login-key', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: 'auth-login-key' }), async (req, res) => {
  const kf = req.body?.keyFile || req.body;
  const kid = typeof kf?.kid === 'string' ? kf.kid.trim() : '';
  const secret = typeof kf?.secret === 'string' ? kf.secret.trim() : '';
  const email = typeof kf?.accountEmail === 'string' ? kf.accountEmail.trim().toLowerCase() : '';

  if (!kid || !secret) {
    return res.status(400).json({ success: false, error: 'Invalid key file: missing key material' });
  }
  if (kf.version && kf.version !== KEY_FILE_VERSION) {
    return res.status(400).json({ success: false, error: 'Unsupported key file version' });
  }
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

  try {
    const row = (
      await pgPool.query(
        `SELECT id, account_id, revoked, last_used_at, created_at
         FROM key_files
         WHERE kid = $1 AND secret_hash = $2 AND revoked = false`,
        [kid, secretHash],
      )
    ).rows[0];

    if (!row) {
      return res.status(401).json({
        success: false,
        error: 'This key file is invalid, revoked, or does not match any account.',
      });
    }

    // Time-gate: refuse keys older than the validity window
    const ageHours = (Date.now() - row.created_at.getTime()) / 36e5;
    if (ageHours > KEY_FILE_VALIDITY_HOURS) {
      return res.status(401).json({
        success: false,
        error: 'This key file has expired. Generate a new one from User Settings.',
      });
    }

    const account = (
      await pgPool.query('SELECT id, email, name, role FROM accounts WHERE id = $1', [row.account_id])
    ).rows[0];
    if (!account) {
      return res.status(401).json({ success: false, error: 'Account no longer exists' });
    }

    // Optional email binding check: file claims an email that doesn't match the account
    if (email && email !== account.email.toLowerCase()) {
      return res.status(401).json({ success: false, error: 'Key file does not match this account' });
    }

    // Record usage (best-effort, never block login)
    pgPool.query('UPDATE key_files SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});

    const token = createToken(account.id);
    res.cookie('votion_auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      success: true,
      message: 'Authenticated via key file',
      token,
      user: {
        id: account.id,
        email: account.email,
        name: account.name,
        role: account.role,
        phone: null,
        supportPin: null,
        twoFactorActive: false,
      },
    });
  } catch (err: any) {
    console.error('[authKey] login-key failed:', err?.message || err);
    res.status(500).json({ success: false, error: 'Key file authentication failed' });
  }
});
