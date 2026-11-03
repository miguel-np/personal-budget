import { createHash } from 'node:crypto';
import type { WebSearchSource } from './web-search.js';

export type MaterialClaimKind = 'evidence_located' | 'unresolved';
export type MaterialClaimClassification = 'documented_fact' | 'interpretation' | 'case_dependent' | 'unclassified';
export type EvidenceSourceClass =
  | 'official_publication' | 'informative_consolidation' | 'dgt_doctrine' | 'teac_criteria'
  | 'administrative_guidance' | 'administrative_information' | 'official_information'
  | 'legislation_source_unclassified' | 'external';
export type PrimaryPublicationStatus =
  | 'cited_with_excerpt' | 'cited_without_excerpt' | 'available_not_cited'
  | 'not_located_in_results' | 'not_required';
export type ClaimEvidenceStatus =
  | 'excerpt_matched'
  | 'excerpt_not_found'
  | 'document_not_retrieved'
  | 'quote_not_provided';

export interface ClaimSourceReference {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly sourceKind: WebSearchSource['sourceKind'];
  readonly sourceAuthority: WebSearchSource['sourceAuthority'];
  readonly evidenceClass: EvidenceSourceClass;
  /** Dates reported by the search provider; they are not legal effective dates. */
  readonly publishedAt: string | null;
  readonly modifiedAt: string | null;
  readonly documentStatus: 'retrieved' | 'partial' | 'unavailable' | 'unsupported' | null;
  readonly documentType: 'boe_consolidated_legislation' | 'official_html' | 'unsupported_format' | null;
  readonly temporalAssessment: string | null;
  readonly evidenceStatus: ClaimEvidenceStatus;
  readonly quote: string | null;
  readonly locator: string | null;
  readonly locatorVerified: boolean;
}

export interface ModelReportedConflict {
  readonly status: 'reported_with_fragments' | 'unverified';
  readonly sourceIds: readonly [string, string];
  readonly reason: string;
}

export interface ClaimPrimaryPublication {
  readonly status: PrimaryPublicationStatus;
  /** IDs of official-publication results relevant to this claim. */
  readonly sourceIds: readonly string[];
}

export interface MaterialClaim {
  readonly id: string;
  readonly text: string;
  /** Model-proposed classification, never a backend legal verification. */
  readonly classification: MaterialClaimClassification;
  readonly kind: MaterialClaimKind;
  readonly sourceRefs: readonly ClaimSourceReference[];
  readonly unresolvedReferences: readonly string[];
  readonly conflicts: readonly ModelReportedConflict[];
  readonly primaryPublication: ClaimPrimaryPublication;
  readonly reviewRequired: true;
}

export interface ClaimEvidence {
  readonly claims: readonly MaterialClaim[];
  readonly limitations: readonly string[];
}

interface EvidenceMarker {
  readonly sourceId: string;
  readonly locator: string | null;
  readonly quote: string;
}
interface ConflictMarker {
  readonly firstSourceId: string;
  readonly secondSourceId: string;
  readonly reason: string;
}
interface EvidenceText {
  readonly text: string;
  readonly locator: string | null;
  readonly kind: 'document_excerpt' | 'historical_block';
}

const REFERENCE_PATTERN = /\[S(\d+)\]/g;
const EVIDENCE_MARKER_PATTERN = /\[\[EVIDENCE\|S(\d+)\|([^|\]\r\n]{0,160})\|([^\]\r\n]{20,500})\]\]/g;
const CONFLICT_MARKER_PATTERN = /\[\[CONFLICT\|S(\d+)\|S(\d+)\|([^\]\r\n]{10,300})\]\]/g;
const CLAIM_MARKER_PATTERN = /\[\[CLAIM\|([a-z_]{1,32})\]\]/g;
const MAX_CLAIMS = 60;
const MAX_CLAIM_CHARS = 2_000;

