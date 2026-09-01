import https from 'https';
import type { IncomingMessage } from 'http';
import tls, { type TLSSocket } from 'tls';

export interface ProxmoxRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  sslFingerprint?: string | null;
  timeoutMs?: number;
}

export class ProxmoxHttpError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'ProxmoxHttpError';
    this.code = options.code;
    this.status = options.status;
  }
}

export function normalizeProxmoxFingerprint(value?: string | null): string {
  return String(value || '')
    .replace(/^sha256\s*:/i, '')
    .replace(/[^a-f0-9]/gi, '')
    .toUpperCase();
}

function formatProxmoxFingerprint(value?: string | null): string {
  const normalized = normalizeProxmoxFingerprint(value);
  if (normalized.length !== 64) {
    throw new ProxmoxHttpError('The server did not present a SHA-256 certificate fingerprint.');
  }
  return `SHA256:${normalized.match(/.{1,2}/g)?.join(':')}`;
}

function normalizeProxmoxHost(value: string): string {
  const host = String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!host || host.length > 253 || /[\s/@?#]/.test(host)) {
    throw new ProxmoxHttpError('Enter a valid Proxmox host name or IP address.');
  }
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Read the SHA-256 fingerprint of the certificate currently presented by a
 * Proxmox HTTPS endpoint. The certificate is intentionally not trusted during
 * this bounded discovery handshake; callers must display the returned value
 * for administrator review before saving it with a connection.
 */
export async function fetchProxmoxTlsFingerprint(hostInput: string, portInput: number): Promise<string> {
  const host = normalizeProxmoxHost(hostInput);
  const port = Number(portInput);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxmoxHttpError('Enter a valid Proxmox HTTPS port.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, fingerprint?: string) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(fingerprint!);
    };

    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      servername: /^[\d.]+$/.test(host) || host.includes(':') ? undefined : host,
    });

    socket.setTimeout(10_000);
    socket.once('secureConnect', () => {
      try {
        finish(undefined, formatProxmoxFingerprint(socket.getPeerCertificate()?.fingerprint256));
      } catch (error) {
        finish(error instanceof Error ? error : new ProxmoxHttpError('Unable to read the server certificate.'));
      }
    });
    socket.once('timeout', () => finish(new ProxmoxHttpError('Certificate lookup timed out.', { code: 'ETIMEDOUT' })));
    socket.once('error', (error) => {
      const cause = error as NodeJS.ErrnoException;
      finish(new ProxmoxHttpError('Unable to reach the Proxmox HTTPS endpoint.', { code: cause.code }));
    });
  });
}

function collectResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/**
 * Make an HTTPS request to Proxmox with strict TLS verification by default.
 * A user-supplied SHA-256 certificate fingerprint permits self-signed PVE
 * certificates, but only when the presented certificate matches exactly.
 */
export async function proxmoxFetch(url: string, options: ProxmoxRequestOptions = {}): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new ProxmoxHttpError('Proxmox endpoint must use HTTPS');

  const expectedFingerprint = normalizeProxmoxFingerprint(options.sslFingerprint);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Length']) {
    headers['Content-Length'] = String(Buffer.byteLength(options.body));
  }

  return new Promise((resolve, reject) => {
    const request = https.request(parsed, {
      method: options.method || 'GET',
      headers,
      agent: new https.Agent({ rejectUnauthorized: !expectedFingerprint }),
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 502,
          statusText: response.statusMessage || undefined,
          headers: collectResponseHeaders(response),
        }));
      });
    });

    request.on('socket', socket => {
      if (!expectedFingerprint) return;
      const tlsSocket = socket as TLSSocket;
      tlsSocket.once('secureConnect', () => {
        const actualFingerprint = normalizeProxmoxFingerprint(tlsSocket.getPeerCertificate()?.fingerprint256);
        if (!actualFingerprint || actualFingerprint !== expectedFingerprint) {
          request.destroy(new ProxmoxHttpError(
            'Proxmox TLS certificate fingerprint mismatch',
            { code: 'PROXMOX_TLS_FINGERPRINT_MISMATCH' },
          ));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new ProxmoxHttpError('Proxmox request timed out', { code: 'ETIMEDOUT' }));
    });
    request.on('error', error => {
      const cause = error as NodeJS.ErrnoException;
      reject(new ProxmoxHttpError(error.message, { code: cause.code }));
    });

    if (options.body) request.write(options.body);
    request.end();
  });
}
/**
 * Create WebSocket TLS options that preserve strict verification by default.
 * When a fingerprint is supplied, the certificate chain may be self-signed,
 * but the exact presented SHA-256 certificate must still match.
 */
export function createProxmoxWebSocketTlsOptions(sslFingerprint?: string | null): {
  rejectUnauthorized: boolean;
  checkServerIdentity?: (servername: string, cert: tls.PeerCertificate) => Error | undefined;
} {
  const expectedFingerprint = normalizeProxmoxFingerprint(sslFingerprint);
  if (!expectedFingerprint) return { rejectUnauthorized: true };

  return {
    rejectUnauthorized: false,
    checkServerIdentity: (_servername: string, cert: tls.PeerCertificate) => {
      const actualFingerprint = normalizeProxmoxFingerprint(cert?.fingerprint256);
      if (!actualFingerprint || actualFingerprint !== expectedFingerprint) {
        const error = new Error('Proxmox TLS certificate fingerprint mismatch');
        (error as any).code = 'PROXMOX_TLS_FINGERPRINT_MISMATCH';
        return error;
      }
      return undefined;
    },
  };
}
