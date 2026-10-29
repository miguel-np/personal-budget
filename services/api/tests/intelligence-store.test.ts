import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { effectiveFindingReview, readFindingReviewState, updateFindingReviewState } from '../src/intelligence-store.js';

const directories: string[] = [];
async function makeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pb-intelligence-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('financial intelligence review state', () => {
  it('persists review metadata without transaction details or amounts', async () => {
    const path = await makeDirectory();
    const record = {
      findingId: 'fi-v1-pending-categorization-2026-10-01-2026-10-31-abcd1234abcd1234',
      fingerprint: '1234567890abcdef',
      status: 'dismissed' as const,
      updatedAt: '2026-10-29T12:00:00.000Z',
    };
    await updateFindingReviewState(path, record);
    expect(await readFindingReviewState(path)).toEqual({ version: 1, reviews: [record] });
    const raw = await readFile(join(path, 'financial-intelligence-state.json'), 'utf8');
    expect(raw).not.toContain('amountMinor');
    expect(raw).not.toContain('notes');
  });

  it('deduplicates decisions and resets them when the evidence fingerprint changes', async () => {
    const path = await makeDirectory();
    const base = {
      findingId: 'fi-v1-example',
      fingerprint: '1234567890abcdef',
      status: 'reviewed' as const,
      updatedAt: '2026-10-29T12:00:00.000Z',
    };
    await updateFindingReviewState(path, base);
    await updateFindingReviewState(path, { ...base, fingerprint: 'fedcba0987654321', status: 'dismissed', updatedAt: '2026-10-29T13:00:00.000Z' });
    const state = await readFindingReviewState(path);
    expect(state.reviews).toHaveLength(1);
    expect(effectiveFindingReview(state.reviews[0]!, '1234567890abcdef', '2026-10-29')).toEqual({ status: 'new' });
    expect(effectiveFindingReview(state.reviews[0]!, 'fedcba0987654321', '2026-10-29')).toEqual({ status: 'dismissed' });
  });

  it('persists an expected decision until evidence changes materially', async () => {
    const path = await makeDirectory();
    const expected = {
      findingId: 'fi-v1-expected', fingerprint: '1234567890abcdef', status: 'expected' as const,
      updatedAt: '2026-10-29T12:00:00.000Z',
    };
    await updateFindingReviewState(path, expected);
    const record = (await readFindingReviewState(path)).reviews[0]!;
    expect(effectiveFindingReview(record, expected.fingerprint, '2026-10-29')).toEqual({ status: 'expected' });
    expect(effectiveFindingReview(record, 'fedcba0987654321', '2026-10-29')).toEqual({ status: 'new' });
  });

  it('expires snoozes after the stored date and rejects an invalid snooze record', async () => {
    const path = await makeDirectory();
    const snoozed = {
      findingId: 'fi-v1-snoozed',
      fingerprint: '1234567890abcdef',
      status: 'snoozed' as const,
      snoozedUntil: '2026-10-29',
      updatedAt: '2026-10-28T12:00:00.000Z',
    };
    await updateFindingReviewState(path, snoozed);
    const record = (await readFindingReviewState(path)).reviews[0]!;
    expect(effectiveFindingReview(record, snoozed.fingerprint, '2026-10-29').status).toBe('snoozed');
    expect(effectiveFindingReview(record, snoozed.fingerprint, '2026-10-30')).toEqual({ status: 'new' });
    await expect(updateFindingReviewState(path, { ...snoozed, snoozedUntil: undefined } as never)).rejects.toThrow();
  });
});
