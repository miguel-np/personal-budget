import { describe, expect, it } from 'vitest';
import { buildClaimEvidence } from '../src/claim-evidence.js';
import type { WebSearchSource } from '../src/web-search.js';

const excerpt = 'Artículo 32. La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.';
const source = (id: string, text = excerpt, withDocument = true): WebSearchSource => ({
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
  ...(withDocument ? { document: {
    status: 'retrieved' as const,
    documentType: 'official_html' as const,
    retrievedAt: '2026-11-03T08:00:00.000Z',
    contentType: 'text/html',
    excerpt: text,
    textLength: text.length,
    temporal: null,
    historical: null,
    fetches: [],
    limitations: [],
  } } : {}),
});

describe('claim-to-source evidence', () => {
  it('marks a primary official publication only when its journal route is cited with a located fragment', () => {
    const result = buildClaimEvidence(
      'La disposición establece la regla [S1] [[EVIDENCE|S1||La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [source('S1')],
      { requirePrimaryPublication: true },
    );
    expect(result.claims[0]?.primaryPublication).toEqual({
      status: 'cited_with_excerpt',
      sourceIds: ['S1'],
    });
    expect(result.claims[0]?.sourceRefs[0]?.evidenceClass).toBe('official_publication');
  });

  it('keeps model classification separate from deterministic evidence status', () => {
    const classified = buildClaimEvidence(
      'El documento expresa el requisito [S1] [[CLAIM|documented_fact]] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [source('S1')],
    );
    expect(classified.claims[0]).toMatchObject({
      classification: 'documented_fact',
      kind: 'evidence_located',
    });
    expect(classified.claims[0]?.text).not.toContain('[[CLAIM');

    const unmarked = buildClaimEvidence('La regla parece aplicable [S1].', [source('S1')]);
    expect(unmarked.claims[0]?.classification).toBe('unclassified');
  });

  it('warns when a primary publication is returned but the claim cites only an informative consolidation', () => {
    const primary = source('S1');
    const consolidation: WebSearchSource = {
      ...source('S2'),
      url: 'https://www.lex.gal/norma/consolidada',
      domain: 'www.lex.gal',
      institution: 'Lex.gal',
      sourceKind: 'normativa_consolidada_informativa',
      sourceAuthority: 'legal_consolidation',
    };
    const result = buildClaimEvidence(
      'La guía consolidada explica la regla [S2] [[CLAIM|interpretation]] [[EVIDENCE|S2|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [primary, consolidation],
      { requirePrimaryPublication: true },
    );
    expect(result.claims[0]?.primaryPublication).toEqual({
      status: 'available_not_cited',
      sourceIds: ['S1'],
    });
    expect(result.claims[0]?.sourceRefs[0]).toMatchObject({
      evidenceClass: 'informative_consolidation',
      documentType: 'official_html',
      documentStatus: 'retrieved',
    });
  });

  it('reports an absent primary publication conservatively when it is not in search results', () => {
    const onlySecondary: WebSearchSource = {
      ...source('S2'),
      url: 'https://www.lex.gal/norma/consolidada',
      domain: 'www.lex.gal',
      institution: 'Lex.gal',
      sourceKind: 'normativa_consolidada_informativa',
      sourceAuthority: 'legal_consolidation',
    };
    const result = buildClaimEvidence(
      'La regla se encuentra en la consolidación [S2] [[EVIDENCE|S2||La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [onlySecondary],
      { requirePrimaryPublication: true },
    );
    expect(result.claims[0]?.primaryPublication.status).toBe('not_located_in_results');
  });

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
        locatorVerified: false,
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
    const noDocument = source('S1', excerpt, false);
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
      kind: 'unresolved',
      conflicts: [{
        status: 'reported_with_fragments',
        sourceIds: ['S1', 'S2'],
      }],
    });
    expect(result.limitations.join(' ')).toContain('no decide si existe contradicción jurídica');
  });


  it('verifies the title of a backend-selected BOE historical block as a locator', () => {
    const document = {
      ...source('S1').document!,
      historical: {
        eventDate: '2022-03-30',
        status: 'reconstructed' as const,
        blocks: [{
          id: 'a32', title: 'Artículo 32', status: 'selected' as const,
          consideredVersionCount: 2, text: excerpt,
        }],
        limitations: [],
      },
    };
    const result = buildClaimEvidence(
      'La redacción corresponde a la versión seleccionada [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [{ ...source('S1'), document }],
    );
    expect(result.claims[0]?.sourceRefs[0]).toMatchObject({
      evidenceStatus: 'excerpt_matched', locator: 'Artículo 32', locatorVerified: true,
    });
  });

  it('rejects duplicate evidence markers for a single source instead of silently ignoring extras', () => {
    const result = buildClaimEvidence(
      'La regla se aplica [S1] [[EVIDENCE|S1||La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]] [[EVIDENCE|S1||Esta frase inventada no aparece en el documento recuperado.]]',
      [source('S1')],
    );
    expect(result.claims[0]).toMatchObject({
      kind: 'unresolved',
      sourceRefs: [{ evidenceStatus: 'excerpt_not_found', quote: null }],
    });
  });

  it('requires both citations to be visible for a reported conflict', () => {
    const second = source('S2', 'Artículo 32. La Administración no ampliará los plazos por incidencias técnicas.');
    const result = buildClaimEvidence(
      'Las fuentes difieren [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]] [[EVIDENCE|S2|Artículo 32|La Administración no ampliará los plazos por incidencias técnicas.]] [[CONFLICT|S1|S2|Los textos difieren en la ampliación del plazo por incidencias técnicas.]]',
      [source('S1'), second],
    );
    expect(result.claims[0]?.kind).toBe('unresolved');
    expect(result.claims[0]?.conflicts).toMatchObject([{ status: 'unverified' }]);
    expect(result.claims[0]?.unresolvedReferences).toContain('[S2] (falta la cita visible para la discrepancia)');
  });

  it('keeps the output deterministic and disclaims semantic entailment validation', () => {
    const answer = 'Conclusión basada en un texto publicado [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]';
    expect(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id)
      .toBe(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id);
    expect(buildClaimEvidence(answer, [source('S1')]).limitations.join(' '))
      .toContain('no demuestra que la fuente implique semánticamente');
  });
});
