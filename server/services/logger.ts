import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SENSITIVE_KEY = /(authorization|cookie|password|passphrase|token|secret|support.?pin|api.?key|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[Truncated]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[Redacted]' : redact(entry, depth + 1),
  ]));
}

export type LogFields = Record<string, unknown>;

export function log(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redact(fields) as LogFields,
  };
  const output = JSON.stringify(record);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

function requestIdFrom(req: Request): string {
  const incoming = req.header('x-request-id')?.trim();
  return incoming && /^[A-Za-z0-9._:-]{1,100}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = requestIdFrom(req);
  const startedAt = process.hrtime.bigint();
  res.setHeader('X-Request-ID', requestId);
  res.locals.requestId = requestId;
  res.on('finish', () => {
    log('info', 'http.request.completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 10_000) / 100,
    });
  });
  next();
}
