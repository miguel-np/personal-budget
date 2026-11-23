import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { tools, MAX_CALLS, MAX_OUTPUT, exact, period, monthRange } from './tool-definitions.mjs';
import { invoke } from './tool-executors.mjs';
import { baseValid, timeoutValid } from './runtime-config.mjs';

const VERSION = '2024-11-05';
const MAX_LINE = 8192;

const prompts = [
 {name:'monthly_financial_review',title:'Monthly financial review',description:'Review an explicit period against the previous period using deterministic summaries and findings.',arguments:[{name:'startDate',description:'Current period start, YYYY-MM-DD.',required:true},{name:'endDate',description:'Current period end, YYYY-MM-DD.',required:true},{name:'previousStartDate',description:'Previous comparison period start, YYYY-MM-DD.',required:true},{name:'previousEndDate',description:'Previous comparison period end, YYYY-MM-DD.',required:true}]},
 {name:'budget_coaching',title:'Budget coaching',description:'Review monthly budget alerts and evidence-backed improvement proposals; simulate rather than apply changes.',arguments:[{name:'month',description:'Budget month, YYYY-MM. Defaults to the application current month.',required:false},{name:'periodMonths',description:'Historical baseline: 3, 6 or 12 months. Defaults to 6.',required:false}]},
 {name:'cash_flow_review',title:'Cash-flow review',description:'Review the local 7/30/90-day cash-flow estimate and distinguish confirmed events from candidates.',arguments:[{name:'horizonDays',description:'Projection horizon: 7, 30 or 90 days. Defaults to 30.',required:false}]},
 {name:'recurring_payment_audit',title:'Recurring-payment audit',description:'Inspect historical recurring-payment candidates without treating them as confirmed subscriptions.',arguments:[{name:'startDate',description:'Historical period start, YYYY-MM-DD.',required:true},{name:'endDate',description:'Historical period end, YYYY-MM-DD.',required:true}]},
 {name:'wealth_review',title:'Net-worth review',description:'Review net-worth totals together with completeness and valuation coverage.',arguments:[]},
];

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
