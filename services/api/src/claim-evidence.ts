import { createHash } from 'node:crypto';
import type { WebSearchSource } from './web-search.js';

export type MaterialClaimKind = 'interpretation' | 'unresolved';

export interface ClaimSourceReference {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly sourceKind: WebSearchSource['sourceKind'];
  readonly sourceAuthority: WebSearchSource['sourceAuthority'];
}

export interface MaterialClaim {
  readonly id: string;
  readonly text: string;
  readonly kind: MaterialClaimKind;
  readonly sourceRefs: readonly ClaimSourceReference[];
  readonly unresolvedReferences: readonly string[];
  readonly locator: null;
  readonly reviewRequired: true;
}

export interface ClaimEvidence {
  readonly claims: readonly MaterialClaim[];
  readonly limitations: readonly string[];
}

const REFERENCE_PATTERN = new RegExp("\\[S(\\d+)\\]", 'g');
const MAX_CLAIMS = 60;
const MAX_CLAIM_CHARS = 2_000;

function splitClaims(answer: string): string[] {
  const claims: string[] = [];
  for (const line of answer.split(/\r?\n+/)) {
    const normalized = line.replace(/^\s*(?:[-*•]+\s+|\d+[.)]\s+)/, '').replace(/^#{1,6}\s+/, '').trim();
    if (!normalized) continue;
    const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÜÑ0-9¿¡])/u);
    for (const sentence of sentences) {
      const text = sentence.trim();
      if (text) claims.push(text.slice(0, MAX_CLAIM_CHARS));
      if (claims.length >= MAX_CLAIMS) return claims;
    }
  }
  return claims;
}

/**
 * Maps citations that the model placed in each sentence to source records returned
 * by the backend. This validates reference existence only; it does not prove that
 * a document semantically entails a claim or that the legal conclusion is correct.
 */
export function buildClaimEvidence(answer: string, sources: readonly WebSearchSource[]): ClaimEvidence {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const claims = splitClaims(answer).map((text, index): MaterialClaim => {
    const references = [...text.matchAll(REFERENCE_PATTERN)].map((match) => '[S' + match[1] + ']');
    const uniqueReferences = [...new Set(references)];
    const sourceIds = uniqueReferences.map((reference) => reference.slice(1, -1));
    const sourceRefs = sourceIds.flatMap((id): ClaimSourceReference[] => {
      const source = sourceById.get(id);
      return source ? [{
        id: source.id,
        title: source.title,
        url: source.url,
        domain: source.domain,
        sourceKind: source.sourceKind,
        sourceAuthority: source.sourceAuthority,
      }] : [];
    });
    const unresolvedReferences = uniqueReferences.filter((reference) => !sourceById.has(reference.slice(1, -1)));
    const normalized = text.replace(REFERENCE_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
    const id = 'claim-' + createHash('sha256').update(String(index + 1) + ':' + normalized).digest('hex').slice(0, 12);
    return {
      id,
      text,
      kind: sourceRefs.length > 0 && unresolvedReferences.length === 0 ? 'interpretation' : 'unresolved',
      sourceRefs,
      unresolvedReferences,
      locator: null,
      reviewRequired: true,
    };
  });
  return {
    claims,
    limitations: [
      'La asociación de citas valida que cada ID existe en el conjunto de fuentes de esta respuesta; no verifica que el documento respalde semánticamente la afirmación.',
      'Las afirmaciones citadas se clasifican como interpretación generada, no como hechos jurídicos probados. Requieren contraste humano con la publicación primaria y el supuesto aplicable.',
      'Las afirmaciones sin una referencia válida quedan marcadas como no resueltas. No se generan localizadores de artículo, bloque o página que la fuente no haya proporcionado.',
    ],
  };
}
