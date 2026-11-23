import { date, period, parse, MAX_OUTPUT } from './tool-definitions.mjs';
import { base, TIMEOUT } from './runtime-config.mjs';

async function boundedBody(response, maxBytes) {
 const declaredLength = Number(response.headers.get('content-length'));
 if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
  await response.body?.cancel().catch(() => undefined);
  throw Error('Local API response exceeds size limit.');
 }
 if (!response.body) return '';
 const reader = response.body.getReader();
 const chunks = [];
 let total = 0;
 try {
  while (true) {
   const { done, value } = await reader.read();
   if (done) break;
   total += value.byteLength;
   if (total > maxBytes) {
    await reader.cancel().catch(() => undefined);
    throw Error('Local API response exceeds size limit.');
   }
   chunks.push(value);
  }
 } finally {
  reader.releaseLock();
 }
 const body = new Uint8Array(total);
 let offset = 0;
 for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
 return new TextDecoder().decode(body);
}
async function api(path, options = {}) {
 const u=new URL(path,base.endsWith('/')?base:base+'/');
 const method = options.method ?? 'GET';
 const headers = { Accept: 'application/json' };
 if (options.body !== undefined) headers['Content-Type'] = 'application/json';
 const r=await fetch(u,{method,headers,body:options.body === undefined ? undefined : JSON.stringify(options.body),signal:AbortSignal.timeout(TIMEOUT)});
 if(!r.ok) {
  await r.body?.cancel().catch(() => undefined);
  throw Error('Local finance API request failed.');
 }
 const raw=await boundedBody(r,MAX_OUTPUT);
 const j=JSON.parse(raw); if(!j||typeof j!=='object'||j.error) throw Error('Local API returned invalid data.'); return j;
}
const q=(p,params)=>'/api/v1/'+p+'?'+new URLSearchParams(params);
async function sum(a,b){period(a,b);const r=await api(q('reports/summary',{startDate:a,endDate:b}));if(!r.data||typeof r.data.expenseMinor!=='number')throw Error('Invalid summary.');return r.data;}
async function rows(a,b,uncat=false){period(a,b);const p={startDate:a,endDate:b,limit:'200',offset:'0',sortBy:'date',order:'asc'};if(uncat)p.uncategorized='true';const r=await api(q('transactions',p));if(!Array.isArray(r.data))throw Error('Invalid transactions.');return r.data;}
async function invokeMonthlySummary(args) {
 return sum(args.startDate, args.endDate);
}

async function invokeSpendingByCategory(args) {
 const summary = await sum(args.startDate, args.endDate);
 return {
  currency: summary.currency,
  startDate: summary.startDate,
  endDate: summary.endDate,
  expensesByCategory: summary.expensesByCategory,
  warnings: summary.warnings
 };
}

async function invokePeriodComparison(args) {
 const [current, previous] = await Promise.all([
  sum(args.currentStartDate, args.currentEndDate),
  sum(args.previousStartDate, args.previousEndDate)
 ]);
 return {
  currency: current.currency,
  current,
  previous,
  delta: {
   incomeMinor: current.incomeMinor - previous.incomeMinor,
   expenseMinor: current.expenseMinor - previous.expenseMinor,
   savingsMinor: current.savingsMinor - previous.savingsMinor
  }
 };
}

async function invokeYearlyOverview(args) {
 const months = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
 const summaries = await Promise.all(months.map((month) => {
  const startDate = args.year + '-' + month + '-01';
  const endDate = new Date(Date.UTC(args.year, Number(month), 0)).toISOString().slice(0, 10);
  return sum(startDate, endDate);
 }));
 return {
  year: args.year,
  currency: summaries[0]?.currency,
  months: summaries.map((summary) => ({
   month: summary.startDate.slice(0, 7),
   incomeMinor: summary.incomeMinor,
   expenseMinor: summary.expenseMinor,
   savingsMinor: summary.savingsMinor,
   transactionCount: summary.transactionCount
  }))
 };
}

async function invokeUncategorizedTransactions(args) {
 const records = await rows(args.startDate, args.endDate, true);
 return {
  truncated: records.length >= 200,
  transactions: records.slice(0, 200).map((transaction) => ({
   id: transaction.id,
   date: transaction.date,
   amount: transaction.amount,
   account: transaction.account,
   category: transaction.category ?? null
  }))
 };
}

function recurringPayee(transaction) {
 if (typeof transaction.payee_name === 'string') return transaction.payee_name;
 if (typeof transaction.imported_payee === 'string') return transaction.imported_payee;
 return '';
}

