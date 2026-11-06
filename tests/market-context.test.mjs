import test from 'node:test';
import assert from 'node:assert/strict';
import {parseContextCSV,refreshMarketContext,marketContext,activityReading} from '../src/market-context.mjs';
const now=new Date('2026-10-28T03:00:00Z');
test('宏观数据跳过空值、未来日期和无效日期，保留负利差及真实零值',()=>{
  const rows=parseContextCSV('observation_date,T10Y2Y\n2026-10-23,-0.4\n2026-10-26,\n2026-10-27,0\n2026-10-29,9\n2026-02-30,5','T10Y2Y',now);
  assert.deepEqual(rows,[{date:'2026-10-23',value:-.4},{date:'2026-10-27',value:0}]);
  assert.throws(()=>parseContextCSV('wrong,DGS10\n2026-10-27,4','DGS10',now));
  assert.throws(()=>parseContextCSV('observation_date,DGS10\n2026-10-27,','DGS10',now));
  assert.equal(parseContextCSV('Date,OFR FSI,Credit\n2026-10-26,-1.2,0','OFR FSI',now,'Date')[0].value,-1.2);
});
test('外部源分开缓存与重试，单一来源失败不丢弃其他来源，保留原始观测日',async()=>{
  let calls=0;
  const fetchImpl=async url=>{calls++;assert.ok(!url.includes('hkma'));
    if(url.includes('financialresearch'))return new Response('Date,OFR FSI\n2026-10-26,-.5');
    const id=new URL(url).searchParams.get('id');return new Response(`observation_date,${id}\n2026-10-23,4\n2026-10-26,4.2`);};
  const first=await refreshMarketContext({}, {fetchImpl,now});assert.equal(calls,5);
  assert.equal(marketContext(first,'US',now).find(r=>r.key==='DGS10').change,.20000000000000018);
  assert.deepEqual(marketContext(first,'HK',now),[]);
  const stale=marketContext({DGS2:{history:[{date:'2026-09-30',value:4}],error:'更新失败'}},'US',now)[0];assert.equal(stale.status,'lagged');assert.equal(stale.lagDays,27);
  await refreshMarketContext(first,{fetchImpl,now:new Date(now.getTime()+60000)});assert.equal(calls,5);
  const later=new Date(now.getTime()+5*3600000),failed=await refreshMarketContext(first,{fetchImpl:async()=>{throw new Error();},now:later});
  const view=marketContext(failed,'US',later);assert.equal(view[0].status,'cached');assert.equal(view[0].date,'2026-10-26');assert.equal(view[0].value,4.2);
  let retries=0;await refreshMarketContext(failed,{fetchImpl:async()=>{retries++;throw new Error();},now:new Date(later.getTime()+60000)});assert.equal(retries,0);
});
test('成交量比仅用最近完整收盘与此前20天，不混入盘中，不跳过缺量日',()=>{
  const history=Array.from({length:21},(_,i)=>({date:new Date(Date.UTC(2026,8,i+1)).toISOString().slice(0,10),volume:i===20?200:100}));
  const series={key:'US.SPY',name:'SPY',market:'US',history,latest:{date:'2026-09-22',volume:50}};
  let row=activityReading(series);assert.equal(row.relativeVolume,2);assert.equal(row.closed.date,'2026-09-21');assert.equal(row.latest.volume,50);assert.equal(row.baselineCount,20);
  history[5].volume=null;assert.equal(activityReading(series).relativeVolume,null);
  history[5].volume=100;history.at(-1).volume=0;assert.equal(activityReading(series).relativeVolume,0);
  series.history=history.slice(1);assert.equal(activityReading(series).relativeVolume,null);
});
test('手动更新可重试失败或已缓存的宏观来源，仍限制一分钟内的重复请求',async()=>{
  const keys=['DGS2','DGS10','T10Y2Y','BAMLH0A0HYM2','OFR'];
  const cached=Object.fromEntries(keys.map((key,i)=>[key,{history:[{date:'2026-10-26',value:4}],attemptedAt:new Date(now.getTime()-10*60000).toISOString(),updatedAt:new Date(now.getTime()-3600000).toISOString(),error:i%2?'本次未取得新数据':null}]));
  let calls=0;
  const fetchImpl=async url=>{calls++;const key=new URL(url).searchParams.get('id');return new Response(key?`observation_date,${key}\n2026-10-27,4.2`:'Date,OFR FSI\n2026-10-26,-.5');};
  await refreshMarketContext(cached,{fetchImpl,now});assert.equal(calls,0);
  const restored=await refreshMarketContext(cached,{fetchImpl,now,force:true});assert.equal(calls,5);
  for(const key of keys){assert.equal(restored[key].error,null);assert.equal(restored[key].updatedAt,now.toISOString());}
  assert.equal(marketContext(restored,'US',now)[0].status,'available');
  assert.equal(marketContext(restored,'US',now)[0].date,'2026-10-27');
  await refreshMarketContext(restored,{fetchImpl,now:new Date(now.getTime()+59999),force:true});assert.equal(calls,5);
  await refreshMarketContext(restored,{fetchImpl,now:new Date(now.getTime()+60000),force:true});assert.equal(calls,10);
  const failed=await refreshMarketContext(restored,{fetchImpl:async()=>{throw new Error('Connection reset');},now:new Date(now.getTime()+60000),force:true});
  for(const key of keys){assert.deepEqual(failed[key].history,restored[key].history);assert.equal(failed[key].updatedAt,restored[key].updatedAt);assert.ok(failed[key].error);}
});
