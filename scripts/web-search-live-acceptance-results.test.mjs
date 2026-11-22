import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSourceAcceptanceEvidence, sanitizePublicSourceUrl } from './web-search-live-acceptance-results.mjs';

function source(overrides = {}) {
  return {
    title: 'Documento oficial de prueba',
    url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2024-1234&token=must-not-be-recorded#fragment',
    sourceAuthority: 'legislation',
    sourceKind: 'normativa',
    publishedAt: null,
    modifiedAt: '2024-02-01T00:00:00.000Z',
    document: {
      status: 'retrieved',
      documentType: 'boe_consolidated_legislation',
      retrievedAt: '2026-11-22T12:00:00.000Z',
      contentType: 'text/html; charset=utf-8',
      textLength: 1200,
      temporal: { assessment: 'not_marked_derogated_or_exhausted', publicationDate: '2024-02-01' },
      historical: { status: 'insufficient', blocks: [] },
      fetches: [{
        endpoint: '/buscar/act.php',
        httpStatus: 200,
        contentType: 'text/html; charset=utf-8',
        bytesReceived: 1200,
        latencyMs: 45,
        outcome: 'completed',
      }],
      limitations: ['El contenido consolidado es informativo.'],
      excerpt: 'No debe conservarse en el informe.',
    },
    snippet: 'Tampoco debe conservarse.',
    ...overrides,
  };
}

test('accepts only a complete retrieved document and preserves a sanitized public URL', () => {
  const evidence = buildSourceAcceptanceEvidence(source(), 'www.boe.es');
  assert.equal(evidence.acceptanceStatus, 'accepted');
  assert.equal(evidence.documentAccepted, true);
  assert.equal(evidence.sourceUrl, 'https://www.boe.es/buscar/act.php?id=BOE-A-2024-1234');
  assert.equal(evidence.publishedAt, null);
  assert.equal(evidence.publishedAtStatus, 'missing');
  assert.equal(evidence.modifiedAt, '2024-02-01T00:00:00.000Z');
  assert.equal(evidence.document.documentType, 'boe_consolidated_legislation');
  assert.equal(evidence.document.fetches[0].httpStatus, 200);
  assert.equal(JSON.stringify(evidence).includes('must-not-be-recorded'), false);
  assert.equal(JSON.stringify(evidence).includes('No debe conservarse'), false);
  assert.equal(JSON.stringify(evidence).includes('Tampoco debe conservarse'), false);
});

test('does not promote a partial BOE text extraction to complete host acceptance', () => {
  const evidence = buildSourceAcceptanceEvidence(source({
    document: {
      ...source().document,
      status: 'partial',
      temporal: null,
      limitations: ['No se pudieron validar todos los metadatos oficiales.'],
    },
  }), 'www.boe.es');
  assert.equal(evidence.acceptanceStatus, 'partial');
  assert.equal(evidence.documentAccepted, false);
  assert.equal(evidence.document.status, 'partial');
});

test('rejects non-HTTPS, mismatched, credentialed and explicit-port source URLs', () => {
  for (const url of [
    'http://www.boe.es/documento',
    'https://evil.example/documento',
    'https://user:pass@www.boe.es/documento',
    'https://www.boe.es:8443/documento',
  ]) {
    assert.equal(sanitizePublicSourceUrl(url, 'www.boe.es'), null, url);
    assert.equal(buildSourceAcceptanceEvidence(source({ url }), 'www.boe.es').acceptanceStatus, 'rejected', url);
  }
});

test('rejects invalid provider date metadata and unsupported MIME values', () => {
  const invalidDate = buildSourceAcceptanceEvidence(source({ publishedAt: 'not-a-date' }), 'www.boe.es');
  assert.equal(invalidDate.publishedAt, null);
  assert.equal(invalidDate.publishedAtStatus, 'invalid');
  assert.equal(invalidDate.acceptanceStatus, 'rejected');

  const invalidMime = buildSourceAcceptanceEvidence(source({
    document: {
      ...source().document,
      contentType: 'text/html-malicious',
      fetches: [{ ...source().document.fetches[0], contentType: 'text/html-malicious' }],
    },
  }), 'www.boe.es');
  assert.equal(invalidMime.acceptanceStatus, 'rejected');
});

test('does not accept a document without a successful bounded extractor fetch', () => {
  const evidence = buildSourceAcceptanceEvidence(source({
    document: { ...source().document, fetches: [{ ...source().document.fetches[0], httpStatus: 302 }] },
  }), 'www.boe.es');
  assert.equal(evidence.acceptanceStatus, 'rejected');
});
