import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {createLedgerService} from '../src/ledger.mjs';
import {createAssistantRuns} from '../src/assistant-runs.mjs';
const reply=message=>Response.json({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}]});
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function fixture(t,{afterWrite}={}){
 const dir=mkdtempSync(join(tmpdir(),'steady-operation-')),store=openStore(dir);
 store.saveConfig({baseUrl:'https://example.com/v1',model:'synthetic',consent:true,useTools:true,includeHistory:true,allowLedgerWrites:true});
 const state=store.state();state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000},...[["star","科创基金","011609"],["south","南方基金","008164"]].map(([id,name,code])=>({id,name,type:'fund',currency:'CNY',quantity:1000,value:2000,unit:'份',fund:{code,autoNav:true},costBasis:{amount:2000,quantity:1000,currency:'CNY'}}))];store.save(state,state.revision);
 const ledger=createLedgerService(store),services=(config,meta,control)=>{
  const bound=ledger.bind(meta,control),cash=bound.recordCashFlow;
  if(afterWrite)bound.recordCashFlow=async args=>{const result=await cash(args);await afterWrite(result);return result;};
  return {...bound,refreshLedgerContext:()=>({state:store.state()})};
 };
 let runtime=createAssistantRuns(store,{dataDir:dir,services});
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {store,ledger,get runtime(){return runtime;},async restart(){await runtime.close();runtime=createAssistantRuns(store,{dataDir:dir,services});}};
}
const income='收到3000元意外现金，帮我记录';
const cashArgs={evidence:income,side:'income',amount:3000,description:'意外现金'};

test('入账后回答失败会保留凭据，跨重启重发或继续只恢复原操作',async t=>{
 for(const followUp of [income,'继续'])await t.test(followUp,async t=>{
  const f=fixture(t);let requests=0;
  t.mock.method(globalThis,'fetch',async(_url,{body})=>{
   requests++;
   if(requests===1||requests===3||requests===5){
    if(requests===3)assert.match(JSON.parse(body).messages[0].content,/当前未完成记账操作/);
    return reply({content:null,tool_calls:[call('income','record_cash_flow',cashArgs)]});
   }
   if(requests===2)return new Response('synthetic failure',{status:503});
   return reply({content:'已记录。'});
  });
  const first=await f.runtime.start(income,'first',null);await assert.rejects(first.promise);
  assert.equal(f.store.state().assets[0].value,13000);assert.equal(f.store.messages().length,2);assert.match(f.store.messages().at(-1).content,/已记录收入3000/);
  await f.restart();
  const result=await(await f.runtime.start(followUp,'retry',first.meta.conversationId)).promise;
  assert.equal(result.toolCalls[0].output.replayed,true);assert.equal(f.store.state().assets[0].value,13000);assert.equal(f.store.ledgerEntries().length,1);
  // Once acknowledged, the same words can describe a separate new receipt.
  await(await f.runtime.start(income,'new-income',first.meta.conversationId)).promise;
  assert.equal(f.store.state().assets[0].value,16000);assert.equal(f.store.ledgerEntries().length,2);
 });
});

test('部分卖出成功与买入待补答分别保存状态，重启后只完成买入',async t=>{
 const f=fixture(t),question='我卖出科创100份，买入南方200份，每份成交价2元';let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{
  requests++;
  if(requests===1)return reply({content:null,tool_calls:[call('sale','record_holding_change',{query:'科创',evidence:question,side:'sell',quantity:100,price:2}),call('buy','record_holding_change',{query:'南方',evidence:question,side:'buy',quantity:200,price:2})]});
  if(requests===2)return reply({content:null,tool_calls:[call('continue-buy','record_holding_change',{query:'南方',evidence:question+'；现有现金',side:'buy',quantity:200,price:2,cashSource:'registered'})]});
  return reply({content:'已完成剩余买入。'});
 });
 const run=await f.runtime.start(question,'mixed',null),first=await run.promise;
 assert.deepEqual(first.toolCalls.map(c=>c.output.status),['applied','needs_information']);assert.match(first.content,/科创基金已入账/);assert.match(first.content,/南方.*现有现金/);
 await f.restart();const second=await(await f.runtime.start('现有现金','mixed-follow-up',run.meta.conversationId)).promise;
 assert.equal(second.toolCalls[0].output.status,'applied');assert.deepEqual(f.store.state().assets.slice(1).map(a=>a.quantity),[900,1200]);assert.equal(f.store.state().assets[0].value,9800);assert.equal(f.store.ledgerEntries().length,2);
 assert.ok(f.store.ledgerEntries().every(e=>e.requestId==='mixed'));
});

