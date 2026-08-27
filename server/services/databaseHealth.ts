import type { PoolClient } from 'pg';
import { pgPool } from '../db/database.js';

export type DatabaseHealthSuccess = {
  status: 'ok';
  database: 'connected';
  latencyMs: number;
  timestamp: string;
};

export type DatabaseHealthFailure = {
  status: 'error';
  database: 'disconnected';
  error: string;
};

export type DatabaseHealth = DatabaseHealthSuccess | DatabaseHealthFailure;

type DatabaseError = Error & {
  code?: string;
  message: string;
};

const getDatabaseErrorMessage = (error: unknown): string => {
  const databaseError = error as Partial<DatabaseError> | null;
  const code = databaseError?.code;
  const message = String(databaseError?.message || '').toLowerCase();

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || message.includes('timeout')) {
    return 'Connection timeout';
  }
  if (code === 'ECONNREFUSED') {
    return 'Connection refused';
  }
  if (code === '28P01' || message.includes('password authentication failed')) {
    return 'Authentication failed';
  }
  if (code === '42501' || message.includes('permission denied')) {
    return 'Write permission denied';
  }
  if (message) {
    return databaseError?.message || 'Database check failed';
  }
  return 'Database check failed';
};

/**
 * Verifies database connectivity and write capability using a transaction that
 * is always rolled back, leaving no persistent health-check rows behind.
 */
export async function checkDbHealth(): Promise<DatabaseHealth> {
  const startedAt = process.hrtime.bigint();
  let client: PoolClient | null = null;
  let transactionStarted = false;

  try {
    client = await pgPool.connect();
    await client.query('SELECT 1');

    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(`
      CREATE TEMP TABLE _health_check (
        checked_at TIMESTAMPTZ NOT NULL
      ) ON COMMIT DROP
    `);
    await client.query('INSERT INTO _health_check (checked_at) VALUES (NOW())');
    await client.query('ROLLBACK');
    transactionStarted = false;

    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    return {
      status: 'ok',
      database: 'connected',
      latencyMs: Math.round(latencyMs * 100) / 100,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    if (transactionStarted && client) {
      await client.query('ROLLBACK').catch(() => undefined);
    }

    return {
      status: 'error',
      database: 'disconnected',
      error: getDatabaseErrorMessage(error),
    };
  } finally {
    client?.release();
  }
}
