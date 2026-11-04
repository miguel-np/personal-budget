import { createInterface } from 'node:readline';
const VERSION = '2024-11-05', MAX_LINE = 8192, MAX_OUTPUT = 65536, MAX_CALLS = 24;
const configuredTimeout = process.env.PERSONAL_BUDGET_MCP_API_TIMEOUT_MS;
const TIMEOUT = configuredTimeout === undefined ? 5000 : Number(configuredTimeout);
if (!Number.isInteger(TIMEOUT) || TIMEOUT < 100 || TIMEOUT > 30000) {
 process.stderr.write('PERSONAL_BUDGET_MCP_API_TIMEOUT_MS must be an integer from 100 to 30000.\n');
 process.exit(2);
}
let calls = 0;
const base = process.env.PERSONAL_BUDGET_API_URL || 'http://127.0.0.1:3000';
function loopback(value) {
  try { const u = new URL(value); return ['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname) && ['http:','https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
if (!loopback(base)) { process.stderr.write('MCP API URL must use loopback.\n'); process.exit(2); }
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
function parse(name,a){
 switch(name){
 case 'get_monthly_summary':exact(a,['month']);return monthRange(a.month);
 case 'get_spending_by_category':case 'get_uncategorized_transactions':exact(a,['startDate','endDate']);period(a.startDate,a.endDate);return a;
 case 'compare_periods':exact(a,['currentStartDate','currentEndDate','previousStartDate','previousEndDate']);period(a.currentStartDate,a.currentEndDate);period(a.previousStartDate,a.previousEndDate);return a;
 case 'get_yearly_overview':exact(a,['year']);if(!Number.isInteger(a.year)||a.year<2000||a.year>2100)throw Error('year must be an integer from 2000 to 2100.');return a;
 case 'get_recurring_candidates':exact(a,['startDate','endDate','limit']);period(a.startDate,a.endDate);if(a.limit!==undefined&&(!Number.isInteger(a.limit)||a.limit<1||a.limit>50))throw Error('limit must be from 1 to 50.');return {...a,limit:a.limit??20};
 case 'simulate_budget_change':exact(a,['startDate','endDate','categoryName','reductionPercent']);period(a.startDate,a.endDate);text(a.categoryName,'categoryName');if(typeof a.reductionPercent!=='number'||!Number.isFinite(a.reductionPercent)||a.reductionPercent<0||a.reductionPercent>100)throw Error('reductionPercent must be from 0 to 100.');return a;
 case 'get_financial_findings':exact(a,['startDate','endDate']);period(a.startDate,a.endDate);return a;
 case 'get_budget_alerts':exact(a,['month']);if(a.month!==undefined)monthRange(a.month);return a;
 case 'get_budget_improvement_context':exact(a,['periodMonths']);if(a.periodMonths!==undefined&&![3,6,12].includes(a.periodMonths))throw Error('periodMonths must be 3, 6 or 12.');return {...a,periodMonths:a.periodMonths??6};
 case 'project_cash_flow':exact(a,['horizonDays','reserveMinor','recurringCandidateIds']);if(a.horizonDays!==undefined&&![7,30,90].includes(a.horizonDays))throw Error('horizonDays must be 7, 30 or 90.');if(a.reserveMinor!==undefined&&(!Number.isSafeInteger(a.reserveMinor)||a.reserveMinor<0))throw Error('reserveMinor must be a non-negative safe integer.');if(a.recurringCandidateIds!==undefined&&(!Array.isArray(a.recurringCandidateIds)||a.recurringCandidateIds.length>50||a.recurringCandidateIds.some(id=>typeof id!=='string'||!/^rc_[a-f0-9]{24}$/.test(id))))throw Error('recurringCandidateIds are invalid.');return {...a,horizonDays:a.horizonDays??30,recurringCandidateIds:a.recurringCandidateIds??[]};
 case 'get_net_worth_summary':exact(a,[]);return {};
 default:throw Error('Unknown tool.');
 }
}
async function invoke(name,a){
 const x=parse(name,a);
 switch(name){
 case 'get_monthly_summary':return sum(x.startDate,x.endDate);
 case 'get_spending_by_category':{const s=await sum(x.startDate,x.endDate);return {currency:s.currency,startDate:s.startDate,endDate:s.endDate,expensesByCategory:s.expensesByCategory,warnings:s.warnings};}
 case 'compare_periods':{const [current,previous]=await Promise.all([sum(x.currentStartDate,x.currentEndDate),sum(x.previousStartDate,x.previousEndDate)]);return {currency:current.currency,current,previous,delta:{incomeMinor:current.incomeMinor-previous.incomeMinor,expenseMinor:current.expenseMinor-previous.expenseMinor,savingsMinor:current.savingsMinor-previous.savingsMinor}};}
 case 'get_yearly_overview':{const m=Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0'));const sums=await Promise.all(m.map(mm=>sum(x.year+'-'+mm+'-01',new Date(Date.UTC(x.year,Number(mm),0)).toISOString().slice(0,10))));return {year:x.year,currency:sums[0]?.currency,months:sums.map(s=>({month:s.startDate.slice(0,7),incomeMinor:s.incomeMinor,expenseMinor:s.expenseMinor,savingsMinor:s.savingsMinor,transactionCount:s.transactionCount}))};}
 case 'get_uncategorized_transactions':{const r=await rows(x.startDate,x.endDate,true);return {truncated:r.length>=200,transactions:r.slice(0,200).map(t=>({id:t.id,date:t.date,amount:t.amount,account:t.account,category:t.category??null}))};}
 case 'get_recurring_candidates':{const r=await rows(x.startDate,x.endDate);const groups=new Map();for(const t of r){const p=typeof t.payee_name==='string'?t.payee_name:typeof t.imported_payee==='string'?t.imported_payee:'';const k=p.trim().toLocaleLowerCase('es').replace(/\s+/g,' ');if(!k||!date(t.date)||!Number.isSafeInteger(t.amount))continue;const g=groups.get(k)??{label:p.slice(0,100),items:[]};g.items.push({date:t.date,amount:Math.abs(t.amount)});groups.set(k,g);}const candidates=[];for(const g of groups.values()){const z=g.items.sort((a,b)=>a.date.localeCompare(b.date));if(z.length<3)continue;const gaps=z.slice(1).map((t,i)=>(Date.parse(t.date+'T00:00:00Z')-Date.parse(z[i].date+'T00:00:00Z'))/86400000);const interval=gaps.reduce((a,b)=>a+b,0)/gaps.length;const mean=z.reduce((a,b)=>a+b.amount,0)/z.length;const deviation=mean?Math.max(...z.map(t=>Math.abs(t.amount-mean)/mean)):0;if(interval>=20&&interval<=45&&deviation<=.2)candidates.push({payee:g.label,occurrenceCount:z.length,estimatedIntervalDays:Math.round(interval),meanAbsoluteAmountMinor:Math.round(mean),dates:z.slice(-12).map(t=>t.date),confidence:'candidate_only',warning:'Historical pattern only; future payment is not guaranteed.'});}return {candidates:candidates.slice(0,x.limit),sourceRecords:r.length,truncated:r.length>=200};}
 case 'simulate_budget_change':{const s=await sum(x.startDate,x.endDate);const c=s.expensesByCategory.find(t=>t.categoryName.toLocaleLowerCase('es')===x.categoryName.toLocaleLowerCase('es'));if(!c)throw Error('Category was not found in the selected period.');const baseline=Math.max(0,c.amountMinor), reduction=Math.round(baseline*x.reductionPercent/100);return {isEstimate:true,persisted:false,currency:s.currency,startDate:s.startDate,endDate:s.endDate,categoryName:c.categoryName,baselineExpenseMinor:baseline,reductionPercent:x.reductionPercent,estimatedReductionMinor:reduction,estimatedExpenseMinorAfterChange:Math.max(0,s.expenseMinor-reduction)};}

 case 'get_financial_findings':{
  const r=await api(q('intelligence/findings',{startDate:x.startDate,endDate:x.endDate}));const d=r.data;
  if(!d||!Array.isArray(d.findings))throw Error('Invalid financial findings response.');
  return {period:d.period,currency:d.currency,accountScopeLabel:d.accountScope?.label??null,findings:d.findings.slice(0,50).map(f=>({id:f.id,type:f.type,title:f.title,explanation:f.explanation,period:f.period,currency:f.currency,confidence:f.confidence,priority:f.priority,priorityReason:f.priorityReason,impactMinor:f.impactMinor,metrics:f.metrics,evidence:f.evidence,limitations:f.limitations,calculatedAt:f.calculatedAt,reviewStatus:f.reviewStatus})),truncated:d.findings.length>50,warnings:d.warnings??[]};
 }
 case 'get_budget_alerts':{
  const r=await api(q('budget-alerts',x.month?{month:x.month}:{}));const d=r.data;
  if(!d||!Array.isArray(d.alerts)||!Array.isArray(d.categories))throw Error('Invalid budget alerts response.');
  return {month:d.month,currency:d.currency,alerts:d.alerts.slice(0,50).map(v=>({categoryName:v.categoryName,metric:v.metric,threshold:v.threshold,observedValue:v.observedValue,message:v.message,status:v.status})),categories:d.categories.slice(0,100).map(v=>({categoryName:v.categoryName,budgetedMinor:v.budgetedMinor,spentMinor:v.spentMinor,availableMinor:v.availableMinor,state:v.state})),truncated:d.categories.length>100,warnings:d.warnings??[]};
 }
 case 'get_budget_improvement_context':{
  const r=await api(q('budget-improvements',{periodMonths:String(x.periodMonths)}));const d=r.data;
  if(!d||!d.baseline||!Array.isArray(d.proposals))throw Error('Invalid budget improvement response.');
  return {asOfDate:d.asOfDate,currency:d.currency,goal:d.goal,baseline:{startDate:d.baseline.startDate,endDate:d.baseline.endDate,periodMonths:d.baseline.periodMonths,monthlyIncomeMinor:d.baseline.monthlyIncomeMinor,monthlyExpenseMinor:d.baseline.monthlyExpenseMinor,monthlySavingsMinor:d.baseline.monthlySavingsMinor,savingsRatePercent:d.baseline.savingsRatePercent,transactionCount:d.baseline.transactionCount,unconvertedTransactionCount:d.baseline.unconvertedTransactionCount},
   proposals:d.proposals.slice(0,25).map(p=>({categoryName:p.categoryName,kind:p.kind,suggestedReductionPercent:p.suggestedReductionPercent,observedMonthlyExpenseMinor:p.observedMonthlyExpenseMinor,estimatedMonthlySavingsMinor:p.estimatedMonthlySavingsMinor,estimatedAnnualSavingsMinor:p.estimatedAnnualSavingsMinor,confidence:p.confidence,explanation:p.explanation,evidence:p.evidence,assumptions:p.assumptions,warnings:p.warnings,priorityRank:p.priorityRank,priorityReason:p.priorityReason,goalImpact:p.goalImpact?{goalName:p.goalImpact.goalName,monthlyContributionGapMinor:p.goalImpact.monthlyContributionGapMinor,estimatedGapCoveredMinor:p.goalImpact.estimatedGapCoveredMinor,estimatedGapRemainingMinor:p.goalImpact.estimatedGapRemainingMinor}:null})),
   savingsGoals:(d.savingsGoals??[]).slice(0,25).map(g=>({name:g.name,targetDate:g.targetDate,targetAmountMinor:g.targetAmountMinor,initialAmountMinor:g.initialAmountMinor,monthlyContributionMinor:g.monthlyContributionMinor,currency:g.currency,status:g.status,projection:g.projection?{projectedBalanceMinor:g.projection.projectedBalanceMinor,projectedProgressPercent:g.projection.projectedProgressPercent,requiredMonthlyContributionMinor:g.projection.requiredMonthlyContributionMinor,estimatedCompletionDate:g.projection.estimatedCompletionDate,achievableUnderCashFlow:g.projection.achievableUnderCashFlow}:null,warnings:g.warnings??[]})),truncated:d.proposals.length>25,warnings:d.warnings??[]};
 }
 case 'project_cash_flow':{
  const body={horizonDays:x.horizonDays,recurringCandidateIds:x.recurringCandidateIds,...(x.reserveMinor===undefined?{}:{reserveMinor:x.reserveMinor})};
  const r=await api('/api/v1/cash-flow/project',{method:'POST',body});const d=r.data;const p=d?.projection;
  if(!d||!p||!Array.isArray(p.timeline))throw Error('Invalid cash-flow projection response.');
  return {asOfDate:d.asOfDate,endDate:d.endDate,currency:d.currency,openingBalanceMinor:d.openingBalanceMinor,unknownOpeningAccountCount:Array.isArray(d.unknownOpeningAccounts)?d.unknownOpeningAccounts.length:0,
   projection:{isEstimate:true,openingBalanceMinor:p.openingBalanceMinor,endingBalanceMinor:p.endingBalanceMinor,minimumProjectedBalanceMinor:p.minimumProjectedBalanceMinor,minimumBalanceDate:p.minimumBalanceDate,firstDeficitDate:p.firstDeficitDate,reserveMinor:p.reserveMinor,firstReserveBreachDate:p.firstReserveBreachDate,totalInflowMinor:p.totalInflowMinor,totalOutflowMinor:p.totalOutflowMinor,netChangeMinor:p.netChangeMinor,sourceTotals:p.sourceTotals,timeline:p.timeline.map(v=>({date:v.date,netChangeMinor:v.netChangeMinor,totalInflowMinor:v.totalInflowMinor,totalOutflowMinor:v.totalOutflowMinor,totalTransferInflowMinor:v.totalTransferInflowMinor,totalTransferOutflowMinor:v.totalTransferOutflowMinor,projectedBalanceMinor:v.projectedBalanceMinor,belowReserve:v.belowReserve})),assumptions:p.assumptions??[],warnings:p.warnings??[]},
   recurringCandidates:(d.recurringCandidates??[]).slice(0,30).map(v=>({candidateId:v.id,payee:v.payee,occurrenceCount:v.occurrenceCount,estimatedIntervalDays:v.estimatedIntervalDays,estimatedFrequency:v.estimatedFrequency,meanAbsoluteAmountMinor:v.meanAbsoluteAmountMinor,amountDeviationPercent:v.amountDeviationPercent,nextDate:v.nextDate,upcomingEventsCount:v.upcomingEventsCount,confidence:'candidate_only',warnings:v.warnings??[]})),truncated:(d.recurringCandidates??[]).length>30,warnings:d.warnings??[],notes:d.notes??[]};
 }
 case 'get_net_worth_summary':{
  const r=await api('/api/v1/wealth/summary');const d=r.data;
  if(!d||!d.actual||!d.external||!d.coverage)throw Error('Invalid net-worth summary response.');
  return {asOfDate:d.asOfDate,currency:d.currency,status:d.status,netWorthMinor:d.netWorthMinor,actual:d.actual,external:d.external,liquidity:d.liquidity,coverage:{includedActualAccounts:d.coverage.includedActualAccounts,unclassifiedAccountCount:d.coverage.unclassifiedAccountIds?.length??0,unconvertibleAccountCount:d.coverage.unconvertibleAccountIds?.length??0,staleAssetCount:d.coverage.staleAssetIds?.length??0,missingValuationCount:d.coverage.missingValuationIds?.length??0,excludedDuplicateOrOptOutCount:d.coverage.excludedDuplicateOrOptOutIds?.length??0},warnings:d.warnings??[]};
 }
 }
 throw Error('Unknown tool.');
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
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',async line=>{
 if(line.length>MAX_LINE){process.stdout.write(JSON.stringify(error(null,-32600,'Request too large.'))+'\n');return;}
 let m;try{m=JSON.parse(line);}catch{process.stdout.write(JSON.stringify(error(null,-32700,'Parse error'))+'\n');return;}
 const r=await handle(m).catch(()=>error(m?.id??null,-32603,'Internal error'));if(r)process.stdout.write(JSON.stringify(r)+'\n');
});
