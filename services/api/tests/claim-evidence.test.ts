import { describe, expect, it } from 'vitest';
import { buildClaimEvidence } from '../src/claim-evidence.js';
import type { WebSearchSource } from '../src/web-search.js';

const excerpt = 'Artículo 32. La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.';
const source = (id: string, text = excerpt): WebSearchSource => ({
  id,
  title: 'Ley publicada',
  url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-1',
  domain: 'www.boe.es',
  institution: 'BOE',
  publishedAt: null,
  modifiedAt: null,
  snippet: 'Fragmento del buscador que no debe probar una afirmación.',
  sourceKind: 'normativa',
  sourceAuthority: 'legislation',
  document: {
    status: 'retrieved',
    documentType: 'official_html',
    retrievedAt: '2026-11-03T08:00:00.000Z',
    contentType: 'text/html',
    excerpt: text,
    textLength: text.length,
    temporal: null,
    historical: null,
    fetches: [],
    limitations: [],
  },
});

describe('claim-to-source evidence', () => {
  it('matches a verbatim quote and verifies a locator found in the recovered document', () => {
    const result = buildClaimEvidence(
      'La regla se recoge en el artículo citado [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [source('S1')],
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      kind: 'evidence_located',
      sourceRefs: [{
        id: 'S1',
        evidenceStatus: 'excerpt_matched',
        quote: 'La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.',
        locator: 'Artículo 32',
        locatorVerified: true,
      }],
      unresolvedReferences: [],
      conflicts: [],
      reviewRequired: true,
    });
    expect(result.claims[0]?.text).not.toContain('[[EVIDENCE');
  });

  it('marks a reference unresolved when a retrieved document does not contain the supplied quote', () => {
    const result = buildClaimEvidence(
      'La norma impone una sanción [S1] [[EVIDENCE|S1|Artículo 32|La Administración impondrá siempre una sanción económica inmediata.]]',
      [source('S1')],
    );
    expect(result.claims[0]).toMatchObject({
      kind: 'unresolved',
      sourceRefs: [{ evidenceStatus: 'excerpt_not_found', quote: null }],
    });
  });

  it('does not treat a search snippet as documentary evidence when no document was retrieved', () => {
    const noDocument = { ...source('S1'), document: undefined };
    const result = buildClaimEvidence(
      'La fuente confirma la obligación [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica.]]',
      [noDocument],
    );
    expect(result.claims[0]).toMatchObject({
      kind: 'unresolved',
      sourceRefs: [{ evidenceStatus: 'document_not_retrieved', quote: null }],
    });
  });

  it('requires an explicit quote for each cited source', () => {
    const result = buildClaimEvidence('La norma se publicó [S1].', [source('S1')]);
    expect(result.claims[0]).toMatchObject({
      kind: 'unresolved',
      sourceRefs: [{ evidenceStatus: 'quote_not_provided' }],
    });
  });

  it('marks invented source references as unresolved', () => {
    const result = buildClaimEvidence('El artículo establece una obligación [S99].', [source('S1')]);
    expect(result.claims[0]).toMatchObject({
      kind: 'unresolved',
      sourceRefs: [],
      unresolvedReferences: ['[S99]'],
    });
  });

  it('surfaces a model-reported discrepancy only when both source excerpts can be located', () => {
    const second = source('S2', 'Artículo 32. La Administración no ampliará los plazos por incidencias técnicas.');
    const result = buildClaimEvidence(
      'Las versiones expresan reglas distintas [S1] [S2] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]] [[EVIDENCE|S2|Artículo 32|La Administración no ampliará los plazos por incidencias técnicas.]] [[CONFLICT|S1|S2|Los textos recuperados expresan reglas opuestas sobre la ampliación del plazo.]]',
      [source('S1'), second],
    );
    expect(result.claims[0]).toMatchObject({
      kind: 'evidence_located',
      conflicts: [{
        status: 'reported_with_fragments',
        sourceIds: ['S1', 'S2'],
      }],
    });
    expect(result.limitations.join(' ')).toContain('no decide si existe contradicción jurídica');
  });

  it('keeps the output deterministic and disclaims semantic entailment validation', () => {
    const answer = 'Conclusión basada en un texto publicado [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]';
    expect(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id)
      .toBe(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id);
    expect(buildClaimEvidence(answer, [source('S1')]).limitations.join(' '))
      .toContain('no demuestra que la fuente implique semánticamente');
  });
});
