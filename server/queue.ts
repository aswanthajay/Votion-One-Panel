import { PgBoss } from 'pg-boss';

let isQueueStarted = false;

function getQueueConnectionString(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return databaseUrl;
  }
  const user = (process.env.PGUSER || process.env.POSTGRES_USER || 'votion').trim();
  const host = (process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost').trim();
  const database = (process.env.PGDATABASE || process.env.POSTGRES_DB || 'votion_proxmox_db').trim();
  const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '';
  const port = parseInt((process.env.PGPORT || process.env.POSTGRES_PORT || '5433').trim(), 10);

  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(user)}@`;
  return `postgresql://${auth}${host}:${port}/${database}`;
}

export const queue = new PgBoss(getQueueConnectionString());

export const isQueueAvailable = () => isQueueStarted;

export const startQueue = async () => {
  try {
    queue.on('error', (error: Error) => {
      // Non-fatal background queue warning
      console.warn('[Queue Warning]', error?.message || error);
    });
    await queue.start();
    isQueueStarted = true;
    console.log('[Queue] pg-boss initialized and ready for background jobs.');
  } catch (err: any) {
    isQueueStarted = false;
    console.warn('[Queue] Background queue worker offline (falling back to built-in interval worker):', err?.message || err);
  }
};
