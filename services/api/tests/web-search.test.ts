import { createServer, type AddressInfo } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SearXNGSearchProvider, WebSearchResponseTooLargeError } from '../src/web-search.js';

const servers: Array<{ close: () => Promise<void> }> = [];
async function serve(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void) {
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
      id: 'S1', domain: 'www.boe.es', institution: 'Boletín Oficial del Estado (BOE)', sourceKind: 'normativa',
      publishedAt: '2025-03-01T00:00:00.000Z', modifiedAt: '2025-04-01T00:00:00.000Z',
    });
  });

  it('does not follow provider redirects', async () => {
    let redirected = false;
    const fixture = await serve((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:1/internal' });
      response.end();
    });
    const provider = new SearXNGSearchProvider(config(fixture.url));
    await expect(provider.search('consulta pública', [])).rejects.toThrow();
    expect(redirected).toBe(false);
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
});
