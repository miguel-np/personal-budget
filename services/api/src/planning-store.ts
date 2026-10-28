import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { AccountScopePreferenceSchema } from './account-scope.js';

const safeInteger = z.number().int().refine(Number.isSafeInteger, 'Amount must be a safe integer.');
const positiveMinor = safeInteger.positive();
const nonNegativeMinor = safeInteger.nonnegative();
const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Currency must be a three-letter uppercase code.');
const scopeSchema = AccountScopePreferenceSchema;

export const PlanningGoalInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  targetAmountMinor: positiveMinor,
  initialAmountMinor: nonNegativeMinor,
  monthlyContributionMinor: nonNegativeMinor,
  targetDate: z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value, 'Target date must be a valid ISO calendar date.'),
  monthlyIncomeMinor: safeInteger.nullable().optional(),
  monthlyExpenseMinor: nonNegativeMinor.nullable().optional(),
}).strict();

export type PlanningGoalInput = z.infer<typeof PlanningGoalInputSchema>;

export const PlanningCommitmentInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  amountMinor: positiveMinor,
  date: z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value, 'Commitment date must be a valid ISO calendar date.'),
  direction: z.enum(['expense', 'income']),
  frequency: z.enum(['once', 'monthly', 'quarterly', 'yearly']),
  notes: z.string().trim().max(500).optional(),
}).strict();

export type PlanningCommitmentInput = z.infer<typeof PlanningCommitmentInputSchema>;

export const StoredPlanningGoalSchema = PlanningGoalInputSchema.extend({
  id: z.string().uuid(),
  currency: currencyCode,
  scope: scopeSchema,
  status: z.enum(['active', 'paused']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const StoredPlanningCommitmentSchema = PlanningCommitmentInputSchema.extend({
  id: z.string().uuid(),
  currency: currencyCode,
  scope: scopeSchema,
  status: z.enum(['active', 'paused']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type StoredPlanningGoal = z.infer<typeof StoredPlanningGoalSchema>;
export type StoredPlanningCommitment = z.infer<typeof StoredPlanningCommitmentSchema>;

export const PlanningDataSchema = z.object({
  version: z.literal(1),
  goals: z.array(StoredPlanningGoalSchema).max(100),
  commitments: z.array(StoredPlanningCommitmentSchema).max(500),
}).strict().superRefine((data, context) => {
  const goalIds = new Set<string>();
  data.goals.forEach((goal, index) => {
    if (goalIds.has(goal.id)) context.addIssue({ code: 'custom', path: ['goals', index, 'id'], message: 'Planning goal IDs must be unique.' });
    goalIds.add(goal.id);
  });
  const commitmentIds = new Set<string>();
  data.commitments.forEach((commitment, index) => {
    if (commitmentIds.has(commitment.id)) context.addIssue({ code: 'custom', path: ['commitments', index, 'id'], message: 'Planning commitment IDs must be unique.' });
    commitmentIds.add(commitment.id);
  });
});

export type PlanningData = z.infer<typeof PlanningDataSchema>;
const MAX_PLANNING_FILE_BYTES = 2 * 1024 * 1024;
const locks = new Map<string, Promise<void>>();

export function emptyPlanningData(): PlanningData {
  return { version: 1, goals: [], commitments: [] };
}

function dataPath(dataDirectory: string): string {
  return resolve(dataDirectory, 'planning-data.json');
}

export async function readPlanningData(dataDirectory: string): Promise<PlanningData> {
  let contents: string;
  try {
    contents = await readFile(dataPath(dataDirectory), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyPlanningData();
    throw error;
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_PLANNING_FILE_BYTES) {
    throw new Error('Local planning data exceeds its permitted size.');
  }
  return PlanningDataSchema.parse(JSON.parse(contents) as unknown);
}

/** Validates and atomically replaces the app-owned planning file with private permissions. */
export async function writePlanningData(dataDirectory: string, data: PlanningData): Promise<void> {
  const parsed = PlanningDataSchema.parse(data);
  const contents = JSON.stringify(parsed, null, 2) + '\n';
  if (Buffer.byteLength(contents, 'utf8') > MAX_PLANNING_FILE_BYTES) {
    throw new RangeError('Local planning data exceeds its permitted size.');
  }
  const path = dataPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Serializes read/modify/write operations inside the API process to avoid lost updates. */
async function withPlanningDataLock<T>(dataDirectory: string, action: () => Promise<T>): Promise<T> {
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

export async function updatePlanningData<T>(
  dataDirectory: string,
  update: (current: PlanningData) => { readonly data: PlanningData; readonly result: T },
): Promise<T> {
  return withPlanningDataLock(dataDirectory, async () => {
    const current = await readPlanningData(dataDirectory);
    const outcome = update(current);
    await writePlanningData(dataDirectory, outcome.data);
    return outcome.result;
  });
}

/** Explicit reset can clear a corrupt local file, but still serializes with all other mutations. */
export async function resetPlanningData(dataDirectory: string): Promise<void> {
  await withPlanningDataLock(dataDirectory, () => writePlanningData(dataDirectory, emptyPlanningData()));
}