function splitClaims(answer: string): string[] {
  const claims: string[] = [];
  for (const line of answer.split(/\r?\n+/)) {
    const normalized = line.replace(/^\s*(?:[-*•]+\s+|\d+[.)]\s+)/, '').replace(/^#{1,6}\s+/, '').trim();
    if (!normalized) continue;
    // One assertion per line gives source/evidence markers an unambiguous scope.
    claims.push(normalized.slice(0, MAX_CLAIM_CHARS));
    if (claims.length >= MAX_CLAIMS) return claims;
  }
  return claims;
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('es');
}

function sourceEvidenceTexts(source: WebSearchSource): EvidenceText[] {
  const document = source.document;
  if (!document || (document.status !== 'retrieved' && document.status !== 'partial')) return [];

  const records: EvidenceText[] = [];
  if (document.excerpt.trim()) {
    records.push({ text: document.excerpt, locator: null, kind: 'document_excerpt' });
  }
  for (const block of document.historical?.blocks ?? []) {
    // Only a version selected by the backend's bounded BOE history evaluator can
    // be used as historical block evidence. Other versions remain contextual data.
    if (block.status === 'selected' && block.text?.trim()) {
      records.push({ text: block.text, locator: block.title, kind: 'historical_block' });
    }
  }
  return records;
}

function parseEvidenceMarkers(text: string): EvidenceMarker[] {
  return [...text.matchAll(EVIDENCE_MARKER_PATTERN)].map((match) => ({
    sourceId: 'S' + match[1]!,
    locator: match[2]!.trim() || null,
    quote: match[3]!.trim(),
  }));
}

function parseConflictMarkers(text: string): ConflictMarker[] {
  return [...text.matchAll(CONFLICT_MARKER_PATTERN)].map((match) => ({
    firstSourceId: 'S' + match[1]!,
    secondSourceId: 'S' + match[2]!,
    reason: match[3]!.trim(),
  }));
}

function sourceReference(
  source: WebSearchSource,
  markers: readonly EvidenceMarker[],
): ClaimSourceReference {
  const base = {
    id: source.id,
    title: source.title,
    url: source.url,
    domain: source.domain,
    sourceKind: source.sourceKind,
    sourceAuthority: source.sourceAuthority,
    evidenceClass: evidenceClassForSource(source),
    publishedAt: source.publishedAt,
    modifiedAt: source.modifiedAt,
    documentStatus: source.document?.status ?? null,
    documentType: source.document?.documentType ?? null,
    temporalAssessment: source.document?.temporal?.assessment ?? null,
  };
  const records = sourceEvidenceTexts(source);
  const sourceMarkers = markers.filter((candidate) => candidate.sourceId === source.id);
  if (sourceMarkers.length === 0) {
    return {
      ...base,
      evidenceStatus: records.length > 0 ? 'quote_not_provided' : 'document_not_retrieved',
      quote: null, locator: null, locatorVerified: false,
    };
  }

  if (sourceMarkers.length !== 1) {
    return {
      ...base,
      evidenceStatus: 'excerpt_not_found', quote: null, locator: null, locatorVerified: false,
    };
  }
  const marker = sourceMarkers[0]!;
  const quote = normalizeEvidenceText(marker.quote);
  const matchingRecords = records.filter((record) =>
    quote.length >= 20 && normalizeEvidenceText(record.text).includes(quote));
  const requestedBlock = marker.locator
    ? matchingRecords.find((record) => record.kind === 'historical_block' &&
      record.locator !== null && normalizeEvidenceText(record.locator) === normalizeEvidenceText(marker.locator!))
    : undefined;
  const match = requestedBlock ?? matchingRecords[0];
  if (!match) {
    return {
      ...base,
      evidenceStatus: records.length > 0 ? 'excerpt_not_found' : 'document_not_retrieved',
      quote: null, locator: marker.locator, locatorVerified: false,
    };
  }

  const requestedLocator = marker.locator;
  // Only a title returned by the backend's BOE block evaluator is a verified
  // locator. A model-proposed HTML locator is displayed but not trusted.
  const backendLocatorVerified = match.kind === 'historical_block' && Boolean(match.locator);
  return {
    ...base,
    evidenceStatus: 'excerpt_matched',
    quote: marker.quote,
    locator: backendLocatorVerified ? match.locator : requestedLocator,
    locatorVerified: backendLocatorVerified,
  };
}

