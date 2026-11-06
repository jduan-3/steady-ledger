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
test('买入金额缺失时只追问该字段，用户补答金额后承接原标的和资金来源',async t=>{
  const {bind,holding}=setup(t),original='今天用现有现金买入科创';
  const first=await holding(original,{amount:undefined});assert.equal(first.status,'needs_information');
  const result=await bind('1000元','value-follow-up',{history:[{role:'user',content:original},{role:'assistant',content:first.question}]}).recordHoldingChange({query:'科创',side:'buy',amount:1000,evidence:'1000元'});
  assert.equal(result.status,'applied');assert.equal(result.after.cash,9000);
});
test('真实买入附带更新持仓请求时仍走买入，不能错误转成总持仓校准',async t=>{
  const {holding}=setup(t);
  assert.equal((await holding('今天用现有现金买入1000元科创，请更新持仓')).status,'applied');
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
test('口语买入金额与从现金支付可识别，含糊日期先追问而不默认今天',async t=>{
  const {store,holding}=setup(t),before=store.state({raw:true});
  const ambiguous=await holding('我买了 1000 的科创50 几天 我自己有的那个 基金 从现金里加入的');
  assert.equal(ambiguous.status,'needs_information');assert.match(ambiguous.missing.join(''),/日期/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
  const confirmed=await holding('今天买了1000的科创基金，从现金里加入的');
  assert.equal(confirmed.status,'applied');assert.equal(confirmed.after.cash,9000);assert.equal(confirmed.after.quantity,600);
});
test('实际失败原话补答今天买的后保存指定日期待入账，净值披露后才联动现金且不重复',async t=>{
  const current=new Date('2026-10-30T06:47:38Z'),{store,bind,service}=setup(t,{clock:()=>current});
  const original='我买了 1000 的科创50 几天 我自己有的那个 基金 从现金里加入的',reply='今天买的';
  const history=[{role:'user',content:original,created_at:'2026-10-30T06:41:03Z'},{role:'assistant',content:'你记得是哪天下单的吗？告诉我日期。'}];
  const before=store.state({raw:true});
  for(const evidence of [original+'。'+reply,reply]){
    const result=await bind(reply,'date-follow-up',{history,startedAt:current.getTime()}).recordHoldingChange({query:'今天买了1000元科创50基金，从现金里支付',assetId:'star',side:'buy',amount:1000,evidence,date:'2026-10-30',cashSource:'registered'});
    assert.equal(result.status,'pending');assert.equal(result.date,'2026-10-30');assert.equal(result.amount,1000);assert.equal(result.cashAssetId,'cash');
  }
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,1);
  store.setKV('fund_nav:011609',{date:'2026-10-30',price:2,currency:'CNY',basis:'unit_nav'});
  await service.processPending();await service.processPending();
  assert.equal(store.state().assets[0].value,9000);assert.equal(store.state().assets[1].quantity,600);
});
test('连续补答日期和资金来源能承接同一笔，跨午夜不把原来的今天移到下一天',async t=>{
  const current=new Date('2026-10-29T16:01:00Z'),{bind}=setup(t,{clock:()=>current});
  const history=[
    {role:'user',content:'我买了1000元科创，几天前的',created_at:'2026-10-29T15:50:00Z'},
    {role:'assistant',content:'是哪天买的？'},
    {role:'user',content:'今天买的',created_at:'2026-10-29T15:55:00Z'},
    {role:'assistant',content:'用现有现金还是额外投入？'}
  ];
  const result=await bind('现有现金','multiple-follow-ups',{history,startedAt:current.getTime()}).recordHoldingChange({query:'科创',side:'buy',amount:1000,evidence:'今天买的',cashSource:'registered'});
  assert.equal(result.status,'applied');assert.equal(result.date,'2026-10-29');assert.equal(result.after.cash,9000);
});
test('包含买入或卖出字样的简短日期补答仍承接原指令的标的与金额',async t=>{
  const {bind}=setup(t),original='用现有现金买入1000元科创，前几天买的';
  const buy=await bind('今天买入的','buy-date',{history:[{role:'user',content:original},{role:'assistant',content:'具体是哪天买入的？'}]}).recordHoldingChange({query:'科创',side:'buy',amount:1000,evidence:original});
  assert.equal(buy.status,'applied');assert.equal(buy.date,date);assert.equal(buy.after.cash,9000);
  const current=new Date('2026-10-30T02:00:00Z'),question='昨天卖出的',saleOriginal='科创全部卖了，前几天的';
  const sale=await bind(question,'sell-date',{startedAt:current.getTime(),history:[{role:'user',content:saleOriginal},{role:'assistant',content:'具体是哪天卖出的？'}]}).recordHoldingChange({query:'科创',side:'sell',evidence:saleOriginal});
  assert.equal(sale.status,'applied');assert.equal(sale.date,date);assert.equal(sale.after.quantity,0);
});
test('日期补答只承接相邻的未完成买卖，不能借旧记录、建议或否定指令入账',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true}),original='我今天用现有现金买入1000元科创';
  const args={query:'科创',side:'buy',amount:1000,evidence:original+'。今天买的'};
  for(const history of [[],[{role:'user',content:original},{role:'assistant',content:'今天市场怎么样？'}],
    [{role:'user',content:original},{role:'assistant',content:'已保存待入账，日期是哪天？',metadata:{toolCalls:[{name:'record_holding_change',status:'complete',output:{status:'pending'}}]}}],
    [{role:'user',content:original},{role:'assistant',content:'已完成入账，是哪天买的？',metadata:{toolCalls:[{name:'record_holding_change',status:'complete',output:{status:'applied'}}]}}]
  ])await assert.rejects(bind('今天买的','unrelated',{history}).recordHoldingChange(args),/当前明确|明确说明/);
  for(const content of ['如果我用现有现金买入1000元科创','我没有用现有现金买入1000元科创']){
    const history=[{role:'user',content},{role:'assistant',content:'是哪天买的？'}];
    await assert.rejects(bind('今天买的','denied',{history}).recordHoldingChange({...args,evidence:content}),/讨论或计划|被否定/);
  }
  const history=[{role:'user',content:'我用现有现金买入100份科创，成交价2元'},{role:'assistant',content:'是哪天买的？'}];
  await assert.rejects(bind('今天买的','wrong-unit',{history}).recordHoldingChange({...args,amount:100}),/对应单位和用途/);
  await assert.rejects(bind('今天卖的','conflicting-side',{history:[{role:'user',content:original},{role:'assistant',content:'是哪天买的？'}]}).recordHoldingChange(args),/买卖方向/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
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

test('全部卖了等口语清仓使用已登记份额，忽略模型从页面带入的金额或份额',async t=>{
  for(const [i,question] of ['然后我把南方全部卖了','我把南方都卖了','南方全卖了','南方卖光了','南方卖完了','卖出全部南方'].entries()){
    const {store,bind}=setup(t),state=store.state();state.assets[1].name='南方基金';store.save(state,state.revision);
    const args={query:'南方',side:'sell',evidence:question,...(i%2?{amount:999}:{quantity:999})};
    const result=await bind(question,'sell-all-'+i).recordHoldingChange(args);
    assert.equal(result.status,'applied',question);assert.equal(result.quantity,100);assert.equal(result.after.quantity,0);assert.equal(result.after.cash,10200);assert.equal(result.after.cost,0);
    const revision=store.state().revision;
    assert.equal((await bind(question,'sell-all-'+i).recordHoldingChange(args)).replayed,true);assert.equal(store.state().revision,revision);assert.equal(store.ledgerEntries().length,1);
  }
});

test('全部变成 cash 与南方啊能连续承接未完成卖出，保留原日期和标的',async t=>{
  const {store,bind}=setup(t),state=store.state();state.assets[1].name='南方基金';store.save(state,state.revision);
  const original='然后我把南方全部卖了',reply='全部 然后变成 cash',history=[
    {role:'user',content:original,created_at:now.toISOString()},
    {role:'assistant',content:'这笔的金额或股数／份额是多少？请核对数字的用途和单位。'},
    {role:'user',content:reply,created_at:now.toISOString()},
    {role:'assistant',content:'这笔要更新哪项记录、具体缺少的内容是什么？请结合本次对话已确认的信息核对。'}
  ];
  const result=await bind('南方啊','recover-full-sale',{history,startedAt:now.getTime()+86400000}).recordHoldingChange({query:'南方',side:'sell',evidence:original,quantity:100});
  assert.equal(result.status,'applied');assert.equal(result.date,date);assert.equal(result.after.quantity,0);assert.equal(result.after.cash,10200);
});

test('完整卖出原话优先于模型拼接的旧证据，按昨日净值清仓并转入现金',async t=>{
  const current=new Date('2026-10-30T02:11:37Z'),{store,bind}=setup(t,{clock:()=>current}),state=store.state();
  state.assets[1].name='南方基金';store.save(state,state.revision);
  const question='南方基金按照昨天的价格全部卖掉了';
  const result=await bind(question,'fresh-sale',{startedAt:current.getTime(),history:[{role:'user',content:'我今天用现有现金买入1000元科创'},{role:'assistant',content:'这笔要更新哪项记录、具体缺少的内容是什么？'}]}).recordHoldingChange({query:'南方',side:'sell',quantity:999,price:999,evidence:'之前买入科创；然后我把南方全部卖了'});
  assert.equal(result.status,'applied');assert.equal(result.date,date);assert.equal(result.price.basis,'unit_nav');assert.equal(result.price.price,2);assert.equal(result.quantity,100);assert.equal(result.after.quantity,0);assert.equal(result.after.cash,10200);
});

test('已经发生了按照昨天收盘价承接紧邻失败卖出，不再追问标的且重放不重复入账',async t=>{
  const current=new Date('2026-10-30T02:12:00Z'),{store,bind}=setup(t,{clock:()=>current}),state=store.state();
  state.assets[1].name='南方基金';store.save(state,state.revision);
  const original='南方基金 按照昨天的价格 全部卖掉了',question='已经发生了 按照 昨天的收盘价';
  const history=[{role:'user',content:original,created_at:'2026-10-30T02:11:37Z'},{role:'assistant',content:'你要记录已经发生的买卖，还是按最新总份额校准持仓？',metadata:{toolCalls:[{name:'record_holding_change',output:{status:'needs_information'}}]}}];
  const call=()=>bind(question,'confirmed-sale',{history,startedAt:current.getTime()}).recordHoldingChange({query:'南方',side:'sell',assetId:'star',quantity:100,price:999,date,evidence:original});
  const result=await call();assert.equal(result.status,'applied');assert.equal(result.date,date);assert.equal(result.price.price,2);assert.equal(result.price.basis,'unit_nav');assert.equal(result.after.quantity,0);assert.equal(result.after.cash,10200);
  const revision=store.state().revision;assert.equal((await call()).replayed,true);assert.equal(store.state().revision,revision);assert.equal(store.ledgerEntries().length,1);
});

test('已发生补答不能重开已完成或待入账记录，也不能把假设与否定变成买卖',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true}),question='已经发生了 按照昨天的收盘价',original='今天科创全部卖了';
  for(const status of ['applied','pending']){
    const history=[{role:'user',content:original},{role:'assistant',content:'你要记录已经发生的买卖，还是按最新总份额校准持仓？',metadata:{toolCalls:[{name:'record_holding_change',output:{status}}]}}];
    await assert.rejects(bind(question,'saved-confirmation-'+status,{history}).recordHoldingChange({query:'科创',side:'sell',evidence:original}),/当前明确/);
  }
  for(const content of ['如果今天科创全部卖了','今天科创没有全部卖掉']){
    const history=[{role:'user',content},{role:'assistant',content:'你要记录已经发生的买卖，还是按最新总份额校准持仓？'}];
    await assert.rejects(bind(question,'unsafe-confirmation',{history}).recordHoldingChange({query:'科创',side:'sell',evidence:content}),/讨论或计划|被否定/);
  }
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});

