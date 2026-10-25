import { createServer } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('MCP stdio protocol', () => {
 let child:ChildProcessWithoutNullStreams|undefined;let closeServer:(()=>Promise<void>)|undefined;
 afterEach(async()=>{child?.kill();child=undefined;await closeServer?.();closeServer=undefined;});
 it('initializes, lists tools, and rejects unknown tools and invalid arguments against a synthetic API',async()=>{
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{currency:'EUR',startDate:'2026-10-01',endDate:'2026-10-31',incomeMinor:200000,expenseMinor:10000,savingsMinor:190000,savingsRatePercent:95,transactionCount:2,excludedTransferCount:1,expensesByCategory:[{categoryName:'Alimentación',amountMinor:10000,transactionCount:1}],warnings:[]}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Synthetic server failed.');
  closeServer=()=>new Promise((resolveClose,reject)=>server.close(e=>e?reject(e):resolveClose()));
  child=spawn(process.execPath,[resolve('services/mcp/server.mjs')],{env:{...process.env,PERSONAL_BUDGET_API_URL:'http://127.0.0.1:'+address.port},stdio:['pipe','pipe','pipe']});
  let buffer='';child.stdout.on('data',(chunk:Buffer)=>{buffer+=chunk.toString('utf8');});
  const read=async()=>{const start=Date.now();while(Date.now()-start<4000){const i=buffer.indexOf('\n');if(i>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);return JSON.parse(line) as {id?:number;result?:{protocolVersion?:string;capabilities?:{tools?:object};tools?:{name:string;description:string}[];structuredContent?:{currency?:string;incomeMinor?:number;expenseMinor?:number};isError?:boolean};error?:unknown};}await new Promise(r=>setTimeout(r,10));}throw Error('MCP response timed out.');};
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  expect(await read()).toMatchObject({id:1,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}}}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
  const list=await read();expect(list.result?.tools?.map((t:{name:string})=>t.name)).toContain('get_monthly_summary');
  expect(list.result?.tools?.every((t:{description:string})=>/read-only/i.test(t.description))).toBe(true);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_monthly_summary',arguments:{month:'2026-10'}}})+'\n');
  expect((await read()).result?.structuredContent).toMatchObject({currency:'EUR',incomeMinor:200000,expenseMinor:10000});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'run_shell',arguments:{command:'whoami'}}})+'\n');expect((await read()).result?.isError).toBe(true);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_monthly_summary',arguments:{month:'2026-99',extra:'bad'}}})+'\n');expect((await read()).result?.isError).toBe(true);
 });
});
