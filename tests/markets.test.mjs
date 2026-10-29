import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {MARKET_SERIES,normalizeMarketQuote,parseMarketQuotes,parseMarketHistory,parseFearGreed,refreshMarketOverview,marketOverview} from '../src/markets.mjs';
import {marketPageHTML} from '../public/markets.js';
import {marketBriefFacts} from '../src/market-briefs.mjs';
import {BUFFETT_SERIES} from '../src/buffett.mjs';
const now=new Date('2026-10-25T09:00:00Z'),def=MARKET_SERIES[0];
function setup(t){const dir=mkdtempSync(join(tmpdir(),'steady-markets-')),s=openStore(dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
function quote(key,price=110,previous=100,time='2026-10-23 16:01:00'){return {key,price,previous:{price:previous},time};}
function wire(code,symbol,price=110,previous=100,time='2026-10-23 16:01:00') {const f=Array(33).fill('');f[2]=symbol;f[3]=String(price);f[4]=String(previous);f[30]=time;return `v_${code}="${f.join('~')}";`;}
function dataFetch(overrides={}){return async url=>{
 if(url.includes('cnn.io'))return new Response('Restricted',{status:418});
 if(url.includes('qt.gtimg'))return new Response(overrides.text||wire('us.INX','.INX'));
 const code=new URL(url).searchParams.get('param').split(',')[0];return Response.json({code:0,data:{[code]:{day:[['2026-10-22','100','100'],['2026-10-23','110','110']]}}});
};}
test('index identities, timestamps and positive prices are validated; missing previous close stays unknown',()=>{
 const q=parseMarketQuotes(wire('us.INX','.INX')+wire('hkHSI','HSI',110,0,'2026/10/23 16:08:00'),now);assert.equal(q.length,2);assert.ok(Math.abs(q[0].percent-10)<1e-10);assert.equal(q[1].percent,null);
 assert.equal(parseMarketQuotes(wire('us.INX','.DJI'),now).length,0);
 for(const price of [0,-1,'',NaN])assert.throws(()=>normalizeMarketQuote(quote(def.key,price),def,now));
 assert.throws(()=>normalizeMarketQuote(quote(def.key,110,100,'2026-10-26 16:00:00'),def,now));
 assert.equal(normalizeMarketQuote(quote(def.key,110,100,'2026-10-23 16:01:00.123'),def,now).time,'2026-10-23 16:01:00');
 assert.equal(parseMarketHistory({code:0,data:{'us.INX':{day:[['2026-10-23','100','110']]}}},def,now)[0].previous,null);
});
test('CNN validates genuine scores, preserves zero, and rejects future or fabricated out-of-range readings',()=>{
 const payload={fear_and_greed:{score:0,rating:'extreme fear',timestamp:'2026-10-23T20:00:00Z',previous_close:5}};
 assert.equal(parseFearGreed(payload,now).score,0);assert.equal(parseFearGreed(payload,now).rating,'极度恐惧');
 for(const score of [null,'',101,-1])assert.throws(()=>parseFearGreed({fear_and_greed:{...payload.fear_and_greed,score}},now));
 assert.throws(()=>parseFearGreed({fear_and_greed:{...payload.fear_and_greed,timestamp:'2026-10-26'}},now));
});
test('refresh caches public fallback, reports CNN restrictions and OpenD status without modifying holdings or calling AI',async t=>{
 const s=setup(t),before=s.state({raw:true});let calls=0;
 const provider=async()=>{calls++;return {global:{qot_logined:true},calendars:{},quotes:[],history:[]};};
 const a=await refreshMarketOverview(s,{provider,fetchImpl:dataFetch(),now});
 assert.equal(a.opend.connected,true);assert.match(a.sentiment.error,/418/);assert.equal(a.sentiment.score,undefined);
 let view=marketOverview(s,'US',now);assert.equal(view.date,'2026-10-23');assert.equal(view.benchmarks[0].quote.price,110);
 await refreshMarketOverview(s,{provider,fetchImpl:dataFetch(),now,force:true});assert.equal(calls,1);assert.deepEqual(s.state({raw:true}),before);
 const html=marketPageHTML('US',view);assert.match(html,/美国市场/);assert.ok(!html.includes('CNN Fear'));assert.match(html,/美国行业表现/);assert.ok(!/NaN|Infinity/.test(html));
 const previous=s.getKV('markets_snapshot').quotes;
 await refreshMarketOverview(s,{provider:async()=>{throw new Error();},fetchImpl:async()=>{throw new Error();},now:new Date('2026-10-25T10:00:00Z')});
 assert.deepEqual(s.getKV('markets_snapshot').quotes,previous);assert.match(marketOverview(s,'US',now).error,/保留/);
});
test('intraday bars never masquerade as yesterday; weekends and exchange half-days use the last completed session',async t=>{
 const s=setup(t),monday=new Date('2026-10-26T17:00:00Z');
 const provider=async()=>({global:{qot_logined:true},calendars:{US:[{time:'2026-10-26',trade_date_type:'WHOLE'}]},quotes:[quote('US..SPX',120,110,'2026-10-26 13:00:00')],history:[{key:'US..SPX',date:'2026-10-23',price:110,previous:{price:100}},{key:'US..SPX',date:'2026-10-26',price:120,previous:{price:110}}]});
 await refreshMarketOverview(s,{provider,fetchImpl:async()=>{throw new Error();},now:monday});const intraday=marketOverview(s,'US',monday);assert.equal(intraday.date,'2026-10-23');assert.equal(intraday.latestDate,'2026-10-26');assert.equal(intraday.benchmarks[0].quote.price,110);assert.equal(intraday.benchmarks[0].latest.price,120);assert.match(marketPageHTML('US',intraday),/最新可用行情 · 美国东岸时间 · 2026-10-26/);
 const half=new Date('2026-11-27T18:20:00Z');
 await refreshMarketOverview(s,{provider:async()=>({global:{qot_logined:true},calendars:{US:[{time:'2026-11-27',trade_date_type:'HALF'}]},quotes:[quote('US..SPX',130,120,'2026-11-27 13:01:00')],history:[]}),fetchImpl:async()=>{throw new Error();},now:half});assert.equal(marketOverview(s,'US',half).date,'2026-11-27');
});

test('市场页按分钟读取轻量行情快照，历史、收盘日期和情绪缓存保持原样，失败保留快照',async t=>{
 const s=setup(t),start=new Date('2026-10-26T02:00:00Z');
 const previous=normalizeMarketQuote(quote('HK.800000',110,100,'2026-10-26 09:59:00'),MARKET_SERIES[4],start);
 const history=[normalizeMarketQuote({key:'HK.800000',date:'2026-10-23',price:100,previous:{price:99}},MARKET_SERIES[4],start)];
 s.setKV('markets_snapshot',{attemptedAt:start.toISOString(),updatedAt:start.toISOString(),quotes:{'HK.800000':previous},histories:{'HK.800000':history},sentiment:{score:42}});
 let calls=0;const urls=[];
 const options={live:true,market:'HK',now:new Date('2026-10-26T02:03:00Z'),provider:async input=>{calls++;assert.equal(input.action,'overview-live');assert.ok(input.keys.every(key=>key.startsWith('HK.')));assert.equal(input.historyKeys,undefined);return {global:{qot_logined:true},quotes:[quote('HK.800000',112,100,'2026-10-26 10:03:00')]};},fetchImpl:async url=>{urls.push(url);throw new Error();}};
 await refreshMarketOverview(s,options);let view=marketOverview(s,'HK',options.now);
 assert.equal(view.latestDate,'2026-10-26');assert.equal(view.benchmarks[0].latest.price,112);assert.equal(view.date,'2026-10-23');assert.equal(view.benchmarks[0].quote.price,100);assert.equal(view.latestError,null);
 const cache=s.getKV('markets_snapshot');assert.deepEqual(cache.histories['HK.800000'],history);assert.equal(cache.sentiment.score,42);assert.equal(cache.updatedAt,start.toISOString());assert.equal(urls.length,1);assert.match(urls[0],/qt\.gtimg\.cn/);
 await refreshMarketOverview(s,{...options,now:new Date('2026-10-26T02:03:30Z')});assert.equal(calls,1);
 await refreshMarketOverview(s,{...options,now:new Date('2026-10-26T02:04:01Z'),provider:async()=>{throw new Error();}});
 view=marketOverview(s,'HK',new Date('2026-10-26T02:04:01Z'));assert.equal(view.benchmarks[0].latest.price,112);assert.match(view.latestError,/保留已有数据/);
 const html=marketPageHTML('HK',view);assert.match(html,/Futu OpenD · 2026-10-26 10:03:00/);assert.match(html,/最新快照/);assert.match(html,/指数走势/);
 await refreshMarketOverview(s,{...options,now:new Date('2026-10-26T02:05:02Z'),provider:async()=>{throw new Error();},fetchImpl:async()=>new Response(wire('hkHSI','HSI',113,100,'2026-10-26 10:05:00'))});
 view=marketOverview(s,'HK',new Date('2026-10-26T02:05:02Z'));assert.equal(view.benchmarks[0].latest.price,113);assert.equal(view.benchmarks[0].latest.source,'腾讯证券公开行情');assert.equal(view.latestError,null);
});

test('港股的指数、持仓涨跌、金额和图表同步更新，跨日缺失不混入合计，简报仍使用收盘记录',async t=>{
 const s=setup(t),start=new Date('2026-10-26T02:00:00Z'),state=s.state();
 state.assets=['00001','00002','00003','00004'].map((symbol,i)=>({id:'h'+i,name:'Synthetic HK '+symbol,type:'stock',currency:'HKD',quantity:i===0?7:1,unit:'股',value:null,autoPrice:true,security:{market:'HK',symbol}}));s.save(state,state.revision);
 const history=[normalizeMarketQuote({key:'HK.800000',date:'2026-10-23',price:100,previous:{price:99}},MARKET_SERIES[4],start)];
 s.setKV('markets_snapshot',{attemptedAt:start.toISOString(),quotes:{},histories:{'HK.800000':history}});
 s.setKV('stock_quote:HK.00001',{...quote('HK.00001',101,100),date:'2026-10-23'});
 const before=s.state({raw:true});let keys;
 const options={live:true,market:'HK',now:new Date('2026-10-26T02:03:00Z'),provider:async input=>{keys=input.keys;return {global:{qot_logined:true},quotes:[quote('HK.800000',112,100,'2026-10-26 10:03:00'),quote('HK.00001',99.875,100,'2026-10-26 10:03:00'),quote('HK.00002',102,100),quote('HK.00003',103,0,'2026-10-26 10:03:00'),quote('HK.00004',101,100,'2026-10-26 10:03:00')]};},fetchImpl:async()=>{throw new Error();}};
 await refreshMarketOverview(s,options);const view=marketOverview(s,'HK',options.now);
 for(const a of s.state({raw:true}).assets)assert.ok(keys.includes(a.security.key));
 assert.equal(view.latestDate,'2026-10-26');assert.equal(view.latestHoldings[0].amount,-.87);assert.ok(Math.abs(view.latestHoldings[0].percent+.125)<1e-10);
 assert.equal(view.latestHoldings[1].status,'stale');assert.equal(view.latestHoldings[1].percent,null);assert.equal(view.latestHoldings[2].status,'missing_previous');assert.equal(view.latestHoldings[2].amount,null);
 assert.equal(view.latestPortfolio.amount,.13);assert.equal(view.latestPortfolio.covered,2);assert.equal(view.latestPortfolio.total,4);
 assert.equal(view.portfolio.amount,7);assert.equal(view.date,'2026-10-23');assert.deepEqual(s.getKV('markets_snapshot').histories['HK.800000'],history);assert.deepEqual(s.state({raw:true}),before);
 const facts=marketBriefFacts(s,'HK');assert.equal(facts.date,'2026-10-23');assert.equal(facts.indices[0].price,100);assert.equal(facts.portfolio.amount,7);
 const html=marketPageHTML('HK',{...view,brief:{market:'HK',date:facts.date,facts,ai:null}});
 assert.match(html,/2026-10-26 10:03:00 · 最新快照/);assert.match(html,/market-live-line/);assert.match(html,/行情摘要/);assert.match(view.latestSummary,/已更新指数上涨/);assert.ok(!view.latestSummary.includes('+12.00%'));assert.ok(!html.includes('我的港股持仓变动'));assert.ok(!html.includes('market-holdings'));assert.match(html,/最近收盘简报 · 2026-10-23 收盘/);
 // A later public quote wins; an older OpenD response cannot roll it back.
 await refreshMarketOverview(s,{...options,now:new Date('2026-10-26T02:04:01Z'),fetchImpl:async()=>new Response(wire('hk00001','00001',100,100,'2026-10-26 10:04:00'))});
 const updated=marketOverview(s,'HK',new Date('2026-10-26T02:04:01Z'));assert.equal(updated.latestHoldings[0].amount,0);assert.equal(updated.latestHoldings[0].source,'腾讯证券公开行情');assert.equal(updated.latestPortfolio.amount,1);
});

test('完整刷新也包含持仓，且美股行业快照使用最新交易日而非上次收盘',async t=>{
 const s=setup(t),state=s.state();state.assets=[{id:'a',name:'Synthetic A',type:'stock',currency:'USD',quantity:2,unit:'股',value:null,autoPrice:true,security:{market:'US',symbol:'SYNTHA'}}];s.save(state,state.revision);
 const monday=new Date('2026-10-26T17:00:00Z');let keys;
 await refreshMarketOverview(s,{now:monday,provider:async input=>{keys=input.keys;return {global:{qot_logined:true},quotes:[quote('US..SPX',120,110,'2026-10-26 13:00:00'),quote('US.XLK',121,110,'2026-10-26 13:00:00'),quote('US.SYNTHA',102,100,'2026-10-26 13:00:00')]};},fetchImpl:dataFetch()});
 const view=marketOverview(s,'US',monday);assert.ok(keys.includes('US.SYNTHA'));assert.equal(view.latestPortfolio.amount,4);assert.equal(view.date,'2026-10-23');assert.equal(view.sectors[0].latest.date,'2026-10-26');
 const html=marketPageHTML('US',view);assert.match(html,/27 个观察板块 · 11 个大行业 \+ 16 个细分与主题/);assert.match(html,/最新可用快照 · 报价日期见各方块/);assert.match(html,/\+10.00%/);
});

test('无个人持仓时也显示更新的行业快照，较旧的指数不混入同日摘要',t=>{
 const s=setup(t),monday=new Date('2026-10-26T17:00:00Z'),sector=MARKET_SERIES.find(d=>d.key==='US.XLK');
 s.setKV('markets_snapshot',{histories:{'US..SPX':[normalizeMarketQuote(quote('US..SPX'),def,monday)]},quotes:{'US.XLK':normalizeMarketQuote(quote('US.XLK',120,100,'2026-10-26 13:00:00'),sector,monday)}});
 const view=marketOverview(s,'US',monday);assert.equal(view.latestDate,'2026-10-26');assert.equal(view.latestPortfolio.total,0);assert.equal(view.latestRecap.indices.length,0);assert.ok(!view.latestSummary.includes('标普'));assert.match(view.latestSummary,/行业广度/);assert.match(marketPageHTML('US',view),/\+20.00%/);
});

test('同一交易日的旧盘中快照不能覆盖已确认的收盘值，只有盘中数据时仍能展示',t=>{
 const s=setup(t);
 s.setKV('markets_snapshot',{quotes:{'HK.800000':normalizeMarketQuote(quote('HK.800000',105,100,'2026-10-23 10:00:00'),MARKET_SERIES[4],now)},histories:{'HK.800000':[normalizeMarketQuote({key:'HK.800000',date:'2026-10-23',price:110,previous:{price:100}},MARKET_SERIES[4],now)]}});
 assert.equal(marketOverview(s,'HK',now).benchmarks[0].latest.price,110);
 s.setKV('markets_snapshot',{quotes:{'HK.800000':normalizeMarketQuote(quote('HK.800000',105,100,'2026-10-23 10:00:00'),MARKET_SERIES[4],now)}});
 const view=marketOverview(s,'HK',now);assert.equal(view.date,null);assert.equal(view.latestDate,'2026-10-23');assert.match(marketPageHTML('HK',view),/105\.00/);
});
test('current-share portfolio movement reconciles and unavailable stocks do not count as zero; stale VIX is hidden',async t=>{
 const s=setup(t),state=s.state();state.assets=[{id:'a',name:'Synthetic A',type:'stock',currency:'USD',quantity:7,unit:'股',value:null,autoPrice:true,security:{market:'US',symbol:'SYNTHA'}},{id:'b',name:'Synthetic B',type:'stock',currency:'USD',quantity:1,unit:'股',value:null,autoPrice:true,security:{market:'US',symbol:'SYNTHB'}}];s.save(state,state.revision);
 s.setKV('stock_quote:US.SYNTHA',{...quote('US.SYNTHA',95,100),date:'2026-10-23',currency:'USD'});
 await refreshMarketOverview(s,{provider:async()=>({global:{qot_logined:true},quotes:[quote('US..SPX'),quote('US..VIX',20,19,'2026-09-15 16:01:00')]}),fetchImpl:dataFetch(),now});
 const v=marketOverview(s,'US',now);assert.equal(v.portfolio.amount,-35);assert.equal(v.portfolio.covered,1);assert.equal(v.portfolio.total,2);assert.equal(v.holdings[1].amount,null);
 assert.ok(!marketPageHTML('US',v).includes('VIX 波动率'));assert.ok(!marketPageHTML('US',v).includes('2026-09-15'));assert.equal(v.volatility.quote.date,'2026-09-15');
});

test('没有行业涨跌数据时显示说明而非空白行业方块，真实零涨跌仍正常展示',()=>{
 const view={market:'US',date:'2026-10-23',benchmarks:[],sectors:[{name:'Synthetic sector',key:'US.XYZ',quote:null}],holdings:[],portfolio:{amount:null,total:0,covered:0},summary:'Waiting'};
 let html=marketPageHTML('US',view);assert.match(html,/行业涨跌数据尚未取得/);assert.ok(!html.includes('class="sector-tile'));
 view.sectors[0].quote={date:view.date,percent:0};html=marketPageHTML('US',view);assert.match(html,/class="sector-tile sector-flat/);assert.match(html,/0\.00%/);assert.ok(!html.includes('行业涨跌数据尚未取得'));
});

test('市场刷新自动计算官方季度估值，页面只显示有效指标，未改动账本且不套用到港股',async t=>{
 const s=setup(t),before=s.state({raw:true}),quarter='2026-04-01',fetchImpl=async url=>{
   if(!url.includes('fred.stlouisfed.org'))return dataFetch()(url);
   const id=new URL(url).searchParams.get('id');return new Response(`observation_date,${id}\n${quarter},${id===BUFFETT_SERIES.marketCap?40000000:20000}\n`);
 };
 await refreshMarketOverview(s,{provider:async()=>({quotes:[]}),fetchImpl,now});
 const view=marketOverview(s,'US',now);assert.equal(view.buffett.percent,200);assert.equal(view.buffett.period,'2026 Q2');assert.deepEqual(s.state({raw:true}),before);
 let html=marketPageHTML('US',view);assert.match(html,/巴菲特指标/);assert.match(html,/2026 Q2 · 季度估值/);assert.match(html,/200.00/);assert.match(html,/40.00 万亿美元/);assert.match(html,/计算口径与来源/);assert.ok(!html.includes('CNN Fear'));assert.ok(!html.includes('VIX 波动率'));
 assert.equal(marketOverview(s,'HK',now).buffett,null);assert.ok(!marketPageHTML('HK',marketOverview(s,'HK',now)).includes('巴菲特指标'));
 view.sentiment={date:view.latestDate,score:0,rating:'极度恐惧'};view.volatility={latest:{date:view.latestDate,price:18}};html=marketPageHTML('US',view);assert.match(html,/CNN Fear/);assert.match(html,/VIX 波动率/);
 view.sentiment.error='fetch failed';view.volatility.latest.date='2026-09-15';html=marketPageHTML('US',view);assert.ok(!html.includes('CNN Fear'));assert.ok(!html.includes('VIX 波动率'));assert.ok(!html.includes('2026-09-15'));
});

test('市场页面展示宏观观测日期和独立来源，不再绘制单独的个股图表与估值表',()=>{
 const view={market:'HK',date:'2026-10-28',benchmarks:[],sectors:[],holdings:[],summary:'Waiting',latestHoldings:[{name:'Synthetic holding',key:'HK.00001',date:'2026-10-27',source:'Futu OpenD',fundamentals:{peTTM:-5,pb:1.2,dividendYieldTTM:0}}],context:[{name:'1 个月 HIBOR',unit:'%',value:3,date:'2026-09-30',previousDate:'2026-09-29',change:.1,status:'lagged',lagDays:28,note:'港元短期资金成本',source:'香港金管局',url:'https://www.hkma.gov.hk/',history:[{date:'2026-09-29',value:2.9},{date:'2026-09-30',value:3}]}]};
 const html=marketPageHTML('HK',view);assert.match(html,/宏观与风险温度/);assert.match(html,/来源滞后 28 天/);assert.match(html,/2026-09-30/);assert.match(html,/较 2026-09-29 \+0.10 百分点/);assert.ok(!html.includes('market-fundamentals'));assert.ok(!html.includes('market-holdings'));assert.ok(!html.includes('我的港股持仓变动'));
});

test('OpenD 成交量与估值字段保留真实零，拒绝负成交量，盘中成交不混入收盘量比',async t=>{
 const s=setup(t),monday=new Date('2026-10-26T17:00:00Z');
 const activity=MARKET_SERIES.find(d=>d.key==='US.SPY');
 const raw={...quote(activity.key,100,99,'2026-10-26 13:00:00'),volume:0,turnover:-1};
 const q=normalizeMarketQuote(raw,activity,monday);assert.equal(q.volume,0);assert.equal(q.turnover,undefined);
 await refreshMarketOverview(s,{now:monday,provider:async input=>{assert.ok(input.historyKeys.includes('US.SPY'));return {quotes:[raw],history:[{key:'US.SPY',date:'2026-10-23',price:99,volume:200,turnover:19000}]};},fetchImpl:async()=>{throw new Error();}});
 const row=marketOverview(s,'US',monday).activity.find(d=>d.key==='US.SPY');assert.equal(row.latest.volume,0);assert.equal(row.closed.volume,200);assert.equal(row.relativeVolume,null);
 assert.match(marketPageHTML('US',marketOverview(s,'US',monday)),/成交活跃度/);
});

test('较新的价格源不覆盖正股估值资料的独立来源时间',async t=>{
 const s=setup(t),state=s.state();state.assets=[{id:'h',name:'Synthetic holding',type:'stock',currency:'HKD',quantity:1,unit:'股',value:null,autoPrice:true,security:{market:'HK',symbol:'00001'}}];s.save(state,state.revision);
 const time=new Date('2026-10-26T02:05:00Z');
 await refreshMarketOverview(s,{now:time,provider:async()=>({quotes:[{...quote('HK.00001',100,99,'2026-10-26 10:03:00'),equityValid:true,fundamentals:{peTTM:10,pb:1,dividendYieldTTM:0}}]}),fetchImpl:async url=>url.includes('qt.gtimg')?new Response(wire('hk00001','00001',102,99,'2026-10-26 10:05:00')):Promise.reject(new Error())});
 const v=marketOverview(s,'HK',time),h=v.latestHoldings[0];assert.equal(h.time,'2026-10-26 10:05:00');assert.equal(h.source,'腾讯证券公开行情');assert.equal(h.fundamentalsTime,'2026-10-26 10:03:00');assert.equal(h.fundamentalsSource,'Futu OpenD');assert.equal(h.fundamentals.dividendYieldTTM,0);
 assert.ok(!marketPageHTML('HK',v).includes('我的港股持仓变动'));
});

test('细分主题扩充到27个观察板块，跨日主题报价保留自身日期且不改变大行业广度与指数日期',t=>{
 const s=setup(t),time=new Date('2026-10-28T12:00:00Z');
 const broad=MARKET_SERIES.find(d=>d.key==='US.XLK'),detail=MARKET_SERIES.find(d=>d.key==='US.SOXX');
 s.setKV('markets_snapshot',{quotes:{'US..SPX':normalizeMarketQuote(quote('US..SPX',110,100,'2026-10-27 16:00:00'),def,time),'US.XLK':normalizeMarketQuote(quote('US.XLK',101,100,'2026-10-27 16:00:00'),broad,time),'US.SOXX':normalizeMarketQuote(quote('US.SOXX',104,100,'2026-10-28 01:00:00'),detail,time)}});
 const v=marketOverview(s,'US',time);assert.equal(v.latestDate,'2026-10-27');assert.equal(v.sectors.length,11);assert.equal(v.industries.length,16);assert.equal(v.latestRecap.sectorCoverage.total,11);assert.equal(v.latestRecap.sectorBreadth.total,1);assert.ok(!v.latestSummary.includes('半导体'));
 const html=marketPageHTML('US',v);assert.match(html,/27 个观察板块/);assert.match(html,/SOXX · 10-28/);assert.match(html,/半导体/);assert.match(html,/\+4.00%/);assert.ok(!/NaN|Infinity/.test(html));
 // Both groups use the same magnitude scale: a 1% gain is light when a theme gains 4%.
 assert.match(html,/sector-up sector-level-1[^>]*aria-label="科技/);assert.match(html,/sector-up sector-level-4[^>]*aria-label="半导体/);
 assert.equal(marketOverview(s,'HK',time).industries.length,0);
});
