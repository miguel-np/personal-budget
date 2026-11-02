import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { OFFICIAL_SOURCE_DOMAINS, isOfficialSourceHost, retrieveOfficialDocument } from './official-evidence.js';
import { isPublicNetworkAddress } from './network-address.js';
import type { OfficialDocumentEvidence } from './official-evidence.js';

export { OFFICIAL_SOURCE_DOMAINS, OFFICIAL_SOURCE_HOSTS } from './official-evidence.js';

export type OfficialSourceDomain = (typeof OFFICIAL_SOURCE_DOMAINS)[number];
export interface WebSearchSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly institution: string;
  readonly publishedAt: string | null;
  readonly modifiedAt: string | null;
  readonly snippet: string;
  readonly sourceKind: 'normativa' | 'normativa_consolidada_informativa' | 'criterio_administrativo' | 'organismo_oficial' | 'externa';
  readonly sourceAuthority: 'legislation' | 'legal_consolidation' | 'dgt_criteria' | 'teac_criteria' | 'tax_administration' | 'tax_agency_guidance' | 'official_information' | 'external';
  readonly document?: OfficialDocumentEvidence;
}
export interface WebSearchResponse {
  readonly provider: 'SearXNG';
  readonly searchedAt: string;
  readonly sources: readonly WebSearchSource[];
}
export interface WebSearchConfig {
  readonly baseURL: string;
  readonly timeoutMs: number;
  readonly maxResults: number;
  readonly maxQueryChars: number;
  readonly maxResponseBytes: number;
}
export class WebSearchUnavailableError extends Error {
  public constructor() {
    super('Web search provider is unavailable.');
    this.name = 'WebSearchUnavailableError';
  }
}
export class WebSearchResponseTooLargeError extends Error {
  public constructor() {
    super('Web search provider response exceeded its configured limit.');
    this.name = 'WebSearchResponseTooLargeError';
  }
}