function parseClaimClassification(text: string): MaterialClaimClassification {
  const markers = [...text.matchAll(CLAIM_MARKER_PATTERN)];
  if (markers.length !== 1) return 'unclassified';
  const value = markers[0]![1];
  return value === 'documented_fact' || value === 'interpretation' || value === 'case_dependent'
    ? value : 'unclassified';
}

function isOfficialPublication(source: WebSearchSource): boolean {
  if (source.sourceAuthority !== 'legislation' ||
    source.document?.documentType === 'boe_consolidated_legislation') return false;
  let url: URL;
  try { url = new URL(source.url); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const boePublication = (host === 'boe.es' || host === 'www.boe.es') &&
    (/^\/diario_boe\//.test(url.pathname) || /^\/eli\//.test(url.pathname));
  const dogPublication = (host === 'xunta.gal' || host === 'www.xunta.gal') &&
    /^\/(?:es\/)?diario-oficial-galicia(?:\/|$)/i.test(url.pathname);
  return boePublication || dogPublication;
}

function evidenceClassForSource(source: WebSearchSource): EvidenceSourceClass {
  if (source.document?.documentType === 'boe_consolidated_legislation' ||
    source.sourceAuthority === 'legal_consolidation') return 'informative_consolidation';
  switch (source.sourceAuthority) {
    case 'legislation': return isOfficialPublication(source) ? 'official_publication' : 'legislation_source_unclassified';
    case 'dgt_criteria': return 'dgt_doctrine';
    case 'teac_criteria': return 'teac_criteria';
    case 'tax_agency_guidance': return 'administrative_guidance';
    case 'tax_administration': return 'administrative_information';
    case 'official_information': return 'official_information';
    case 'external': return 'external';
    default: return 'external';
  }
}

function primaryPublicationForClaim(
  sources: readonly WebSearchSource[],
  citationIds: readonly string[],
  references: readonly ClaimSourceReference[],
  required: boolean,
): ClaimPrimaryPublication {
  if (!required) return { status: 'not_required', sourceIds: [] };
  const primarySources = sources.filter(isOfficialPublication);
  if (primarySources.length === 0) return { status: 'not_located_in_results', sourceIds: [] };
  const cited = primarySources.filter((source) => citationIds.includes(source.id));
  if (cited.length === 0) {
    return { status: 'available_not_cited', sourceIds: primarySources.map((source) => source.id) };
  }
  const evidenceById = new Map(references.map((reference) => [reference.id, reference]));
  const allCitedHaveExcerpts = cited.every((source) =>
    evidenceById.get(source.id)?.evidenceStatus === 'excerpt_matched');
  return {
    status: allCitedHaveExcerpts ? 'cited_with_excerpt' : 'cited_without_excerpt',
    sourceIds: primarySources.map((source) => source.id),
  };
}

/**
 * Builds auditable, claim-level references from model markers. A matched fragment
 * proves only that the quoted text occurs in the retrieved extract; it does not
 * establish semantic entailment, source authority, legal validity or applicability.
 */
export interface ClaimEvidenceOptions {
  /** Require an official primary-publication result for tax/normative research. */
  readonly requirePrimaryPublication?: boolean;
}

export function buildClaimEvidence(
  answerWithMarkers: string,
  sources: readonly WebSearchSource[],
  options: ClaimEvidenceOptions = {},
): ClaimEvidence {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const claims = splitClaims(answerWithMarkers).map((rawText, index): MaterialClaim => {
    const classification = parseClaimClassification(rawText);
    const visibleText = rawText
      .replace(EVIDENCE_MARKER_PATTERN, '')
      .replace(CONFLICT_MARKER_PATTERN, '')
      .replace(CLAIM_MARKER_PATTERN, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    const citationIds = [...new Set([...rawText.matchAll(REFERENCE_PATTERN)].map((match) => 'S' + match[1]!))];
    const evidenceMarkers = parseEvidenceMarkers(rawText);
    const conflictMarkers = parseConflictMarkers(rawText);
    const allIds = [...new Set([
      ...citationIds,
      ...evidenceMarkers.map((marker) => marker.sourceId),
      ...conflictMarkers.flatMap((marker) => [marker.firstSourceId, marker.secondSourceId]),
    ])];

    const unresolvedReferences = allIds
      .filter((id) => !sourceById.has(id))
      .map((id) => '[' + id + ']');
    for (const marker of evidenceMarkers) {
      if (!citationIds.includes(marker.sourceId) && sourceById.has(marker.sourceId)) {
        unresolvedReferences.push('[' + marker.sourceId + '] (falta la cita visible)');
      }
    }
    for (const marker of conflictMarkers) {
      for (const id of [marker.firstSourceId, marker.secondSourceId]) {
        if (!citationIds.includes(id) && sourceById.has(id)) {
          unresolvedReferences.push('[' + id + '] (falta la cita visible para la discrepancia)');
        }
      }
    }

    const references = allIds.flatMap((id): ClaimSourceReference[] => {
      const source = sourceById.get(id);
      return source ? [sourceReference(source, evidenceMarkers)] : [];
    });
    const allFragmentsMatched = references.length > 0 &&
      references.every((reference) => reference.evidenceStatus === 'excerpt_matched') &&
      unresolvedReferences.length === 0;
    const conflicts = conflictMarkers.map((marker): ModelReportedConflict => {
      const first = references.find((reference) => reference.id === marker.firstSourceId);
      const second = references.find((reference) => reference.id === marker.secondSourceId);
      return {
        status: marker.firstSourceId !== marker.secondSourceId &&
          citationIds.includes(marker.firstSourceId) && citationIds.includes(marker.secondSourceId) &&
          first?.evidenceStatus === 'excerpt_matched' && second?.evidenceStatus === 'excerpt_matched'
          ? 'reported_with_fragments' : 'unverified',
        sourceIds: [marker.firstSourceId, marker.secondSourceId],
        reason: marker.reason.slice(0, 300),
      };
    });
    const primaryPublication = primaryPublicationForClaim(
      sources, citationIds, references, options.requirePrimaryPublication === true,
    );
    const normalized = visibleText.replace(REFERENCE_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
    const id = 'claim-' + createHash('sha256').update(String(index + 1) + ':' + normalized).digest('hex').slice(0, 12);
    return {
      id,
      text: visibleText,
      classification,
      // Any reported conflict remains unresolved even when both literal fragments exist.
      kind: allFragmentsMatched && conflicts.length === 0 ? 'evidence_located' : 'unresolved',
      sourceRefs: references,
      unresolvedReferences: [...new Set(unresolvedReferences)],
      conflicts,
      primaryPublication,
      reviewRequired: true,
    };
  });

  return {
    claims,
    limitations: [
      'Un fragmento localizado demuestra únicamente que el texto citado aparece en el extracto recuperado; no demuestra que la fuente implique semánticamente la afirmación ni que la interpretación sea correcta.',
      'Los localizadores propuestos por el modelo solo se muestran como verificados cuando aparecen en el extracto; en los bloques históricos BOE se utiliza el título del bloque seleccionado por el backend.',
      'Las discrepancias son hipótesis señaladas por el modelo y acompañadas de fragmentos localizados; el backend no decide si existe contradicción jurídica ni resuelve jerarquía, vigencia o aplicabilidad.',
      'La clasificación de cada afirmación es una propuesta del modelo local, no una comprobación del backend ni una revisión jurídica.',
      'La clase de fuente se deriva de la procedencia y de rutas institucionales conocidas; no acredita por sí sola el rango, autenticidad material o fuerza vinculante del documento.',
      'La búsqueda no es exhaustiva: que una publicación primaria no aparezca entre los resultados devueltos no demuestra que no exista.',
      'La recuperación y búsqueda no garantizan exhaustividad ni sustituyen la publicación primaria. Todas las afirmaciones requieren revisión humana; la evidencia insuficiente debe permanecer explícita.',
    ],
  };
}
