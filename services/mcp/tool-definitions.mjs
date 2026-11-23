export const MAX_OUTPUT = 65536;
export const MAX_CALLS = 24;

export function date(v) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d=new Date(v+'T00:00:00.000Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===v; }
export function period(a,b) { if(!date(a)||!date(b)) throw Error('Dates must use valid YYYY-MM-DD values.'); const n=Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'); if(n<0||n/86400000>366*5) throw Error('Period must be ordered and at most five years.'); }
export function exact(a,keys) { if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!keys.includes(k))) throw Error('Tool arguments contain unsupported fields.'); }
function text(v,label,max=128) { if(typeof v!=='string'||!v.trim()||v.trim().length>max) throw Error(label+' is invalid.'); return v.trim(); }
export function monthRange(m) { text(m,'month',7); if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m))throw Error('month must use YYYY-MM.'); return {startDate:m+'-01',endDate:new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(5,7)),0)).toISOString().slice(0,10)}; }
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
export const tools=[
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

export function parse(name, args) {
 const parser = argumentParsers[name];
 if (!parser) throw Error('Unknown tool.');
 return parser(args);
}

