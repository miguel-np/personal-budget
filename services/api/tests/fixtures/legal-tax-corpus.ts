/**
 * Initial, source-pinned legal/tax regression corpus for #108.
 *
 * Expected results deliberately cover provenance, temporal dimensions and abstention.
 * They are not tax computations or legal opinions. "reviewStatus: pending" is intentional:
 * a qualified tax/legal reviewer must approve substantive interpretations before this
 * corpus can satisfy the human-reviewed acceptance criterion.
 */
export const legalTaxCorpus = [
  {
    id: 'ES-IRPF-2023-FILING-2024',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'IRPF',
    taxpayer: 'individual; residency and personal circumstances explicitly unspecified',
    taxYear: 2023, filingYear: 2024,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2006-11-29', effectiveDate: '2007-01-01', eventDate: '2023-12-31', referenceDate: '2024-06-30' },
    documents: [{ id: 'BOE-A-2006-20764', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2006/11/28/35', locator: 'Ley 35/2006; temporal scope and filing year' }, { id: 'BOE-A-2006-20764-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764', locator: 'Consolidated text; informational disclaimer' }],
    expected: { outcome: 'separate_tax_and_filing_years', taxYear: 2023, filingYear: 2024, doNotInfer: ['residency', 'regional_deductions', 'taxable_income', 'filing_obligation'] },
    tags: ['year-separation', 'source-hierarchy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IRPF-2024-FILING-2025',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'IRPF',
    taxpayer: 'individual; autonomous-community residence not supplied',
    taxYear: 2024, filingYear: 2025,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2006-11-29', effectiveDate: '2007-01-01', eventDate: '2024-12-31', referenceDate: '2025-06-30' },
    documents: [{ id: 'BOE-A-2006-20764', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2006/11/28/35', locator: 'Ley 35/2006' }, { id: 'AEAT-IRPF-CAMPAIGN-2024', authority: 'administrative_guide', url: 'https://sede.agenciatributaria.gob.es/', locator: 'AEAT campaign material; locate the specific 2024 guide at capture time' }],
    expected: { outcome: 'separate_tax_and_filing_years', taxYear: 2024, filingYear: 2025, administrativeGuideIsNotStatute: true, doNotInfer: ['autonomousCommunity', 'deductions', 'taxableIncome'] },
    tags: ['year-separation', 'administrative-guidance'], reviewStatus: 'pending'
  },
  {
    id: 'ES-FRAUD-LAW-11-2021-EFFECTIVE-DATES',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'multiple_tax_amendments',
    taxpayer: 'corporate and individual taxpayers; provision-specific scope required',
    taxYear: 2021, filingYear: 2022,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2021-07-10', effectiveDate: '2021-07-11', eventDate: '2021-07-11', referenceDate: '2022-06-30' },
    documents: [{ id: 'BOE-A-2021-11473', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2021/07/09/11', locator: 'Disposición final séptima; letras a) a e)' }],
    expected: { outcome: 'provision_specific_temporal_effects', generalEntryIntoForce: '2021-07-11', separateEffects: ['three_month_delay', 'tax_periods_from_2021-01-01', 'effects_from_2022-01-01'], doNotApplyOneDateToEveryProvision: true },
    tags: ['transitional', 'effective-date', 'period-specific'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IVA-1992-ORIGINAL-VS-CURRENT',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'IVA',
    taxpayer: 'business; taxable-person status and transaction facts required',
    taxYear: 2024, filingYear: 2024,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '1992-12-29', effectiveDate: '1993-01-01', eventDate: '2024-06-15', referenceDate: '2024-06-15' },
    documents: [{ id: 'BOE-A-1992-28740', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/1992/12/28/37', locator: 'Ley 37/1992 original publication' }, { id: 'BOE-A-1992-28740-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740', locator: 'Consolidated text and amendment history' }],
    expected: { outcome: 'require_version_for_event_date', sourceHierarchy: ['official_publication', 'informative_consolidation'], doNotTreatConsolidationAsOfficialPublication: true, doNotInfer: ['vat_rate', 'exemption', 'deductibility'] },
    tags: ['version-conflict', 'source-hierarchy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IVA-2024-DECREE-9-2024-REPEAL',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'IVA',
    taxpayer: 'business; exact supply and taxable event required',
    taxYear: 2024, filingYear: 2025,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2024-12-24', effectiveDate: '2024-12-25', eventDate: '2025-01-10', referenceDate: '2025-01-23' },
    documents: [{ id: 'BOE-A-2024-26915', authority: 'official_publication', url: 'https://www.boe.es/buscar/doc.php?id=BOE-A-2024-26915', locator: 'Real Decreto-ley 9/2024' }, { id: 'BOE-A-2025-1136', authority: 'official_publication', url: 'https://www.boe.es/buscar/doc.php?id=BOE-A-2025-1136', locator: 'Resolución de 22 de enero de 2025; publication of Congress agreement repealing RDL 9/2024' }, { id: 'BOE-A-1992-28740', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/1992/12/28/37', locator: 'Ley 37/1992 as amended' }],
    expected: { outcome: 'detect_repeal_and_recompute_applicable_text', conflict: 'RDL 9/2024 amendment vs subsequent repeal resolution', doNotAssumeAmendmentRemainsEffective: true, doNotInfer: ['applicable_rate_without_supply_facts'] },
    tags: ['transitional', 'repeal', 'normative-discrepancy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-BOE-ARTICLE-32-2022-03-30',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'administrative_deadline_extension',
    taxpayer: 'administrative-procedure participant; no personal data',
    taxYear: null, filingYear: null,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2015-10-02', effectiveDate: '2016-10-02', eventDate: '2022-03-30', referenceDate: '2022-03-30' },
    documents: [{ id: 'BOE-A-2015-10565', authority: 'official_publication', url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2015-10565', locator: 'Ley 39/2015, artículo 32; redacción anterior' }, { id: 'BOE-A-2022-4972', authority: 'official_publication', url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2022-4972', locator: 'RDL 6/2022; amendment effective 2022-03-31' }],
    expected: { outcome: 'select_pre_amendment_version', selectedNorm: 'BOE-A-2015-10565', mustNotContainNewParagraph5: true },
    tags: ['transitional', 'boe-history', 'boundary-before'], reviewStatus: 'pending'
  },
  {
    id: 'ES-BOE-ARTICLE-32-2022-03-31',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'administrative_deadline_extension',
    taxpayer: 'administrative-procedure participant; no personal data',
    taxYear: null, filingYear: null,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2022-03-30', effectiveDate: '2022-03-31', eventDate: '2022-03-31', referenceDate: '2022-03-31' },
    documents: [{ id: 'BOE-A-2015-10565', authority: 'official_publication', url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2015-10565', locator: 'Ley 39/2015, artículo 32' }, { id: 'BOE-A-2022-4972', authority: 'official_publication', url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2022-4972', locator: 'RDL 6/2022, artículo modificador; entrada en vigor 2022-03-31' }],
    expected: { outcome: 'select_amended_version', selectedNorm: 'BOE-A-2022-4972', mustContainNewParagraph5: true },
    tags: ['transitional', 'boe-history', 'boundary-after'], reviewStatus: 'pending'
  },
  {
    id: 'ES-GALICIA-LAW-5-2024-IRPF-2025',
    jurisdiction: { state: 'ES', autonomousCommunity: 'GA', municipality: null },
    taxOrProcedure: 'regional_IRPF_deduction',
    taxpayer: 'individual resident in Galicia; all statutory eligibility facts still required',
    taxYear: 2025, filingYear: 2026,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2024-12-31', effectiveDate: '2025-01-01', eventDate: '2025-12-31', referenceDate: '2026-06-30' },
    documents: [{ id: 'BOE-A-2025-2145', authority: 'official_publication', url: 'https://www.boe.es/eli/es-ga/l/2024/12/27/5', locator: 'Ley 5/2024, artículo 2; modification of Galicia ceded-tax consolidated text' }, { id: 'BOE-A-2025-2145-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2025-2145', locator: 'Consolidated text; later amendments must be dated' }],
    expected: { outcome: 'regional_rule_candidate_requires_eligibility_facts', jurisdiction: 'GA', effectiveFrom: '2025-01-01', doNotInfer: ['disability', 'age', 'income_threshold', 'third_party_care', 'residency'] },
    tags: ['regional-jurisdiction', 'effective-date'], reviewStatus: 'pending'
  },
  {
    id: 'ES-GALICIA-LAW-5-2024-DOG-BOE-DATE-DISCREPANCY',
    jurisdiction: { state: 'ES', autonomousCommunity: 'GA', municipality: null },
    taxOrProcedure: 'regional_tax_and_administrative_measures',
    taxpayer: 'not specified; determine provision-specific scope',
    taxYear: 2025, filingYear: 2026,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2024-12-31', effectiveDate: '2025-01-01', eventDate: '2025-01-01', referenceDate: '2025-02-06' },
    documents: [{ id: 'BOE-A-2025-2145', authority: 'official_publication', url: 'https://www.boe.es/eli/es-ga/l/2024/12/27/5', locator: 'DOG no. 251, 2024-12-31; BOE no. 32, 2025-02-06' }],
    expected: { outcome: 'preserve_distinct_publication_events', dogPublicationDate: '2024-12-31', boePublicationDate: '2025-02-06', generalEffectiveDate: '2025-01-01', doNotReplaceDogDateWithBoeRepublicationDate: true },
    tags: ['regional-jurisdiction', 'publication-discrepancy', 'effective-date'], reviewStatus: 'pending'
  },
  {
    id: 'ES-GALICIA-LAW-6-2023-SCOPE-ABSTENTION',
    jurisdiction: { state: 'ES', autonomousCommunity: 'GA', municipality: null },
    taxOrProcedure: 'inheritance_of_public_property',
    taxpayer: 'public-sector entity or nonprofit beneficiary; exact legal capacity required',
    taxYear: null, filingYear: null,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2023-11-28', effectiveDate: '2023-12-03', eventDate: '2024-02-01', referenceDate: '2024-02-01' },
    documents: [{ id: 'BOE-A-2023-24124', authority: 'official_publication', url: 'https://www.boe.es/eli/es-ga/l/2023/11/02/6', locator: 'Ley 6/2023, patrimonio de Galicia; artículos 140-144' }],
    expected: { outcome: 'abstain_scope_mismatch', reason: 'Public-asset transfer law does not establish a tax liability merely because the scenario mentions an inheritance', doNotInfer: ['inheritance_tax_exemption', 'tax_rate', 'taxable_base'] },
    tags: ['regional-jurisdiction', 'abstention', 'scope-control'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IRPF-CONSOLIDATED-VS-OFFICIAL-PUBLICATION',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'IRPF_historical_rule',
    taxpayer: 'individual; facts and tax year required',
    taxYear: 2022, filingYear: 2023,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2006-11-29', effectiveDate: '2007-01-01', eventDate: '2022-12-31', referenceDate: '2023-06-30' },
    documents: [{ id: 'BOE-A-2006-20764', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2006/11/28/35', locator: 'Original official publication and dated amending provisions' }, { id: 'BOE-A-2006-20764-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764', locator: 'BOE warning: consolidated text is informative and has no legal value' }],
    expected: { outcome: 'prefer_official_publication_for_legal_proof', consolidatedTextMayAidNavigation: true, consolidatedTextIsNotOfficialPublication: true, requireVersionAtEventDate: true },
    tags: ['normative-discrepancy', 'source-hierarchy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-TAX-INSUFFICIENT-JURISDICTION-AND-FACTS',
    jurisdiction: { state: null, autonomousCommunity: null, municipality: null },
    taxOrProcedure: 'unspecified_personal_tax_question',
    taxpayer: 'unknown',
    taxYear: 2024, filingYear: 2025,
    capturedAt: '2026-11-02',
    dates: { publicationDate: null, effectiveDate: null, eventDate: null, referenceDate: '2025-06-01' },
    documents: [],
    expected: { outcome: 'abstain_insufficient_context', requiredFacts: ['state', 'autonomousCommunity_when_relevant', 'municipality_when_local_tax', 'taxpayer_type', 'tax_or_procedure', 'eventDate'], doNotInfer: ['location_from_network', 'residency_from_currency', 'taxpayer_type_from_financial_movements'] },
    tags: ['abstention', 'privacy', 'missing-context'], reviewStatus: 'pending'
  }
] as const;
