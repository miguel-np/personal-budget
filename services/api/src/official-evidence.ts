import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { WebSearchSource } from './web-search.js';
import { isPublicNetworkAddress } from './network-address.js';

/**
 * Official sources are a deliberately small allowlist. A result URL is never
 * treated as a general-purpose fetch target: it must be HTTPS and belong to one
 * of these explicitly approved hostnames. BOE legislation is resolved through its fixed
 * official Open Data API using a validated BOE document identifier.
 */
export const OFFICIAL_SOURCE_DOMAINS = [
  'agenciatributaria.gob.es',
  'boe.es',
  'hacienda.gob.es',
  'petete.tributos.hacienda.gob.es',
  'serviciostelematicosext.hacienda.gob.es',
  'sede.tea.hacienda.gob.es',
  'seg-social.es',
  'seg-social.gob.es',
  'xunta.gal',
  'lex.gal',
  'cnmv.es',
  'bde.es',
] as const;

/**
 * Exact hosts approved for result classification and server-side retrieval.
 * Domain filters above are user-facing groups; they are not fetch permissions.
 * Add a hostname only after validating institutional ownership and purpose.
 */
export const OFFICIAL_SOURCE_HOSTS = [
  'sede.agenciatributaria.gob.es',
  'boe.es',
  'www.boe.es',
  'hacienda.gob.es',
  'www.hacienda.gob.es',
  'petete.tributos.hacienda.gob.es',
  'sede.tributos.hacienda.gob.es',
  'serviciostelematicosext.hacienda.gob.es',
  'sede.tea.hacienda.gob.es',
  'seg-social.es',
  'www.seg-social.es',
  'sede.seg-social.gob.es',
  'portal.seg-social.gob.es',
  'xunta.gal',
  'www.xunta.gal',
  'sede.xunta.gal',
  'facenda.xunta.gal',
  'lex.gal',
  'cnmv.es',
  'www.cnmv.es',
  'bde.es',
  'www.bde.es',
  'sedeelectronica.bde.es',
] as const;

export type OfficialSourceHost = (typeof OFFICIAL_SOURCE_HOSTS)[number];

export function isOfficialSourceHost(hostname: string): boolean {
  return OFFICIAL_SOURCE_HOSTS.includes(hostname.toLowerCase() as OfficialSourceHost);
}

export type OfficialDocumentStatus = 'retrieved' | 'partial' | 'unavailable' | 'unsupported';
export type BoeTemporalAssessment =
  | 'consolidation_pending_update'
  | 'annulled_by_reference_date'
  | 'annulment_after_reference_date'
  | 'repealed_by_reference_date'
  | 'derogation_after_reference_date'
  | 'not_effective_yet'
  | 'exhausted_date_unknown'
  | 'not_marked_derogated_or_exhausted'
  | 'insufficient';

export interface BoeTemporalEvidence {
  readonly assessment: BoeTemporalAssessment;
  readonly referenceDate: string;
  readonly publicationDate: string | null;
  readonly effectiveDate: string | null;
  readonly derogationDate: string | null;
  readonly annulmentDate: string | null;
  readonly lastRegistryUpdate: string | null;
  readonly derogated: boolean | null;
  readonly annulled: boolean | null;
  readonly exhausted: boolean | null;
  readonly consolidationStatus: string | null;
  readonly relatedNorms: readonly string[];
}

export interface OfficialDocumentEvidence {
  readonly status: OfficialDocumentStatus;
  readonly documentType: 'boe_consolidated_legislation' | 'official_html' | 'unsupported_format';
  readonly retrievedAt: string | null;
  readonly contentType: string | null;
  /** Bounded extract sent to the local model and shown as evidence, not a cached full copy. */
  readonly excerpt: string;
  readonly textLength: number;
  readonly temporal: BoeTemporalEvidence | null;
  readonly limitations: readonly string[];
}

const MAX_HTML_BYTES = 1_048_576;
const MAX_BOE_METADATA_BYTES = 96_000;
const MAX_BOE_ANALYSIS_BYTES = 196_608;
const MAX_EXCERPT_CHARS = 5_000;
const MAX_RELATIONS = 12;

