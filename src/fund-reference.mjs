import { isoDay, marketDay } from './securities.mjs';
import { parseTencentQuote } from './tencent.mjs';
import { stockQuote } from './market.mjs';

// Relations come from issuer disclosures, not fund-name similarity.
export const FUND_REFERENCES={
  '008164':{key:'SH.515450',name:'南方标普红利低波50ETF',relation:'target_etf',index:'标普中国A股大盘红利低波50指数',sources:[{title:'南方基金年度报告 · 目标基金基本情况',url:'https://pdf.dfcfw.com/pdf/H2_AN202603311820891283_1.pdf'}]},
  '021634':{key:'SZ.159750',name:'招商中证香港科技ETF',relation:'target_etf',index:'中证香港科技指数',sources:[{title:'招商基金年度报告 · 目标基金基本情况',url:'https://pdf.dfcfw.com/pdf/H2_AN202503281648532274_1.pdf'}]},
  '009051':{key:'SH.515180',name:'易方达中证红利ETF',relation:'target_etf',index:'中证红利指数',sources:[{title:'易方达基金官方产品资料',url:'https://www.efunds.com.cn/fund/009051_org.shtml'}]},
  '011609':{key:'SH.588080',name:'易方达科创50ETF',relation:'target_etf',index:'上证科创板50成份指数',sources:[{title:'易方达基金官方产品资料',url:'https://www.efunds.com.cn/fund/011609_org.shtml'}]},
  '005052':{key:'SH.513630',name:'摩根标普港股通低波红利ETF',relation:'same_index_etf',index:'标普港股通低波红利指数',sources:[{title:'摩根指数基金产品资料概要',url:'https://pdf.dfcfw.com/pdf/H2_AN202509121742181261_1.pdf'},{title:'摩根ETF产品资料概要 · 上交所披露',url:'https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-01-21/513630_20260121_L57A.pdf'}]}
};
const pending=new WeakMap();
const number=value=>value==null||String(value).trim()===''?null:Number.isFinite(Number(value))?Number(value):null;
const positive=value=>{const n=number(value);return n>0?n:null;};
const nonnegative=value=>{const n=number(value);return n>=0?n:null;};
const codeOf=key=>{if(!/^(SH|SZ)\.\d{6}$/.test(key))throw new Error('仅支持已核验的沪深ETF参考行情');return key.slice(0,2).toLowerCase()+key.slice(3);};
const fetchedAt=now=>now.toISOString();
const localTime=now=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).format(now);
const sourceUrl=key=>'https://gu.qq.com/'+codeOf(key)+'/jj';

export function parseReferenceQuote(text,key,now=new Date()) {
  const code=codeOf(key),quote=stockQuote(parseTencentQuote(text,key),now);
  if(Date.parse(quote.time.replace(' ','T')+'+08:00')>now.getTime()+300000)throw new Error('参考报价时间晚于当前时间');
  const row=[...text.matchAll(/v_([^=\s]+)="([^"\n]*)"/g)].find(m=>m[1]===code),fields=row[2].split('~');
  const open=positive(fields[5]),high=positive(fields[33]),low=positive(fields[34]),lots=nonnegative(fields[6]);
  if(high!=null&&low!=null&&(high<low||quote.price>high+1e-6||quote.price<low-1e-6))throw new Error('参考行情高低价不一致');
  // SH/SZ ETF quote volume is in lots of 100 units; amount[37] is CNY 10,000.
  // The composite field supplies an unrounded CNY amount when it agrees on identity.
  const summary=String(fields[35]||'').split('/'),exact=summary.length===3&&positive(summary[0])===quote.price&&nonnegative(summary[1])===lots?nonnegative(summary[2]):null;
  return {...quote,source:'腾讯证券公开行情',sourceUrl:sourceUrl(key),open,high,low,volume:lots==null?null:lots*100,amount:exact??(nonnegative(fields[37])==null?null:Number(fields[37])*10000),turnover:nonnegative(fields[38]),percent:quote.previous?(quote.price/quote.previous.price-1)*100:null};
}

