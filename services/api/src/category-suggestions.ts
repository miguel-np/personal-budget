import {
  normalizeTransactions,
  suggestCategories,
} from '@personal-budget/finance-core';
import type {
  BudgetCategory,
  BudgetTransaction,
  CategorySuggestion as CoreCategorySuggestion,
} from '@personal-budget/finance-core';
import { z } from 'zod';
import {
  LocalAiBusyError,
  LocalAiCancelledError,
  LocalAiContextBudgetError,
  LocalAiUnavailableError,
} from './local-ai.js';
import type { LocalAiClient } from './local-ai.js';

const CategoryClassificationPayloadSchema = z.object({
  suggestions: z.array(z.object({
    reference: z.string().trim().regex(/^c(?:[1-9]|1[0-2])$/),
    categoryId: z.string().trim().min(1).max(128).nullable(),
    rationale: z.string().trim().min(1).max(240),
    uncertainty: z.enum(['low', 'medium', 'high']),
  }).strict()).min(1).max(12),
}).strict();

export type HybridCategorySuggestion = Omit<CoreCategorySuggestion,
  'suggestedCategoryId' | 'suggestedCategoryName' | 'lastEvidenceDate' | 'confidence'> & {
  readonly suggestedCategoryId: string | null;
  readonly suggestedCategoryName: string | null;
  readonly lastEvidenceDate: string | null;
  readonly confidence: 'rule_based' | 'local_ai' | 'none';
  readonly source: 'rule_based' | 'local_ai' | 'none';
  readonly uncertainty: 'low' | 'medium' | 'high' | 'not_assessed';
  readonly rationale: string | null;
};

type Entry = ReturnType<typeof normalizeTransactions>[number];
type AiCandidate = z.infer<typeof CategoryClassificationPayloadSchema>['suggestions'][number];
type ClassificationOutcome =
  | 'disabled' | 'no_candidates' | 'not_configured' | 'payee_sharing_disabled'
  | 'completed' | 'abstained' | 'invalid_response' | 'unavailable' | 'context_limited';

interface ClassificationDiagnostics {
  readonly outcome: ClassificationOutcome;
  readonly inferenceDurationMs: number;
  readonly batchesAttempted: number;
  readonly candidatesConsidered: number;
}

interface ClassificationDependencies {
  readonly localAi: LocalAiClient;
  readonly aiEnabled: boolean;
  readonly aiCategoryClassificationEnabled: boolean;
  readonly includePayee: boolean;
  readonly modelConfigured: boolean;
  readonly log: (fields: Readonly<Record<string, string | number>>, message: string) => void;
}

interface CandidateBatch {
  readonly entries: readonly Entry[];
  readonly references: ReadonlyMap<string, Entry>;
  readonly referenceById: ReadonlyMap<string, string>;
}

const MAX_CLASSIFICATION_CANDIDATES = 12;

function noneSuggestion(
  entry: Entry,
  rationale: string,
  uncertainty: HybridCategorySuggestion['uncertainty'] = 'high',
): HybridCategorySuggestion {
  return {
    transactionId: entry.id,
    date: entry.date,
    payeeLabel: entry.payeeLabel ?? '',
    amountMinor: entry.amountMinor,
    suggestedCategoryId: null,
    suggestedCategoryName: null,
    evidenceCount: 0,
    lastEvidenceDate: null,
    confidence: 'none',
    source: 'none',
    uncertainty,
    rationale,
  };
}

function createCandidateBatch(entries: readonly Entry[]): CandidateBatch {
  const references = new Map(entries.map((entry, index) => ['c' + (index + 1), entry] as const));
  const referenceById = new Map([...references.entries()].map(([reference, entry]) => [entry.id, reference] as const));
  return { entries, references, referenceById };
}

function fallbackEntries(
  entries: readonly Entry[],
  query: { readonly startDate: string; readonly endDate: string },
  rulesById: ReadonlyMap<string, CoreCategorySuggestion>,
): Entry[] {
  return entries
    .filter((entry) => !entry.isTransfer && entry.amountMinor < 0 && entry.categoryId === null &&
      Boolean(entry.payeeLabel) && entry.date >= query.startDate && entry.date <= query.endDate &&
      !/(refund|reembolso|devoluci[oó]n|chargeback|reintegro)/i.test(entry.payeeLabel ?? ''))
    .filter((entry) => {
      const deterministic = rulesById.get(entry.id);
      return !deterministic || deterministic.evidenceCount < 2;
    })
    .sort((left, right) => left.date.localeCompare(right.date) ||
      (left.payeeLabel ?? '').localeCompare(right.payeeLabel ?? '', 'es') || left.id.localeCompare(right.id));
}

