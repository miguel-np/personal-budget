export interface BudgetSignalCategory {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly isIncome: boolean;
  readonly hidden: boolean;
  readonly budgetedMinor: number | null;
  readonly spentMinor: number | null;
  readonly availableMinor: number | null;
  readonly percentUsed: number | null;
}

export interface BudgetAlert {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly kind: 'over-budget' | 'near-limit';
  readonly budgetedMinor: number;
  readonly spentMinor: number;
  readonly availableMinor: number;
  readonly percentUsed: number;
  readonly overByMinor: number;
}

export interface PeriodChange {
  readonly absoluteMinor: number;
  readonly percentageChange: number | null;
}

/** A percentage is meaningful only when the previous value is a positive denominator. */
export function comparePeriodValues(currentMinor: number, previousMinor: number): PeriodChange {
  if (!Number.isSafeInteger(currentMinor) || !Number.isSafeInteger(previousMinor)) {
    throw new RangeError('Period comparison requires safe integer minor-unit amounts.');
  }
  const absoluteMinor = currentMinor - previousMinor;
  if (!Number.isSafeInteger(absoluteMinor)) throw new RangeError('Period change exceeds the safe integer range.');
  return {
    absoluteMinor,
    percentageChange: previousMinor > 0 ? (absoluteMinor / previousMinor) * 100 : null,
  };
}

/** Only flags categories whose budget and actual spend are known. Unbudgeted and unknown are not zero. */
export function getBudgetAlerts(
  categories: readonly BudgetSignalCategory[],
  thresholdPercent = 80,
  limit = 3,
): readonly BudgetAlert[] {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
    throw new RangeError('Budget alert threshold must be between 0 and 100.');
  }
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Budget alert limit must be a non-negative integer.');

  const alerts: BudgetAlert[] = [];
  for (const category of categories) {
    if (category.isIncome || category.hidden) continue;
    if (category.budgetedMinor === null || category.budgetedMinor <= 0) continue;
    if (category.spentMinor === null || category.availableMinor === null) continue;
    const percentUsed = category.percentUsed !== null && Number.isFinite(category.percentUsed)
      ? category.percentUsed
      : (category.spentMinor / category.budgetedMinor) * 100;
    if (!Number.isFinite(percentUsed)) continue;
    const kind = category.availableMinor < 0
      ? 'over-budget'
      : percentUsed >= thresholdPercent ? 'near-limit' : null;
    if (!kind) continue;
    alerts.push({
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      kind,
      budgetedMinor: category.budgetedMinor,
      spentMinor: category.spentMinor,
      availableMinor: category.availableMinor,
      percentUsed,
      overByMinor: Math.max(0, -category.availableMinor),
    });
  }
  alerts.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'over-budget' ? -1 : 1;
    if (left.kind === 'over-budget' && right.kind === 'over-budget') {
      return right.overByMinor - left.overByMinor || right.percentUsed - left.percentUsed;
    }
    return right.percentUsed - left.percentUsed;
  });
  return alerts.slice(0, limit);
}

export type AccountClassification = 'asset' | 'liability';

export interface NetWorthAccountInput {
  readonly id: string;
  readonly closed: boolean;
  readonly offBudget: boolean;
  readonly classification?: AccountClassification | null;
  readonly displayBalanceMinor: number | null | undefined;
  readonly displayCurrency: string | null | undefined;
}

export interface NetWorthAssessment {
  readonly status: 'available' | 'incomplete' | 'unavailable';
  readonly amountMinor: number | null;
  readonly currency: string;
  readonly includedAccountIds: readonly string[];
  readonly excludedAccountIds: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Computes net worth only if each included open account is explicitly classified
 * and has a valid balance converted to the requested currency. Account sign and
 * display/group names are never used to infer asset/liability classification.
 */
export function assessNetWorth(
  accounts: readonly NetWorthAccountInput[],
  currency: string,
  accountScopeIds?: readonly string[],
  includeOffBudget = true,
): NetWorthAssessment {
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('Net-worth currency must be a three-letter uppercase code.');
  const scope = accountScopeIds === undefined ? null : new Set(accountScopeIds);
  const eligible = accounts.filter((account) =>
    !account.closed &&
    (scope === null || scope.has(account.id)) &&
    (includeOffBudget || !account.offBudget));
  const includedAccountIds = eligible.map((account) => account.id);
  const excludedAccountIds = accounts.filter((account) => !includedAccountIds.includes(account.id)).map((account) => account.id);
  const reasons: string[] = [];

  if (eligible.length === 0) {
    return {
      status: 'incomplete', amountMinor: null, currency, includedAccountIds, excludedAccountIds,
      reasons: ['No hay cuentas abiertas dentro del ámbito seleccionado.'],
    };
  }

  const unclassified = eligible.filter((account) => account.classification !== 'asset' && account.classification !== 'liability');
  if (unclassified.length > 0) {
    reasons.push('Falta una clasificación fiable de activo/pasivo para ' + unclassified.length + ' cuenta(s). El saldo y el nombre de la cuenta no permiten deducirla.');
    return { status: 'unavailable', amountMinor: null, currency, includedAccountIds, excludedAccountIds, reasons };
  }

  const unavailable = eligible.filter((account) =>
    account.displayBalanceMinor === null ||
    account.displayBalanceMinor === undefined ||
    account.displayCurrency !== currency);
  if (unavailable.length > 0) {
    reasons.push('Falta un saldo conocido o una conversión válida a ' + currency + ' para ' + unavailable.length + ' cuenta(s).');
    return { status: 'incomplete', amountMinor: null, currency, includedAccountIds, excludedAccountIds, reasons };
  }

  let amountMinor = 0;
  for (const account of eligible) {
    const balance = account.displayBalanceMinor as number;
    if (!Number.isSafeInteger(balance)) {
      return {
        status: 'incomplete', amountMinor: null, currency, includedAccountIds, excludedAccountIds,
        reasons: ['Un saldo convertido no está representado en unidades monetarias menores con precisión segura.'],
      };
    }
    const contribution = account.classification === 'liability' ? -Math.abs(balance) : balance;
    amountMinor += contribution;
    if (!Number.isSafeInteger(amountMinor)) {
      return {
        status: 'incomplete', amountMinor: null, currency, includedAccountIds, excludedAccountIds,
        reasons: ['El total excede el rango entero seguro y no se muestra para evitar pérdida de precisión.'],
      };
    }
  }

  if (excludedAccountIds.length > 0) {
    reasons.push('El cálculo se limita al ámbito elegido y a cuentas abiertas; las cuentas excluidas se muestran aparte y no contribuyen al total.');
  }
  if (!includeOffBudget) reasons.push('Las cuentas fuera de presupuesto están excluidas explícitamente por la preferencia seleccionada.');
  return { status: 'available', amountMinor, currency, includedAccountIds, excludedAccountIds, reasons };
}