function groupRecurringTransactions(records) {
 const groups = new Map();
 for (const transaction of records) {
  const payee = recurringPayee(transaction);
  const key = payee.trim().toLocaleLowerCase('es').replace(/\s+/g, ' ');
  if (!key || !date(transaction.date) || !Number.isSafeInteger(transaction.amount)) continue;
  const group = groups.get(key) ?? { label: payee.slice(0, 100), items: [] };
  group.items.push({ date: transaction.date, amount: Math.abs(transaction.amount) });
  groups.set(key, group);
 }
 return groups;
}

function buildRecurringCandidate(group) {
 const items = group.items.sort((left, right) => left.date.localeCompare(right.date));
 if (items.length < 3) return null;
 const gaps = items.slice(1).map((item, index) => (
  (Date.parse(item.date + 'T00:00:00Z') - Date.parse(items[index].date + 'T00:00:00Z')) / 86400000
 ));
 const interval = gaps.reduce((total, gap) => total + gap, 0) / gaps.length;
 const mean = items.reduce((total, item) => total + item.amount, 0) / items.length;
 const deviation = mean ? Math.max(...items.map((item) => Math.abs(item.amount - mean) / mean)) : 0;
 if (interval < 20 || interval > 45 || deviation > 0.2) return null;
 return {
  payee: group.label,
  occurrenceCount: items.length,
  estimatedIntervalDays: Math.round(interval),
  meanAbsoluteAmountMinor: Math.round(mean),
  dates: items.slice(-12).map((item) => item.date),
  confidence: 'candidate_only',
  warning: 'Historical pattern only; future payment is not guaranteed.'
 };
}

async function invokeRecurringCandidates(args) {
 const records = await rows(args.startDate, args.endDate);
 const candidates = [...groupRecurringTransactions(records).values()]
  .map(buildRecurringCandidate)
  .filter(Boolean);
 return {
  candidates: candidates.slice(0, args.limit),
  sourceRecords: records.length,
  truncated: records.length >= 200
 };
}

async function invokeBudgetSimulation(args) {
 const summary = await sum(args.startDate, args.endDate);
 const category = summary.expensesByCategory.find((item) => (
  item.categoryName.toLocaleLowerCase('es') === args.categoryName.toLocaleLowerCase('es')
 ));
 if (!category) throw Error('Category was not found in the selected period.');
 const baseline = Math.max(0, category.amountMinor);
 const reduction = Math.round(baseline * args.reductionPercent / 100);
 return {
  isEstimate: true,
  persisted: false,
  currency: summary.currency,
  startDate: summary.startDate,
  endDate: summary.endDate,
  categoryName: category.categoryName,
  baselineExpenseMinor: baseline,
  reductionPercent: args.reductionPercent,
  estimatedReductionMinor: reduction,
  estimatedExpenseMinorAfterChange: Math.max(0, summary.expenseMinor - reduction)
 };
}

async function invokeFinancialFindings(args) {
 const response = await api(q('intelligence/findings', { startDate: args.startDate, endDate: args.endDate }));
 const data = response.data;
 if (!data || !Array.isArray(data.findings)) throw Error('Invalid financial findings response.');
 return {
  period: data.period,
  currency: data.currency,
  accountScopeLabel: data.accountScope?.label ?? null,
  findings: data.findings.slice(0, 50).map((finding) => ({
   id: finding.id,
   type: finding.type,
   title: finding.title,
   explanation: finding.explanation,
   period: finding.period,
   currency: finding.currency,
   confidence: finding.confidence,
   priority: finding.priority,
   priorityReason: finding.priorityReason,
   impactMinor: finding.impactMinor,
   metrics: finding.metrics,
   evidence: finding.evidence,
   limitations: finding.limitations,
   calculatedAt: finding.calculatedAt,
   reviewStatus: finding.reviewStatus
  })),
  truncated: data.findings.length > 50,
  warnings: data.warnings ?? []
 };
}

