import { security, securityKey } from './securities.mjs';
const prefixes={SH:'sh',SZ:'sz',HK:'hk',US:'us'};
export const canonicalUS = value => String(value).toUpperCase().replace(/\.(OQ|N|PS|PK|AM)$/,'');
const readText = async (url, fetchImpl) => {
  const r=await fetchImpl(url,{headers:{Referer:'https://gu.qq.com/','User-Agent':'Steady/1.0'},signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error('腾讯行情暂不可用');return new TextDecoder('gb18030').decode(await r.arrayBuffer());
};
export async function searchTencent(query,{fetchImpl=fetch}={}){
  const text=await readText('https://smartbox.gtimg.cn/s3/?q='+encodeURIComponent(query)+'&t=all',fetchImpl),match=text.match(/v_hint="([^"\n]*)"/);
  if(!match)throw new Error('股票搜索返回格式无效');
  const content=JSON.parse('"'+match[1]+'"'),items=[];
  for(const item of content.split('^')){
    const [m,code,name]=item.split('~'),market=Object.entries(prefixes).find(([,p])=>p===m)?.[0];
    if(!market)continue;
    try{items.push({...security({market,symbol:market==='US'?canonicalUS(code):code}),name:String(name).slice(0,120)});}catch{}
  }
  return items;
}
export function parseTencentQuote(text, key){
  const s=securityKey(key),{market,symbol}=s,code=prefixes[market]+symbol;
  const matches=[...text.matchAll(/v_([^=\s]+)="([^"\n]*)"/g)],row=matches.find(m=>m[1].toUpperCase()===code.toUpperCase());
  if(!row)throw new Error('未返回对应股票行情');
  const f=row[2].split('~'),actual=market==='US'?canonicalUS(f[2]):f[2];
  if(actual!==s.symbol || f.length<33)throw new Error('股票身份不匹配');
  let time=f[30].replaceAll('/','-');
  if(/^\d{14}$/.test(time))time=time.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,'$1-$2-$3 $4:$5:$6');
  return {key:s.key,price:Number(f[3]),previous:{price:Number(f[4])},time,...(market==='US'?{historyCode:'us'+String(f[2]).toUpperCase()}:{}),source:'腾讯证券公开行情'};
}
export async function tencentQuotes(keys,{fetchImpl=fetch}={}){
  const codes=keys.map(key=>{const s=securityKey(key);if(!prefixes[s.market])throw new Error();return prefixes[s.market]+s.symbol;});
  const text=await readText('https://qt.gtimg.cn/q='+codes.join(','),fetchImpl),quotes=[];
  for(const key of keys){try{quotes.push(parseTencentQuote(text,key));}catch{}}
  return quotes;
}