test('卖出缺数量时补答全部即可入账，不能重复追问具体份额',async t=>{
  const {bind}=setup(t),original='今天卖了科创';
  const first=await bind(original).recordHoldingChange({query:'科创',side:'sell',evidence:original});
  assert.equal(first.status,'needs_information');
  const result=await bind('全部 然后变成 cash','sell-all-answer',{history:[{role:'user',content:original},{role:'assistant',content:first.question}]}).recordHoldingChange({query:'科创',side:'sell',evidence:original});
  assert.equal(result.status,'applied');assert.equal(result.after.quantity,0);assert.equal(result.after.cash,10200);
});

test('清仓补答不承接已入账、待入账或无关对话，也不能绕过否定与假设',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true}),original='今天卖了科创';
  for(const status of ['applied','pending']){
    const history=[{role:'user',content:original},{role:'assistant',content:'这笔金额或份额是多少？',metadata:{toolCalls:[{name:'record_holding_change',output:{status}}]}}];
    await assert.rejects(bind('全部','saved-'+status,{history}).recordHoldingChange({query:'科创',side:'sell',evidence:original}),/当前明确/);
  }
  for(const content of ['如果我把科创全部卖了','我没有把科创全部卖了','不要记录科创全部卖了','我不想把科创全部卖了']){
    const history=[{role:'user',content},{role:'assistant',content:'这笔金额或份额是多少？'}];
    await assert.rejects(bind('全部','denied-sale',{history}).recordHoldingChange({query:'科创',side:'sell',evidence:content}),/讨论或计划|被否定/);
  }
  await assert.rejects(bind('科创啊','unrelated-sale',{history:[{role:'user',content:original},{role:'assistant',content:'今天市场怎么样？'}]}).recordHoldingChange({query:'科创',side:'sell',evidence:original}),/当前明确/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});

