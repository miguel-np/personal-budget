import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isIsoDate } from '@personal-budget/finance-core';
import type {
  BudgetRepository,
  BudgetTransaction,
  PlanningCommitment,
} from '@personal-budget/finance-core';
import { projectSavingsGoal, estimatePlanningCashFlow, detectRecurringCandidates } from '@personal-budget/finance-core';
import type { AppConfig } from './config.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import { resolveAccountScope } from './account-scope.js';
import type { AccountScopePreference } from './account-scope.js';
import {
  readPlanningData,
} from './planning-store.js';
import type { StoredPlanningGoal, StoredPlanningCommitment } from './planning-store.js';
import {
  LocalAiBusyError,
  LocalAiCancelledError,
  LocalAiContextBudgetError,
  LocalAiUnavailableError,
} from './local-ai.js';
import type { LocalAiClient } from './local-ai.js';

export const PlanningConversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(1_600),
}).strict();

export const PlanningIntentDraftSchema = z.object({
  intent: z.enum(['goal_plan', 'compare_contributions', 'test_expense']),
  goalId: z.string().uuid().nullable(),
  goalName: z.string().trim().min(1).max(100).nullable(),
  targetAmountMajor: z.number().finite().positive().max(1_000_000_000).nullable(),
  targetDate: z.string().refine(isIsoDate).nullable(),
  initialAmountMajor: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  monthlyContributionMajor: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  contributionOptionsMajor: z.array(z.number().finite().nonnegative().max(1_000_000_000)).max(5),
  monthlyIncomeMajor: z.number().finite().min(-1_000_000_000).max(1_000_000_000).nullable(),
  monthlyExpenseMajor: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  expenseAmountMajor: z.number().finite().positive().max(1_000_000_000).nullable(),
  expenseDate: z.string().refine(isIsoDate).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  clarificationQuestion: z.string().trim().min(1).max(240).nullable(),
}).strict();

type PlanningIntentDraft = z.infer<typeof PlanningIntentDraftSchema>;
type SanitizedError = {
  readonly statusCode: number;
  readonly body: { readonly error: { readonly code: string; readonly message: string } };
};

interface Dependencies {
  readonly config: Pick<AppConfig, 'aiEnabled' | 'actualDataDir'>;
  readonly repository: BudgetRepository;
  readonly localAi: Pick<LocalAiClient, 'extractPlanningIntent'>;
  readonly currencyPreferences: () => Promise<CurrencyPreferences>;
  readonly accountScopePreference: () => Promise<AccountScopePreference>;
  readonly transactionsForAccounts: (
    accounts: Awaited<ReturnType<BudgetRepository['listAccounts']>>,
    startDate: string,
    endDate: string,
    preferences: CurrencyPreferences,
  ) => Promise<readonly BudgetTransaction[]>;
  readonly convertTransactionsForAnalysis: (
    transactions: readonly BudgetTransaction[], preferences: CurrencyPreferences,
  ) => { readonly transactions: readonly BudgetTransaction[]; readonly warnings: readonly string[] };
  readonly planningScopeMatches: (saved: AccountScopePreference, current: AccountScopePreference) => boolean;
  readonly toPlanningCommitment: (item: StoredPlanningCommitment) => PlanningCommitment;
  readonly majorToMinor: (amount: number, currency: string, label: string) => number;
  readonly currencyFractionDigits: (currency: string) => number;
  readonly shiftPlanningMonth: (month: string, offset: number) => string;
  readonly validateGoalWindow: (targetDate: string, asOfDate: string) => void;
  readonly sanitizedErrorResponse: (error: unknown) => SanitizedError;
}

function clarification(question: string) {
  return {
    data: {
      status: 'clarification_required' as const,
      question,
      saved: false,
      message: 'No se ha ejecutado ni guardado ninguna modificación.',
    },
  };
}

function validateInitialDraft(
  draft: PlanningIntentDraft,
  currency: string,
) {
  if (draft.clarificationQuestion) return clarification(draft.clarificationQuestion);
  if (draft.currency && draft.currency !== currency) {
    return clarification('La planificación utiliza actualmente ' + currency +
      '. ¿Puedes expresar los importes en esa divisa? No convertiré importes futuros sin una tasa explícita y fechada.');
  }
  if (draft.intent === 'compare_contributions' && draft.contributionOptionsMajor.length < 2) {
    return clarification('Indica al menos dos aportaciones mensuales que quieras comparar, por ejemplo 150 € y 250 €.');
  }
  if (draft.intent === 'test_expense' && (!draft.expenseAmountMajor || !draft.expenseDate)) {
    return clarification('¿Qué importe tendría el gasto extraordinario y en qué fecha se produciría?');
  }
  return null;
}