export function parseReferenceMinutes(input,key,now=new Date()) {
  const code=codeOf(key),wire=input?.data?.[code]?.data;
  if(input?.code!==0||!Array.isArray(wire?.data)||!/^\d{8}$/.test(wire.date))throw new Error('参考分时数据格式无效');
  const date=isoDay(wire.date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'));
  if(date>marketDay('SH',now))throw new Error('参考分时日期无效');
  const points=[];let lastTime='',previousVolume=0,previousAmount=0;
  for(const line of wire.data){
    const [stamp,rawPrice,rawVolume,rawAmount]=String(line).trim().split(/\s+/),price=positive(rawPrice),lots=nonnegative(rawVolume),amount=nonnegative(rawAmount);
    if(!/^(?:09[0-5]\d|1[0-5][0-5]\d)$/.test(stamp)||stamp<=lastTime||price==null||lots==null||lots*100<previousVolume||amount!=null&&previousAmount!=null&&amount<previousAmount)throw new Error('参考分时价格、时间或累计量无效');
    const time=stamp.slice(0,2)+':'+stamp.slice(2),volume=lots*100;
    if(date===marketDay('SH',now)&&time>localTime(now))throw new Error('参考分时时点晚于当前时间');
    points.push({time,price,volume:volume-previousVolume,amount:amount==null||previousAmount==null?null:amount-previousAmount,cumulativeVolume:volume,cumulativeAmount:amount});
    lastTime=stamp;previousVolume=volume;previousAmount=amount;
  }
  if(!points.length)throw new Error('参考分时数据为空');
  return {date,points,fetchedAt:fetchedAt(now),source:'腾讯证券分时行情',sourceUrl:sourceUrl(key),volumeUnit:'份'};
}

export function parseReferenceHistory(input,key,now=new Date()) {
  const code=codeOf(key),rows=input?.data?.[code]?.day;
  if(input?.code!==0||!Array.isArray(rows))throw new Error('未取得不复权参考日线');
  const points=[],dates=new Set(),today=marketDay('SH',now);
  for(const row of rows.slice(-60)){
    const date=isoDay(row[0]),open=positive(row[1]),price=positive(row[2]),high=positive(row[3]),low=positive(row[4]),lots=nonnegative(row[5]);
    if(date>today||dates.has(date)||[open,price,high,low].some(n=>n==null)||high<Math.max(open,price)||low>Math.min(open,price)||high<low)throw new Error('参考日线价格、日期或身份无效');
    points.push({date,open,price,high,low,volume:lots==null?null:lots*100,status:date===today&&localTime(now)<'15:15'?'partial':'complete'});dates.add(date);
  }
  if(!points.length)throw new Error('参考日线数据为空');
  points.sort((a,b)=>a.date.localeCompare(b.date));
  return {points,basis:'unadjusted',fetchedAt:fetchedAt(now),source:'腾讯证券不复权日线',sourceUrl:sourceUrl(key),volumeUnit:'份'};
}

export function fundReference(store,assetId,now=new Date()) {
  const asset=store.state({raw:true}).assets.find(a=>a.id===assetId);
  if(!asset)throw Object.assign(new Error('资产不存在'),{status:404});
  if(asset.type!=='fund')return {assetId,status:'not_applicable'};
  const reference=FUND_REFERENCES[asset.fund?.code];
  if(!reference)return {assetId,fundCode:asset.fund?.code||null,status:'unmapped',message:'该基金尚无已核验的参考标的。'};
  const cached=store.getKV('fund_reference:'+reference.key),errors=cached?.errors||{};
  const hasData=Boolean(cached?.quote||cached?.intraday||cached?.history);
  return {assetId,fundCode:asset.fund.code,reference:{...reference,verifiedAt:'2026-10-31'},status:!hasData?'unavailable':Object.keys(errors).length?'cached':'available',quote:cached?.quote||null,intraday:cached?.intraday||null,history:cached?.history||null,attemptedAt:cached?.attemptedAt||null,errors,asOf:now.toISOString(),notice:'ETF二级市场行情仅作盘中参考，不是本基金净值或你的持仓收益；不用于更新基金估值、成本、份额或现金。'};
}

export function fundReferenceSummary(view) {
  const series=(value,section)=>{
    if(!value)return null;
    const {points,...metadata}=value;
    return {...metadata,count:points.length,latest:points.at(-1)||null,readWith:{tool:'get_page_data',page:'instruments',section,assetId:view.assetId}};
  };
  return {...view,intraday:series(view.intraday,'referenceMinutes'),history:series(view.history,'referenceHistory')};
}

export function refreshFundReference(store,assetId,{fetchImpl=fetch,now=new Date()}={}) {
  const view=fundReference(store,assetId,now);if(!view.reference)return Promise.resolve(view);
  const {key}=view.reference,cacheKey='fund_reference:'+key,cached=store.getKV(cacheKey);
  if(!pending.has(store))pending.set(store,new Map());const tasks=pending.get(store);
  if(tasks.has(key))return tasks.get(key).then(()=>fundReference(store,assetId,now));
  if(cached&&now-Date.parse(cached.attemptedAt)>=0&&now-Date.parse(cached.attemptedAt)<60000)return Promise.resolve(view);
  const code=codeOf(key),headers={Referer:'https://gu.qq.com/','User-Agent':'Steady/1.0'};
  const read=async url=>{const response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('参考行情暂不可用');return new TextDecoder('gb18030').decode(await response.arrayBuffer());};
  const task=(async()=>{
    const results=await Promise.allSettled([
      read('https://qt.gtimg.cn/q='+code).then(text=>parseReferenceQuote(text,key,now)),
      read('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code='+code).then(text=>parseReferenceMinutes(JSON.parse(text),key,now)),
      read('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+code+',day,,,60,').then(text=>parseReferenceHistory(JSON.parse(text),key,now))
    ]);
    // A deleted/replaced fund must not receive a late response from its old request.
    if(store.state({raw:true}).assets.find(a=>a.id===assetId)?.fund?.code!==view.fundCode)return;
    const next={...cached,attemptedAt:fetchedAt(now),errors:{}};
    for(const [i,section] of ['quote','intraday','history'].entries()){
      const result=results[i],old=cached?.[section];
      const stamp=value=>section==='quote'?value.time:section==='intraday'?value.date:value.points.at(-1).date;
      if(result.status==='fulfilled'&&(!old||stamp(result.value)>=stamp(old)))next[section]=result.value;
      else next.errors[section]='最新'+({quote:'报价',intraday:'分时',history:'日线'}[section])+'暂不可用，保留已有数据和实际日期。';
    }
    store.setKV(cacheKey,next);
  })().finally(()=>tasks.delete(key));tasks.set(key,task);
  return task.then(()=>fundReference(store,assetId,now));
}
