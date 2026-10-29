import { isoDay } from './securities.mjs';

export const BUFFETT_SERIES={marketCap:'BOGZ1LM883164115Q',gdp:'GDP'};
const quarterIndex=date=>Number(date.slice(0,4))*4+Math.floor((Number(date.slice(5,7))-1)/3);
export function parseFredQuarterly(text,series,now=new Date()) {
  const [header,...lines]=String(text).trim().replace(/^\uFEFF/,'').split(/\r?\n/),fields=header.split(',');
  const column=fields.indexOf(series);
  if(fields[0]!=='observation_date'||column<1)throw new Error('FRED 季度数据格式无效');
  const rows=[];
  for(const line of lines){
    const cells=line.split(','),date=cells[0],value=Number(cells[column]);
    try{isoDay(date);}catch{continue;}
    if(!/^\d{4}-(01|04|07|10)-01$/.test(date)||!Number.isFinite(value)||value<=0||quarterIndex(date)>=quarterIndex(now.toISOString().slice(0,10)))continue;
    rows.push({date,value});
  }
  return rows;
}
export function calculateBuffettIndicator(marketCaps,gdps,now=new Date()) {
  const gdpByDate=new Map(gdps.map(r=>[r.date,r.value]));
  const pairs=marketCaps.filter(r=>/^\d{4}-(01|04|07|10)-01$/.test(r.date)&&Number.isFinite(r.value)&&r.value>0&&Number.isFinite(gdpByDate.get(r.date))&&gdpByDate.get(r.date)>0).sort((a,b)=>b.date.localeCompare(a.date));
  const pair=pairs[0],currentQuarter=quarterIndex(now.toISOString().slice(0,10));
  // Z.1 normally publishes a quarter about ten weeks after it ends.
  if(!pair||!/^\d{4}-(01|04|07|10)-01$/.test(pair.date)||quarterIndex(pair.date)>=currentQuarter||currentQuarter-quarterIndex(pair.date)>2)return null;
  const marketCapBillions=pair.value/1000,gdpBillions=gdpByDate.get(pair.date),percent=marketCapBillions/gdpBillions*100;
  return {date:pair.date,period:`${pair.date.slice(0,4)} Q${Math.floor((Number(pair.date.slice(5,7))-1)/3)+1}`,percent,marketCapBillions,gdpBillions,currency:'USD',basis:'quarterly_public_equity_to_annualized_nominal_gdp',
    source:'Federal Reserve Z.1 / BEA，经 FRED 获取',marketCapUrl:'https://fred.stlouisfed.org/series/'+BUFFETT_SERIES.marketCap,gdpUrl:'https://fred.stlouisfed.org/series/'+BUFFETT_SERIES.gdp,
    methodology:'公开交易股权市值 ÷ 同季度年化名义 GDP × 100%；市值按 Fed Z.1 口径，含 ETF、封闭式基金等份额；GDP 为季调年率。'};
}
export function availableBuffett(cached,now=new Date()) {
  if(cached?.error||!cached?.indicator)return null;
  const i=cached.indicator;
  return calculateBuffettIndicator([{date:i.date,value:i.marketCapBillions*1000}],[{date:i.date,value:i.gdpBillions}],now);
}
export async function refreshBuffett(cached,{fetchImpl=fetch,now=new Date()}={}) {
  const age=now-Date.parse(cached?.attemptedAt),interval=cached?.error?30*60000:24*60*60000;
  if(Number.isFinite(age)&&age>=0&&age<interval)return cached;
  const attemptedAt=now.toISOString();
  try{
    const rows=await Promise.all(Object.values(BUFFETT_SERIES).map(async series=>{
      const url=`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${now.getUTCFullYear()-2}-01-01`;
      const response=await fetchImpl(url,{headers:{Accept:'text/csv','User-Agent':'Steady/1.0'},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('FRED 数据暂不可用');
      return parseFredQuarterly(await response.text(),series,now);
    }));
    const indicator=calculateBuffettIndicator(rows[0],rows[1],now);
    if(!indicator)throw new Error('尚无同季度有效数据');
    return {indicator,attemptedAt,updatedAt:attemptedAt,error:null};
  }catch{return {...cached,attemptedAt,error:'本次估值数据未取得'};}
}