test('清仓只能从已登记份额取数量，成交价与费用仍需用户提供；名称中的全字不代表清仓',async t=>{
  const {store,bind}=setup(t),original='今天科创全部卖了',before=store.state({raw:true});
  for(const extra of [{price:2},{fee:1}])await assert.rejects(bind(original).recordHoldingChange({query:'科创',side:'sell',evidence:original,...extra}),/对应单位和用途/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
  const state=store.state();state.assets[1].name='全国基金';store.save(state,state.revision);
  const question='我把全国基金卖了';assert.equal((await bind(question).recordHoldingChange({query:'全国基金',side:'sell',evidence:question})).status,'needs_information');assert.equal(store.ledgerEntries().length,0);
});

test('全部卖出仍检查唯一标的与已知份额，未披露净值时只待入账且结算一次',async t=>{
  const {store,bind,service}=setup(t),state=store.state();state.assets[1].name='南方一号基金';
  state.assets.push({...state.assets[1],id:'second',name:'南方二号基金'});store.save(state,state.revision);
  const question='我把南方全部卖了',args={query:'南方',side:'sell',evidence:question,assetId:'star'};
  assert.equal((await bind(question).recordHoldingChange(args)).status,'needs_information');assert.equal(store.ledgerEntries().length,0);
  const unknown=store.state();unknown.assets.pop();unknown.assets[1].quantity=null;unknown.assets[1].fund.autoNav=false;store.save(unknown,unknown.revision);
  assert.equal((await bind(question).recordHoldingChange(args)).status,'needs_information');assert.equal(store.ledgerEntries().length,0);
  const known=store.state();known.assets[1].quantity=100;known.assets[1].fund.autoNav=true;store.save(known,known.revision);store.setKV('fund_nav:011609',null);
  const pending=await bind(question).recordHoldingChange(args);assert.equal(pending.status,'pending');assert.equal(store.state().assets[1].quantity,100);assert.equal(store.state().assets[0].value,10000);
  store.setKV('fund_nav:011609',{date,price:2,basis:'unit_nav',currency:'CNY'});await service.processPending();await service.processPending();
  assert.equal(store.state().assets[1].quantity,0);assert.equal(store.state().assets[0].value,10200);assert.equal(store.ledgerEntries().length,1);
});

test('资金来源追问由服务端承接可信上一轮，即使模型拼接证据或把query写成整句也无需用户重说',async t=>{
  const {store,bind}=setup(t),original='我今天加了1000元科创，请帮我记账。',answer='这是额外投入，请按已保存的今日净值记账。';
  const result=await bind(answer,'joined-evidence',{history:[{role:'user',content:original,created_at:now.toISOString()},{role:'assistant',content:'用现有现金还是额外投入？'}]}).recordHoldingChange({query:'今天额外投入1000元买入科创基金，按今日净值记账',evidence:original+answer,side:'buy',assetId:'star',amount:1000,cashSource:'outside'});
  assert.equal(result.status,'applied');assert.equal(store.state().assets[1].quantity,600);assert.equal(store.state().assets[0].value,10000);
});

test('否定的买卖和收支不能入账，截取证据或补答资金来源也不能绕过',async t=>{
  const {store,holding,bind}=setup(t),before=store.state({raw:true});
  for(const question of ['我今天没有用现有现金买入1000元科创','我今天并未用现有现金买入1000元科创','不要记录我今天用现有现金买入1000元科创','我今天用现有现金买入1000元科创，但不要记账']){
    await assert.rejects(holding(question),/被否定/);
  }
  const original='我今天没有用现有现金买入1000元科创';
  await assert.rejects(holding(original,{evidence:'买入1000元科创'}),/被否定/);
  await assert.rejects(bind('额外投入','negative-follow-up',{history:[{role:'user',content:original,created_at:now.toISOString()},{role:'assistant',content:'这笔用现有现金，还是额外投入？'}]}).recordHoldingChange({query:'科创',side:'buy',amount:1000,evidence:original}),/被否定/);
  await assert.rejects(holding('我今天没有卖出科创20份',{side:'sell',amount:undefined,quantity:20}),/被否定/);
  for(const [question,side] of [['我今天没收到100元红包','income'],['我今天没有花了100元','expense']]){
    await assert.rejects(bind(question).recordCashFlow({evidence:question,side,amount:100,description:'虚构收支'}),/被否定/);
  }
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});

test('否定其他动作或资金来源不阻止明确已发生的买入',async t=>{
  const {store,holding}=setup(t);
  assert.equal((await holding('我今天用额外投入买入1000元科创，不用现有现金')).status,'applied');
  assert.equal(store.state().assets[0].value,10000);
  assert.equal((await holding('我今天用现有现金买入1000元科创，没有卖出',{},'positive-buy')).status,'applied');
  assert.equal(store.state().assets[0].value,9000);assert.equal(store.state().assets[1].quantity,1100);
});

test('数字必须匹配金额、份额、单价或费用；相同数字出现在其他用途不能作为证据',async t=>{
  const {store,holding}=setup(t),before=store.state({raw:true}),question='我今天用现有现金买入100份科创，成交价2元';
  for(const args of [{amount:100,price:2},{amount:2,price:2},{amount:undefined,quantity:2,price:2},{amount:undefined,quantity:100,price:100},{amount:undefined,quantity:100,price:2,fee:2}]){
    await assert.rejects(holding(question,args),/对应单位和用途/);
  }
  await assert.rejects(holding('我今天用现有现金买入100手科创',{amount:undefined,quantity:100}),/对应单位和用途/);
  await assert.rejects(holding('我今天用现有现金买入100份科创，成交价2份',{amount:undefined,quantity:100,price:2}),/对应单位和用途/);
  await assert.rejects(holding('我今天用现有现金买入100份科创，成交价2元，手续费1%',{amount:undefined,quantity:100,price:2,fee:1}),/对应单位和用途/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
  const result=await holding(question,{amount:undefined,quantity:100,price:2});
  assert.equal(result.quantity,100);assert.equal(result.amount,200);assert.equal(result.after.quantity,200);assert.equal(result.after.cash,9800);
});

test('中文数量、成交价和带千分位的金额仍按对应单位正确记账',async t=>{
  const {holding}=setup(t);
  const first=await holding('我今天用现有现金买入科创一百份，成交价二元',{amount:undefined,quantity:100,price:2});
  assert.equal(first.quantity,100);assert.equal(first.after.cash,9800);
  const second=await holding('我今天用现有现金买入1,000元科创',{},'thousand-separated');
  assert.equal(second.after.cash,8800);assert.equal(second.quantity,500);
});

test('现金原话币种与工具参数不一致时拒绝，证据片段不能隐藏币种',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true});
  for(const question of ['我今天收到100美元红包','我今天收到100美金红包','我今天收到USD 100红包','我今天收到100港币红包','我今天收到HKD 100红包','我今天收到美元红包100','我今天收到USD红包100']){
    await assert.rejects(bind(question).recordCashFlow({evidence:question,side:'income',amount:100,currency:'CNY',description:'红包收入'}),/币种不一致/);
  }
  const question='我今天收到100美元红包';
  await assert.rejects(bind(question).recordCashFlow({evidence:'收到100',side:'income',amount:100,currency:'CNY',description:'红包收入'}),/币种不一致/);
  await assert.rejects(bind(question).recordCashFlow({evidence:question,side:'income',amount:100,description:'红包收入'}),/币种不一致/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});

