import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
const VERSION = '2024-11-05', MAX_LINE = 8192, MAX_OUTPUT = 65536, MAX_CALLS = 24;
const configuredTimeout = process.env.PERSONAL_BUDGET_MCP_API_TIMEOUT_MS;
const parsedTimeout = configuredTimeout === undefined ? 5000 : Number(configuredTimeout);
const timeoutValid = Number.isInteger(parsedTimeout) && parsedTimeout >= 100 && parsedTimeout <= 30000;
function loopback(value) {
  try { const u = new URL(value); return ['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname) && ['http:','https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
const configuredBase = process.env.PERSONAL_BUDGET_API_URL || 'http://127.0.0.1:3000';
const baseValid = loopback(configuredBase);
const TIMEOUT = timeoutValid ? parsedTimeout : 5000;
const base = baseValid ? configuredBase : 'http://127.0.0.1:3000';
function date(v) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d=new Date(v+'T00:00:00.000Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===v; }
function period(a,b) { if(!date(a)||!date(b)) throw Error('Dates must use valid YYYY-MM-DD values.'); const n=Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'); if(n<0||n/86400000>366*5) throw Error('Period must be ordered and at most five years.'); }
function exact(a,keys) { if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!keys.includes(k))) throw Error('Tool arguments contain unsupported fields.'); }
function text(v,label,max=128) { if(typeof v!=='string'||!v.trim()||v.trim().length>max) throw Error(label+' is invalid.'); return v.trim(); }
function monthRange(m) { text(m,'month',7); if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m))throw Error('month must use YYYY-MM.'); return {startDate:m+'-01',endDate:new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(5,7)),0)).toISOString().slice(0,10)}; }
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const tools=[
{name:'get_monthly_summary',description:'Deterministic calendar-month totals. Read-only.',inputSchema:schema({month:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$'}},['month'])},
{name:'get_spending_by_category',description:'Calculated category totals for a validated period. Read-only.',inputSchema:schema({startDate:{type:'string'},endDate:{type:'string'}},['startDate','endDate'])},
{name:'compare_periods',description:'Compare two explicit date periods using deterministic totals. Read-only.',inputSchema:schema({currentStartDate:{type:'string'},currentEndDate:{type:'string'},previousStartDate:{type:'string'},previousEndDate:{type:'string'}},['currentStartDate','currentEndDate','previousStartDate','previousEndDate'])},
{name:'get_yearly_overview',description:'Deterministic summaries for each month of a year. Read-only.',inputSchema:schema({year:{type:'integer',minimum:2000,maximum:2100}},['year'])},
{name:'get_uncategorized_transactions',description:'List up to 200 IDs, dates, amounts and accounts without transaction descriptions. Read-only.',inputSchema:schema({startDate:{type:'string'},endDate:{type:'string'}},['startDate','endDate'])},
{name:'get_recurring_candidates',description:'Find historical recurring-payment candidates; never a guarantee. Read-only.',inputSchema:schema({startDate:{type:'string'},endDate:{type:'string'},limit:{type:'integer',minimum:1,maximum:50}},['startDate','endDate'])},
{name:'simulate_budget_change',description:'Calculate hypothetical category reduction; never persists changes. Read-only.',inputSchema:schema({startDate:{type:'string'},endDate:{type:'string'},categoryName:{type:'string',minLength:1,maxLength:128},reductionPercent:{type:'number',minimum:0,maximum:100}},['startDate','endDate','categoryName','reductionPercent'])},

{name:'get_financial_findings',description:'Return evidence-backed financial findings for an explicit period. Omits account identifiers. Read-only.',inputSchema:schema({startDate:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},endDate:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}},['startDate','endDate'])},
{name:'get_budget_alerts',description:'Read active budget threshold alerts and category budget totals for a month. Read-only.',inputSchema:schema({month:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$'}},[])},
{name:'get_budget_improvement_context',description:'Read deterministic budget-improvement proposals, observed baselines and savings-goal context. Read-only.',inputSchema:schema({periodMonths:{type:'integer',enum:[3,6,12]}},[])},
{name:'project_cash_flow',description:'Create a bounded 7/30/90-day cash-flow estimate. POSTs only to a non-persisting projection endpoint; never writes financial data.',inputSchema:schema({horizonDays:{type:'integer',enum:[7,30,90]},reserveMinor:{type:'integer',minimum:0},recurringCandidateIds:{type:'array',items:{type:'string',pattern:'^rc_[a-f0-9]{24}$'},maxItems:50}},[])},
{name:'get_net_worth_summary',description:'Read consolidated net-worth totals and coverage status; omits account and asset identifiers. Read-only.',inputSchema:schema({},[])}
];

const prompts = [
 {name:'monthly_financial_review',title:'Monthly financial review',description:'Review an explicit period against the previous period using deterministic summaries and findings.',arguments:[{name:'startDate',description:'Current period start, YYYY-MM-DD.',required:true},{name:'endDate',description:'Current period end, YYYY-MM-DD.',required:true},{name:'previousStartDate',description:'Previous comparison period start, YYYY-MM-DD.',required:true},{name:'previousEndDate',description:'Previous comparison period end, YYYY-MM-DD.',required:true}]},
 {name:'budget_coaching',title:'Budget coaching',description:'Review monthly budget alerts and evidence-backed improvement proposals; simulate rather than apply changes.',arguments:[{name:'month',description:'Budget month, YYYY-MM. Defaults to the application current month.',required:false},{name:'periodMonths',description:'Historical baseline: 3, 6 or 12 months. Defaults to 6.',required:false}]},
 {name:'cash_flow_review',title:'Cash-flow review',description:'Review the local 7/30/90-day cash-flow estimate and distinguish confirmed events from candidates.',arguments:[{name:'horizonDays',description:'Projection horizon: 7, 30 or 90 days. Defaults to 30.',required:false}]},
 {name:'recurring_payment_audit',title:'Recurring-payment audit',description:'Inspect historical recurring-payment candidates without treating them as confirmed subscriptions.',arguments:[{name:'startDate',description:'Historical period start, YYYY-MM-DD.',required:true},{name:'endDate',description:'Historical period end, YYYY-MM-DD.',required:true}]},
 {name:'wealth_review',title:'Net-worth review',description:'Review net-worth totals together with completeness and valuation coverage.',arguments:[]},
];

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
function parseMonthlySummary(args) {
 exact(args, ['month']);
 return monthRange(args.month);
}

function parsePeriodRange(args) {
 exact(args, ['startDate', 'endDate']);
 period(args.startDate, args.endDate);
 return args;
}

function parseComparisonPeriods(args) {
 exact(args, ['currentStartDate', 'currentEndDate', 'previousStartDate', 'previousEndDate']);
 period(args.currentStartDate, args.currentEndDate);
 period(args.previousStartDate, args.previousEndDate);
 return args;
}

function parseYear(args) {
 exact(args, ['year']);
 if (!Number.isInteger(args.year) || args.year < 2000 || args.year > 2100) {
  throw Error('year must be an integer from 2000 to 2100.');
 }
 return args;
}

function parseRecurringCandidates(args) {
 exact(args, ['startDate', 'endDate', 'limit']);
 period(args.startDate, args.endDate);
 if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) {
  throw Error('limit must be from 1 to 50.');
 }
 return { ...args, limit: args.limit ?? 20 };
}

function parseBudgetSimulation(args) {
 exact(args, ['startDate', 'endDate', 'categoryName', 'reductionPercent']);
 period(args.startDate, args.endDate);
 text(args.categoryName, 'categoryName');
 const reduction = args.reductionPercent;
 if (typeof reduction !== 'number' || !Number.isFinite(reduction) || reduction < 0 || reduction > 100) {
  throw Error('reductionPercent must be from 0 to 100.');
 }
 return args;
}

function parseFinancialFindings(args) {
 return parsePeriodRange(args);
}

function parseBudgetAlerts(args) {
 exact(args, ['month']);
 if (args.month !== undefined) monthRange(args.month);
 return args;
}

function parseBudgetImprovements(args) {
 exact(args, ['periodMonths']);
 if (args.periodMonths !== undefined && ![3, 6, 12].includes(args.periodMonths)) {
  throw Error('periodMonths must be 3, 6 or 12.');
 }
 return { ...args, periodMonths: args.periodMonths ?? 6 };
}

function parseCashFlowProjection(args) {
 exact(args, ['horizonDays', 'reserveMinor', 'recurringCandidateIds']);
 if (args.horizonDays !== undefined && ![7, 30, 90].includes(args.horizonDays)) {
  throw Error('horizonDays must be 7, 30 or 90.');
 }
 if (args.reserveMinor !== undefined && (!Number.isSafeInteger(args.reserveMinor) || args.reserveMinor < 0)) {
  throw Error('reserveMinor must be a non-negative safe integer.');
 }
 const ids = args.recurringCandidateIds;
 if (ids !== undefined && (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !/^rc_[a-f0-9]{24}$/.test(id)))) {
  throw Error('recurringCandidateIds are invalid.');
 }
 return { ...args, horizonDays: args.horizonDays ?? 30, recurringCandidateIds: ids ?? [] };
}

function parseNetWorthSummary(args) {
 exact(args, []);
 return {};
}

const argumentParsers = {
 get_monthly_summary: parseMonthlySummary,
 get_spending_by_category: parsePeriodRange,
 get_uncategorized_transactions: parsePeriodRange,
 compare_periods: parseComparisonPeriods,
 get_yearly_overview: parseYear,
 get_recurring_candidates: parseRecurringCandidates,
 simulate_budget_change: parseBudgetSimulation,
 get_financial_findings: parseFinancialFindings,
 get_budget_alerts: parseBudgetAlerts,
 get_budget_improvement_context: parseBudgetImprovements,
 project_cash_flow: parseCashFlowProjection,
 get_net_worth_summary: parseNetWorthSummary
};

function parse(name, args) {
 const parser = argumentParsers[name];
 if (!parser) throw Error('Unknown tool.');
 return parser(args);
}

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

async function invoke(name, args) {
 const normalized = parse(name, args);
 const executor = toolExecutors[name];
 if (!executor) throw Error('Unknown tool.');
 return executor(normalized);
}

async function promptResponse(id, params) {
 const name = params?.name;
 const prompt = prompts.find((candidate) => candidate.name === name);
 if (!prompt) return error(id ?? null, -32602, 'Unknown prompt.');
 try {
  const args = parsePrompt(name, params?.arguments ?? {});
  return {
   jsonrpc: '2.0',
   id,
   result: {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text: promptText(name, args) } }]
   }
  };
 } catch (cause) {
  const message = cause instanceof Error && /invalid|must |unsupported|period|date|limit|unknown/i.test(cause.message)
   ? cause.message
   : 'Invalid prompt arguments.';
  return error(id ?? null, -32602, message);
 }
}

