import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { calculate, validateState, initialState } from '../src/domain.mjs';
import { refreshFundNAV, searchFunds } from '../src/funds.mjs';
import { dailyValuation } from '../src/valuation.mjs';

function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'steady-fund-')),store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const state=store.state();state.assets=[{id:'fund',name:'Synthetic fund',type:'fund',currency:'CNY',value:250,asOf:'2026-10-22',quantity:100,unit:'份',fund:{code:'123456',autoNav:true},reported:{date:'2026-10-22',value:250,dividends:10,totalReturn:20}}];
  store.save(state,0);return store;
}
const reply=(date='2026-10-23')=>({ok:true,json:async()=>({ErrCode:0,Data:{LSJZList:[{FSRQ:date,DWJZ:'2.6',LJJZ:'3.5'},{FSRQ:'2026-10-22',DWJZ:'2.5',LJJZ:'3.4'}]}})});

test('基金名称与代码搜索校验标的身份、保留前导零、离线回退且不改动账本',async t=>{
  const store=setup(t),before=store.state({raw:true});
  const row={CATEGORY:700,CODE:'008164',NAME:'南方标普红利低波50ETF联接C',JP:'NFBPHLDB50ETFLJC',FundBaseInfo:{FCODE:'008164',FTYPE:'指数型-股票',OTHERNAME:'南方大盘红利50C'}};
  const fetchImpl=async url=>{assert.equal(url.hostname,'fundsuggest.eastmoney.com');assert.equal(url.searchParams.get('key'),'008164');return Response.json({ErrCode:0,Datas:[row,{...row,CATEGORY:1,CODE:'600000'},{...row,CODE:'8164'},{...row,CODE:'006789'},row]});};
  const found=await searchFunds(store,' 008164 ',{fetchImpl});assert.deepEqual(found.items,[{code:'008164',name:row.NAME,type:'指数型-股票'}]);assert.equal(found.message,'');
  const offline=async()=>{throw new Error('offline');};
  for(const query of ['红利','008164','南方大盘红利50C','NFBPHLDB']){
    const result=await searchFunds(store,query,{fetchImpl:offline});assert.equal(result.items[0].code,'008164');assert.match(result.message,/在线搜索暂不可用/);
  }
  assert.equal((await searchFunds(store,'不存在的基金',{fetchImpl:offline})).items.length,0);
  assert.deepEqual(store.state({raw:true}),before);
  for(const query of ['',null,'a'.repeat(81)])await assert.rejects(()=>searchFunds(store,query,{fetchImpl}),/请输入/);
});

test('截图校准保留确认金额和成本，公开净值估值单列，更新日期的净值才恢复自动估值',t=>{
 const store=setup(t),s=store.state();s.assets[0]={...s.assets[0],quantity:20453,fund:{code:'123456',autoNav:true,valuationOverride:{value:20089.48,quantity:20453,date:'2026-10-28',navDate:'2026-10-27',dailyProfit:-878.02,dailyProfitDate:'2026-10-27'}},costBasis:{amount:22816.61,quantity:20453,currency:'CNY',method:'inferred_pnl'}};store.save(s,s.revision);
 store.setKV('fund_nav:123456',{price:.981,date:'2026-10-27',previous:{price:1.0275,date:'2026-10-26'},currency:'CNY',source:'公开净值'});
 let a=store.state().assets[0];assert.equal(a.value,20089.48);assert.equal(a.quantity,20453);assert.equal(a.investment.profit,-2727.13);assert.equal(a.investment.returnPercent.toFixed(2),'-11.95');assert.equal(a.valuation.status,'manual');assert.equal(a.valuation.navValue,20064.39);assert.equal(a.movement.kind,'reported_daily');assert.equal(a.movement.amount,-878.02);assert.equal(calculate(store.state()).complete,true);
 store.setKV('fund_nav:123456',{price:1,date:'2026-10-28',currency:'CNY'});a=store.state().assets[0];assert.equal(a.value,20453);assert.equal(a.valuation.status,'nav');assert.equal(a.costBasis.amount,22816.61);
 const changed=store.state();changed.assets[0].quantity=20454;store.save(changed,changed.revision);assert.equal(store.state().assets[0].value,20454);assert.equal(store.state().assets[0].investment.status,'quantity_changed');
});

