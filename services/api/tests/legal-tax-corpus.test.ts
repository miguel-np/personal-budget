import { describe, expect, it } from 'vitest';
import { legalTaxCorpus } from './fixtures/legal-tax-corpus.js';

describe('legal/tax regression corpus (#108)', () => {
  it('contains at least twelve stable, source-pinned cases across jurisdictions and tax years', () => {
    expect(legalTaxCorpus.length).toBeGreaterThanOrEqual(12);
    expect(new Set(legalTaxCorpus.map((item) => item.id)).size).toBe(legalTaxCorpus.length);
    expect(new Set(legalTaxCorpus.map((item) => item.jurisdiction.state).filter(Boolean)).size).toBeGreaterThanOrEqual(1);
    expect(legalTaxCorpus.some((item) => item.jurisdiction.autonomousCommunity === 'GA')).toBe(true);
    expect(new Set(legalTaxCorpus.map((item) => item.taxYear).filter((year) => typeof year === 'number')).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps tax year, filing year, event date and reference date independent', () => {
    for (const item of legalTaxCorpus) {
      expect(item).toHaveProperty('taxYear');
      expect(item).toHaveProperty('filingYear');
      expect(item.dates).toHaveProperty('eventDate');
      expect(item.dates).toHaveProperty('referenceDate');
    }
    expect(legalTaxCorpus.find((item) => item.id === 'ES-IRPF-2023-FILING-2024')).toMatchObject({
      taxYear: 2023, filingYear: 2024,
    });
  });

  it('covers at least three explicit transitional/effective-date boundaries', () => {
    const temporal = legalTaxCorpus.filter((item) =>
      item.tags.some((tag) => ['transitional', 'effective-date', 'boundary-before', 'boundary-after'].includes(tag)));
    expect(temporal.length).toBeGreaterThanOrEqual(3);
    expect(legalTaxCorpus.find((item) => item.id === 'ES-BOE-ARTICLE-32-2022-03-30')?.expected)
      .toMatchObject({ selectedNorm: 'BOE-A-2015-10565' });
    expect(legalTaxCorpus.find((item) => item.id === 'ES-BOE-ARTICLE-32-2022-03-31')?.expected)
      .toMatchObject({ selectedNorm: 'BOE-A-2022-4972' });
  });

  it('covers at least three distinct source/version discrepancy scenarios', () => {
    const discrepancies = legalTaxCorpus.filter((item) =>
      item.tags.some((tag) => ['version-conflict', 'normative-discrepancy', 'publication-discrepancy'].includes(tag)));
    expect(discrepancies.length).toBeGreaterThanOrEqual(3);
  });

  it('requires primary-source provenance or an explicit abstention for every case', () => {
    for (const item of legalTaxCorpus) {
      expect(item.expected.outcome).toBeTruthy();
      expect(item.reviewStatus).toBe('pending');
      if (item.expected.outcome.startsWith('abstain')) continue;
      expect(item.documents.length).toBeGreaterThan(0);
      expect(item.documents.some((document) => document.authority === 'official_publication')).toBe(true);
      for (const document of item.documents) {
        expect(document.url).toMatch(/^https:\/\//);
        expect(document.locator.length).toBeGreaterThan(0);
      }
    }
  });

  it('does not silently turn the draft corpus into reviewed legal advice', () => {
    expect(legalTaxCorpus.every((item) => item.reviewStatus === 'pending')).toBe(true);
    expect(legalTaxCorpus.find((item) => item.id === 'ES-TAX-INSUFFICIENT-JURISDICTION-AND-FACTS')?.expected)
      .toMatchObject({ outcome: 'abstain_insufficient_context' });
  });
});