function isOfficialHost(hostname: string): boolean {
  return isOfficialSourceHost(hostname);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function fieldText(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || null;
  if (isRecord(value)) {
    const text = value.texto ?? value.text ?? value.value;
    return typeof text === 'string' ? text.trim() || null : null;
  }
  return null;
}
function validatedIsoDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? value : null;
}
function normalizeBoeDate(value: unknown): string | null {
  const raw = fieldText(value);
  if (!raw) return null;
  if (/^\d{8}$/.test(raw)) {
    return validatedIsoDate(raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validatedIsoDate(raw);
  const compact = raw.match(/^(\d{8})T\d{6}Z$/);
  if (compact) return validatedIsoDate(compact[1]!.slice(0, 4) + '-' + compact[1]!.slice(4, 6) + '-' + compact[1]!.slice(6, 8));
  return null;
}
function affirmative(value: unknown): boolean | null {
  const raw = fieldText(value)?.toUpperCase();
  if (raw === 'S' || raw === 'Y' || raw === 'SI' || raw === 'TRUE' || raw === '1') return true;
  if (raw === 'N' || raw === 'NO' || raw === 'FALSE' || raw === '0') return false;
  return null;
}
function unwrapData(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  if (isRecord(data.metadatos)) return data.metadatos;
  return data;
}
function normalizeReferences(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const root = isRecord(value.data) ? value.data : value;
  const analysis = isRecord(root.analisis) ? root.analisis : root;
  const references = isRecord(analysis.referencias) ? analysis.referencias : null;
  if (!references) return [];
  const output: string[] = [];
  for (const sectionName of ['anteriores', 'posteriores'] as const) {
    const section = references[sectionName];
    if (!isRecord(section)) continue;
    const entries = section[sectionName === 'anteriores' ? 'anterior' : 'posterior'];
    for (const entry of (Array.isArray(entries) ? entries : entries ? [entries] : [])) {
      if (!isRecord(entry)) continue;
      const id = fieldText(entry.id_norma) ?? '';
      const relation = fieldText(entry.relacion) ?? 'relación no clasificada';
      const detail = fieldText(entry.texto) ?? '';
      if (id && /^BOE-A-\d{4}-\d{1,8}$/.test(id)) {
        output.push([id, relation, detail].filter(Boolean).join(' — ').slice(0, 500));
      }
      if (output.length >= MAX_RELATIONS) return output;
    }
  }
  return output;
}

/**
 * Interprets only explicit BOE metadata flags. "Not marked repealed" is not a
 * legal-validity conclusion: tacit repeal, partial repeal, transitional rules,
 * regional rules and article-specific effects still require legal analysis.
 */
export function assessBoeTemporalMetadata(metadata: Record<string, unknown>, referenceDate: string, relatedNorms: readonly string[] = []): BoeTemporalEvidence {
  const effectiveDate = normalizeBoeDate(metadata.fecha_vigencia);
  const publicationDate = normalizeBoeDate(metadata.fecha_publicacion);
  const derogationDate = normalizeBoeDate(metadata.fecha_derogacion);
  const annulmentDate = normalizeBoeDate(metadata.fecha_anulacion);
  const lastRegistryUpdate = normalizeBoeDate(metadata.fecha_actualizacion);
  const derogated = affirmative(metadata.estatus_derogacion);
  const annulled = affirmative(metadata.estatus_anulacion);
  const exhausted = affirmative(metadata.vigencia_agotada);
  const consolidationStatus = fieldText(metadata.estado_consolidacion)?.toLowerCase() ?? null;
  let assessment: BoeTemporalAssessment = 'insufficient';

  if (consolidationStatus?.includes('desactualizado') || consolidationStatus?.includes('pendiente')) {
    assessment = 'consolidation_pending_update';
  } else if (annulled === true && annulmentDate && annulmentDate <= referenceDate) {
    assessment = 'annulled_by_reference_date';
  } else if (annulled === true && annulmentDate && annulmentDate > referenceDate) {
    assessment = 'annulment_after_reference_date';
  } else if (derogated === true && derogationDate && derogationDate <= referenceDate) {
    assessment = 'repealed_by_reference_date';
  } else if (derogated === true && derogationDate && derogationDate > referenceDate) {
    assessment = 'derogation_after_reference_date';
  } else if (effectiveDate && effectiveDate > referenceDate) {
    assessment = 'not_effective_yet';
  } else if (exhausted === true && !derogationDate) {
    assessment = 'exhausted_date_unknown';
  } else if (consolidationStatus?.includes('finalizado') && derogated === false && annulled === false && exhausted === false && effectiveDate && effectiveDate <= referenceDate) {
    assessment = 'not_marked_derogated_or_exhausted';
  }

  return {
    assessment, referenceDate, publicationDate, effectiveDate, derogationDate, annulmentDate,
    lastRegistryUpdate, derogated, annulled, exhausted, consolidationStatus, relatedNorms: relatedNorms.slice(0, MAX_RELATIONS),
  };
}
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    const key = code.toLowerCase();
    if (key.startsWith('#x')) {
      const point = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    }
    if (key.startsWith('#')) {
      const point = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[key] ?? entity;
  });
}
export function extractOfficialHtmlText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|template|noscript|nav|footer|header|form|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function relevantExcerpt(text: string, query: string): string {
  if (text.length <= MAX_EXCERPT_CHARS) return text;
  const words = query.toLocaleLowerCase('es').split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4).slice(0, 8);
  const lower = text.toLocaleLowerCase('es');
  const positions = words.map((word) => lower.indexOf(word)).filter((position) => position >= 0).sort((a, b) => a - b);
  if (positions.length === 0) return text.slice(0, MAX_EXCERPT_CHARS);
  const center = positions[0]!;
  const start = Math.max(0, Math.min(text.length - MAX_EXCERPT_CHARS, center - Math.floor(MAX_EXCERPT_CHARS / 4)));
  return (start > 0 ? '[…] ' : '') + text.slice(start, start + MAX_EXCERPT_CHARS) + (start + MAX_EXCERPT_CHARS < text.length ? ' […]' : '');
}

