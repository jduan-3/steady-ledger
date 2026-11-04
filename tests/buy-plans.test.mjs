import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, validateState, calculate } from '../src/domain.mjs';
import { openStore } from '../src/store.mjs';
import { buildAssistantData, readAssistantPage } from '../src/assistant-data.mjs';

const plan={id:'plan',name:'计划买入的基金',code:'008164',amount:1000,currency:'CNY',plannedDate:'2026-11-06',condition:'确认现金后分批买入',status:'pending',createdOn:'2026-11-04',completedOn:''};

test('买入待办兼容旧档案，校验日期、状态、金额和唯一编号',()=>{
  const state=initialState();delete state.buyPlans;
  assert.deepEqual(validateState(state).buyPlans,[]);
  const clean=validateState({...state,buyPlans:[plan]});assert.deepEqual(clean.buyPlans,[plan]);
  for(const change of [{amount:0},{amount:-1},{plannedDate:'2026-02-30'},{status:'unknown'},{status:'completed',completedOn:''},{name:'   '}])assert.throws(()=>validateState({...state,buyPlans:[{...plan,...change}]}));
  assert.throws(()=>validateState({...state,buyPlans:[plan,plan]}),/重复/);
  assert.deepEqual(validateState({...state,buyPlans:[{...plan,amount:null,plannedDate:''}]}).buyPlans[0].amount,null);
});

test('买入待办保存、执行、撤销、备份与重新打开保留记录，现金和持仓不受影响',t=>{
  const dir=mkdtempSync(join(tmpdir(),'steady-plans-'));let store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const state=store.state();state.assets=[{id:'cash',name:'测试现金',type:'cash',currency:'CNY',value:10000,asOf:'2026-11-04',inPool:true}];
  state.buyPlans=[plan];store.save(state,0,'添加买入待办');
  const before=store.state({raw:true}),metrics=calculate(store.state()),snapshot=buildAssistantData(store);
  assert.deepEqual(readAssistantPage(snapshot,{page:'dashboard',section:'buyPlans'}).data,[plan]);
  const executed=store.state();executed.buyPlans[0].status='completed';executed.buyPlans[0].completedOn='2026-11-04';
  store.save(executed,executed.revision,'标记执行');
  assert.deepEqual(store.state().assets,before.assets);assert.deepEqual(calculate(store.state()),metrics);assert.equal(store.ledgerEntries().length,0);
  const backup=validateState(JSON.parse(JSON.stringify(store.state())));assert.equal(backup.buyPlans[0].status,'completed');
  assert.throws(()=>store.save(before,before.revision),/其他窗口更新/);
  store.undo(store.audit()[0].id,store.state().revision);assert.equal(store.state().buyPlans[0].status,'pending');
  store.close();store=openStore(dir);assert.deepEqual(store.state().buyPlans,[plan]);
  store.reset(store.state().revision);assert.deepEqual(store.state().buyPlans,[]);
});