function validateClassificationPayload(
  raw: string,
  batch: CandidateBatch,
  expenseCategoryById: ReadonlyMap<string, BudgetCategory>,
): ReadonlyMap<string, AiCandidate> {
  const payload = CategoryClassificationPayloadSchema.parse(JSON.parse(raw));
  const expected = new Set(batch.references.keys());
  const received = new Set<string>();
  for (const candidate of payload.suggestions) {
    if (!expected.has(candidate.reference) || received.has(candidate.reference)) {
      throw new Error('Invalid category classification references.');
    }
    received.add(candidate.reference);
    if (candidate.categoryId !== null && !expenseCategoryById.has(candidate.categoryId)) {
      throw new Error('Invalid category classification category.');
    }
  }
  if (received.size !== expected.size) throw new Error('Incomplete category classification response.');
  return new Map(payload.suggestions.map((candidate) => [candidate.reference, candidate] as const));
}

function removeWeakRuleSuggestion(
  entryId: string,
  rulesById: ReadonlyMap<string, CoreCategorySuggestion>,
  suggestions: HybridCategorySuggestion[],
): void {
  const deterministic = rulesById.get(entryId);
  if (!deterministic || deterministic.evidenceCount >= 2) return;
  const index = suggestions.findIndex((item) => item.transactionId === entryId);
  if (index >= 0) suggestions.splice(index, 1);
}

function suggestionFromAi(
  entry: Entry,
  candidate: AiCandidate | undefined,
  expenseCategoryById: ReadonlyMap<string, BudgetCategory>,
): HybridCategorySuggestion {
  if (candidate?.categoryId && candidate.uncertainty === 'low') {
    const category = expenseCategoryById.get(candidate.categoryId);
    if (category) {
      return {
        transactionId: entry.id,
        date: entry.date,
        payeeLabel: entry.payeeLabel ?? '',
        amountMinor: entry.amountMinor,
        suggestedCategoryId: category.id,
        suggestedCategoryName: category.name,
        evidenceCount: 0,
        lastEvidenceDate: null,
        confidence: 'local_ai',
        source: 'local_ai',
        uncertainty: 'low',
        rationale: candidate.rationale,
      };
    }
  }
  const rationale = candidate?.rationale
    ? 'La IA local no ofrece una clasificación suficientemente clara: ' + candidate.rationale
    : 'La IA local se abstuvo; elige una categoría manualmente.';
  return noneSuggestion(entry, rationale, candidate?.uncertainty ?? 'high');
}

function unavailableOutcome(error: unknown): ClassificationOutcome {
  if (error instanceof LocalAiUnavailableError || error instanceof LocalAiBusyError ||
      error instanceof LocalAiCancelledError) return 'unavailable';
  if (error instanceof LocalAiContextBudgetError) return 'context_limited';
  return 'invalid_response';
}

function fallbackRationale(outcome: ClassificationOutcome): string {
  if (outcome === 'unavailable') return 'La IA local no está disponible; elige una categoría manualmente.';
  if (outcome === 'context_limited') return 'El contexto supera el límite local; elige una categoría manualmente.';
  return 'La respuesta local no fue válida; elige una categoría manualmente.';
}

function configurationRationale(outcome: ClassificationOutcome): string {
  if (outcome === 'not_configured') return 'Ollama no tiene un modelo configurado; elige una categoría manualmente.';
  if (outcome === 'payee_sharing_disabled') return 'No se ha enviado el beneficiario al modelo por configuración; elige una categoría manualmente.';
  return 'El catálogo de categorías está vacío o supera el límite de contexto; elige una categoría manualmente.';
}

function addUnassessedFallbacks(
  entries: readonly Entry[],
  rulesById: ReadonlyMap<string, CoreCategorySuggestion>,
  suggestions: HybridCategorySuggestion[],
  rationale: string,
  uncertainty: HybridCategorySuggestion['uncertainty'],
): void {
  for (const entry of entries) {
    if (rulesById.has(entry.id) || suggestions.some((item) => item.transactionId === entry.id)) continue;
    suggestions.push(noneSuggestion(entry, rationale, uncertainty));
  }
}

async function runAiFallback(
  batch: CandidateBatch,
  categories: readonly BudgetCategory[],
  rulesById: ReadonlyMap<string, CoreCategorySuggestion>,
  suggestions: HybridCategorySuggestion[],
  dependencies: ClassificationDependencies,
): Promise<{ outcome: ClassificationOutcome; durationMs: number; batchesAttempted: 1 }> {
  const startedAt = Date.now();
  try {
    const raw = await dependencies.localAi.classifyCategories({
      categories: categories.map((category) => ({ id: category.id, name: category.name })),
      transactions: batch.entries.map((entry, index) => ({
        reference: 'c' + (index + 1),
        payee: entry.payeeLabel ?? '',
      })),
    });
    const byReference = validateClassificationPayload(raw, batch, new Map(categories.map((category) => [category.id, category])));
    for (const entry of batch.entries) {
      removeWeakRuleSuggestion(entry.id, rulesById, suggestions);
      const reference = batch.referenceById.get(entry.id);
      suggestions.push(suggestionFromAi(entry, reference ? byReference.get(reference) : undefined,
        new Map(categories.map((category) => [category.id, category]))));
    }
    const hasAiResult = suggestions.some((item) =>
      batch.entries.some((entry) => entry.id === item.transactionId) && item.source === 'local_ai');
    return { outcome: hasAiResult ? 'completed' : 'abstained', durationMs: Math.max(0, Date.now() - startedAt), batchesAttempted: 1 };
  } catch (error) {
    const outcome = unavailableOutcome(error);
    addUnassessedFallbacks(batch.entries, rulesById, suggestions, fallbackRationale(outcome), 'not_assessed');
    return { outcome, durationMs: Math.max(0, Date.now() - startedAt), batchesAttempted: 1 };
  }
}