test('明确美元收入仅进入美元账户，不能从日期数字或数量推断收入',async t=>{
  const {store,bind}=setup(t),state=store.state();
  state.assets.push({id:'usd-cash',name:'美元现金',type:'cash',currency:'USD',value:50,asOf:date});store.save(state,state.revision);
  const question='我今天收到100美元红包';
  assert.equal((await bind(question).recordCashFlow({evidence:question,side:'income',amount:100,currency:'USD',cashAssetId:'usd-cash',description:'红包收入'})).status,'applied');
  assert.equal(store.state().assets.find(a=>a.id==='usd-cash').value,150);assert.equal(store.state().assets.find(a=>a.id==='cash').value,10000);
  const currencyFirst='我今天收到美元红包100';
  assert.equal((await bind(currencyFirst,'currency-before-description').recordCashFlow({evidence:currencyFirst,side:'income',amount:100,currency:'USD',cashAssetId:'usd-cash',description:'红包收入'})).status,'applied');
  assert.equal(store.state().assets.find(a=>a.id==='usd-cash').value,250);assert.equal(store.state().assets.find(a=>a.id==='cash').value,10000);
  const bad='我10月29日收到红包，金额还没确认';
  await assert.rejects(bind(bad,'date-is-not-money').recordCashFlow({evidence:bad,side:'income',amount:29,currency:'CNY',description:'红包收入'}),/对应单位和用途/);
});

