import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pgPool } from './database.js';

export const INITIAL_ADMIN_EMAIL = 'admin@votioncloud.org';
const ADMIN_ROLES = ['admin', 'administrator', 'moderator'];

export type InitialAdminBootstrapResult =
  | { status: 'created'; email: string }
  | { status: 'promoted'; email: string }
  | { status: 'already-configured' }
  | { status: 'pending-configuration'; email: string };

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

async function rollbackQuietly(client: PoolClient, transactionStarted: boolean): Promise<void> {
  if (transactionStarted) {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

/**
 * Creates the sole bootstrap administrator on an otherwise administrator-free
 * database. The address is intentionally fixed and the password is supplied
 * only through deployment configuration.
 */
export async function bootstrapInitialAdmin(): Promise<InitialAdminBootstrapResult> {
  const client = await pgPool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE');

    const existingAdmin = await client.query<{ email: string }>(
      'SELECT email FROM accounts WHERE role = ANY($1::text[]) LIMIT 1',
      [ADMIN_ROLES],
    );
    if (existingAdmin.rowCount) {
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