export interface CategorySuggestionResult {
  readonly data: readonly HybridCategorySuggestion[];
  readonly classification: {
    readonly enabled: boolean;
    readonly outcome: ClassificationOutcome;
    readonly candidatesConsidered: number;
    readonly candidatesDeferred: number;
    readonly maxCandidatesPerRequest: number;
    readonly inferenceDurationMs: number;
    readonly batchesAttempted: number;
  };
}

export async function buildCategorySuggestions(
  transactions: readonly BudgetTransaction[],
  categories: readonly BudgetCategory[],
  query: { readonly startDate: string; readonly endDate: string },
  dependencies: ClassificationDependencies,
): Promise<CategorySuggestionResult> {
  const ruleSuggestions = suggestCategories(transactions, categories, query);
  const suggestions: HybridCategorySuggestion[] = ruleSuggestions.map((suggestion) => ({
    ...suggestion,
    source: 'rule_based' as const,
    uncertainty: 'not_assessed' as const,
    rationale: null,
  }));
  const rulesById = new Map(ruleSuggestions.map((suggestion) => [suggestion.transactionId, suggestion] as const));
  const expenseCategories = categories.filter((category) => !category.isIncome);
  const fallback = fallbackEntries(normalizeTransactions(transactions), query, rulesById);
  const selected = fallback.slice(0, MAX_CLASSIFICATION_CANDIDATES);
  const enabled = dependencies.aiEnabled && dependencies.aiCategoryClassificationEnabled;
  let diagnostics: ClassificationDiagnostics = {
    outcome: enabled ? 'no_candidates' : 'disabled',
    inferenceDurationMs: 0,
    batchesAttempted: 0,
    candidatesConsidered: selected.length,
  };

  if (enabled && selected.length > 0) {
    if (!dependencies.modelConfigured) {
      diagnostics = { ...diagnostics, outcome: 'not_configured' };
    } else if (!dependencies.includePayee) {
      diagnostics = { ...diagnostics, outcome: 'payee_sharing_disabled' };
    } else if (expenseCategories.length === 0 || expenseCategories.length > 100) {
      diagnostics = { ...diagnostics, outcome: 'context_limited' };
    } else {
      diagnostics = await runAiFallback(
        createCandidateBatch(selected), expenseCategories, rulesById, suggestions, dependencies,
      );
    }
    if (['not_configured', 'payee_sharing_disabled', 'context_limited'].includes(diagnostics.outcome)) {
      addUnassessedFallbacks(selected, rulesById, suggestions,
        configurationRationale(diagnostics.outcome), 'not_assessed');
    }
  }

  if (enabled && fallback.length > selected.length && diagnostics.outcome !== 'disabled') {
    dependencies.log({
      component: 'category-classification',
      event: 'batch_limited',
      deferredCandidates: fallback.length - selected.length,
      maxCandidatesPerRequest: MAX_CLASSIFICATION_CANDIDATES,
    }, 'Category classification batch limit reached.');
  }
  dependencies.log({
    component: 'category-classification',
    outcome: diagnostics.outcome,
    batchesAttempted: diagnostics.batchesAttempted,
    durationMs: diagnostics.inferenceDurationMs,
    candidatesConsidered: selected.length,
    maxCandidatesPerRequest: MAX_CLASSIFICATION_CANDIDATES,
  }, 'Hybrid category classification diagnostics.');

  return {
    data: suggestions.sort((left, right) =>
      left.date.localeCompare(right.date) || left.payeeLabel.localeCompare(right.payeeLabel, 'es')),
    classification: {
      enabled,
      outcome: diagnostics.outcome,
      candidatesConsidered: selected.length,
      candidatesDeferred: enabled ? Math.max(0, fallback.length - selected.length) : 0,
      maxCandidatesPerRequest: MAX_CLASSIFICATION_CANDIDATES,
      inferenceDurationMs: diagnostics.inferenceDurationMs,
      batchesAttempted: diagnostics.batchesAttempted,
    },
  };
}
