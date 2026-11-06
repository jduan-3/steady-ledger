import { isoDay, marketDay } from './securities.mjs';
import { parseReferenceQuote, parseReferenceHistory } from './fund-reference.mjs';

export const CN_BENCHMARKS = [
  {key:'SH.000001',name:'上证指数'}, {key:'SZ.399001',name:'深证成指'},
  {key:'SZ.399006',name:'创业板指'}, {key:'SH.000300',name:'沪深300'}
];
export const WATCHED_ETFS = [
  {key:'SH.510300',name:'华泰柏瑞沪深300ETF',index:'沪深300'},
  {key:'SH.510310',name:'易方达沪深300ETF',index:'沪深300'},
  {key:'SH.510330',name:'华夏沪深300ETF',index:'沪深300'},
  {key:'SZ.159919',name:'嘉实沪深300ETF',index:'沪深300'},
  {key:'SH.510050',name:'华夏上证50ETF',index:'上证50'},
  {key:'SH.510500',name:'南方中证500ETF',index:'中证500'}
];
const CACHE='cn_market_snapshot', pending=new WeakMap();
const codeOf=key=>key.slice(0,2).toLowerCase()+key.slice(3);
const numeric=value=>value==null||typeof value==='boolean'||String(value).trim()===''?null:Number.isFinite(Number(String(value).replaceAll(',','')))?Number(String(value).replaceAll(',','')):null;
const nonnegative=value=>{const n=numeric(value);return n!=null&&n>=0?n:null;};
const timeFormat=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const shareDay=(value,now)=>{const date=isoDay(value);if(date>marketDay('SH',now)||[0,6].includes(new Date(date).getUTCDay()))throw new Error('份额日期无效');return date;};

export function parseETFFlows(input,now=new Date()) {
  if(input?.rc!==0||!Array.isArray(input.data?.diff))throw new Error('ETF资金流数据格式无效');
  const rows=[],seen=new Set();
  for(const row of input.data.diff){
    const def=WATCHED_ETFS.find(d=>d.key.slice(3)===row.f12&&numeric(row.f13)===(d.key.startsWith('SH.')?1:0));
    if(!def||seen.has(def.key))continue;
    try{
      const price=numeric(row.f2),stamp=numeric(row.f124),date=isoDay(row.f297);
      if(!(price>0)||!(stamp>0)||stamp*1000>now.getTime()+300000)continue;
      const time=timeFormat.format(new Date(stamp*1000));
      if(time.slice(0,10)!==date||date>marketDay('SH',now))continue;
      rows.push({key:def.key,quote:{price,percent:numeric(row.f3),amount:nonnegative(row.f6),date,time,source:'东方财富公开ETF行情',fetchedAt:now.toISOString()},flow:{mainNet:numeric(row.f62),superNet:numeric(row.f66),date,time,source:'东方财富逐单资金流估算',fetchedAt:now.toISOString()}});
      seen.add(def.key);
    }catch{}
  }
  if(!rows.length)throw new Error('未取得有效ETF资金流');
  return rows;
}

export function parseSSEShares(input,date,now=new Date()) {
  shareDay(date,now);
  if(!Array.isArray(input?.result))throw new Error('上交所份额数据格式无效');
  const defs=WATCHED_ETFS.filter(d=>d.key.startsWith('SH.')),rows=[];
  for(const def of defs){
    const row=input.result.find(r=>r.SEC_CODE===def.key.slice(3));
    if(!row)continue;
    const shares=nonnegative(row.TOT_VOL);
    if(row.STAT_DATE!==date||shares==null)throw new Error('上交所份额日期或单位无效');
    rows.push({key:def.key,date,shares:Math.round(shares*10000),source:'上交所清算后份额'});
  }
  if(input.result.length&&rows.length!==defs.length)throw new Error('上交所观察样本份额不完整');
  return rows;
}