export interface OfficialDocumentFetchResponse {
  readonly body: Buffer;
  readonly contentType: string;
}
export type OfficialDocumentFetcher = (
  url: URL,
  maxBytes: number,
  timeoutMs: number,
  callerSignal?: AbortSignal,
) => Promise<OfficialDocumentFetchResponse>;
type HttpsPayload = OfficialDocumentFetchResponse;
async function requestOfficialHttps(url: URL, maxBytes: number, timeoutMs: number, callerSignal?: AbortSignal): Promise<HttpsPayload> {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !isOfficialHost(url.hostname)) {
    throw new Error('Official document URL rejected.');
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => !isPublicNetworkAddress(item.address, item.family))) {
    throw new Error('Official document DNS address rejected.');
  }
  if (callerSignal?.aborted) throw new Error('Official document request cancelled.');
  const selected = addresses[0]!;
  const pinnedLookup = ((_: string, __: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
    callback(null, selected.address, selected.family);
  }) as NonNullable<RequestOptions['lookup']>;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  return new Promise<HttpsPayload>((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      method: 'GET',
      path: url.pathname + url.search,
      headers: { Accept: 'text/html, application/xhtml+xml, application/json;q=0.9', 'User-Agent': 'PersonalBudget/0.1 official-source-evidence' },
      maxHeaderSize: 8_192,
      signal,
      lookup: pinnedLookup,
      servername: url.hostname,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 || status !== 200) {
        response.destroy();
        reject(new Error('Official source returned a non-success response.'));
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        reject(new Error('Official source response exceeded its configured limit.'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          response.destroy(new Error('Official source response exceeded its configured limit.'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        body: Buffer.concat(chunks),
        contentType: String(response.headers['content-type'] ?? '').toLowerCase(),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}
function parseJsonPayload(payload: HttpsPayload): Record<string, unknown> | null {
  if (!payload.contentType.includes('application/json')) return null;
  try {
    const parsed = JSON.parse(payload.body.toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}
function boeIdentifier(source: WebSearchSource): string | null {
  let url: URL;
  try { url = new URL(source.url); } catch { return null; }
  if (!isOfficialHost(url.hostname) || !['boe.es', 'www.boe.es'].includes(url.hostname.toLowerCase())) return null;
  const candidate = url.searchParams.get('id') ?? url.pathname.match(/\/(BOE-A-\d{4}-\d{1,8})(?:\/|$)/)?.[1] ?? '';
  return /^BOE-A-\d{4}-\d{1,8}$/.test(candidate) ? candidate : null;
}
function temporalLimitations(assessment: BoeTemporalAssessment): string[] {
  const limitations = [
    'El texto consolidado del BOE es informativo y carece de valor jurídico; para fines jurídicos debe consultarse la publicación oficial.',
    'El análisis del BOE recoge modificaciones y derogaciones expresas, no acredita por sí solo derogaciones tácitas ni la aplicación a hechos concretos.',
    'La vigencia de una norma no resuelve por sí sola el régimen transitorio, la vigencia de cada artículo ni la normativa autonómica/local aplicable.',
    'El texto HTML recuperado corresponde a la consolidación más reciente disponible; esta operación no reconstruye la redacción de cada artículo en eventDate. No atribuyas esta versión a un periodo anterior sin consultar el historial de versiones del bloque y la publicación oficial original.',
  ];
  if (assessment === 'consolidation_pending_update') limitations.push('El BOE marca la consolidación como desactualizada o pendiente; puede faltar incorporar una modificación ya publicada.');
  if (assessment === 'insufficient') limitations.push('Los metadatos oficiales recuperados no permiten clasificar temporalmente la disposición para la fecha de referencia.');
  return limitations;
}
function makeBoeTemporal(metadata: Record<string, unknown> | null, analysis: Record<string, unknown> | null, referenceDate: string): BoeTemporalEvidence | null {
  if (!metadata) return null;
  const related = normalizeReferences(analysis ?? {});
  return assessBoeTemporalMetadata(metadata, referenceDate, related);
}
function unavailableEvidence(status: OfficialDocumentStatus, documentType: OfficialDocumentEvidence['documentType']): OfficialDocumentEvidence {
  return {
    status, documentType, retrievedAt: null, contentType: null, excerpt: '', textLength: 0,
    temporal: null,
    limitations: ['No se pudo recuperar y validar el contenido de la fuente oficial. Abre el enlace original y no deduzcas vigencia a partir del snippet del buscador.'],
  };
}

/**
 * Fetches up to a bounded amount from official HTTPS hosts only. The BOE branch
 * obtains metadata and relations from its documented Open Data API and the
 * consolidated HTML version; other official hosts are treated as documentary
 * evidence only and never promoted to legal-validity metadata automatically.
 */
export async function retrieveOfficialDocument(
  source: WebSearchSource,
  query: string,
  referenceDate: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
  fetchOfficial: OfficialDocumentFetcher = requestOfficialHttps,
): Promise<OfficialDocumentEvidence> {
  let sourceUrl: URL;
  try { sourceUrl = new URL(source.url); } catch { return unavailableEvidence('unsupported', 'unsupported_format'); }
  if (!isOfficialHost(sourceUrl.hostname) || sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || sourceUrl.port || sourceUrl.hash) {
    return unavailableEvidence('unsupported', 'unsupported_format');
  }

  const id = boeIdentifier(source);
  if (id) {
    try {
      const metadataURL = new URL('/datosabiertos/api/legislacion-consolidada/id/' + id + '/metadatos', 'https://www.boe.es');
      const analysisURL = new URL('/datosabiertos/api/legislacion-consolidada/id/' + id + '/analisis', 'https://www.boe.es');
      const pageURL = new URL('/buscar/act.php?id=' + encodeURIComponent(id), 'https://www.boe.es');
      const [metadataResult, analysisResult, pageResult] = await Promise.allSettled([
        fetchOfficial(metadataURL, MAX_BOE_METADATA_BYTES, timeoutMs, callerSignal),
        fetchOfficial(analysisURL, MAX_BOE_ANALYSIS_BYTES, timeoutMs, callerSignal),
        fetchOfficial(pageURL, MAX_HTML_BYTES, timeoutMs, callerSignal),
      ]);
      const metadataPayload = metadataResult.status === 'fulfilled' ? parseJsonPayload(metadataResult.value) : null;
      const analysisPayload = analysisResult.status === 'fulfilled' ? parseJsonPayload(analysisResult.value) : null;
      const metadata = metadataPayload ? unwrapData(metadataPayload) : null;
      const htmlPayload = pageResult.status === 'fulfilled' ? pageResult.value : null;
      const htmlContentType = htmlPayload?.contentType ?? '';
      if (!htmlPayload || !(htmlContentType.includes('text/html') || htmlContentType.includes('application/xhtml+xml'))) {
        const temporal = makeBoeTemporal(metadata, analysisPayload, referenceDate);
        return {
          ...unavailableEvidence(metadata || analysisPayload ? 'partial' : 'unavailable', 'boe_consolidated_legislation'),
          ...(temporal ? { retrievedAt: new Date().toISOString(), temporal, limitations: temporalLimitations(temporal.assessment).concat(
            'No se pudo recuperar el texto consolidado HTML; consulta la publicación oficial y el enlace original.',
          ) } : {}),
        };
      }
      const fullText = extractOfficialHtmlText(htmlPayload.body.toString('utf8'));
      if (!fullText) return unavailableEvidence('partial', 'boe_consolidated_legislation');
      const temporal = makeBoeTemporal(metadata, analysisPayload, referenceDate);
      const status: OfficialDocumentStatus = metadata && analysisPayload ? 'retrieved' : 'partial';
      return {
        status, documentType: 'boe_consolidated_legislation', retrievedAt: new Date().toISOString(),
        contentType: htmlContentType, excerpt: relevantExcerpt(fullText, query), textLength: fullText.length,
        temporal,
        limitations: temporal ? temporalLimitations(temporal.assessment) : [
          'Se recuperó el texto consolidado, pero no se pudieron validar todos los metadatos temporales del BOE.',
          'El texto consolidado del BOE es informativo, no sustituye a la publicación oficial ni cubre derogaciones tácitas.',
          'El texto HTML recuperado corresponde a la consolidación más reciente disponible; esta operación no reconstruye la redacción de cada artículo en eventDate. No atribuyas esta versión a un periodo anterior sin consultar el historial de versiones del bloque y la publicación oficial original.',
        ],
      };
    } catch {
      return unavailableEvidence('unavailable', 'boe_consolidated_legislation');
    }
  }

  try {
    const payload = await fetchOfficial(sourceUrl, MAX_HTML_BYTES, timeoutMs, callerSignal);
    if (!(payload.contentType.includes('text/html') || payload.contentType.includes('application/xhtml+xml') || payload.contentType.includes('text/plain'))) {
      return unavailableEvidence('unsupported', 'unsupported_format');
    }
    const fullText = payload.contentType.includes('text/plain')
      ? payload.body.toString('utf8').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()
      : extractOfficialHtmlText(payload.body.toString('utf8'));
    if (!fullText) return unavailableEvidence('partial', 'official_html');
    return {
      status: 'retrieved', documentType: 'official_html', retrievedAt: new Date().toISOString(),
      contentType: payload.contentType, excerpt: relevantExcerpt(fullText, query), textLength: fullText.length,
      temporal: null,
      limitations: ['El contenido oficial se ha recuperado, pero no existe una comprobación temporal estructurada para este tipo de documento. La fecha y fuerza del criterio deben leerse en el original.'],
    };
  } catch {
    return unavailableEvidence('unavailable', 'official_html');
  }
}
