import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateNegativeProbe } from './web-search-live-acceptance-probes.mjs';

test('does not pass a negative probe when the API returned no usable sources', () => {
  const probe = { requiredHosts: ['www.xunta.gal'], forbiddenHosts: ['dog.gal'] };
  assert.deepEqual(evaluateNegativeProbe(probe, []), {
    status: 'not_observed',
    forbiddenHostsObserved: [],
  });
  assert.deepEqual(evaluateNegativeProbe(probe, [{ host: null }]), {
    status: 'not_observed',
    forbiddenHostsObserved: [],
  });
});

test('requires a positive in-scope source and rejects forbidden hosts and subdomains', () => {
  const probe = {
    requiredHosts: ['boe.es', 'www.boe.es'],
    forbiddenHosts: ['example.com'],
  };
  assert.deepEqual(evaluateNegativeProbe(probe, [{ host: 'www.boe.es' }]), {
    status: 'accepted',
    forbiddenHostsObserved: [],
  });
  assert.deepEqual(evaluateNegativeProbe(probe, [{ host: 'www.boe.es' }, { host: 'example.com' }]), {
    status: 'rejected',
    forbiddenHostsObserved: ['example.com'],
  });
  assert.deepEqual(evaluateNegativeProbe(probe, [{ host: 'www.boe.es' }, { host: 'docs.example.com' }]), {
    status: 'rejected',
    forbiddenHostsObserved: ['example.com'],
  });
  assert.deepEqual(evaluateNegativeProbe(probe, [{ host: 'www.xunta.gal' }]), {
    status: 'not_observed',
    forbiddenHostsObserved: [],
  });
});

test('requires the expected external host to be explicitly classified and not retrieved', () => {
  const probe = { expectedExternalHost: 'dog.gal' };
  assert.deepEqual(evaluateNegativeProbe(probe, [{
    host: 'dog.gal',
    sourceAuthority: 'external',
    documentRetrieved: false,
  }]), {
    status: 'accepted',
    forbiddenHostsObserved: [],
  });
  assert.deepEqual(evaluateNegativeProbe(probe, [{
    host: 'dog.gal',
    sourceAuthority: 'legislation',
    documentRetrieved: false,
  }]), {
    status: 'rejected',
    forbiddenHostsObserved: [],
  });
  assert.deepEqual(evaluateNegativeProbe(probe, [{
    host: 'dog.gal',
    sourceAuthority: 'external',
    documentRetrieved: true,
  }]), {
    status: 'rejected',
    forbiddenHostsObserved: [],
  });
  assert.deepEqual(evaluateNegativeProbe(probe, [{ host: 'xunta.gal', sourceAuthority: 'official_information' }]), {
    status: 'not_observed',
    forbiddenHostsObserved: [],
  });
});