type GoalSelection = { readonly goal: StoredPlanningGoal | undefined } |
  { readonly response: ReturnType<typeof clarification> | { readonly error: { readonly code: string; readonly message: string } }; readonly statusCode: number };

function selectGoal(
  draft: PlanningIntentDraft,
  storedGoals: readonly StoredPlanningGoal[],
  eligibleGoals: readonly StoredPlanningGoal[],
  preference: AccountScopePreference,
  currency: string,
  dependencies: Dependencies,
): GoalSelection {
  let selectedGoal = draft.goalId ? storedGoals.find((goal) => goal.id === draft.goalId) : undefined;
  if (draft.goalId && !selectedGoal) {
    return { statusCode: 409, response: { error: {
      code: 'PLANNING_GOAL_CONTEXT_CHANGED',
      message: 'El objetivo indicado ya no existe o no está disponible. Actualiza la planificación y vuelve a intentarlo.',
    } } };
  }
  if (selectedGoal && selectedGoal.status !== 'active') {
    return { statusCode: 409, response: { error: {
      code: 'PLANNING_GOAL_PAUSED',
      message: 'El objetivo seleccionado está pausado. Reanúdalo desde Objetivos antes de simularlo.',
    } } };
  }
  if (selectedGoal && (!dependencies.planningScopeMatches(selectedGoal.scope, preference) || selectedGoal.currency !== currency)) {
    return { statusCode: 409, response: { error: {
      code: 'PLANNING_CONTEXT_CHANGED',
      message: 'El ámbito de cuentas o la divisa del objetivo han cambiado. Revísalo desde Objetivos antes de simularlo.',
    } } };
  }
  if (draft.intent === 'test_expense' && !selectedGoal) {
    if (eligibleGoals.length === 1) selectedGoal = eligibleGoals[0];
    else if (eligibleGoals.length > 1) return { statusCode: 200, response: clarification('¿Sobre cuál de tus objetivos activos quieres comprobar el impacto de ese gasto?') };
    else return { statusCode: 200, response: clarification('Primero necesito un objetivo de ahorro activo para comprobar si el gasto retrasaría su fecha prevista.') };
  }
  return { goal: selectedGoal };
}

type GoalParameters = {
  readonly selectedGoal: StoredPlanningGoal | undefined;
  readonly targetAmountMinor: number;
  readonly targetDate: string;
  readonly initialAmountMinor: number;
  readonly goalName: string;
};

function resolveGoalParameters(
  draft: PlanningIntentDraft,
  selectedGoal: StoredPlanningGoal | undefined,
  currency: string,
  asOfDate: string,
  dependencies: Dependencies,
): GoalParameters | ReturnType<typeof clarification> {
  const targetAmountMinor = selectedGoal?.targetAmountMinor ??
    (draft.targetAmountMajor === null ? null : dependencies.majorToMinor(draft.targetAmountMajor, currency, 'objetivo'));
  const targetDate = selectedGoal?.targetDate ?? draft.targetDate;
  if (targetAmountMinor === null) return clarification('¿Qué cantidad total quieres alcanzar con el objetivo de ahorro?');
  if (!targetDate) return clarification('¿Para qué fecha quieres alcanzar el objetivo? Indica mes y año para evitar ambigüedades.');
  dependencies.validateGoalWindow(targetDate, asOfDate);
  if (draft.intent === 'test_expense' && draft.expenseDate! <= asOfDate) {
    return clarification('La fecha del gasto debe ser futura. ¿Qué día ocurriría ese gasto?');
  }
  if (draft.intent === 'test_expense' && draft.expenseDate! > targetDate) {
    return clarification('El gasto indicado cae después de la fecha objetivo. ¿Quieres comprobar otro gasto anterior a esa fecha?');
  }
  return {
    selectedGoal,
    targetAmountMinor,
    targetDate,
    initialAmountMinor: selectedGoal?.initialAmountMinor ??
      (draft.initialAmountMajor === null ? 0 : dependencies.majorToMinor(draft.initialAmountMajor, currency, 'ahorro inicial')),
    goalName: selectedGoal?.name ?? draft.goalName ?? 'Objetivo hipotético',
  };
}

