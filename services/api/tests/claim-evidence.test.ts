import { describe, expect, it } from 'vitest';
import { buildClaimEvidence, shouldAbstainFromTaxConclusion } from '../src/claim-evidence.js';
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

  it('classifies metadata separately from substantive legal claims', () => {
    const result = buildClaimEvidence(
      'La ficha indica una fecha de publicación [S1] [[CLAIM|metadata]].',
      [source('S1')],
    );
    expect(result.claims[0]?.classification).toBe('metadata');
    expect(result.claims[0]?.text).not.toContain('[[CLAIM');
  });

  it('does not treat an insecure BOE URL as a primary official publication', () => {
    const insecure = {
      ...source('S1'),
      url: 'http://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-1',
    };
    const result = buildClaimEvidence(
      'La disposición contiene la regla [S1] [[EVIDENCE|S1||La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [insecure],
      { requirePrimaryPublication: true },
    );
    expect(result.claims[0]?.primaryPublication.status).toBe('not_located_in_results');
    expect(result.claims[0]?.sourceRefs[0]?.evidenceClass).toBe('legislation_source_unclassified');
  });

  it('does not treat BOE consolidated text as a verified excerpt from the original publication', () => {
    const consolidated: WebSearchSource = {
      ...source('S1'),
      document: { ...source('S1').document!, documentType: 'boe_consolidated_legislation' },
    };
    const result = buildClaimEvidence(
      'La norma publicada establece el requisito [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [consolidated],
      { requirePrimaryPublication: true },
    );
    expect(result.claims[0]?.sourceRefs[0]).toMatchObject({
      evidenceStatus: 'excerpt_matched', evidenceClass: 'informative_consolidation',
      documentType: 'boe_consolidated_legislation',
    });
    expect(result.claims[0]?.primaryPublication).toEqual({
      status: 'cited_without_excerpt', sourceIds: ['S1'],
    });
    expect(shouldAbstainFromTaxConclusion(result)).toBe(true);
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
    expect(shouldAbstainFromTaxConclusion(result)).toBe(true);
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
          consideredVersionCount: 2, publicationDate: '2015-10-02', effectiveDate: '2015-10-02',
          publicationUrl: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2015-10565', text: excerpt,
        }],
        limitations: [],
      },
    };
    const result = buildClaimEvidence(
      'La redacción corresponde a la versión seleccionada [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [{ ...source('S1'), document }],
      { requirePrimaryPublication: true },
    );
    expect(result.claims[0]?.sourceRefs[0]).toMatchObject({
      evidenceStatus: 'excerpt_matched', locator: 'Artículo 32', locatorVerified: true,
      evidenceClass: 'official_publication',
      historicalVersion: { publicationUrl: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2015-10565' },
    });
    expect(result.claims[0]?.primaryPublication.status).toBe('cited_with_excerpt');
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

  it('requires fiscal abstention when claim evidence is missing or a discrepancy is reported', () => {
    const missingEvidence = buildClaimEvidence(
      'La norma impone una sanción [S1] [[EVIDENCE|S1|Artículo 32|La Administración impondrá siempre una sanción económica inmediata.]]',
      [source('S1')],
    );
    expect(shouldAbstainFromTaxConclusion(missingEvidence)).toBe(true);

    const discrepancy = buildClaimEvidence(
      'Las fuentes discrepan [S1] [S2] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]] [[EVIDENCE|S2|Artículo 32|La Administración no ampliará los plazos por incidencias técnicas.]] [[CONFLICT|S1|S2|Los textos difieren sobre los efectos de la incidencia técnica.]]',
      [source('S1'), source('S2', 'Artículo 32. La Administración no ampliará los plazos por incidencias técnicas.')],
    );
    expect(discrepancy.claims[0]?.conflicts).toMatchObject([{ status: 'reported_with_fragments' }]);
    expect(shouldAbstainFromTaxConclusion(discrepancy)).toBe(true);
    expect(shouldAbstainFromTaxConclusion({ claims: [], limitations: [] })).toBe(true);
  });

  it('does not force abstention when every claim has a located fragment and no conflict is reported', () => {
    const supported = buildClaimEvidence(
      'La disposición contiene la regla [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]',
      [source('S1')],
    );
    expect(shouldAbstainFromTaxConclusion(supported)).toBe(false);
  });

  it('compares available source and temporal metadata without inferring legal priority or case applicability', () => {
    const temporalOne = {
      assessment: 'not_marked_derogated_or_exhausted' as const, referenceDate: '2026-11-03',
      publicationDate: '2025-03-01', effectiveDate: '2025-04-01', derogationDate: null,
      annulmentDate: null, lastRegistryUpdate: '2025-04-01', derogated: false, annulled: false,
      exhausted: false, consolidationStatus: 'Finalizado', relatedNorms: [],
    };
    const temporalThree = {
      ...temporalOne, assessment: 'not_effective_yet' as const,
      publicationDate: '2025-06-01', effectiveDate: '2025-07-01', lastRegistryUpdate: '2025-06-15',
    };
    const first = {
      ...source('S1'), publishedAt: '2025-03-01T00:00:00.000Z', modifiedAt: '2025-03-10T00:00:00.000Z',
      document: {
        ...source('S1').document!, temporal: temporalOne,
        historical: {
          eventDate: '2022-03-30', status: 'reconstructed' as const,
          blocks: [{ id: 'a32', title: 'Artículo 32', status: 'selected' as const, consideredVersionCount: 2,
            publicationDate: '2015-10-02', effectiveDate: '2015-10-02', publicationUrl: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2015-10565', text: excerpt }],
          limitations: [],
        },
      },
    };
    const consolidationExcerpt = 'Artículo 32. La Administración ampliará los plazos en los supuestos expresamente previstos por la norma.';
    const second: WebSearchSource = {
      ...source('S2', consolidationExcerpt),
      url: 'https://www.lex.gal/norma/consolidada', domain: 'www.lex.gal', institution: 'Lex.gal',
      sourceKind: 'normativa_consolidada_informativa', sourceAuthority: 'legal_consolidation',
      publishedAt: '2025-04-01T00:00:00.000Z', modifiedAt: null,
    };
    const thirdExcerpt = 'Artículo 32. La Administración ampliará los plazos desde la fecha indicada en la disposición modificativa.';
    const third: WebSearchSource = {
      ...source('S3', thirdExcerpt),
      publishedAt: '2025-06-01T00:00:00.000Z', modifiedAt: '2025-06-15T00:00:00.000Z',
      document: {
        ...source('S3').document!, temporal: temporalThree,
        historical: {
          eventDate: '2022-03-30', status: 'reconstructed' as const,
          blocks: [{ id: 'a32', title: 'Artículo 32', status: 'selected' as const, consideredVersionCount: 2,
            publicationDate: '2022-03-30', effectiveDate: '2022-03-31', modifyingNormId: 'BOE-A-2022-4972', publicationUrl: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2022-4972', text: thirdExcerpt }],
          limitations: [],
        },
      },
    };
    const result = buildClaimEvidence(
      'Las fuentes presentan metadatos distintos [S1] [S2] [S3] '+
      '[[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]] '+
      '[[EVIDENCE|S2|Artículo 32|La Administración ampliará los plazos en los supuestos expresamente previstos por la norma.]] '+
      '[[EVIDENCE|S3|Artículo 32|La Administración ampliará los plazos desde la fecha indicada en la disposición modificativa.]]',
      [first, second, third],
    );
    const comparison = result.claims[0]?.sourceComparison;
    expect(comparison?.sourceIds).toEqual(['S1', 'S2', 'S3']);
    expect(comparison?.dimensions.find((item) => item.dimension === 'evidence_class')).toMatchObject({ status: 'different' });
    expect(comparison?.dimensions.find((item) => item.dimension === 'provider_published_at')).toMatchObject({ status: 'different' });
    expect(comparison?.dimensions.find((item) => item.dimension === 'official_effective_date')).toMatchObject({ status: 'different', missingSourceIds: ['S2'] });
    expect(comparison?.dimensions.find((item) => item.dimension === 'official_temporal_assessment')).toMatchObject({ status: 'different', missingSourceIds: ['S2'] });
    expect(comparison?.dimensions.find((item) => item.dimension === 'selected_version_event_date')).toMatchObject({ status: 'incomplete', missingSourceIds: ['S2'] });
    expect(comparison?.dimensions.find((item) => item.dimension === 'selected_version_publication_date')).toMatchObject({ status: 'different', missingSourceIds: ['S2'] });
    expect(comparison?.dimensions.find((item) => item.dimension === 'selected_version_effective_date')).toMatchObject({ status: 'different', missingSourceIds: ['S2'] });
    expect(comparison?.dimensions.find((item) => item.dimension === 'selected_version_modifying_norm')).toMatchObject({ status: 'incomplete', missingSourceIds: ['S1', 'S2'] });
    expect(result.claims[0]?.sourceRefs[0]?.historicalVersion).toMatchObject({
      eventDate: '2022-03-30', blockId: 'a32', title: 'Artículo 32', publicationDate: '2015-10-02', effectiveDate: '2015-10-02', publicationUrl: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2015-10565',
    });
    expect(comparison?.notAssessedDimensions).toEqual(['jurisdiction', 'legal_rank', 'subject_matter', 'case_applicability']);
    expect(result.claims[0]?.conflicts).toEqual([]);
  });

  it('keeps the output deterministic and disclaims semantic entailment validation', () => {
    const answer = 'Conclusión basada en un texto publicado [S1] [[EVIDENCE|S1|Artículo 32|La Administración ampliará los plazos cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema.]]';
    expect(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id)
      .toBe(buildClaimEvidence(answer, [source('S1')]).claims[0]?.id);
    expect(buildClaimEvidence(answer, [source('S1')]).limitations.join(' '))
      .toContain('no demuestra que la fuente implique semánticamente');
  });
});
