import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { buildAssistantData, automaticPageContext, readAssistantPage } from '../src/assistant-data.mjs';
import { runAssistant } from '../src/ai.mjs';
import { createAssistantServices } from '../src/market-access.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'finance-page-data-')),store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.saveConfig({baseUrl:'https://example.com/v1',model:'synthetic',apiKey:'PRIVATE_API_KEY',consent:true,includePageData:true});
  store.setKV('auth',{hash:'PRIVATE_PASSWORD_HASH'});
  const state=store.state();state.profile.income=12345;state.preferences.rates.USD=7.1;
  state.assets=Array.from({length:101},(_,i)=>({id:'asset-'+i,name:'资产-'+i,account:'账户-'+i,note:'备注-'+i,type:'cash',currency:'CNY',value:i+1,inPool:true,asOf:'2026-10-23'}));
  state.assets[0]={...state.assets[0],type:'stock',name:'Synthetic GOOG',security:{market:'US',symbol:'GOOG'},quantity:1,currency:'USD',costBasis:{amount:90,quantity:1,currency:'USD',method:'average'}};
  store.save(state,state.revision);
  store.setKV('stock_details:US.GOOG',{key:'US.GOOG',time:'2026-10-23 16:00:00',fetchedAt:new Date().toISOString(),currency:'USD',metrics:{peTTM:18.5,dividendYieldTTM:1.2}});
  store.recordPrice('US.GOOG',{date:'2026-10-23',price:100,currency:'USD',source:'Synthetic'});
  store.setKV('markets_snapshot',{context:{DGS10:{history:[{date:'2026-10-23',value:4.2}]}}});
  store.generateReport(store.state());
  return store;
}

test('完整页面资料覆盖超过100项资产、账户备注、成本、宏观、基础资料、历史和日报，并排除凭据',t=>{
  const store=fixture(t),snapshot=buildAssistantData(store),auto=automaticPageContext(snapshot);
  assert.equal(auto.pages.assets.assets.length,101);assert.equal(auto.pages.assets.assets.at(-1).account,'账户-100');assert.equal(auto.pages.assets.assets.at(-1).note,'备注-100');
  assert.equal(auto.pages.assets.assets[0].investment.cost,90);assert.equal(auto.pages.cashflow.profile.income,12345);
  assert.equal(auto.pages['us-market'].context.find(r=>r.key==='DGS10').value,4.2);
  assert.equal(auto.pages.instruments.items[0].details.metrics.peTTM,18.5);assert.equal(auto.pages.instruments.items[0].priceHistory.count,1);
  assert.equal(auto.pages.reports.reportDays.length,1);assert.equal(snapshot.pages.dashboard.metrics.netWorth,store.state().assets.reduce((sum,a)=>sum+a.value*store.state().preferences.rates[a.currency],0));
  const serialized=JSON.stringify(snapshot);assert.ok(!serialized.includes('PRIVATE_API_KEY'));assert.ok(!serialized.includes('PRIVATE_PASSWORD_HASH'));assert.equal(snapshot.pages.settings.ai.apiKey,undefined);
  const before=JSON.stringify(snapshot);store.setKV('stock_details:US.GOOG',{metrics:{peTTM:99}});assert.equal(JSON.stringify(snapshot),before);
});

test('页面工具分页明确剩余数量，读取历史保留来源，不允许任意配置或KV访问',t=>{
  const store=fixture(t),snapshot=buildAssistantData(store);
  const first=readAssistantPage(snapshot,{page:'assets',section:'assets',limit:100});assert.equal(first.data.length,100);assert.equal(first.lists.assets.nextOffset,100);
  const last=readAssistantPage(snapshot,{page:'assets',section:'assets',offset:100});assert.equal(last.data.length,1);assert.equal(last.data[0].name,'资产-100');assert.equal(last.lists.assets.nextOffset,null);
  const details=readAssistantPage(snapshot,{page:'instruments',section:'items',assetId:'asset-0'});assert.equal(details.data[0].priceHistory[0].source,'Synthetic');
  assert.throws(()=>readAssistantPage(snapshot,{page:'auth'}),/已有页面/);assert.throws(()=>readAssistantPage(snapshot,{page:'settings',section:'apiKey'}),/可读取的栏目/);
  assert.throws(()=>readAssistantPage(snapshot,{page:'assets',limit:101}),/1–100/);
});

