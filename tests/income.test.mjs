import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {initialState,validateState} from '../src/domain.mjs';
import {incomePlan} from '../src/income.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'steady-income-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.testDirectory=dir;return store;}
function fixture(){const s=initialState();s.profile={...s.profile,income:13100,payday:25,autoIncome:{enabled:true,cashAssetId:'cash',startsOn:'2026-10-28'}};s.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:1000,asOf:'2026-10-28'}];return validateState(s);}
test('启用后只处理起始日期后的发薪日，按账本时区在25日入账，同月重复检查和数据库重开不重复',t=>{
 const s=setup(t);s.save(fixture(),0);const before=s.state({raw:true});
 let result=s.applyIncome(new Date('2026-10-28T05:00:00Z'));assert.equal(result.posted,0);assert.equal(result.nextDate,'2026-11-25');assert.deepEqual(s.state({raw:true}),before);
 assert.equal(s.applyIncome(new Date('2026-11-24T15:59:59Z')).posted,0);
 result=s.applyIncome(new Date('2026-11-24T16:00:00Z'));assert.equal(result.posted,1);assert.equal(result.totalAmount,13100);assert.equal(s.state({raw:true}).assets[0].value,14100);assert.equal(result.nextDate,'2026-12-25');
 assert.equal(s.applyIncome(new Date('2026-11-25T05:00:00Z')).posted,0);
 const reopened=openStore(s.testDirectory);
 try{assert.equal(reopened.applyIncome(new Date('2026-11-25T05:00:00Z')).posted,0);assert.equal(reopened.state({raw:true}).assets[0].value,14100);}finally{reopened.close();}
});
test('停机跨月后逐月补记，快照记在实际处理日，备份中的月份游标可防止新数据库恢复后再加一次',t=>{
 const s=setup(t);s.save(fixture(),0);
 const result=s.applyIncome(new Date('2026-12-26T00:00:00Z'));assert.equal(result.posted,2);assert.equal(result.totalAmount,26200);assert.equal(s.state({raw:true}).assets[0].value,27200);assert.equal(s.history().at(-1).day,'2026-12-26');
 assert.deepEqual(s.incomeStatus(new Date('2026-12-26')).credits.map(c=>c.period),['2026-12','2026-11']);
 const restored=setup(t);restored.save(s.state({raw:true}),0);assert.equal(restored.applyIncome(new Date('2026-12-31')).posted,0);assert.equal(restored.state({raw:true}).assets[0].value,27200);
 assert.equal(restored.applyIncome(new Date('2027-01-25T00:00:00Z')).posted,1);assert.equal(restored.state({raw:true}).assets[0].value,40300);
});
test('账户、账本、入账凭据原子提交，凭据写入失败时余额和版本回滚，重试只入账一次',t=>{
 const s=setup(t);s.save(fixture(),0);const before=s.state({raw:true}),audit=s.audit();
 s.db.exec("CREATE TRIGGER reject_income BEFORE INSERT ON kv WHEN NEW.key='income_credits' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
 assert.throws(()=>s.applyIncome(new Date('2026-11-25')),/receipt failure/);assert.deepEqual(s.state({raw:true}),before);assert.deepEqual(s.audit(),audit);assert.equal(s.getKV('income_credits'),null);
 s.db.exec('DROP TRIGGER reject_income');assert.equal(s.applyIncome(new Date('2026-11-25')).posted,1);assert.equal(s.applyIncome(new Date('2026-11-25')).posted,0);
});
test('31日遇短月按月末入账，停用、零收入或失效账户不生成凭据也不修改余额',t=>{
 const state=fixture();state.profile.payday=31;state.profile.autoIncome.startsOn='2026-02-01';
 let plan=incomePlan(state,[],new Date('2026-02-28T00:00:00Z'));assert.equal(plan.due[0].date,'2026-02-28');
 state.profile.autoIncome.enabled=false;assert.equal(incomePlan(state).status,'disabled');
 state.profile.autoIncome.enabled=true;state.profile.income=0;assert.equal(incomePlan(state).status,'blocked');
 state.profile.income=13100;state.assets[0].restricted=true;assert.equal(incomePlan(state).status,'blocked');
 const s=setup(t);s.save(state,0);const before=s.state({raw:true});assert.equal(s.applyIncome(new Date('2026-03-31')).posted,0);assert.deepEqual(s.state({raw:true}),before);assert.equal(s.getKV('income_credits'),null);
 assert.throws(()=>validateState({...state,profile:{...state.profile,payday:25.5}}),/整数发薪日/);
});
