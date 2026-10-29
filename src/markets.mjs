import { runOpenD } from './market.mjs';
import { isoDay, marketDay } from './securities.mjs';
import { canonicalUS } from './tencent.mjs';
import { marketRecap } from './market-summary.mjs';
import { refreshBuffett, availableBuffett } from './buffett.mjs';
import { refreshMarketContext, marketContext, activityReading } from './market-context.mjs';

const index = (market, key, name, code, extra={}) => ({ market, key, name, code, kind:'index', ...extra });
export const MARKET_SERIES = [
  index('US','US..SPX','标普 500','us.INX'), index('US','US..DJI','道琼斯','us.DJI'), index('US','US..IXIC','纳斯达克综合','us.IXIC'),
  index('US','US..VIX','VIX 波动率','us.VIX',{kind:'volatility'}),
  index('HK','HK.800000','恒生指数','hkHSI'), index('HK','HK.800100','恒生国企','hkHSCEI'), index('HK','HK.800700','恒生科技','hkHSTECH'),
  ...[['XLK','科技'],['XLF','金融'],['XLE','能源'],['XLV','医疗'],['XLY','可选消费'],['XLP','必需消费'],['XLI','工业'],['XLB','原材料'],['XLRE','房地产'],['XLU','公用事业'],['XLC','通信服务']].map(([symbol,name])=>({market:'US',key:'US.'+symbol,name,code:'us'+symbol,kind:'sector'}))
];
MARKET_SERIES.push(...[
  ['SOXX','半导体'],['IGV','软件'],['FDN','互联网'],['CIBR','网络安全'],['SKYY','云计算'],['BOTZ','机器人与 AI'],
  ['XBI','生物科技'],['IHI','医疗器械'],['KRE','区域银行'],['KIE','保险业'],['ITB','住宅建筑'],['XRT','零售业'],
  ['JETS','航空业'],['ITA','航空航天与国防'],['XOP','油气开采'],['GDX','金矿股']
].map(([symbol,name])=>({market:'US',key:'US.'+symbol,name,code:'us'+symbol,kind:'industry'})));
MARKET_SERIES.push(...[['US','SPY','标普 500 ETF'],['US','QQQ','纳斯达克 100 ETF'],['US','IWM','罗素 2000 ETF'],['HK','02800','盈富基金'],['HK','03033','恒生科技 ETF']].map(([market,symbol,name])=>({market,key:market+'.'+symbol,name,code:market.toLowerCase()+symbol,kind:'activity'})));
const CNN_URL='https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const CACHE='markets_snapshot';
const finite = value => value!==null && value!==undefined && value!=='' && Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value)>0;
const round = n => Math.round(n*100)/100;
function keepFundamentals(cache,quote) {
  if(!quote.fundamentals)return;
  const previous=cache.fundamentalQuotes?.[quote.key];
  if(!previous||(quote.time||quote.date)>=(previous.time||previous.date))cache.fundamentalQuotes={...cache.fundamentalQuotes,[quote.key]:quote};
}
function marketDefinitions(store,market) {
  const defs=new Map(MARKET_SERIES.filter(d=>!market||d.market===market).map(d=>[d.key,d]));
  for(const a of store.state({raw:true}).assets) {
    const s=a.security;
    if(a.type!=='stock'||!['US','HK'].includes(s?.market)||(market&&s.market!==market)||defs.has(s.key))continue;
    defs.set(s.key,{market:s.market,key:s.key,name:a.name,code:s.market.toLowerCase()+s.symbol,kind:'holding'});
  }
  return [...defs.values()];
}
export function sessionClose(market,date,calendars={}) {
  const half=calendars[market]?.find(d=>d.time===date)?.trade_date_type==='HALF';
  return market==='US'?(half?'13:00':'16:00'):(half?'12:00':'16:00');
}
function completed(market,date,now,calendars) {
  const today=marketDay(market,now);
  if(date<today)return true;
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:market==='US'?'America/New_York':'Asia/Hong_Kong',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  const settled=sessionClose(market,date,calendars).slice(0,3)+'15';
  return date===today && time>=settled;
}
export function normalizeMarketQuote(raw,def,now=new Date(),source='Futu OpenD') {
  const time=typeof raw.time==='string'?raw.time.replace(/\.\d+$/,''):raw.time;
  const date=isoDay(raw.date||String(time).slice(0,10));
  if(raw.key!==def.key || !positive(raw.price) || date>marketDay(def.market,now))throw new Error('市场行情无效');
  if(time && !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time))throw new Error('行情时间无效');
  const previous=positive(raw.previous?.price)?Number(raw.previous.price):null,price=Number(raw.price);
  const activity=Object.fromEntries(['volume','turnover'].filter(k=>finite(raw[k])&&Number(raw[k])>=0).map(k=>[k,Number(raw[k])]));
  const fundamentals=raw.equityValid===true?Object.fromEntries(['peTTM','pb','dividendYieldTTM'].map(k=>[k,finite(raw.fundamentals?.[k])?Number(raw.fundamentals[k]):null])):null;
  return {key:def.key,date,price,previous,change:previous==null?null:round(price-previous),percent:previous==null?null:(price/previous-1)*100,...activity,...(fundamentals?{equityValid:true,fundamentals}:{}),...(time?{time}:{}),source,fetchedAt:now.toISOString()};
}
export function parseMarketQuotes(text,now=new Date(),defs=MARKET_SERIES) {
  const rows=[...text.matchAll(/v_([^=\s]+)="([^"\n]*)"/g)],out=[];
  for(const def of defs) {
    const match=rows.find(r=>r[1]===def.code);if(!match)continue;
    const f=match[2].split('~'),expected=def.code.slice(2);
    if(canonicalUS(f[2])!==expected.toUpperCase())continue;
    let time=f[30]?.replaceAll('/','-');if(/^\d{14}$/.test(time))time=time.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,'$1-$2-$3 $4:$5:$6');
    try{out.push(normalizeMarketQuote({key:def.key,price:f[3],previous:{price:f[4]},time},def,now,'腾讯证券公开行情'));}catch{}
  }
  return out;
}
async function responseText(url,fetchImpl) {
  const r=await fetchImpl(url,{headers:{Referer:'https://gu.qq.com/','User-Agent':'Steady/1.0'},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('公开行情暂不可用');
  return new TextDecoder('gb18030').decode(await r.arrayBuffer());
}
export function parseMarketHistory(input,def,now=new Date()) {
  if(input.code!==0 || !Array.isArray(input.data?.[def.code]?.day))throw new Error('历史行情格式无效');
  const days=input.data[def.code].day,out=[];
  for(let i=0;i<days.length;i++) {
    const row=days[i];try{const date=isoDay(row[0]);if(date>marketDay(def.market,now)||!positive(row[2]))continue;
      out.push(normalizeMarketQuote({key:def.key,date,price:row[2],previous:{price:i>0?days[i-1][2]:null}},def,now,'腾讯证券日 K 线'));
    }catch{}
  }
  return out;
}
export function parseFearGreed(input,now=new Date()) {
  const f=input?.fear_and_greed,timestamp=new Date(f?.timestamp);
  if(!finite(f?.score)||f.score<0||f.score>100||!Number.isFinite(timestamp.getTime())||timestamp>now)throw new Error('CNN 指数格式无效');
  const rating={'extreme fear':'极度恐惧',fear:'恐惧',neutral:'中性',greed:'贪婪','extreme greed':'极度贪婪'};
  const history=Array.isArray(input.fear_and_greed_historical?.data)?input.fear_and_greed_historical.data:[];
  return {score:Number(f.score),rating:rating[String(f.rating).toLowerCase()]||'未分类',date:marketDay('US',timestamp),timestamp:timestamp.toISOString(),previous:finite(f.previous_close)?Number(f.previous_close):null,history:history.filter(p=>finite(p.x)&&finite(p.y)&&p.y>=0&&p.y<=100&&Number(p.x)<=now.getTime()).slice(-40).map(p=>({date:marketDay('US',new Date(Number(p.x))),price:Number(p.y)})),source:'CNN Fear & Greed Index',url:'https://www.cnn.com/markets/fear-and-greed',fetchedAt:now.toISOString()};
}
async function fetchSentiment(fetchImpl,now) {
  const r=await fetchImpl(CNN_URL,{headers:{Accept:'application/json','User-Agent':'Steady/1.0'},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error([403,418,429].includes(r.status)?`CNN 限制自动请求（HTTP ${r.status}）`:'CNN 数据源暂不可用');
  return parseFearGreed(await r.json(),now);
}
const pending=new WeakMap();
export function refreshMarketOverview(store,options={}) {
  if(pending.has(store))return pending.get(store);
  const task=updateOverview(store,options).finally(()=>pending.delete(store));pending.set(store,task);return task;
}
async function updateLiveQuotes(store,old,{provider,fetchImpl,now,market}) {
  const age=now-Date.parse(old.quoteAttemptedAt?.[market]||old.attemptedAt);
  if(Number.isFinite(age)&&age>=0&&age<60000)return old;
  const defs=marketDefinitions(store,market);
  const results=await Promise.allSettled([
    provider({action:'overview-live',keys:defs.map(d=>d.key)}),
    responseText('https://qt.gtimg.cn/q='+defs.map(d=>d.code).join(','),fetchImpl).then(t=>parseMarketQuotes(t,now,defs))
  ]);
  const next={...old,quotes:{...old.quotes},quoteAttemptedAt:{...old.quoteAttemptedAt,[market]:now.toISOString()},quoteErrors:{...old.quoteErrors}};
  const opend=results[0].status==='fulfilled'?results[0].value:null;
  if(opend)next.opend={connected:opend.global?.qot_logined===true,state:opend.global||{},message:opend.global?.qot_logined?'已连接；美股指数由公开行情补充':opend.errors?.[0]||'OpenD 暂未连接',checkedAt:now.toISOString()};
  const quotes=[];
  for(const raw of opend?.quotes||[]){const def=defs.find(d=>d.key===raw.key);if(def)try{quotes.push(normalizeMarketQuote(raw,def,now));}catch{}}
  if(results[1].status==='fulfilled')quotes.push(...results[1].value.filter(q=>defs.some(d=>d.key===q.key)));
  let accepted=0;
  for(const q of quotes) {
    keepFundamentals(next,q);
    const previous=next.quotes[q.key];
    if(!previous||q.date>previous.date||(q.date===previous.date&&(q.time||'')>=(previous.time||''))){next.quotes[q.key]=q;accepted++;}
  }
  next.quoteErrors[market]=accepted?null:'本次行情快照更新失败，保留已有数据';
  store.setKV(CACHE,next);return next;
}
async function updateOverview(store,{provider=runOpenD,fetchImpl=fetch,now=new Date(),force=false,live=false,market}={}) {
  if(live&&!['US','HK'].includes(market))throw new Error('请选择美国或港股市场');
  const old=store.getKV(CACHE,{}),age=now-Date.parse(old.attemptedAt),interval=force?60000:old.error?5*60000:30*60000;
  if(Number.isFinite(age)&&age>=0&&age<interval)return live?updateLiveQuotes(store,old,{provider,fetchImpl,now,market}):old;
  const defs=marketDefinitions(store),indices=MARKET_SERIES.filter(d=>d.kind==='index'),activities=MARKET_SERIES.filter(d=>d.kind==='activity');
  const results=await Promise.allSettled([
    provider({action:'overview',keys:defs.map(d=>d.key),historyKeys:[...indices.filter(d=>d.market==='HK'),...activities].map(d=>d.key)}),
    responseText('https://qt.gtimg.cn/q='+defs.map(d=>d.code).join(','),fetchImpl).then(t=>parseMarketQuotes(t,now,defs)),
    ...indices.map(d=>responseText('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+d.code+',day,,,45,qfq',fetchImpl).then(t=>parseMarketHistory(JSON.parse(t),d,now))),
    fetchSentiment(fetchImpl,now),
    refreshBuffett(old.buffett,{fetchImpl,now}),
    refreshMarketContext(old.context,{fetchImpl,now})
  ]);
  const next={...old,quotes:{...old.quotes},histories:{...old.histories},attemptedAt:now.toISOString(),error:null};
  const opend=results[0].status==='fulfilled'?results[0].value:null;
  next.opend={connected:opend?.global?.qot_logined===true,state:opend?.global||{},message:opend?.global?.qot_logined?'已连接；美股指数由公开行情补充':opend?.errors?.[0]||'OpenD 暂未连接',checkedAt:now.toISOString()};
  next.calendars={...old.calendars,...opend?.calendars};
  let accepted=0;const acceptedMarkets=new Set();
  const put=q=>{keepFundamentals(next,q);const prev=next.quotes[q.key];if(!prev||q.date>prev.date||(q.date===prev.date&&(q.time||'')>=(prev.time||''))){next.quotes[q.key]=q;accepted++;acceptedMarkets.add(q.key.startsWith('US.')?'US':'HK');}};
  for(const r of opend?.quotes||[]){const d=defs.find(d=>d.key===r.key);if(d)try{put(normalizeMarketQuote(r,d,now));}catch{}}
  if(results[1].status==='fulfilled')for(const q of results[1].value){const own=next.quotes[q.key];if(!own||q.date>own.date||(q.date===own.date&&(q.time||'')>(own.time||'')))put(q);}
  const merge=(key,rows)=>{const days=new Map((next.histories[key]||[]).map(r=>[r.date,r]));for(const q of rows)if(completed(key.startsWith('US.')?'US':'HK',q.date,now,next.calendars)){const prev=days.get(q.date);if(!prev||q.source==='Futu OpenD'||prev.source!=='Futu OpenD')days.set(q.date,q);}next.histories[key]=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-50);};
  for(let i=0;i<indices.length;i++){const result=results[i+2];if(result.status==='fulfilled')merge(indices[i].key,result.value);}
  for(const raw of opend?.history||[]){const d=MARKET_SERIES.find(d=>d.key===raw.key);if(d)try{merge(d.key,[normalizeMarketQuote(raw,d,now)]);}catch{}}
  // A timestamped quote is a closing observation only after the regular session ends.
  for(const def of MARKET_SERIES){const q=next.quotes[def.key];if(q?.time&&q.time.slice(11,16)>=sessionClose(def.market,q.date,next.calendars))merge(def.key,[q]);}
  const sentiment=results.at(-3);next.sentiment=sentiment.status==='fulfilled'?{...sentiment.value,error:null}:{...old.sentiment,error:sentiment.reason?.message?.startsWith('CNN ')?sentiment.reason.message:'CNN 数据源暂不可用（网络连接失败或响应无效）',attemptedAt:now.toISOString()};
  if(results.at(-2).status==='fulfilled')next.buffett=results.at(-2).value;
  if(results.at(-1).status==='fulfilled')next.context=results.at(-1).value;
  if(!accepted)next.error='行情更新失败，保留上次数据';
  else next.updatedAt=now.toISOString();
  next.quoteAttemptedAt=Object.fromEntries(['US','HK'].map(m=>[m,now.toISOString()]));
  next.quoteErrors=Object.fromEntries(['US','HK'].map(m=>[m,acceptedMarkets.has(m)?null:'本次行情快照更新失败，保留已有数据']));
  store.setKV(CACHE,next);return next;
}
export function marketOverview(store,market,now=new Date()) {
  if(!['US','HK'].includes(market))throw new Error('请选择美国或港股市场');
  const cache=store.getKV(CACHE,{}),defs=MARKET_SERIES.filter(d=>d.market===market),calendars=cache.calendars||{};
  const rows=defs.map(d=>{
    const history=(cache.histories?.[d.key]||[]).filter(q=>completed(market,q.date,now,calendars)),q=history.at(-1),live=cache.quotes?.[d.key];
    const newer=live&&(!q||live.date>q.date||(live.date===q.date&&(live.time||'').slice(11,16)>=(q.time?.slice(11,16)||sessionClose(market,q.date,calendars))));
    return {...d,quote:q||null,history:history.slice(-30),live:live||null,latest:newer?live:q||null};
  });
  const benchmarks=rows.filter(d=>d.kind==='index'),date=benchmarks.map(d=>d.quote?.date).filter(Boolean).sort().at(-1)||null;
  const assets=store.state({raw:true}).assets.filter(a=>a.type==='stock'&&a.security?.market===market);
  const holdingQuotes=new Map(assets.map(a=>{
    const candidates=[cache.quotes?.[a.security.key],store.getKV('stock_quote:'+a.security.key),...store.priceHistory(a.security.key)],valid=[];
    for(const q of candidates)if(q)try{
      valid.push(normalizeMarketQuote({...q,previous:{price:typeof q.previous==='object'?q.previous?.price:q.previous}},a.security,now,q.source||'Futu OpenD'));
    }catch{}
    const stamp=q=>q.time||q.date+' '+sessionClose(market,q.date,calendars)+':00';
    valid.sort((a,b)=>stamp(b).localeCompare(stamp(a)));
    return [a.id,valid[0]||null];
  }));
  const latestDate=[...rows.filter(d=>d.kind!=='industry').map(d=>d.latest?.date),...[...holdingQuotes.values()].map(q=>q?.date)].filter(Boolean).sort().at(-1)||null;
  // Completed-session fields remain the input to daily briefs and historical tools.
  const portfolios=store.state().assets.filter(a=>a.type==='stock'&&a.security?.market===market).map(a=>{
    const candidates=[store.getKV('stock_quote:'+a.security.key),...store.priceHistory(a.security.key)];
    const q=candidates.find(q=>q?.date===date&&positive(q.previous?.price)&&(q.basis==='unadjusted_close'||q.time?.slice(11,16)>=sessionClose(market,date,calendars))),end=Boolean(q);
    return {id:a.id,name:a.name,key:a.security.key,quantity:a.quantity,currency:a.currency,date:q?.date||null,percent:end?(q.price/q.previous.price-1)*100:null,amount:end&&finite(a.quantity)?round((q.price-q.previous.price)*a.quantity):null};
  });
  const available=portfolios.filter(a=>a.amount!=null),portfolioAmount=available.length?round(available.reduce((s,a)=>s+a.amount,0)):null;
  const labels=benchmarks.filter(d=>d.quote?.date===date&&d.quote.percent!=null).map(d=>`${d.name}${d.quote.percent>=0?'上涨':'下跌'}${Math.abs(d.quote.percent).toFixed(2)}%`);
  const latestHoldings=assets.map(a=>{
    const q=holdingQuotes.get(a.id),current=q?.date===latestDate,known=current&&q.percent!=null;
    const f=cache.fundamentalQuotes?.[a.security.key]||(q?.fundamentals?q:null);
    return {id:a.id,name:a.name,key:a.security.key,quantity:a.quantity,currency:a.currency,date:q?.date||null,time:q?.time||null,source:q?.source||null,fundamentals:f?.fundamentals||null,fundamentalsDate:f?.date||null,fundamentalsTime:f?.time||null,fundamentalsSource:f?.source||null,percent:known?q.percent:null,amount:known&&finite(a.quantity)?round((q.price-q.previous)*a.quantity):null,status:!q?'missing':!current?'stale':!known?'missing_previous':'current'};
  });
  const latestAvailable=latestHoldings.filter(h=>h.amount!=null);
  const latestPortfolio={date:latestDate,amount:latestAvailable.length?round(latestAvailable.reduce((s,h)=>s+h.amount,0)):null,covered:latestAvailable.length,total:latestHoldings.length,currency:market==='US'?'USD':'HKD'};
  const sectors=rows.filter(d=>d.kind==='sector'),volatility=rows.find(d=>d.kind==='volatility')||null;
  const snapshotRow=d=>({key:d.key,name:d.name,...d.latest});
  const latestRecap=marketRecap({market,date:latestDate,indices:benchmarks.map(snapshotRow),sectors:sectors.map(snapshotRow),sectorTotal:sectors.length,volatility:volatility?.latest,sentiment:cache.sentiment});
  return {market,date,latestDate,benchmarks,sectors,industries:rows.filter(d=>d.kind==='industry'),volatility,context:marketContext(cache.context,market,now),activity:rows.filter(d=>d.kind==='activity').map(activityReading),holdings:portfolios,portfolio:{amount:portfolioAmount,covered:available.length,total:portfolios.length,currency:market==='US'?'USD':'HKD'},summary:labels.length?`${date}：${labels.join('，')}。`:'尚无完整交易日数据，等待更新。',latestHoldings,latestPortfolio,latestRecap,buffett:market==='US'?availableBuffett(cache.buffett,now):null,latestSummary:latestRecap.sections.map(s=>`${s.label}：${s.text}`).join('\n')||'同日行情待更新。',opend:cache.opend||null,sentiment:latestRecap.sentiment,attemptedAt:cache.attemptedAt||null,updatedAt:cache.updatedAt||null,latestCheckedAt:cache.quoteAttemptedAt?.[market]||cache.attemptedAt||null,latestError:cache.quoteErrors?.[market]||null,error:cache.error||null,methods:{change:'指数、行业与持仓展示最新可用快照，涨跌相对前收盘；每日简报保留完整交易日收盘记录。',sectors:'11 只美国行业 ETF 的价格涨跌；不代表全市场涨跌家数，不计分红。',portfolio:'按当前持股数 × 最新价与前收盘价之差估算，不含交易和分红；仅合计页面所示交易日的有效行情，缺失或跨日行情不按零处理。',history:'最近最多 30 个有数据的交易日，不复权收盘价；如有更新报价，图中以虚线附加最新快照，不写入收盘历史。',refresh:'打开市场页时，每分钟同时检查指数、行业 ETF 与已登记持仓的行情快照；历史与情绪数据每 30 分钟检查。数据以来源时间为准，不保证实时。'}};
}
