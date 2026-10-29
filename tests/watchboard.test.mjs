import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { WATCH_GROUPS,WATCH_INSTRUMENTS,WATCH_CACHE,normalizeWatchQuote,parseWatchHistory,watchboard,refreshWatchboard } from '../src/watchboard.mjs';
import { watchboardPageHTML,watchboardGroupsHTML,watchboardQuoteHTML,watchboardCopyText } from '../public/watchboard.js';
import { watchboardLogos } from '../public/watchboard-logos.js';
import { buildAssistantData,automaticPageContext,readAssistantPage } from '../src/assistant-data.mjs';
const now=new Date('2026-10-29T14:00:00Z');
const raw=(key,time='2026-10-28 16:00:01',price=110,previous=100)=>({key,time,price,previous:{price:previous},historyCode:'us'+key.slice(3)+'.OQ',source:'Synthetic quote'});
const provider=async keys=>keys.map(k=>raw(k));
const history=(key,rows)=>({code:0,data:{['us'+key.slice(3)+'.OQ']:{day:rows.map(([d,p])=>[d,'100',String(p)])}}});
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'steady-watchboard-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
test('watch groups resolve to distinct US-listed quote keys, ETF labels are retained, and local brand assets have a license',()=>{
  assert.equal(WATCH_GROUPS.length,7);assert.equal(new Set(WATCH_INSTRUMENTS.map(i=>i.key)).size,WATCH_INSTRUMENTS.length);
  for(const g of WATCH_GROUPS)for(const k of g.keys)assert.ok(WATCH_INSTRUMENTS.some(i=>i.key===k));
  assert.equal(WATCH_INSTRUMENTS.find(i=>i.symbol==='SOXL').kind,'etf');
  assert.ok(!WATCH_INSTRUMENTS.some(i=>i.symbol==='SPACEX'));
  for(const slug of Object.values(watchboardLogos))assert.ok(existsSync(new URL('../public/logos/'+slug+'.svg',import.meta.url)));
  assert.match(readFileSync(new URL('../public/logos/LICENSE.txt',import.meta.url),'utf8'),/Simple Icons/);
});
test('quote validation keeps missing previous closes unknown and rejects future dates or wrong instruments',()=>{
  assert.equal(normalizeWatchQuote(raw('US.MSFT',undefined,110,0),now).percent,null);
  assert.equal(normalizeWatchQuote(raw('US.MSFT',undefined,100,100),now).percent,0);
  for(const q of [raw('US.UNKNOWN'),raw('HK.00700'),raw('US.MSFT','2026-10-30 16:00:01'),raw('US.MSFT',undefined,0)])assert.throws(()=>normalizeWatchQuote(q,now));
});
test('close history excludes intraday bars and respects half-day close plus settlement delay',()=>{
  const h=history('US.MSFT',[['2026-10-27',100],['2026-10-28',108],['2026-10-29',121]]);
  let q=parseWatchHistory(h,'US.MSFT',now);assert.equal(q.date,'2026-10-28');assert.ok(Math.abs(q.percent-8)<1e-9);
  q=parseWatchHistory(h,'US.MSFT',new Date('2026-10-29T20:14:00Z'));assert.equal(q.date,'2026-10-28');
  q=parseWatchHistory(h,'US.MSFT',new Date('2026-10-29T20:15:00Z'));assert.equal(q.date,'2026-10-29');
  const half={US:[{time:'2026-11-27',trade_date_type:'HALF'}]},bar=history('US.MSFT',[['2026-11-25',100],['2026-11-27',105]]);
  assert.equal(parseWatchHistory(bar,'US.MSFT',new Date('2026-11-27T18:14:00Z'),half).date,'2026-11-25');
  assert.equal(parseWatchHistory(bar,'US.MSFT',new Date('2026-11-27T18:15:00Z'),half).date,'2026-11-27');
  assert.throws(()=>parseWatchHistory(history('US.AAPL',[['2026-10-28',1]]),'US.MSFT',now));
  assert.throws(()=>parseWatchHistory({code:0,data:{usMSFT:{day:[['2011-06-02','24','24'],['2026-10-28','531','531']]}}},'US.MSFT',now));
});
test('completed regular-session quotes supply closing cards without unnecessary history requests; refresh is deduplicated and ledger stays unchanged',async t=>{
  const store=fixture(t),revision=store.state().revision;let calls=0;
  const options={now,quoteProvider:async keys=>{calls++;return provider(keys);},fetchImpl:async()=>{throw new Error('history should not be requested');}};
  const a=refreshWatchboard(store,options),b=refreshWatchboard(store,options);assert.equal(a,b);
  const view=await a;assert.equal(view.available,WATCH_INSTRUMENTS.length);assert.equal(view.error,null);assert.equal(view.items[0].close.date,'2026-10-28');
  const count=calls;await refreshWatchboard(store,options);assert.equal(calls,count);
  const close=await refreshWatchboard(store,{...options,mode:'close'});assert.equal(close.available,view.available);assert.equal(store.state().revision,revision);
});
test('concurrent mode changes retain both cache projections, and failed or older responses never overwrite good quotes',async t=>{
  const store=fixture(t);await Promise.all([refreshWatchboard(store,{now,quoteProvider:provider}),refreshWatchboard(store,{now,mode:'close',quoteProvider:provider})]);
  assert.ok(store.getKV(WATCH_CACHE).attemptedAt.latest);assert.ok(store.getKV(WATCH_CACHE).attemptedAt.close);
  const later=new Date(now.getTime()+61000),failed=await refreshWatchboard(store,{now:later,quoteProvider:async()=>{throw new Error('offline');}});
  assert.match(failed.error,/保留/);assert.equal(failed.items[0].latest.date,'2026-10-28');
  const older=await refreshWatchboard(store,{now:new Date(later.getTime()+61000),quoteProvider:async keys=>keys.map(k=>raw(k,'2026-10-27 16:00:01',90,80))});
  assert.equal(older.items[0].latest.price,110);assert.match(older.error,/保留/);
});
test('intraday cold starts load completed daily closes with bounded concurrency, keeping the two modes distinct',async t=>{
  const store=fixture(t);let inFlight=0,maxInFlight=0,historyCalls=0;
  const quoteProvider=async keys=>keys.map(k=>raw(k,'2026-10-29 10:00:00',121,108));
  const fetchImpl=async url=>{historyCalls++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await Promise.resolve();inFlight--;const code=new URL(url).searchParams.get('param').split(',')[0];return Response.json(history('US.'+code.slice(2).replace(/\.(OQ|N|AM)$/,''),[['2026-10-27',100],['2026-10-28',108],['2026-10-29',121]]));};
  const view=await refreshWatchboard(store,{now,mode:'close',quoteProvider,fetchImpl});assert.equal(view.available,view.total);assert.equal(view.error,null);assert.ok(maxInFlight<=8);
  assert.equal(view.items[0].latest.date,'2026-10-29');assert.equal(view.items[0].close.date,'2026-10-28');assert.ok(Math.abs(view.items[0].close.percent-8)<1e-9);
  const count=historyCalls;await refreshWatchboard(store,{now:new Date(now.getTime()+61000),mode:'close',quoteProvider,fetchImpl});assert.equal(historyCalls,count);
});
test('partial quote responses flag missing coverage and preserve actual zero changes',async t=>{
  const store=fixture(t),view=await refreshWatchboard(store,{now,quoteProvider:async keys=>keys.includes('US.MSFT')?[raw('US.MSFT',undefined,100,100)]:[]});
  assert.equal(view.available,1);assert.match(view.error,/部分证券/);assert.equal(view.items.find(i=>i.symbol==='MSFT').latest.percent,0);assert.equal(view.items.find(i=>i.symbol==='AAPL').latest,null);
});
test('cards filter names and codes, sort valid changes ahead of missing values, and copy only the selected scope and mode',()=>{
  const msft={key:'US.MSFT',symbol:'MSFT',name:'微软',latest:normalizeWatchQuote(raw('US.MSFT'),now),close:{...normalizeWatchQuote(raw('US.MSFT',undefined,95,100),now),basis:'close'}},apple={key:'US.AAPL',symbol:'AAPL',name:'苹果',latest:null,close:null};
  const view={items:[apple,msft],groups:[{id:'popular',title:'热门关注',keys:['US.AAPL','US.MSFT']}],total:2};
  let html=watchboardGroupsHTML(view);assert.ok(html.indexOf('data-key="US.MSFT"')<html.indexOf('data-key="US.AAPL"'));assert.match(html,/待更新/);
  html=watchboardGroupsHTML(view,{query:'msft'});assert.match(html,/微软/);assert.ok(!html.includes('data-key="US.AAPL"'));
  assert.match(watchboardGroupsHTML(view,{query:'苹果'}),/data-key="US.AAPL"/);assert.match(watchboardGroupsHTML(view,{query:'不存在'}),/没有找到匹配/);
  const text=watchboardCopyText(view,{query:'msft',mode:'close'});assert.match(text,/−5.00%/);assert.ok(!text.includes('AAPL'));
  assert.match(watchboardQuoteHTML(msft,{mode:'close'}),/最近收盘/);assert.match(watchboardPageHTML(view,{error:'<img src=x>'}),/&lt;img src=x&gt;/);
});
test('all watch quotes remain accessible to the authorized assistant with pagination and an explicit automatic-context directory',async t=>{
  const store=fixture(t);await refreshWatchboard(store,{now,quoteProvider:provider});
  const snapshot=buildAssistantData(store),auto=automaticPageContext(snapshot),page=readAssistantPage(snapshot,{page:'us-quotes',section:'items',offset:100});
  assert.equal(page.data.length,16);assert.equal(page.lists.items.total,116);assert.ok(page.data.every(i=>i.latest));assert.equal(auto.pages['us-quotes'].items.count,116);assert.equal(auto.pages['us-quotes'].items.readWith,'get_page_data');
});
