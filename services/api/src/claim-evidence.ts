import { createHash } from 'node:crypto';
import type { WebSearchSource } from './web-search.js';

export type MaterialClaimKind = 'evidence_located' | 'unresolved';
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

export interface MaterialClaim {
  readonly id: string;
  readonly text: string;
  readonly kind: MaterialClaimKind;
  readonly sourceRefs: readonly ClaimSourceReference[];
  readonly unresolvedReferences: readonly string[];
  readonly conflicts: readonly ModelReportedConflict[];
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
    sourceId: match[1]!,
    locator: match[2]!.trim() || null,
    quote: match[3]!.trim(),
  }));
}

function parseConflictMarkers(text: string): ConflictMarker[] {
  return [...text.matchAll(CONFLICT_MARKER_PATTERN)].map((match) => ({
    firstSourceId: match[1]!,
    secondSourceId: match[2]!,
    reason: match[3]!.trim(),
  }));
}

function sourceReference(
  source: WebSearchSource,
  markers: readonly EvidenceMarker[],
): ClaimSourceReference {
  const records = sourceEvidenceTexts(source);
  const sourceMarkers = markers.filter((candidate) => candidate.sourceId === source.id);
  if (sourceMarkers.length === 0) {
    return {
      id: source.id, title: source.title, url: source.url, domain: source.domain,
      sourceKind: source.sourceKind, sourceAuthority: source.sourceAuthority,
      evidenceStatus: records.length > 0 ? 'quote_not_provided' : 'document_not_retrieved',
      quote: null, locator: null, locatorVerified: false,
    };
  }

  if (sourceMarkers.length !== 1) {
    return {
      id: source.id, title: source.title, url: source.url, domain: source.domain,
      sourceKind: source.sourceKind, sourceAuthority: source.sourceAuthority,
      evidenceStatus: 'excerpt_not_found', quote: null, locator: null, locatorVerified: false,
    };
  }
  const marker = sourceMarkers[0]!;
  const quote = normalizeEvidenceText(marker.quote);
  const match = records.find((record) => quote.length >= 20 && normalizeEvidenceText(record.text).includes(quote));
  if (!match) {
    return {
      id: source.id, title: source.title, url: source.url, domain: source.domain,
      sourceKind: source.sourceKind, sourceAuthority: source.sourceAuthority,
      evidenceStatus: records.length > 0 ? 'excerpt_not_found' : 'document_not_retrieved',
      quote: null, locator: marker.locator, locatorVerified: false,
    };
  }

  const requestedLocator = marker.locator;
  // Only a title returned by the backend's BOE block evaluator is a verified
  // locator. A model-proposed HTML locator is displayed but not trusted.
  const backendLocatorVerified = match.kind === 'historical_block' && Boolean(match.locator);
  return {
    id: source.id, title: source.title, url: source.url, domain: source.domain,
    sourceKind: source.sourceKind, sourceAuthority: source.sourceAuthority,
    evidenceStatus: 'excerpt_matched',
    quote: marker.quote,
    locator: backendLocatorVerified ? match.locator : requestedLocator,
    locatorVerified: backendLocatorVerified,
  };
}

/**
 * Builds auditable, claim-level references from model markers. A matched fragment
 * proves only that the quoted text occurs in the retrieved extract; it does not
 * establish semantic entailment, source authority, legal validity or applicability.
 */
export function buildClaimEvidence(answerWithMarkers: string, sources: readonly WebSearchSource[]): ClaimEvidence {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const claims = splitClaims(answerWithMarkers).map((rawText, index): MaterialClaim => {
    const visibleText = rawText
      .replace(EVIDENCE_MARKER_PATTERN, '')
      .replace(CONFLICT_MARKER_PATTERN, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    const citationIds = [...new Set([...rawText.matchAll(REFERENCE_PATTERN)].map((match) => match[1]!))];
    const evidenceMarkers = parseEvidenceMarkers(rawText);
    const conflictMarkers = parseConflictMarkers(rawText);
    const allIds = [...new Set([
      ...citationIds,
      ...evidenceMarkers.map((marker) => marker.sourceId),
      ...conflictMarkers.flatMap((marker) => [marker.firstSourceId, marker.secondSourceId]),
    ])];

    const unresolvedReferences = allIds
      .filter((id) => !sourceById.has(id))
      .map((id) => '[S' + id + ']');
    for (const marker of evidenceMarkers) {
      if (!citationIds.includes(marker.sourceId) && sourceById.has(marker.sourceId)) {
        unresolvedReferences.push('[S' + marker.sourceId + '] (falta la cita visible)');
      }
    }
    for (const marker of conflictMarkers) {
      for (const id of [marker.firstSourceId, marker.secondSourceId]) {
        if (!citationIds.includes(id) && sourceById.has(id)) {
          unresolvedReferences.push('[S' + id + '] (falta la cita visible para la discrepancia)');
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
    const normalized = visibleText.replace(REFERENCE_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
    const id = 'claim-' + createHash('sha256').update(String(index + 1) + ':' + normalized).digest('hex').slice(0, 12);
    return {
      id,
      text: visibleText,
      // Any reported conflict remains unresolved even when both literal fragments exist.
      kind: allFragmentsMatched && conflicts.length === 0 ? 'evidence_located' : 'unresolved',
      sourceRefs: references,
      unresolvedReferences: [...new Set(unresolvedReferences)],
      conflicts,
      reviewRequired: true,
    };
  });

  return {
    claims,
    limitations: [
      'Un fragmento localizado demuestra únicamente que el texto citado aparece en el extracto recuperado; no demuestra que la fuente implique semánticamente la afirmación ni que la interpretación sea correcta.',
      'Los localizadores propuestos por el modelo solo se muestran como verificados cuando aparecen en el extracto; en los bloques históricos BOE se utiliza el título del bloque seleccionado por el backend.',
      'Las discrepancias son hipótesis señaladas por el modelo y acompañadas de fragmentos localizados; el backend no decide si existe contradicción jurídica ni resuelve jerarquía, vigencia o aplicabilidad.',
      'La recuperación y búsqueda no garantizan exhaustividad ni sustituyen la publicación primaria. Todas las afirmaciones requieren revisión humana; la evidencia insuficiente debe permanecer explícita.',
    ],
  };
}
