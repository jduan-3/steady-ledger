import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store.mjs';
import { createLedgerService,holdingPrice } from '../src/ledger.mjs';

const now=new Date('2026-10-29T10:00:00Z'),date='2026-10-29';
function setup(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'steady-ledger-')),store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.saveConfig({baseUrl:'https://example.com',model:'synthetic',consent:true,allowLedgerWrites:true});
  const state=store.state();state.assets=[{id:'cash',name:'现金账户',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'star',name:'科创基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',quantity:100,unit:'份',value:200,asOf:date,costBasis:{amount:100,quantity:100,currency:'CNY'}}];store.save(state,0);
  store.setKV('fund_nav:011609',{code:'011609',date,price:2,currency:'CNY',basis:'unit_nav',source:'Synthetic NAV'});
  const service=createLedgerService(store,{clock:()=>now,fundOptions:{fetchImpl:async()=>{throw new Error('offline');}},...options});
  const bind=(question,requestId='request-one',extra={})=>service.bind({question,requestId,scopeId:store.config().scopeId,startedAt:now.getTime(),...extra});
  const holding=(question,args={},requestId)=>bind(question,requestId).recordHoldingChange({query:'科创',side:'buy',amount:1000,evidence:question,...args});
  return {store,service,bind,holding,dir};
}
test('买入未说明现金来源时只追问，不能因只有一个现金账户就自动扣款',async t=>{
  const {store,holding}=setup(t),before=store.state({raw:true});const result=await holding('我今天加了1000元科创');
  assert.equal(result.status,'needs_information');assert.match(result.question,/现有现金.*额外投入/);assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});