test('持仓买入金额、成交价和费用也核对原话币种',async t=>{
  const {store,holding}=setup(t),before=store.state({raw:true});
  await assert.rejects(holding('我今天用现有现金买入100美元科创',{amount:100,currency:'CNY'}),/币种不一致/);
  await assert.rejects(holding('我今天用现有现金买入科创100份，成交价2美元',{amount:undefined,quantity:100,price:2,currency:'CNY'}),/币种不一致/);
  await assert.rejects(holding('我今天用现有现金买入1000元科创，手续费10美元',{fee:10,currency:'CNY'}),/币种不一致/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});

test('清空档案会取消新基金待入账，净值补齐、重启或恢复旧快照均不能使它复活',async t=>{
  const {store,service,bind,dir}=setup(t),question='我今天用额外投入买入1000元基金006789';
  const pending=await bind(question).recordHoldingChange({query:'006789',fundCode:'006789',side:'buy',amount:1000,evidence:question});
  assert.equal(pending.status,'pending');
  const prior=store.ledgerEntry(pending.id),generation=store.ledgerGeneration();
  store.reset(store.state().revision);
  assert.equal(store.state().assets.length,0);assert.equal(store.ledgerGeneration(),generation+1);
  assert.equal(store.ledgerEntry(pending.id).status,'cancelled');assert.equal(store.ledgerEntries({pending:true}).length,0);
  store.setKV('fund_nav:006789',{date,price:2,currency:'CNY',basis:'unit_nav'});
  await service.processPending();assert.equal(store.postLedgerEntry(prior).status,'cancelled');assert.equal(store.state().assets.length,0);
  const reopened=openStore(dir);
  try{assert.equal(reopened.ledgerGeneration(),generation+1);await createLedgerService(reopened,{clock:()=>now}).processPending();assert.equal(reopened.state().assets.length,0);}finally{reopened.close();}
  store.undo(store.audit()[0].id,store.state().revision);await service.processPending();
  assert.equal(store.state().assets.length,2);assert.ok(!store.state().assets.some(a=>a.fund?.code==='006789'));
});

test('清空时仍在查净值、尚未保存的请求不能写回，清空前绑定的现金工具也失效',async t=>{
  let finish;const {store,service,bind}=setup(t,{fundOptions:{fetchImpl:()=>new Promise(resolve=>{finish=resolve;})}});
  const question='我今天用额外投入买入1000元基金006789',oldCash=bind('我今天收到100元红包','stale-cash');
  const inFlight=bind(question).recordHoldingChange({query:'006789',fundCode:'006789',side:'buy',amount:1000,evidence:question});
  assert.equal(typeof finish,'function');assert.equal(store.ledgerEntries().length,0);
  store.reset(store.state().revision);
  finish(Response.json({ErrCode:0,Data:{LSJZList:[{FSRQ:date,DWJZ:'2'}]}}));
  await assert.rejects(inFlight,/已清空/);
  await assert.rejects(oldCash.recordCashFlow({evidence:'我今天收到100元红包',side:'income',amount:100,description:'红包'}),/已清空/);
  await service.processPending();assert.equal(store.state().assets.length,0);assert.equal(store.ledgerEntries().length,0);
});

test('已开始处理的待入账在清空后保持取消；旧代号不能在底层事务重新提交',async t=>{
  const {store,holding}=setup(t);store.setKV('fund_nav:011609',null);
  const pending=await holding('我今天用额外投入买入1000元科创');let finish;
  const service=createLedgerService(store,{clock:()=>now,fundOptions:{force:true,fetchImpl:()=>new Promise(resolve=>{finish=resolve;})}});
  const running=service.processPending();assert.equal(typeof finish,'function');store.reset(store.state().revision);
  finish(Response.json({ErrCode:0,Data:{LSJZList:[{FSRQ:date,DWJZ:'2'}]}}));await running;
  assert.equal(store.ledgerEntry(pending.id).status,'cancelled');assert.equal(store.state().assets.length,0);
  assert.throws(()=>store.postLedgerEntry({...pending,id:'stale-unpersisted-entry'},state=>({state})),/已清空/);
});

test('清空失败时档案、待办和代号全部回滚；新代号上的正常记账继续可用',async t=>{
  const {store,holding,bind}=setup(t);store.setKV('fund_nav:011609',null);
  const pending=await holding('我今天用额外投入买入1000元科创'),before=store.state({raw:true});
  assert.throws(()=>store.reset(before.revision-1),e=>e.status===409);
  store.db.exec("CREATE TRIGGER reject_reset BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT,'reset failure'); END");
  assert.throws(()=>store.reset(before.revision),/reset failure/);
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerGeneration(),0);assert.equal(store.ledgerEntry(pending.id).status,'pending');
  store.db.exec('DROP TRIGGER reject_reset');store.reset(before.revision);
  const state=store.state();state.assets=[{id:'new-cash',name:'新现金',type:'cash',currency:'CNY',value:10,asOf:date}];store.save(state,state.revision);
  const question='我今天收到100元红包';const result=await bind(question,'new-generation').recordCashFlow({evidence:question,side:'income',amount:100,description:'红包收入'});
  assert.equal(result.status,'applied');assert.equal(result.generation,1);assert.equal(store.state().assets[0].value,110);
});

