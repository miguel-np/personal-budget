import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ReviewRecordSchema = z.object({
  findingId: z.string().trim().min(1).max(200),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  status: z.enum(['reviewed', 'dismissed', 'snoozed']),
  snoozedUntil: z.string().regex(ISO_DATE).optional(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((record, context) => {
  if (record.status === 'snoozed' && !record.snoozedUntil) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'A snoozed finding requires an expiry date.' });
  }
  if (record.status !== 'snoozed' && record.snoozedUntil !== undefined) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Only snoozed findings may have an expiry date.' });
  }
});

export type FindingReviewRecord = z.infer<typeof ReviewRecordSchema>;

const ReviewStateSchema = z.object({
  version: z.literal(1),
  reviews: z.array(ReviewRecordSchema).max(5_000),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  state.reviews.forEach((review, index) => {
    if (ids.has(review.findingId)) context.addIssue({ code: 'custom', path: ['reviews', index, 'findingId'], message: 'Finding review IDs must be unique.' });
    ids.add(review.findingId);
  });
});

export type FindingReviewState = z.infer<typeof ReviewStateSchema>;
const MAX_REVIEW_FILE_BYTES = 1024 * 1024;
const locks = new Map<string, Promise<void>>();

function statePath(dataDirectory: string): string {
  return resolve(dataDirectory, 'financial-intelligence-state.json');
}

export function emptyFindingReviewState(): FindingReviewState {
  return { version: 1, reviews: [] };
}

export async function readFindingReviewState(dataDirectory: string): Promise<FindingReviewState> {
  let content: string;
  try {
    content = await readFile(statePath(dataDirectory), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyFindingReviewState();
    throw error;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_REVIEW_FILE_BYTES) {
    throw new Error('Financial intelligence review state exceeds its permitted size.');
  }
  return ReviewStateSchema.parse(JSON.parse(content) as unknown);
}

async function writeFindingReviewState(dataDirectory: string, state: FindingReviewState): Promise<void> {
  const parsed = ReviewStateSchema.parse(state);
  const content = JSON.stringify(parsed, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_REVIEW_FILE_BYTES) {
    throw new RangeError('Financial intelligence review state exceeds its permitted size.');
  }
  const path = statePath(dataDirectory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function withLock<T>(dataDirectory: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(dataDirectory);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  locks.set(key, gate);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === gate) locks.delete(key);
  }
}

/** Persists finding identity and review metadata, never amounts or transaction details. */
export async function updateFindingReviewState(
  dataDirectory: string,
  next: FindingReviewRecord,
): Promise<FindingReviewState> {
  const parsed = ReviewRecordSchema.parse(next);
  return withLock(dataDirectory, async () => {
    const current = await readFindingReviewState(dataDirectory);
    const reviews = current.reviews.filter((review) => review.findingId !== parsed.findingId);
    reviews.push(parsed);
    reviews.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.findingId.localeCompare(right.findingId));
    const state = ReviewStateSchema.parse({ version: 1, reviews: reviews.slice(0, 5_000) });
    await writeFindingReviewState(dataDirectory, state);
    return state;
  });
}

export function effectiveFindingReview(
  record: FindingReviewRecord | undefined,
  fingerprint: string,
  today: string,
): { readonly status: 'new' | 'reviewed' | 'dismissed' | 'snoozed'; readonly snoozedUntil?: string } {
  if (!record || record.fingerprint !== fingerprint) return { status: 'new' };
  if (record.status === 'snoozed') {
    if (!record.snoozedUntil || record.snoozedUntil < today) return { status: 'new' };
    return { status: 'snoozed', snoozedUntil: record.snoozedUntil };
  }
  return { status: record.status };
}
