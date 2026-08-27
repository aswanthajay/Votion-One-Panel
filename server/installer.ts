import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { rateLimit as expressRateLimit, ipKeyGenerator } from 'express-rate-limit';
import pg from 'pg';
import { persistInstallationConfiguration } from './services/runtimeConfig.js';

const { Pool } = pg;
const INSTALLER_TOKEN_TTL_MS = 30 * 60 * 1000;
const INSTALLER_SESSION_COOKIE = 'votion_installation';
const ADMIN_EMAIL = 'admin@votioncloud.org';
const ADMIN_ROLES = ['admin', 'administrator', 'moderator'];
const currentFile = fileURLToPath(import.meta.url);
const migrationsDirectory = path.join(path.dirname(currentFile), 'db', 'migrations');
const PORT = Number(process.env.PORT || 5000);

const installerToken = crypto.randomBytes(32).toString('base64url');
const installerTokenHash = crypto.createHash('sha256').update(installerToken).digest();
const installerExpiresAt = Date.now() + INSTALLER_TOKEN_TTL_MS;
let installationCompleted = false;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${hash}:${salt}`;
}

function tokenIsValid(value: unknown): boolean {
  if (installationCompleted || Date.now() > installerExpiresAt || typeof value !== 'string' || !value.trim()) return false;
  const candidate = crypto.createHash('sha256').update(value.trim()).digest();
  return candidate.length === installerTokenHash.length && crypto.timingSafeEqual(candidate, installerTokenHash);
}

function readInstallerToken(req: express.Request): string {
  const headerToken = req.header('x-installation-token');
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken;

  const cookieHeader = req.header('cookie') || '';
  const sessionCookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${INSTALLER_SESSION_COOKIE}=`));
  return sessionCookie ? decodeURIComponent(sessionCookie.slice(INSTALLER_SESSION_COOKIE.length + 1)) : '';
}

function installerSessionCookie(token: string, req: express.Request): string {
  const forwardedProtocol = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const secure = req.secure || forwardedProtocol === 'https';
  const attributes = [
    `${INSTALLER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${Math.floor(INSTALLER_TOKEN_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function validPublicUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validDatabaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return value.trim();
  } catch {
    return null;
  }
}

async function withDatabase<T>(databaseUrl: string, work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

async function verifyDatabaseAccess(databaseUrl: string): Promise<void> {
  await withDatabase(databaseUrl, async (pool) => {
    await pool.query('SELECT 1');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE votion_installation_probe (id integer) ON COMMIT DROP');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
}

async function applyMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    const files = (await fs.readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
    const appliedRows = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map((row) => row.version));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Database initialization failed while applying ${file}.`);
      }
    }
  } finally {
    client.release();
  }
}

async function provisionInitialAdmin(pool: pg.Pool, password: string, name: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE');
    const existingAdmin = await client.query('SELECT id FROM accounts WHERE role = ANY($1::text[]) LIMIT 1', [ADMIN_ROLES]);
    if (existingAdmin.rowCount) throw new Error('An administrator is already configured.');

    const existingReservedAccount = await client.query('SELECT id FROM accounts WHERE email = $1 FOR UPDATE', [ADMIN_EMAIL]);
    const passwordHash = hashPassword(password);
    const displayName = name.trim().slice(0, 255) || 'Votion Administrator';
    if (existingReservedAccount.rowCount) {
      await client.query(
        `UPDATE accounts
         SET password_hash = $2, name = $3, role = 'admin', operator_access = true, updated_at = NOW()
         WHERE email = $1`,
        [ADMIN_EMAIL, passwordHash, displayName],
      );
    } else {
      await client.query(
        `INSERT INTO accounts (email, password_hash, name, role, two_factor_active, operator_access, created_at, updated_at)
         VALUES ($1, $2, $3, 'admin', false, true, NOW(), NOW())`,
        [ADMIN_EMAIL, passwordHash, displayName],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: '32kb' }));

const installationRateLimit = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: 'votion-one-installer', setupAvailable: !installationCompleted && Date.now() <= installerExpiresAt });
});