interface ScenarioContext {
  readonly draft: PlanningIntentDraft;
  readonly currency: string;
  readonly goal: GoalParameters;
  readonly monthlyIncomeMinor: number;
  readonly monthlyExpenseMinor: number;
  readonly baseContributionMinor: number;
  readonly commitments: readonly PlanningCommitment[];
  readonly makeProjection: (monthlyContribution: number, activeCommitments: readonly PlanningCommitment[]) => ReturnType<typeof projectSavingsGoal>;
  readonly dependencies: Dependencies;
}

function contributionScenarios(context: ScenarioContext) {
  const amounts = [...new Set(context.draft.contributionOptionsMajor)]
    .map((amount) => context.dependencies.majorToMinor(amount, context.currency, 'aportación comparada'))
    .sort((left, right) => left - right);
  if (amounts.length < 2) return clarification('Las aportaciones comparadas deben ser diferentes. ¿Qué dos importes quieres contrastar?');
  return amounts.map((amount) => ({
    label: 'Aportación mensual de ' + new Intl.NumberFormat('es-ES', {
      style: 'currency', currency: context.currency,
    }).format(amount / Math.pow(10, context.dependencies.currencyFractionDigits(context.currency))),
    monthlyContributionMinor: amount,
    projection: context.makeProjection(amount, context.commitments),
  }));
}

function expenseScenarios(context: ScenarioContext) {
  const expenseAmountMinor = context.dependencies.majorToMinor(
    context.draft.expenseAmountMajor!, context.currency, 'gasto hipotético',
  );
  const hypotheticalCommitment: PlanningCommitment = {
    id: 'hypothetical:' + randomUUID(),
    title: 'Gasto extraordinario hipotético',
    amountMinor: expenseAmountMinor,
    date: context.draft.expenseDate!,
    direction: 'expense',
    frequency: 'once',
    currency: context.currency,
    status: 'active',
    source: 'manual',
  };
  return [
    {
      label: 'Sin el gasto extraordinario',
      monthlyContributionMinor: context.baseContributionMinor,
      projection: context.makeProjection(context.baseContributionMinor, context.commitments),
    },
    {
      label: 'Incluyendo el gasto extraordinario',
      monthlyContributionMinor: context.baseContributionMinor,
      projection: context.makeProjection(context.baseContributionMinor, [...context.commitments, hypotheticalCommitment]),
    },
  ];
}

function ordinaryGoalScenario(context: ScenarioContext) {
  const initialProjection = context.makeProjection(context.baseContributionMinor, context.commitments);
  if (!context.goal.selectedGoal && context.draft.monthlyContributionMajor === null &&
      initialProjection.requiredMonthlyContributionMinor !== null &&
      initialProjection.requiredMonthlyContributionMinor > 0) {
    const required = initialProjection.requiredMonthlyContributionMinor;
    return {
      label: 'Aportación mensual necesaria estimada',
      monthlyContributionMinor: required,
      projection: context.makeProjection(required, context.commitments),
    };
  }
  return {
    label: context.goal.selectedGoal
      ? 'Objetivo existente · simulación sin guardar'
      : 'Nuevo objetivo hipotético · sin guardar',
    monthlyContributionMinor: context.baseContributionMinor,
    projection: initialProjection,
  };
}

function buildScenarios(context: ScenarioContext) {
  if (context.draft.intent === 'compare_contributions') return contributionScenarios(context);
  if (context.draft.intent === 'test_expense') return expenseScenarios(context);
  return [ordinaryGoalScenario(context)];
}

