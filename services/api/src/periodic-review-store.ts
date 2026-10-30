import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DateSchema = z.string().regex(ISO_DATE).refine((value) => {
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const FindingTypeSchema = z.enum([
  'expense-change', 'income-change', 'budget-overspend', 'pending-categorization',
  'commitment-upcoming', 'recurring-candidate-upcoming', 'goal-at-risk', 'goal-progress', 'financial-anomaly',
]);
const ReviewItemSchema = z.object({
  findingId: z.string().trim().min(1).max(200),
  findingType: FindingTypeSchema,
  status: z.enum(['pending', 'reviewed', 'postponed']),
  postponedUntil: DateSchema.optional(),
}).strict().superRefine((item, context) => {
  if (item.status === 'postponed' && !item.postponedUntil) {
    context.addIssue({ code: 'custom', path: ['postponedUntil'], message: 'Postponed items require an expiry date.' });
  }
  if (item.status !== 'postponed' && item.postponedUntil !== undefined) {
    context.addIssue({ code: 'custom', path: ['postponedUntil'], message: 'Only postponed items may have an expiry date.' });
  }
});

export const PeriodicReviewRunSchema = z.object({
  id: z.string().uuid(),
  periodType: z.enum(['weekly', 'monthly']),
  startDate: DateSchema,
  endDate: DateSchema,
  generatedAt: z.string().datetime(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  accountScope: z.object({
    mode: z.enum(['all', 'selected']),
    label: z.string().trim().min(1).max(500),
  }).strict(),
  status: z.enum(['in_progress', 'completed']),
  completedAt: z.string().datetime().optional(),
  items: z.array(ReviewItemSchema).max(100),
}).strict().superRefine((run, context) => {
  if (run.startDate > run.endDate) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: 'Review period is inverted.' });
  }
  const ids = new Set<string>();
  run.items.forEach((item, index) => {
    if (ids.has(item.findingId)) context.addIssue({ code: 'custom', path: ['items', index, 'findingId'], message: 'Finding IDs must be unique within a review.' });
    ids.add(item.findingId);
  });
  const allHandled = run.items.every((item) => item.status !== 'pending');
  if (run.status === 'completed' && !allHandled) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'A completed review cannot contain pending items.' });
  }
  if (run.status === 'completed' && !run.completedAt) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Completed reviews require a completion timestamp.' });
  }
  if (run.status === 'in_progress' && run.completedAt !== undefined) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'In-progress reviews cannot have a completion timestamp.' });
  }
});

export type PeriodicReviewItem = z.infer<typeof ReviewItemSchema>;
export type PeriodicReviewRun = z.infer<typeof PeriodicReviewRunSchema>;

const StateSchema = z.object({
  version: z.literal(1),
  reviews: z.array(PeriodicReviewRunSchema).max(200),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  state.reviews.forEach((review, index) => {
    if (ids.has(review.id)) context.addIssue({ code: 'custom', path: ['reviews', index, 'id'], message: 'Review IDs must be unique.' });
    ids.add(review.id);
  });
});

export type PeriodicReviewState = z.infer<typeof StateSchema>;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const locks = new Map<string, Promise<void>>();

function statePath(dataDirectory: string): string {
  return resolve(dataDirectory, 'periodic-reviews.json');
}

export function emptyPeriodicReviewState(): PeriodicReviewState {
  return { version: 1, reviews: [] };
}

export async function readPeriodicReviewState(dataDirectory: string): Promise<PeriodicReviewState> {
  let content: string;
  try {
    content = await readFile(statePath(dataDirectory), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyPeriodicReviewState();
    throw error;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Periodic review state exceeds its permitted size.');
  }
  return StateSchema.parse(JSON.parse(content) as unknown);
}

async function writeState(dataDirectory: string, state: PeriodicReviewState): Promise<void> {
  const parsed = StateSchema.parse(state);
  const content = JSON.stringify(parsed, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new RangeError('Periodic review state exceeds its permitted size.');
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

/** Saves only review metadata and finding references; transaction and narrative data are never stored. */
export async function createPeriodicReview(
  dataDirectory: string,
  input: Omit<PeriodicReviewRun, 'id' | 'generatedAt' | 'status' | 'completedAt'>,
): Promise<PeriodicReviewRun> {
  return withLock(dataDirectory, async () => {
    const current = await readPeriodicReviewState(dataDirectory);
    const generatedAt = new Date().toISOString();
    const allHandled = input.items.every((item) => item.status !== 'pending');
    const review = PeriodicReviewRunSchema.parse({
      ...input,
      id: randomUUID(),
      generatedAt,
      status: allHandled ? 'completed' : 'in_progress',
      ...(allHandled ? { completedAt: generatedAt } : {}),
    });
    const reviews = [review, ...current.reviews].slice(0, 200);
    await writeState(dataDirectory, StateSchema.parse({ version: 1, reviews }));
    return review;
  });
}

export async function updatePeriodicReviewItem(
  dataDirectory: string,
  reviewId: string,
  findingId: string,
  status: 'reviewed' | 'postponed',
  postponedUntil?: string,
): Promise<PeriodicReviewRun | null> {
  return withLock(dataDirectory, async () => {
    const current = await readPeriodicReviewState(dataDirectory);
    const existing = current.reviews.find((item) => item.id === reviewId);
    if (!existing || !existing.items.some((item) => item.findingId === findingId)) return null;
    const now = new Date().toISOString();
    const items = existing.items.map((item) => item.findingId !== findingId ? item : ReviewItemSchema.parse({
      findingId: item.findingId,
      findingType: item.findingType,
      status,
      ...(status === 'postponed' && postponedUntil ? { postponedUntil } : {}),
    }));
    const allHandled = items.every((item) => item.status !== 'pending');
    const updated = PeriodicReviewRunSchema.parse({
      ...existing,
      items,
      status: allHandled ? 'completed' : 'in_progress',
      ...(allHandled ? { completedAt: existing.completedAt ?? now } : {}),
      ...(!allHandled ? { completedAt: undefined } : {}),
    });
    const reviews = current.reviews.map((item) => item.id === reviewId ? updated : item);
    await writeState(dataDirectory, StateSchema.parse({ version: 1, reviews }));
    return updated;
  });
}
