import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {security,securityKey} from '../src/securities.mjs';
import {parseStockMarketQuote,parseStockMarketMinutes,parseStockMarketHistory,stockMarketData,refreshStockMarketData} from '../src/stock-market-data.mjs';
import {stockMarketHTML} from '../public/stock-market.js';
import {fundReferenceChartHTML} from '../public/fund-reference.js';
import {buildAssistantData,readAssistantPage,automaticPageContext} from '../src/assistant-data.mjs';
import {createAssistantServices} from '../src/market-access.mjs';

const now=new Date('2026-10-31T07:00:00Z');
const code=key=>({SH:'sh',SZ:'sz',HK:'hk',US:'us'})[securityKey(key).market]+securityKey(key).symbol;
function wire(key='US.GOOG',values={}){
  const s=securityKey(key),f=Array(50).fill('');
  Object.assign(f,{0:s.market==='US'?'delay':'51',1:'Synthetic stock',2:s.market==='US'?s.symbol+'.OQ':s.symbol,3:'120',4:'110',5:'115',6:'10',30:s.market==='US'?'2026/10/30 16:00:00':'20261030160800',33:'130',34:'100',35:s.market==='US'?'USD':'120/10/1200',37:'1200',38:'0.5',...values});
  return 'v_'+code(key)+'="'+f.join('~')+'";';
}
const minutes=(key='US.GOOG',rows=['0930 110 2','0931 120 5','1600 120 10'],date='20261030')=>({code:0,data:{[key.startsWith('US.')?code(key)+'.OQ':code(key)]:{data:{date,data:rows}}}});
const history=(key='US.GOOG',rows=[['2026-10-29','110','110','120','100','8'],['2026-10-30','115','120','130','100','10']])=>({code:0,data:{[key.startsWith('US.')?code(key)+'.OQ':code(key)]:{day:rows}}});
const response=async url=>new Response(url.includes('/q=')?wire():JSON.stringify(url.includes('Minute/')?minutes():history()));
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'steady-stock-market-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const state=store.state();state.assets=[{id:'stock',name:'Synthetic stock',type:'stock',currency:'USD',quantity:100,unit:'股',value:10000,asOf:'2026-10-30',security:security({market:'US',symbol:'GOOG'}),autoPrice:true,costBasis:{amount:8000,quantity:100,currency:'USD'}},{id:'cash',name:'Synthetic cash',type:'cash',currency:'CNY',value:10000,asOf:'2026-10-30'}];store.save(state,state.revision);return store;
}