async function toolCallResponse(id, params, incrementCalls) {
 if (incrementCalls() > MAX_CALLS) {
  return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Session tool-call limit reached.' }] } };
 }
 const name = params?.name;
 if (!tools.some((candidate) => candidate.name === name)) {
  return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Unknown tool; no action was taken.' }] } };
 }
 try {
  const data = await invoke(name, params?.arguments ?? {});
  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_OUTPUT) throw Error('Tool response exceeds size limit.');
  return { jsonrpc: '2.0', id, result: { isError: false, structuredContent: data, content: [{ type: 'text', text: serialized }] } };
 } catch (cause) {
  const message = cause instanceof Error && /invalid|must |found|unsupported|unknown|limit|period|date|category|year|month|size/i.test(cause.message)
   ? cause.message
   : 'Local finance tool failed.';
  return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } };
 }
}

export function createMcpHandler() {
 let calls = 0;
 return async function handle(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
   return error(message?.id ?? null, -32600, 'Invalid Request');
  }
  const id = message.id;
  if (id === undefined && message.method.startsWith('notifications/')) return null;
  switch (message.method) {
   case 'initialize':
    return { jsonrpc: '2.0', id, result: { protocolVersion: VERSION, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'personal-budget-readonly', version: '0.2.0' } } };
   case 'ping':
    return { jsonrpc: '2.0', id, result: {} };
   case 'tools/list':
    return { jsonrpc: '2.0', id, result: { tools } };
   case 'prompts/list':
    return { jsonrpc: '2.0', id, result: { prompts } };
   case 'prompts/get':
    return promptResponse(id, message.params);
   case 'tools/call':
    return toolCallResponse(id, message.params, () => ++calls);
   default:
    return error(id ?? null, -32601, 'Method not found');
  }
 };
}

