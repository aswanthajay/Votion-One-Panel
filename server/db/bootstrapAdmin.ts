import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pgPool } from './database.js';

export const INITIAL_ADMIN_EMAIL = 'admin@votioncloud.org';
const ADMIN_ROLES = ['admin', 'administrator', 'moderator'];
const INITIAL_ADMIN_SETUP_TTL_MS = 15 * 60 * 1000;
const INITIAL_ADMIN_SETUP_MAX_ATTEMPTS = 5;

export type InitialAdminBootstrapResult =
  | { status: 'created'; email: string }
  | { status: 'promoted'; email: string }
  | { status: 'already-configured' }
  | { status: 'pending-configuration'; email: string };

export type InitialAdminSetupResult =
  | { success: true; account: { id: number; email: string; name: string; role: 'admin' } }
  | { success: false; error: 'setup-unavailable' | 'setup-expired-or-invalid' | 'administrator-already-configured' };

type InitialAdminSetupSession = {
  tokenHash: Buffer;
  expiresAt: number;
  failedAttempts: number;
};

let initialAdminSetupSession: InitialAdminSetupSession | null = null;

function readInitialAdminPassword(): string | null {
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!password) return null;
  if (password.length < 12) {
    throw new Error('INITIAL_ADMIN_PASSWORD must contain at least 12 characters.');
  }
  return password;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${hash}:${salt}`;
}

function hashSetupToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest();
}

function clearExpiredInitialAdminSetupSession(): void {
  if (initialAdminSetupSession && initialAdminSetupSession.expiresAt <= Date.now()) {
    initialAdminSetupSession = null;
  }
}

function tokenMatches(expectedHash: Buffer, token: string): boolean {
  const candidateHash = hashSetupToken(token);
  return expectedHash.length === candidateHash.length && crypto.timingSafeEqual(expectedHash, candidateHash);
}

async function rollbackQuietly(client: PoolClient, transactionStarted: boolean): Promise<void> {
  if (transactionStarted) {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

async function administratorAlreadyExists(client: PoolClient): Promise<boolean> {
  const existingAdmin = await client.query<{ email: string }>(
    'SELECT email FROM accounts WHERE role = ANY($1::text[]) LIMIT 1',
    [ADMIN_ROLES],
  );
  return Boolean(existingAdmin.rowCount);
}

/**
 * Creates the sole bootstrap administrator on an otherwise administrator-free
 * database. The address is intentionally fixed and the password is supplied
 * only through deployment configuration when that explicit path is chosen.
 */
export async function bootstrapInitialAdmin(): Promise<InitialAdminBootstrapResult> {
  const client = await pgPool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE');

    if (await administratorAlreadyExists(client)) {
      await client.query('COMMIT');
      transactionStarted = false;
      return { status: 'already-configured' };
    }

    const password = readInitialAdminPassword();
    if (!password) {
      await client.query('COMMIT');
      transactionStarted = false;
      return { status: 'pending-configuration', email: INITIAL_ADMIN_EMAIL };
    }

    const existingAccount = await client.query<{ email: string }>(
      'SELECT email FROM accounts WHERE email = $1 FOR UPDATE',
      [INITIAL_ADMIN_EMAIL],
    );
    if (existingAccount.rowCount) {
      await client.query(
        `UPDATE accounts
         SET password_hash = $2, name = $3, role = 'admin', operator_access = true, updated_at = NOW()
         WHERE email = $1`,
        [INITIAL_ADMIN_EMAIL, hashPassword(password), 'Votion Administrator'],
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return { status: 'promoted', email: INITIAL_ADMIN_EMAIL };
    }

    await client.query(
      `INSERT INTO accounts (email, password_hash, name, role, two_factor_active, operator_access, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', false, true, NOW(), NOW())`,
      [INITIAL_ADMIN_EMAIL, hashPassword(password), 'Votion Administrator'],
    );

    await client.query('COMMIT');
    transactionStarted = false;
    return { status: 'created', email: INITIAL_ADMIN_EMAIL };
  } catch (error) {
    await rollbackQuietly(client, transactionStarted);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Generates a process-local, single-use setup token only while no administrator
 * exists. The plaintext is returned once to the server bootstrap for console use;
 * only its hash is retained in memory.
 */
export function beginInitialAdminSetup(): { token: string; expiresAt: string } {
  clearExpiredInitialAdminSetupSession();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + INITIAL_ADMIN_SETUP_TTL_MS;
  initialAdminSetupSession = {
    tokenHash: hashSetupToken(token),
    expiresAt,
    failedAttempts: 0,
  };
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export async function getInitialAdminSetupStatus(): Promise<{ available: boolean; expiresAt?: string }> {
  clearExpiredInitialAdminSetupSession();
  if (!initialAdminSetupSession) return { available: false };

  const result = await pgPool.query<{ email: string }>(
    'SELECT email FROM accounts WHERE role = ANY($1::text[]) LIMIT 1',
    [ADMIN_ROLES],
  );
  if (result.rowCount) {
    initialAdminSetupSession = null;
    return { available: false };
  }

  return { available: true, expiresAt: new Date(initialAdminSetupSession.expiresAt).toISOString() };
}

/**
 * Atomically provisions or recovers the reserved administrator after a setup-link
 * token has been presented. The setup token is consumed after successful creation.
 */
export async function completeInitialAdminSetup(token: string, password: string): Promise<InitialAdminSetupResult> {
  clearExpiredInitialAdminSetupSession();
  const setupSession = initialAdminSetupSession;
  if (!setupSession || setupSession.failedAttempts >= INITIAL_ADMIN_SETUP_MAX_ATTEMPTS) {
    return { success: false, error: 'setup-unavailable' };
  }
  if (!tokenMatches(setupSession.tokenHash, token)) {
    setupSession.failedAttempts += 1;
    return { success: false, error: 'setup-expired-or-invalid' };
  }
  if (password.length < 12) {
    return { success: false, error: 'setup-expired-or-invalid' };
  }

  const client = await pgPool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE');

    if (await administratorAlreadyExists(client)) {
      await client.query('COMMIT');
      transactionStarted = false;
      initialAdminSetupSession = null;
      return { success: false, error: 'administrator-already-configured' };
    }

    const existingAccount = await client.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1 FOR UPDATE',
      [INITIAL_ADMIN_EMAIL],
    );
    const passwordHash = hashPassword(password);
    let account: { id: number; email: string; name: string; role: 'admin' };

    if (existingAccount.rowCount) {
      const updated = await client.query<{ id: number; email: string; name: string; role: 'admin' }>(
        `UPDATE accounts
         SET password_hash = $2, name = $3, role = 'admin', operator_access = true, updated_at = NOW()
         WHERE email = $1
         RETURNING id, email, name, role`,
        [INITIAL_ADMIN_EMAIL, passwordHash, 'Votion Administrator'],
      );
      account = updated.rows[0]!;
    } else {
      const created = await client.query<{ id: number; email: string; name: string; role: 'admin' }>(
        `INSERT INTO accounts (email, password_hash, name, role, two_factor_active, operator_access, created_at, updated_at)
         VALUES ($1, $2, $3, 'admin', false, true, NOW(), NOW())
         RETURNING id, email, name, role`,
        [INITIAL_ADMIN_EMAIL, passwordHash, 'Votion Administrator'],
      );
      account = created.rows[0]!;
    }

    await client.query('COMMIT');
    transactionStarted = false;
    initialAdminSetupSession = null;
    return { success: true, account };
  } catch (error) {
    await rollbackQuietly(client, transactionStarted);
    throw error;
  } finally {
    client.release();
  }
}
