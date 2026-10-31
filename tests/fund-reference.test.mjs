import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {FUND_REFERENCES,parseReferenceQuote,parseReferenceMinutes,parseReferenceHistory,fundReference,refreshFundReference} from '../src/fund-reference.mjs';
import {fundReferenceHTML,fundReferenceChartHTML} from '../public/fund-reference.js';
import {buildAssistantData,readAssistantPage,automaticPageContext} from '../src/assistant-data.mjs';
import {createAssistantServices} from '../src/market-access.mjs';

const now=new Date('2026-10-31T07:00:00Z'),key='SH.588080';
function wire(values={}){const f=Array(50).fill('');Object.assign(f,{1:'Synthetic ETF',2:'588080',3:'1.2',4:'1.1',5:'1.15',6:'10',30:'20261030150000',33:'1.3',34:'1.0',35:'1.2/10/1200',37:'0.12',38:'0',...values});return 'v_sh588080="'+f.join('~')+'";';}
const minutes=(rows=['0930 1.1 2 220','0931 1.2 5 580','1500 1.2 10 1180'])=>({code:0,data:{sh588080:{data:{date:'20261030',data:rows}}}});
const history=(rows=[['2026-10-29','1.1','1.1','1.2','1.0','8'],['2026-10-30','1.15','1.2','1.3','1.0','10']])=>({code:0,data:{sh588080:{day:rows}}});
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'steady-fund-reference-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const state=store.state();state.assets=[{id:'fund',name:'Synthetic fund',type:'fund',currency:'CNY',quantity:100,unit:'份',value:100,asOf:'2026-10-30',fund:{code:'011609',autoNav:true},costBasis:{amount:80,quantity:100,currency:'CNY'}},{id:'cash',name:'Synthetic cash',type:'cash',currency:'CNY',value:10000,asOf:'2026-10-30'}];store.save(state,state.revision);return store;
}
const response=async url=>new Response(url.includes('/q=')?wire():JSON.stringify(url.includes('/minute/')?minutes():history()));

