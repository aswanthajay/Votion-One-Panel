import 'dotenv/config';
import crypto from 'crypto';
import pg, { type Pool } from 'pg';

const { Client } = pg;
const testDatabaseName = `votion_fresh_verify_${crypto.randomBytes(6).toString('hex')}`;
const originalDatabaseUrl = process.env.DATABASE_URL?.trim();

function createConnectionUrl(database: string): string {
  if (originalDatabaseUrl) {
    const url = new URL(originalDatabaseUrl);
    url.pathname = `/${database}`;
    return url.toString();
  }

  const host = (process.env.PGHOST || 'localhost').trim();
  const port = (process.env.PGPORT || '5433').trim();
  const user = encodeURIComponent((process.env.PGUSER || 'votion').trim());
  const password = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';
  return `postgresql://${user}${password}@${host}:${port}/${database}`;
}

async function verifyFreshDatabase(): Promise<void> {
  const maintenanceUrl = createConnectionUrl('postgres');
  const testDatabaseUrl = createConnectionUrl(testDatabaseName);
  const maintenanceClient = new Client({ connectionString: maintenanceUrl });
  let maintenanceConnected = false;
  let testPool: Pool | null = null;

  try {
    await maintenanceClient.connect();
    maintenanceConnected = true;
    await maintenanceClient.query(`CREATE DATABASE ${testDatabaseName}`);

    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.INITIAL_ADMIN_PASSWORD = crypto.randomBytes(32).toString('base64url');

    const { runMigrations } = await import('./migrate.js');
    const { bootstrapInitialAdmin } = await import('./bootstrapAdmin.js');
    const { initializeDatabaseSchema, pgPool, REQUIRED_DATABASE_TABLES } = await import('./database.js');
    testPool = pgPool;
    const { checkDbHealth } = await import('../services/databaseHealth.js');

    const appliedMigrations = await runMigrations();
    await initializeDatabaseSchema();
    const initialAdmin = await bootstrapInitialAdmin();
    const repeatedBootstrap = await bootstrapInitialAdmin();
    const health = await checkDbHealth();
    const tableResult = await pgPool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_DATABASE_TABLES],
    );
    const bootstrapAccount = await pgPool.query<{ email: string; role: string }>(
      'SELECT email, role FROM accounts WHERE role = ANY($1::text[])',
      [['admin', 'administrator', 'moderator']],
    );

    if (appliedMigrations.length === 0) throw new Error('Fresh database did not apply any migrations.');
    if (initialAdmin.status !== 'created') throw new Error('Fresh database did not create the initial administrator.');
    if (repeatedBootstrap.status !== 'already-configured') throw new Error('Initial administrator bootstrap was not idempotent.');
    if (health.status !== 'ok') throw new Error(`Fresh database health check failed: ${health.error}`);
    if (tableResult.rowCount !== REQUIRED_DATABASE_TABLES.length) {
      throw new Error(`Fresh database is missing required tables: expected ${REQUIRED_DATABASE_TABLES.length}, found ${tableResult.rowCount ?? 0}.`);
    }
    if (bootstrapAccount.rowCount !== 1 || bootstrapAccount.rows[0]?.email !== 'admin@votioncloud.org' || bootstrapAccount.rows[0]?.role !== 'admin') {
      throw new Error('Initial administrator eligibility restriction failed.');
    }

    console.log(JSON.stringify({
      status: 'ok',
      database: 'fresh',
      appliedMigrations,
      requiredTableCount: REQUIRED_DATABASE_TABLES.length,
      initialAdmin: bootstrapAccount.rows[0]?.email,
      health,
    }));

  } finally {
    await testPool?.end().catch(() => undefined);
    if (maintenanceConnected) {
      await maintenanceClient.query(`DROP DATABASE IF EXISTS ${testDatabaseName}`).catch(() => undefined);
      await maintenanceClient.end();
    }
  }
}

verifyFreshDatabase()
  .catch(error => {
    console.error('[FRESH DATABASE VERIFY] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit();
  });
