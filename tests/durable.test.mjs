import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { createAssistantRuns } from '../src/assistant-runs.mjs';

const config={baseUrl:'https://example.com/v1',model:'synthetic',consent:true,apiKey:'FAKE_DURABLE_KEY',useTools:true};
const reply=message=>Response.json({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}]});
const tool=()=>reply({content:null,reasoning_content:'OPAQUE_CONTINUATION',tool_calls:[{id:'market-read',type:'function',function:{name:'get_market_data',arguments:'{"market":"HK"}'}}]});
async function within(promise){return Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Test stalled')),5000);timer.unref();})]);}

test('清空后即使进程重启也不恢复旧代号的持久任务或旧版无代号任务',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-reset-')),store=openStore(dir);store.saveConfig(config);
 const thread=store.createConversation(store.config().scopeId,'旧任务');store.reset(store.state().revision);
 const runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})});let calls=0;
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 t.mock.method(globalThis,'fetch',async()=>{calls++;return reply({content:'不应生成'});});
 for(const extra of [{ledgerGeneration:0},{}]){
   store.setKV('assistant_active_run',{id:'00000000-0000-4000-8000-000000000001',requestId:'old-reset-request',scopeId:store.config().scopeId,conversationId:thread.id,question:'旧任务',status:'running',snapshot:store.state(),history:[],startedAt:Date.now(),...extra});
   assert.equal(await runtime.resume(),null);assert.equal(store.getKV('assistant_active_run'),null);
 }
 assert.equal(calls,0);assert.equal(store.messages().length,0);assert.equal(store.state().assets.length,0);
});

test('重开持久会话接着完成工具之后的模型请求，不重算已完成的工具，也不重复保存回答',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-'));let store=openStore(dir);store.saveConfig(config);
 let runtime,calls=0,toolCalls=0,reached;const waiting=new Promise(r=>reached=r);
 t.mock.method(globalThis,'fetch',async(_url,{body,signal})=>{
   calls++;const input=JSON.parse(body);
   if(calls===1)return tool();
   assert.ok(input.messages.some(m=>m.role==='tool'));assert.equal(input.messages.find(m=>m.tool_calls)?.reasoning_content,'OPAQUE_CONTINUATION');
   if(calls===2)return new Promise((_,reject)=>{reached();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
   return reply({content:'已从保存的工具结果继续回答。'});
 });
 const services=()=>({getMarketData:async()=>{toolCalls++;return {market:'HK',date:'2026-10-23',indices:[]};}});
 runtime=createAssistantRuns(store,{dataDir:dir,services});
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const before=store.state({raw:true}),run=await runtime.start('虚构恢复测试','same-request');await within(waiting);
 const files=readdirSync(join(dir,'assistant-runs'));
 assert.ok(files.some(f=>f.endsWith('.sqlite')));
 for(const file of files){const path=join(dir,'assistant-runs',file);assert.equal(statSync(path).mode&0o777,0o600);assert.ok(!readFileSync(path).includes(Buffer.from(config.apiKey)));}
 await within(runtime.close());assert.equal(store.getKV('assistant_active_run').status,'running');store.close();
 store=openStore(dir);runtime=createAssistantRuns(store,{dataDir:dir,services});const resumed=await runtime.resume();
 const result=await within(resumed.promise);assert.equal(result.content,'已从保存的工具结果继续回答。');assert.equal(calls,3);assert.equal(toolCalls,1);assert.deepEqual(result.toolsUsed,[{name:'get_market_data',ok:true}]);
 assert.equal(result.toolCalls[0].args.market,'HK');assert.equal(result.toolCalls[0].output.date,'2026-10-23');assert.equal(result.toolCalls[0].status,'complete');
 assert.equal(store.messages().find(m=>m.role==='assistant').metadata.toolCalls[0].name,'get_market_data');
 const replay=[];runtime.subscribe(resumed,event=>replay.push(event));assert.ok(replay.some(e=>e.type==='tools'&&e.calls[0]?.output?.date==='2026-10-23'));
 assert.equal(store.messages().length,2);assert.deepEqual(store.state({raw:true}),before);assert.equal(store.getKV('assistant_active_run').snapshot,undefined);assert.equal(readdirSync(join(dir,'assistant-runs')).length,0);
 await (await runtime.start('虚构恢复测试','same-request')).promise;assert.equal(calls,3);assert.equal(store.messages().length,2);
 await assert.rejects(runtime.start('其他问题','same-request'),/用于其他内容/);
 store.addConversation('不应重复','不应重复',0,{durableRunId:run.meta.id});assert.equal(store.messages().length,2);
});

test('工具执行中重启只重放只读工具，已提交的模型工具请求不重发',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-tool-')),store=openStore(dir);store.saveConfig(config);
 let runtime,calls=0,toolCalls=0,reached;const waiting=new Promise(r=>reached=r);
 t.mock.method(globalThis,'fetch',async()=>++calls===1?tool():reply({content:'只读工具恢复完成。'}));
 const services=()=>({getMarketData:async()=>{if(++toolCalls===1){reached();return new Promise(()=>{});}return {market:'HK',date:'2026-10-23'};}});
 runtime=createAssistantRuns(store,{dataDir:dir,services});t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 await runtime.start('虚构工具恢复','tool-replay');await within(waiting);await within(runtime.close());
 runtime=createAssistantRuns(store,{dataDir:dir,services});const result=await within((await runtime.resume()).promise);
 assert.equal(result.content,'只读工具恢复完成。');assert.equal(calls,2);assert.equal(toolCalls,2);assert.equal(store.messages().length,2);
});