test('多标的方向和数量串错不能直接入账，harness依据对应原话纠正',async t=>{
 const f=fixture(t),question='我卖出科创100份，买入南方200份，用现有现金，每份成交价2元';
 const args={query:'科创',evidence:question,side:'buy',quantity:200,price:2};
 await assert.rejects(f.ledger.bind({question,requestId:'wrong',scopeId:f.store.config().scopeId,startedAt:Date.now()}).recordHoldingChange(args));
 assert.equal(f.store.ledgerEntries().length,0);
 let requests=0;
 t.mock.method(globalThis,'fetch',async()=>++requests===1?reply({content:null,tool_calls:[call('correct-trade','record_holding_change',args)]}):reply({content:'已按原话记录。'}));
 const result=await(await f.runtime.start(question,'correct',null)).promise;
 const receipt=result.toolCalls[0].output;assert.equal(receipt.side,'sell');assert.equal(receipt.quantity,100);assert.equal(receipt.asset.id,'star');assert.equal(receipt.after.quantity,900);assert.equal(receipt.after.cash,10200);assert.equal(requests,2);
});

test('100份被模型填为amount时自动修正，缺失的资金来源仍只追问一次',async t=>{
 const f=fixture(t);let requests=0;
 const question='用现有现金买入100份科创，每份成交价2元';
 t.mock.method(globalThis,'fetch',async()=>++requests===1?reply({content:null,tool_calls:[call('wrong-units','record_holding_change',{query:'科创',evidence:question,side:'buy',amount:100,price:2})]}):reply({content:'已记录100份。'}));
 const result=await(await f.runtime.start(question,'units',null)).promise;
 assert.equal(result.toolCalls[0].output.quantity,100);assert.equal(result.toolCalls[0].output.amount,200);assert.equal(f.store.state().assets[0].value,9800);assert.equal(requests,2);
 const missing='买入100份科创，每份成交价2元';
 t.mock.method(globalThis,'fetch',async()=>reply({content:null,tool_calls:[call('missing-source','record_holding_change',{query:'科创',evidence:missing,side:'buy',quantity:100,price:2})]}));
 const answer=await(await f.runtime.start(missing,'missing-source',null)).promise;
 assert.equal(answer.toolCalls[0].output.requiresUserInput,true);assert.match(answer.content,/现有现金.*额外投入/);assert.equal(f.store.ledgerEntries().length,1);
});

test('同一句无法分离的多标的不写账，自动纠正不绕过否定、假设和币种',async t=>{
 const f=fixture(t);
 for(const question of ['我买入科创100份和南方200份，用现有现金，每份成交价2元','如果我卖出科创100份，买入南方200份，用现有现金，每份成交价2元','我没有卖出科创100份，买入南方200份，用现有现金，每份成交价2元']){
  await assert.rejects(f.ledger.bind({question,requestId:'unsafe',scopeId:f.store.config().scopeId,startedAt:Date.now()}).recordHoldingChange({query:'科创',side:'buy',quantity:200,price:2,evidence:question}));
 }
 assert.equal(f.store.ledgerEntries().length,0);assert.equal(f.store.state().assets[0].value,10000);
});

test('补答入账后回答失败，继续保留已确认的资金来源和原交易日期',async t=>{
 const f=fixture(t),question='我在2026-10-29买入科创100份，每份成交价2元';let requests=0;
 const args={query:'科创',evidence:question,side:'buy',quantity:100,price:2};
 t.mock.method(globalThis,'fetch',async()=>{
  requests++;
  if([1,2,4].includes(requests))return reply({content:null,tool_calls:[call('buy','record_holding_change',args)]});
  if(requests===3)return new Response('synthetic failure',{status:503});
  return reply({content:'已恢复原买入。'});
 });
 const run=await f.runtime.start(question,'source-missing',null);assert.match((await run.promise).content,/现有现金/);
 await assert.rejects((await f.runtime.start('现有现金','source-provided',run.meta.conversationId)).promise);
 assert.equal(f.store.state().assets[0].value,9800);await f.restart();
 const result=await(await f.runtime.start('继续','retry-follow-up',run.meta.conversationId)).promise;
 assert.equal(result.toolCalls[0].output.replayed,true);assert.equal(result.toolCalls[0].output.date,'2026-10-29');assert.equal(f.store.ledgerEntries().length,1);assert.equal(f.store.state().assets[0].value,9800);
});