async function buildPlanningPreview(
  draft: PlanningIntentDraft,
  asOfDate: string,
  stored: Awaited<ReturnType<typeof readPlanningData>>,
  accounts: Awaited<ReturnType<BudgetRepository['listAccounts']>>,
  categories: Awaited<ReturnType<BudgetRepository['listCategories']>>,
  preferences: CurrencyPreferences,
  preference: AccountScopePreference,
  dependencies: Dependencies,
): Promise<unknown> {
  const initialError = validateInitialDraft(draft, preferences.displayCurrency);
  if (initialError) return initialError;
  const [scope, eligibleGoals] = [
    resolveAccountScope(accounts, preference),
    stored.goals.filter((goal) =>
      goal.status === 'active' && goal.currency === preferences.displayCurrency &&
      dependencies.planningScopeMatches(goal.scope, preference) && goal.targetDate > asOfDate),
  ];
  const selected = selectGoal(draft, stored.goals, eligibleGoals, preference, preferences.displayCurrency, dependencies);
  if ('response' in selected) return selected.statusCode === 200 ? selected.response : selected.response;
  const goal = resolveGoalParameters(draft, selected.goal, preferences.displayCurrency, asOfDate, dependencies);
  if (!('targetAmountMinor' in goal)) return goal;

  const historyStartDate = dependencies.shiftPlanningMonth(asOfDate.slice(0, 7), -11) + '-01';
  const historyTransactions = await dependencies.transactionsForAccounts(scope.accounts, historyStartDate, asOfDate, preferences);
  const convertedHistory = dependencies.convertTransactionsForAnalysis(historyTransactions, preferences);
  const estimate = estimatePlanningCashFlow(convertedHistory.transactions, categories, {
    currency: preferences.displayCurrency, startDate: historyStartDate, endDate: asOfDate,
  });
  const monthlyIncomeMinor = draft.monthlyIncomeMajor === null
    ? (goal.selectedGoal?.monthlyIncomeMinor ?? estimate.monthlyIncomeMinor)
    : dependencies.majorToMinor(draft.monthlyIncomeMajor, preferences.displayCurrency, 'ingresos mensuales');
  const monthlyExpenseMinor = draft.monthlyExpenseMajor === null
    ? (goal.selectedGoal?.monthlyExpenseMinor ?? estimate.monthlyExpenseMinor)
    : dependencies.majorToMinor(draft.monthlyExpenseMajor, preferences.displayCurrency, 'gastos mensuales');
  const recurringCandidates = detectRecurringCandidates(convertedHistory.transactions, {
    startDate: historyStartDate, endDate: asOfDate,
  });
  const commitments = stored.commitments
    .filter((item) => item.status === 'active' && item.currency === preferences.displayCurrency &&
      dependencies.planningScopeMatches(item.scope, preference))
    .map(dependencies.toPlanningCommitment);
  const baseContributionMinor = goal.selectedGoal?.monthlyContributionMinor ??
    (draft.monthlyContributionMajor === null ? 0 :
      dependencies.majorToMinor(draft.monthlyContributionMajor, preferences.displayCurrency, 'aportación mensual'));
  const makeProjection = (monthlyContribution: number, activeCommitments: readonly PlanningCommitment[]) =>
    projectSavingsGoal({
      asOfDate,
      targetDate: goal.targetDate,
      targetAmountMinor: goal.targetAmountMinor,
      initialAmountMinor: goal.initialAmountMinor,
      currency: preferences.displayCurrency,
      monthlyContributionMinor: monthlyContribution,
      monthlyIncomeMinor,
      monthlyExpenseMinor,
      commitments: activeCommitments,
    });
  const scenarioContext: ScenarioContext = {
    draft, currency: preferences.displayCurrency, goal,
    monthlyIncomeMinor, monthlyExpenseMinor, baseContributionMinor,
    commitments, makeProjection, dependencies,
  };
  const scenarios = buildScenarios(scenarioContext);
  if (!Array.isArray(scenarios)) return scenarios;
  const warnings = [...new Set([
    ...convertedHistory.warnings,
    ...estimate.warnings,
    ...scenarios.flatMap((scenario) => scenario.projection.warnings),
  ])];
  return {
    data: {
      status: 'ready' as const,
      saved: false,
      label: 'Simulación conversacional · no guardada',
      intent: draft.intent,
      goal: {
        id: goal.selectedGoal?.id ?? null,
        name: goal.goalName,
        targetAmountMinor: goal.targetAmountMinor,
        initialAmountMinor: goal.initialAmountMinor,
        targetDate: goal.targetDate,
        currency: preferences.displayCurrency,
      },
      scenarios,
      hypotheticalExpense: draft.intent === 'test_expense' ? {
        amountMinor: dependencies.majorToMinor(draft.expenseAmountMajor!, preferences.displayCurrency, 'gasto hipotético'),
        date: draft.expenseDate!,
        currency: preferences.displayCurrency,
      } : null,
      manualCommitments: commitments.map((item) => ({
        title: item.title, amountMinor: item.amountMinor, date: item.date,
        direction: item.direction, frequency: item.frequency, currency: item.currency,
      })),
      sources: {
        historyStartDate,
        historyEndDate: asOfDate,
        monthsWithData: estimate.monthsWithData,
        transactionCount: estimate.transactionCount,
        monthlyIncomeSource: draft.monthlyIncomeMajor === null && goal.selectedGoal?.monthlyIncomeMinor == null
          ? 'observed_median' : 'user_or_goal_assumption',
        monthlyExpenseSource: draft.monthlyExpenseMajor === null && goal.selectedGoal?.monthlyExpenseMinor == null
          ? 'observed_median' : 'user_or_goal_assumption',
        accountScope: scope.metadata,
        currency: preferences.displayCurrency,
        commitmentsConsidered: commitments.length,
        unconfirmedRecurringCandidatesExcluded: recurringCandidates.length,
      },
      assumptions: [
        ...estimate.assumptions,
        'Los importes propuestos por la IA se consideran entradas del usuario, se validan en el backend y no son cálculos del modelo.',
        'Ingresos y gastos proceden de la mediana mensual observada o de supuestos explícitos del objetivo o de la petición.',
        'Las simulaciones no aplican intereses, inflación ni revalorización y no constituyen una garantía.',
        'Los escenarios y el gasto extraordinario conversacional son efímeros; no crean ni modifican objetivos, compromisos ni movimientos.',
      ],
      warnings,
      notes: convertedHistory.warnings,
    },
  };
}