function parsePrompt(name,args) {
 if(name==='monthly_financial_review'){exact(args,['startDate','endDate','previousStartDate','previousEndDate']);period(args.startDate,args.endDate);period(args.previousStartDate,args.previousEndDate);return args;}
 if(name==='budget_coaching'){exact(args,['month','periodMonths']);if(args.month!==undefined)monthRange(args.month);if(args.periodMonths!==undefined&&![3,6,12].includes(args.periodMonths))throw Error('periodMonths must be 3, 6 or 12.');return {...args,periodMonths:args.periodMonths??6};}
 if(name==='cash_flow_review'){exact(args,['horizonDays']);if(args.horizonDays!==undefined&&![7,30,90].includes(args.horizonDays))throw Error('horizonDays must be 7, 30 or 90.');return {horizonDays:args.horizonDays??30};}
 if(name==='recurring_payment_audit'){exact(args,['startDate','endDate']);period(args.startDate,args.endDate);return args;}
 if(name==='wealth_review'){exact(args,[]);return {};}
 throw Error('Unknown prompt.');
}
function promptText(name,args) {
 if(name==='monthly_financial_review')return 'Revisa el periodo '+args.startDate+' a '+args.endDate+' y compáralo con '+args.previousStartDate+' a '+args.previousEndDate+'. Usa compare_periods, get_spending_by_category y get_financial_findings. No inventes ni recalcules importes; separa hechos observados, estimaciones, candidatos, advertencias y hasta tres acciones sugeridas. No modifiques datos ni atribuyas causas no medidas.';
 if(name==='budget_coaching')return 'Revisa el presupuesto del mes '+(args.month??'(mes actual de la aplicación)')+' y la ventana histórica de '+args.periodMonths+' meses. Consulta get_budget_alerts y get_budget_improvement_context. Explica evidencia, clasificación, supuestos y advertencias. Puedes usar simulate_budget_change para escenarios hipotéticos no persistentes. No recomiendes recortar categorías esenciales/protegidas por defecto y no guardes preferencias, escenarios ni decisiones.';
 if(name==='cash_flow_review')return 'Revisa la proyección de caja a '+args.horizonDays+' días con project_cash_flow. Separa movimientos registrados, compromisos, recurrencias confirmadas y candidatos; estos últimos solo se incluyen si el usuario los selecciona expresamente. Destaca fechas de déficit/reserva solo cuando existan. El saldo es estimado, no saldo bancario disponible garantizado. No crees ni modifiques pagos o compromisos.';
 if(name==='recurring_payment_audit')return 'Audita patrones potencialmente recurrentes entre '+args.startDate+' y '+args.endDate+' usando get_recurring_candidates. Agrupa por beneficiario, frecuencia, variabilidad y fechas. Distingue candidatos de suscripciones confirmadas. No asumas que habrá un cargo futuro ni recomiendes cancelar sin verificación manual. No edites movimientos ni compromisos.';
 return 'Revisa el patrimonio con get_net_worth_summary. Si el estado es incomplete o netWorthMinor es null, explica la cobertura faltante y no fabriques un total alternativo. Separa Actual y activos/pasivos externos. No infieras rentabilidad, valor de mercado ni recomendaciones de inversión; no modifiques activos, valoraciones ni clasificaciones.';
}