export function parseSZSEShares(input,now=new Date()) {
  const report=Array.isArray(input)?input.find(r=>r.metadata?.catalogid==='fund_jjgm'):null;
  if(!Array.isArray(report?.data)||!String(report.metadata.cols?.current_size).includes('万份'))throw new Error('深交所份额数据格式或单位无效');
  const rows=[];
  for(const row of report.data){
    if(row.fund_code!=='159919')continue;
    const date=shareDay(row.size_date,now),shares=nonnegative(row.current_size);
    // The exchange warns that same-day figures are provisional until the next morning.
    if(date===marketDay('SH',now))continue;
    if(shares==null)throw new Error('深交所份额无效');
    rows.push({key:'SZ.159919',date,shares:Math.round(shares*10000),source:'深交所历史份额'});
  }
  if(!rows.length)throw new Error('未取得深交所已确认份额');
  return rows;
}

function mergeDays(old=[],rows=[]) {
  return [...new Map([...old,...rows].map(r=>[r.date,r])).values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);
}
export function etfDailyReading(shares=[],closes=[]) {
  const latest=shares.at(-1);
  if(!latest)return null;
  const priceIndex=closes.findIndex(r=>r.date===latest.date),price=closes[priceIndex]?.price??null;
  const previousDate=priceIndex>0?closes[priceIndex-1].date:null;
  const previous=previousDate?shares.find(r=>r.date===previousDate):null;
  const delta=previous?latest.shares-previous.shares:null;
  return {...latest,previousDate:previous?.date??null,delta,price,estimatedNet:delta!=null&&price!=null?Math.round(delta*price*100)/100:null,priceSource:priceIndex>=0?closes[priceIndex].source:null};
}

export function cnMarketOverview(store,now=new Date()) {
  const cache=store.getKV(CACHE,{quotes:{},flows:{},shares:{},closes:{}});
  const items=WATCHED_ETFS.map(def=>({...def,quote:cache.quotes?.[def.key]||null,flow:cache.flows?.[def.key]||null,daily:etfDailyReading(cache.shares?.[def.key],cache.closes?.[def.key])}));
  const commonDate=items[0]?.flow?.date;
  const mainNet=commonDate&&items.every(i=>i.flow?.date===commonDate&&i.flow.mainNet!=null)?items.reduce((sum,i)=>sum+i.flow.mainNet,0):null;
  const dailyDate=items[0]?.daily?.date;
  const estimatedNet=dailyDate&&items.every(i=>i.daily?.date===dailyDate&&i.daily.estimatedNet!=null)?items.reduce((sum,i)=>sum+i.daily.estimatedNet,0):null;
  return {benchmarks:CN_BENCHMARKS.map(def=>({...def,quote:cache.quotes?.[def.key]||null})),items,summary:{mainNet,flowDate:mainNet==null?null:commonDate,estimatedNet,dailyDate:estimatedNet==null?null:dailyDate},attemptedAt:cache.attemptedAt||null,sharesAttemptedAt:cache.sharesAttemptedAt||null,errors:cache.errors||{},asOf:now.toISOString(),notice:'重点宽基ETF资金动向，不代表国家队实际买卖。盘中主力资金是二级市场逐单估算；每日净申赎按份额变化乘以同日收盘价估算。'};
}