export async function handlePlanningConversationPreview(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Dependencies,
) {
  const abort = new AbortController();
  const abortRequest = () => abort.abort();
  const abortResponse = () => { if (!reply.raw.writableEnded) abort.abort(); };
  request.raw.once('aborted', abortRequest);
  reply.raw.once('close', abortResponse);
  try {
    const body = PlanningConversationRequestSchema.parse(request.body);
    if (!dependencies.config.aiEnabled) {
      return reply.code(503).send({ error: {
        code: 'AI_DISABLED',
        message: 'El planificador conversacional requiere activar la IA local. Los formularios de planificación siguen disponibles.',
      } });
    }
    const [stored, accounts, categories, preferences, preference] = await Promise.all([
      readPlanningData(dependencies.config.actualDataDir),
      dependencies.repository.listAccounts(),
      dependencies.repository.listCategories(),
      dependencies.currencyPreferences(),
      dependencies.accountScopePreference(),
    ]);
    const asOfDate = new Date().toISOString().slice(0, 10);
    const draftUnknown = await dependencies.localAi.extractPlanningIntent(body.message, {
      asOfDate,
      currency: preferences.displayCurrency,
      goals: stored.goals.filter((goal) =>
        goal.status === 'active' && goal.currency === preferences.displayCurrency &&
        dependencies.planningScopeMatches(goal.scope, preference) && goal.targetDate > asOfDate,
      ).map((goal) => ({ id: goal.id, name: goal.name })),
    }, abort.signal);
    const parsedDraft = PlanningIntentDraftSchema.safeParse(draftUnknown);
    if (!parsedDraft.success) {
      return reply.code(422).send({ error: {
        code: 'PLANNING_INTENT_INVALID',
        message: 'La IA local no ha devuelto una intención válida. Utiliza el formulario de planificación o reformula la petición.',
      } });
    }
    const result = await buildPlanningPreview(
      parsedDraft.data, asOfDate, stored, accounts, categories, preferences, preference, dependencies,
    );
    if (typeof result === 'object' && result !== null && 'statusCode' in result) {
      const status = (result as { statusCode: number }).statusCode;
      const response = (result as { response: unknown }).response;
      return status === 200 ? response : reply.code(status).send(response);
    }
    return result;
  } catch (error) {
    if (error instanceof LocalAiCancelledError) {
      if (request.raw.aborted || reply.raw.destroyed) return;
      return reply.code(499).send({ error: { code: 'AI_CANCELLED', message: 'La consulta de planificación se ha cancelado.' } });
    }
    if (error instanceof LocalAiBusyError) {
      return reply.code(503).header('retry-after', '1').send({ error: { code: 'AI_BUSY', message: 'La IA local está ocupada; vuelve a intentarlo.' } });
    }
    if (error instanceof LocalAiContextBudgetError) {
      return reply.code(413).send({ error: { code: 'AI_CONTEXT_TOO_LARGE', message: 'La petición supera el límite de contexto local permitido.' } });
    }
    if (error instanceof LocalAiUnavailableError) {
      return reply.code(503).send({ error: { code: 'AI_UNAVAILABLE', message: 'Ollama o el modelo local no están disponibles o no han devuelto una extracción válida.' } });
    }
    const normalized = dependencies.sanitizedErrorResponse(error);
    return reply.code(normalized.statusCode).send(normalized.body);
  } finally {
    request.raw.removeListener('aborted', abortRequest);
    reply.raw.removeListener('close', abortResponse);
  }
}
