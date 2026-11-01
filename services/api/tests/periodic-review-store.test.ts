import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPeriodicReview, readPeriodicReviewState, updatePeriodicReviewItem } from '../src/periodic-review-store.js';

const directories: string[] = [];
const fingerprint = (label: string): string => createHash('sha256').update(label).digest('hex').slice(0, 16);
const scopeAllFingerprint = fingerprint('synthetic scope all');
const scopeSelectedFingerprint = fingerprint('synthetic scope selected');
const identityA = fingerprint('synthetic identity a');
const identityB = fingerprint('synthetic identity b');
const evidenceA = fingerprint('synthetic evidence a');
const evidenceB = fingerprint('synthetic evidence b');
const fullA = fingerprint('synthetic full fingerprint a');
const fullB = fingerprint('synthetic full fingerprint b');
async function makeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pb-periodic-review-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('periodic review store', () => {
  it('creates versioned metadata without copying financial records or narrative content', async () => {
    const directory = await makeDirectory();
    const review = await createPeriodicReview(directory, {
      periodType: 'monthly',
      startDate: '2026-10-01',
      endDate: '2026-10-30',
      currency: 'EUR',
      accountScope: { mode: 'all', label: 'Todas las cuentas abiertas', fingerprint: scopeAllFingerprint },
      items: [{ findingId: 'pending-categorization:2026-10', findingType: 'pending-categorization', identityKey: identityA, evidenceFingerprint: evidenceA, fingerprint: fullA, status: 'pending' }],
    });

    expect(review).toMatchObject({ periodType: 'monthly', status: 'in_progress', currency: 'EUR' });
    expect(review.id).toMatch(/^[0-9a-f-]{36}$/);
    const saved = await readFile(join(directory, 'periodic-reviews.json'), 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ version: 1, reviews: [{ id: review.id }] });
    expect(saved).not.toContain('amountMinor');
    expect(saved).not.toContain('transaction');
    expect(saved).not.toContain('conversation');
    expect((await readPeriodicReviewState(directory)).reviews).toHaveLength(1);
  });

  it('tracks reviewed and postponed decisions and completes only after all items are handled', async () => {
    const directory = await makeDirectory();
    const review = await createPeriodicReview(directory, {
      periodType: 'weekly',
      startDate: '2026-10-26',
      endDate: '2026-10-30',
      currency: 'EUR',
      accountScope: { mode: 'selected', label: 'Dos cuentas seleccionadas', fingerprint: scopeSelectedFingerprint },
      items: [
        { findingId: 'finding-a', findingType: 'expense-change', identityKey: identityA, evidenceFingerprint: evidenceA, fingerprint: fullA, status: 'pending' },
        { findingId: 'finding-b', findingType: 'financial-anomaly', identityKey: identityB, evidenceFingerprint: evidenceB, fingerprint: fullB, status: 'pending' },
      ],
    });

    const partlyHandled = await updatePeriodicReviewItem(directory, review.id, 'finding-a', 'reviewed');
    expect(partlyHandled?.status).toBe('in_progress');
    expect(partlyHandled?.items[0]).toMatchObject({
      status: 'reviewed',
      identityKey: identityA,
      evidenceFingerprint: evidenceA,
    });

    const completed = await updatePeriodicReviewItem(directory, review.id, 'finding-b', 'postponed', '2026-11-06');
    expect(completed?.status).toBe('completed');
    expect(completed?.completedAt).toBeTruthy();
    expect(completed?.items[1]).toMatchObject({
      status: 'postponed',
      postponedUntil: '2026-11-06',
      identityKey: identityB,
      evidenceFingerprint: evidenceB,
    });
    expect(await updatePeriodicReviewItem(directory, review.id, 'missing', 'reviewed')).toBeNull();
    expect((await readPeriodicReviewState(directory)).reviews[0]?.status).toBe('completed');
  });

  it('keeps concurrent review writes serialized', async () => {
    const directory = await makeDirectory();
    const review = await createPeriodicReview(directory, {
      periodType: 'monthly',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      currency: 'EUR',
      accountScope: { mode: 'all', label: 'Todas las cuentas abiertas', fingerprint: scopeAllFingerprint },
      items: [
        { findingId: 'finding-a', findingType: 'expense-change', identityKey: identityA, evidenceFingerprint: evidenceA, fingerprint: fullA, status: 'pending' },
        { findingId: 'finding-b', findingType: 'income-change', identityKey: identityB, evidenceFingerprint: evidenceB, fingerprint: fullB, status: 'pending' },
      ],
    });
    await Promise.all([
      updatePeriodicReviewItem(directory, review.id, 'finding-a', 'reviewed'),
      updatePeriodicReviewItem(directory, review.id, 'finding-b', 'reviewed'),
    ]);
    expect((await readPeriodicReviewState(directory)).reviews[0]?.status).toBe('completed');
  });

  it('rejects repeated references to the same finding in one review', async () => {
    const directory = await makeDirectory();
    await expect(createPeriodicReview(directory, {
      periodType: 'monthly',
      startDate: '2026-10-01',
      endDate: '2026-10-30',
      currency: 'EUR',
      accountScope: { mode: 'all', label: 'Todas las cuentas abiertas', fingerprint: scopeAllFingerprint },
      items: [
        { findingId: 'same-finding', findingType: 'expense-change', identityKey: identityA, evidenceFingerprint: evidenceA, fingerprint: fullA, status: 'pending' },
        { findingId: 'same-finding', findingType: 'expense-change', identityKey: identityA, evidenceFingerprint: evidenceA, fingerprint: fullA, status: 'pending' },
      ],
    })).rejects.toThrow();
  });

  it('continues reading legacy v1 items that predate stable cross-period identity', async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, 'periodic-reviews.json'), JSON.stringify({
      version: 1,
      reviews: [{
        id: '00000000-0000-4000-8000-000000000001',
        periodType: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        generatedAt: '2026-11-01T00:00:00.000Z',
        currency: 'EUR',
        accountScope: { mode: 'all', label: 'Todas las cuentas abiertas', fingerprint: scopeAllFingerprint },
        status: 'in_progress',
        items: [{
          findingId: 'legacy-period-specific-id',
          findingType: 'pending-categorization',
          fingerprint: fullA,
          status: 'pending',
        }],
      }],
    }));
    const state = await readPeriodicReviewState(directory);
    expect(state.reviews[0]?.items[0]).toMatchObject({
      findingId: 'legacy-period-specific-id',
      status: 'pending',
    });
    expect(state.reviews[0]?.items[0]?.identityKey).toBeUndefined();
    expect(state.reviews[0]?.items[0]?.evidenceFingerprint).toBeUndefined();
  });

  it('rejects malformed persisted schemas rather than silently discarding review history', async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, 'periodic-reviews.json'), JSON.stringify({ version: 2, reviews: [] }));
    await expect(readPeriodicReviewState(directory)).rejects.toThrow();
  });
});
