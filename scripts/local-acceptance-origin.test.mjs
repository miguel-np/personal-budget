import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOCAL_ACCEPTANCE_API_ORIGIN,
  validateLocalAcceptanceOrigin,
} from './local-acceptance-origin.mjs';

test('defaults to the local API loopback origin', () => {
  assert.equal(DEFAULT_LOCAL_ACCEPTANCE_API_ORIGIN, 'http://127.0.0.1:3000');
  assert.equal(validateLocalAcceptanceOrigin(DEFAULT_LOCAL_ACCEPTANCE_API_ORIGIN).origin, DEFAULT_LOCAL_ACCEPTANCE_API_ORIGIN);
});

test('accepts an explicitly configured loopback port', () => {
  assert.equal(validateLocalAcceptanceOrigin('http://127.0.0.1:4173/').origin, 'http://127.0.0.1:4173');
});

test('rejects non-loopback hosts and hostnames without performing DNS lookup', () => {
  for (const value of [
    'https://example.com:443',
    'http://example.com:3000',
    'http://localhost:3000',
    'http://127.0.0.2:3000',
    'http://0.0.0.0:3000',
    'http://[::1]:3000',
    'http://2130706433:3000',
    'https://127.0.0.1:3000',
  ]) {
    assert.throws(() => validateLocalAcceptanceOrigin(value));
  }
});

test('rejects credentials, non-root paths, query strings and fragments', () => {
  for (const value of [
    'http://user:pass@127.0.0.1:3000',
    'http://127.0.0.1:3000/api',
    'http://127.0.0.1:3000?x=1',
    'http://127.0.0.1:3000#fragment',
    'http://127.0.0.1:3000?',
    'http://127.0.0.1:3000#',
  ]) {
    assert.throws(() => validateLocalAcceptanceOrigin(value));
  }
});

test('rejects missing, zero and out-of-range ports', () => {
  for (const value of [
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
  ]) {
    assert.throws(() => validateLocalAcceptanceOrigin(value));
  }
});

test('rejects empty and malformed configuration', () => {
  for (const value of ['', '   ', 'not-a-url', null, undefined]) {
    assert.throws(() => validateLocalAcceptanceOrigin(value));
  }
});
