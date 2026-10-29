import { watchboardLogos } from './watchboard-logos.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=n=>typeof n==='number'&&Number.isFinite(n);
const signed=(n,digits=1)=>known(n)?`${n>0?'+':n<0?'−':''}${Math.abs(n).toFixed(digits)}%`:'待更新';
const tone=n=>!known(n)?'unknown':n>0?'gain':n<0?'loss':'flat';
const price=q=>q?`$${q.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'—';
const quoteFor=(item,mode)=>item?.[mode==='close'?'close':'latest'];
const normalized=value=>String(value).normalize('NFKC').toUpperCase().replace(/\s+/g,'');
function selectedGroups(view,{query='',mode='latest'}={}) {
  const needle=normalized(query),items=new Map((view?.items||[]).map(i=>[i.key,i]));
  return (view?.groups||[]).map(g=>({...g,items:g.keys.map(k=>items.get(k)).filter(Boolean).filter(i=>!needle||normalized(i.name+i.symbol).includes(needle)).sort((a,b)=>{
    const x=quoteFor(a,mode)?.percent,y=quoteFor(b,mode)?.percent;
    return (known(x)&&known(y)?y-x:known(x)?-1:known(y)?1:0)||a.symbol.localeCompare(b.symbol);
  })})).filter(g=>g.items.length);
}
function logoHTML(item) {
  const slug=watchboardLogos[item.symbol];
  return `<span class="watchboard-logo ${slug?'has-logo':''}">${slug?`<img src="/logos/${slug}.svg" alt="" width="34" height="34" loading="lazy">`:`<span>${esc(item.symbol)}</span>`}</span>`;
}
function cardHTML(item,mode,latestDate) {
  const q=quoteFor(item,mode),stale=q&&latestDate&&q.date<latestDate;
  return `<button class="watchboard-tile watchboard-${tone(q?.percent)}" data-action="watchboard-quote" data-key="${esc(item.key)}" aria-label="${esc(item.name)}，${item.symbol}，${signed(q?.percent)}${q?'，'+esc(q.time||q.date):'，暂无报价'}" title="${esc(item.name)} · ${item.symbol}${q?' · '+esc(q.time||q.date)+' 美国东部时间':''}">${logoHTML(item)}<span class="watchboard-name">${esc(item.name)}</span><small class="watchboard-symbol">${item.symbol}</small><strong>${signed(q?.percent)}</strong><span class="watchboard-tile-foot">${q?`${price(q)}<time>${esc(q.date.slice(5))}${stale?' · 旧数据':''}</time>`:'暂无有效报价'}</span></button>`;
}
export function watchboardGroupsHTML(view,{query='',mode='latest'}={}) {
  const groups=selectedGroups(view,{query,mode}),items=view?.items||[],field=mode==='close'?'close':'latest';
  const dates=items.map(i=>i[field]?.date).filter(Boolean).sort(),latestDate=dates.at(-1)||null;
  if(!groups.length)return `<div class="watchboard-empty">${query?'没有找到匹配的股票或 ETF。':'正在准备观察列表…'}${query?'<button class="text-btn" data-action="clear-watchboard-query">清除搜索</button>':''}</div>`;
  return groups.map(g=>`<section class="watchboard-group" aria-labelledby="watchboard-${g.id}"><div class="watchboard-group-heading"><h2 id="watchboard-${g.id}">${g.title}</h2><span>${g.items.length} 项</span></div><div class="watchboard-grid">${g.items.map(i=>cardHTML(i,mode,latestDate)).join('')}</div></section>`).join('');
}
export function watchboardPageHTML(view,{mode='latest',query='',loading=false,error=''}={}) {
  const field=mode==='close'?'close':'latest',items=view?.items||[],available=items.filter(i=>i[field]).length,dates=items.map(i=>i[field]?.date).filter(Boolean).sort(),date=dates.at(-1);
  return `<div class="watchboard-page"><div class="page-heading"><div><div class="monthly-eyebrow">美国市场 <span>/</span> MARKET WATCH</div><h1>美股行情</h1><p>热门公司、ETF 与行业样本，按涨跌幅从高到低浏览。</p></div><div class="watchboard-coverage"><strong>${available}<small> / ${view?.total||'—'}</small></strong><span>只证券有${mode==='close'?'收盘':'行情'}数据</span></div></div>
  <div class="watchboard-toolbar"><div class="watchboard-switch" role="group" aria-label="行情口径"><button data-action="watchboard-mode" data-mode="latest" class="${mode==='latest'?'active':''}" aria-pressed="${mode==='latest'}" ${loading?'disabled':''}>当前行情</button><button data-action="watchboard-mode" data-mode="close" class="${mode==='close'?'active':''}" aria-pressed="${mode==='close'}" ${loading?'disabled':''}>最近收盘</button></div><label class="watchboard-search"><span class="sr-only">搜索股票名称或代码</span><input id="watchboard-search" type="search" placeholder="搜索名称或代码" value="${esc(query)}" autocomplete="off"></label><div class="watchboard-actions"><button class="text-btn" data-action="copy-watchboard" ${!available?'disabled':''}>复制行情</button><button class="btn btn-secondary" data-action="refresh-watchboard" ${loading?'disabled':''}>${loading?'更新中…':'更新行情'}</button></div></div>
  <div class="watchboard-caption"><span>${mode==='close'?'已完成交易日的收盘记录':'最新可用报价快照'}${date?' · '+esc(date):''} · 美国东部时间</span><span><i class="watchboard-dot gain"></i>上涨 <i class="watchboard-dot loss"></i>下跌${loading?' · 正在检查更新':''}</span></div>
  ${error||view?.error?`<div class="monthly-notice" role="status">${esc(error||view.error)}</div>`:''}
  <div id="watchboard-results" aria-busy="${loading}">${watchboardGroupsHTML(view,{mode,query})}</div>
  <p class="watchboard-method">${esc(view?.method||'预设观察样本；缺失数据不补零，报价时间以来源为准。')}<br>来源：<a href="https://gu.qq.com/" target="_blank" rel="noopener noreferrer">腾讯证券</a> · 公司标识由 Simple Icons 提供，其余使用证券代码。</p></div>`;
}
export function watchboardQuoteHTML(item,{mode='latest'}={}) {
  const panel=(label,q)=>`<section class="watchboard-detail-quote"><span>${label}</span><strong>${price(q)}</strong><b class="watchboard-text-${tone(q?.percent)}">${signed(q?.percent,2)}</b><p>${q?`${esc(q.time||q.date)} · 美国东部时间<br>${esc(q.source)}${q.previous?`<br>对比前收盘 $${q.previous.price.toFixed(2)}`:''}`:'尚未取得有效数据'}</p></section>`;
  return `<div class="watchboard-detail"><div class="watchboard-detail-brand">${logoHTML(item)}<span>${item.symbol} · ${item.kind==='etf'?'ETF':'美股上市证券'} · USD</span></div><div class="watchboard-detail-grid">${mode==='close'?panel('最近收盘',item.close)+panel('最新报价快照',item.latest):panel('最新报价快照',item.latest)+panel('最近收盘',item.close)}</div><p class="watchboard-method">报价可能延迟；按所示来源时间读取，不将旧报价或盘中价格当作本日收盘。</p><a class="text-btn" href="https://gu.qq.com/us${encodeURIComponent(item.symbol)}/gp" target="_blank" rel="noopener noreferrer">在腾讯证券查看 ${item.symbol} ↗</a></div>`;
}
export function watchboardCopyText(view,options={}) {
  const mode=options.mode||'latest';
  return [`美股行情 · ${mode==='close'?'最近收盘':'最新可用快照'} · 美国东部时间`,...selectedGroups(view,{...options,mode}).flatMap(g=>['',g.title,...g.items.map(i=>{const q=quoteFor(i,mode);return `${i.symbol} ${i.name} ${signed(q?.percent,2)} ${price(q)} ${q?.time||q?.date||'无数据'}`;})])].join('\n');
}
