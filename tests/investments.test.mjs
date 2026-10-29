import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { validateState,initialState,nowDate,parseCSV } from '../src/domain.mjs';
import { inferredCostBasis } from '../src/investments.mjs';

const asset=()=>({id:'f',name:'Synthetic fund',type:'fund',currency:'CNY',value:100,quantity:50,unit:'份',asOf:'2026-10-23',fund:{code:'123456',autoNav:true},reported:{date:'2026-10-23',value:100,unrealized:20,dividends:5}});
test('valuation date defaults to the local record date; valid old dates remain unchanged; CSV does not require dates',()=>{
 const s=initialState();s.assets=[{...asset(),asOf:''}];assert.equal(validateState(s).assets[0].asOf,nowDate());s.assets[0].asOf='2026-10-23';assert.equal(validateState(s).assets[0].asOf,'2026-10-23');
 assert.equal(parseCSV('name,type,currency,value\nSynthetic,cash,CNY,100\n').length,1);
});
test('infer cost only from matching reported value and floating P/L, never total return or an extra quantity',()=>{
 const a=asset();assert.equal(inferredCostBasis(a).amount,80);assert.equal(inferredCostBasis({...a,value:150}),null);assert.equal(inferredCostBasis({...a,asOf:'2026-10-24'}),null);assert.equal(inferredCostBasis({...a,costBasis:null}),null);
});
test('future NAV changes floating P/L without changing the inferred cost; changed units require a cost matching the new quantity',t=>{
 const dir=mkdtempSync(join(tmpdir(),'steady-cost-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const s=store.state();s.assets=[asset()];store.save(s,s.revision);store.setKV('fund_nav:123456',{price:3,date:'2026-10-24',currency:'CNY'});
 let a=store.state().assets[0];assert.equal(a.costBasis.amount,80);assert.equal(a.investment.profit,70);assert.equal(a.investment.averageCost,1.6);
 const next=store.state();next.assets[0].quantity=100;store.save(next,next.revision);a=store.state().assets[0];assert.equal(a.investment.profit,null);assert.equal(a.investment.status,'quantity_changed');
 const confirmed=store.state();confirmed.assets[0].costBasis={amount:200,quantity:100,currency:'CNY'};store.save(confirmed,confirmed.revision);assert.equal(store.state().assets[0].investment.profit,100);
});
test('cost currency and negative cost are rejected; a zero cost does not create an infinite return',()=>{
 const s=initialState();s.assets=[{...asset(),costBasis:{amount:80,quantity:50,currency:'USD'}}];assert.throws(()=>validateState(s),/币种/);s.assets[0].costBasis={amount:-1,quantity:50,currency:'CNY'};assert.throws(()=>validateState(s),/成本/);
});

test('new automatic fund uses the latest disclosed NAV even if entered after a weekend, without inventing a purchase date',t=>{
 const dir=mkdtempSync(join(tmpdir(),'steady-fund-date-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const s=store.state();s.assets=[{id:'new',name:'Synthetic',type:'fund',currency:'CNY',quantity:100,unit:'份',value:null,fund:{code:'123456',autoNav:true}}];store.save(s,s.revision);
 store.setKV('fund_nav:123456',{price:2,date:'2026-10-23',currency:'CNY'});const a=store.state().assets[0];assert.equal(a.value,200);assert.equal(a.asOf,'2026-10-23');assert.equal(a.investment.profit,null);
});
