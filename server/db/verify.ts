import { bootstrapInitialAdmin } from './bootstrapAdmin.js';
import { initializeDatabaseSchema, pgPool } from './database.js';
import { runMigrations } from './migrate.js';
import { checkDbHealth } from '../services/databaseHealth.js';

async function verifyDatabase(): Promise<void> {
  const appliedMigrations = await runMigrations();
  await initializeDatabaseSchema();
  const initialAdmin = await bootstrapInitialAdmin();
  const health = await checkDbHealth();

  if (health.status !== 'ok') {
    throw new Error(`Database health check failed: ${health.error}`);
  }

  console.log(JSON.stringify({
    status: 'ok',
    database: health.database,
    latencyMs: health.latencyMs,
    appliedMigrations,
    initialAdmin: initialAdmin.status,
  }));
}

verifyDatabase()
  .catch(error => {
    console.error('[DATABASE VERIFY] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end();
    process.exit();
  });
