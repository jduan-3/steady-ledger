import { runOpenD } from './market.mjs';
import { securityKey, isoDay, marketDay, MARKETS } from './securities.mjs';

const pending = new WeakMap();
const fields = {
  pe:'pe_ratio',peTTM:'pe_ttm_ratio',pb:'pb_ratio',dividendTTM:'dividend_ttm',dividendYieldTTM:'dividend_ratio_ttm',
  dividendLFY:'dividend_lfy',dividendYieldLFY:'dividend_lfy_ratio',marketCap:'total_market_val',eps:'earning_per_share',bookValuePerShare:'net_asset_per_share'
};

export async function stockDetails(store, key, { provider=runOpenD, now=new Date() }={}) {
  const security=securityKey(key),cacheKey='stock_details:'+security.key,cached=store.getKV(cacheKey);
  if(cached&&now-Date.parse(cached.fetchedAt)>=0&&now-Date.parse(cached.fetchedAt)<30*60000)return {...cached,status:'available'};
  if(!pending.has(store))pending.set(store,new Map());
  const tasks=pending.get(store);
  if(tasks.has(key))return tasks.get(key);
  const task=(async()=>{
    try {
      const {details}=await provider({action:'details',keys:[security.key]});
      if(details?.key!==security.key||details.equityValid!==true)throw new Error('未取得正股基础资料');
      const time=String(details.time||'').replace(/\.\d+$/,'');
      if(!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)||isoDay(time.slice(0,10))>marketDay(security.market,now))throw new Error('基础资料日期无效');
      const metrics=Object.fromEntries(Object.entries(fields).map(([name,field])=>{
        const value=details.metrics?.[field];
        return [name,Number.isFinite(value)&&(!['dividendTTM','dividendYieldTTM','dividendLFY','dividendYieldLFY','marketCap'].includes(name)||value>=0)?value:null];
      }));
      if(Object.values(metrics).every(value=>value===null))throw new Error('基础资料缺失');
      const value={key:security.key,currency:security.currency,time,timeZone:MARKETS[security.market].timeZone,fetchedAt:now.toISOString(),source:'Futu OpenD',metrics};
      store.setKV(cacheKey,value);
      return {...value,status:'available'};
    } catch {
      return cached?{...cached,status:'cached',message:'最新基础资料暂不可用，以下保留上次记录。'}:{key:security.key,status:'unavailable',message:'基础资料暂不可用，请确认本机 OpenD 已连接并有对应行情权限。'};
    }
  })();
  tasks.set(key,task);
  try{return await task;}finally{tasks.delete(key);}
}