test('stock snapshots use market-specific units, original currency, delayed flags and no invented missing values',()=>{
  for(const key of ['SH.601318','SZ.000001']){const q=parseStockMarketQuote(wire(key),key,now);assert.equal(q.volume,1000);assert.equal(q.amount,1200);assert.equal(q.currency,'CNY');assert.equal(parseStockMarketQuote(wire(key,{35:''}),key,now).amount,12000000);}
  const hk=parseStockMarketQuote(wire('HK.00700'),'HK.00700',now);assert.equal(hk.volume,10);assert.equal(hk.amount,1200);assert.equal(hk.turnover,null);assert.equal(hk.currency,'HKD');
  assert.equal(parseStockMarketQuote(wire('HK.80700'),'HK.80700',now).currency,'CNY');
  const us=parseStockMarketQuote(wire(),'US.GOOG',now);assert.equal(us.volume,10);assert.equal(us.amount,1200);assert.equal(us.historyCode,'usGOOG.OQ');assert.equal(us.delayed,true);assert.equal(us.timeZone,'America/New_York');
  const missing=parseStockMarketQuote(wire('US.GOOG',{5:'',6:'',37:'',38:''}),'US.GOOG',now);assert.equal(missing.open,null);assert.equal(missing.volume,null);assert.equal(missing.amount,null);assert.equal(missing.turnover,null);
  assert.equal(parseStockMarketQuote(wire('US.GOOG',{6:'0',37:'0',38:'0'}),'US.GOOG',now).volume,0);
});
test('stock quotes reject wrong identity, currency, prices and future market-local timestamps',()=>{
  for(const values of [{2:'GOOGL.OQ'},{35:'HKD'},{34:'140'},{30:'2026/10/31 16:00:00'}])assert.throws(()=>parseStockMarketQuote(wire('US.GOOG',values),'US.GOOG',now));
  assert.throws(()=>parseStockMarketQuote(wire('HK.00700'),'US.GOOG',now));
  assert.throws(()=>parseStockMarketQuote(wire('US.GOOG',{2:'GOOG;evil'}),'US.GOOG',now));
  assert.throws(()=>parseStockMarketQuote(wire(),'BJ.430047',now));
});
test('minutes difference cumulative volume by market; preserve HK auction, US regular session and missing amounts',()=>{
  const us=parseStockMarketMinutes(minutes(),'US.GOOG','usGOOG.OQ',now);assert.deepEqual(us.points.map(p=>p.volume),[2,3,5]);assert.ok(us.points.every(p=>p.amount===null));assert.equal(us.session,'regular');
  const hk=parseStockMarketMinutes(minutes('HK.00700',['0930 110 2 220','0931 120 5 580','1608 120 10 1180']),'HK.00700','hk00700',now);assert.equal(hk.points.at(-1).time,'16:08');assert.equal(hk.points[1].amount,360);assert.equal(hk.points.at(-1).cumulativeVolume,10);
  const cn=parseStockMarketMinutes(minutes('SH.601318',['0930 110 2 22000','1500 120 5 58000']),'SH.601318','sh601318',now);assert.deepEqual(cn.points.map(p=>p.volume),[200,300]);assert.equal(cn.points.at(-1).amount,36000);
  assert.throws(()=>parseStockMarketMinutes(minutes('US.GOOG',['1601 120 10']),'US.GOOG','usGOOG.OQ',now));
  assert.throws(()=>parseStockMarketMinutes(minutes('US.GOOG',['0929 120 10']),'US.GOOG','usGOOG.OQ',now));
  const corrected=parseStockMarketMinutes(minutes('US.GOOG',['0930 120 10 1200','0931 119 9 1100','0932 120 12 1500']),'US.GOOG','usGOOG.OQ',now);assert.equal(corrected.volumeDecreases,1);assert.equal(corrected.amountDecreases,1);assert.equal(corrected.points[1].volume,null);assert.equal(corrected.points[1].amount,null);assert.equal(corrected.points[1].price,119);assert.equal(corrected.points[1].volumeStatus,'cumulative_decrease');assert.equal(corrected.points[2].volume,3);assert.equal(corrected.points[2].amount,400);
  assert.throws(()=>parseStockMarketMinutes(minutes('US.GOOG',['0930 120 -1']),'US.GOOG','usGOOG.OQ',now));
  assert.throws(()=>parseStockMarketMinutes(minutes('US.GOOG',['0930 120 10','0930 120 10']),'US.GOOG','usGOOG.OQ',now));
  assert.throws(()=>parseStockMarketMinutes(minutes(),'US.GOOGL','usGOOG.OQ',now));
  assert.throws(()=>parseStockMarketMinutes({...minutes(),data:{'usGOOG.OQ':{...minutes().data['usGOOG.OQ'],qt:{'usGOOG.OQ':[null,null,'GOOGL.OQ']}}}},'US.GOOG','usGOOG.OQ',now));
});
test('US minute and day timestamps handle daylight saving and calendar half-days',()=>{
  const rows=['0930 110 2','0931 120 5'];
  assert.throws(()=>parseStockMarketMinutes(minutes('US.GOOG',rows),'US.GOOG','usGOOG.OQ',new Date('2026-10-30T13:30:00Z')));
  assert.throws(()=>parseStockMarketMinutes(minutes('US.GOOG',rows,'20261106'),'US.GOOG','usGOOG.OQ',new Date('2026-11-06T14:30:00Z')));
  const calendars={US:[{time:'2026-10-30',trade_date_type:'HALF'}]};
  assert.throws(()=>parseStockMarketMinutes(minutes(),'US.GOOG','usGOOG.OQ',now,calendars));
  assert.equal(parseStockMarketMinutes(minutes('US.GOOG',['1300 120 10']),'US.GOOG','usGOOG.OQ',now,calendars).points[0].time,'13:00');
  assert.equal(parseStockMarketHistory(history(),'US.GOOG','usGOOG.OQ',new Date('2026-10-30T17:10:00Z'),calendars).points.at(-1).status,'partial');
  assert.equal(parseStockMarketHistory(history(),'US.GOOG','usGOOG.OQ',new Date('2026-10-30T17:15:00Z'),calendars).points.at(-1).status,'complete');
  assert.equal(parseStockMarketHistory(history(),'US.GOOG','usGOOG.OQ',new Date('2026-10-30T17:15:00Z')).points.at(-1).status,'partial');
});
test('unadjusted daily bars validate OHLC, dates, identity and market volume units',()=>{
  for(const key of ['SH.601318','HK.00700','US.GOOG']){const series=parseStockMarketHistory(history(key),key,key==='US.GOOG'?'usGOOG.OQ':code(key),now);assert.equal(series.basis,'unadjusted');assert.equal(series.points.at(-1).volume,key.startsWith('SH.')?1000:10);}
  assert.throws(()=>parseStockMarketHistory({code:0,data:{'usGOOG.OQ':{qfqday:history().data['usGOOG.OQ'].day}}},'US.GOOG','usGOOG.OQ',now));
  for(const rows of [[['2026-11-01','115','120','130','100','10']],[['2026-10-30','115','120','110','100','10']],[...history().data['usGOOG.OQ'].day,history().data['usGOOG.OQ'].day[0]]])assert.throws(()=>parseStockMarketHistory(history('US.GOOG',rows),'US.GOOG','usGOOG.OQ',now));
});
test('stock refresh deduplicates, uses verified US minute route, caches and never changes financial records or valuation caches',async t=>{
  const store=setup(t),quote={key:'US.GOOG',price:100,date:'2026-10-30',currency:'USD'};store.setKV('stock_quote:US.GOOG',quote);
  const before=store.state({raw:true}),audit=store.audit(),savedHistory=store.history(),prices=store.priceHistory('US.GOOG'),urls=[];
  const fetchImpl=async url=>{urls.push(url);return response(url);};
  const [a,b]=await Promise.all([refreshStockMarketData(store,'stock',{now,fetchImpl}),refreshStockMarketData(store,'stock',{now,fetchImpl})]);assert.deepEqual(a,b);assert.equal(urls.length,3);assert.ok(urls.some(u=>u.endsWith('/UsMinute/query?code=usGOOG.OQ')));assert.ok(urls.some(u=>u.includes('param=usGOOG.OQ,day,,,60,')));
  await refreshStockMarketData(store,'stock',{now,fetchImpl});assert.equal(urls.length,3);assert.equal(a.quote.price,120);assert.equal(a.intraday.points.length,3);
  assert.deepEqual(store.state({raw:true}),before);assert.deepEqual(store.audit(),audit);assert.deepEqual(store.history(),savedHistory);assert.deepEqual(store.priceHistory('US.GOOG'),prices);assert.deepEqual(store.getKV('stock_quote:US.GOOG'),quote);assert.equal(store.ledgerEntries().length,0);
  assert.equal(stockMarketData(store,'cash').status,'not_applicable');assert.throws(()=>stockMarketData(store,'missing'),e=>e.status===404);
});
test('outages and older responses preserve independent section dates; no US suffix is guessed',async t=>{
  const store=setup(t);let calls=0;
  const first=await refreshStockMarketData(store,'stock',{now,fetchImpl:async()=>{calls++;throw new Error('offline');}});assert.equal(calls,1);assert.equal(first.status,'unavailable');assert.equal(first.intraday,null);
  const later=new Date(now.getTime()+61000);await refreshStockMarketData(store,'stock',{now:later,fetchImpl:response});
  const failed=await refreshStockMarketData(store,'stock',{now:new Date(later.getTime()+61000),fetchImpl:async()=>{throw new Error('offline');}});assert.equal(failed.status,'cached');assert.equal(failed.quote.time,'2026-10-30 16:00:00');assert.equal(failed.intraday.date,'2026-10-30');assert.equal(Object.keys(failed.errors).length,3);
  const old=await refreshStockMarketData(store,'stock',{now:new Date(later.getTime()+122000),fetchImpl:async url=>url.includes('/q=')?new Response(wire('US.GOOG',{30:'2026/10/29 16:00:00'})):url.includes('Minute/')?new Response(JSON.stringify(minutes('US.GOOG',undefined,'20261029'))):new Response(JSON.stringify(history('US.GOOG',[history().data['usGOOG.OQ'].day[0]])))});
  assert.equal(old.quote.date,'2026-10-30');assert.equal(old.intraday.date,'2026-10-30');assert.equal(old.history.points.at(-1).date,'2026-10-30');assert.equal(Object.keys(old.errors).length,3);
});
test('late stock responses are not retained after deleting or replacing the asset',async t=>{
  const store=setup(t);let release;const gate=new Promise(r=>{release=r;});
  const running=refreshStockMarketData(store,'stock',{now,fetchImpl:async url=>{await gate;return response(url);}}),state=store.state({raw:true});state.assets[0].security=security({market:'US',symbol:'DAL'});store.save(state,state.revision);release();
  assert.equal((await running).instrument.key,'US.DAL');assert.equal(store.getKV('stock_market_data:US.GOOG'),null);
  let releaseDelete;const gateDelete=new Promise(r=>{releaseDelete=r;});
  const deleted=refreshStockMarketData(store,'stock',{now,fetchImpl:async url=>{await gateDelete;return response(url);}}),empty=store.state({raw:true});empty.assets=[];store.save(empty,empty.revision);releaseDelete();await assert.rejects(deleted,e=>e.status===404);assert.equal(store.getKV('stock_market_data:US.DAL'),null);
});
test('authorized AI gets compact stock summaries and paginates full point lists without changing PE sources',async t=>{
  const store=setup(t);await refreshStockMarketData(store,'stock',{now,fetchImpl:response});store.setKV('stock_details:US.GOOG',{key:'US.GOOG',currency:'USD',source:'Synthetic OpenD',fetchedAt:new Date().toISOString(),metrics:{peTTM:20}});
  const snapshot=buildAssistantData(store),item=readAssistantPage(snapshot,{page:'instruments',section:'items',assetId:'stock'}).data[0];assert.equal(item.marketData.quote.price,120);assert.equal(item.marketData.intraday.count,3);assert.equal(item.marketData.intraday.points,undefined);assert.equal(item.details.metrics.peTTM,20);
  const compact=automaticPageContext(snapshot);assert.equal(compact.pages.instruments.stockMinutes.count,3);assert.equal(compact.pages.instruments.stockHistory.count,2);assert.ok(!JSON.stringify(compact).includes('09:31'));
  const page=readAssistantPage(snapshot,{page:'instruments',section:'stockMinutes',assetId:'stock',date:'2026-10-30',offset:1,limit:1});assert.equal(page.data[0].time,'09:31');assert.equal(page.data[0].currency,'USD');assert.equal(page.lists.stockMinutes.nextOffset,2);
  assert.equal(createAssistantServices(store).getInstrumentDetails,undefined);assert.equal((await createAssistantServices(store,{includePageData:true}).getInstrumentDetails({assetId:'stock'})).marketData.quote.price,120);
});
test('stock UI preserves original currency, delayed timestamps, missing amounts and safe escaped content',()=>{
  const view={instrument:{key:'US.GOOG',market:'US',currency:'USD',marketLabel:'美股',timeZone:'America/New_York',name:'Synthetic <stock>'},quote:parseStockMarketQuote(wire(),'US.GOOG',now),intraday:parseStockMarketMinutes(minutes(),'US.GOOG','usGOOG.OQ',now),history:parseStockMarketHistory(history(),'US.GOOG','usGOOG.OQ',now),errors:{}};
  const html=stockMarketHTML(view);assert.match(html,/股票行情/);assert.match(html,/USD/);assert.match(html,/10 股/);assert.match(html,/纽约时间/);assert.match(html,/延迟行情/);assert.match(html,/不复权/);assert.match(html,/Synthetic &lt;stock&gt;/);assert.ok(!html.includes('CNY'));assert.ok(!html.includes(' 份'));
  const unsafe=stockMarketHTML({...view,quote:{...view.quote,sourceUrl:'javascript:alert(1)'}});assert.ok(!unsafe.includes('href="javascript:'));assert.match(stockMarketHTML(null,{error:'连接失败'}),/重新读取/);assert.match(stockMarketHTML({status:'unsupported',message:'尚不支持'}),/尚不支持/);
});
test('fund and stock volume colors track price direction, never volume growth or alleged buys and sells',()=>{
  const view={quote:{date:'2026-10-30',previous:{price:100}},intraday:{date:'2026-10-30',points:[{time:'09:30',price:101,volume:10},{time:'09:31',price:100,volume:20},{time:'09:32',price:100,volume:30},{time:'09:33',price:102,volume:null} ]},history:{points:[{date:'2026-10-29',price:101,volume:10},{date:'2026-10-30',price:100,volume:20}]}};
  const colors=html=>[...html.matchAll(/<rect class="fund-reference-volume volume-(\w+)"/g)].map(m=>m[1]);
  const html=fundReferenceChartHTML(view);assert.deepEqual(colors(html),['up','down','flat']);assert.match(html,/较该日昨收上涨/);assert.match(html,/较上一已返回时点下跌/);assert.match(html,/红：价格上涨/);assert.match(html,/蓝：价格下跌/);assert.match(html,/颜色不代表主动买入或卖出/);
  assert.deepEqual(colors(fundReferenceChartHTML({...view,quote:{date:'2026-10-29',previous:{price:100}}})),['flat','down','flat']);assert.deepEqual(colors(fundReferenceChartHTML(view,'daily')),['flat','down']);
  const stock=stockMarketHTML({...view,instrument:{market:'HK',key:'HK.00700',currency:'HKD',name:'Synthetic'}});assert.deepEqual(colors(stock),colors(html));assert.match(stock,/HKD/);assert.match(stock,/股/);
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');assert.match(css,/\.volume-up\{fill:#c24b50/);assert.match(css,/\.volume-down\{fill:#4a7fb8/);assert.match(css,/\.volume-flat\{fill:#9ca6af/);
  assert.match(fundReferenceChartHTML({...view,intraday:{...view.intraday,volumeDecreases:1}}),/对应时点的量或额留空/);
});