function error(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}};}
export function createMcpHandler() {
 let calls = 0;
 async function handle(m){
 if(!m||typeof m!=='object'||m.jsonrpc!=='2.0'||typeof m.method!=='string')return error(m?.id??null,-32600,'Invalid Request');
 const id=m.id;if(id===undefined&&m.method.startsWith('notifications/'))return null;
 if(m.method==='initialize')return {jsonrpc:'2.0',id,result:{protocolVersion:VERSION,capabilities:{tools:{},prompts:{}},serverInfo:{name:'personal-budget-readonly',version:'0.2.0'}}};
 if(m.method==='ping')return {jsonrpc:'2.0',id,result:{}};
 if(m.method==='tools/list')return {jsonrpc:'2.0',id,result:{tools}};
 if(m.method==='prompts/list')return {jsonrpc:'2.0',id,result:{prompts}};
 if(m.method==='prompts/get'){
  const name=m.params?.name;
  if(typeof name!=='string'||!prompts.some(prompt=>prompt.name===name))return error(id??null,-32602,'Unknown prompt.');
  try{const args=parsePrompt(name,m.params?.arguments??{});return {jsonrpc:'2.0',id,result:{description:prompts.find(prompt=>prompt.name===name).description,messages:[{role:'user',content:{type:'text',text:promptText(name,args)}}]}};}
  catch(e){const message=e instanceof Error&&/invalid|must |unsupported|period|date|limit|unknown/i.test(e.message)?e.message:'Invalid prompt arguments.';return error(id??null,-32602,message);}
 }
 if(m.method==='tools/call'){
  if(++calls>MAX_CALLS)return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'Session tool-call limit reached.'}]}};
  const name=m.params?.name;if(!tools.some(t=>t.name===name))return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'Unknown tool; no action was taken.'}]}};
  try{const data=await invoke(name,m.params?.arguments??{});const s=JSON.stringify(data);if(s.length>MAX_OUTPUT)throw Error('Tool response exceeds size limit.');return {jsonrpc:'2.0',id,result:{isError:false,structuredContent:data,content:[{type:'text',text:s}]}};}
  catch(e){const s=e instanceof Error&&/invalid|must |found|unsupported|unknown|limit|period|date|category|year|month|size/i.test(e.message)?e.message:'Local finance tool failed.';return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:s}]}};
  }
 }
 return error(id??null,-32601,'Method not found');
}
 return handle;
}

export function startMcpStdio({
 inputStream = process.stdin,
 outputStream = process.stdout,
 errorStream = process.stderr,
 handler = createMcpHandler()
} = {}) {
 if (!timeoutValid) {
  errorStream.write('PERSONAL_BUDGET_MCP_API_TIMEOUT_MS must be an integer from 100 to 30000.\n');
  process.exitCode = 2;
  return null;
 }
 if (!baseValid) {
  errorStream.write('MCP API URL must use loopback.\n');
  process.exitCode = 2;
  return null;
 }
 const input = createInterface({ input: inputStream, crlfDelay: Infinity });
 input.on('line', async line => {
  if (line.length > MAX_LINE) {
   outputStream.write(JSON.stringify(error(null, -32600, 'Request too large.')) + '\n');
   return;
  }
  let message;
  try { message = JSON.parse(line); }
  catch {
   outputStream.write(JSON.stringify(error(null, -32700, 'Parse error')) + '\n');
   return;
  }
  const result = await handler(message).catch(() => error(message?.id ?? null, -32603, 'Internal error'));
  if (result) outputStream.write(JSON.stringify(result) + '\n');
 });
 return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const input = startMcpStdio();
 if (input === null) process.exit(process.exitCode ?? 2);
}
