import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {nowDate} from '../src/domain.mjs';
import {reconcile} from '../src/reconciliation.mjs';
import {cashCalendar,monthlyBridge} from '../src/planning.mjs';
import {buildAssistantData,readAssistantPage,automaticPageContext} from '../src/assistant-data.mjs';
import {createLedgerService} from '../src/ledger.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'steady-ledger-review-')),store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const state=store.state();
  state.assets=[{id:'cash',name:'账户',type:'cash',currency:'CNY',value:1000}];
  state.buyPlans=[{id:'plan',name:'基金',code:'000001',amount:100,plannedDate:'2026-09-01'}];
  store.save(state,0);return store;
}
test('对账、历史恢复与重做同步流水；读取旧版本流水保留当时状态',t=>{
  const store=fixture(t),input={revision:1,actual:1100,assetId:'cash',date:nowDate(),reason:'核对过账单',save:true,adjust:true};
  const receipt=reconcile(store,input),beforeUndo=store.ledgerCursor();
  assert.equal(receipt.difference,100);assert.equal(store.state().assets[0].value,1100);
  assert.throws(()=>reconcile(store,input),/版本/);
  store.undo(store.audit()[0].id,2);
  assert.equal(store.state().assets[0].value,1000);assert.equal(store.ledgerEntry(receipt.id).status,'reversed');
  assert.equal(store.ledgerPage({status:'applied'},beforeUndo).total,1);
  store.undo(store.audit()[0].id,3);assert.equal(store.state().assets[0].value,1100);
  assert.equal(store.ledgerEntry(receipt.id).status,'applied');
});
test('旧流水可按账户与日期跨页，冻结的数据库游标在后续记账后仍然有效',t=>{
  const store=fixture(t);
  const entry=i=>({id:String(i),signature:String(i),status:'pending',asset:{id:'security'},cashAssetId:'cash',date:'2026-01-01',createdAt:new Date(i*1000).toISOString()});
  for(let i=0;i<105;i++)store.postLedgerEntry(entry(i));
  const snapshot=buildAssistantData(store,store.state(),{indexedLedger:true});
  store.postLedgerEntry(entry(106));store.cancelLedgerEntry('0');
  const args={page:'assets',section:'ledgerEntries',assetId:'cash',date:'2026-01-01',status:'pending',offset:100};
  const old=readAssistantPage(snapshot,args,store.ledgerPage);
  assert.equal(old.lists.ledgerEntries.total,105);assert.equal(old.data.at(-1).id,'0');
  assert.equal(store.ledgerPage({status:'cancelled',assetId:'cash'}).items[0].id,'0');
});
test('日报拒绝比较不完整基准，行情摘要和自选目录给出正确资料',t=>{
  const store=fixture(t),state=store.state();state.fundWatchlist=[{name:'仅自选',code:'000001'}];store.save(state,1);
  const day='2020-01-01';
  store.db.prepare('INSERT INTO history VALUES(?,?)').run(day,JSON.stringify({day,netWorth:0,complete:false}));
  assert.equal(store.generateReport(store.state()).changes,null);
  const snapshot=buildAssistantData(store);
  assert.equal(snapshot.pages.assets.fundWatchlist[0].name,'仅自选');
  snapshot.pages.instruments.items=[{priceHistory:[{date:'2026-02-02'},{date:'2026-02-01'}]}];
  assert.equal(automaticPageContext(snapshot).pages.instruments.items[0].priceHistory.latest.date,'2026-02-02');
});
test('计划成交使用同一笔持仓和现金事务，重复提交不重复扣款',async t=>{
  const store=fixture(t),ledger=createLedgerService(store),input={planId:'plan',revision:1,assetId:'new',newType:'fund',cashAssetId:'cash',date:'2026-08-03',amount:100,fee:2,price:2};
  const r=await Promise.allSettled([ledger.executePlan(input),ledger.executePlan(input)]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
  const state=store.state({raw:true});
  assert.equal(state.assets[0].value,900);assert.equal(state.assets[1].quantity,49);assert.equal(state.buyPlans[0].entryId,store.ledgerEntries()[0].id);
  assert.equal(state.buyPlans[0].status,'completed');
});
test('等待基金净值期间不扣现金；无需 AI 授权即可结算手工确认的成交',async t=>{
  const store=fixture(t),ledger=createLedgerService(store,{fundOptions:{fetchImpl:async()=>{throw Error('offline');}}});
  const input={planId:'plan',revision:1,assetId:'new',newType:'fund',cashAssetId:'cash',date:'2026-08-03',amount:100,fee:0,price:null};
  assert.equal((await ledger.executePlan(input)).status,'pending');
  assert.equal(store.state().assets[0].value,1000);
  await assert.rejects(ledger.executePlan(input),/待入账/);
  store.setKV('fund_nav:000001',{date:input.date,price:2,basis:'unit_nav',currency:'CNY'});
  await ledger.processPending();await ledger.processPending();
  assert.equal(store.state().assets[0].value,900);assert.equal(store.state().buyPlans[0].status,'completed');
});
test('90 天预测按真实月份处理发薪日和月供，只在打开假设时计入计划',t=>{
  const store=fixture(t),state=store.state();state.profile={...state.profile,income:200,expenses:0,payday:31};
  state.debts=[{name:'月供',balance:1000,payment:50,currency:'CNY'}];
  const plain=cashCalendar(state,{day:'2026-08-31'}),scenario=cashCalendar(state,{day:'2026-08-31',includePlans:true});
  assert.equal(plain.rows.length,90);assert.equal(plain.rows[0].balance,1000);
  assert.equal(scenario.lowDate,'2026-09-01');assert.equal(scenario.low,900);
  assert.equal(scenario.rows.find(r=>r.date==='2026-09-30').balance,1050);
});
test('月度变化拆解的各项相加等于净资产变化，缺失基准明确留空',()=>{
  const pos={id:'stock',type:'stock',currency:'USD',quantity:1,quoted:true};
  const base={day:'2026-09-30',revision:1,netWorth:700,complete:true,rates:{USD:7},positions:[{...pos,value:100}]};
  const end={day:'2026-10-01',revision:2,netWorth:970,complete:true,rates:{USD:8,CNY:1},positions:[{...pos,value:110}]};
  const bridge=monthlyBridge('2026-10',base,[end],[{revision:2,status:'applied',kind:'cash',asset:{currency:'CNY'},side:'income',amount:70}],[]);
  assert.deepEqual([bridge.total,bridge.cash,bridge.market,bridge.fx,bridge.other],[270,70,80,100,20]);
  assert.equal(monthlyBridge('2026-10',{...base,day:'2026-09-28'},[end],[],[]).complete,false);
});
test('工资到账后恢复旧版本，现金、工资凭据与补发游标一起恢复',t=>{
  const store=fixture(t),state=store.state();
  state.profile={...state.profile,income:100,payday:10,autoIncome:{enabled:true,cashAssetId:'cash',startsOn:'2026-08-01',lastPeriod:''}};
  store.save(state,state.revision);
  const time=new Date('2026-08-10T08:00:00Z');
  assert.equal(store.applyIncome(time).posted,1);
  const target=store.audit()[0].id;
  store.undo(target,store.state().revision);
  assert.equal(store.state().assets[0].value,1000);assert.equal(store.incomeStatus(time).credits.length,0);
  assert.equal(store.applyIncome(time).posted,1);assert.equal(store.applyIncome(time).posted,0);
  assert.equal(store.state().assets[0].value,1100);
});

const newFundTrade = {
  planId: 'plan', revision: 2, assetId: 'new', newType: 'fund',
  cashAssetId: 'cash', date: '2026-08-03', amount: 100, fee: 0, price: 2
};

test('新建计划持仓不会误改编号恰好相同的旧持仓', async t => {
  const store = fixture(t), state = store.state({raw: true});
  state.assets.push({id: 'plan-plan', name: '另一只基金', type: 'fund', currency: 'CNY',
    quantity: 10, value: 20, fund: {code: '000002'}});
  store.save(state, 1);
  const receipt = await createLedgerService(store).executePlan(newFundTrade);
  const assets = store.state({raw: true}).assets;
  assert.equal(assets.find(a => a.id === 'plan-plan').quantity, 10);
  assert.equal(assets.find(a => a.id === receipt.asset.id).fund.code, '000001');
  assert.equal(assets.find(a => a.id === receipt.asset.id).quantity, 50);
});

test('两项计划同时为同一基金新建持仓，在净值披露前只登记一项', async t => {
  const store = fixture(t), state = store.state({raw: true});
  state.buyPlans.push({...state.buyPlans[0], id: 'other'});
  store.save(state, 1);
  const ledger = createLedgerService(store, {fundOptions: {fetchImpl: async () => {throw Error('offline');}}});
  const results = await Promise.allSettled(['plan', 'other'].map(planId =>
    ledger.executePlan({...newFundTrade, planId, price: null})));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /待入账/);
  assert.equal(store.ledgerEntries({pending: true}).length, 1);
  assert.equal(store.state().assets[0].value, 1000);
});

