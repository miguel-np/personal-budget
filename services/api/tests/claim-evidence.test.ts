import { describe, expect, it } from 'vitest';
import { buildClaimEvidence } from '../src/claim-evidence.js';
import type { WebSearchSource } from '../src/web-search.js';

const source = (id: string): WebSearchSource => ({
  id, title: 'Ley publicada', url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-1',
  domain: 'www.boe.es', institution: 'BOE', publishedAt: null, modifiedAt: null,
  snippet: 'Texto publicado.', sourceKind: 'normativa', sourceAuthority: 'legislation',
});

describe('claim-to-source traceability', () => {
  it('maps only valid references attached to each sentence', () => {
    const result = buildClaimEvidence('La norma se publicó [S1]. La fecha aplicable no está acreditada.', [source('S1')]);
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]).toMatchObject({
      kind: 'interpretation',
      sourceRefs: [{ id: 'S1', sourceAuthority: 'legislation' }],
      unresolvedReferences: [],
      locator: null,
      reviewRequired: true,
    });
    expect(result.claims[1]).toMatchObject({
      kind: 'unresolved', sourceRefs: [], unresolvedReferences: [], reviewRequired: true,
    });
  });

  it('marks invented or missing source references as unresolved', () => {
    const result = buildClaimEvidence('El artículo establece una obligación [S99].', [source('S1')]);
    expect(result.claims[0]).toMatchObject({
      kind: 'unresolved', sourceRefs: [], unresolvedReferences: ['[S99]'],
    });
  });

  it('preserves distinct references and identifies mixed valid/invalid citations', () => {
    const result = buildClaimEvidence('Las fuentes difieren [S1] [S2] [S88].', [source('S1'), {
      ...source('S2'), sourceKind: 'organismo_oficial', sourceAuthority: 'official_information',
    }]);
    expect(result.claims[0]?.sourceRefs.map((item) => item.id)).toEqual(['S1', 'S2']);
    expect(result.claims[0]?.unresolvedReferences).toEqual(['[S88]']);
    expect(result.claims[0]?.kind).toBe('unresolved');
  });

  it('uses deterministic IDs and explicitly disclaims semantic entailment validation', () => {
    const answer = 'Conclusión basada en un texto publicado [S1].';
    expect(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id)
      .toBe(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id);
    expect(buildClaimEvidence(answer, [source('S1')]).limitations.join(' '))
      .toContain('no verifica que el documento respalde semánticamente');
  });
});
