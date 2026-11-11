import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {initialState,validateState} from '../src/domain.mjs';
import {expensePlan} from '../src/expenses.mjs';
import {cashCalendar} from '../src/planning.mjs';

function setup(t){const dir=mkdtempSync(join(tmpdir(),'steady-expenses-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.testDirectory=dir;return store;}
function fixture(){const s=initialState();s.profile={...s.profile,income:0,expenses:5500,autoExpenses:{enabled:true,cashAssetId:'cash',startsOn:'2026-11-11'}};s.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:30000,asOf:'2026-11-11'}];return validateState(s);}

test('必要支出按账本时区月末扣减 5500，同月刷新、重开和改额不重复扣减',t=>{
  const store=setup(t);store.save(fixture(),0);const before=store.state({raw:true});
  assert.equal(store.applyExpenses(new Date('2026-11-11T00:00:00Z')).nextDate,'2026-11-30');
  assert.equal(store.applyExpenses(new Date('2026-11-29T15:59:59Z')).posted,0);
  assert.deepEqual(store.state({raw:true}),before);
  const result=store.applyExpenses(new Date('2026-11-29T16:00:00Z'));
  assert.equal(result.posted,1);assert.equal(result.totalAmount,5500);assert.equal(result.nextDate,'2026-12-31');
  assert.equal(store.state().assets[0].value,24500);assert.equal(store.expenseStatus().debits[0].dueDate,'2026-11-30');
  assert.equal(store.applyExpenses(new Date('2026-11-30T00:00:00Z')).posted,0);
  const reopened=openStore(store.testDirectory);
  try{assert.equal(reopened.applyExpenses(new Date('2026-11-30')).posted,0);assert.equal(reopened.state().assets[0].value,24500);}finally{reopened.close();}
  const changed=store.state({raw:true});changed.profile.expenses=6000;store.save(changed,changed.revision);
  assert.equal(store.applyExpenses(new Date('2026-11-30')).posted,0);
  assert.equal(store.applyExpenses(new Date('2026-12-31')).totalAmount,6000);
  assert.equal(store.state().assets[0].value,18500);
});

test('停机跨年补扣各月一次，恢复 JSON 备份不重复，短月及闰年取真实月末',t=>{
  const store=setup(t);store.save(fixture(),0);
  assert.equal(store.applyExpenses(new Date('2027-01-31')).posted,3);assert.equal(store.state().assets[0].value,13500);
  const restored=setup(t);restored.save(store.state({raw:true}),0);
  assert.equal(restored.applyExpenses(new Date('2027-02-01')).posted,0);
  assert.equal(restored.applyExpenses(new Date('2027-02-28')).posted,1);assert.equal(restored.state().assets[0].value,8000);
  const state=fixture();state.profile.autoExpenses.startsOn='2028-02-01';
  assert.equal(expensePlan(state,[],new Date('2028-02-28')).due.length,0);
  assert.equal(expensePlan(state,[],new Date('2028-02-29')).due[0].date,'2028-02-29');
});

test('凭据失败则现金、月份游标、审计与快照全部回滚',t=>{
  const store=setup(t);store.save(fixture(),0);const before=store.state({raw:true}),audit=store.audit(),history=store.history();
  store.db.exec("CREATE TRIGGER reject_expenses BEFORE INSERT ON kv WHEN NEW.key='expense_debits' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
  assert.throws(()=>store.applyExpenses(new Date('2026-11-30')),/receipt failure/);
  assert.deepEqual(store.state({raw:true}),before);assert.deepEqual(store.audit(),audit);assert.deepEqual(store.history(),history);
  assert.equal(store.getKV('expense_debits'),null);
  store.db.exec('DROP TRIGGER reject_expenses');
  assert.equal(store.applyExpenses(new Date('2026-11-30')).posted,1);
  assert.equal(store.applyExpenses(new Date('2026-11-30')).posted,0);
});

test('未启用、零支出、受限或失效账户、余额不足都不扣减，补足余额后可重试',t=>{
  for(const change of [s=>{s.profile.autoExpenses.enabled=false;},s=>{s.profile.expenses=0;},s=>{s.assets[0].restricted=true;},s=>{s.assets[0].currency='USD';},s=>{s.assets=[];},s=>{s.assets[0].value=5000;}]){
    const store=setup(t),state=fixture();change(state);store.save(state,0);const before=store.state({raw:true});
    assert.equal(store.applyExpenses(new Date('2026-11-30')).posted,0);assert.deepEqual(store.state({raw:true}),before);assert.equal(store.getKV('expense_debits'),null);
  }
  const store=setup(t),state=fixture();state.assets[0].value=5000;store.save(state,0);
  assert.match(store.expenseStatus(new Date('2026-11-30')).message,/余额不足/);
  const funded=store.state({raw:true});funded.assets[0].value=5500;store.save(funded,funded.revision);
  assert.equal(store.applyExpenses(new Date('2026-11-30')).posted,1);assert.equal(store.state().assets[0].value,0);
});

test('历史撤销和重做同步扣减凭据，清空可恢复，不重复记账',t=>{
  const store=setup(t);store.save(fixture(),0);store.applyExpenses(new Date('2026-11-30'));
  store.undo(store.audit()[0].id,store.state().revision);
  assert.equal(store.state().assets[0].value,30000);assert.equal(store.getKV('expense_debits').length,0);
  store.undo(store.audit()[0].id,store.state().revision);
  assert.equal(store.state().assets[0].value,24500);assert.equal(store.getKV('expense_debits').length,1);
  assert.equal(store.applyExpenses(new Date('2026-11-30')).posted,0);
  store.reset(store.state().revision);assert.deepEqual(store.getKV('expense_debits'),[]);
  store.undo(store.audit()[0].id,store.state().revision);
  assert.equal(store.state().assets[0].value,24500);assert.equal(store.applyExpenses(new Date('2026-11-30')).posted,0);
});

test('月度变化将自动扣减归入现金支出，历史月份不会随以后扣减变化',t=>{
  const store=setup(t);store.save(fixture(),0);store.snapshot(store.state(),'2026-10-31');
  store.applyExpenses(new Date('2026-11-30'));
  const summary=store.monthSummary('2026-11');
  assert.equal(summary.complete,true);assert.equal(summary.total,-5500);assert.equal(summary.cash,-5500);assert.equal(summary.other,0);
  store.applyExpenses(new Date('2026-12-31'));
  assert.deepEqual(store.monthSummary('2026-11'),summary);
});

test('90 天预测每个月末扣除完整 5500，月中不扣，已结算月末不重复',()=>{
  const state=fixture(),calendar=cashCalendar(state,{day:'2026-11-11'});
  assert.equal(calendar.rows.find(r=>r.date==='2026-11-29').balance,30000);
  assert.equal(calendar.rows.find(r=>r.date==='2026-11-30').balance,24500);
  assert.equal(calendar.rows.find(r=>r.date==='2026-12-31').balance,19000);
  assert.equal(calendar.rows.find(r=>r.date==='2027-01-31').balance,13500);
  assert.equal(calendar.rows.flatMap(r=>r.events).filter(e=>e.name==='必要生活支出（月末）').length,3);
  state.assets[0].value=24500;state.profile.autoExpenses.lastPeriod='2026-11';
  assert.equal(cashCalendar(state,{day:'2026-11-30'}).rows.find(r=>r.date==='2026-12-31').balance,19000);
  state.profile.autoExpenses.startsOn='2027-01-01';
  assert.equal(cashCalendar(state,{day:'2026-11-11'}).rows.find(r=>r.date==='2026-12-31').balance,24500);
});

test('旧档案不自动开启扣减，启用时校验起始日期、月份游标与账户',()=>{
  const old=fixture();delete old.profile.autoExpenses;assert.equal(validateState(old).profile.autoExpenses.enabled,false);
  for(const invalid of [{cashAssetId:''},{startsOn:''},{startsOn:'2026-02-30'},{lastPeriod:'2026-13'}]){
    const state=fixture();Object.assign(state.profile.autoExpenses,invalid);assert.throws(()=>validateState(state));
  }
});
