const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=n=>typeof n==='number'&&Number.isFinite(n);
const number=(n,digits=2)=>known(n)?n.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
const tone=n=>!known(n)?'price-flat':n>0?'price-up':n<0?'price-down':'price-flat';
const signed=(n,scale=1,digits=2)=>known(n)?`${n>0?'+':n<0?'−':''}${number(Math.abs(n)/scale,digits)}`:'—';
const money=n=>known(n)?signed(n,1e8)+' 亿':'—';
const stamp=value=>value?esc(value):'等待数据';
const checked=view=>view?.attemptedAt?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(view.attemptedAt)):'尚未检查';
function heading(title,description,loading){return `<div class="page-heading mobile-wrap"><div><h1>${title}</h1><p>${description}</p></div><button class="btn btn-secondary" data-action="refresh-cn-market" ${loading?'disabled':''}>${loading?'更新中…':'更新市场数据'}</button></div>`;}
function errorsHTML(view,error){const errors=[...new Set([error,...Object.values(view?.errors||{})].filter(Boolean))];return errors.length?`<div class="cn-data-notice" role="status">${errors.map(e=>`<p>${esc(e)}</p>`).join('')}</div>`:'';}
function identity(item){return `<strong>${esc(item.name)}</strong><small>${esc(item.key.slice(3))} · ${esc(item.index)}</small>`;}
function summaryHTML(view){return `<div class="cn-flow-summary"><article class="card"><span>观察样本主力净流入 · 逐单估算</span><strong class="${tone(view?.summary?.mainNet)}">${money(view?.summary?.mainNet)}</strong><small>${stamp(view?.summary?.flowDate)} · 六只同日数据齐全后汇总</small></article><article class="card"><span>观察样本净申赎 · 收盘价估算</span><strong class="${tone(view?.summary?.estimatedNet)}">${money(view?.summary?.estimatedNet)}</strong><small>${stamp(view?.summary?.dailyDate)} · 六只同日数据齐全后汇总</small></article></div>`;}

export function cnMarketPageHTML(view,{loading=false,error=''}={}) {
  return `<div class="cn-market-page">${heading('沪深市场','主要指数与重点宽基 ETF · 北京时间',loading)}${errorsHTML(view,error)}
    <div class="market-indices cn-market-indices">${(view?.benchmarks||[]).map(item=>{const q=item.quote;return `<article class="card market-index"><span>${esc(item.name)} <small>${esc(item.key.slice(3))}</small></span><strong>${number(q?.price)}</strong><b class="${tone(q?.percent)}">${known(q?.percent)?signed(q.percent)+'%':'待更新'}</b><p class="market-source">${q?`${esc(q.source)} · ${stamp(q.time)}`:'尚未取得有效报价'}</p></article>`;}).join('')||'<div class="market-chart-empty">正在读取沪深指数…</div>'}</div>
    <div class="cn-section-heading"><div><h2>重点 ETF 资金动向</h2><p>四只沪深300 ETF、上证50与中证500</p></div><a href="#cn-etf" class="text-btn">查看资金观察 ↗</a></div>${summaryHTML(view)}
    <p class="cn-market-foot">${esc(view?.notice||'ETF资金数据不能识别国家队买方身份。')}<br>页面可见时每分钟检查一次 · 最近检查 ${checked(view)} · 报价可能延迟，以每项来源时间为准。</p></div>`;
}

