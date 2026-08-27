import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SUPPORT_PIN_PREFIX = 'hmac:v1:';
const RUNTIME_KEY_FILE_NAME = 'proxmox-credentials.env';

type SecretKeySource = 'hex' | 'base64url';

export const PROXMOX_PROVIDER_UNAVAILABLE_MESSAGE =
  'Proxmox provider access is unavailable until the deployment credential key is configured.';

export class ProxmoxProviderUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'PROXMOX_PROVIDER_UNAVAILABLE';

  constructor() {
    super(PROXMOX_PROVIDER_UNAVAILABLE_MESSAGE);
    this.name = 'ProxmoxProviderUnavailableError';
  }
}

export type ProviderCredentialKeyInitialization =
  | { status: 'environment' }
  | { status: 'runtime-file' }
  | { status: 'generated' }
  | { status: 'unavailable-existing-credentials' };

function runtimeSecretsDirectory(): string {
  return path.resolve(process.env.RUNTIME_SECRETS_DIR?.trim() || path.join(process.cwd(), '.runtime'));
}

function runtimeKeyFilePath(): string {
  return path.join(runtimeSecretsDirectory(), RUNTIME_KEY_FILE_NAME);
}

function decodeKey(configured: string): Buffer | null {
  if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  try {
    const decoded = Buffer.from(configured, 'base64url');
    return decoded.length === KEY_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

function readRuntimeKey(): string | null {
  const filePath = runtimeKeyFilePath();
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^PROXMOX_CREDENTIALS_KEY=([^\r\n]+)$/m);
  if (!match?.[1]) {
    throw new Error('The generated provider credential key file is malformed. Restore it from the protected runtime volume or configure PROXMOX_CREDENTIALS_KEY explicitly.');
  }
  return match[1].trim();
}

function configuredKeyValue(): { source: 'environment' | 'runtime-file'; value: string } | null {
  const environmentValue = process.env.PROXMOX_CREDENTIALS_KEY?.trim();
  if (environmentValue) return { source: 'environment', value: environmentValue };

  const runtimeValue = readRuntimeKey();
  if (runtimeValue) return { source: 'runtime-file', value: runtimeValue };
  return null;
}

function persistGeneratedRuntimeKey(key: string): void {
  const directory = runtimeSecretsDirectory();
  const target = runtimeKeyFilePath();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${RUNTIME_KEY_FILE_NAME}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);

  try {
    fs.writeFileSync(temporary, `PROXMOX_CREDENTIALS_KEY=${key}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Unable to persist the generated provider credential key: ${error instanceof Error ? error.message : 'unknown file-system error'}`);
  }
}

/**
 * Initializes a credential key only for an installation with no stored provider
 * secrets. Environment configuration always takes precedence; a saved runtime
 * key is reused. Existing credentials without either key remain fail-closed.
 */
export function initializeProviderCredentialKey(hasStoredProviderCredentials: boolean): ProviderCredentialKeyInitialization {
  const existing = configuredKeyValue();
  if (existing) {
    if (!decodeKey(existing.value)) {
      throw new Error('PROXMOX_CREDENTIALS_KEY must be exactly 32 bytes encoded as 64 hex or base64url characters.');
    }
    process.env.PROXMOX_CREDENTIALS_KEY = existing.value;
    return { status: existing.source };
  }

  if (hasStoredProviderCredentials) {
    return { status: 'unavailable-existing-credentials' };
  }

  const generated = crypto.randomBytes(KEY_BYTES).toString('base64url');
  persistGeneratedRuntimeKey(generated);
  process.env.PROXMOX_CREDENTIALS_KEY = generated;
  return { status: 'generated' };
}

export function isProviderCredentialKeyConfigured(): boolean {
  const configured = configuredKeyValue();
  return Boolean(configured && decodeKey(configured.value));
}

function loadKey(): Buffer {
  const configured = configuredKeyValue();
  if (!configured) {
    throw new Error('PROXMOX_CREDENTIALS_KEY must be configured before provider credentials are accessed.');
  }
  const decoded = decodeKey(configured.value);
  if (!decoded) {
    throw new Error('PROXMOX_CREDENTIALS_KEY must be exactly 32 bytes encoded as 64 hex or base64url characters.');
  }
  return decoded;
}

export function isEncryptedCredential(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptCredential(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return value ?? null;
  if (isEncryptedCredential(value)) return value;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function supportPinKey(): Buffer {
  const configured = process.env.SUPPORT_PIN_PEPPER?.trim() || process.env.TOKEN_SECRET?.trim();
  if (!configured || configured.length < 32) {
    throw new Error('SUPPORT_PIN_PEPPER or TOKEN_SECRET must be configured before Support PIN verification.');
  }
  return Buffer.from(configured, 'utf8');
}

export function hashSupportPin(pin: string): string {
  return `${SUPPORT_PIN_PREFIX}${crypto.createHmac('sha256', supportPinKey()).update(pin.trim()).digest('hex')}`;
}

export function verifySupportPin(pin: string, storedValue: string | null | undefined): boolean {
  if (!storedValue) return false;
  if (!storedValue.startsWith(SUPPORT_PIN_PREFIX)) return storedValue === pin.trim();
  const expected = hashSupportPin(pin);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(storedValue, 'utf8');
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function isHashedSupportPin(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SUPPORT_PIN_PREFIX);
}

export function decryptCredential(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return value ?? null;
  if (!isEncryptedCredential(value)) return value;

  const encoded = value.slice(PREFIX.length).split('.');
  if (encoded.length !== 3) throw new Error('Stored provider credential has an invalid encrypted format.');
  const [ivEncoded, tagEncoded, ciphertextEncoded] = encoded;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    loadKey(),
    Buffer.from(ivEncoded, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
