import { tencentQuotes, canonicalUS } from './tencent.mjs';
import { stockQuote } from './market.mjs';
import { isoDay, marketDay, completedDay } from './securities.mjs';
import { sessionClose } from './markets.mjs';

const group=(id,title,rows)=>({id,title,keys:rows.map(([symbol])=>'US.'+symbol),rows});
export const WATCH_GROUPS=[
  group('popular','热门关注',[
    ['MSFT','微软'],['META','Meta'],['AAPL','苹果'],['AMZN','亚马逊'],['NVDA','英伟达'],['TSLA','特斯拉'],['ORCL','甲骨文'],['TSM','台积电'],['AVGO','博通'],['AMD','超威半导体'],['MU','美光科技'],['INTC','英特尔'],['GOOGL','谷歌 A']
  ]),
  group('etf','ETF',[
    ['QTEC','纳斯达克科技'],['IWF','罗素 1000 成长'],['SPY','标普 500'],['FXI','中国大盘股'],['QQQ','纳斯达克 100'],['GLD','黄金'],['XLK','科技精选'],['EWH','香港市场'],['ARKK','创新主题'],['SOXL','半导体三倍做多']
  ]),
  group('technology','信息技术',[
    ['LITE','Lumentum'],['MSFT','微软'],['COHR','相干公司'],['CTSH','高知特'],['AAPL','苹果'],['SHOP','Shopify'],['CSCO','思科'],['PLTR','Palantir'],['APP','AppLovin'],['ADI','亚德诺'],['NXPI','恩智浦'],['U','Unity'],['NVDA','英伟达'],['TXN','德州仪器'],['ASML','阿斯麦'],['SNPS','新思科技'],['MCHP','微芯科技'],['ACN','埃森哲'],['ADSK','欧特克'],['AMAT','应用材料'],['SAP','SAP'],['CDNS','楷登电子'],['ORCL','甲骨文'],['QCOM','高通'],['ANET','Arista'],['LRCX','泛林集团'],['TSM','台积电'],['ON','安森美'],['ADBE','Adobe'],['MPWR','芯源系统'],['AVGO','博通'],['DELL','戴尔科技'],['DDOG','Datadog'],['GLW','康宁'],['INTU','财捷'],['ONTO','Onto Innovation'],['SNOW','Snowflake'],['AMD','超威半导体'],['ARM','Arm'],['FN','Fabrinet'],['TTMI','TTM 科技'],['FLEX','伟创力'],['AXTI','AXT'],['MU','美光科技'],['NVTS','纳微半导体'],['WDAY','Workday'],['TER','泰瑞达'],['STX','希捷科技'],['CIEN','Ciena'],['SNDK','闪迪'],['VRT','Vertiv'],['MDB','MongoDB'],['CLS','天弘科技'],['WDC','西部数据'],['INTC','英特尔'],['CRM','赛富时'],['PANW','Palo Alto'],['ZS','Zscaler'],['CRWD','CrowdStrike'],['MRVL','迈威尔科技'],['NOW','ServiceNow'],['FTNT','飞塔信息']
  ]),
  group('communication','通讯服务',[
    ['CMCSA','康卡斯特'],['META','Meta'],['TTWO','Take-Two'],['NFLX','奈飞'],['TRI','汤森路透'],['WBD','华纳兄弟探索'],['RBLX','Roblox'],['RDDT','Reddit'],['GOOGL','谷歌 A']
  ]),
  group('discretionary','非必需消费',[
    ['ORLY','奥莱利'],['SBUX','星巴克'],['HD','家得宝'],['CPRT','科帕特'],['BKNG','Booking'],['ROST','罗斯百货'],['ABNB','爱彼迎'],['MAR','万豪酒店'],['DASH','DoorDash'],['UBER','优步'],['RCL','皇家加勒比'],['RACE','法拉利'],['RIVN','Rivian'],['MELI','美客多'],['AMZN','亚马逊'],['TSLA','特斯拉']
  ]),
  group('staples','必需消费',[
    ['MNST','怪物饮料'],['KDP','Keurig Dr Pepper'],['WMT','沃尔玛'],['PEP','百事可乐'],['CCEP','可口可乐欧洲伙伴'],['COST','好市多'],['KO','可口可乐'],['PM','菲利普莫里斯'],['MDLZ','亿滋']
  ]),
  group('financials','金融',[
    ['WFC','富国银行'],['C','花旗集团'],['V','Visa'],['PRU','保德信金融'],['AXP','美国运通'],['JPM','摩根大通'],['BAC','美国银行'],['MA','万事达'],['GS','高盛'],['MS','摩根士丹利']
  ])
];
export const WATCH_INSTRUMENTS=[...new Map(WATCH_GROUPS.flatMap(g=>g.rows.map(([symbol,name])=>['US.'+symbol,{key:'US.'+symbol,symbol,name,kind:g.id==='etf'?'etf':'stock'}]))).values()];
const keys=new Set(WATCH_INSTRUMENTS.map(d=>d.key));
export const WATCH_CACHE='us_watchboard';
const pending=new WeakMap();
const modeOf=mode=>{if(!['latest','close'].includes(mode))throw new Error('请选择最新行情或最近收盘');return mode;};
const isCompleted=(date,now,calendars)=>completedDay('US',[{day:date,close:sessionClose('US',date,calendars).slice(0,3)+'15'}],now)===date;
const quoteTime=q=>q.time||q.date+' 16:00:00';
const newer=(a,b)=>!b||quoteTime(a)>=quoteTime(b);
export function normalizeWatchQuote(raw,now=new Date()) {
  if(!keys.has(raw?.key))throw new Error('不属于当前观察列表');
  const quote=stockQuote(raw,now);
  const historyCode=typeof raw.historyCode==='string'&&/^us[A-Z][A-Z0-9.-]*\.(OQ|N|PS|PK|AM)$/.test(raw.historyCode)&&canonicalUS(raw.historyCode.slice(2))===quote.symbol?raw.historyCode:null;
  return {...quote,historyCode,source:raw.source||quote.source,percent:quote.previous?(quote.price/quote.previous.price-1)*100:null};
}
export function parseWatchHistory(input,key,now=new Date(),calendars={},historyCode=null) {
  if(!keys.has(key))throw new Error('不属于当前观察列表');
  const codes=Object.keys(input?.data||{}).filter(code=>/^us[A-Z][A-Z0-9.-]*\.(OQ|N|PS|PK|AM)$/.test(code)&&canonicalUS(code.slice(2))===key.slice(3));
  if(historyCode?!codes.includes(historyCode):codes.length!==1)throw new Error('收盘历史证券身份无效');
  const rows=input.data[historyCode||codes[0]]?.day;
  if(input?.code!==0||!Array.isArray(rows))throw new Error('收盘历史格式无效');
  const points=[];
  for(let i=0;i<rows.length;i++){
    try{
      const date=isoDay(rows[i][0]),price=Number(rows[i][2]);
      if(price<=0||!Number.isFinite(price)||!isCompleted(date,now,calendars))continue;
      const previous=i>0&&isoDay(rows[i-1][0])<date&&Date.parse(date)-Date.parse(rows[i-1][0])<=7*86400000&&Number(rows[i-1][2])>0?Number(rows[i-1][2]):null;
      points.push({key,date,price,previous:Number.isFinite(previous)&&previous>0?{price:previous}:undefined,percent:Number.isFinite(previous)&&previous>0?(price/previous-1)*100:null,currency:'USD',basis:'close',source:'腾讯证券 · 不复权日 K 线',fetchedAt:now.toISOString()});
    }catch{}
  }
  return points.sort((a,b)=>a.date.localeCompare(b.date)).at(-1)||null;
}
export function watchboard(store,{mode='latest',now=new Date()}={}) {
  modeOf(mode);
  const cache=store.getKV(WATCH_CACHE,{}),items=WATCH_INSTRUMENTS.map(d=>({...d,latest:cache.latest?.[d.key]||null,close:cache.closes?.[d.key]||null}));
  const field=mode==='latest'?'latest':'close',dates=items.map(i=>i[field]?.date).filter(Boolean).sort(),latestDate=dates.at(-1)||null;
  return {mode,groups:WATCH_GROUPS.map(({id,title,keys})=>({id,title,keys})),items,latestDate,
    available:items.filter(i=>i[field]).length,total:items.length,attemptedAt:cache.attemptedAt?.[mode]||null,updatedAt:cache.updatedAt?.[mode]||null,error:cache.errors?.[mode]||null,
    timeZone:'America/New_York',today:marketDay('US',now),source:'腾讯证券公开行情',sourceUrl:'https://gu.qq.com/',
    method:'预设观察样本，按展示用途分组，不代表全市场、热度排名或指数成分。最新行情按来源实际时间展示，不补算盘前盘后价格。最近收盘只接纳已完成交易日，日 K 线备用按相邻不复权收盘价计算，拆并股或除权会影响比较。绿色上涨、红色下跌；缺失数据不补零。'};
}
export function refreshWatchboard(store,options={}) {
  const mode=modeOf(options.mode||'latest'),running=pending.get(store);
  if(running)return running.mode===mode?running.task:running.task.then(()=>refreshWatchboard(store,options));
  const task=update(store,{...options,mode}).finally(()=>pending.delete(store));pending.set(store,{mode,task});return task;
}
async function update(store,{mode,now=new Date(),fetchImpl=fetch,quoteProvider=keys=>tencentQuotes(keys,{fetchImpl})}) {
  const old=store.getKV(WATCH_CACHE,{}),age=now-Date.parse(old.attemptedAt?.[mode]);
  if(age>=0&&age<60000)return watchboard(store,{mode,now});
  const next={...old,latest:{...old.latest},closes:{...old.closes},historyAt:{...old.historyAt},attemptedAt:{...old.attemptedAt,[mode]:now.toISOString()},updatedAt:{...old.updatedAt},errors:{...old.errors}};
  const calendars=store.getKV('markets_snapshot',{}).calendars||{};
  const batches=[];for(let i=0;i<WATCH_INSTRUMENTS.length;i+=40)batches.push(WATCH_INSTRUMENTS.slice(i,i+40).map(d=>d.key));
  const results=await Promise.allSettled(batches.map(batch=>quoteProvider(batch)));
  const received=new Set();let historyReceived=0;
  for(let i=0;i<results.length;i++){
    const result=results[i];if(result.status!=='fulfilled'||!Array.isArray(result.value))continue;
    for(const raw of result.value){try{
      if(!batches[i].includes(raw.key))continue;
      const q=normalizeWatchQuote(raw,now);if(!newer(q,next.latest[q.key]))continue;
      next.latest[q.key]=q;received.add(q.key);
      if(q.time.slice(11,16)>=sessionClose('US',q.date,calendars)&&isCompleted(q.date,now,calendars)&&newer(q,next.closes[q.key]))next.closes[q.key]={...q,basis:'close'};
    }catch{}}
  }
  if(mode==='close'){
    const due=WATCH_INSTRUMENTS.filter(d=>{
      const q=next.latest[d.key],close=next.closes[d.key],historyAge=now-Date.parse(next.historyAt[d.key]);
      return q?.historyCode&&(!close||q.date>close.date)&&!(historyAge>=0&&historyAge<30*60000);
    });
    let cursor=0;const deadline=AbortSignal.timeout(18000);
    const worker=async()=>{while(cursor<due.length){const d=due[cursor++];try{
      deadline.throwIfAborted();next.historyAt[d.key]=now.toISOString();
      const r=await fetchImpl('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+encodeURIComponent(next.latest[d.key].historyCode)+',day,,,6,',{headers:{Referer:'https://gu.qq.com/','User-Agent':'Steady/1.0'},signal:AbortSignal.any([deadline,AbortSignal.timeout(8000)])});
      if(!r.ok)throw new Error('历史行情暂不可用');
      const close=parseWatchHistory(await r.json(),d.key,now,calendars,next.latest[d.key].historyCode);
      if(close&&newer(close,next.closes[d.key])){next.closes[d.key]=close;historyReceived++;}
    }catch{}}};
    await Promise.all(Array.from({length:Math.min(8,due.length)},worker));
  }
  const field=mode==='latest'?'latest':'closes',available=WATCH_INSTRUMENTS.filter(d=>next[field][d.key]).length;
  next.errors[mode]=!received.size&&!historyReceived?'本次行情更新失败，保留已保存的数据。':available<WATCH_INSTRUMENTS.length||received.size<WATCH_INSTRUMENTS.length?'部分证券本次行情未取得，保留已保存的有效数据。':null;
  if(received.size||historyReceived)next.updatedAt[mode]=now.toISOString();
  store.setKV(WATCH_CACHE,next);return watchboard(store,{mode,now});
}
