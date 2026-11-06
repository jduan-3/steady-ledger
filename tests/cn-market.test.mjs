import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { createApplication } from '../src/server.mjs';
import { CN_BENCHMARKS, WATCHED_ETFS, parseETFFlows, parseSSEShares, parseSZSEShares, etfDailyReading, refreshCNMarket, cnMarketOverview } from '../src/cn-market.mjs';
import { cnMarketPageHTML, etfFlowsPageHTML } from '../public/cn-market.js';
import { buildAssistantData, automaticPageContext, readAssistantPage } from '../src/assistant-data.mjs';

const now=new Date('2026-11-04T02:00:00Z');
const epoch=Math.floor(new Date('2026-11-04T01:59:00Z').getTime()/1000);
function em(){return {rc:0,data:{diff:WATCHED_ETFS.map(d=>({f12:d.key.slice(3),f13:d.key.startsWith('SH.')?1:0,f2:4,f3:1,f6:1e9,f62:0,f66:-1e7,f124:epoch,f297:20261104}))}};}
function sse(date){return {result:WATCHED_ETFS.filter(d=>d.key.startsWith('SH.')).map(d=>({SEC_CODE:d.key.slice(3),STAT_DATE:date,TOT_VOL:date==='2026-11-03'?'1,500':'1,000'}))};}
function szse(){return [{metadata:{catalogid:'fund_jjgm',cols:{current_size:'基金规模<br>(万份)'}},data:[
 {fund_code:'159919',size_date:'2026-11-04',current_size:'9,999'},
 {fund_code:'159919',size_date:'2026-11-03',current_size:'1,500'},
 {fund_code:'159919',size_date:'2026-11-02',current_size:'1,000'}
]}];}
function quoteWire(){return [...CN_BENCHMARKS,...WATCHED_ETFS].map(d=>{const f=Array(40).fill('');f[2]=d.key.slice(3);f[3]='4';f[4]='3.9';f[5]='3.9';f[6]='100';f[30]='20261104095900';f[33]='4.1';f[34]='3.8';f[37]='40';return `v_${d.key.slice(0,2).toLowerCase()+d.key.slice(3)}="${f.join('~')}";`;}).join('');}
function fixtureFetch(url){
 const u=new URL(url);
 if(u.hostname==='push2delay.eastmoney.com')return Promise.resolve(Response.json(em()));
 if(u.hostname==='qt.gtimg.cn')return Promise.resolve(new Response(quoteWire()));
 if(u.hostname==='web.ifzq.gtimg.cn'){
  const code=u.searchParams.get('param').split(',')[0];
  return Promise.resolve(Response.json({code:0,data:{[code]:{day:[['2026-10-30','4','4','4','4','100'],['2026-11-02','4','4','4','4','100'],['2026-11-03','4','4.1','4.1','4','100'],['2026-11-04','4','4','4','4','100']]}}}));
 }
 if(u.hostname==='query.sse.com.cn')return Promise.resolve(Response.json(sse(u.searchParams.get('STAT_DATE'))));
 if(u.hostname==='fund.szse.cn')return Promise.resolve(Response.json(szse()));
 throw new Error('Unexpected source '+u.hostname);
}
function setup(t){const dir=mkdtempSync(join(tmpdir(),'steady-cn-market-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}

test('ETF flows validate identity and source time, preserving zero and leaving missing metrics null',()=>{
 const input=em(),first=input.data.diff[0];
 first.f62='-';assert.equal(parseETFFlows(input,now)[0].flow.mainNet,null);
 first.f62=0;assert.equal(parseETFFlows(input,now)[0].flow.mainNet,0);
 first.f66='';assert.equal(parseETFFlows(input,now)[0].flow.superNet,null);
 first.f13=0;assert.equal(parseETFFlows(input,now).length,5);
 const sz=em();sz.data.diff[3].f13=null;assert.equal(parseETFFlows(sz,now).length,5);
 first.f13=1;first.f297=20261103;assert.equal(parseETFFlows(input,now).length,5);
 first.f297=20261104;first.f124=epoch+3600;assert.equal(parseETFFlows(input,now).length,5);
 assert.throws(()=>parseETFFlows({rc:0,data:null},now));
});
test('exchange share units and actual dates are checked; provisional SZ figures are excluded',()=>{
 assert.equal(parseSSEShares(sse('2026-11-03'),'2026-11-03',now)[0].shares,15000000);
 assert.deepEqual(parseSSEShares({result:[]},'2026-11-04',now),[]);
 const wrong=sse('2026-11-03');wrong.result[0].STAT_DATE='2026-11-02';assert.throws(()=>parseSSEShares(wrong,'2026-11-03',now));
 wrong.result.shift();assert.throws(()=>parseSSEShares(wrong,'2026-11-03',now));
 assert.deepEqual(parseSZSEShares(szse(),now).map(r=>[r.date,r.shares]),[['2026-11-03',15000000],['2026-11-02',10000000]]);
 const missing=szse();missing[0].data[1].current_size=null;assert.throws(()=>parseSZSEShares(missing,now));
 const units=szse();units[0].metadata.cols.current_size='份';assert.throws(()=>parseSZSEShares(units,now));
});
test('daily net subscriptions use matching close and immediately previous trading session, with no gap inference',()=>{
 const shares=[{date:'2026-10-30',shares:100},{date:'2026-11-03',shares:150}],closes=[{date:'2026-10-30',price:2},{date:'2026-11-02',price:3},{date:'2026-11-03',price:4}];
 assert.equal(etfDailyReading(shares,closes).delta,null);
 shares.splice(1,0,{date:'2026-11-02',shares:120});
 assert.equal(etfDailyReading(shares,closes).estimatedNet,120);
 assert.equal(etfDailyReading(shares,closes).previousDate,'2026-11-02');
 assert.equal(etfDailyReading(shares,closes.slice(0,-1)).estimatedNet,null);
 shares[2].shares=120;assert.equal(etfDailyReading(shares,closes).estimatedNet,0);
});
test('refresh batches public sources, deduplicates requests, caches by cadence and preserves the ledger',async t=>{
 const store=setup(t),before=store.state({raw:true}),urls=[];
 const options={now,fetchImpl:async(url,opts)=>{urls.push(url);assert.equal(opts.headers.Cookie,undefined);assert.equal(opts.headers.Authorization,undefined);return fixtureFetch(url);}};
 const pending=refreshCNMarket(store,options);assert.equal(refreshCNMarket(store,options),pending);
 let view=await pending;
 assert.equal(view.benchmarks.filter(i=>i.quote).length,4);assert.equal(view.items.length,6);
 assert.equal(view.summary.mainNet,0);assert.equal(view.summary.dailyDate,'2026-11-03');
 assert.equal(view.items[0].daily.delta,5000000);assert.equal(view.items[0].daily.estimatedNet,20500000);
 assert.equal(view.items[3].daily.date,'2026-11-03');assert.deepEqual(view.errors,{});
 const count=urls.length;await refreshCNMarket(store,{...options,now:new Date(now.getTime()+59999)});assert.equal(urls.length,count);
 await refreshCNMarket(store,{...options,now:new Date(now.getTime()+60000)});assert.equal(urls.length,count+2);
 assert.deepEqual(store.state({raw:true}),before);
 const snapshot=buildAssistantData(store),context=automaticPageContext(snapshot);
 assert.equal(context.directory.find(d=>d.page==='cn-market').name,'沪深市场');
 assert.equal(readAssistantPage(snapshot,{page:'cn-etf',section:'items'}).data.length,6);
 assert.match(snapshot.pages['cn-etf'].notice,/不代表国家队/);
 const cached=store.getKV('cn_market_snapshot');
 view=await refreshCNMarket(store,{now:new Date(now.getTime()+3600000),fetchImpl:async()=>{throw new Error('Offline');}});
 assert.deepEqual(store.getKV('cn_market_snapshot').quotes,cached.quotes);assert.deepEqual(store.getKV('cn_market_snapshot').shares,cached.shares);
 assert.equal(view.items[0].flow.time,'2026-11-04 09:59:00');assert.match(view.errors.flows,/保留/);
 assert.deepEqual(store.state({raw:true}),before);
});
test('same-date complete coverage is required for sums, and the UI labels unknown values and cached source dates',async t=>{
 const store=setup(t);await refreshCNMarket(store,{now,fetchImpl:fixtureFetch});
 let view=cnMarketOverview(store,now),html=etfFlowsPageHTML(view);
 assert.match(html,/不能据此确认汇金/);assert.match(html,/逐单估算/);assert.match(html,/2026-11-03/);assert.match(html,/2026-11-04 09:59:00/);assert.match(html,/0\.00 亿/);assert.ok(!/NaN|Infinity|undefined/.test(html));
 const cache=store.getKV('cn_market_snapshot');cache.flows['SZ.159919'].date='2026-11-03';cache.shares['SZ.159919']=[];store.setKV('cn_market_snapshot',cache);
 view=cnMarketOverview(store,now);assert.equal(view.summary.mainNet,null);assert.equal(view.summary.estimatedNet,null);
 html=etfFlowsPageHTML(view,{error:'<img src=x onerror=alert(1)>'});assert.match(html,/&lt;img/);assert.ok(!html.includes('<img'));
 assert.match(cnMarketPageHTML(view),/上证指数/);assert.match(cnMarketPageHTML(view),/href="#cn-etf"/);
});
test('CN market API and refresh require login and public components remain local',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'steady-cn-http-')),app=createApplication({dataDir:dir,disableAuth:false,schedule:false});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 for(const [path,method] of [['/api/markets/cn','GET'],['/api/markets/cn/refresh','POST']])assert.equal((await fetch(base+path,{method,headers:{'Content-Type':'application/json'}})).status,401);
 const login=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-cn-test-password'})}),cookie=login.headers.get('set-cookie').split(';')[0];
 app.store.setKV('cn_market_snapshot',{attemptedAt:new Date().toISOString()});const before=app.store.state({raw:true});
 for(const [path,method] of [['/api/markets/cn','GET'],['/api/markets/cn/refresh','POST']]){const r=await fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'}});assert.equal(r.status,200);assert.equal((await r.json()).items.length,6);}
 const component=await fetch(base+'/cn-market.js');assert.equal(component.status,200);assert.match(await component.text(),/etfFlowsPageHTML/);
 assert.deepEqual(app.store.state({raw:true}),before);
});
