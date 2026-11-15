import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { validateRequestBoundary } from '../src/request-boundary.js';

const allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const host = '127.0.0.1:3000';

function validate(options: {
  method?: string;
  headers?: IncomingHttpHeaders;
  rawHeaders?: string[];
  environment?: 'development' | 'test' | 'production';
  apiPort?: number;
} = {}) {
  const headers: IncomingHttpHeaders = { host, ...options.headers };
  const rawHeaders = options.rawHeaders ?? Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [name, Array.isArray(value) ? value.join(', ') : value],
  );
  return validateRequestBoundary({
    method: options.method ?? 'POST',
    headers,
    rawHeaders,
    allowedOrigins,
    apiPort: options.apiPort ?? 3000,
    environment: options.environment ?? 'production',
  });
}

describe('validateRequestBoundary', () => {
  it('accepts configured loopback hosts and exact local browser origins', () => {
    expect(validate({ headers: { origin: allowedOrigins[0] } })).toEqual({ allowed: true });
    expect(validate({ headers: { host: 'localhost:5173', origin: allowedOrigins[1] } })).toEqual({ allowed: true });
    expect(validate({ headers: { host: '[::1]:3000' } })).toEqual({ allowed: true });
  });

  it('accepts the API listen port while rejecting alternate loopback addresses and DNS aliases', () => {
    expect(validate({ headers: { host: 'localhost:3000' } })).toEqual({ allowed: true });
    expect(validate({ headers: { host: '127.0.0.2:3000' } })).toMatchObject({ allowed: false, code: 'HOST_NOT_ALLOWED' });
    expect(validate({ headers: { host: 'attacker.example:3000' } })).toMatchObject({ allowed: false, code: 'HOST_NOT_ALLOWED' });
  });

  it('rejects malformed, ambiguous and unexpected Host values', () => {
    for (const value of ['', 'localhost.evil:3000', 'localhost.:3000', 'localhost:3000, attacker.example', 'user@localhost:3000', 'localhost:99999', '127.1:3000', '2130706433:3000', '0x7f000001:3000']) {
      expect(validate({ headers: { host: value } })).toMatchObject({ allowed: false, code: 'HOST_NOT_ALLOWED' });
    }
    expect(validate({ rawHeaders: ['host', host, 'host', 'localhost:3000'] }))
      .toMatchObject({ allowed: false, code: 'HOST_NOT_ALLOWED' });
  });

  it('rejects untrusted, null, malformed and duplicate Origin values', () => {
    for (const origin of ['null', 'https://attacker.example', 'http://localhost:5173/path', '']) {
      expect(validate({ headers: { origin } })).toMatchObject({ allowed: false, code: 'ORIGIN_NOT_ALLOWED' });
    }
    expect(validate({
      headers: { origin: allowedOrigins[0] },
      rawHeaders: ['host', host, 'origin', allowedOrigins[0]!, 'origin', allowedOrigins[1]!],
    })).toMatchObject({ allowed: false, code: 'REQUEST_METADATA_INVALID' });
  });

  it('validates Referer and rejects cross-site Fetch Metadata even without Origin', () => {
    expect(validate({ headers: { referer: allowedOrigins[0] + '/settings' } })).toEqual({ allowed: true });
    expect(validate({ headers: { referer: 'https://attacker.example/form' } }))
      .toMatchObject({ allowed: false, code: 'ORIGIN_NOT_ALLOWED' });
    expect(validate({ headers: { 'sec-fetch-site': 'cross-site' } }))
      .toMatchObject({ allowed: false, code: 'ORIGIN_NOT_ALLOWED' });
    expect(validate({ headers: { 'sec-fetch-site': 'same-site' } }))
      .toMatchObject({ allowed: false, code: 'ORIGIN_NOT_ALLOWED' });
    expect(validate({ headers: { 'sec-fetch-site': 'unknown' } }))
      .toMatchObject({ allowed: false, code: 'REQUEST_METADATA_INVALID' });
  });

  it('keeps origin-less local automation compatible without weakening browser metadata checks', () => {
    expect(validate()).toEqual({ allowed: true });
    expect(validate({ method: 'GET', headers: { 'sec-fetch-site': 'same-site' } })).toEqual({ allowed: true });
    expect(validate({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).toEqual({ allowed: true });
    expect(validate({ method: 'POST', headers: { 'sec-fetch-site': 'none' } }))
      .toMatchObject({ allowed: false, code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('accepts the actual ephemeral socket port instead of the configured zero sentinel', () => {
    expect(validate({ headers: { host: '127.0.0.1:43127' }, apiPort: 43127 })).toEqual({ allowed: true });
  });

  it('normalizes implicit HTTP default ports without widening the hostname allowlist', () => {
    expect(validate({ headers: { host: 'localhost' }, environment: 'test' })).toEqual({ allowed: true });
    expect(validate({ headers: { host: '127.0.0.1' }, environment: 'test' }))
      .toMatchObject({ allowed: false, code: 'HOST_NOT_ALLOWED' });
    expect(validate({ headers: { host: '127.0.0.1:80' }, environment: 'production' }))
      .toMatchObject({ allowed: false, code: 'HOST_NOT_ALLOWED' });
  });

  it('allows localhost:80 only for Fastify in-memory tests', () => {
    expect(validate({ headers: { host: 'localhost:80' }, environment: 'test' })).toEqual({ allowed: true });
    expect(validate({ headers: { host: 'localhost:80' }, environment: 'production' }))
      .toMatchObject({ allowed: false, code: 'HOST_NOT_ALLOWED' });
  });
});