test('完整页面授权控制自动上下文和读取工具；真实harness往返及可见事件保存工具参数与结果',async t=>{
  const store=fixture(t),pageData=buildAssistantData(store),state=store.state(),events=[];let authorized=false,calls=0;
  t.mock.method(globalThis,'fetch',async(_url,{body})=>{
    const req=JSON.parse(body),system=req.messages.find(m=>m.role==='system').content;
    if(!authorized){assert.ok(!system.includes('账户-100'));assert.ok(!req.tools.some(t=>t.function.name==='get_page_data'));return Response.json({choices:[{message:{content:'摘要测试完成'}}]});}
    assert.ok(system.includes('账户-100'));assert.ok(!body.includes('PRIVATE_API_KEY'));assert.ok(req.tools.some(t=>t.function.name==='get_page_data'));
    if(++calls===1)return Response.json({choices:[{message:{content:null,reasoning_content:'PRIVATE_REASONING',tool_calls:[{id:'page-read',type:'function',function:{name:'get_page_data',arguments:JSON.stringify({page:'assets',section:'assets',offset:100})}}]}}]});
    const output=JSON.parse(req.messages.at(-1).content);assert.equal(output.data[0].account,'账户-100');
    return Response.json({choices:[{message:{content:'页面工具已读取最后一项资产'}}]});
  });
  const config={...store.config(),includePageData:false};
  await runAssistant(config,state,'未授权测试',{pageData});authorized=true;
  const result=await runAssistant({...config,includePageData:true},state,'读取最后一项资产',{pageData,onEvent:event=>events.push(event)});
  assert.equal(result.toolCalls.length,1);assert.equal(result.toolCalls[0].name,'get_page_data');assert.equal(result.toolCalls[0].args.offset,100);assert.equal(result.toolCalls[0].status,'complete');assert.equal(result.toolCalls[0].output.data[0].name,'资产-100');
  assert.ok(events.some(e=>e.type==='tool'&&e.call.status==='running'));assert.ok(events.some(e=>e.type==='tool'&&e.call.output?.data?.[0]?.account==='账户-100'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REASONING'));assert.ok(!JSON.stringify(events).includes('PRIVATE_REASONING'));
});

test('股票详情工具使用页面相同的资料接口和历史，不会给基金套PE',async t=>{
  const store=fixture(t),without=createAssistantServices(store);assert.equal(without.getInstrumentDetails,undefined);
  const services=createAssistantServices(store,{includePageData:true});
  const result=await services.getInstrumentDetails({assetId:'asset-0'});assert.equal(result.details.metrics.peTTM,18.5);assert.equal(result.priceHistory[0].price,100);
  const state=store.state();state.assets.push({id:'fund-test',name:'Synthetic fund',type:'fund',currency:'CNY',value:100,fund:{code:'000001',autoNav:false}});store.save(state,state.revision);
  const fund=await services.getInstrumentDetails({assetId:'fund-test'});assert.equal(fund.details.status,'not_applicable');assert.equal(fund.details.metrics,undefined);
  await assert.rejects(services.getInstrumentDetails({assetId:'missing'}),/未找到/);
});

test('完整页面授权变更隔离旧对话，省略开关的旧客户端保存不会撤回已有授权',t=>{
  const store=fixture(t),before=store.config();
  store.saveConfig({...before,includePageData:false});assert.notEqual(store.config().scopeId,before.scopeId);
  store.saveConfig({...store.config(),includePageData:true});const {includePageData,...legacy}=store.config();store.saveConfig(legacy);assert.equal(store.config().includePageData,true);
});
