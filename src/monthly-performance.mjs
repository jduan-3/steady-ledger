import { isoDay, marketDay } from './securities.mjs';

export const NASDAQ_MONTHLY_CACHE = 'nasdaq_monthly';
export const NASDAQ_MONTHLY_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=us.IXIC,month,,,42,qfq';
const pending = new WeakMap();
const previousMonth = period => {
  const [year,month]=period.split('-').map(Number);
  return month===1?`${year-1}-12`:`${year}-${String(month-1).padStart(2,'0')}`;
};

export function parseNasdaqMonthly(input, now=new Date()) {
  const rows=input?.data?.['us.IXIC']?.month;
  if(input?.code!==0 || !Array.isArray(rows))throw new Error('纳指月线数据格式无效');
  const today=marketDay('US',now),currentMonth=today.slice(0,7),seen=new Set(),points=[];
  for(const row of rows) {
    if(!Array.isArray(row))continue;
    let date;try{date=isoDay(row[0]);}catch{continue;}
    const close=Number(row[2]),period=date.slice(0,7);
    if(date>today || row[2]==null || row[2]==='' || !Number.isFinite(close) || close<=0)continue;
    if(seen.has(period))throw new Error('纳指月线包含重复月份');
    seen.add(period);points.push({period,date,close,complete:period<currentMonth});
  }
  if(!points.length)throw new Error('尚未取得有效的纳指月线');
  return points.sort((a,b)=>a.period.localeCompare(b.period));
}

// Require adjacent months and a finished baseline; a missing month is never zero
// and never turns the next observation into a multi-month return.
export function calculateMonthlyPerformance(points, now=new Date()) {
  const currentMonth=marketDay('US',now).slice(0,7),year=Number(currentMonth.slice(0,4));
  const byMonth=new Map(points.filter(p=>p.period<=currentMonth).map(p=>[p.period,p]));
  const years=[year,year-1,year-2];
  const rows=years.map(year=>({year,months:Array.from({length:12},(_,i)=>{
    const month=i+1,period=`${year}-${String(month).padStart(2,'0')}`,point=byMonth.get(period),previous=byMonth.get(previousMonth(period));
    const valid=point?.close>0&&previous?.close>0&&previous.complete===true;
    const percent=valid?(point.close/previous.close-1)*100:null;
    const status=period>currentMonth?'future':percent===null?'missing':point.complete===true&&period<currentMonth?'complete':period===currentMonth?'partial':'pending';
    return {month,period,percent,status,date:point?.date||null,close:point?.close??null,previousClose:previous?.close??null,previousDate:previous?.date||null};
  })}));
  const statistics=Array.from({length:12},(_,i)=>{
    const samples=rows.map(row=>row.months[i]).filter(cell=>cell.status==='complete').sort((a,b)=>a.percent-b.percent),count=samples.length;
    return {month:i+1,samples:count,upRate:count?samples.filter(s=>s.percent>0).length/count*100:null,
      median:count?(samples[Math.floor((count-1)/2)].percent+samples[Math.ceil((count-1)/2)].percent)/2:null,
      average:count?samples.reduce((sum,s)=>sum+s.percent,0)/count:null,
      best:count?{period:samples.at(-1).period,percent:samples.at(-1).percent}:null,
      worst:count?{period:samples[0].period,percent:samples[0].percent}:null};
  });
  return {years,rows,statistics,currentMonth,from:`${year-2}-01`,through:previousMonth(currentMonth),completedSamples:rows.flatMap(r=>r.months).filter(c=>c.status==='complete').length};
}

export function monthlyPerformance(store, now=new Date()) {
  const cache=store.getKV(NASDAQ_MONTHLY_CACHE,{}),points=cache.points||[];
  return {key:'US..IXIC',name:'纳斯达克综合指数',symbol:'IXIC',...calculateMonthlyPerformance(points,now),
    source:'腾讯证券 · 纳指月 K 线',sourceUrl:'https://gu.qq.com/us.IXIC/zs',
    latestDate:points.at(-1)?.date||null,updatedAt:cache.updatedAt||null,attemptedAt:cache.attemptedAt||null,error:cache.error||null,
    method:'月涨跌幅 = 本月月线收盘点位 ÷ 上月月线收盘点位 − 1；为价格回报，不含分红。本月暂计单独标记，统计仅使用已结束且相邻月线完整的月份。上涨率 = 涨幅大于 0 的月份数 ÷ 有效样本数，持平也计入样本。'};
}

export function refreshMonthlyPerformance(store, options={}) {
  if(pending.has(store))return pending.get(store);
  const task=update(store,options).finally(()=>pending.delete(store));pending.set(store,task);return task;
}
async function update(store,{fetchImpl=fetch,now=new Date(),force=false}={}) {
  const old=store.getKV(NASDAQ_MONTHLY_CACHE,{}),age=now-Date.parse(old.attemptedAt),currentMonth=marketDay('US',now).slice(0,7);
  const sameMonth=old.attemptedAt&&marketDay('US',new Date(old.attemptedAt)).slice(0,7)===currentMonth;
  const interval=old.error?60000:6*60*60*1000;
  if(!force&&sameMonth&&age>=0&&age<interval)return monthlyPerformance(store,now);
  const next={...old,attemptedAt:now.toISOString()};
  try {
    const response=await fetchImpl(NASDAQ_MONTHLY_URL,{headers:{Referer:'https://gu.qq.com/','User-Agent':'Steady/1.0'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('公开行情暂不可用');
    const points=parseNasdaqMonthly(await response.json(),now);
    // Do not replace a good cache with a source response that moved backwards.
    if(old.points?.length&&points.at(-1).date<old.points.at(-1).date)throw new Error('数据源返回了更早的月线，保留上次数据');
    next.points=points;next.updatedAt=now.toISOString();next.error=null;
  } catch {next.error='月线更新未完成，已保留上次数据。请稍后重试。';}
  store.setKV(NASDAQ_MONTHLY_CACHE,next);
  return monthlyPerformance(store,now);
}
