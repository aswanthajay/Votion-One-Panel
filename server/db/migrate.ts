import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pgPool } from './database.js';

const currentFile = fileURLToPath(import.meta.url);
const migrationsDirectory = path.join(path.dirname(currentFile), 'migrations');

export async function runMigrations(): Promise<string[]> {
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    const files = (await fs.readdir(migrationsDirectory))
      .filter(file => file.endsWith('.sql'))
      .sort();
    const appliedRows = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map(row => row.version));
    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return newlyApplied;
  } finally {
    client.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runMigrations()
    .then(applied => {
      console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'No pending migrations.');
    })
    .catch(error => {
      console.error('[MIGRATIONS] Failed:', error);
      process.exitCode = 1;
    })
    .finally(() => pgPool.end());
}