async function invokeBudgetAlerts(args) {
 const params = args.month ? { month: args.month } : {};
 const response = await api(q('budget-alerts', params));
 const data = response.data;
 if (!data || !Array.isArray(data.alerts) || !Array.isArray(data.categories)) {
  throw Error('Invalid budget alerts response.');
 }
 return {
  month: data.month,
  currency: data.currency,
  alerts: data.alerts.slice(0, 50).map((alert) => ({
   categoryName: alert.categoryName,
   metric: alert.metric,
   threshold: alert.threshold,
   observedValue: alert.observedValue,
   message: alert.message,
   status: alert.status
  })),
  categories: data.categories.slice(0, 100).map((category) => ({
   categoryName: category.categoryName,
   budgetedMinor: category.budgetedMinor,
   spentMinor: category.spentMinor,
   availableMinor: category.availableMinor,
   state: category.state
  })),
  truncated: data.categories.length > 100,
  warnings: data.warnings ?? []
 };
}

function mapBudgetProposal(proposal) {
 return {
  categoryName: proposal.categoryName,
  kind: proposal.kind,
  suggestedReductionPercent: proposal.suggestedReductionPercent,
  observedMonthlyExpenseMinor: proposal.observedMonthlyExpenseMinor,
  estimatedMonthlySavingsMinor: proposal.estimatedMonthlySavingsMinor,
  estimatedAnnualSavingsMinor: proposal.estimatedAnnualSavingsMinor,
  confidence: proposal.confidence,
  explanation: proposal.explanation,
  evidence: proposal.evidence,
  assumptions: proposal.assumptions,
  warnings: proposal.warnings,
  priorityRank: proposal.priorityRank,
  priorityReason: proposal.priorityReason,
  goalImpact: proposal.goalImpact ? {
   goalName: proposal.goalImpact.goalName,
   monthlyContributionGapMinor: proposal.goalImpact.monthlyContributionGapMinor,
   estimatedGapCoveredMinor: proposal.goalImpact.estimatedGapCoveredMinor,
   estimatedGapRemainingMinor: proposal.goalImpact.estimatedGapRemainingMinor
  } : null
 };
}

function mapSavingsGoal(goal) {
 const projection = goal.projection;
 return {
  name: goal.name,
  targetDate: goal.targetDate,
  targetAmountMinor: goal.targetAmountMinor,
  initialAmountMinor: goal.initialAmountMinor,
  monthlyContributionMinor: goal.monthlyContributionMinor,
  currency: goal.currency,
  status: goal.status,
  projection: projection ? {
   projectedBalanceMinor: projection.projectedBalanceMinor,
   projectedProgressPercent: projection.projectedProgressPercent,
   requiredMonthlyContributionMinor: projection.requiredMonthlyContributionMinor,
   estimatedCompletionDate: projection.estimatedCompletionDate,
   achievableUnderCashFlow: projection.achievableUnderCashFlow
  } : null,
  warnings: goal.warnings ?? []
 };
}

async function invokeBudgetImprovements(args) {
 const response = await api(q('budget-improvements', { periodMonths: String(args.periodMonths) }));
 const data = response.data;
 if (!data || !data.baseline || !Array.isArray(data.proposals)) {
  throw Error('Invalid budget improvement response.');
 }
 return {
  asOfDate: data.asOfDate,
  currency: data.currency,
  goal: data.goal,
  baseline: {
   startDate: data.baseline.startDate,
   endDate: data.baseline.endDate,
   periodMonths: data.baseline.periodMonths,
   monthlyIncomeMinor: data.baseline.monthlyIncomeMinor,
   monthlyExpenseMinor: data.baseline.monthlyExpenseMinor,
   monthlySavingsMinor: data.baseline.monthlySavingsMinor,
   savingsRatePercent: data.baseline.savingsRatePercent,
   transactionCount: data.baseline.transactionCount,
   unconvertedTransactionCount: data.baseline.unconvertedTransactionCount
  },
  proposals: data.proposals.slice(0, 25).map(mapBudgetProposal),
  savingsGoals: (data.savingsGoals ?? []).slice(0, 25).map(mapSavingsGoal),
  truncated: data.proposals.length > 25,
  warnings: data.warnings ?? []
 };
}

function mapCashFlowTimelinePoint(point) {
 return {
  date: point.date,
  netChangeMinor: point.netChangeMinor,
  totalInflowMinor: point.totalInflowMinor,
  totalOutflowMinor: point.totalOutflowMinor,
  totalTransferInflowMinor: point.totalTransferInflowMinor,
  totalTransferOutflowMinor: point.totalTransferOutflowMinor,
  projectedBalanceMinor: point.projectedBalanceMinor,
  belowReserve: point.belowReserve
 };
}

