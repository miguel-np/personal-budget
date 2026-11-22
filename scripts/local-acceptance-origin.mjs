export const DEFAULT_LOCAL_ACCEPTANCE_API_ORIGIN = 'http://127.0.0.1:3000';

export function validateLocalAcceptanceOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('The local acceptance API origin is required.');
  }

  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(value);
  if (!match) {
    throw new Error('The acceptance API must use an explicit HTTP port on 127.0.0.1, with no credentials, path, query or fragment.');
  }

  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The local acceptance API port must be between 1 and 65535.');
  }

  return new URL('http://127.0.0.1:' + port);
}
