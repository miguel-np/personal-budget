import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicAddress, validateAcceptanceEndpoint } from './acceptance-endpoint.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('accepts a public HTTPS hostname with public DNS answers', async () => {
  const result = await validateAcceptanceEndpoint('https://acceptance.example.net', { lookup: publicLookup });
  assert.equal(result.hostname, 'acceptance.example.net');
});

test('accepts public IPv4 and IPv6 literals', async () => {
  assert.equal((await validateAcceptanceEndpoint('https://8.8.8.8')).hostname, '8.8.8.8');
  assert.equal((await validateAcceptanceEndpoint('https://[2606:4700:4700::1111]')).hostname, '[2606:4700:4700::1111]');
});

test('rejects non-HTTPS URLs and URL components', async () => {
  for (const value of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?query=1',
    'https://example.com/#fragment',
  ]) {
    await assert.rejects(validateAcceptanceEndpoint(value, { lookup: publicLookup }));
  }
});

test('rejects local and reserved hostnames before DNS resolution', async () => {
  for (const value of ['https://localhost', 'https://api.local', 'https://api.internal', 'https://service.test']) {
    await assert.rejects(validateAcceptanceEndpoint(value, { lookup: publicLookup }));
  }
});

test('rejects private, loopback, link-local, documentation and multicast IP ranges', async () => {
  for (const address of [
    '0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '2002:7f00:1::1', '3fff::1', '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
    await assert.rejects(validateAcceptanceEndpoint('https://' + (address.includes(':') ? '[' + address + ']' : address)));
  }
});

test('rejects DNS answers containing any non-public address', async () => {
  const mixedLookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(
    validateAcceptanceEndpoint('https://mixed.example.net', { lookup: mixedLookup }),
    /Every resolved acceptance target address must be globally routable/,
  );
});

test('fails closed when DNS cannot resolve the configured host', async () => {
  const failedLookup = async () => { throw new Error('DNS unavailable'); };
  await assert.rejects(
    validateAcceptanceEndpoint('https://unresolved.example.net', { lookup: failedLookup }),
    /could not be resolved safely/,
  );
});
