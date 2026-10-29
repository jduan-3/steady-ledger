import test from 'node:test';
import assert from 'node:assert/strict';
import { stockDetails } from '../src/instrument-details.mjs';

const now=new Date('2026-10-24T08:00:00Z');
function fixture(){const kv=new Map();return {getKV:key=>kv.get(key),setKV:(key,value)=>kv.set(key,value)};}
const snapshot=(metrics={})=>({details:{key:'HK.00700',time:'2026-10-23 16:08:00',equityValid:true,metrics:{pe_ttm_ratio:18.5,dividend_ttm:4.5,dividend_ratio_ttm:1.2,total_market_val:3000000000,...metrics}}});

test('股票资料保留 TTM 和上一财年口径、原币种及真实零值，缺值不变成零',async()=>{
  const store=fixture(),result=await stockDetails(store,'HK.00700',{now,provider:async input=>{assert.deepEqual(input,{action:'details',keys:['HK.00700']});return snapshot({pe_ratio:-2,dividend_lfy:0,pb_ratio:null,earning_per_share:NaN,dividend_lfy_ratio:-1});}});
  assert.equal(result.status,'available');assert.equal(result.currency,'HKD');assert.equal(result.timeZone,'Asia/Hong_Kong');
  assert.equal(result.metrics.peTTM,18.5);assert.equal(result.metrics.pe,-2);assert.equal(result.metrics.dividendYieldTTM,1.2);assert.equal(result.metrics.dividendLFY,0);assert.equal(result.metrics.pb,null);assert.equal(result.metrics.eps,null);assert.equal(result.metrics.dividendYieldLFY,null);
});
test('基础资料请求共用任务与缓存，不触碰持仓估值；过期后失败保留有日期的记录',async()=>{
  const store=fixture();let finish,calls=0;
  const provider=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const first=stockDetails(store,'HK.00700',{now,provider}),second=stockDetails(store,'HK.00700',{now,provider});
  finish(snapshot());const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(calls,1);
  assert.equal((await stockDetails(store,'HK.00700',{now,provider})).metrics.peTTM,18.5);assert.equal(calls,1);
  const failure=await stockDetails(store,'HK.00700',{now:new Date(now.getTime()+31*60000),provider:async()=>{throw new Error('offline');}});
  assert.equal(failure.status,'cached');assert.equal(failure.time,'2026-10-23 16:08:00');assert.match(failure.message,/保留上次/);
});
test('拒绝错股、未来日期、非正股和全缺指标，失败可以重试',async()=>{
  for(const patch of [{key:'US.GOOG'},{time:'2026-10-26 16:00:00'},{equityValid:false},{metrics:{}}]) {
    const result=await stockDetails(fixture(),'HK.00700',{now,provider:async()=>({details:{...snapshot().details,...patch}})});
    assert.equal(result.status,'unavailable');assert.equal(result.metrics,undefined);
  }
  const store=fixture();await stockDetails(store,'HK.00700',{now,provider:async()=>{throw new Error();}});
  assert.equal((await stockDetails(store,'HK.00700',{now,provider:async()=>snapshot()})).status,'available');
});
test('美股快照的毫秒时间被正常读取，时区和美元金额不变',async()=>{
  const result=await stockDetails(fixture(),'US.GOOG',{now,provider:async()=>({details:{...snapshot().details,key:'US.GOOG',time:'2026-10-23 20:02:13.343'}})});
  assert.equal(result.status,'available');assert.equal(result.time,'2026-10-23 20:02:13');assert.equal(result.currency,'USD');assert.equal(result.timeZone,'America/New_York');
});
