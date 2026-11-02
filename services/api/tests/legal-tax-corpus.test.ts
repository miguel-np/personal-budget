import { describe, expect, it } from 'vitest';
import { legalTaxCorpus } from './fixtures/legal-tax-corpus.js';

describe('legal/tax regression corpus (#108)', () => {
  it('contains at least twelve stable cases across state and autonomous-community jurisdiction and multiple tax years', () => {
    expect(legalTaxCorpus.length).toBeGreaterThanOrEqual(13);
    expect(new Set(legalTaxCorpus.map((item) => item.id)).size).toBe(legalTaxCorpus.length);
    expect(legalTaxCorpus.some((item) => item.jurisdiction.state === 'ES')).toBe(true);
    expect(legalTaxCorpus.some((item) => item.jurisdiction.autonomousCommunity === 'GA')).toBe(true);
    expect(legalTaxCorpus.some((item) => item.jurisdiction.autonomousCommunity === 'MD' && item.jurisdiction.municipality === 'Madrid')).toBe(true);
    expect(new Set(legalTaxCorpus.map((item) => item.taxYear).filter((year) => typeof year === 'number')).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps tax year, filing year, event date and reference date independent', () => {
    for (const item of legalTaxCorpus) {
      expect(item.question.length).toBeGreaterThan(20);
      expect(item.context.length).toBeGreaterThan(20);
      expect(item.context).not.toMatch(/\\b\\d{8}[A-Z]\\b/);
      expect(item).toHaveProperty('taxYear');
      expect(item).toHaveProperty('filingYear');
      expect(item.dates).toHaveProperty('eventDate');
      expect(item.dates).toHaveProperty('referenceDate');
    }
    expect(legalTaxCorpus.find((item) => item.id === 'ES-IRPF-2023-FILING-2024')).toMatchObject({
      taxYear: 2023, filingYear: 2024,
    });
    expect(legalTaxCorpus.find((item) => item.id === 'ES-IVA-2024-DECREE-9-2024-REPEAL')).toMatchObject({
      taxYear: 2025, filingYear: null,
      dates: { eventDate: '2025-01-10', referenceDate: '2025-01-23', repealPublicationDate: '2025-01-23' },
    });
  });

  it('covers at least three explicit transitional or effective-date boundaries', () => {
    const temporal = legalTaxCorpus.filter((item) =>
      item.tags.some((tag) => ['transitional', 'effective-date', 'boundary-before', 'boundary-after'].includes(tag)));
    expect(temporal.length).toBeGreaterThanOrEqual(3);
    expect(legalTaxCorpus.find((item) => item.id === 'ES-BOE-ARTICLE-32-2022-03-30')?.expected)
      .toMatchObject({ selectedNorm: 'BOE-A-2015-10565' });
    expect(legalTaxCorpus.find((item) => item.id === 'ES-BOE-ARTICLE-32-2022-03-31')?.expected)
      .toMatchObject({ selectedNorm: 'BOE-A-2022-4972' });
    expect(legalTaxCorpus.find((item) => item.id === 'ES-IVA-2024-DECREE-9-2024-REPEAL')?.expected)
      .toMatchObject({ outcome: 'flag_temporal_conflict_and_abstain_on_effects', doNotAssumeRetrospectiveEffect: true });
  });

  it('covers at least three distinct publication, version and authority discrepancies', () => {
    const discrepancies = legalTaxCorpus.filter((item) =>
      item.tags.some((tag) => ['version-conflict', 'normative-discrepancy', 'publication-discrepancy'].includes(tag)));
    expect(discrepancies.length).toBeGreaterThanOrEqual(3);
    expect(legalTaxCorpus.find((item) => item.id === 'ES-GALICIA-LAW-5-2024-DOG-BOE-DATE-DISCREPANCY')?.documents.map((d) => d.id))
      .toEqual(expect.arrayContaining(['DOG-g-2024-90260', 'BOE-A-2025-2145']));
  });

  it('pins each cited expected result to a declared source and a dated evidence snapshot', () => {
    for (const item of legalTaxCorpus) {
      const documentIds = item.documents.map((document) => document.id);
      const snapshotIds = item.evidenceSnapshots.map((snapshot) => snapshot.documentId);
      for (const citationId of item.expected.citationIds) {
        expect(documentIds).toContain(citationId);
        expect(snapshotIds).toContain(citationId);
      }

      if (item.documents.length === 0) {
        expect(item.expected.outcome).toMatch(/^abstain/);
        expect(item.evidenceSnapshots).toHaveLength(0);
        continue;
      }

      expect(item.evidenceSnapshots.length).toBeGreaterThan(0);
      for (const snapshot of item.evidenceSnapshots) {
        expect(documentIds).toContain(snapshot.documentId);
        expect(snapshot.sourceUrl).toMatch(/^https:\/\//);
        expect(snapshot.version.length).toBeGreaterThan(0);
        expect(snapshot.locator.length).toBeGreaterThan(0);
        expect(snapshot.capturedAt).toBe(item.capturedAt);
        const excerpt = 'excerpt' in snapshot ? snapshot.excerpt : undefined;
        const recordedFacts = 'recordedFacts' in snapshot ? snapshot.recordedFacts : undefined;
        expect(Boolean(excerpt) || (Array.isArray(recordedFacts) && recordedFacts.length > 0)).toBe(true);
        if (excerpt) expect(excerpt.length).toBeLessThanOrEqual(250);
      }
    }
  });

  it('keeps statutes, official publications, consolidations and administrative guides distinct', () => {
    expect(legalTaxCorpus.find((item) => item.id === 'ES-IRPF-2024-FILING-2025')?.documents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'BOE-A-2006-20764', authority: 'official_publication' }),
        expect.objectContaining({ id: 'AEAT-IRPF-2024-MODEL100', authority: 'administrative_guide' }),
      ]));
    expect(legalTaxCorpus.find((item) => item.id === 'ES-IRPF-CONSOLIDATED-VS-OFFICIAL-PUBLICATION')?.documents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ authority: 'official_publication' }),
        expect.objectContaining({ authority: 'informative_consolidation' }),
      ]));
  });

  it('requires explicit abstention when jurisdiction, facts or source scope are insufficient', () => {
    expect(legalTaxCorpus.find((item) => item.id === 'ES-TAX-INSUFFICIENT-JURISDICTION-AND-FACTS')?.expected)
      .toMatchObject({ outcome: 'abstain_insufficient_context' });
    expect(legalTaxCorpus.find((item) => item.id === 'ES-GALICIA-LAW-6-2023-SCOPE-ABSTENTION')?.expected)
      .toMatchObject({ outcome: 'abstain_scope_mismatch' });
  });

  it('keeps the corpus pending legal review until a competent reviewer signs off', () => {
    expect(legalTaxCorpus.every((item) => item.reviewStatus === 'pending')).toBe(true);
  });
});
