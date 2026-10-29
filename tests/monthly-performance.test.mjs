import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { parseNasdaqMonthly, calculateMonthlyPerformance, monthlyPerformance, refreshMonthlyPerformance, NASDAQ_MONTHLY_CACHE } from '../src/monthly-performance.mjs';
import { monthlyPageHTML } from '../public/monthly-performance.js';
import { buildAssistantData, readAssistantPage } from '../src/assistant-data.mjs';
const now=new Date('2026-10-29T08:00:00Z');
const wire=rows=>({code:0,data:{'us.IXIC':{month:rows.map(([date,close])=>[date,'100',String(close)])}}});
const input=wire([['2023-12-29',100],['2024-01-31',110],['2024-02-29',110],['2024-03-28',121],['2024-12-31',100],['2025-01-31',90],['2025-02-28',99],['2025-03-31',99],['2025-12-31',100],['2026-01-30',100],['2026-02-27',80],['2026-09-30',100],['2026-10-28',110]]);
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'steady-monthly-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('three calendar years use the preceding December, and statistics preserve zero with correct denominators and medians',()=>{
  const view=calculateMonthlyPerformance(parseNasdaqMonthly(input,now),now);
  assert.deepEqual(view.years,[2026,2025,2024]);assert.equal(view.rows.length,3);assert.ok(view.rows.every(r=>r.months.length===12));
  const jan=view.statistics[0];assert.equal(jan.samples,3);near(jan.upRate,100/3);near(jan.median,0);near(jan.average,0);
  assert.equal(jan.best.period,'2024-01');near(jan.best.percent,10);assert.equal(jan.worst.period,'2025-01');near(jan.worst.percent,-10);
  near(view.statistics[1].median,0);near(view.statistics[1].average,-10/3);near(view.statistics[2].median,5);
  assert.equal(view.rows[0].months[9].status,'partial');near(view.rows[0].months[9].percent,10);assert.equal(view.statistics[9].samples,0);
  assert.equal(view.rows[0].months[10].status,'future');assert.equal(view.rows[0].months[10].percent,null);
  assert.equal(view.rows[1].months[11].percent,null);assert.equal(view.rows[1].months[11].status,'missing');
});
test('monthly parser validates identity, duplicates, dates and positive prices without fabricating missing months',()=>{
  assert.throws(()=>parseNasdaqMonthly({code:0,data:{'us.QQQ':{month:[]}}},now));
  assert.throws(()=>parseNasdaqMonthly(wire([['2024-01-30',100],['2024-01-31',110]]),now));
  const points=parseNasdaqMonthly(wire([['2024-01-31',100],['2024-02-30',120],['2024-02-29',0],['2024-03-28',121],['2026-11-30',130]]),now);
  assert.deepEqual(points.map(p=>p.period),['2024-01','2024-03']);
  assert.equal(calculateMonthlyPerformance(points,now).rows[2].months[2].percent,null);
  assert.throws(()=>parseNasdaqMonthly(wire([['2024-01-31',NaN]]),now));
});
test('New York determines year boundaries; cached partial months never become finished just because time passed',()=>{
  const before=new Date('2026-01-01T02:00:00Z'),after=new Date('2026-01-01T06:00:00Z');
  const points=parseNasdaqMonthly(wire([['2025-11-28',100],['2025-12-31',110]]),before);
  assert.equal(calculateMonthlyPerformance(points,before).currentMonth,'2025-12');
  const view=calculateMonthlyPerformance(points,after);assert.deepEqual(view.years,[2026,2025,2024]);
  assert.equal(view.rows[1].months[11].status,'pending');assert.equal(view.statistics[11].samples,0);
});
test('refresh shares in-flight work, caches public data, retries failed updates and leaves ledger revision unchanged',async t=>{
  const store=fixture(t),revision=store.state().revision;let calls=0;
  const fetchImpl=async()=>{calls++;return Response.json(input);};
  const a=refreshMonthlyPerformance(store,{fetchImpl,now}),b=refreshMonthlyPerformance(store,{fetchImpl,now});assert.equal(a,b);await a;
  assert.equal(calls,1);assert.equal(store.state().revision,revision);assert.equal(monthlyPerformance(store,now).completedSamples,8);
  await refreshMonthlyPerformance(store,{fetchImpl,now});assert.equal(calls,1);
  const failed=await refreshMonthlyPerformance(store,{fetchImpl:async()=>{throw new Error('offline');},now,force:true});
  assert.match(failed.error,/保留上次数据/);assert.equal(failed.updatedAt,now.toISOString());assert.equal(failed.rows[2].months[0].date,'2024-01-31');
  await refreshMonthlyPerformance(store,{fetchImpl,now:new Date(now.getTime()+61000)});assert.equal(calls,2);assert.equal(store.getKV(NASDAQ_MONTHLY_CACHE).error,null);
  await refreshMonthlyPerformance(store,{fetchImpl:async()=>Response.json(wire([['2025-12-31',100]])),now,force:true});
  assert.equal(store.getKV(NASDAQ_MONTHLY_CACHE).points.at(-1).date,'2026-10-28');
});
test('a new month bypasses the cache interval, and failed refresh retains provisional status',async t=>{
  const store=fixture(t),before=new Date('2026-10-31T23:00:00Z');
  await refreshMonthlyPerformance(store,{fetchImpl:async()=>Response.json(input),now:before});
  const view=await refreshMonthlyPerformance(store,{fetchImpl:async()=>{throw new Error('offline');},now:new Date('2026-11-01T05:00:00Z')});
  assert.ok(view.error);assert.equal(view.rows[0].months[9].status,'pending');assert.equal(view.statistics[9].samples,0);
});
test('page shows signed values, provisional and missing cells, selectable close details, source errors and empty states',t=>{
  const store=fixture(t);store.setKV(NASDAQ_MONTHLY_CACHE,{points:parseNasdaqMonthly(input,now)});
  const view=monthlyPerformance(store,now),html=monthlyPageHTML(view,{selectedPeriod:'2024-01'});
  assert.match(html,/近 3 年/);assert.match(html,/2024 — 2026/);assert.match(html,/本月暂计/);assert.match(html,/−10.00%/);assert.match(html,/monthly-empty/);assert.match(html,/monthly-future/);
  assert.match(html,/2023-12-29 100.00 → 2024-01-31 110.00/);assert.match(html,/aria-pressed="true"/);assert.match(html,/2024-01<\/span>/);
  assert.match(monthlyPageHTML(null,{loading:true}),/正在读取纳指月线/);
  assert.match(monthlyPageHTML(view,{error:'<img src=x>'}),/&lt;img src=x&gt;/);
});
test('authorized assistant page data includes the same monthly observations and statistics',t=>{
  const store=fixture(t);store.setKV(NASDAQ_MONTHLY_CACHE,{points:parseNasdaqMonthly(input,now)});
  const snapshot=buildAssistantData(store),result=readAssistantPage(snapshot,{page:'us-monthly',section:'statistics'});
  assert.equal(result.data[0].samples,3);near(result.data[0].average,0);assert.equal(snapshot.pages['us-monthly'].rows.length,3);
});