const balanceHistory=()=>[
  {role:'user',content:'我更新一下我的科创的持仓'},
  {role:'assistant',content:'把现在的份额或金额告诉我。'},
  {role:'user',content:'科创50目前持有23671.48份，持仓收益率还是-18.03%，单位成本是1.1141'},
  {role:'assistant',content:'和旧持仓有差异，要按 App 数字更新吗？'},
  {role:'user',content:'嗯嗯直接更新，不用管1000元了'},
  {role:'assistant',content:'现金保持不变，还是另有明确的现金调整？'}
];
test('持仓校准承接连续补答，绝对份额、单位成本和现金调整分别核对，不能当成买入差额',async t=>{
  const {store,bind}=setup(t);store.setKV('fund_nav:011609',{date,price:0.9132,currency:'CNY',basis:'unit_nav'});
  const question='现金 -1000 其他的不管',history=balanceHistory(),bound=bind(question,'balance-follow-up',{history});
  const redirected=await bound.recordHoldingChange({query:'科创',side:'buy',quantity:3218.48,evidence:'模型拼接的旧买入记录'});
  assert.equal(redirected.status,'use_other_tool');assert.equal(redirected.tool,'set_holding_balance');assert.equal(store.ledgerEntries().length,0);
  const args={query:'科创',assetId:'star',quantity:23671.48,averageCost:1.1141,cashDelta:-1000,cashAssetId:'cash',evidence:question};
  const result=await bound.setHoldingBalance(args);
  assert.equal(result.status,'applied');assert.equal(result.after.quantity,23671.48);assert.equal(result.after.cost,26372.4);assert.equal(result.after.cash,9000);
  assert.equal(store.state().assets[1].investment.returnPercent.toFixed(2),'-18.03');
  const revision=store.state().revision;assert.equal((await bound.setHoldingBalance(args)).replayed,true);assert.equal(store.state().revision,revision);assert.equal(store.state().assets[0].value,9000);
});
test('校准缺信息时逐项追问，补答总份额和现金不动后直接完成同一笔',async t=>{
  const {store,bind}=setup(t),original='请更新科创持仓',args={query:'科创',evidence:original};
  const first=await bind(original,'balance-missing').setHoldingBalance(args);
  assert.equal(first.status,'needs_information');assert.match(first.question,/份额|股数|数量/);assert.equal(store.ledgerEntries().length,0);
  const history=[{role:'user',content:original},{role:'assistant',content:first.question}];
  const second=await bind('目前持有200份','balance-quantity',{history}).setHoldingBalance({...args,quantity:200,evidence:'目前持有200份'});
  assert.equal(second.status,'needs_information');assert.match(second.question,/现金/);assert.equal(store.ledgerEntries().length,0);
  history.push({role:'user',content:'目前持有200份'},{role:'assistant',content:second.question});
  const result=await bind('现金不动','balance-cash',{history}).setHoldingBalance({...args,quantity:200,cashDelta:0,evidence:'现金不动'});
  assert.equal(result.status,'applied');assert.equal(store.state().assets[1].quantity,200);assert.equal(store.state().assets[1].costBasis,null);assert.equal(store.state().assets[0].value,10000);
});
test('科创50校准承接原样补答“不变”，也能从旧版重复询问标的中恢复',async t=>{
  for(const legacy of [false,true]){
    const {store,bind}=setup(t),original='科创50 的数据更新一下， 持仓收益率是 -百分之16.03 亏损时 4283.93';
    const history=[
      {role:'user',content:original},{role:'assistant',content:'更新后的总份额／总股数是多少？'},
      {role:'user',content:'24775.11 份'},{role:'assistant',content:'更新后的单位成本是多少？未知时可以先留空。'},
      {role:'user',content:'单位成本 1.0790'},{role:'assistant',content:'现金保持不变，还是另有明确的现金调整金额？'}
    ];
    if(legacy)history.push(
      {role:'user',content:'不变'},{role:'assistant',content:'你要按最新总份额校准哪一项持仓？'},
      {role:'user',content:'科创50'},{role:'assistant',content:'你要按最新总份额校准哪一项持仓？'},
      {role:'user',content:'啥意思'},{role:'assistant',content:'你要按最新总份额校准哪一项持仓？'}
    );
    const question=legacy?'科创50':'不变';
    const result=await bind(question,'balance-short-answer',{history}).setHoldingBalance({query:'科创50',quantity:24775.11,averageCost:1.079,cashDelta:0,evidence:question});
    assert.equal(result.status,'applied',JSON.stringify({legacy,result}));assert.equal(result.after.quantity,24775.11);assert.equal(result.after.cost,26732.34);
    assert.equal(store.state().assets[0].value,10000);assert.equal(store.ledgerEntries().length,1);
  }
});
test('简短现金补答必须紧接现金追问，不能从无关、已完成或被取消的对话沿用',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true}),original='更新科创持仓为200份，单位成本1.5元';
  const args={query:'科创',quantity:200,averageCost:1.5,cashDelta:0,evidence:'不变'};
  for(const answer of [
    {role:'assistant',content:'更新后的单位成本是多少？'},
    {role:'assistant',content:'现金保持不变吗？',metadata:{toolCalls:[{name:'set_holding_balance',output:{status:'applied'}}]}},
    {role:'assistant',content:'最近市场怎么样？'}
  ]){
    const result=await bind('不变','balance-unrelated',{history:[{role:'user',content:original},answer]}).setHoldingBalance(args);
    assert.equal(result.status,'needs_information');
  }
  const history=[{role:'user',content:original},{role:'assistant',content:'现金保持不变吗？'}];
  const confused=await bind('啥意思','balance-confused',{history}).setHoldingBalance({...args,evidence:'啥意思'});
  assert.equal(confused.status,'needs_information');
  const result=await bind('不变，不要更新','balance-cancelled',{history}).setHoldingBalance({...args,evidence:'不变，不要更新'});
  assert.notEqual(result.status,'applied');assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});
