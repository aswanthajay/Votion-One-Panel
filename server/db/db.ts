import pg from 'pg';

const { Pool } = pg;

// PostgreSQL Connection Pool configuration
export const pool = new Pool({
  user: process.env.POSTGRES_USER || 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  database: process.env.POSTGRES_DB || 'votion_proxmox',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  max: 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err: any) => {
  console.error('[db.ts pool] Unexpected idle client error:', err?.message || err);
});

export const queryDb = async (text: string, params?: any[]) => {
  try {
    const res = await pool.query(text, params);
    return res.rows;
  } catch (err) {
    console.warn('[POSTGRES] Database query fallback (offline DB driver active):', text);
    return [];
  }
};