app.get('/install', (req, res, next) => {
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!queryToken || !tokenIsValid(queryToken)) return next();

  res.setHeader('Set-Cookie', installerSessionCookie(queryToken, req));
  return res.redirect(303, '/install');
});

app.get('/api/v1/installation/status', installationRateLimit, (req, res) => {
  if (!tokenIsValid(readInstallerToken(req))) {
    return res.status(410).json({ success: false, error: 'This installation link is unavailable or has expired.' });
  }
  return res.json({
    success: true,
    administratorEmail: ADMIN_EMAIL,
    expiresAt: new Date(installerExpiresAt).toISOString(),
    optionalProviderSetup: true,
  });
});

app.post('/api/v1/installation/validate-database', installationRateLimit, async (req, res) => {
  if (!tokenIsValid(readInstallerToken(req))) {
    return res.status(410).json({ success: false, error: 'This installation link is unavailable or has expired.' });
  }
  const databaseUrl = validDatabaseUrl(req.body?.databaseUrl);
  if (!databaseUrl) {
    return res.status(400).json({ success: false, error: 'Enter a valid PostgreSQL connection URL.' });
  }
  try {
    await verifyDatabaseAccess(databaseUrl);
    return res.json({ success: true, message: 'Database connection and write permissions verified.' });
  } catch {
    return res.status(400).json({ success: false, error: 'The database could not be reached or does not allow required schema writes.' });
  }
});

app.post('/api/v1/installation/complete', installationRateLimit, async (req, res) => {
  if (!tokenIsValid(readInstallerToken(req))) {
    return res.status(410).json({ success: false, error: 'This installation link is unavailable or has expired.' });
  }

  const databaseUrl = validDatabaseUrl(req.body?.databaseUrl);
  const publicAppUrl = validPublicUrl(req.body?.publicAppUrl);
  const corsOrigins = typeof req.body?.corsOrigins === 'string' && req.body.corsOrigins.trim() ? req.body.corsOrigins.trim() : publicAppUrl;
  const adminPassword = typeof req.body?.adminPassword === 'string' ? req.body.adminPassword : '';
  const adminName = typeof req.body?.adminName === 'string' ? req.body.adminName : '';
  const suppliedTokenSecret = typeof req.body?.tokenSecret === 'string' ? req.body.tokenSecret.trim() : '';
  const tokenSecret = suppliedTokenSecret || crypto.randomBytes(48).toString('base64url');

  if (!databaseUrl || !publicAppUrl || !corsOrigins || adminPassword.length < 12 || tokenSecret.length < 32) {
    return res.status(400).json({ success: false, error: 'Provide a valid database URL, public application URL, administrator password of at least 12 characters, and a valid session secret.' });
  }

  try {
    await verifyDatabaseAccess(databaseUrl);
    await withDatabase(databaseUrl, async (pool) => {
      await applyMigrations(pool);
      await provisionInitialAdmin(pool, adminPassword, adminName);
    });
    persistInstallationConfiguration({ databaseUrl, tokenSecret, corsOrigins, publicAppUrl });
    installationCompleted = true;
    return res.status(201).json({
      success: true,
      message: 'Installation is complete. Restart the service to launch Votion One™.',
      restartRequired: true,
      optionalNextStep: 'Configure Proxmox connections from the administrator panel after sign-in.',
    });
  } catch (error) {
    const message = error instanceof Error && error.message === 'An administrator is already configured.'
      ? 'An administrator is already configured. Normal setup cannot be run again.'
      : 'Installation could not be completed. Verify the database details and try again.';
    return res.status(400).json({ success: false, error: message });
  }
});

const distDirectory = path.resolve(process.cwd(), 'dist');
app.use(express.static(distDirectory, { index: false, fallthrough: true }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(distDirectory, 'index.html')));

const installerBaseUrl = (process.env.INSTALLER_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const installerLink = `${installerBaseUrl}/install?token=${encodeURIComponent(installerToken)}`;
app.listen(PORT, () => {
  console.log(`[INSTALL] Open this one-time installation link before ${new Date(installerExpiresAt).toISOString()}: ${installerLink}`);
  console.log('[INSTALL] The link can configure database access, session protection, trusted application origin, and the first administrator.');
});