test('校准不能用推算增量、助手数字、被否定的指令或无关历史写账',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true}),history=balanceHistory(),args={query:'科创',quantity:23671.48,averageCost:1.1141,cashDelta:-1000,evidence:'现金-1000'};
  for(const extra of [{quantity:3218.48},{averageCost:1},{cashDelta:-3556}]){
    const result=await bind('现金-1000','balance-hallucination',{history}).setHoldingBalance({...args,...extra});
    assert.equal(result.status,'needs_information');assert.ok(result.question);assert.ok(result.instruction.includes('不要要求重说'));
  }
  for(const question of ['如果更新科创持仓为200份，现金不动','不要更新科创持仓为200份，现金不动']){
    const result=await bind(question,'balance-denied').setHoldingBalance({...args,quantity:200,averageCost:undefined,cashDelta:0,evidence:question});
    assert.equal(result.status,'blocked');
  }
  const noContext=await bind('现金-1000','balance-no-context').setHoldingBalance(args);
  assert.equal(noContext.status,'needs_information');
  const savedHistory=[...history,{role:'user',content:'现金-1000'},{role:'assistant',content:'已更新。还要直接更新吗？',metadata:{toolCalls:[{name:'set_holding_balance',output:{status:'applied'}}]}}];
  assert.equal((await bind('直接更新','balance-already-saved',{history:savedHistory}).setHoldingBalance(args)).status,'needs_information');
  assert.deepEqual(store.state({raw:true}),before);assert.equal(store.ledgerEntries().length,0);
});
test('校准现金变化的单位错误或同一条消息互相矛盾时只追问，不误扣款',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true});
  for(const cash of ['现金减1000份','现金减1e3','现金不动，但现金减1000元']){
    const question='更新科创持仓为200份，'+cash;
    const result=await bind(question,'invalid-balance-cash').setHoldingBalance({query:'科创',quantity:200,cashDelta:-1000,evidence:question});
    assert.equal(result.status,'needs_information');assert.match(result.question,/现金/);
  }
  assert.deepEqual(store.state({raw:true}),before);
});
test('校准持仓和现金原子提交，现金不足或凭据失败不改任何字段',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true});
  const question='将科创持仓更新为200份，单位成本1.5元，现金减1000元',args={query:'科创',quantity:200,averageCost:1.5,cashDelta:-1000,evidence:question};
  store.db.exec("CREATE TRIGGER reject_balance BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT,'balance receipt failure'); END");
  await assert.rejects(bind(question,'balance-rollback').setHoldingBalance(args),/balance receipt failure/);assert.deepEqual(store.state({raw:true}),before);
  store.db.exec('DROP TRIGGER reject_balance');
  const short='将科创持仓更新为200份，现金减10001元';
  const result=await bind(short,'balance-no-cash').setHoldingBalance({query:'科创',quantity:200,cashDelta:-10001,evidence:short});
  assert.equal(result.status,'needs_information');assert.match(result.question,/现金|余额/);assert.deepEqual(store.state({raw:true}),before);
});