test('待入账期间手工建立了同标的持仓，结算时保留现金并提示重新选择', async t => {
  const store = fixture(t);
  const ledger = createLedgerService(store, {fundOptions: {fetchImpl: async () => {throw Error('offline');}}});
  const entry = await ledger.executePlan({...newFundTrade, revision: 1, price: null});
  const state = store.state({raw: true});
  state.assets.push({...entry.asset, id: 'manual', quantity: 10, value: 20});
  store.save(state, 1);
  store.setKV('fund_nav:000001', {date: entry.date, price: 2, basis: 'unit_nav', currency: 'CNY'});
  await ledger.processPending();
  assert.equal(store.ledgerEntry(entry.id).status, 'blocked');
  const saved = store.state({raw: true});
  assert.equal(saved.assets.length, 2);
  assert.equal(saved.assets[0].value, 1000);
  assert.equal(saved.buyPlans[0].status, 'pending');

  const retry = await ledger.executePlan({...newFundTrade, revision: saved.revision, assetId: 'manual'});
  assert.equal(retry.status, 'applied');
  const settled = store.state({raw: true});
  assert.equal(settled.assets.length, 2);
  assert.equal(settled.assets[0].value, 900);
  assert.equal(settled.assets[1].quantity, 60);
});

test('等待净值时修改计划代码，旧成交不能完成新标的的计划', async t => {
  const store = fixture(t);
  const ledger = createLedgerService(store, {fundOptions: {fetchImpl: async () => {throw Error('offline');}}});
  const entry = await ledger.executePlan({...newFundTrade, revision: 1, price: null});
  const state = store.state({raw: true});
  state.buyPlans[0].code = '000002';
  store.save(state, 1);
  store.setKV('fund_nav:000001', {date: entry.date, price: 2, basis: 'unit_nav', currency: 'CNY'});
  await ledger.processPending();
  assert.equal(store.ledgerEntry(entry.id).status, 'blocked');
  assert.equal(store.state().assets[0].value, 1000);
  assert.equal(store.state().buyPlans[0].status, 'pending');
});