function isLoopbackAddress(address: string, family: number): boolean {
  if (family === 4) return address.startsWith('127.');
  return address === '::1' || address.toLowerCase() === '0:0:0:0:0:0:0:1';
}
function hostWithoutBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
function isLoopbackHost(hostname: string): boolean {
  const host = hostWithoutBrackets(hostname.toLowerCase());
  if (host === 'localhost') return true;
  return isIP(host) === 4 ? host.startsWith('127.') : host === '::1';
}
function validateBaseURL(value: string): URL {
  const url = new URL(value);
  const hostname = hostWithoutBrackets(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('WEB_SEARCH_BASE_URL must be an origin without credentials, path, query or fragment.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(hostname))) {
    throw new Error('Web search must use HTTPS; plain HTTP is allowed only for an explicitly configured loopback SearXNG instance.');
  }
  if (isIP(hostname) !== 0 && !isLoopbackHost(hostname)) {
    throw new Error('Web search cannot target a private or non-loopback IP address.');
  }
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname === 'metadata.google.internal') {
    throw new Error('Web search cannot target local or metadata hostnames.');
  }
  return url;
}
function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain);
}
function cleanText(value: string, maximum: number): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/gi, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maximum);
}
function publishedDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = typeof value === 'number' ? new Date(value < 10_000_000_000 ? value * 1_000 : value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function isDogPublication(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return ['xunta.gal', 'www.xunta.gal'].includes(hostname) &&
    /^\/(?:es\/)?diario-oficial-galicia(?:\/|$)/i.test(url.pathname);
}
function institutionLabel(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  if (isDogPublication(url)) return 'Diario Oficial de Galicia (DOG)';
  if (hostname === 'sede.tributos.hacienda.gob.es' || matchesDomain(hostname, 'petete.tributos.hacienda.gob.es')) return 'Dirección General de Tributos (DGT)';
  if (matchesDomain(hostname, 'serviciostelematicosext.hacienda.gob.es') || matchesDomain(hostname, 'sede.tea.hacienda.gob.es')) return 'Tribunal Económico-Administrativo Central (TEAC)';
  if (matchesDomain(hostname, 'lex.gal')) return 'Lex.gal · legislación consolidada de Galicia';
  if (matchesDomain(hostname, 'agenciatributaria.gob.es')) return 'Agencia Estatal de Administración Tributaria (AEAT)';
  if (matchesDomain(hostname, 'boe.es')) return 'Boletín Oficial del Estado (BOE)';
  if (matchesDomain(hostname, 'hacienda.gob.es')) return 'Ministerio de Hacienda';
  if (matchesDomain(hostname, 'seg-social.es') || matchesDomain(hostname, 'seg-social.gob.es')) return 'Seguridad Social';
  if (matchesDomain(hostname, 'xunta.gal')) return 'Xunta de Galicia';
  if (matchesDomain(hostname, 'cnmv.es')) return 'Comisión Nacional del Mercado de Valores (CNMV)';
  if (matchesDomain(hostname, 'bde.es')) return 'Banco de España';
  return hostname;
}
function sourceAuthority(url: URL): WebSearchSource['sourceAuthority'] {
  const hostname = url.hostname.toLowerCase();
  if (matchesDomain(hostname, 'boe.es') || isDogPublication(url)) return 'legislation';
  if (matchesDomain(hostname, 'lex.gal')) return 'legal_consolidation';
  if (hostname === 'sede.tributos.hacienda.gob.es' || matchesDomain(hostname, 'petete.tributos.hacienda.gob.es')) return 'dgt_criteria';
  if (matchesDomain(hostname, 'serviciostelematicosext.hacienda.gob.es') || matchesDomain(hostname, 'sede.tea.hacienda.gob.es')) return 'teac_criteria';
  if (matchesDomain(hostname, 'hacienda.gob.es')) return 'tax_administration';
  if (matchesDomain(hostname, 'agenciatributaria.gob.es')) return 'tax_agency_guidance';
  if (OFFICIAL_SOURCE_DOMAINS.some((domain) => matchesDomain(hostname, domain)) ||
    matchesDomain(hostname, 'seg-social.gob.es')) return 'official_information';
  return 'external';
}
function sourceKind(url: URL): WebSearchSource['sourceKind'] {
  const hostname = url.hostname.toLowerCase();
  if (matchesDomain(hostname, 'boe.es') || isDogPublication(url)) return 'normativa';
  if (matchesDomain(hostname, 'lex.gal')) return 'normativa_consolidada_informativa';
  if (hostname.endsWith('.hacienda.gob.es') || hostname === 'hacienda.gob.es') return 'criterio_administrativo';
  if (OFFICIAL_SOURCE_DOMAINS.some((domain) => matchesDomain(hostname, domain)) ||
    matchesDomain(hostname, 'seg-social.gob.es')) return 'organismo_oficial';
  return 'externa';
}
function parseSource(value: unknown, index: number, allowedDomains: readonly string[]): WebSearchSource | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.title !== 'string' || typeof item.url !== 'string') return null;
  let url: URL;
  try { url = new URL(item.url); } catch { return null; }
  const hostname = hostWithoutBrackets(url.hostname).toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || hostname === 'localhost' ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') || isIP(hostname) !== 0) return null;
  const belongsToOfficialNamespace = OFFICIAL_SOURCE_DOMAINS.some((domain) => matchesDomain(hostname, domain));
  const exactOfficialHost = isOfficialSourceHost(hostname);
  // Known institutional namespaces are not trusted wholesale: a lookalike,
  // abandoned or unrelated subdomain must not inherit the institution label.
  if (belongsToOfficialNamespace && !exactOfficialHost) return null;
  if (allowedDomains.length > 0 && (!exactOfficialHost || !allowedDomains.some((domain) => matchesDomain(hostname, domain)))) return null;
  const title = cleanText(item.title, 180);
  const snippet = cleanText(typeof item.content === 'string' ? item.content : '', 480);
  if (!title || !snippet) return null;
  return {
    id: 'S' + String(index + 1),
    title,
    url: url.toString().slice(0, 2_048),
    domain: hostname,
    institution: institutionLabel(url),
    publishedAt: publishedDate(item.publishedDate),
    modifiedAt: publishedDate(item.modifiedDate ?? item.updatedDate ?? item.lastUpdated),
    snippet,
    sourceKind: sourceKind(url),
    sourceAuthority: sourceAuthority(url),
  };
}

export interface WebSearchProvider {
  search(query: string, allowedDomains: readonly string[], callerSignal?: AbortSignal): Promise<WebSearchResponse>;
  retrieveOfficialDocuments?(search: WebSearchResponse, query: string, referenceDate: string, callerSignal?: AbortSignal, eventDate?: string): Promise<WebSearchResponse>;
}