test('明确停止或撤回授权后不自动恢复，未完成回答不进入聊天历史',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-stop-')),store=openStore(dir);store.saveConfig(config);
 let runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})}),calls=0,reached;const waiting=new Promise(r=>reached=r);
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 t.mock.method(globalThis,'fetch',async(_url,{signal})=>{calls++;return new Promise((_,reject)=>{reached();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});});
 const run=await runtime.start('虚构停止测试','stop-test');await within(waiting);
 assert.equal((await runtime.start('虚构停止测试','stop-test')),run);
 await assert.rejects(runtime.start('并发问题','another-request'),e=>e.status===429);
 await within(runtime.stop(run.meta.id));assert.equal(runtime.view().status,'failed');assert.equal(store.messages().length,0);
 await runtime.close();runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})});await runtime.resume();assert.equal(calls,1);
 store.setKV('assistant_active_run',{...store.getKV('assistant_active_run'),status:'running'});store.saveConfig({...config,consent:false});await runtime.resume();assert.equal(store.getKV('assistant_active_run'),null);assert.equal(calls,1);
});

test('调用次数限制保存在持久文档中，达到限制时不会重试或保存伪成功回答',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-limits-')),store=openStore(dir);store.saveConfig(config);
 const runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({getMarketData:async()=>({date:'2026-10-23'})})});
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return tool();});
 const run=await runtime.start('虚构循环测试','limit-test');await assert.rejects(within(run.promise),e=>e.code==='AI_CALL_LIMIT');assert.equal(calls,5);assert.equal(store.messages().length,0);
});

test('删除正在回答的对话会停止持久任务，不复活记录，也不影响另一段对话',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-delete-')),store=openStore(dir);store.saveConfig(config);
 const keep=store.createConversation(store.config().scopeId);store.addConversation('保留问题','保留回复',0,{conversationId:keep.id,scopeId:store.config().scopeId,aiChat:true});
 const runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})});t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 let reached;const waiting=new Promise(r=>reached=r);
 t.mock.method(globalThis,'fetch',async(_url,{signal})=>new Promise((_,reject)=>{reached();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
 const run=await runtime.start('删除中的问题','delete-live',null);await within(waiting);
 await within(runtime.deleteConversation(run.meta.conversationId));
 assert.equal(runtime.view(),null);assert.equal(store.conversation(run.meta.conversationId),null);assert.equal(store.messages().length,2);assert.equal(store.conversations()[0].id,keep.id);
});

test('重启发现上下文开关变化时不恢复含旧上下文的任务',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-context-')),store=openStore(dir);store.saveConfig({...config,includeHistory:true});
 let runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})}),calls=0,reached;const waiting=new Promise(r=>reached=r);
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 t.mock.method(globalThis,'fetch',async(_url,{signal})=>new Promise((_,reject)=>{calls++;reached();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
 await runtime.start('上下文开关测试','context-toggle',null);await within(waiting);await within(runtime.close());
 store.saveConfig({...config,includeHistory:false});runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})});
 assert.equal(await runtime.resume(),null);assert.equal(calls,1);assert.equal(store.getKV('assistant_active_run'),null);
});

test('完整页面快照随本轮持久保存，重启不混入账本后续变动，下一轮读取新数据',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-pages-')),store=openStore(dir);store.saveConfig({...config,includePageData:true});
 const state=store.state();state.assets=[{id:'frozen-cash',name:'现金页面',account:'原账户',type:'cash',currency:'CNY',value:100,asOf:'2026-10-23'}];store.save(state,state.revision);
 let runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})}),calls=0,reached;const waiting=new Promise(r=>reached=r);
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 t.mock.method(globalThis,'fetch',async(_url,{body,signal})=>{
   const request=JSON.parse(body),snapshot=JSON.parse(request.messages[0].content.split('当前已授权财务快照（JSON 数据）：\n')[1]);calls++;
   assert.equal(snapshot.pageData.pages.assets.assets[0].value,calls<=3?100:200);
   if(calls===1)return reply({content:null,tool_calls:[{id:'frozen-read',type:'function',function:{name:'get_page_data',arguments:'{"page":"assets","section":"assets"}'}}]});
   if(calls<=3)assert.equal(JSON.parse(request.messages.at(-1).content).data[0].value,100);
   if(calls===2)return new Promise((_,reject)=>{reached();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
   return reply({content:'页面快照测试完成'});
 });
 await runtime.start('读取原页面','pages-once');await within(waiting);await within(runtime.close());
 const newer=store.state();newer.assets[0].value=200;store.save(newer,newer.revision);
 runtime=createAssistantRuns(store,{dataDir:dir,services:()=>({})});const result=await within((await runtime.resume()).promise);
 assert.equal(result.toolCalls[0].output.data[0].value,100);assert.equal(store.getKV('assistant_active_run').pageData,undefined);
 await within((await runtime.start('读取新页面','pages-next')).promise);assert.equal(calls,4);
});
