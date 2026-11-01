import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const safeNonNegative = z.number().int().refine(Number.isSafeInteger).nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const BudgetAlertRuleSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().trim().min(1).max(128),
  metric: z.enum(['percent_used', 'remaining_minor', 'overspend_minor', 'overspend_percent']),
  threshold: safeNonNegative.max(1_000_000_000_000),
  enabled: z.boolean(),
}).strict();
const BudgetAlertEventSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  ruleId: z.string().uuid(),
  categoryId: z.string().trim().min(1).max(128),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  status: z.enum(['dismissed', 'snoozed']),
  snoozedUntil: isoDate.optional(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((event, context) => {
  if (event.status === 'snoozed' && !event.snoozedUntil) context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Snoozed alerts require an expiry date.' });
  if (event.status === 'dismissed' && event.snoozedUntil) context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Dismissed alerts cannot carry a snooze expiry.' });
});
const CategoryPreferenceSchema = z.object({
  categoryId: z.string().trim().min(1).max(128),
  classification: z.enum(['unclassified', 'essential', 'protected', 'flexible', 'reviewable']),
}).strict();
const DecisionSchema = z.object({
  proposalId: z.string().trim().min(1).max(256),
  status: z.enum(['accepted', 'rejected', 'postponed']),
  updatedAt: z.string().datetime(),
}).strict();
const ReductionSchema = z.object({
  categoryId: z.string().trim().min(1).max(128),
  reductionPercent: z.number().int().min(1).max(100),
}).strict();
const ScenarioSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  startDate: isoDate,
  endDate: isoDate,
  currency: z.string().regex(/^[A-Z]{3}$/),
  accountScopeSignature: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reductions: z.array(ReductionSchema).max(100),
  estimatedMonthlySavingsMinor: safeNonNegative,
  estimatedAnnualSavingsMinor: safeNonNegative,
  createdAt: z.string().datetime(),
}).strict();
export const FinancialActionStateSchema = z.object({
  version: z.literal(1),
  budgetAlerts: z.object({
    rules: z.array(BudgetAlertRuleSchema).max(500),
    events: z.array(BudgetAlertEventSchema).max(2_000),
  }).strict(),
  budgetImprovements: z.object({
    goal: z.enum(['increase_monthly_margin', 'reduce_variable_spending', 'reach_savings_goal', 'free_cash_flow']),
    categories: z.array(CategoryPreferenceSchema).max(500),
    decisions: z.array(DecisionSchema).max(2_000),
    scenarios: z.array(ScenarioSchema).max(100),
  }).strict(),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  state.budgetAlerts.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) context.addIssue({ code: 'custom', path: ['budgetAlerts', 'rules', index, 'id'], message: 'Alert rule IDs must be unique.' });
    ids.add(rule.id);
  });
  const categoryIds = new Set<string>();
  state.budgetImprovements.categories.forEach((category, index) => {
    if (categoryIds.has(category.categoryId)) context.addIssue({ code: 'custom', path: ['budgetImprovements', 'categories', index, 'categoryId'], message: 'Category preferences must be unique.' });
    categoryIds.add(category.categoryId);
  });
});
export type FinancialActionState = z.infer<typeof FinancialActionStateSchema>;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const locks = new Map<string, Promise<void>>();
export function emptyFinancialActionState(): FinancialActionState {
  return {
    version: 1,
    budgetAlerts: { rules: [], events: [] },
    budgetImprovements: { goal: 'increase_monthly_margin', categories: [], decisions: [], scenarios: [] },
  };
}
function statePath(directory: string): string { return resolve(directory, 'financial-actions.json'); }
export async function readFinancialActionState(directory: string): Promise<FinancialActionState> {
  let content: string;
  try { content = await readFile(statePath(directory), 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyFinancialActionState(); throw error; }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Financial action state exceeds its permitted size.');
  return FinancialActionStateSchema.parse(JSON.parse(content) as unknown);
}
async function writeState(directory: string, value: FinancialActionState): Promise<void> {
  const data = FinancialActionStateSchema.parse(value);
  const content = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new RangeError('Financial action state exceeds its permitted size.');
  const path = statePath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally { await rm(temporaryPath, { force: true }).catch(() => undefined); }
}
async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(directory);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  locks.set(key, gate);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(key) === gate) locks.delete(key); }
}
export async function updateFinancialActionState<T>(
  directory: string,
  update: (current: FinancialActionState) => { readonly state: FinancialActionState; readonly result: T },
): Promise<T> {
  return withLock(directory, async () => {
    const current = await readFinancialActionState(directory);
    const result = update(current);
    const parsed = FinancialActionStateSchema.parse(result.state);
    await writeState(directory, parsed);
    return result.result;
  });
}