test('local NAV uses disclosed unit NAV, sends only fund code and preserves raw ledger and revision',async t=>{
  const store=setup(t),revision=store.state().revision;let calls=0;
  const fetchImpl=async url=>{calls++;assert.equal(url.searchParams.get('fundCode'),'123456');assert.ok(!url.href.includes('100'));return reply();};
  assert.equal((await refreshFundNAV(store,{now:new Date('2026-10-24T08:00:00Z'),fetchImpl})).updated,1);
  const s=store.state();assert.equal(s.assets[0].value,260);assert.equal(s.assets[0].asOf,'2026-10-23');assert.equal(s.revision,revision);assert.equal(store.state({raw:true}).assets[0].value,250);assert.equal(s.assets[0].reported.dividends,10);assert.equal(calculate(s).cash,0);
  const v=dailyValuation(s,calculate(s),[],'2026-10-24');assert.equal(v.delta,null);assert.equal(v.funds.amount,10);assert.equal(v.funds.date,'2026-10-23');
  await refreshFundNAV(store,{now:new Date('2026-10-24T08:01:00Z'),fetchImpl});assert.equal(calls,1);
  s.profile.income=999;store.save(s,revision);assert.equal(store.state({raw:true}).assets[0].value,250);assert.equal(store.state().assets[0].value,260);
  const edited=store.state();edited.assets[0].quantity=120;store.save(edited,edited.revision);assert.equal(store.state().assets[0].value,312);assert.equal(store.state({raw:true}).assets[0].value,null);
});

test('failed, older or future NAV does not overwrite a known value or fabricate daily movement',async t=>{
  const store=setup(t);await refreshFundNAV(store,{now:new Date('2026-10-24T08:00:00Z'),fetchImpl:async()=>reply()});
  const failed=await refreshFundNAV(store,{now:new Date('2026-10-24T09:00:00Z'),fetchImpl:async()=>{throw new Error();}});assert.equal(failed.errors.length,1);assert.equal(store.state().assets[0].value,260);assert.equal(calculate(store.state()).complete,false);assert.equal(dailyValuation(store.state(),calculate(store.state()),[]).funds.amount,null);
  await refreshFundNAV(store,{now:new Date('2026-10-24T10:00:00Z'),fetchImpl:async()=>reply('2026-10-25')});assert.equal(store.getKV('fund_nav:123456').date,'2026-10-23');
  await refreshFundNAV(store,{now:new Date('2026-10-24T11:00:00Z'),fetchImpl:async()=>reply('2026-10-21')});assert.equal(store.getKV('fund_nav:123456').date,'2026-10-23');
});

test('daily net change requires yesterday and complete estimates; holdings additions are separate from NAV movement',async t=>{
  const store=setup(t);await refreshFundNAV(store,{now:new Date('2026-10-24T08:00:00Z'),fetchImpl:async()=>reply()});const s=store.state(),m=calculate(s);
  assert.equal(dailyValuation(s,m,[{day:'2026-10-22',netWorth:200}], '2026-10-24').delta,null);
  assert.equal(dailyValuation(s,m,[{day:'2026-10-23',netWorth:250,complete:false}], '2026-10-24').delta,null);
  const v=dailyValuation(s,m,[{day:'2026-10-23',netWorth:250,complete:true,revision:0}], '2026-10-24');assert.equal(v.delta,10);assert.equal(v.bookChanged,true);
});

test('fund units and unknown insurance premium frequency survive validation without assuming annual premium',()=>{
  const s=initialState();s.assets=[{id:'p',type:'insurance',name:'Synthetic policy',currency:'CNY',value:1000,asOf:'2026-10-23',insurance:{premiumAmount:500,premiumFrequency:'unknown',premiumInExpenses:false}}];
  const m=calculate(validateState(s));assert.equal(m.totalAssets,1000);assert.equal(m.insuranceExpenseComplete,false);assert.equal(m.surplus,null);
  s.assets=[{id:'f',type:'fund',name:'Synthetic fund',currency:'CNY',value:100,quantity:10,unit:'股',asOf:'2026-10-23',fund:{code:'123456',autoNav:true}}];assert.throws(()=>validateState(s),/以份为单位/);
});

test('自选基金兼容旧账本、按代码去重校验，刷新净值不改变持仓或资产合计',async t=>{
  const legacy=initialState();delete legacy.fundWatchlist;assert.deepEqual(validateState(legacy).fundWatchlist,[]);
  assert.throws(()=>validateState({...legacy,fundWatchlist:[{code:'123',name:'无效'}]}),/六位数字/);
  assert.throws(()=>validateState({...legacy,fundWatchlist:[{code:'006789',name:'一'},{code:'006789',name:'二'}]}),/重复/);
  const store=setup(t),state=store.state();state.fundWatchlist=[{code:'123456',name:'已持有的基金'},{code:'006789',name:'仅关注的基金'}];store.save(state,state.revision);
  const before=store.state({raw:true}),calls=[];
  await refreshFundNAV(store,{now:new Date('2026-10-24T08:00:00Z'),fetchImpl:async url=>{calls.push(url.searchParams.get('fundCode'));return reply();}});
  assert.deepEqual(calls.sort(),['006789','123456']);assert.deepEqual(store.state({raw:true}),before);
  const projected=store.state();assert.equal(projected.assets.length,1);assert.equal(projected.fundWatchlist[1].valuation.price,2.6);assert.equal(projected.fundWatchlist[1].movement.amount,null);
  assert.deepEqual(calculate(projected),calculate({...projected,fundWatchlist:[]}));
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(projected))).fundWatchlist,before.fundWatchlist);
});
