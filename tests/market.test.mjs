import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { validateState,initialState,calculate } from '../src/domain.mjs';
import { security } from '../src/securities.mjs';
import { searchSecurities,refreshStocks,stockQuote } from '../src/market.mjs';
import { priceMovement } from '../src/valuation.mjs';
import { parseTencentQuote, searchTencent } from '../src/tencent.mjs';

const now=new Date('2026-10-24T08:00:00Z');
function setup(t){const dir=mkdtempSync(join(tmpdir(),'steady-stock-')),s=openStore(dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
const raw=(key='SH.601318',price=11,previous=10,time='2026-10-23 15:00:00')=>({key,price,previous:{price:previous},time});
function holding(store,key='SH.601318'){
 const [market,symbol]=key.split('.'),s=security({market,symbol}),state=store.state();
 state.assets=[{id:'synthetic',name:'Synthetic stock',type:'stock',security:s,autoPrice:true,quantity:100,unit:'股',currency:s.currency,value:900,asOf:'2026-10-22'}];store.save(state,state.revision);
}

test('Chinese names and stock codes resolve exact A/H identities from search, and survive a source outage',async t=>{
 const s=setup(t);let query;
 const r=await searchSecurities(s,'中国平安','ALL',{searchProvider:async q=>{query=q;return [{...security({market:'SH',symbol:'601318'}),name:q},{...security({market:'HK',symbol:'02318'}),name:q}];}});
 assert.equal(query,'中国平安');assert.deepEqual(r.items.map(x=>x.key),['SH.601318','HK.02318']);
 const offline=await searchSecurities(s,'中国平安','SH',{searchProvider:async()=>{throw new Error();},provider:async()=>{throw new Error();},now});
 assert.equal(offline.items.length,1);assert.equal(offline.items[0].key,'SH.601318');assert.equal((await searchSecurities(s,'601318','ALL',{provider:async()=>({catalog:[]}),now})).items[0].key,'SH.601318');
});

test('Tencent search parses escaped Unicode as data and canonicalizes US listing suffixes',async()=>{
 const result=await searchTencent('test',{fetchImpl:async()=>({ok:true,arrayBuffer:async()=>new TextEncoder().encode('v_hint="sh~601318~\\u4e2d\\u56fd\\u5e73\\u5b89~zgpa~GP-A^us~aapl.oq~Apple~pg~GP"').buffer})});
 assert.equal(result[0].name,'中国平安');assert.equal(result[1].key,'US.AAPL');
});

test('snapshot parser checks identity and normalizes each markets timestamp without executing returned scripts',()=>{
 const fixtures=[['SH.601318','sh601318','601318','20261023150000'],['HK.02318','hk02318','02318','2026/10/23 16:08:00'],['US.AAPL','usAAPL','AAPL.OQ','2026-10-23 16:00:00']];
 for(const [key,callback,code,time] of fixtures){const f=Array(33).fill('');f[2]=code;f[3]='11';f[4]='10';f[30]=time;const q=stockQuote(parseTencentQuote('v_'+callback+'="'+f.join('~')+'";',key),now);assert.equal(q.key,key);assert.equal(priceMovement(q,100).percent,10);}
 assert.throws(()=>parseTencentQuote('v_sh600000=""','SH.601318'));
 assert.throws(()=>stockQuote(raw('SH.601318',0),now));assert.throws(()=>stockQuote(raw('SH.601318',10,9,'2026-10-25 15:00:00'),now));
 assert.throws(()=>stockQuote(raw('SH.601318',10,9,'2026-10-23 29:00:00'),now));
});

test('OpenD failure automatically uses the second source and records the last trading day during a weekend',async t=>{
 const s=setup(t);holding(s);const revision=s.state().revision;
 const result=await refreshStocks(s,{now,provider:async()=>{throw new Error();},fallback:async keys=>keys.map(k=>({...raw(k),source:'腾讯证券公开行情'}))});
 assert.equal(result.updated,1);assert.deepEqual(result.errors,[]);const a=s.state().assets[0];assert.equal(a.value,1100);assert.equal(a.asOf,'2026-10-23');assert.equal(a.movement.amount,100);assert.equal(a.valuation.source,'腾讯证券公开行情');assert.equal(s.state().revision,revision);assert.equal(calculate(s.state()).complete,true);
 assert.equal(s.priceHistory('SH.601318').length,1);assert.equal(s.state({raw:true}).assets[0].value,900);
});

test('choose the fresher valid source, reject invalid prices, and preserve existing value when all feeds fail',async t=>{
 const s=setup(t);holding(s);
 await refreshStocks(s,{now,provider:async()=>({quotes:[raw('SH.601318',11,10,'2026-10-23 14:00:00')]}),fallback:async()=>[{...raw('SH.601318',12),source:'腾讯证券公开行情'}]});
 assert.equal(s.state().assets[0].value,1200);
 const state=s.state();state.profile.income=123;state.assets[0].quantity=200;s.save(state,state.revision);assert.equal(s.state().assets[0].value,2400);
 assert.equal(s.state({raw:true}).assets[0].value,null);
 await refreshStocks(s,{now,force:true,provider:async()=>({quotes:[raw('SH.601318',0)]}),fallback:async()=>[raw('SH.601318',13)]});assert.equal(s.state().assets[0].value,2600);
 await refreshStocks(s,{now,force:true,provider:async()=>{throw new Error();},fallback:async()=>{throw new Error();}});
 assert.equal(s.state().assets[0].value,2600);assert.equal(s.state().assets[0].valuation.status,'pending');assert.equal(calculate(s.state()).complete,false);assert.equal(s.priceHistory('SH.601318').length,1);
});

test('daily price records are persisted per instrument and date, and do not invent percentage changes',t=>{
 const s=setup(t);s.recordPrice('FUND.123456',{date:'2026-10-22',price:1,currency:'CNY'});s.recordPrice('FUND.123456',{date:'2026-10-23',price:1.1,previous:{price:1},currency:'CNY'});s.recordPrice('FUND.123456',{date:'2026-10-23',price:1.2,currency:'CNY'});
 const h=s.priceHistory('FUND.123456');assert.equal(h.length,2);assert.ok(Math.abs(priceMovement(h[0],100).percent-20)<1e-8);assert.equal(priceMovement(h[1],100),null);
 assert.throws(()=>s.recordPrice('FUND.123456',{date:'2099-01-01',price:1}));assert.throws(()=>s.recordPrice('FUND.123456',{date:'2026-10-23',price:0}));
});

test('A/H currencies, RMB counters, stock units and identity are validated separately',()=>{
 assert.equal(security({market:'HK',symbol:'2318'}).currency,'HKD');assert.equal(security({market:'HK',symbol:'82318'}).currency,'CNY');
 const s=initialState();s.assets=[{id:'x',name:'Synthetic',type:'stock',security:{market:'HK',symbol:'02318'},autoPrice:true,currency:'HKD',value:null,quantity:100,unit:'股',asOf:'2026-10-23'}];assert.equal(validateState(s).assets[0].value,null);
 for(const bad of [{currency:'CNY'},{unit:'份'},{quantity:null},{security:null}])assert.throws(()=>validateState({...s,assets:[{...s.assets[0],...bad}]}));
 assert.equal(priceMovement({price:10,previous:{price:0}},100),null);
});

test('US class-share symbols preserve their dot when resolving a quote',()=>{
 const q=stockQuote(raw('US.BRK.B'),now);assert.equal(q.symbol,'BRK.B');assert.equal(q.key,'US.BRK.B');
});
