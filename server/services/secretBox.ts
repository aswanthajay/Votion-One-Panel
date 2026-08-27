import crypto from 'crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SUPPORT_PIN_PREFIX = 'hmac:v1:';

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

export function isProviderCredentialKeyConfigured(): boolean {
  const configured = process.env.PROXMOX_CREDENTIALS_KEY?.trim();
  if (!configured) return false;
  if (/^[0-9a-f]{64}$/i.test(configured)) return true;
  try {
    return Buffer.from(configured, 'base64url').length === KEY_BYTES;
  } catch {
    return false;
  }
}

function loadKey(): Buffer {
  const configured = process.env.PROXMOX_CREDENTIALS_KEY?.trim();
  if (!configured) {
    throw new Error('PROXMOX_CREDENTIALS_KEY must be configured before provider credentials are accessed.');
  }

  const candidates: Array<{ source: SecretKeySource; value: Buffer }> = [];
  if (/^[0-9a-f]{64}$/i.test(configured)) {
    candidates.push({ source: 'hex', value: Buffer.from(configured, 'hex') });
  }
  try {
    candidates.push({ source: 'base64url', value: Buffer.from(configured, 'base64url') });
  } catch {
    // The length check below produces the public configuration error.
  }

  const valid = candidates.find(candidate => candidate.value.length === KEY_BYTES);
  if (!valid) {
    throw new Error('PROXMOX_CREDENTIALS_KEY must be exactly 32 bytes encoded as 64 hex or base64url characters.');
  }
  return valid.value;
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