test('字段前置的份额与单位成本补答保留原校准，其他都不变保留现金，旧版反复问标的可恢复',async t=>{
  for(const legacy of [false,true]){
    const {store,bind}=setup(t),original='科创50 我需要更新一下持仓， 持仓收益率是 -百分之16.03 其他都不变';
    const history=[{role:'user',content:original},{role:'assistant',content:'显示的成本金额（或持仓金额）是多少？有这一个数我就能直接把账本校准到位。'}];
    const details='成本是 1.0790 份额是 24775.11    持仓收益率是 -百分之16.03';
    const args={query:'科创50',quantity:24775.11,averageCost:1.079,cashDelta:0,evidence:details};
    const first=await bind(details,'prefixed-details',{history}).setHoldingBalance(args);
    assert.equal(first.status,'needs_information');assert.match(first.question,/单位成本/);assert.equal(first.corrections,undefined);
    history.push({role:'user',content:details},{role:'assistant',content:first.question});
    if(legacy)history.push({role:'user',content:'成本是 1.0790'},{role:'assistant',content:'你要按最新总份额校准哪一项持仓？'},{role:'user',content:'科创啊'},{role:'assistant',content:'你要按最新总份额校准哪一项持仓？'});
    const question=legacy?'科创 50':'成本是 1.0790';
    const result=await bind(question,'prefixed-complete',{history}).setHoldingBalance({...args,evidence:question});
    assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(result.after.quantity,24775.11);assert.equal(result.after.cost,26732.34);assert.equal(store.state().assets[0].value,10000);
  }
});
test('成本数字不能误读成紧随其后的份额标签，普通成本不能凭大小推断单位成本',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true});
  for(const cost of ['成本是1.0790','总成本是26732.34']){
    const question='更新科创持仓，'+cost+' 份额是24775.11，其他都不变';
    const result=await bind(question).setHoldingBalance({query:'科创',quantity:24775.11,averageCost:1.079,evidence:question});
    assert.equal(result.status,'needs_information');assert.match(result.question,/单位成本/);assert.equal(result.corrections,undefined);
  }
  assert.deepEqual(store.state({raw:true}),before);
  const question='更新科创持仓，单位成本是1.0790，份额是24775.11，其他都不变';
  const result=await bind(question).setHoldingBalance({query:'科创',quantity:1.079,evidence:question});
  assert.deepEqual(result.corrections,{quantity:24775.11});
});

test('对话删除持仓和自选独立、可恢复、幂等，现金和买卖历史不动',async t=>{
  const {store,bind}=setup(t),s=store.state({raw:true});s.fundWatchlist=[{code:'011609',name:'科创基金'}];store.save(s,s.revision);
  const cash=store.state().assets[0].value,original='删除科创持仓记录',args={query:'科创',target:'holding'};
  const result=await bind(original,'remove-holding').removeInstrument(args);
  assert.equal(result.status,'applied');assert.equal(store.state().assets.length,1);assert.equal(store.state().assets[0].value,cash);assert.equal(store.state().fundWatchlist.length,1);
  assert.equal((await bind(original,'remove-holding').removeInstrument(args)).replayed,true);assert.equal(store.ledgerEntries().length,1);
  assert.ok(store.audit().some(a=>a.label.includes('删除持仓')));
  const watch=await bind('移除科创自选','remove-watch').removeInstrument({query:'科创',target:'watchlist'});
  assert.equal(watch.status,'applied');assert.equal(store.state().fundWatchlist.length,0);assert.equal(store.ledgerEntries().length,2);assert.equal(store.state().assets[0].value,cash);
});
test('删除范围和标的缺项能补答，旧版不需要保留承接用户标的，助手名称不能授权删除',async t=>{
  const {store,bind}=setup(t),s=store.state({raw:true});s.fundWatchlist=[{code:'011609',name:'科创基金'}];store.save(s,s.revision);
  const original='删除科创',args={query:'科创',target:'holding'};
  const first=await bind(original).removeInstrument(args);assert.equal(first.status,'needs_information');
  const history=[{role:'user',content:original},{role:'assistant',content:first.question,metadata:{toolCalls:[{name:'remove_instrument',output:first}]}}];
  const result=await bind('自选','remove-follow',{history}).removeInstrument({...args,target:'watchlist'});
  assert.equal(result.status,'applied');assert.equal(store.state().assets.length,2);
  const prior=[{role:'user',content:'科创基金是0了为什么还在持仓里？'},{role:'assistant',content:'你可以删除零持仓记录。'}];
  assert.equal((await bind('不需要保留','remove-legacy',{history:prior}).removeInstrument(args)).status,'applied');
  const noTarget=[{role:'user',content:'为什么还在持仓里？'},{role:'assistant',content:'你可以删除科创基金。'}];
  assert.equal((await bind('不需要保留','remove-no-target',{history:noTarget}).removeInstrument(args)).status,'needs_information');
});
test('删除拒绝否定、假设、含糊目标、待入账和撤回授权，失败原子回滚',async t=>{
  const {store,bind}=setup(t),before=store.state({raw:true}),args={query:'科创',target:'holding'};
  for(const question of ['不要删除科创持仓','如果删除科创持仓','科创持仓怎么样','删除持仓']){
    assert.notEqual((await bind(question).removeInstrument(args)).status,'applied');
  }
  store.db.exec("CREATE TRIGGER reject_removal BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT,'removal receipt failure'); END");
  await assert.rejects(bind('删除科创持仓').removeInstrument(args),/removal receipt failure/);assert.deepEqual(store.state({raw:true}),before);
  store.db.exec('DROP TRIGGER reject_removal');
  store.postLedgerEntry({id:'pending-removal-test',asset:{id:'star'},status:'pending',signature:'pending-removal-test',generation:store.ledgerGeneration(),createdAt:now.toISOString()});
  const pending=await bind('删除科创持仓').removeInstrument(args);assert.equal(pending.status,'needs_information');assert.match(pending.question,/待入账/);
  store.saveConfig({allowLedgerWrites:false});await assert.rejects(bind('删除科创持仓').removeInstrument(args),/未开启|授权/);assert.deepEqual(store.state({raw:true}),before);
});