export function etfFlowsPageHTML(view,{loading=false,error=''}={}) {
  const items=view?.items||[];
  return `<div class="cn-market-page">${heading('ETF 资金观察','重点宽基 ETF 的盘中资金流估算与每日份额 · 北京时间',loading)}
    <p class="cn-scope-note">这里观察的是 ETF 整体资金动向，不能据此确认汇金或其他国家队机构的买卖。</p>${errorsHTML(view,error)}${summaryHTML(view)}
    <section class="card cn-flow-section"><div class="cn-section-heading"><div><h2>盘中资金动向</h2><p>二级市场逐单估算，不是基金净申购；主力净流入已包含超大单，二者不相加。</p></div><span>${items.filter(i=>i.flow).length} / 6 只</span></div>
    <p class="cn-table-scroll-hint">左右滑动查看完整数据</p><div class="table-scroll"><table class="cn-flow-table"><thead><tr><th>ETF</th><th>价格 / 涨跌</th><th>成交额</th><th>主力净流入</th><th>超大单净流入</th></tr></thead><tbody>${items.map(item=>`<tr><td>${identity(item)}</td><td><strong>${number(item.quote?.price,3)}</strong><small class="${tone(item.quote?.percent)}">${known(item.quote?.percent)?signed(item.quote.percent)+'%':'—'}</small><small>${stamp(item.quote?.time)}</small></td><td>${known(item.quote?.amount)?number(item.quote.amount/1e8)+' 亿':'—'}</td><td class="${tone(item.flow?.mainNet)}"><strong>${money(item.flow?.mainNet)}</strong><small>${stamp(item.flow?.time)}</small></td><td class="${tone(item.flow?.superNet)}">${money(item.flow?.superNet)}</td></tr>`).join('')||'<tr><td colspan="5">正在读取观察列表…</td></tr>'}</tbody></table></div><p class="cn-table-foot">资金流来源：东方财富 · 报价来源：东方财富 / 腾讯证券 · 报价和资金流按各自来源时间展示。</p></section>
    <section class="card cn-flow-section"><div class="cn-section-heading"><div><h2>每日份额与净申赎</h2><p>份额变化 × 同日不复权收盘价；与前一交易日比较，缺少任一数据时不计算。</p></div><span>日频数据</span></div>
    <p class="cn-table-scroll-hint">左右滑动查看完整数据</p><div class="table-scroll"><table class="cn-flow-table"><thead><tr><th>ETF</th><th>总份额</th><th>份额变化</th><th>净申赎估算</th><th>份额所属日期</th></tr></thead><tbody>${items.map(item=>{const d=item.daily;return `<tr><td>${identity(item)}</td><td>${known(d?.shares)?number(d.shares/1e8)+' 亿份':'—'}</td><td class="${tone(d?.delta)}">${known(d?.delta)?signed(d.delta,1e4)+' 万份':'—'}</td><td class="${tone(d?.estimatedNet)}"><strong>${money(d?.estimatedNet)}</strong><small>${known(d?.price)?'按收盘价 ¥'+number(d.price,3):'等待同日收盘价'}</small></td><td>${stamp(d?.date)}<small>${d?.previousDate?'对比 '+stamp(d.previousDate):'等待前一交易日份额'}</small></td></tr>`;}).join('')||'<tr><td colspan="5">等待交易所每日份额…</td></tr>'}</tbody></table></div><p class="cn-table-foot">份额来源：上交所 / 深交所 · 深市只使用次日确认的历史份额 · 每小时检查披露更新。</p></section>
    <details class="card market-methods"><summary>数据口径与来源</summary><p>盘中资金流按成交单分类估算；每日份额变化反映全市场申购赎回。二级市场买入已有份额不会改变基金总份额。两种指标均不识别交易者身份，也不能直接推导国家队净买入。</p><p>净申赎金额按收盘价近似计算，属于研究估算，不是基金按净值结算的实际现金流。缺失数据留空；更新失败保留旧记录及原始日期，避免把旧值当作今日数据。</p><p><a href="https://www.sse.com.cn/market/funddata/volumn/etfvolumn/" target="_blank" rel="noopener noreferrer">上交所 ETF 份额</a> · <a href="https://fund.szse.cn/marketdata/fundslist/index.html" target="_blank" rel="noopener noreferrer">深交所基金列表</a> · <a href="https://quote.eastmoney.com/center/gridlist.html#fund_etf" target="_blank" rel="noopener noreferrer">东方财富 ETF 行情</a></p></details>
    <p class="cn-market-foot">页面可见时每分钟检查一次 · 最近检查 ${checked(view)} · 免费数据可能延迟或中断，以来源日期为准。</p></div>`;
}
