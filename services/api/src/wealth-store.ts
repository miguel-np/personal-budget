import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const currency = z.string().regex(/^[A-Z]{3}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const safeMinor = z.number().int().refine(Number.isSafeInteger).nonnegative();
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/);

export const WealthKindSchema = z.enum([
  'cash_external', 'investment_portfolio', 'security', 'crypto', 'real_estate',
  'vehicle', 'loan_receivable', 'other_asset', 'loan', 'mortgage', 'other_liability',
]);
export type WealthKind = z.infer<typeof WealthKindSchema>;
export const WealthClassificationSchema = z.enum(['asset', 'liability']);
export type WealthClassification = z.infer<typeof WealthClassificationSchema>;

export const WealthValuationSchema = z.object({
  id: z.string().uuid(),
  valuedAt: isoDate,
  amountMinor: safeMinor,
  currency,
  source: z.enum(['manual', 'statement', 'document']),
  notes: z.string().trim().max(1_000).optional(),
  quantity: quantity.optional(),
  unitPriceMinor: safeMinor.optional(),
  createdAt: z.string().datetime(),
}).strict().superRefine((valuation, context) => {
  if ((valuation.quantity === undefined) !== (valuation.unitPriceMinor === undefined)) {
    context.addIssue({ code: 'custom', path: ['quantity'], message: 'Quantity and unit price must be supplied together.' });
  }
  if (valuation.quantity !== undefined && calculateQuantityAmountMinor(valuation.quantity, valuation.unitPriceMinor!) !== valuation.amountMinor) {
    context.addIssue({ code: 'custom', path: ['amountMinor'], message: 'Amount must equal the deterministic quantity × unit price calculation.' });
  }
});
export type WealthValuation = z.infer<typeof WealthValuationSchema>;

export const ExternalAssetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  kind: WealthKindSchema,
  description: z.string().trim().max(2_000).optional(),
  owner: z.string().trim().max(120).optional(),
  currency,
  acquiredAt: isoDate.optional(),
  status: z.enum(['active', 'archived']),
  includeInNetWorth: z.boolean(),
  /** An explicit duplicate reference prevents the same account from being counted twice. */
  actualAccountId: z.string().trim().min(1).max(128).optional(),
  valuations: z.array(WealthValuationSchema).max(500),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((asset, context) => {
  if (asset.actualAccountId && asset.includeInNetWorth) {
    context.addIssue({ code: 'custom', path: ['includeInNetWorth'], message: 'An item already represented by an Actual account cannot be included again.' });
  }
  const ids = new Set<string>();
  for (const [index, valuation] of asset.valuations.entries()) {
    if (ids.has(valuation.id)) context.addIssue({ code: 'custom', path: ['valuations', index, 'id'], message: 'Valuation IDs must be unique.' });
    ids.add(valuation.id);
    if (valuation.currency !== asset.currency) context.addIssue({ code: 'custom', path: ['valuations', index, 'currency'], message: 'A valuation must use the asset currency.' });
  }
}).refine((asset) => asset.kind.endsWith('_liability') || asset.kind === 'loan' || asset.kind === 'mortgage' || asset.kind !== 'other_liability', 'Invalid wealth kind.');
export type ExternalAsset = z.infer<typeof ExternalAssetSchema>;

export const WealthDataSchema = z.object({
  version: z.literal(1),
  settings: z.object({ staleAfterDays: z.number().int().min(30).max(365).default(90), includeOffBudgetAccounts: z.boolean().default(true) }).strict(),
  accountClassifications: z.array(z.object({
    accountId: z.string().trim().min(1).max(128),
    classification: WealthClassificationSchema,
    updatedAt: z.string().datetime(),
  }).strict()).max(500),
  assets: z.array(ExternalAssetSchema).max(500),
}).strict().superRefine((data, context) => {
  const assetIds = new Set<string>();
  data.assets.forEach((asset, index) => {
    if (assetIds.has(asset.id)) context.addIssue({ code: 'custom', path: ['assets', index, 'id'], message: 'Asset IDs must be unique.' });
    assetIds.add(asset.id);
  });
  const accountIds = new Set<string>();
  data.accountClassifications.forEach((entry, index) => {
    if (accountIds.has(entry.accountId)) context.addIssue({ code: 'custom', path: ['accountClassifications', index, 'accountId'], message: 'Actual account classifications must be unique.' });
    accountIds.add(entry.accountId);
  });
});
export type WealthData = z.infer<typeof WealthDataSchema>;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const locks = new Map<string, Promise<void>>();

export function calculateQuantityAmountMinor(quantityValue: string, unitPriceMinor: number): number {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) throw new RangeError('Unit price must be a non-negative safe integer.');
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,8}))?$/.exec(quantityValue);
  if (!match) throw new RangeError('Quantity must be a positive decimal with at most eight fractional digits.');
  const fraction = match[2] ?? '';
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(match[1]! + fraction);
  const product = BigInt(unitPriceMinor) * numerator;
  const rounded = (product + scale / 2n) / scale;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new RangeError('Calculated valuation exceeds the safe monetary range.');
  return result;
}

export function emptyWealthData(): WealthData {
  return { version: 1, settings: { staleAfterDays: 90, includeOffBudgetAccounts: true }, accountClassifications: [], assets: [] };
}
function statePath(directory: string): string { return resolve(directory, 'wealth-data.json'); }

export async function readWealthData(directory: string): Promise<WealthData> {
  let content: string;
  try { content = await readFile(statePath(directory), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyWealthData();
    throw error;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Local wealth data exceeds its permitted size.');
  return WealthDataSchema.parse(JSON.parse(content) as unknown);
}

async function writeWealthData(directory: string, value: WealthData): Promise<void> {
  const parsed = WealthDataSchema.parse(value);
  const content = JSON.stringify(parsed, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new RangeError('Local wealth data exceeds its permitted size.');
  const path = statePath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function updateWealthData<T>(
  directory: string,
  update: (current: WealthData) => { readonly data: WealthData; readonly result: T },
): Promise<T> {
  const key = resolve(directory);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  locks.set(key, gate);
  await previous;
  try {
    const current = await readWealthData(directory);
    const outcome = update(current);
    await writeWealthData(directory, outcome.data);
    return outcome.result;
  } finally {
    release();
    if (locks.get(key) === gate) locks.delete(key);
  }
}