test('现有现金买入同时更新持仓与现金、保留成本，重放只入账一次且记录可恢复',async t=>{
  const {store,holding}=setup(t),before=store.state({raw:true});
  const result=await holding('我今天用现有现金加仓1000元科创');assert.equal(result.status,'applied');assert.equal(result.after.quantity,600);assert.equal(result.after.cash,9000);assert.equal(result.after.cost,1100);assert.equal(result.estimated,true);
  const revision=store.state().revision;assert.equal((await holding('我今天用现有现金加仓1000元科创')).replayed,true);assert.equal(store.state().revision,revision);
  store.undo(store.audit()[0].id,revision);assert.equal(store.state({raw:true}).assets[0].value,before.assets[0].value);assert.equal(store.state({raw:true}).assets[1].quantity,100);
});
test('额外投入增加持仓，保留原现金；资金来源的简短后续答复能接续上一轮明确买入指令',async t=>{
  const {store,bind}=setup(t),original='我今天加了1000元科创';
  const result=await bind('额外投入','follow-up',{history:[{role:'user',content:original,created_at:now.toISOString()},{role:'assistant',content:'这笔用现有现金，还是额外投入？'}]}).recordHoldingChange({query:'科创',side:'buy',amount:1000,evidence:original,cashSource:'outside'});
  assert.equal(result.status,'applied');assert.equal(store.state().assets[0].value,10000);assert.equal(store.state().assets[1].quantity,600);
});
test('卖出增加现金并按原平均成本减记剩余持仓，不能超卖',async t=>{
  const {store,holding}=setup(t);
  const result=await holding('我今天卖出科创20份',{side:'sell',amount:undefined,quantity:20});assert.equal(result.after.quantity,80);assert.equal(result.after.cash,10040);assert.equal(result.after.cost,80);
  await assert.rejects(holding('我今天卖出科创200份',{side:'sell',amount:undefined,quantity:200},'oversell'),/超过当前持仓/);assert.equal(store.state().assets[1].quantity,80);
});
test('红包收入支持一万元的中文金额，收支方向不能颠倒，也不重复入账',async t=>{
  const {store,bind}=setup(t),question='我今天收到一万的红包';
  const call=()=>bind(question,'red-envelope').recordCashFlow({evidence:question,side:'income',amount:10000,description:'红包收入'});
  assert.equal((await call()).status,'applied');assert.equal(store.state().assets[0].value,20000);assert.equal((await call()).replayed,true);assert.equal(store.state().assets[0].value,20000);
  await assert.rejects(bind(question,'bad-side').recordCashFlow({evidence:question,side:'expense',amount:10000,description:'红包'}),/明确说明/);
});
test('没有当日净值就保存待入账，不能挪用昨日净值；净值披露后自动入账且重启不重复',async t=>{
  const {store,holding,service,dir}=setup(t);store.setKV('fund_nav:011609',{date:'2026-10-28',price:1,currency:'CNY',basis:'unit_nav'});
  const result=await holding('我今天用现有现金加仓1000元科创');assert.equal(result.status,'pending');assert.equal(store.state().assets[1].quantity,100);assert.equal(store.state().assets[0].value,10000);
  store.setKV('fund_nav:011609',{date,price:2,currency:'CNY',basis:'unit_nav'});await service.processPending();assert.equal(store.state().assets[1].quantity,600);assert.equal(store.state().assets[0].value,9000);
  const reopened=openStore(dir);try{await createLedgerService(reopened,{clock:()=>now}).processPending();assert.equal(reopened.state().assets[1].quantity,600);assert.equal(reopened.ledgerEntries()[0].status,'applied');}finally{reopened.close();}
});
test('收盘前不采纳盘中价格或尚未完成的日K，收盘后使用明确的收盘记录',async t=>{
  let clock=new Date('2026-10-29T06:00:00Z'),providerCalls=0;
  const {store,holding,service}=setup(t,{clock:()=>clock,stockProvider:async()=>{providerCalls++;return {history:[{key:'SH.588000',date,price:3}]};}});
  const state=store.state();state.assets[1]={id:'star',name:'科创ETF',type:'stock',currency:'CNY',quantity:100,unit:'股',value:200,security:{market:'SH',symbol:'588000'},autoPrice:true,costBasis:{amount:100,quantity:100,currency:'CNY'}};store.save(state,state.revision);
  store.recordPrice('SH.588000',{date,price:2,basis:'quote',time:date+' 14:00:00',currency:'CNY'});
  assert.equal(holdingPrice(store,store.state().assets[1],date,clock),null);assert.equal((await holding('我今天用额外投入加仓1000元科创')).status,'pending');assert.equal(providerCalls,0);
  clock=new Date('2026-10-29T07:16:00Z');await service.processPending();assert.equal(providerCalls,1);assert.equal(store.ledgerEntries()[0].price.price,3);assert.ok(Math.abs(store.state().assets[1].quantity-(100+1000/3))<1e-7);
});
test('待入账期间人工改了份额会暂停核对，取消的记录不会在价格披露后复活',async t=>{
  const {store,holding,service}=setup(t);store.setKV('fund_nav:011609',null);
  const first=await holding('我今天用额外投入加仓1000元科创');store.cancelLedgerEntry(first.id);store.setKV('fund_nav:011609',{date,price:2,basis:'unit_nav'});await service.processPending();assert.equal(store.state().assets[1].quantity,100);
  store.setKV('fund_nav:011609',null);await holding('我今天用额外投入加仓1000元科创',{},'next');const state=store.state();state.assets[1].quantity=150;store.save(state,state.revision);store.setKV('fund_nav:011609',{date,price:2,basis:'unit_nav'});await service.processPending();assert.equal(store.ledgerEntries().find(e=>e.requestId==='next').status,'blocked');assert.equal(store.state().assets[1].quantity,150);
});
test('持仓、现金、版本、审计与入账凭据在同一事务，凭据失败全部回滚',async t=>{
  const {store,holding}=setup(t),before=store.state({raw:true}),audit=store.audit();
  store.db.exec("CREATE TRIGGER reject_ledger BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
  await assert.rejects(holding('我今天用现有现金加仓1000元科创'),/receipt failure/);assert.deepEqual(store.state({raw:true}),before);assert.deepEqual(store.audit(),audit);assert.equal(store.ledgerEntries().length,0);
  store.db.exec('DROP TRIGGER reject_ledger');assert.equal((await holding('我今天用现有现金加仓1000元科创')).status,'applied');
});
test('讨论假设、幻觉金额、未经确认的资金来源、跨币种金额均不允许入账',async t=>{
  const {store,holding}=setup(t),before=store.state({raw:true});
  await assert.rejects(holding('比如我今天用现有现金加仓1000元科创'),/讨论或计划/);
  await assert.rejects(holding('我今天用现有现金加仓1000元科创',{amount:2000}),/来自用户原话/);
  assert.equal((await holding('我今天用现有现金加仓1000元科创',{cashSource:'outside'})).status,'needs_information');
  assert.deepEqual(store.state({raw:true}),before);
});
test('等待价格时停止回答或撤回授权，不会在异步价格到达后偷偷写账',async t=>{
  let finish,active=true;const {store,service}=setup(t,{fundOptions:{fetchImpl:()=>new Promise(resolve=>{finish=resolve;})}});store.setKV('fund_nav:011609',null);
  const question='我今天用现有现金加仓1000元科创',meta={question,requestId:'stop-read',scopeId:store.config().scopeId,startedAt:now.getTime()};
  const pending=service.bind(meta,{isActive:()=>active}).recordHoldingChange({query:'科创',side:'buy',amount:1000,evidence:question});
  active=false;finish(Response.json({ErrCode:0,Data:{LSJZList:[{FSRQ:date,DWJZ:'2'}]}}));await assert.rejects(pending,/已停止/);assert.equal(store.state().assets[1].quantity,100);assert.equal(store.ledgerEntries().length,0);
});
test('已知申购费用从总付款中扣出份额成本，缺失原成本不能凭空补零',async t=>{
  const {store,holding}=setup(t);const state=store.state();state.assets[1].costBasis=null;store.save(state,state.revision);
  const r=await holding('我今天用现有现金买入1000元科创，手续费10元',{fee:10});assert.equal(r.after.quantity,595);assert.equal(r.after.cash,9000);assert.equal(r.after.cost,null);assert.equal(store.state().assets[1].costBasis,null);
});

test('清仓可使用已登记的完整份额，多现金账户不能由模型私自挑选',async t=>{
  const {store,holding}=setup(t);const first=await holding('我今天清仓科创',{side:'sell',amount:undefined});assert.equal(first.after.quantity,0);assert.equal(first.after.cash,10200);
  const state=store.state();state.assets.push({id:'cash-two',name:'第二现金',type:'cash',currency:'CNY',value:5000,account:'银行',asOf:date});store.save(state,state.revision);
  const result=await holding('我今天用现有现金买入1000元科创',{cashAssetId:'cash-two'},'multi-cash');assert.equal(result.status,'needs_information');assert.equal(store.state().assets.find(a=>a.id==='cash-two').value,5000);
});

test('资金来源追问由服务端承接可信上一轮，即使模型拼接证据或把query写成整句也无需用户重说',async t=>{
  const {store,bind}=setup(t),original='我今天加了1000元科创，请帮我记账。',answer='这是额外投入，请按已保存的今日净值记账。';
  const result=await bind(answer,'joined-evidence',{history:[{role:'user',content:original,created_at:now.toISOString()},{role:'assistant',content:'用现有现金还是额外投入？'}]}).recordHoldingChange({query:'今天额外投入1000元买入科创基金，按今日净值记账',evidence:original+answer,side:'buy',assetId:'star',amount:1000,cashSource:'outside'});
  assert.equal(result.status,'applied');assert.equal(store.state().assets[1].quantity,600);assert.equal(store.state().assets[0].value,10000);
});
