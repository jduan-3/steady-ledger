import {MARKETS,securityKey,isoDay,marketDay} from './securities.mjs';
import {parseTencentQuote,canonicalUS} from './tencent.mjs';
import {stockQuote} from './market.mjs';
import {sessionClose} from './markets.mjs';

const pending=new WeakMap(),prefixes={SH:'sh',SZ:'sz',HK:'hk',US:'us'};
const number=value=>value==null||String(value).trim()===''?null:Number.isFinite(Number(value))?Number(value):null;
const positive=value=>{const n=number(value);return n>0?n:null;};
const nonnegative=value=>{const n=number(value);return n>=0?n:null;};
const localTime=(market,now)=>new Intl.DateTimeFormat('en-GB',{timeZone:MARKETS[market].timeZone,hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(now);
function codeFor(key,historyCode){
  const s=securityKey(key);if(!prefixes[s.market])throw new Error('目前支持沪深、港股和美股行情');
  if(historyCode){if(s.market!=='US'||!/^us[A-Z][A-Z0-9.-]{0,24}$/.test(historyCode)||canonicalUS(historyCode.slice(2))!==s.symbol)throw new Error('股票行情市场后缀与证券身份不一致');return historyCode;}
  return prefixes[s.market]+s.symbol;
}
function payload(input,key,code){
  if(code.startsWith('us'))codeFor(key,code);else if(code!==codeFor(key))throw new Error('股票行情请求代码不一致');
  const value=input?.data?.[code];if(input?.code!==0||!value)throw new Error('未返回对应股票行情');
  const raw=value.qt?.[code]?.[2],s=securityKey(key);
  if(raw&&(s.market==='US'?canonicalUS(raw)!==s.symbol:raw!==s.symbol))throw new Error('股票行情身份不匹配');
  return value;
}
const sourceUrl=key=>'https://gu.qq.com/'+codeFor(key)+'/gp';

export function parseStockMarketQuote(text,key,now=new Date()){
  const s=securityKey(key),code=codeFor(key),raw=parseTencentQuote(text,key),quote=stockQuote(raw,now),future=new Date(now.getTime()+300000);
  if(quote.time>marketDay(s.market,future)+' '+localTime(s.market,future))throw new Error('股票报价时间晚于当前时间');
  const row=[...text.matchAll(/v_([^=\s]+)="([^"\n]*)"/g)].find(m=>m[1].toUpperCase()===code.toUpperCase()),f=row[2].split('~');
  if(s.market==='US'&&f[35]&&f[35]!==s.currency)throw new Error('股票报价币种不一致');
  const open=positive(f[5]),high=positive(f[33]),low=positive(f[34]),volume=nonnegative(f[6]),cn=['SH','SZ'].includes(s.market);
  if(high!=null&&low!=null&&(high<low||quote.price>high+1e-6||quote.price<low-1e-6))throw new Error('股票报价高低价不一致');
  const summary=String(f[35]||'').split('/'),exact=cn&&summary.length===3&&positive(summary[0])===quote.price&&nonnegative(summary[1])===volume?nonnegative(summary[2]):null;
  // A shares: lots / CNY 10,000. HK and US: shares / original-currency units.
  // HK field[38] is a placeholder in observed responses; do not present it as zero turnover.
  return {...quote,source:'腾讯证券公开行情',sourceUrl:sourceUrl(key),timeZone:MARKETS[s.market].timeZone,open,high,low,volume:volume==null?null:volume*(cn?100:1),amount:exact??(nonnegative(f[37])==null?null:Number(f[37])*(cn?10000:1)),turnover:cn||s.market==='US'?nonnegative(f[38]):null,percent:quote.previous?(quote.price/quote.previous.price-1)*100:null,...(raw.historyCode?{historyCode:codeFor(key,raw.historyCode)}:{}),session:s.market==='US'?'regular':'source_session',delayed:f[0]==='delay'};
}

export function parseStockMarketMinutes(input,key,code=codeFor(key),now=new Date(),calendars={}){
  const s=securityKey(key),wire=payload(input,key,code).data,today=marketDay(s.market,now),clock=localTime(s.market,now);
  if(!Array.isArray(wire?.data))throw new Error('股票分时格式无效');
  const date=isoDay(wire.date);if(date>today)throw new Error('股票分时日期无效');
  const points=[];let previousTime='',previousVolume=0,previousAmount=0,volumeDecreases=0,amountDecreases=0;
  for(const line of wire.data){
    const [stamp,rawPrice,rawVolume,rawAmount]=String(line).trim().split(/\s+/),price=positive(rawPrice),volume=nonnegative(rawVolume),amount=nonnegative(rawAmount);
    if(!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(stamp)||stamp<=previousTime||price==null||volume==null)throw new Error('股票分时时点、价格或成交量无效');
    const time=stamp.slice(0,2)+':'+stamp.slice(2),cumulativeVolume=volume*(['SH','SZ'].includes(s.market)?100:1);
    if(date===today&&time>clock.slice(0,5))throw new Error('股票分时时间无效');
    if(s.market==='US'&&(time<'09:30'||time>sessionClose('US',date,calendars)))throw new Error('美股分时包含非普通交易时段');
    const volumeDecrease=cumulativeVolume<previousVolume,amountDecrease=amount!=null&&previousAmount!=null&&amount<previousAmount;
    if(volumeDecrease)volumeDecreases++;if(amountDecrease)amountDecreases++;
    points.push({time,price,volume:volumeDecrease?null:cumulativeVolume-previousVolume,amount:amount==null||previousAmount==null||amountDecrease?null:amount-previousAmount,cumulativeVolume,cumulativeAmount:amount,...(volumeDecrease?{volumeStatus:'cumulative_decrease'}:{}),...(amountDecrease?{amountStatus:'cumulative_decrease'}:{})});
    previousTime=stamp;previousVolume=cumulativeVolume;previousAmount=amount;
  }
  if(!points.length)throw new Error('股票分时数据为空');
  return {date,points,currency:s.currency,timeZone:MARKETS[s.market].timeZone,volumeUnit:'股',source:'腾讯证券分时行情',sourceUrl:sourceUrl(key),fetchedAt:now.toISOString(),session:s.market==='US'?'regular':'source_session',volumeDecreases,amountDecreases};
}

export function parseStockMarketHistory(input,key,code=codeFor(key),now=new Date(),calendars={}){
  const s=securityKey(key),rows=payload(input,key,code).day,today=marketDay(s.market,now),clock=localTime(s.market,now);
  if(!Array.isArray(rows))throw new Error('未取得不复权股票日线');
  const points=[],dates=new Set();
  for(const row of rows.slice(-60)){
    const date=isoDay(row[0]),open=positive(row[1]),price=positive(row[2]),high=positive(row[3]),low=positive(row[4]),volume=nonnegative(row[5]);
    if(date>today||dates.has(date)||[open,price,high,low].some(v=>v==null)||high<Math.max(open,price)||low>Math.min(open,price)||high<low)throw new Error('股票日线价格或日期无效');
    const close=['SH','SZ'].includes(s.market)?'15:15':sessionClose(s.market,date,calendars).slice(0,3)+'15';
    points.push({date,open,price,high,low,volume:volume==null?null:volume*(['SH','SZ'].includes(s.market)?100:1),status:date===today&&clock<close?'partial':'complete'});dates.add(date);
  }
  if(!points.length)throw new Error('股票日线数据为空');points.sort((a,b)=>a.date.localeCompare(b.date));
  return {points,basis:'unadjusted',currency:s.currency,timeZone:MARKETS[s.market].timeZone,volumeUnit:'股',source:'腾讯证券不复权日线',sourceUrl:sourceUrl(key),fetchedAt:now.toISOString()};
}

export function stockMarketData(store,assetId){
  const asset=store.state({raw:true}).assets.find(a=>a.id===assetId);if(!asset)throw Object.assign(new Error('资产不存在'),{status:404});
  if(asset.type!=='stock')return {assetId,status:'not_applicable'};
  if(!asset.security?.key||!prefixes[asset.security.market])return {assetId,status:'unsupported',message:'补充沪深、港股或美股证券代码后可查看行情。'};
  const s=securityKey(asset.security.key),cached=store.getKV('stock_market_data:'+s.key),errors=cached?.errors||{},hasData=Boolean(cached?.quote||cached?.intraday||cached?.history);
  return {assetId,instrument:{...s,name:asset.name,timeZone:MARKETS[s.market].timeZone,marketLabel:MARKETS[s.market].label},status:!hasData?'unavailable':Object.keys(errors).length?'cached':'available',quote:cached?.quote||null,intraday:cached?.intraday||null,history:cached?.history||null,attemptedAt:cached?.attemptedAt||null,errors,notice:'股票市场行情按来源时间和原币展示，价格涨跌不代表你的实际持仓收益；图表数据不产生交易或现金变动。'};
}

export function stockMarketSummary(view){
  const series=(value,section)=>{if(!value)return null;const {points,...metadata}=value;return {...metadata,count:points.length,latest:points.at(-1)||null,readWith:{tool:'get_page_data',page:'instruments',section,assetId:view.assetId}};};
  return {...view,intraday:series(view.intraday,'stockMinutes'),history:series(view.history,'stockHistory')};
}

export function refreshStockMarketData(store,assetId,{fetchImpl=fetch,now=new Date()}={}){
  const view=stockMarketData(store,assetId);if(!view.instrument)return Promise.resolve(view);
  const {key,market}=view.instrument,cacheKey='stock_market_data:'+key,cached=store.getKV(cacheKey);
  if(!pending.has(store))pending.set(store,new Map());const tasks=pending.get(store);
  if(tasks.has(key))return tasks.get(key).then(()=>stockMarketData(store,assetId));
  if(cached&&now-Date.parse(cached.attemptedAt)>=0&&now-Date.parse(cached.attemptedAt)<60000)return Promise.resolve(view);
  const read=async url=>{const r=await fetchImpl(url,{headers:{Referer:'https://gu.qq.com/','User-Agent':'Steady/1.0'},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('股票行情暂不可用');return new TextDecoder('gb18030').decode(await r.arrayBuffer());};
  const task=(async()=>{
    const next={...cached,attemptedAt:now.toISOString(),errors:{}};
    try{const q=parseStockMarketQuote(await read('https://qt.gtimg.cn/q='+codeFor(key)),key,now);if(cached?.quote&&q.time<cached.quote.time)throw new Error();next.quote=q;}catch{next.errors.quote='最新报价暂不可用，保留已有报价和实际时间。';}
    const code=market==='US'?next.quote?.historyCode:codeFor(key);
    if(code){
      codeFor(key,market==='US'?code:undefined);
      const calendar=store.getKV('markets_snapshot',{}).calendars||{},results=await Promise.allSettled([
        read('https://web.ifzq.gtimg.cn/appstock/app/'+(market==='US'?'UsMinute':'minute')+'/query?code='+code).then(t=>parseStockMarketMinutes(JSON.parse(t),key,code,now,calendar)),
        read('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+code+',day,,,60,').then(t=>parseStockMarketHistory(JSON.parse(t),key,code,now,calendar))
      ]);
      for(const [i,section] of ['intraday','history'].entries()){
        const result=results[i],old=cached?.[section],stamp=v=>section==='intraday'?v.date:v.points.at(-1).date;
        if(result.status==='fulfilled'&&(!old||stamp(result.value)>=stamp(old)))next[section]=result.value;
        else next.errors[section]='最新'+(section==='intraday'?'分时':'日线')+'暂不可用，保留已有数据和实际日期。';
      }
    }else{next.errors.intraday='尚未核验美股市场后缀，分时待更新。';next.errors.history='尚未核验美股市场后缀，日线待更新。';}
    if(store.state({raw:true}).assets.find(a=>a.id===assetId)?.security?.key===key)store.setKV(cacheKey,next);
  })().finally(()=>tasks.delete(key));tasks.set(key,task);
  return task.then(()=>stockMarketData(store,assetId));
}