export class SearXNGSearchProvider implements WebSearchProvider {
  private readonly baseURL: URL;
  public constructor(private readonly config: WebSearchConfig) {
    this.baseURL = validateBaseURL(config.baseURL);
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000) throw new Error('Invalid web search timeout.');
    if (!Number.isSafeInteger(config.maxResults) || config.maxResults < 1 || config.maxResults > 8) throw new Error('Invalid web search result limit.');
    if (!Number.isSafeInteger(config.maxQueryChars) || config.maxQueryChars < 20 || config.maxQueryChars > 500) throw new Error('Invalid web search query limit.');
    if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 8_192 || config.maxResponseBytes > 262_144) throw new Error('Invalid web search response limit.');
  }

  public async retrieveOfficialDocuments(
    search: WebSearchResponse,
    query: string,
    referenceDate: string,
    callerSignal?: AbortSignal,
    eventDate?: string,
  ): Promise<WebSearchResponse> {
    if (callerSignal?.aborted) throw new WebSearchUnavailableError();
    const candidates = search.sources.filter((source) => source.sourceAuthority !== 'external').slice(0, 3);
    const evidence = await Promise.all(candidates.map(async (source) => ({
      id: source.id,
      document: await retrieveOfficialDocument(source, query, referenceDate, this.config.timeoutMs, callerSignal, undefined, eventDate),
    })));
    const byId = new Map(evidence.map((item) => [item.id, item.document]));
    return {
      ...search,
      sources: search.sources.map((source) => {
        const document = byId.get(source.id);
        return document ? { ...source, document } : source;
      }),
    };
  }

  public async search(query: string, allowedDomains: readonly string[], callerSignal?: AbortSignal): Promise<WebSearchResponse> {
    const safeQuery = query.trim();
    if (safeQuery.length < 2 || safeQuery.length > this.config.maxQueryChars || /[\u0000-\u001F\u007F]/.test(safeQuery)) throw new WebSearchUnavailableError();
    if (allowedDomains.length > OFFICIAL_SOURCE_DOMAINS.length ||
      allowedDomains.some((domain) => !OFFICIAL_SOURCE_DOMAINS.includes(domain as OfficialSourceDomain))) {
      throw new WebSearchUnavailableError();
    }
    if (callerSignal?.aborted) throw new WebSearchUnavailableError();

    const hostname = hostWithoutBrackets(this.baseURL.hostname);
    let addresses: Array<{ readonly address: string; readonly family: number }> = [];
    if (isIP(hostname) !== 0) {
      const family = isIP(hostname);
      if (!isLoopbackAddress(hostname, family) && !isPublicNetworkAddress(hostname, family)) throw new WebSearchUnavailableError();
      addresses = [{ address: hostname, family: family as 4 | 6 }];
    } else {
      try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
      catch { throw new WebSearchUnavailableError(); }
      if (addresses.length === 0) throw new WebSearchUnavailableError();
      const localEndpoint = isLoopbackHost(hostname);
      if (addresses.some((item) => localEndpoint ? !isLoopbackAddress(item.address, item.family) : !isPublicNetworkAddress(item.address, item.family))) {
        throw new WebSearchUnavailableError();
      }
    }
    const selectedAddress = addresses[0]!;
    const pinnedLookup = ((_: string, __: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
      callback(null, selectedAddress.address, selectedAddress.family);
    }) as NonNullable<RequestOptions['lookup']>;
    const target = new URL('/search', this.baseURL);
    target.searchParams.set('q', safeQuery);
    target.searchParams.set('format', 'json');
    target.searchParams.set('safesearch', '2');
    target.searchParams.set('pageno', '1');
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(this.config.timeoutMs)])
      : AbortSignal.timeout(this.config.timeoutMs);

    const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const requester = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const options: RequestOptions = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: 'GET',
        path: target.pathname + target.search,
        headers: { Accept: 'application/json', 'User-Agent': 'PersonalBudget/0.1 local-web-research' },
        maxHeaderSize: 8_192,
        signal,
        lookup: pinnedLookup,
        ...(target.protocol === 'https:' && isIP(hostname) === 0 ? { servername: hostname } : {}),
      };
      const request = requester(options, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new WebSearchUnavailableError());
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(new WebSearchUnavailableError());
          return;
        }
        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > this.config.maxResponseBytes) {
          response.destroy();
          reject(new WebSearchResponseTooLargeError());
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > this.config.maxResponseBytes) {
            response.destroy(new WebSearchResponseTooLargeError());
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', (error: Error) => reject(error instanceof WebSearchResponseTooLargeError ? error : new WebSearchUnavailableError()));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if (!parsed || typeof parsed !== 'object') throw new Error('Invalid search payload.');
            resolve(parsed as Record<string, unknown>);
          } catch { reject(new WebSearchUnavailableError()); }
        });
      });
      request.on('error', () => reject(new WebSearchUnavailableError()));
      request.end();
    });

    const rawResults = Array.isArray(payload.results) ? payload.results : [];
    const sources: WebSearchSource[] = [];
    for (const item of rawResults) {
      const parsed = parseSource(item, sources.length, allowedDomains);
      if (!parsed) continue;
      sources.push(parsed);
      if (sources.length >= this.config.maxResults) break;
    }
    return { provider: 'SearXNG', searchedAt: new Date().toISOString(), sources };
  }
}
