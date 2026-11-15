import type { IncomingHttpHeaders } from 'node:http';

export type RequestBoundaryFailureCode =
  | 'HOST_NOT_ALLOWED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'REQUEST_METADATA_INVALID';

export type RequestBoundaryResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly statusCode: 400 | 403;
      readonly code: RequestBoundaryFailureCode;
      readonly message: string;
    };

export interface RequestBoundaryInput {
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawHeaders: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly apiPort: number;
  readonly environment: 'development' | 'test' | 'production';
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const FETCH_SITE_VALUES = new Set(['same-origin', 'same-site', 'cross-site', 'none']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValues(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  name: string,
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === name) values.push(rawHeaders[index + 1]!);
  }
  if (values.length > 0) return values;

  const value = headers[name];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function readUniqueHeader(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  name: string,
): { readonly value?: string; readonly invalid: boolean } {
  const values = headerValues(headers, rawHeaders, name);
  return values.length > 1
    ? { invalid: true }
    : { ...(values.length === 1 ? { value: values[0] } : {}), invalid: false };
}

function allowedHostValues(input: RequestBoundaryInput): ReadonlySet<string> {
  const values = new Set<string>();
  for (const origin of input.allowedOrigins) {
    try {
      values.add(new URL(origin).host.toLowerCase());
    } catch {
      // Configuration validation rejects malformed origins before the server starts.
    }
  }

  for (const hostname of LOOPBACK_HOSTNAMES) {
    const host = hostname.includes(':') ? '[' + hostname + ']' : hostname;
    values.add(host + ':' + input.apiPort);
  }

  // Fastify's in-memory inject transport uses localhost:80 when no Host is
  // supplied. This test-only compatibility does not affect a listening server.
  if (input.environment === 'test') values.add('localhost:80');
  return values;
}

function isAllowedHost(value: string | undefined, input: RequestBoundaryInput): boolean {
  if (!value || value.length > 255 || value !== value.trim() || /[\s,/@?#\\]/.test(value)) return false;
  try {
    const parsed = new URL('http://' + value);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    if (parsed.hostname.endsWith('.')) return false;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
    return allowedHostValues(input).has(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

function isAllowedReferer(value: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username && !parsed.password && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function denied(
  code: RequestBoundaryFailureCode,
  statusCode: 400 | 403,
  message: string,
): RequestBoundaryResult {
  return { allowed: false, statusCode, code, message };
}

/**
 * Enforces the browser-facing trust boundary before body parsing or route handlers.
 *
 * Requests without browser provenance headers remain available to local CLI and
 * automation clients. This is not process authentication: any process with access
 * to the user's account can still call the loopback API directly.
 */
export function validateRequestBoundary(input: RequestBoundaryInput): RequestBoundaryResult {
  const host = readUniqueHeader(input.headers, input.rawHeaders, 'host');
  if (host.invalid || !isAllowedHost(host.value, input)) {
    return denied('HOST_NOT_ALLOWED', 400, 'Request host is not allowed.');
  }

  const origin = readUniqueHeader(input.headers, input.rawHeaders, 'origin');
  if (origin.invalid) {
    return denied('REQUEST_METADATA_INVALID', 400, 'Request metadata is invalid.');
  }
  const allowedOrigins = new Set(input.allowedOrigins);
  if (origin.value !== undefined && (origin.value === 'null' || !allowedOrigins.has(origin.value))) {
    return denied('ORIGIN_NOT_ALLOWED', 403, 'Request origin is not allowed.');
  }

  const referer = readUniqueHeader(input.headers, input.rawHeaders, 'referer');
  if (referer.invalid || (referer.value !== undefined && !isAllowedReferer(referer.value, allowedOrigins))) {
    return denied('ORIGIN_NOT_ALLOWED', 403, 'Request origin is not allowed.');
  }

  const fetchSite = readUniqueHeader(input.headers, input.rawHeaders, 'sec-fetch-site');
  if (fetchSite.invalid || (fetchSite.value !== undefined && !FETCH_SITE_VALUES.has(fetchSite.value))) {
    return denied('REQUEST_METADATA_INVALID', 400, 'Request metadata is invalid.');
  }
  if (fetchSite.value === 'cross-site') {
    return denied('ORIGIN_NOT_ALLOWED', 403, 'Request origin is not allowed.');
  }

  const isUnsafeMethod = !SAFE_METHODS.has(input.method.toUpperCase());
  if (
    isUnsafeMethod &&
    origin.value === undefined &&
    referer.value === undefined &&
    (fetchSite.value === 'same-site' || fetchSite.value === 'none')
  ) {
    return denied('ORIGIN_NOT_ALLOWED', 403, 'Request origin is not allowed.');
  }

  return { allowed: true };
}
