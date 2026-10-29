import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityKey, isoDay, marketDay } from './securities.mjs';
import { priceMovement } from './valuation.mjs';
import { searchTencent, tencentQuotes } from './tencent.mjs';

export function runOpenD(input) {
  const bundled = join(homedir(), 'Library/Application Support/Steady/market-venv/bin/python');
  const python = process.env.STEADY_MARKET_PYTHON || (existsSync(bundled) ? bundled : 'python3');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('../scripts/opend-local.py', import.meta.url))], { stdio: ['pipe','pipe','pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), input.action==='overview'?40000:input.action==='catalog'?20000:10000);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 8e6) child.kill('SIGTERM'); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('本机 OpenD 读取程序不可用')); });
    child.on('close', () => {
      clearTimeout(timer);
      try { const line = output.split('\n').findLast(line => line.startsWith('STEADY_JSON:')); const result = JSON.parse(line.slice(12)); if (result.error) throw new Error(result.error); resolve(result); }
      catch { reject(new Error('OpenD 未连接或行情权限不足，请检查本机 OpenD')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
const pendingCatalog = new WeakMap();
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
export async function searchSecurities(store, query, market = 'ALL', { provider = runOpenD, searchProvider = provider===runOpenD?searchTencent:null, now = new Date() } = {}) {
  query = normalize(query);
  if (!query || query.length > 80) throw new Error('请输入股票名称或代码');
  if (!['ALL','SH','SZ','HK','US'].includes(market)) throw new Error('股票市场无效');
  let catalog = store.getKV('stock_catalog', { items: [], fetchedAt: null }), message = '';
  if(searchProvider){
    try{
      const found=await searchProvider(query),byKey=new Map(catalog.items.map(x=>[x.key,x]));for(const item of found)byKey.set(item.key,item);
      store.setKV('stock_catalog',{...catalog,items:[...byKey.values()]});
      return {items:found.filter(x=>market==='ALL'||x.market===market),message:''};
    }catch{message='在线搜索暂不可用，尝试本机目录';}
  }
  if (!catalog.items.length || !Number.isFinite(Date.parse(catalog.fetchedAt)) || now - Date.parse(catalog.fetchedAt) > 86400000) {
    if (!pendingCatalog.has(store)) pendingCatalog.set(store, (async () => {
      const data = await provider({ action: 'catalog' }), items = [];
      for (const row of data.catalog || []) {
        try { const s = securityKey(row.key); items.push({ ...s, name: String(row.name).slice(0,120) }); } catch {}
      }
      if (!items.length) throw new Error('未能读取股票目录，请确认 OpenD 已运行');
      const byKey = new Map(catalog.items.map(x => [x.key,x]));
      for (const item of items) {
        const old=byKey.get(item.key),aliases=[...new Set([...(old?.aliases||[]),old?.name,item.name].filter(Boolean))];
        byKey.set(item.key,{...item,name:old?.name&&/[\u4e00-\u9fff]/.test(old.name)&&!/[\u4e00-\u9fff]/.test(item.name)?old.name:item.name,aliases});
      }
      const next = { items: [...byKey.values()], fetchedAt: now.toISOString() };
      store.setKV('stock_catalog', next); return next;
    })().finally(() => pendingCatalog.delete(store)));
    try { catalog = await pendingCatalog.get(store); }
    catch (e) { if (!catalog.items.length) throw e; message = 'OpenD 暂不可用，使用已保存的股票目录'; }
  }
  const items = catalog.items.filter(x => (market === 'ALL' || x.market === market) && ([x.name,...(x.aliases||[])].some(name=>normalize(name).includes(query)) || x.key.includes(query) || x.symbol.includes(query)));
  const rank = x => Number(x.key === query || x.symbol === query) * 4 + Number(normalize(x.name) === query) * 2;
  return { items: items.sort((a,b) => rank(b)-rank(a) || a.key.localeCompare(b.key)).slice(0,30), message };
}
export function stockQuote(input, now = new Date(), basis = 'quote') {
  const s = securityKey(input.key);
  const time=typeof input.time==='string'?input.time.replace(/\.\d+$/,''):input.time;
  const date = isoDay(input.date || String(time).slice(0,10)), price = Number(input.price);
  if (input.key !== s.key || date > marketDay(s.market,now) || !Number.isFinite(price) || price <= 0) throw new Error('股票行情无效');
  if (basis === 'quote' && !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) throw new Error('股票行情时间无效');
  const previousPrice = Number(input.previous?.price);
  return { ...s, date, price, ...(Number.isFinite(previousPrice) && previousPrice > 0 ? { previous: { price: previousPrice } } : {}), ...(basis === 'quote' ? { time } : {}), ...(Number.isInteger(input.lotSize)&&input.lotSize>0?{lotSize:input.lotSize}:{}), basis, source: 'Futu OpenD', fetchedAt: now.toISOString() };
}
export function applyStockPrices(input, getKV) {
  const state = structuredClone(input);
  for (const a of state.assets) {
    if (!a.autoPrice || !a.security) continue;
    const q = getKV('stock_quote:' + a.security.key), attempt = getKV('stock_attempt:' + a.security.key);
    if (q && q.currency === a.currency && a.unit === '股' && Number.isFinite(a.quantity)) {
      a.value = Math.round(q.price * a.quantity * 100) / 100;
      a.asOf = q.date; a.valuation = { ...q, status: attempt?.error ? 'pending' : 'quote', message: attempt?.error || '' };
      a.movement = priceMovement(q,a.quantity);
    } else a.valuation = { status: 'pending', message: attempt?.error || '等待股票行情' };
  }
  const fx = getKV('market_fx');
  if (state.preferences.autoFx !== false && fx) { state.preferences.rates = { ...state.preferences.rates, ...fx.rates, CNY: 1 }; state.preferences.fx = { date: fx.date, source: fx.source }; }
  return state;
}
export async function refreshStocks(store, { provider = runOpenD, fallback = provider===runOpenD?tencentQuotes:null, now = new Date(), force = false, keys = null } = {}) {
  const watched = keys || [...new Set(store.state({raw:true}).assets.filter(a => a.autoPrice && a.security).map(a => a.security.key))];
  const due = watched.filter(key => { const a=store.getKV('stock_attempt:'+key); return force || !a || now-Date.parse(a.at)>5*60000; }).slice(0,50);
  if (!due.length) return { updated: 0, errors: [] };
  const historyKeys = due.filter(key => store.getKV('stock_history_sync:'+key)?.day !== now.toISOString().slice(0,10));
  const responses=await Promise.allSettled([provider({action:'quotes',keys:due,historyKeys}),...(fallback?[fallback(due)]:[])]);
  const data=responses[0].status==='fulfilled'?responses[0].value:{quotes:[],history:[]};
  const candidates=[...(data.quotes||[]),...(responses[1]?.status==='fulfilled'?responses[1].value:[])];
  data.quotes=[];
  for(const key of due){
    const valid=candidates.filter(q=>{try{return q.key===key&&!!stockQuote(q,now);}catch{return false;}});
    valid.sort((a,b)=>b.time.localeCompare(a.time));if(valid.length)data.quotes.push(valid[0]);
  }
  for (const raw of data.history || []) {
    if (!due.includes(raw.key)) continue;
    try { const q=stockQuote(raw,now,'unadjusted_close'); store.recordPrice(q.key,q); } catch {}
  }
  for (const key of historyKeys) if ((data.history||[]).some(q=>q.key===key)) store.setKV('stock_history_sync:'+key,{day:now.toISOString().slice(0,10)});
  let updated=0;const errors=[];
  for (const key of due) {
    try {
      const raw=(data.quotes||[]).find(q=>q.key===key),q=stockQuote(raw,now), previous=store.getKV('stock_quote:'+key);
      if(raw.source==='腾讯证券公开行情')q.source=raw.source;
      if (previous && (q.date<previous.date || (q.date===previous.date && q.time<previous.time))) throw new Error();
      store.setKV('stock_quote:'+key,q);store.recordPrice(key,q);store.setKV('stock_attempt:'+key,{at:now.toISOString()});updated++;
    } catch { store.setKV('stock_attempt:'+key,{at:now.toISOString(),error:'行情来源暂不可用，保留上次记录'});errors.push(key); }
  }
  return {updated,errors};
}
export async function refreshFX(store, { now = new Date(), fetchImpl = fetch } = {}) {
  const state=store.state({raw:true}),old=store.getKV('market_fx');
  if (state.preferences.autoFx===false || !state.assets.some(a=>['HKD','USD'].includes(a.currency)) || old?.fetchedAt?.slice(0,10)===now.toISOString().slice(0,10)) return;
  try {
    const r=await fetchImpl('https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD,HKD',{signal:AbortSignal.timeout(12000)}),j=await r.json(),date=isoDay(j.date);
    if(!r.ok || j.base!=='CNY' || date>now.toISOString().slice(0,10) || old?.date>date)throw new Error();
    const rates={CNY:1};for(const c of ['HKD','USD']){if(!Number.isFinite(j.rates?.[c])||j.rates[c]<=0)throw new Error();rates[c]=1/j.rates[c];}
    store.setKV('market_fx',{rates,date,source:'Frankfurter / ECB',fetchedAt:now.toISOString()});
  } catch { /* Keep the last known rates; calculate() flags absent currencies. */ }
}
