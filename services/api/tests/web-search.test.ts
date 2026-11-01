import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SearXNGSearchProvider, WebSearchResponseTooLargeError } from '../src/web-search.js';
import { assessBoeTemporalMetadata, extractOfficialHtmlText, retrieveOfficialDocument } from '../src/official-evidence.js';

const servers: Array<{ close: () => Promise<void> }> = [];
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start local SearXNG fixture.');
  const fixture = {
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  servers.push(fixture);
  return fixture;
}
function config(baseURL: string, maxResponseBytes = 32_768) {
  return { baseURL, timeoutMs: 2_000, maxResults: 5, maxQueryChars: 300, maxResponseBytes };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SearXNG web search provider', () => {
  it('sends only the approved query, filters official domains and rejects internal result URLs', async () => {
    let requestedURL = '';
    const fixture = await serve((request, response) => {
      requestedURL = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [
        { title: 'Ley publicada', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2025-1', content: 'Texto oficial y fecha de entrada en vigor.', publishedDate: '2025-03-01', modifiedDate: '2025-04-01' },
        { title: 'Internal metadata', url: 'https://169.254.169.254/latest/meta-data', content: 'Debe descartarse.' },
        { title: 'Private UI', url: 'https://127.0.0.1/admin', content: 'Debe descartarse.' },
        { title: 'Domain outside filter', url: 'https://example.com/article', content: 'Debe descartarse por dominio.' },
      ] }));
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    const result = await provider.search('IRPF ejercicio 2025', ['boe.es']);

    expect(requestedURL).toContain('/search?');
    expect(new URL(requestedURL, fixture.url).searchParams.get('q')).toBe('IRPF ejercicio 2025');
    expect(new URL(requestedURL, fixture.url).searchParams.get('format')).toBe('json');
    expect(result.provider).toBe('SearXNG');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      id: 'S1', domain: 'www.boe.es', institution: 'Boletín Oficial del Estado (BOE)', sourceKind: 'normativa', sourceAuthority: 'legislation',
      publishedAt: '2025-03-01T00:00:00.000Z', modifiedAt: '2025-04-01T00:00:00.000Z',
    });
  });

  it('classifies Diario Oficial de Galicia results as published normative sources', async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [{
        title: 'Disposición publicada en DOG',
        url: 'https://dog.gal/gl/publicados',
        content: 'Texto normativo autonómico.',
        publishedDate: '2026-01-15',
      }] }));
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    const result = await provider.search('normativa autonómica', ['dog.gal']);
    expect(result.sources[0]).toMatchObject({
      domain: 'dog.gal',
      institution: 'Xunta de Galicia / Diario Oficial de Galicia',
      sourceKind: 'normativa',
    });
  });

  it('classifies DGT and TEAC sources distinctly from legislation and generic guidance', async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [
        { title: 'Consulta vinculante', url: 'https://petete.tributos.hacienda.gob.es/consultas/', content: 'Criterio DGT.' },
        { title: 'Resolución TEAC', url: 'https://serviciostelematicosext.hacienda.gob.es/TEAC/DYCTEA/', content: 'Criterio TEAC.' },
      ] }));
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    const result = await provider.search('criterio tributario', [
      'petete.tributos.hacienda.gob.es', 'serviciostelematicosext.hacienda.gob.es',
    ]);
    expect(result.sources[0]).toMatchObject({
      institution: 'Dirección General de Tributos (DGT)', sourceAuthority: 'dgt_criteria',
    });
    expect(result.sources[1]).toMatchObject({
      institution: 'Tribunal Económico-Administrativo Central (TEAC)', sourceAuthority: 'teac_criteria',
    });
  });

  it('does not follow provider redirects', async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:1/internal' });
      response.end();
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    await expect(provider.search('consulta pública', [])).rejects.toThrow();
  });

  it('rejects non-HTTPS remote provider endpoints and local metadata destinations', () => {
    expect(() => new SearXNGSearchProvider(config('http://search.example.org'))).toThrow();
    expect(() => new SearXNGSearchProvider(config('http://169.254.169.254'))).toThrow();
    expect(() => new SearXNGSearchProvider(config('file:///etc/passwd'))).toThrow();
  });

  it('bounds provider response bytes', async () => {
    const fixture = await serve((_request, response) => {
      const body = JSON.stringify({ results: [{ title: 'A', url: 'https://www.boe.es/a', content: 'x'.repeat(9_000) }] });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
    const provider = new SearXNGSearchProvider(config(fixture.url, 8_192));
    await expect(provider.search('consulta de prueba', [])).rejects.toBeInstanceOf(WebSearchResponseTooLargeError);
  });

  it('returns no sources when official-domain filters do not match', async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [
        { title: 'General article', url: 'https://example.com/article', content: 'Snippet.' },
      ] }));
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    await expect(provider.search('consulta de prueba', ['boe.es'])).resolves.toMatchObject({ sources: [] });
  });
