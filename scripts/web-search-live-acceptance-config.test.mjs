import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { WEB_SEARCH_ACCEPTANCE_GROUPS } from './web-search-live-acceptance-config.mjs';

test('acceptance host inventory matches the API exact official-source allowlist', async () => {
  const source = await readFile(new URL('../services/api/src/official-evidence.ts', import.meta.url), 'utf8');
  const match = source.match(/export const OFFICIAL_SOURCE_HOSTS = \[([\s\S]*?)\] as const;/);
  assert.ok(match, 'OFFICIAL_SOURCE_HOSTS must remain an explicit source-code allowlist');

  const apiHosts = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]).sort();
  const acceptanceHosts = WEB_SEARCH_ACCEPTANCE_GROUPS.map((group) => group.host).sort();
  assert.deepEqual(acceptanceHosts, apiHosts);
  assert.equal(new Set(acceptanceHosts).size, acceptanceHosts.length, 'acceptance hosts must be unique');
});

test('acceptance requests are fixed public queries with an explicit host filter', () => {
  assert.ok(WEB_SEARCH_ACCEPTANCE_GROUPS.length > 0);
  for (const group of WEB_SEARCH_ACCEPTANCE_GROUPS) {
    assert.equal(typeof group.query, 'string');
    assert.ok(group.query.length >= 2 && group.query.length <= 300);
    assert.ok(!group.query.includes('${'), 'queries must not interpolate user data');
    assert.ok(Array.isArray(group.allowedDomains) && group.allowedDomains.length > 0);
    assert.ok(group.allowedDomains.every((domain) => typeof domain === 'string' && domain.length > 0));
    assert.ok(group.host && group.domain);
  }
  assert.equal(WEB_SEARCH_ACCEPTANCE_GROUPS.some((group) => group.host === 'dog.gal'), false);
});
