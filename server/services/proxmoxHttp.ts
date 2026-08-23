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
  createConnection?: (options: tls.ConnectionOptions) => TLSSocket;
} {
  const expectedFingerprint = normalizeProxmoxFingerprint(sslFingerprint);
  if (!expectedFingerprint) return { rejectUnauthorized: true };

  return {
    rejectUnauthorized: false,
    createConnection: (options) => {
      const socket = tls.connect({ ...options, rejectUnauthorized: false });
      socket.once('secureConnect', () => {
        const actualFingerprint = normalizeProxmoxFingerprint(socket.getPeerCertificate()?.fingerprint256);
        if (!actualFingerprint || actualFingerprint !== expectedFingerprint) {
          socket.destroy(new ProxmoxHttpError(
            'Proxmox TLS certificate fingerprint mismatch',
            { code: 'PROXMOX_TLS_FINGERPRINT_MISMATCH' },
          ));
        }
      });
      return socket;
    },
  };
}