function mapRecurringProjectionCandidate(candidate) {
 return {
  candidateId: candidate.id,
  payee: candidate.payee,
  occurrenceCount: candidate.occurrenceCount,
  estimatedIntervalDays: candidate.estimatedIntervalDays,
  estimatedFrequency: candidate.estimatedFrequency,
  meanAbsoluteAmountMinor: candidate.meanAbsoluteAmountMinor,
  amountDeviationPercent: candidate.amountDeviationPercent,
  nextDate: candidate.nextDate,
  upcomingEventsCount: candidate.upcomingEventsCount,
  confidence: 'candidate_only',
  warnings: candidate.warnings ?? []
 };
}

async function invokeCashFlowProjection(args) {
 const body = {
  horizonDays: args.horizonDays,
  recurringCandidateIds: args.recurringCandidateIds,
  ...(args.reserveMinor === undefined ? {} : { reserveMinor: args.reserveMinor })
 };
 const response = await api('/api/v1/cash-flow/project', { method: 'POST', body });
 const data = response.data;
 const projection = data?.projection;
 if (!data || !projection || !Array.isArray(projection.timeline)) {
  throw Error('Invalid cash-flow projection response.');
 }
 const recurring = data.recurringCandidates ?? [];
 return {
  asOfDate: data.asOfDate,
  endDate: data.endDate,
  currency: data.currency,
  openingBalanceMinor: data.openingBalanceMinor,
  unknownOpeningAccountCount: Array.isArray(data.unknownOpeningAccounts) ? data.unknownOpeningAccounts.length : 0,
  projection: {
   isEstimate: true,
   openingBalanceMinor: projection.openingBalanceMinor,
   endingBalanceMinor: projection.endingBalanceMinor,
   minimumProjectedBalanceMinor: projection.minimumProjectedBalanceMinor,
   minimumBalanceDate: projection.minimumBalanceDate,
   firstDeficitDate: projection.firstDeficitDate,
   reserveMinor: projection.reserveMinor,
   firstReserveBreachDate: projection.firstReserveBreachDate,
   totalInflowMinor: projection.totalInflowMinor,
   totalOutflowMinor: projection.totalOutflowMinor,
   netChangeMinor: projection.netChangeMinor,
   sourceTotals: projection.sourceTotals,
   timeline: projection.timeline.map(mapCashFlowTimelinePoint),
   assumptions: projection.assumptions ?? [],
   warnings: projection.warnings ?? []
  },
  recurringCandidates: recurring.slice(0, 30).map(mapRecurringProjectionCandidate),
  truncated: recurring.length > 30,
  warnings: data.warnings ?? [],
  notes: data.notes ?? []
 };
}

async function invokeNetWorthSummary() {
 const response = await api('/api/v1/wealth/summary');
 const data = response.data;
 if (!data || !data.actual || !data.external || !data.coverage) {
  throw Error('Invalid net-worth summary response.');
 }
 return {
  asOfDate: data.asOfDate,
  currency: data.currency,
  status: data.status,
  netWorthMinor: data.netWorthMinor,
  actual: data.actual,
  external: data.external,
  liquidity: data.liquidity,
  coverage: {
   includedActualAccounts: data.coverage.includedActualAccounts,
   unclassifiedAccountCount: data.coverage.unclassifiedAccountIds?.length ?? 0,
   unconvertibleAccountCount: data.coverage.unconvertibleAccountIds?.length ?? 0,
   staleAssetCount: data.coverage.staleAssetIds?.length ?? 0,
   missingValuationCount: data.coverage.missingValuationIds?.length ?? 0,
   excludedDuplicateOrOptOutCount: data.coverage.excludedDuplicateOrOptOutIds?.length ?? 0
  },
  warnings: data.warnings ?? []
 };
}

const toolExecutors = {
 get_monthly_summary: invokeMonthlySummary,
 get_spending_by_category: invokeSpendingByCategory,
 compare_periods: invokePeriodComparison,
 get_yearly_overview: invokeYearlyOverview,
 get_uncategorized_transactions: invokeUncategorizedTransactions,
 get_recurring_candidates: invokeRecurringCandidates,
 simulate_budget_change: invokeBudgetSimulation,
 get_financial_findings: invokeFinancialFindings,
 get_budget_alerts: invokeBudgetAlerts,
 get_budget_improvement_context: invokeBudgetImprovements,
 project_cash_flow: invokeCashFlowProjection,
 get_net_worth_summary: invokeNetWorthSummary
};

export async function invoke(name, args) {
 const normalized = parse(name, args);
 const executor = toolExecutors[name];
 if (!executor) throw Error('Unknown tool.');
 return executor(normalized);
}

