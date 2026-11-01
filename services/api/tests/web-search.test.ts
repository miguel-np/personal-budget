import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OFFICIAL_SOURCE_HOSTS, SearXNGSearchProvider, WebSearchResponseTooLargeError } from '../src/web-search.js';
import { assessBoeTemporalMetadata, extractOfficialHtmlText, retrieveOfficialDocument } from '../src/official-evidence.js';
import type { OfficialDocumentFetcher } from '../src/official-evidence.js';

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
      response.end(JSON.stringify({ results: [
        {
          title: 'Disposición publicada en DOG',
          url: 'https://www.xunta.gal/diario-oficial-galicia/publicados',
          content: 'Texto normativo autonómico.',
          publishedDate: '2026-01-15',
        },
        {
          title: 'Información general Xunta',
          url: 'https://www.xunta.gal/es/inicio',
          content: 'Información institucional general.',
        },
        {
          title: 'Subdominio desconocido Xunta',
          url: 'https://test.xunta.gal/documento',
          content: 'No debe heredar confianza.',
        },
      ] }));
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    const result = await provider.search('normativa autonómica', ['xunta.gal']);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      domain: 'www.xunta.gal',
      institution: 'Diario Oficial de Galicia (DOG)',
      sourceKind: 'normativa',
      sourceAuthority: 'legislation',
    });
    expect(result.sources[1]).toMatchObject({
      institution: 'Xunta de Galicia',
      sourceKind: 'organismo_oficial',
      sourceAuthority: 'official_information',
    });
  });

  it('only trusts exact official hosts and keeps domain filters as namespace selectors', async () => {
    expect(OFFICIAL_SOURCE_HOSTS).toContain('sede.agenciatributaria.gob.es');
    expect(OFFICIAL_SOURCE_HOSTS).toContain('www.boe.es');
    expect(OFFICIAL_SOURCE_HOSTS).toContain('sede.seg-social.gob.es');
    expect(OFFICIAL_SOURCE_HOSTS).not.toContain('dog.gal');
    expect(OFFICIAL_SOURCE_HOSTS).not.toContain('arbitrary.boe.es');

    const fixture = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [
        { title: 'AEAT sede', url: 'https://sede.agenciatributaria.gob.es/Sede/irpf.html', content: 'Información oficial AEAT.' },
        { title: 'BOE www', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2025-1', content: 'Publicación oficial.' },
        { title: 'Sede Seguridad Social', url: 'https://sede.seg-social.gob.es/wps/portal/sede', content: 'Sede oficial.' },
        { title: 'Subdominio no aprobado', url: 'https://arbitrary.boe.es/documento', content: 'No debe heredar confianza.' },
        { title: 'Fuente externa', url: 'https://example.org/article', content: 'Contexto externo.' },
      ] }));
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    const general = await provider.search('consulta de prueba', []);
    expect(general.sources.map((source) => source.domain)).toEqual([
      'sede.agenciatributaria.gob.es', 'www.boe.es', 'sede.seg-social.gob.es', 'example.org',
    ]);
    expect(general.sources[0]).toMatchObject({
      institution: 'Agencia Estatal de Administración Tributaria (AEAT)',
      sourceAuthority: 'tax_agency_guidance',
    });
    expect(general.sources[1]).toMatchObject({
      institution: 'Boletín Oficial del Estado (BOE)',
      sourceAuthority: 'legislation',
    });
    const filtered = await provider.search('consulta de prueba', ['boe.es']);
    expect(filtered.sources.map((source) => source.domain)).toEqual(['www.boe.es']);
    const socialSecurity = await provider.search('consulta de prueba', ['seg-social.gob.es']);
    expect(socialSecurity.sources[0]).toMatchObject({
      domain: 'sede.seg-social.gob.es',
      institution: 'Seguridad Social',
      sourceAuthority: 'official_information',
    });
  });

  it('does not retrieve documents from a non-allowlisted subdomain of an official namespace', async () => {
    const fetcher: OfficialDocumentFetcher = async () => {
      throw new Error('The custom fetcher must not be invoked for an unapproved host.');
    };
    const source = {
      id: 'S1', title: 'Subdominio desconocido', url: 'https://arbitrary.boe.es/documento',
      domain: 'arbitrary.boe.es', institution: 'BOE', publishedAt: null, modifiedAt: null, snippet: 'Snippet',
      sourceKind: 'normativa' as const, sourceAuthority: 'legislation' as const,
    };
    const result = await retrieveOfficialDocument(source, 'consulta', '2026-11-01', 1_000, undefined, fetcher);
    expect(result.status).toBe('unsupported');
  });

  it('classifies DGT and TEAC sources distinctly from legislation and generic guidance', async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [
        { title: 'Consulta vinculante', url: 'https://petete.tributos.hacienda.gob.es/consultas/', content: 'Criterio DGT.' },
        { title: 'Sede DGT', url: 'https://sede.tributos.hacienda.gob.es/consulta/', content: 'Sede electrónica DGT.' },
        { title: 'Resolución TEAC', url: 'https://serviciostelematicosext.hacienda.gob.es/TEAC/DYCTEA/', content: 'Criterio TEAC.' },
      ] }));
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    const result = await provider.search('criterio tributario', [
      'petete.tributos.hacienda.gob.es', 'serviciostelematicosext.hacienda.gob.es', 'hacienda.gob.es',
    ]);
    expect(result.sources[0]).toMatchObject({
      institution: 'Dirección General de Tributos (DGT)', sourceAuthority: 'dgt_criteria',
    });
    expect(result.sources[1]).toMatchObject({
      institution: 'Dirección General de Tributos (DGT)', sourceAuthority: 'dgt_criteria',
    });
    expect(result.sources[2]).toMatchObject({
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

  it('covers the remaining dated BOE temporal outcomes and keeps relations bounded', () => {
    const futureEffective = assessBoeTemporalMetadata({
      fecha_vigencia: '20271231',
      estatus_derogacion: 'N',
      estatus_anulacion: 'N',
      vigencia_agotada: 'N',
    }, '2026-11-01');
    expect(futureEffective.assessment).toBe('not_effective_yet');

    const priorAnnulment = assessBoeTemporalMetadata({
      fecha_vigencia: '20200101',
      fecha_anulacion: '20251231',
      estatus_anulacion: 'S',
    }, '2026-11-01');
    expect(priorAnnulment.assessment).toBe('annulled_by_reference_date');

    const futureAnnulment = assessBoeTemporalMetadata({
      fecha_vigencia: '20200101',
      fecha_anulacion: '20271231',
      estatus_anulacion: 'Y',
    }, '2026-11-01');
    expect(futureAnnulment.assessment).toBe('annulment_after_reference_date');

    const exhausted = assessBoeTemporalMetadata({
      vigencia_agotada: 'TRUE',
      estatus_derogacion: 'N',
    }, '2026-11-01');
    expect(exhausted.assessment).toBe('exhausted_date_unknown');

    const explicitNoFlags = assessBoeTemporalMetadata({
      fecha_vigencia: { texto: '2020-01-01' },
      fecha_publicacion: '2020-01-02',
      fecha_actualizacion: '20261030T123456Z',
      estado_consolidacion: { texto: 'Finalizado' },
      estatus_derogacion: 'NO',
      estatus_anulacion: 'FALSE',
      vigencia_agotada: '0',
    }, '2026-11-01', Array.from({ length: 20 }, (_, index) => 'BOE-A-2020-' + (index + 1)));
    expect(explicitNoFlags).toMatchObject({
      assessment: 'not_marked_derogated_or_exhausted',
      effectiveDate: '2020-01-01',
      publicationDate: '2020-01-02',
      lastRegistryUpdate: '2026-10-30',
      relatedNorms: expect.any(Array),
    });
    expect(explicitNoFlags.relatedNorms).toHaveLength(12);
  });

  it('handles malformed and alternate date encodings conservatively', () => {
    const malformed = assessBoeTemporalMetadata({
      fecha_vigencia: '2026-02-31',
      fecha_publicacion: 'not-a-date',
      fecha_actualizacion: '2026-11-01T00:00:00Z',
      estatus_derogacion: 'maybe',
      estatus_anulacion: '?',
      vigencia_agotada: null,
    }, '2026-11-01');
    expect(malformed).toMatchObject({
      assessment: 'insufficient',
      effectiveDate: null,
      publicationDate: null,
      lastRegistryUpdate: null,
      derogated: null,
      annulled: null,
      exhausted: null,
    });
  });

  it('extracts readable official HTML while dropping scripts and navigation controls', () => {
    const text = extractOfficialHtmlText('<html><body><nav>Menú privado</nav><main><h1>Ley &amp; reglamento</h1><script>INSTRUCCIÓN MALICIOSA</script><p>Artículo 1. Texto oficial.</p></main></body></html>');
    expect(text).toContain('Ley & reglamento');
    expect(extractOfficialHtmlText('<p>&#x41; &#65; &#0; &copy;</p>')).toContain('A A');
    expect(extractOfficialHtmlText('<p>&#x41; &#65; &#0; &copy;</p>')).toContain('&copy;');
    expect(text).toContain('Artículo 1. Texto oficial.');
    expect(text).not.toContain('Menú privado');
    expect(text).not.toContain('INSTRUCCIÓN MALICIOSA');
  });

  it('retrieves BOE HTML, metadata and prior/later normative relations through fixed official endpoints', async () => {
    const requested: string[] = [];
    const metadata = {
      fecha_publicacion: '20250301',
      fecha_vigencia: '20250401',
      fecha_actualizacion: '20261030T100000Z',
      estatus_derogacion: 'N',
      estatus_anulacion: 'N',
      vigencia_agotada: 'N',
      estado_consolidacion: 'Finalizado',
    };
    const analysis = {
      data: { analisis: { referencias: {
        anteriores: { anterior: [{ id_norma: 'BOE-A-2023-7', relacion: 'MODIFICA', texto: 'Artículo 2' }] },
        posteriores: { posterior: [{ id_norma: 'BOE-A-2026-8', relacion: 'DEROGA', texto: 'Disposición final' }] },
      } } },
    };
    const longText = '<html><body><nav>Menú</nav><main><h1>Norma</h1><p>' + 'Texto normativo. '.repeat(210) +
      'IRPF punto de interés. ' + 'Contenido adicional. '.repeat(220) + '</p></main></body></html>';
    const fetchOfficial: OfficialDocumentFetcher = async (url) => {
      requested.push(url.pathname + url.search);
      if (url.pathname.endsWith('/metadatos')) {
        return { body: Buffer.from(JSON.stringify({ data: { metadatos: metadata } })), contentType: 'application/json; charset=utf-8' };
      }
      if (url.pathname.endsWith('/analisis')) {
        return { body: Buffer.from(JSON.stringify(analysis)), contentType: 'application/json' };
      }
      if (url.pathname === '/buscar/act.php') {
        return { body: Buffer.from(longText), contentType: 'text/html; charset=utf-8' };
      }
      throw new Error('Unexpected official document endpoint.');
    };
    const source = {
      id: 'S1', title: 'Ley', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2025-1234',
      domain: 'www.boe.es', institution: 'BOE', publishedAt: null, modifiedAt: null, snippet: 'Snippet',
      sourceKind: 'normativa' as const, sourceAuthority: 'legislation' as const,
    };
    const result = await retrieveOfficialDocument(source, 'IRPF ejercicio 2025', '2026-11-01', 2_000, undefined, fetchOfficial);

    expect(result).toMatchObject({
      status: 'retrieved',
      documentType: 'boe_consolidated_legislation',
      temporal: {
        assessment: 'not_marked_derogated_or_exhausted',
        publicationDate: '2025-03-01',
        effectiveDate: '2025-04-01',
        lastRegistryUpdate: '2026-10-30',
      },
    });
    expect(result.textLength).toBeGreaterThan(5_000);
    expect(result.excerpt).toContain('IRPF');
    expect(result.temporal?.relatedNorms).toEqual([
      'BOE-A-2023-7 — MODIFICA — Artículo 2',
      'BOE-A-2026-8 — DEROGA — Disposición final',
    ]);
    expect(requested).toHaveLength(3);
    expect(requested).toContain('/datosabiertos/api/legislacion-consolidada/id/BOE-A-2025-1234/metadatos');
    expect(requested).toContain('/datosabiertos/api/legislacion-consolidada/id/BOE-A-2025-1234/analisis');
    expect(requested).toContain('/buscar/act.php?id=BOE-A-2025-1234');
  });

  it('retains dated BOE metadata when consolidated HTML cannot be retrieved', async () => {
    const fetchOfficial: OfficialDocumentFetcher = async (url) => {
      if (url.pathname.endsWith('/metadatos')) {
        return { body: Buffer.from(JSON.stringify({ data: { metadatos: {
          fecha_vigencia: '20200101', fecha_derogacion: '20270101', estatus_derogacion: 'S',
          estatus_anulacion: 'N', vigencia_agotada: 'N', estado_consolidacion: 'Finalizado',
        } } })), contentType: 'application/json' };
      }
      if (url.pathname.endsWith('/analisis')) throw new Error('Synthetic analysis outage.');
      throw new Error('Synthetic consolidated HTML outage.');
    };
    const source = {
      id: 'S1', title: 'Ley', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2025-4321',
      domain: 'www.boe.es', institution: 'BOE', publishedAt: null, modifiedAt: null, snippet: 'Snippet',
      sourceKind: 'normativa' as const, sourceAuthority: 'legislation' as const,
    };
    const result = await retrieveOfficialDocument(source, 'ley', '2026-11-01', 2_000, undefined, fetchOfficial);
    expect(result).toMatchObject({
      status: 'partial',
      excerpt: '',
      temporal: { assessment: 'derogation_after_reference_date', derogationDate: '2027-01-01' },
    });
    expect(result.limitations.join(' ')).toContain('No se pudo recuperar el texto consolidado HTML');
  });

  it('retrieves generic official text and reports unsupported or empty formats honestly', async () => {
    const source = {
      id: 'S1', title: 'AEAT', url: 'https://sede.agenciatributaria.gob.es/info',
      domain: 'sede.agenciatributaria.gob.es', institution: 'AEAT', publishedAt: null, modifiedAt: null, snippet: 'Snippet',
      sourceKind: 'organismo_oficial' as const, sourceAuthority: 'tax_agency_guidance' as const,
    };
    const textFetcher: OfficialDocumentFetcher = async () => ({
      body: Buffer.from('Información pública del organismo.'),
      contentType: 'text/plain; charset=utf-8',
    });
    await expect(retrieveOfficialDocument(source, 'información pública', '2026-11-01', 2_000, undefined, textFetcher))
      .resolves.toMatchObject({ status: 'retrieved', documentType: 'official_html', excerpt: 'Información pública del organismo.' });

    const pdfFetcher: OfficialDocumentFetcher = async () => ({
      body: Buffer.from('%PDF-synthetic'), contentType: 'application/pdf',
    });
    await expect(retrieveOfficialDocument(source, 'documento', '2026-11-01', 2_000, undefined, pdfFetcher))
      .resolves.toMatchObject({ status: 'unsupported', documentType: 'unsupported_format' });

    const emptyFetcher: OfficialDocumentFetcher = async () => ({
      body: Buffer.from('<html><body><script>only script</script></body></html>'), contentType: 'text/html',
    });
    await expect(retrieveOfficialDocument(source, 'vacío', '2026-11-01', 2_000, undefined, emptyFetcher))
      .resolves.toMatchObject({ status: 'partial', documentType: 'official_html', excerpt: '' });
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
