import { createInterface } from 'node:readline';
const VERSION = '2024-11-05', MAX_LINE = 8192, MAX_OUTPUT = 65536, MAX_CALLS = 24, TIMEOUT = 5000;
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
{name:'simulate_budget_change',description:'Calculate hypothetical category reduction; never persists changes. Read-only.',inputSchema:schema({startDate:{type:'string'},endDate:{type:'string'},categoryName:{type:'string',minLength:1,maxLength:128},reductionPercent:{type:'number',minimum:0,maximum:100}},['startDate','endDate','categoryName','reductionPercent'])}
];
async function api(path) {
 const u=new URL(path,base.endsWith('/')?base:base+'/');
 const r=await fetch(u,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(TIMEOUT)});
 if(!r.ok) throw Error('Local finance API request failed.');
 const raw=await r.text(); if(raw.length>MAX_OUTPUT) throw Error('Local API response exceeds size limit.');
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
 }
 throw Error('Unknown tool.');
}
function error(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}};}
async function handle(m){
 if(!m||typeof m!=='object'||m.jsonrpc!=='2.0'||typeof m.method!=='string')return error(m?.id??null,-32600,'Invalid Request');
 const id=m.id;if(id===undefined&&m.method.startsWith('notifications/'))return null;
 if(m.method==='initialize')return {jsonrpc:'2.0',id,result:{protocolVersion:VERSION,capabilities:{tools:{}},serverInfo:{name:'personal-budget-readonly',version:'0.1.0'}}};
 if(m.method==='ping')return {jsonrpc:'2.0',id,result:{}};
 if(m.method==='tools/list')return {jsonrpc:'2.0',id,result:{tools}};
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