test('另一笔操作不会覆盖失败凭据，不同对话相同原话仍是独立收入',async t=>{
 const f=fixture(t);let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{
  requests++;
  if(requests===2)return new Response('synthetic failure',{status:503});
  if([1,3,5,7].includes(requests))return reply({content:null,tool_calls:[call('cash','record_cash_flow',requests===3?{...cashArgs,evidence:'收到100元红包',amount:100}:cashArgs)]});
  return reply({content:'已记录。'});
 });
 const original=await f.runtime.start(income,'old-failure',null);await assert.rejects(original.promise);
 await(await f.runtime.start('收到100元红包','other-operation',original.meta.conversationId)).promise;
 const recovered=await(await f.runtime.start(income,'recover-old',original.meta.conversationId)).promise;
 assert.equal(recovered.toolCalls[0].output.replayed,true);assert.equal(f.store.state().assets[0].value,13100);
 await(await f.runtime.start(income,'other-conversation',null)).promise;
 assert.equal(f.store.state().assets[0].value,16100);assert.equal(f.store.ledgerEntries().length,3);
});

test('清空对话会删除操作草稿，清空财务档案后不复用旧操作',async t=>{
 const f=fixture(t);let requests=0;
 t.mock.method(globalThis,'fetch',async()=>++requests%2?reply({content:null,tool_calls:[call('cash','record_cash_flow',cashArgs)]}):new Response('synthetic failure',{status:503}));
 const first=await f.runtime.start(income,'private-draft',null);await assert.rejects(first.promise);
 assert.ok(f.store.getKV('assistant_operations:'+first.meta.conversationId+':private-draft'));
 f.store.reset(f.store.state().revision);await f.runtime.invalidate();
 const state=f.store.state();state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:0}];f.store.save(state,state.revision);
 const next=await f.runtime.start(income,'new-generation',first.meta.conversationId);await assert.rejects(next.promise);
 assert.equal(f.store.state().assets[0].value,3000);
 await f.runtime.deleteConversation(first.meta.conversationId);
 assert.equal(f.store.getKV('assistant_operations:'+first.meta.conversationId),null);
 assert.equal(f.store.getKV('assistant_operations:'+first.meta.conversationId+':private-draft'),null);
 assert.equal(f.store.getKV('assistant_operations:'+first.meta.conversationId+':new-generation'),null);
});

test('未登记的另一标的也不能向当前标的提供买卖方向或数量',async t=>{
 const f=fixture(t),question='我卖出科创100份，买入未知基金200份，用现有现金，每份成交价2元';
 for(const args of [{side:'buy',quantity:200},{side:'sell',quantity:200}])await assert.rejects(f.ledger.bind({question,requestId:'unknown-other',scopeId:f.store.config().scopeId,startedAt:Date.now()}).recordHoldingChange({query:'科创',evidence:question,price:2,...args}));
 assert.equal(f.store.ledgerEntries().length,0);
});

test('入账提交与工具结果保存之间重启，凭据与草稿恢复后不再执行收入',async t=>{
 let reached,paused=false;const waiting=new Promise(resolve=>{reached=resolve;});
 const f=fixture(t,{afterWrite:async()=>{if(!paused){paused=true;reached();await new Promise(()=>{});}}});let requests=0;
 t.mock.method(globalThis,'fetch',async()=>++requests===1?reply({content:null,tool_calls:[call('cash','record_cash_flow',cashArgs)]}):reply({content:'已从入账凭据恢复。'}));
 await f.runtime.start(income,'commit-gap',null);await waiting;
 assert.equal(f.store.state().assets[0].value,13000);assert.equal(f.store.messages().length,0);
 await f.restart();const result=await(await f.runtime.resume()).promise;
 assert.equal(result.toolCalls[0].output.replayed,true);assert.equal(f.store.ledgerEntries().length,1);assert.equal(f.store.state().assets[0].value,13000);assert.equal(requests,2);
});

test('多笔交易的现金与日期短答继续使用原操作身份',async t=>{
 for(const [question,answer] of [['我卖出科创100份，买入南方200份，每份成交价2元','现金'],['我卖出科创100份，前几天买入南方200份，用现有现金，每份成交价2元','今天买入的']])await t.test(answer,async t=>{
  const f=fixture(t);let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{
   if(++requests===1)return reply({content:null,tool_calls:[call('sell','record_holding_change',{query:'科创',evidence:question,side:'sell',quantity:100,price:2}),call('buy','record_holding_change',{query:'南方',evidence:question,side:'buy',quantity:200,price:2})]});
   if(requests===2)return reply({content:null,tool_calls:[call('buy-follow-up','record_holding_change',{query:'南方',evidence:question,side:'buy',quantity:200,price:2})]});
   return reply({content:'已完成剩余记录。'});
  });
  const first=await f.runtime.start(question,'two-trades',null);assert.equal((await first.promise).toolCalls[1].output.status,'needs_information');
  const result=await(await f.runtime.start(answer,'short-answer',first.meta.conversationId)).promise;
  assert.equal(result.toolCalls[0].output.status,'applied');assert.equal(f.store.ledgerEntries().length,2);assert.ok(f.store.ledgerEntries().every(e=>e.requestId==='two-trades'));
 });
});