async function read(url,fetchImpl,referer,json=true) {
  const response=await fetchImpl(String(url),{headers:{Referer:referer,'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('公开数据源暂不可用');
  return json?response.json():new TextDecoder('gb18030').decode(await response.arrayBuffer());
}
function requestURL(base,params){const url=new URL(base);url.search=new URLSearchParams(params).toString();return url;}
function putQuote(cache,key,quote){if(!cache.quotes[key]||quote.time>=cache.quotes[key].time)cache.quotes[key]=quote;}

export function refreshCNMarket(store,{fetchImpl=fetch,now=new Date()}={}) {
  if(pending.has(store))return pending.get(store);
  const task=updateCNMarket(store,{fetchImpl,now}).finally(()=>pending.delete(store));
  pending.set(store,task);return task;
}
async function updateCNMarket(store,{fetchImpl,now}) {
  const old=store.getKV(CACHE,{}),age=now-Date.parse(old.attemptedAt);
  if(age>=0&&age<60000)return cnMarketOverview(store,now);
  const cache={...old,quotes:{...old.quotes},flows:{...old.flows},shares:{...old.shares},closes:{...old.closes},errors:{...old.errors},attemptedAt:now.toISOString()};
  const shareAge=now-Date.parse(old.sharesAttemptedAt),dailyDue=!(shareAge>=0&&shareAge<3600000);
  const emURL=requestURL('https://push2delay.eastmoney.com/api/qt/ulist.np/get',{fltt:'2',invt:'2',secids:WATCHED_ETFS.map(d=>(d.key.startsWith('SH.')?'1.':'0.')+d.key.slice(3)).join(','),fields:'f12,f13,f2,f3,f6,f62,f66,f124,f297'});
  const defs=[...CN_BENCHMARKS,...WATCHED_ETFS];
  const results=await Promise.allSettled([
    read(emURL,fetchImpl,'https://quote.eastmoney.com/').then(j=>parseETFFlows(j,now)),
    read('https://qt.gtimg.cn/q='+defs.map(d=>codeOf(d.key)).join(','),fetchImpl,'https://gu.qq.com/',false),
    ...(dailyDue?WATCHED_ETFS.map(async def=>({key:def.key,points:parseReferenceHistory(await read('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+codeOf(def.key)+',day,,,15,',fetchImpl,'https://gu.qq.com/'),def.key,now).points.filter(p=>p.status==='complete').map(p=>({date:p.date,price:p.price,source:'腾讯证券不复权收盘价'}))})):[])
  ]);
  cache.errors.flows='资金流更新未完成，保留已有数据及原始时间。';
  if(results[0].status==='fulfilled'){
    const rows=results[0].value;
    for(const row of rows){putQuote(cache,row.key,row.quote);if(!cache.flows[row.key]||row.flow.time>=cache.flows[row.key].time)cache.flows[row.key]=row.flow;}
    if(rows.length===WATCHED_ETFS.length&&rows.every(r=>r.flow.mainNet!=null&&r.flow.superNet!=null))delete cache.errors.flows;
  }
  let quoteCount=0;
  if(results[1].status==='fulfilled')for(const def of defs)try{putQuote(cache,def.key,parseReferenceQuote(results[1].value,def.key,now));quoteCount++;}catch{}
  if(quoteCount===defs.length)delete cache.errors.quotes;else cache.errors.quotes='部分指数或ETF报价未更新，保留已有数据及原始时间。';
  if(dailyDue){
    cache.sharesAttemptedAt=now.toISOString();
    let closeCount=0;
    for(const result of results.slice(2))if(result.status==='fulfilled'&&result.value.points.length){const {key,points}=result.value;cache.closes[key]=mergeDays(cache.closes[key],points);closeCount++;}
    if(closeCount===WATCHED_ETFS.length)delete cache.errors.closes;else cache.errors.closes='部分收盘价更新失败，无法匹配的净申赎金额暂不计算。';
    // Actual trading dates come from completed daily bars, so holidays are not guessed.
    const dates=(cache.closes['SH.510300']||[]).slice(-3).map(r=>r.date);
    const shareResults=await Promise.allSettled([
      ...dates.map(date=>read(requestURL('https://query.sse.com.cn/commonQuery.do',{isPagination:'true','pageHelp.pageSize':'1000','pageHelp.pageNo':'1',sqlId:'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L',STAT_DATE:date}),fetchImpl,'https://www.sse.com.cn/').then(j=>parseSSEShares(j,date,now))),
      read(requestURL('https://fund.szse.cn/api/report/ShowReport/data',{SHOWTYPE:'JSON',CATALOGID:'fund_jjgm',TABKEY:'tab1',txtDm:'159919',txtStart:new Date(now.getTime()-20*86400000).toISOString().slice(0,10),txtEnd:marketDay('SH',now)}),fetchImpl,'https://fund.szse.cn/').then(j=>parseSZSEShares(j,now))
    ]);
    for(const result of shareResults)if(result.status==='fulfilled')for(const row of result.value)cache.shares[row.key]=mergeDays(cache.shares[row.key],[row]);
    const shResults=shareResults.slice(0,-1);
    if(shResults.some(r=>r.status==='fulfilled'&&r.value.length)&&shResults.every(r=>r.status==='fulfilled'))delete cache.errors.sharesSH;else cache.errors.sharesSH='沪市每日份额更新未完成，保留原始日期；尚未披露的份额不补零。';
    if(shareResults.at(-1).status==='fulfilled')delete cache.errors.sharesSZ;else cache.errors.sharesSZ='深市每日份额更新未完成，保留原始日期。';
  }
  store.setKV(CACHE,cache);
  return cnMarketOverview(store,now);
}
