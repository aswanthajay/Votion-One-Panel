import fs from 'fs';
import path from 'path';

const INSTALLATION_CONFIG_FILE = 'installation.env';
const INSTALLATION_CONFIG_KEYS = [
  'DATABASE_URL',
  'TOKEN_SECRET',
  'CORS_ORIGINS',
  'PUBLIC_APP_URL',
  'INSTALLATION_COMPLETED_AT',
] as const;

type InstallationConfigKey = typeof INSTALLATION_CONFIG_KEYS[number];
type InstallationConfigValues = Partial<Record<InstallationConfigKey, string>>;

function runtimeSecretsDirectory(): string {
  return path.resolve(process.env.RUNTIME_SECRETS_DIR?.trim() || path.join(process.cwd(), '.runtime'));
}

function installationConfigPath(): string {
  return path.join(runtimeSecretsDirectory(), INSTALLATION_CONFIG_FILE);
}

function parseEnvironmentFile(content: string): InstallationConfigValues {
  const values: InstallationConfigValues = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator) as InstallationConfigKey;
    const value = line.slice(separator + 1);
    if (INSTALLATION_CONFIG_KEYS.includes(key) && value) values[key] = value;
  }
  return values;
}

function assertSafeEnvironmentValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`${name} must be a non-empty single-line value.`);
  }
  return normalized;
}

/** Loads installer-persisted values only when the process environment does not already define them. */
export function loadRuntimeConfiguration(): void {
  const configPath = installationConfigPath();
  if (!fs.existsSync(configPath)) return;

  const values = parseEnvironmentFile(fs.readFileSync(configPath, 'utf8'));
  for (const key of INSTALLATION_CONFIG_KEYS) {
    if (!process.env[key] && values[key]) process.env[key] = values[key];
  }
}

export function hasCoreInstallationConfiguration(): boolean {
  loadRuntimeConfiguration();
  const databaseUrlConfigured = Boolean(process.env.DATABASE_URL?.trim());
  const legacyDatabaseConfigured = Boolean(
    process.env.PGHOST?.trim()
    && process.env.PGPORT?.trim()
    && process.env.PGUSER?.trim()
    && process.env.PGPASSWORD?.trim()
    && process.env.PGDATABASE?.trim(),
  );
  const tokenSecretConfigured = Boolean(process.env.TOKEN_SECRET?.trim() && process.env.TOKEN_SECRET.trim().length >= 32);
  return (databaseUrlConfigured || legacyDatabaseConfigured) && tokenSecretConfigured;
}

/** Saves encrypted-transport-ready connection configuration to the ignored runtime volume after successful installation. */
export function persistInstallationConfiguration(values: {
  databaseUrl: string;
  tokenSecret: string;
  corsOrigins: string;
  publicAppUrl: string;
}): void {
  const normalized: Record<InstallationConfigKey, string> = {
    DATABASE_URL: assertSafeEnvironmentValue(values.databaseUrl, 'DATABASE_URL'),
    TOKEN_SECRET: assertSafeEnvironmentValue(values.tokenSecret, 'TOKEN_SECRET'),
    CORS_ORIGINS: assertSafeEnvironmentValue(values.corsOrigins, 'CORS_ORIGINS'),
    PUBLIC_APP_URL: assertSafeEnvironmentValue(values.publicAppUrl, 'PUBLIC_APP_URL'),
    INSTALLATION_COMPLETED_AT: new Date().toISOString(),
  };
  const directory = runtimeSecretsDirectory();
  const target = installationConfigPath();
  const temporary = path.join(directory, `.${INSTALLATION_CONFIG_FILE}.${process.pid}.tmp`);
  const body = `${INSTALLATION_CONFIG_KEYS.map((key) => `${key}=${normalized[key]}`).join('\n')}\n`;

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Unable to persist installation configuration: ${error instanceof Error ? error.message : 'unknown file-system error'}`);
  }

  for (const key of INSTALLATION_CONFIG_KEYS) process.env[key] = normalized[key];
}
