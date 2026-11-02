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
    question: "¿Qué ejercicio corresponde a las rentas obtenidas durante 2023 y en qué año se presenta la declaración ordinaria?",
    context: "Supuesto abstracto de una persona física con periodo impositivo coincidente con el año natural; no se facilitan residencia autonómica, rentas ni circunstancias personales.",
    taxOrProcedure: 'IRPF',
    taxpayer: 'individual; residency and personal circumstances explicitly unspecified',
    taxYear: 2023, filingYear: 2024,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2006-20764-consolidated",
        "sourceUrl": "https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764&p=20231231&tn=1",
        "version": "consolidated-text-as-of-2023-12-31",
        "locator": "Article 12(1), tax period",
        "excerpt": "El período impositivo será el año natural.",
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2006-20764",
        "sourceUrl": "https://www.boe.es/diario_boe/txt.php?id=BOE-A-2006-20764",
        "version": "official-original-publication",
        "locator": "Article 12(1), tax period",
        "excerpt": "El período impositivo será el año natural.",
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2006-11-29', effectiveDate: '2007-01-01', eventDate: '2023-12-31', referenceDate: '2024-06-30' },
    documents: [{ id: 'BOE-A-2006-20764', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2006/11/28/35', locator: 'Ley 35/2006; temporal scope and filing year' }, { id: 'BOE-A-2006-20764-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764&p=20231231&tn=1', locator: 'Consolidated text; informational disclaimer' }],
    expected: { citationIds: ["BOE-A-2006-20764"], outcome: 'separate_tax_and_filing_years', taxYear: 2023, filingYear: 2024, doNotInfer: ['residency', 'regional_deductions', 'taxable_income', 'filing_obligation'] },
    tags: ['year-separation', 'source-hierarchy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IRPF-2024-FILING-2025',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    question: "¿A qué ejercicio corresponde la campaña del Modelo 100 de Renta 2024 y qué valor tiene la guía informativa de la AEAT?",
    context: "Supuesto abstracto de una persona física sin comunidad autónoma de residencia indicada; se compara la ley del IRPF con material informativo de la campaña 2024.",
    taxOrProcedure: 'IRPF',
    taxpayer: 'individual; autonomous-community residence not supplied',
    taxYear: 2024, filingYear: 2025,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "AEAT-IRPF-2024-MODEL100",
        "sourceUrl": "https://sede.agenciatributaria.gob.es/Sede/Ayuda/24Presentacion/100.html",
        "version": "AEAT-Modelo-100-IRPF-2024",
        "locator": "Page heading and informational disclaimer",
        "excerpt": "Esta publicación tiene efectos meramente informativos.",
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2006-20764-consolidated",
        "sourceUrl": "https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764&p=20241231&tn=1",
        "version": "consolidated-text-as-of-2024-12-31",
        "locator": "Article 12(1), tax period for the 2024 tax year",
        "recordedFacts": [
          "Tax period is a calendar year under the general rule",
          "Filing campaign occurs in the following calendar year"
        ],
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2006-20764",
        "sourceUrl": "https://www.boe.es/diario_boe/txt.php?id=BOE-A-2006-20764",
        "version": "official-original-publication",
        "locator": "Article 12(1), tax period",
        "excerpt": "El período impositivo será el año natural.",
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2006-11-29', effectiveDate: '2007-01-01', eventDate: '2024-12-31', referenceDate: '2025-06-30' },
    documents: [{ id: 'BOE-A-2006-20764', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2006/11/28/35', locator: 'Ley 35/2006, original official publication' }, { id: 'BOE-A-2006-20764-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764&p=20241231&tn=1', locator: 'Consolidated text frozen at 31/12/2024; informational only' }, { id: 'AEAT-IRPF-2024-MODEL100', authority: 'administrative_guide', url: 'https://sede.agenciatributaria.gob.es/Sede/Ayuda/24Presentacion/100.html', locator: 'Modelo 100 IRPF 2024; informational publication; campaign for filing in 2025' }],
    expected: { citationIds: ["BOE-A-2006-20764","BOE-A-2006-20764-consolidated","AEAT-IRPF-2024-MODEL100"], outcome: 'separate_tax_and_filing_years', taxYear: 2024, filingYear: 2025, administrativeGuideIsNotStatute: true, doNotInfer: ['autonomousCommunity', 'deductions', 'taxableIncome'] },
    tags: ['year-separation', 'administrative-guidance'], reviewStatus: 'pending'
  },
  {
    id: 'ES-FRAUD-LAW-11-2021-EFFECTIVE-DATES',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    question: "¿Puede aplicarse una única fecha de entrada en vigor a todas las modificaciones de la Ley 11/2021?",
    context: "Supuesto abstracto sobre las distintas letras de la disposición final séptima de la Ley 11/2021 y sus fechas de efectos.",
    taxOrProcedure: 'multiple_tax_amendments',
    taxpayer: 'corporate and individual taxpayers; provision-specific scope required',
    taxYear: 2021, filingYear: 2022,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2021-11473",
        "sourceUrl": "https://www.boe.es/eli/es/l/2021/07/09/11",
        "version": "official-original-publication",
        "locator": "Disposición final séptima, letras b) y c)",
        "excerpt": "tendrán efectos para los períodos impositivos que se inicien a partir de 1 de enero de 2021.",
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2021-07-10', effectiveDate: '2021-07-11', eventDate: '2021-07-11', referenceDate: '2022-06-30' },
    documents: [{ id: 'BOE-A-2021-11473', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2021/07/09/11', locator: 'Disposición final séptima; letras a) a e)' }],
    expected: { citationIds: ["BOE-A-2021-11473"], outcome: 'provision_specific_temporal_effects', generalEntryIntoForce: '2021-07-11', separateEffects: ['three_month_delay', 'tax_periods_from_2021-01-01', 'effects_from_2022-01-01'], doNotApplyOneDateToEveryProvision: true },
    tags: ['transitional', 'effective-date', 'period-specific'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IVA-1992-ORIGINAL-VS-CURRENT',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    question: "¿Qué versión de la Ley del IVA debe consultarse para un hecho imponible ocurrido el 15 de junio de 2024?",
    context: "Supuesto abstracto de una operación empresarial sujeta potencialmente a IVA; no se aportan naturaleza de la operación, exención ni tipo impositivo.",
    taxOrProcedure: 'IVA',
    taxpayer: 'business; taxable-person status and transaction facts required',
    taxYear: 2024, filingYear: 2024,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-1992-28740",
        "sourceUrl": "https://www.boe.es/eli/es/l/1992/12/28/37",
        "version": "official-original-publication",
        "locator": "Publication record: BOE núm. 312, 29/12/1992; entry into force 01/01/1993",
        "recordedFacts": [
          "Publication date: 1992-12-29",
          "Entry into force: 1993-01-01"
        ],
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-1992-28740-consolidated",
        "sourceUrl": "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
        "version": "live-consolidated-text-observed-2026-11-02",
        "locator": "BOE consolidated-text disclaimer and date selector",
        "recordedFacts": [
          "The live consolidated page is not a frozen historical version for 2024",
          "The version must be selected by the event date"
        ],
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '1992-12-29', effectiveDate: '1993-01-01', eventDate: '2024-06-15', referenceDate: '2024-06-15' },
    documents: [{ id: 'BOE-A-1992-28740', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/1992/12/28/37', locator: 'Ley 37/1992 original publication' }, { id: 'BOE-A-1992-28740-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740', locator: 'Consolidated text and amendment history' }],
    expected: { citationIds: ["BOE-A-1992-28740","BOE-A-1992-28740-consolidated"], outcome: 'require_version_for_event_date', sourceHierarchy: ['official_publication', 'informative_consolidation'], doNotTreatConsolidationAsOfficialPublication: true, doNotInfer: ['vat_rate', 'exemption', 'deductibility'] },
    tags: ['version-conflict', 'source-hierarchy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IVA-2024-DECREE-9-2024-REPEAL',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    question: "¿Qué puede concluirse sobre la modificación temporal del régimen especial de IVA cuando el decreto fue derogado después de la fecha del hecho?",
    context: "Supuesto abstracto de actividad económica que podría acogerse a regímenes especiales; se comparan el RDL 9/2024 y el acuerdo posterior de derogación, sin datos de actividad o volumen.",
    taxOrProcedure: 'IVA_simplified_regime_and_agriculture_fishing_special_regime',
    taxpayer: 'business; exact regime eligibility, turnover and activity facts required',
    taxYear: 2025, filingYear: null,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2024-26915",
        "sourceUrl": "https://www.boe.es/eli/es/rdl/2024/12/23/9",
        "version": "official-original-publication",
        "locator": "Article 8(Three), Ley 37/1992, transitional provision 13",
        "excerpt": "queda fijada en 250.000 euros.",
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2025-1136",
        "sourceUrl": "https://www.boe.es/eli/es/res/2025/01/22/(1)",
        "version": "official-repeal-resolution",
        "locator": "Congress agreement of 22/01/2025, published 23/01/2025",
        "excerpt": "acordó derogar el Real Decreto-ley 9/2024.",
        "recordedFacts": [
          "Agreement adopted: 2025-01-22; BOE publication: 2025-01-23",
          "The BOE analysis says the modification of the VAT Law transitional provision 13, which had effects from 2025-01-01, is left without effect with those stated effects",
          "This is source evidence about the legal amendment; applying it to a particular taxpayer or transaction still requires fact-specific legal review"
        ],
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2024-12-24', effectiveDate: '2024-12-25', eventDate: '2025-01-10', referenceDate: '2025-01-23', repealPublicationDate: '2025-01-23' },
    documents: [{ id: 'BOE-A-2024-26915', authority: 'official_publication', url: 'https://www.boe.es/eli/es/rdl/2024/12/23/9', locator: 'Artículo 8, apartado Tres: modificación de la disposición transitoria decimotercera de la Ley 37/1992; efectos desde 01/01/2025' }, { id: 'BOE-A-2025-1136', authority: 'official_publication', url: 'https://www.boe.es/eli/es/res/2025/01/22/(1)', locator: 'Acuerdo del Congreso de 22/01/2025; publicación oficial de la derogación el 23/01/2025' }, { id: 'BOE-A-1992-28740', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/1992/12/28/37', locator: 'Ley 37/1992 as amended' }],
    expected: { citationIds: ["BOE-A-2024-26915","BOE-A-2025-1136"], outcome: 'flag_temporal_conflict_and_abstain_on_effects', amendmentEffectiveFrom: '2025-01-01', repealPublishedOn: '2025-01-23', conflict: 'RDL 9/2024 amended the IVA transitional limit with effects from 2025-01-01; the 2025-01-22 repeal resolution records that this amendment is left without effect with the indicated effects from 2025-01-01', resolutionRecordsEffectsFrom: '2025-01-01', doNotInfer: ['individual_eligibility_for_special_regime', 'whether_a_specific_transaction_between_2025-01-01_and_2025-01-22_created_a_protected_position', 'filing_frequency'] },
    tags: ['transitional', 'repeal', 'normative-discrepancy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-BOE-ARTICLE-32-2022-03-30',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    question: "¿Qué redacción del artículo 32 de la Ley 39/2015 corresponde al hecho producido el 30 de marzo de 2022?",
    context: "Supuesto abstracto de procedimiento administrativo en la víspera de la entrada en vigor de la modificación introducida por el RDL 6/2022.",
    taxOrProcedure: 'administrative_deadline_extension',
    taxpayer: 'administrative-procedure participant; no personal data',
    taxYear: null, filingYear: null,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2015-10565",
        "sourceUrl": "https://www.boe.es/eli/es/l/2015/10/01/39",
        "version": "article-32-before-2022-03-31-amendment",
        "locator": "Article 32, version applicable on 30/03/2022",
        "excerpt": "Cuando una incidencia técnica haya imposibilitado el funcionamiento ordinario del sistema o aplicación.",
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2022-4972",
        "sourceUrl": "https://www.boe.es/eli/es/rdl/2022/03/29/6",
        "version": "official-original-publication",
        "locator": "Official publication and entry-into-force data; article 32 amendment",
        "recordedFacts": [
          "Published: 2022-03-30",
          "Entry into force: 2022-03-31"
        ],
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2015-10-02', effectiveDate: '2016-10-02', eventDate: '2022-03-30', referenceDate: '2022-03-30' },
    documents: [{ id: 'BOE-A-2015-10565', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2015/10/01/39', locator: 'Ley 39/2015, artículo 32; redacción anterior' }, { id: 'BOE-A-2022-4972', authority: 'official_publication', url: 'https://www.boe.es/eli/es/rdl/2022/03/29/6', locator: 'RDL 6/2022; amendment effective 2022-03-31' }],
    expected: { citationIds: ["BOE-A-2015-10565","BOE-A-2022-4972"], outcome: 'select_pre_amendment_version', selectedNorm: 'BOE-A-2015-10565', mustNotContainNewParagraph5: true },
    tags: ['transitional', 'boe-history', 'boundary-before'], reviewStatus: 'pending'
  },
  {
    id: 'ES-BOE-ARTICLE-32-2022-03-31',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    question: "¿Qué redacción del artículo 32 de la Ley 39/2015 corresponde al hecho producido el 31 de marzo de 2022?",
    context: "Supuesto abstracto de procedimiento administrativo en la fecha de entrada en vigor de la modificación introducida por el RDL 6/2022.",
    taxOrProcedure: 'administrative_deadline_extension',
    taxpayer: 'administrative-procedure participant; no personal data',
    taxYear: null, filingYear: null,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2022-4972",
        "sourceUrl": "https://www.boe.es/eli/es/rdl/2022/03/29/6",
        "version": "official-original-publication",
        "locator": "Disposición final vigésima primera; amendment to Article 32(5) of Ley 39/2015",
        "excerpt": "se añade un apartado 5 al artículo 32 de la Ley 39/2015.",
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2015-10565",
        "sourceUrl": "https://www.boe.es/eli/es/l/2015/10/01/39",
        "version": "Ley-39-2015-original-publication",
        "locator": "Article 32 paragraphs in force before the RDL 6/2022 amendment",
        "recordedFacts": [
          "Original publication: 2015-10-02",
          "Entry into force: 2016-10-02"
        ],
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2022-03-30', effectiveDate: '2022-03-31', eventDate: '2022-03-31', referenceDate: '2022-03-31' },
    documents: [{ id: 'BOE-A-2015-10565', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2015/10/01/39', locator: 'Ley 39/2015, artículo 32' }, { id: 'BOE-A-2022-4972', authority: 'official_publication', url: 'https://www.boe.es/eli/es/rdl/2022/03/29/6', locator: 'RDL 6/2022, artículo modificador; entrada en vigor 2022-03-31' }],
    expected: { citationIds: ["BOE-A-2015-10565","BOE-A-2022-4972"], outcome: 'select_amended_version', selectedNorm: 'BOE-A-2022-4972', mustContainNewParagraph5: true },
    tags: ['transitional', 'boe-history', 'boundary-after'], reviewStatus: 'pending'
  },
  {
    id: 'ES-GALICIA-LAW-5-2024-IRPF-2025',
    jurisdiction: { state: 'ES', autonomousCommunity: 'GA', municipality: null },
    question: "¿Qué norma gallega puede ser relevante para una deducción autonómica del IRPF del ejercicio 2025 y qué requisitos no se pueden presumir?",
    context: "Supuesto abstracto de contribuyente residente en Galicia durante el ejercicio 2025; no se aportan edad, discapacidad, renta ni gastos que permitan determinar elegibilidad.",
    taxOrProcedure: 'regional_IRPF_deduction',
    taxpayer: 'individual resident in Galicia; all statutory eligibility facts still required',
    taxYear: 2025, filingYear: 2026,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2025-2145-consolidated",
        "sourceUrl": "https://www.boe.es/buscar/act.php?id=BOE-A-2025-2145&p=20251231&tn=1",
        "version": "consolidated-text-as-of-2025-12-31",
        "locator": "Article 2, modification of the regional IRPF deductions",
        "excerpt": "el 10 % de las cantidades satisfechas a los terceros, con un límite máximo de 600 euros.",
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2025-2145",
        "sourceUrl": "https://www.boe.es/eli/es-ga/l/2024/12/27/5",
        "version": "official-original-publication",
        "locator": "Article 2, amendments to the Galician IRPF deduction regime",
        "recordedFacts": [
          "Published in DOG on 2024-12-31; BOE republication on 2025-02-06",
          "The consolidation used for the tax-year scenario is an informational snapshot selected as of 2025-12-31"
        ],
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2024-12-31', effectiveDate: '2025-01-01', eventDate: '2025-12-31', referenceDate: '2026-06-30' },
    documents: [{ id: 'BOE-A-2025-2145', authority: 'official_publication', url: 'https://www.boe.es/eli/es-ga/l/2024/12/27/5', locator: 'Ley 5/2024, original official publication' }, { id: 'BOE-A-2025-2145-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2025-2145&p=20251231&tn=1', locator: 'Consolidated snapshot selected as of 31/12/2025; informational only' }],
    expected: { citationIds: ["BOE-A-2025-2145","BOE-A-2025-2145-consolidated"], outcome: 'regional_rule_candidate_requires_eligibility_facts', jurisdiction: 'GA', effectiveFrom: '2025-01-01', doNotInfer: ['disability', 'age', 'income_threshold', 'third_party_care', 'residency'] },
    tags: ['regional-jurisdiction', 'effective-date'], reviewStatus: 'pending'
  },
  {
    id: 'ES-GALICIA-LAW-5-2024-DOG-BOE-DATE-DISCREPANCY',
    jurisdiction: { state: 'ES', autonomousCommunity: 'GA', municipality: null },
    question: "¿Deben confundirse las fechas de publicación en el DOG y de reproducción en el BOE de una ley gallega?",
    context: "Supuesto abstracto de una disposición autonómica publicada primero en el DOG y posteriormente en el BOE; las fechas de publicación se mantienen separadas de la entrada en vigor.",
    taxOrProcedure: 'regional_tax_and_administrative_measures',
    taxpayer: 'not specified; determine provision-specific scope',
    taxYear: 2025, filingYear: 2026,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "DOG-g-2024-90260",
        "sourceUrl": "https://www.boe.es/buscar/doc.php?id=DOG-g-2024-90260",
        "version": "DOG-official-publication",
        "locator": "Document header and publication record",
        "recordedFacts": [
          "DOG no. 251, published 2024-12-31"
        ],
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2025-2145",
        "sourceUrl": "https://www.boe.es/eli/es-ga/l/2024/12/27/5",
        "version": "BOE-official-publication",
        "locator": "Document header and publication record",
        "recordedFacts": [
          "BOE no. 32, published 2025-02-06",
          "General entry into force: 2025-01-01"
        ],
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2024-12-31', effectiveDate: '2025-01-01', eventDate: '2025-01-01', referenceDate: '2025-02-06' },
    documents: [{ id: 'DOG-g-2024-90260', authority: 'official_publication', url: 'https://www.boe.es/buscar/doc.php?id=DOG-g-2024-90260', locator: 'DOG no. 251, 31/12/2024' }, { id: 'BOE-A-2025-2145', authority: 'official_publication', url: 'https://www.boe.es/eli/es-ga/l/2024/12/27/5', locator: 'BOE no. 32, 06/02/2025; republication of the same Galician law' }],
    expected: { citationIds: ["DOG-g-2024-90260","BOE-A-2025-2145"], outcome: 'preserve_distinct_publication_events', dogPublicationDate: '2024-12-31', boePublicationDate: '2025-02-06', generalEffectiveDate: '2025-01-01', doNotReplaceDogDateWithBoeRepublicationDate: true },
    tags: ['regional-jurisdiction', 'publication-discrepancy', 'effective-date'], reviewStatus: 'pending'
  },
  {
    id: 'ES-GALICIA-LAW-6-2023-SCOPE-ABSTENTION',
    jurisdiction: { state: 'ES', autonomousCommunity: 'GA', municipality: null },
    question: "¿Permite una norma gallega de patrimonio público determinar la tributación de una herencia privada?",
    context: "Supuesto abstracto de herencia privada; se aporta una norma sobre cesión y uso de bienes públicos como posible fuente irrelevante para el impuesto preguntado.",
    taxOrProcedure: 'inheritance_tax_question_with_irrelevant_public_asset_source',
    taxpayer: 'individual receiving a private inheritance; tax facts and relationship to deceased unspecified',
    taxYear: null, filingYear: null,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2023-24124",
        "sourceUrl": "https://www.boe.es/eli/es-ga/l/2023/11/02/6",
        "version": "official-original-publication",
        "locator": "Articles 140-144, assignment of public assets and formalisation",
        "excerpt": "La cesión se otorgará en escritura pública.",
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2023-11-28', effectiveDate: '2023-12-03', eventDate: '2024-02-01', referenceDate: '2024-02-01' },
    documents: [{ id: 'BOE-A-2023-24124', authority: 'official_publication', url: 'https://www.boe.es/eli/es-ga/l/2023/11/02/6', locator: 'Ley 6/2023, patrimonio de Galicia; artículos 140-144' }],
    expected: { citationIds: ["BOE-A-2023-24124"], outcome: 'abstain_scope_mismatch', reason: 'Articles 140-144 regulate assignment/transfer and use of public assets; they do not establish an inheritance-tax rule for a private inheritance', doNotInfer: ['inheritance_tax_exemption', 'tax_rate', 'taxable_base'] },
    tags: ['regional-jurisdiction', 'abstention', 'scope-control'], reviewStatus: 'pending'
  },
  {
    id: 'ES-IRPF-CONSOLIDATED-VS-OFFICIAL-PUBLICATION',
    jurisdiction: { state: 'ES', autonomousCommunity: null, municipality: null },
    question: "¿Qué valor probatorio debe atribuirse al texto consolidado del IRPF frente a la publicación oficial y sus modificaciones?",
    context: "Supuesto abstracto de una consulta sobre el IRPF del ejercicio 2022; se comparan la publicación oficial, las modificaciones posteriores y una consolidación informativa a fecha determinada.",
    taxOrProcedure: 'IRPF_historical_rule',
    taxpayer: 'individual; facts and tax year required',
    taxYear: 2022, filingYear: 2023,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [
      {
        "documentId": "BOE-A-2006-20764-consolidated",
        "sourceUrl": "https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764&p=20221231&tn=1",
        "version": "consolidated-snapshot-as-of-2022-12-31",
        "locator": "BOE consolidated-text disclaimer and selected version date",
        "excerpt": "Este texto consolidado es de carácter informativo y no tiene valor jurídico.",
        "capturedAt": "2026-11-02"
      },
      {
        "documentId": "BOE-A-2006-20764",
        "sourceUrl": "https://www.boe.es/eli/es/l/2006/11/28/35",
        "version": "official-original-publication",
        "locator": "Original publication metadata for BOE-A-2006-20764",
        "recordedFacts": [
          "Official publication: 2006-11-29",
          "Entry into force: 2007-01-01"
        ],
        "capturedAt": "2026-11-02"
      }
    ],
    dates: { publicationDate: '2006-11-29', effectiveDate: '2007-01-01', eventDate: '2022-12-31', referenceDate: '2023-06-30' },
    documents: [{ id: 'BOE-A-2006-20764', authority: 'official_publication', url: 'https://www.boe.es/eli/es/l/2006/11/28/35', locator: 'Original official publication and dated amending provisions' }, { id: 'BOE-A-2006-20764-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764', locator: 'BOE warning: consolidated text is informative and has no legal value' }],
    expected: { citationIds: ["BOE-A-2006-20764","BOE-A-2006-20764-consolidated"], outcome: 'prefer_official_publication_for_legal_proof', consolidatedTextMayAidNavigation: true, consolidatedTextIsNotOfficialPublication: true, requireVersionAtEventDate: true },
    tags: ['normative-discrepancy', 'source-hierarchy'], reviewStatus: 'pending'
  },
  {
    id: 'ES-TAX-INSUFFICIENT-JURISDICTION-AND-FACTS',
    jurisdiction: { state: null, autonomousCommunity: null, municipality: null },
    question: "¿Puede determinarse la norma fiscal aplicable si no se identifica el Estado, la residencia ni la fecha del hecho?",
    context: "No se facilita jurisdicción, comunidad autónoma, municipio, tipo de contribuyente, impuesto concreto ni fecha del hecho; no se añade contexto financiero ni personal.",
    taxOrProcedure: 'unspecified_personal_tax_question',
    taxpayer: 'unknown',
    taxYear: 2024, filingYear: 2025,
    capturedAt: '2026-11-02',
    evidenceSnapshots: [],
    dates: { publicationDate: null, effectiveDate: null, eventDate: null, referenceDate: '2025-06-01' },
    documents: [],
    expected: { citationIds: [], outcome: 'abstain_insufficient_context', requiredFacts: ['state', 'autonomousCommunity_when_relevant', 'municipality_when_local_tax', 'taxpayer_type', 'tax_or_procedure', 'eventDate'], doNotInfer: ['location_from_network', 'residency_from_currency', 'taxpayer_type_from_financial_movements'] },
    tags: ['abstention', 'privacy', 'missing-context'], reviewStatus: 'pending'
  },
  {
    id: 'ES-MADRID-IBI-2026-MUNICIPAL-ORDINANCE',
    jurisdiction: { state: 'ES', autonomousCommunity: 'MD', municipality: 'Madrid' },
    question: "¿Puede determinarse el tipo de IBI aplicable en Madrid para 2026 sin conocer la naturaleza, el uso y el valor catastral del inmueble?",
    context: "Supuesto abstracto de inmueble situado en Madrid para el devengo de 2026; no se aportan uso, clasificación catastral, valor catastral, titularidad ni posibles bonificaciones.",
    taxOrProcedure: 'IBI',
    taxpayer: 'Holder of a right over an urban or rural property in Madrid; property classification and cadastral facts not supplied',
    taxYear: 2026, filingYear: null,
    capturedAt: '2026-11-02',
    dates: { publicationDate: '2025-12-26', effectiveDate: null, eventDate: '2026-01-01', referenceDate: '2026-11-02' },
    documents: [
      { id: 'BOE-A-2004-4214', authority: 'official_publication', url: 'https://www.boe.es/eli/es/rdlg/2004/03/05/2', locator: 'Real Decreto Legislativo 2/2004, official original publication' },
      { id: 'BOE-A-2004-4214-consolidated', authority: 'informative_consolidation', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2004-4214&p=20260101&tn=1', locator: 'Consolidated text selected as of 01/01/2026; Article 75, accrual and tax period; informational only' },
      { id: 'ANM-2025-141', authority: 'official_municipal_ordinance', url: 'https://sede.madrid.es/eli/es-md-01860896/odnz/1989/12/22/(1)/con/20251226/spa/html', locator: 'Madrid IBI ordinance, ANM 2025\\141, wording current for tax year 2026; Chapter VI, articles 8-9' }
    ],
    evidenceSnapshots: [
      {
        documentId: 'BOE-A-2004-4214',
        sourceUrl: 'https://www.boe.es/eli/es/rdlg/2004/03/05/2',
        version: 'official-original-publication',
        locator: 'Official BOE publication record for the consolidated Local Finance Act',
        recordedFacts: ['Published: 2004-03-09', 'Entry into force: 2004-03-10', 'Includes the statutory framework for IBI'],
        capturedAt: '2026-11-02'
      },
      {
        documentId: 'BOE-A-2004-4214-consolidated',
        sourceUrl: 'https://www.boe.es/buscar/act.php?id=BOE-A-2004-4214&p=20260101&tn=1',
        version: 'consolidated-text-as-of-2026-01-01',
        locator: 'Article 75(1)-(2), accrual on the first day of the tax period; the tax period coincides with the calendar year',
        excerpt: 'El impuesto se devengará el primer día del período impositivo. El período impositivo coincide con el año natural.',
        capturedAt: '2026-11-02'
      },
      {
        documentId: 'ANM-2025-141',
        sourceUrl: 'https://sede.madrid.es/eli/es-md-01860896/odnz/1989/12/22/(1)/con/20251226/spa/html',
        version: 'consolidated-municipal-ordinance-as-of-2025-12-26',
        locator: 'Official Madrid ordinance record, ANM 2025\\141; version current for 2026; Chapter VI on rates',
        recordedFacts: ['Last update published: 2025-12-26', 'The official record states the wording is current for 2026', 'Articles 8-9 distinguish general and differentiated property rates'],
        capturedAt: '2026-11-02'
      }
    ],
    expected: {
      citationIds: ['BOE-A-2004-4214', 'BOE-A-2004-4214-consolidated', 'ANM-2025-141'],
      outcome: 'abstain_missing_property_classification',
      requiredFacts: ['property_municipality', 'property_nature', 'cadastral_value', 'property_use', 'tax_year'],
      doNotInfer: ['property_use_from_residence', 'municipal_rate_without_property_classification', 'bonifications', 'tax_due']
    },
    tags: ['municipal-jurisdiction', 'local-tax', 'source-hierarchy', 'abstention'],
    reviewStatus: 'pending'
  },
] as const;