describe('official document evidence and temporal metadata', () => {
  it('does not claim a repeal without an effective date and evaluates dated repeals against the requested date', () => {
    const missingDate = assessBoeTemporalMetadata({
      fecha_vigencia: '20200101',
      estado_consolidacion: 'Finalizado',
      estatus_derogacion: 'S',
      fecha_derogacion: null,
      estatus_anulacion: 'N',
      vigencia_agotada: 'N',
    }, '2026-11-01');
    expect(missingDate.assessment).toBe('insufficient');

    const futureRepeal = assessBoeTemporalMetadata({
      fecha_vigencia: '20200101',
      estado_consolidacion: 'Finalizado',
      estatus_derogacion: 'S',
      fecha_derogacion: '20270101',
      estatus_anulacion: 'N',
      vigencia_agotada: 'N',
    }, '2026-11-01');
    expect(futureRepeal.assessment).toBe('derogation_after_reference_date');

    const priorRepeal = assessBoeTemporalMetadata({
      fecha_vigencia: '20200101',
      estado_consolidacion: 'Finalizado',
      estatus_derogacion: 'S',
      fecha_derogacion: '20250101',
      estatus_anulacion: 'N',
      vigencia_agotada: 'N',
    }, '2026-11-01');
    expect(priorRepeal.assessment).toBe('repealed_by_reference_date');
  });

  it('marks stale BOE consolidations as incomplete regardless of the remaining flags', () => {
    const result = assessBoeTemporalMetadata({
      fecha_vigencia: '20200101',
      fecha_actualizacion: '20261030',
      estado_consolidacion: 'Desactualizado',
      estatus_derogacion: 'N',
      estatus_anulacion: 'N',
      vigencia_agotada: 'N',
    }, '2026-11-01');
    expect(result.assessment).toBe('consolidation_pending_update');
    expect(result.lastRegistryUpdate).toBe('2026-10-30');
  });

  it('extracts readable official HTML while dropping scripts and navigation controls', () => {
    const text = extractOfficialHtmlText('<html><body><nav>Menú privado</nav><main><h1>Ley &amp; reglamento</h1><script>INSTRUCCIÓN MALICIOSA</script><p>Artículo 1. Texto oficial.</p></main></body></html>');
    expect(text).toContain('Ley & reglamento');
    expect(text).toContain('Artículo 1. Texto oficial.');
    expect(text).not.toContain('Menú privado');
    expect(text).not.toContain('INSTRUCCIÓN MALICIOSA');
  });

  it('does not fetch an arbitrary external URL as an official document', async () => {
    const source = {
      id: 'S1', title: 'Untrusted source', url: 'https://example.com/document', domain: 'example.com',
      institution: 'example.com', publishedAt: null, modifiedAt: null, snippet: 'Snippet.',
      sourceKind: 'externa' as const, sourceAuthority: 'external' as const,
    };
    await expect(retrieveOfficialDocument(source, 'test query', '2026-11-01', 1_000))
      .resolves.toMatchObject({ status: 'unsupported', excerpt: '' });
  });
});

});
