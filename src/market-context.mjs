import { isoDay, marketDay } from './securities.mjs';

const HKMA='https://api.hkma.gov.hk/public/market-data-and-statistics/';
export const CONTEXT_SOURCES={
  DGS2:{market:'US',name:'2 年期美债收益率',unit:'%',source:'美联储 H.15 / FRED',note:'短端利率',url:'https://fred.stlouisfed.org/series/DGS2'},
  DGS10:{market:'US',name:'10 年期美债收益率',unit:'%',source:'美联储 H.15 / FRED',note:'长期融资与估值折现背景',url:'https://fred.stlouisfed.org/series/DGS10'},
  T10Y2Y:{market:'US',name:'10 年 − 2 年利差',unit:'百分点',source:'FRED',note:'负值表示收益率曲线倒挂',url:'https://fred.stlouisfed.org/series/T10Y2Y'},
  BAMLH0A0HYM2:{market:'US',name:'高收益债信用利差',unit:'%',source:'ICE BofA / FRED',note:'OAS；利差扩大表示信用风险溢价上升',url:'https://fred.stlouisfed.org/series/BAMLH0A0HYM2'},
  OFR:{market:'US',name:'OFR 金融压力指数',unit:'点',source:'美国财政部 OFR',note:'全球金融压力；0 为历史平均，正值表示高于平均；约滞后两个工作日',url:'https://www.financialresearch.gov/financial-stress-index/'},
  HIBOR_ON:{market:'HK',name:'隔夜 HIBOR',field:'ir_overnight',unit:'%',source:'香港银行公会 / 金管局',note:'港元拆息定盘年率',url:'https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/hk-interbank-ir-daily/'},
  HIBOR_1M:{market:'HK',name:'1 个月 HIBOR',field:'ir_1m',unit:'%',source:'香港银行公会 / 金管局',note:'港元短期资金成本',url:'https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/hk-interbank-ir-daily/'},
  HIBOR_3M:{market:'HK',name:'3 个月 HIBOR',field:'ir_3m',unit:'%',source:'香港银行公会 / 金管局',note:'按来源披露日展示，可能晚于定盘日发布',url:'https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/hk-interbank-ir-daily/'},
  HK_BALANCE:{market:'HK',name:'银行体系总结余',field:'aggr_balance_bf_disc_win',unit:'亿港元',source:'香港金管局',note:'贴现窗活动前结余；不等同南向资金净流入',url:'https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/monetary-operation/monetary-base-daily/'}
};
const finite=value=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value));
function observations(rows,market,now) {
  const days=new Map();
  for(const row of rows)try{isoDay(row.date);if(row.date<=marketDay(market,now)&&finite(row.value))days.set(row.date,{date:row.date,value:Number(row.value)});}catch{}
  const out=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);
  if(!out.length)throw new Error('没有有效观测值');
  return out;
}
export function parseContextCSV(text,column,now=new Date(),dateColumn='observation_date') {
  const [header,...lines]=String(text).trim().replace(/^\uFEFF/,'').split(/\r?\n/),fields=header.split(','),index=fields.indexOf(column);
  if(fields[0]!==dateColumn||index<1)throw new Error('宏观数据格式无效');
  return observations(lines.map(line=>{const cells=line.split(',');return {date:cells[0],value:cells[index]};}),'US',now);
}
export function parseHKMA(input,keys,now=new Date()) {
  if(input?.header?.success!==true||!Array.isArray(input.result?.records))throw new Error('金管局数据格式无效');
  return Object.fromEntries(keys.map(key=>{
    const def=CONTEXT_SOURCES[key];
    try{return [key,observations(input.result.records.map(r=>({date:r.end_of_day,value:finite(r[def.field])?Number(r[def.field])/(key==='HK_BALANCE'?100:1):null})),'HK',now)];}catch{return [key,null];}
  }));
}
export async function refreshMarketContext(cached={}, {fetchImpl=fetch,now=new Date()}={}) {
  const next={...cached};
  const groups=[...['DGS2','DGS10','T10Y2Y','BAMLH0A0HYM2','OFR'].map(key=>({keys:[key],url:key==='OFR'?'https://www.financialresearch.gov/financial-stress-index/data/fsi.csv':`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${key}&cosd=${new Date(now.getTime()-120*86400000).toISOString().slice(0,10)}`})),
    {keys:['HIBOR_ON','HIBOR_1M','HIBOR_3M'],url:HKMA+'monthly-statistical-bulletin/er-ir/hk-interbank-ir-daily?segment=hibor.fixing&sortby=end_of_day&sortorder=desc&pagesize=60'},
    {keys:['HK_BALANCE'],url:HKMA+'monthly-statistical-bulletin/monetary-operation/monetary-base-daily?sortby=end_of_day&sortorder=desc&pagesize=60'}];
  await Promise.all(groups.map(async group=>{
    const due=group.keys.some(key=>{const prev=cached[key],age=now-Date.parse(prev?.attemptedAt);return !Number.isFinite(age)||age<0||age>=(prev?.error?30*60000:4*3600000);});
    if(!due)return;
    let rows={};
    for(let attempt=0;attempt<2;attempt++)try{
      const response=await fetchImpl(group.url,{headers:{Accept:'text/csv, application/json','User-Agent':'Steady/1.0'},signal:AbortSignal.timeout(10000)});
      if(!response.ok){if(response.status<500)break;throw new Error('数据源暂不可用');}
      rows=group.keys[0].startsWith('HI')||group.keys[0]==='HK_BALANCE'?parseHKMA(await response.json(),group.keys,now):{[group.keys[0]]:parseContextCSV(await response.text(),group.keys[0]==='OFR'?'OFR FSI':group.keys[0],now,group.keys[0]==='OFR'?'Date':'observation_date')};
      break;
    }catch{}
    for(const key of group.keys)next[key]=rows[key]?.length?{history:rows[key],attemptedAt:now.toISOString(),updatedAt:now.toISOString(),error:null}:{...cached[key],attemptedAt:now.toISOString(),error:'本次未取得新数据'};
  }));
  return next;
}
export function marketContext(cached,market,now=new Date()) {
  return Object.entries(CONTEXT_SOURCES).filter(([,def])=>def.market===market).map(([key,def])=>{
    const entry=cached?.[key],history=(entry?.history||[]).filter(r=>r.date<=marketDay(market,now)&&Number.isFinite(r.value)),latest=history.at(-1),previous=history.at(-2);
    const lagDays=latest?Math.floor((Date.parse(marketDay(market,now))-Date.parse(latest.date))/86400000):null;
    return {key,...def,history,value:latest?.value??null,date:latest?.date??null,previousDate:previous?.date??null,change:latest&&previous?latest.value-previous.value:null,lagDays,status:!latest?'unavailable':entry.error?'cached':lagDays>7?'lagged':'available',error:entry?.error||null};
  });
}

export function activityReading(series) {
  const latest=series.latest,history=series.history||[],closed=history.at(-1);
  const prior=closed?history.filter(q=>q.date<closed.date).slice(-20):[];
  // Require every preceding session, including zero-volume sessions; never cherry-pick a shorter sample.
  const baseline=prior.length===20&&prior.every(q=>Number.isFinite(q.volume)&&q.volume>=0)?prior.reduce((sum,q)=>sum+q.volume,0)/20:null;
  const relativeVolume=closed&&Number.isFinite(closed.volume)&&baseline>0?closed.volume/baseline:null;
  return {key:series.key,name:series.name,currency:series.market==='US'?'USD':'HKD',latest:latest||null,closed:closed||null,relativeVolume,baselineDate:prior.at(-1)?.date||null,baselineCount:baseline===null?0:20};
}