test('issuer-verified references distinguish target ETFs from a same-index peer and never guess an unknown fund',t=>{
  const store=setup(t);assert.equal(FUND_REFERENCES['011609'].key,'SH.588080');assert.equal(FUND_REFERENCES['008164'].key,'SH.515450');assert.equal(FUND_REFERENCES['005052'].relation,'same_index_etf');
  assert.equal(Object.values(FUND_REFERENCES).filter(r=>r.relation==='target_etf').length,4);assert.ok(Object.values(FUND_REFERENCES).every(r=>r.sources.every(s=>s.url.startsWith('https://'))));
  const state=store.state({raw:true});state.assets[0].fund.code='000001';store.save(state,state.revision);
  assert.equal(fundReference(store,'fund').status,'unmapped');assert.equal(fundReference(store,'cash').status,'not_applicable');assert.throws(()=>fundReference(store,'missing'),e=>e.status===404);
});
test('A-share ETF snapshots convert lots to units and amount to CNY, preserve missing values and reject other markets or identities',()=>{
  const q=parseReferenceQuote(wire(),key,now);assert.equal(q.volume,1000);assert.equal(q.amount,1200);assert.equal(q.open,1.15);assert.equal(q.turnover,0);assert.ok(Math.abs(q.percent-9.090909)<1e-5);
  const missing=parseReferenceQuote(wire({5:'',6:'',35:'',37:'',38:''}),key,now);assert.equal(missing.volume,null);assert.equal(missing.amount,null);assert.equal(missing.open,null);assert.equal(missing.turnover,null);
  assert.equal(parseReferenceQuote(wire({35:'',37:'2'}),key,now).amount,20000);
  assert.throws(()=>parseReferenceQuote(wire(),'HK.00700',now));assert.throws(()=>parseReferenceQuote(wire({2:'588000'}),key,now));assert.throws(()=>parseReferenceQuote(wire({34:'1.4'}),key,now));assert.throws(()=>parseReferenceQuote(wire({30:'20261031160000'}),key,now));
});
test('minute volumes are differences of source cumulative lots, retain actual dates and do not invent amounts or future points',()=>{
  const view=parseReferenceMinutes(minutes(),key,now);assert.equal(view.date,'2026-10-30');assert.deepEqual(view.points.map(p=>p.volume),[200,300,500]);assert.equal(view.points[1].amount,360);assert.equal(view.points.at(-1).cumulativeVolume,1000);
  assert.equal(parseReferenceMinutes(minutes(['0930 1.1 2','0931 1.2 5 580']),key,now).points[1].amount,null);
  assert.throws(()=>parseReferenceMinutes(minutes(['0931 1.1 5 500','0930 1.2 10 1000']),key,now));assert.throws(()=>parseReferenceMinutes(minutes(['0930 1.1 5 500','0931 1.2 4 550']),key,now));
  assert.throws(()=>parseReferenceMinutes(minutes(),key,new Date('2026-10-30T01:30:00Z')));
});
test('daily reference uses unadjusted OHLC and source volume, labels unfinished sessions and rejects adjusted or duplicate bars',()=>{
  const view=parseReferenceHistory(history(),key,new Date('2026-10-30T06:00:00Z'));assert.equal(view.basis,'unadjusted');assert.equal(view.points[0].volume,800);assert.equal(view.points.at(-1).status,'partial');
  assert.throws(()=>parseReferenceHistory({code:0,data:{sh588080:{qfqday:history().data.sh588080.day}}},key,now));
  assert.throws(()=>parseReferenceHistory(history([history().data.sh588080.day[0],history().data.sh588080.day[0]]),key,now));
  assert.throws(()=>parseReferenceHistory(history([['2026-10-30','1.1','1.2','1.0','1.1','10']]),key,now));
});
test('parallel refreshes share requests, cache for a minute and leave NAV, ledger, revision, history and audit untouched',async t=>{
  const store=setup(t),before=store.state({raw:true}),audit=store.audit(),savedHistory=store.history();let calls=0;
  store.setKV('fund_nav:011609',{date:'2026-10-30',price:0.9,basis:'unit_nav',currency:'CNY'});
  const fetchImpl=async url=>{calls++;return response(url);};
  const [a,b]=await Promise.all([refreshFundReference(store,'fund',{now,fetchImpl}),refreshFundReference(store,'fund',{now,fetchImpl})]);assert.equal(calls,3);assert.equal(a.quote.price,1.2);assert.deepEqual(a,b);
  await refreshFundReference(store,'fund',{now,fetchImpl});assert.equal(calls,3);
  assert.deepEqual(store.state({raw:true}),before);assert.deepEqual(store.audit(),audit);assert.deepEqual(store.history(),savedHistory);assert.equal(store.ledgerEntries().length,0);assert.equal(store.state().assets[0].value,90);assert.equal(store.getKV('fund_nav:011609').price,0.9);
  const pages=buildAssistantData(store),item=readAssistantPage(pages,{page:'instruments',section:'items',assetId:'fund'}).data[0];assert.equal(item.marketReference.quote.price,1.2);assert.match(item.marketReference.notice,/不是本基金净值/);
  assert.equal(item.marketReference.intraday.count,3);assert.equal(item.marketReference.intraday.points,undefined);
  const compact=automaticPageContext(pages);assert.equal(compact.pages.instruments.referenceMinutes.count,3);assert.equal(compact.pages.instruments.referenceHistory.count,2);assert.ok(!JSON.stringify(compact).includes('09:31'));
  const page=readAssistantPage(pages,{page:'instruments',section:'referenceMinutes',assetId:'fund',date:'2026-10-30',offset:1,limit:1});assert.equal(page.data[0].time,'09:31');assert.equal(page.lists.referenceMinutes.nextOffset,2);
  assert.equal((await createAssistantServices(store,{includePageData:true}).getInstrumentDetails({assetId:'fund'})).marketReference.quote.price,1.2);
});
test('failed and older updates preserve each section and its date without replacing missing values with zero',async t=>{
  const store=setup(t);await refreshFundReference(store,'fund',{now,fetchImpl:response});
  const later=new Date(now.getTime()+61000),failed=await refreshFundReference(store,'fund',{now:later,fetchImpl:async()=>{throw new Error('offline');}});
  assert.equal(failed.status,'cached');assert.equal(failed.quote.time,'2026-10-30 15:00:00');assert.equal(failed.intraday.date,'2026-10-30');assert.equal(Object.keys(failed.errors).length,3);
  const older=await refreshFundReference(store,'fund',{now:new Date(later.getTime()+61000),fetchImpl:async url=>url.includes('/q=')?new Response(wire({30:'20261029150000'})):response(url)});
  assert.equal(older.quote.time,'2026-10-30 15:00:00');assert.ok(older.errors.quote);assert.equal(Object.keys(older.errors).length,1);
});
test('first-load failures and deleted assets never create a valuation or retain a late private asset response',async t=>{
  const store=setup(t),failed=await refreshFundReference(store,'fund',{now,fetchImpl:async()=>{throw new Error('offline');}});assert.equal(failed.status,'unavailable');assert.equal(failed.quote,null);
  let release;const gate=new Promise(resolve=>{release=resolve;}),running=refreshFundReference(store,'fund',{now:new Date(now.getTime()+61000),fetchImpl:async url=>{await gate;return response(url);}});
  const state=store.state({raw:true});state.assets=[];store.save(state,state.revision);release();await assert.rejects(running,e=>e.status===404);assert.equal(store.getKV('fund_reference:'+key).quote,undefined);
});
test('reference UI labels relation, source dates, volume and missing data, separates NAV and supports range selection without unsafe links',()=>{
  const view={reference:{...FUND_REFERENCES['005052'],verifiedAt:'2026-10-31'},quote:parseReferenceQuote(wire(),key,now),intraday:parseReferenceMinutes(minutes(),key,now),history:parseReferenceHistory(history(),key,now),errors:{quote:'保留上次数据'}};
  const html=fundReferenceHTML(view);assert.match(html,/同指数参考 ETF/);assert.match(html,/不是该 ETF 的联接基金/);assert.match(html,/基金估值仍按正式披露净值/);assert.match(html,/2026-10-30 15:00:00/);assert.match(html,/data-fund-reference-range/);assert.match(html,/成交额/);assert.match(html,/保留上次数据/);assert.match(html,/1,000 份/);
  assert.match(fundReferenceChartHTML(view,'intraday',0),/2026-10-30 09:30/);assert.match(fundReferenceChartHTML(view,'daily'),/不复权日线/);
  const escaped=fundReferenceHTML({...view,reference:{...view.reference,name:'<img src=x onerror=alert(1)>',sources:[{title:'bad',url:'javascript:alert(1)'}]}});assert.ok(!escaped.includes('<img'));assert.ok(!escaped.includes('href="javascript:'));assert.match(escaped,/&lt;img/);
  assert.ok(!/NaN|Infinity/.test(fundReferenceChartHTML({...view,intraday:{date:'2026-10-30',points:[{time:'09:30',price:1,volume:null}]}})));
  assert.match(fundReferenceHTML({status:'unmapped',message:'尚无参考'}),/尚无参考/);
  const failed=fundReferenceHTML(null,{error:'暂时无法读取参考行情，请重试。'});assert.match(failed,/role="alert"/);assert.match(failed,/重新读取/);assert.ok(!failed.includes('正在读取'));
});
