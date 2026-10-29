const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=n=>Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed=n=>n==null?'待更新':(n>0?'+':n<0?'−':'')+number(Math.abs(n));
const color=n=>n>0?'price-up':n<0?'price-down':'price-flat';
const btn=(action,label,attrs='')=>`<button class="btn btn-secondary" data-action="${action}" ${attrs}>${label}</button>`;
const staleDate=(q,date)=>q&&q.date!==date?`<p class="market-note">${esc(q.date)} · 数据滞后</p>`:'';
export function marketBriefCard(brief) {
  const us=brief.market==='US',ai=brief.ai?.scope==='market_only'?brief.ai:null,summary=ai?.status==='complete'?ai.summary:null;
  const points=summary?.points||brief.facts.publicLines.slice(0,4);
  return `<article class="card daily-market-brief"><div class="market-card-heading"><div class="brief-identity"><div><h2>${us?'美股':'港股'}每日简报</h2><time datetime="${esc(brief.date)}">${esc(brief.date)}</time></div></div><button class="text-btn" data-action="generate-market-brief" data-market="${brief.market}" ${ai?.status==='generating'?'disabled':''}>${ai?.status==='generating'?'总结中…':summary?'重新总结':'生成简报'}</button></div><h3>${esc(summary?.headline||brief.facts.headline)}</h3><ul>${points.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>${ai?.status==='failed'?'<p class="market-note">本次总结未完成，可重试。</p>':''}</article>`;
}
export function marketBriefsHTML(reports=[]) {
  return reports.length?`<div class="daily-market-briefs">${reports.map(marketBriefCard).join('')}</div>`:'';
}

function sectorsHTML(rows,{detail=false,scaleMax=null}={}) {
  const valid=rows.filter(r=>Number.isFinite(r.percent));
  if(!valid.length)return '<div class="market-chart-empty">行业涨跌数据尚未取得，更新后显示行业表现。</div>';
  const max=scaleMax??Math.max(...valid.map(r=>Math.abs(r.percent)));
  return `<ul class="sector-mosaic ${rows.length===11?'sector-mosaic-eleven':''} ${detail?'sector-mosaic-detail':''}" aria-label="${detail?'细分行业与主题':'美国大行业'} ETF 涨跌热力图">${rows.map((r,i)=>{
    const known=Number.isFinite(r.percent),level=known&&r.percent!==0?Math.max(1,Math.ceil(Math.abs(r.percent)/(max||1)*4)):0;
    const tone=!known?'missing':r.percent>0?'up':r.percent<0?'down':'flat';
    const position=rows.length===11?(i<9?`grid-column:${i%3*3+1}/span 3;grid-row:${Math.floor(i/3)*2+1}/span 2`:`grid-column:10/span 2;grid-row:${i===9?1:4}/span 3`):'';
    const reading=known?signed(r.percent)+'%':'待更新';
    return `<li class="sector-tile sector-${tone} sector-level-${level}" ${position?`style="${position}"`:''} tabindex="0" aria-label="${esc(r.name)}，${esc(r.code)}，${reading}，${esc(r.note||'')}"><span class="sector-tile-code">${esc(r.code)}${r.date?' · '+esc(r.date.slice(5)):''}</span><strong>${esc(r.name)}</strong><b>${reading}</b><span class="sector-tile-note">${esc(r.note||'')}</span></li>`;
  }).join('')}</ul><div class="sector-map-legend"><span><i class="sector-up sector-level-3"></i>上涨</span><span><i class="sector-flat"></i>持平</span><span><i class="sector-down sector-level-3"></i>下跌</span><small>颜色越深，涨跌幅越大 · 等权样本，不代表行业市值占比</small></div>`;
}

function chartRows(series) {
  const history=series?.history||[],latest=series?.latest;
  return latest&&(!history.length||latest.date>history.at(-1).date)?[...history,{...latest,snapshot:true}]:history;
}
function chartHTML(series,selectedDate) {
  const rows=chartRows(series);
  if(rows.length<2)return `<div class="market-chart-empty">${rows.length?'已保存 '+rows.length+' 个交易日':'尚未取得历史数据'}，至少两个交易日后显示走势。</div>`;
  const values=rows.map(r=>r.price),min=Math.min(...values),max=Math.max(...values),pad=(max-min)*.12||max*.01||1,lo=min-pad,hi=max+pad;
  const first=Date.parse(rows[0].date),last=Date.parse(rows.at(-1).date),x=d=>52+(Date.parse(d)-first)/(last-first||1)*608,y=p=>14+(hi-p)/(hi-lo)*180;
  const selected=rows.find(r=>r.date===selectedDate)||rows.at(-1);
  const path=points=>points.map((r,i)=>(i?'L':'M')+x(r.date).toFixed(2)+','+y(r.price).toFixed(2)).join(' ');
  const snapshot=rows.at(-1).snapshot;
  const label=r=>r.snapshot?(r.time||r.date)+' · 最新快照':r.date+' 收盘';
  return `<div class="market-chart-reading"><strong>${number(selected.price)} <small>点</small></strong><span>${esc(label(selected))}</span></div><svg class="market-history-chart" viewBox="0 0 680 230" role="img" aria-label="${esc(series.name)} ${esc(rows[0].date)}至${esc(rows.at(-1).date)}走势${snapshot?'，虚线为最新快照':''}">${[lo,(lo+hi)/2,hi].map(v=>`<line x1="52" y1="${y(v)}" x2="660" y2="${y(v)}" class="market-gridline"/><text x="44" y="${y(v)+4}" text-anchor="end">${number(v)}</text>`).join('')}<path d="${path(rows.filter(r=>!r.snapshot))}" class="market-line"/>${snapshot?`<path d="${path(rows.slice(-2))}" class="market-line market-live-line"/>`:''}${rows.map(r=>`<circle cx="${x(r.date)}" cy="${y(r.price)}" r="${r.date===selected.date?5:3}" class="market-chart-point" tabindex="0" role="button" data-action="market-point" data-date="${esc(r.date)}" aria-label="${esc(label(r))} ${number(r.price)}点"><title>${esc(label(r))} · ${number(r.price)}点</title></circle>`).join('')}<text x="52" y="223">${esc(rows[0].date)}</text><text x="660" y="223" text-anchor="end">${esc(rows.at(-1).date)}</text></svg>`;
}
function sentimentHTML(f,date) {
  const known=Number.isFinite(f?.score),stale=known&&f.date!==date;
  const note=known?[stale?f.date+' · 数据滞后':'',f.previous==null?'':'较前收 '+signed(f.score-f.previous)+' 点'].filter(Boolean).join(' · '):'';
  return `<article class="card market-sentiment"><div class="market-card-heading"><div><h2>市场情绪</h2><p>CNN Fear &amp; Greed Index</p></div><span class="pill info">0–100</span></div><div class="market-sentiment-score">${known?number(f.score):'—'}<span>${known?esc(f.rating):'暂不可用'}</span></div><div class="market-gauge ${known?'':'unavailable'}" role="img" aria-label="${known?'CNN 情绪指数 '+number(f.score):'CNN 指数未取得，无读数'}">${known?`<i style="left:${f.score}%"></i>`:''}</div><div class="market-gauge-labels"><span>0 · 极度恐惧</span><span>50 · 中性</span><span>100 · 极度贪婪</span></div>${note?`<p class="market-note">${esc(note)}</p>`:''}</article>`;
}
function buffettHTML(value) {
  if(!value||![value.percent,value.marketCapBillions,value.gdpBillions].every(n=>Number.isFinite(n)&&n>0))return '';
  return `<article class="card market-sentiment market-buffett"><div class="market-card-heading"><div><h2>巴菲特指标</h2><p>${esc(value.period)} · 季度估值</p></div></div><div class="market-sentiment-score">${number(value.percent)}<span>%</span></div><p class="market-note">公开交易股权市值相当于年化 GDP 的 ${number(value.percent/100)} 倍。</p><dl class="market-buffett-inputs"><div><dt>公开交易股权市值</dt><dd>${number(value.marketCapBillions/1000)} 万亿美元</dd></div><div><dt>年化名义 GDP</dt><dd>${number(value.gdpBillions/1000)} 万亿美元</dd></div></dl><details class="market-buffett-method"><summary>计算口径与来源</summary><p>${esc(value.methodology)}</p><p>同季度市值 ÷ 年化 GDP × 100%，按季度公布；用于观察长期估值。</p><p><a href="https://fred.stlouisfed.org/series/BOGZ1LM883164115Q" target="_blank" rel="noopener noreferrer">美联储 Z.1 市值</a> · <a href="https://fred.stlouisfed.org/series/GDP" target="_blank" rel="noopener noreferrer">BEA 名义 GDP</a></p></details></article>`;
}
function contextHistoryHTML(item) {
  const rows=item.history||[];
  if(rows.length<2)return '';
  const values=rows.map(r=>r.value),min=Math.min(...values),max=Math.max(...values),pad=(max-min)*.15||.1,lo=min-pad,hi=max+pad;
  const first=Date.parse(rows[0].date),last=Date.parse(rows.at(-1).date),x=r=>6+(Date.parse(r.date)-first)/(last-first||1)*288,y=v=>8+(hi-v)/(hi-lo)*58;
  return `<svg class="context-sparkline" viewBox="0 0 300 84" role="img" aria-label="${esc(item.name)}，${esc(rows[0].date)}至${esc(rows.at(-1).date)}，最低 ${number(min)}，最高 ${number(max)} ${esc(item.unit)}">${lo<0&&hi>0?`<line class="market-gridline" x1="6" x2="294" y1="${y(0)}" y2="${y(0)}"/>`:''}<path class="market-line" d="${rows.map((r,i)=>(i?'L':'M')+x(r).toFixed(2)+','+y(r.value).toFixed(2)).join(' ')}"/><text x="6" y="81">${esc(rows[0].date.slice(5))}</text><text x="294" y="81" text-anchor="end">${esc(rows.at(-1).date.slice(5))}</text></svg><p class="context-range">区间 ${number(min)}–${number(max)} ${esc(item.unit)} · 各图独立刻度</p>`;
}
function marketIndicatorsHTML(items) {
  if(!items.length)return '';
  const available=items.filter(i=>Number.isFinite(i.value)),missing=items.filter(i=>!Number.isFinite(i.value));
  const missingHTML=missing.length?`<details class="context-source"><summary>${available.length?'部分宏观数据暂不可用':'宏观数据暂未取得'} · ${missing.length} 项</summary><p>${missing.map(i=>`<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.name)}</a>`).join(' · ')}；来源恢复后自动补充。</p></details>`:'';
  return `<section class="market-indicators"><div class="market-section-heading"><h2>宏观与风险温度</h2><p>按各来源实际披露日 · 利率与风险指标不代表买卖信号</p></div><div class="context-grid">${available.map(item=>`<article class="card context-card"><h3>${esc(item.name)}</h3><div class="context-value">${item.value==null?'—':number(item.value)} <small>${esc(item.unit)}</small></div><p class="context-date">${item.date?esc(item.date):'尚未取得数据'}${item.status==='cached'?' · 更新失败，保留记录':item.status==='lagged'?' · 来源滞后 '+item.lagDays+' 天':''}</p>${item.change==null?'':`<p class="context-change">较 ${esc(item.previousDate)} ${signed(item.change)} ${item.unit==='%'?'百分点':esc(item.unit)}</p>`}${contextHistoryHTML(item)}<p class="market-note">${esc(item.note)}</p><details class="context-source"><summary>来源与历史记录</summary><p><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.source)} ↗</a></p>${item.history?.length?`<div class="table-scroll"><table><thead><tr><th>日期</th><th>${esc(item.unit)}</th></tr></thead><tbody>${[...item.history].reverse().map(r=>`<tr><td>${esc(r.date)}</td><td>${number(r.value)}</td></tr>`).join('')}</tbody></table></div>`:'<p>来源恢复后自动补充。</p>'}</details></article>`).join('')}</div>${missingHTML}</section>`;
}
function activityHTML(items) {
  if(!items.length)return '';
  const amount=(v,unit)=>Number.isFinite(v)?number(v>=1e8?v/1e8:v/1e4)+(v>=1e8?' 亿':' 万')+unit:'—';
  return `<article class="card market-activity"><div class="market-card-heading"><div><h2>成交活跃度</h2><p>代表性 ETF 样本 · 不等同全市场成交量或资金净流入</p></div></div><div class="table-scroll"><table><thead><tr><th>样本</th><th>最新成交量</th><th>最新成交额</th><th>最近收盘 / 前 20 日均量</th></tr></thead><tbody>${items.map(item=>{const q=Number.isFinite(item.latest?.volume)?item.latest:item.closed;return `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.key)}</small></td><td>${amount(q?.volume,'股')}<small>${esc(q?.time||q?.date||'等待行情')}</small></td><td>${amount(q?.turnover,item.currency==='USD'?'美元':'港元')}<small>${esc(q?.source||'')}</small></td><td>${item.relativeVolume==null?'—':number(item.relativeVolume)+' 倍'}<small>${esc(item.closed?.date||'等待收盘记录')}${item.relativeVolume==null?' · 需前 20 个完整交易日成交量':' 收盘'}</small></td></tr>`;}).join('')}</tbody></table></div><p class="market-note">最新成交量可能为盘中累计；量比只使用完整交易日，分母为此前 20 个交易日均量，不含当日。不用盘中累计量与全天均量比较。</p></article>`;
}

export function marketPageHTML(market,view,{loading=false,error='',seriesKey='',selectedDate='',briefOpen=false}={}) {
  const us=market==='US',title=us?'美国市场':'港股市场',date=view?.latestDate||view?.date;
  const head=`<div class="page-heading mobile-wrap"><div><h1>${title}</h1><p>最新可用行情 · ${us?'美国东岸时间':'香港时间'} · ${date||'等待数据'}</p></div><div class="heading-actions">${btn('refresh-markets',loading?'正在更新…':'更新市场数据',loading?'disabled':'')}</div></div>${error?`<div class="market-load-error" role="alert"><div><strong>本次更新未完成${view?'，保留上次数据':''}</strong><p>${esc(error)}</p></div>${btn('refresh-markets','重试',loading?'disabled':'')}</div>`:''}`;
  if(!view)return head+`<div class="card market-chart-empty" role="status">${loading?'正在读取市场数据…':'暂未读取到市场数据，请点击更新重试。'}</div>`;
  const indices=view.benchmarks,selected=indices.find(d=>d.key===seriesKey)||indices[0];
  const indexCards=indices.map(d=>{const q=d.latest||d.quote;return `<article class="card market-index"><span>${esc(d.name)}</span><strong>${q?number(q.price):'—'}</strong><b class="${color(q?.percent)}">${q?.percent==null?'待更新':signed(q.percent)+'%'}<small>${q?.change==null?'':signed(q.change)+' 点'}</small></b>${staleDate(q,date)}${q?`<p class="market-source">${esc(q.source||'')} · ${esc(q.time||q.date+' 收盘')}</p>`:''}</article>`;}).join('');
  const sectors=view.sectors.map(d=>{const q=d.latest||d.quote;return {name:d.name,code:d.key.slice(3),percent:q?.percent??null,date:q?.date||null,note:q?(q.time||q.date+' 收盘')+' · '+(q.source||''):'行情待更新'};});
  const industries=(view.industries||[]).map(d=>{const q=d.latest||d.quote;return {name:d.name,code:d.key.slice(3),percent:q?.percent??null,date:q?.date||null,note:q?(q.time||q.date+' 收盘')+' · '+(q.source||''):'行情待更新'};});
  const sectorScale=Math.max(0,...[...sectors,...industries].filter(r=>Number.isFinite(r.percent)).map(r=>Math.abs(r.percent)));
  const recap=view.latestRecap;
  const summary=`<article class="card market-recap"><div class="market-card-heading"><div><h2>行情摘要</h2><p>${esc(date||'等待数据')} · 随行情快照更新</p></div></div>${recap?.sections.length?`<dl class="market-recap-points">${recap.sections.map(s=>`<div><dt>${esc(s.label)}</dt><dd>${esc(s.text)}</dd></div>`).join('')}</dl>`:`<p>${esc(view.latestSummary||view.summary)}</p>`}</article>`;
  const trendNote=chartRows(selected).at(-1)?.snapshot?'最近 30 个交易日收盘记录 + 最新快照 · 虚线为最新报价':'最近 30 个完整交易日';
  const checkedAt=new Date(view.latestCheckedAt),checked=Number.isFinite(checkedAt.getTime())&&view.latestCheckedAt?new Intl.DateTimeFormat('sv-SE',{timeZone:us?'America/New_York':'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(checkedAt):'';
  const brief=view.brief?`<details class="market-archive" data-market="${market}" ${briefOpen?'open':''}><summary>最近收盘简报 · ${esc(view.brief.date)} 收盘</summary>${marketBriefCard(view.brief)}</details>`:'';
  const vix=view.volatility?.latest||view.volatility?.quote,volatility=vix?.date===date&&Number.isFinite(vix.price)&&vix.price>0?vix:null;
  const mood=view.sentiment,sentiment=us&&mood?.date===date&&Number.isFinite(mood.score)&&mood.score>=0&&mood.score<=100&&!mood.error?sentimentHTML(mood,date):'';
  const marketContext=sentiment+(us?buffettHTML(view.buffett):'');
  return head+`
    <div class="market-data-context"><span>指数与行情每分钟同步检查 · 时间以来源为准</span>${checked?`<span>最近检查 ${esc(checked)}</span>`:''}</div>
    ${view.latestError||view.error?`<p class="market-notice" role="status">${esc(view.latestError||view.error)}</p>`:''}
    <div class="market-indices">${indexCards}</div>${summary}
    <div class="market-layout${!marketContext?' market-layout-single':''}">
      <article class="card market-trend"><div class="market-card-heading"><div><h2>指数走势</h2><p>${esc(trendNote)}</p></div></div><div class="market-series-tabs" role="group" aria-label="选择指数">${indices.map(d=>`<button class="filter ${d.key===selected?.key?'active':''}" data-action="market-series" data-key="${esc(d.key)}">${esc(d.name)}</button>`).join('')}</div>${chartHTML(selected,selectedDate)}</article>
      ${marketContext?`<div class="market-context">${marketContext}</div>`:''}
    </div>
    ${marketIndicatorsHTML(view.context||[])}${activityHTML(view.activity||[])}
    ${us?`<article class="card market-sectors"><div class="market-card-heading"><div><h2>美国行业表现</h2><p>${sectors.length+industries.length} 个观察板块 · ${sectors.length} 个大行业${industries.length?' + '+industries.length+' 个细分与主题':''}</p></div></div><div class="sector-group-heading"><h3>大行业</h3><span>最新可用快照 · 报价日期见各方块</span></div>${sectorsHTML(sectors,{scaleMax:sectorScale})}${industries.length?`<div class="sector-group-heading"><h3>细分行业与主题</h3><span>美股上市 ETF · 报价日期见各方块</span></div>${sectorsHTML(industries,{detail:true,scaleMax:sectorScale})}<p class="market-note">细分与主题可能包含全球公司，并与大行业持仓重叠；行情摘要中的行业广度按上方大行业统计。</p>`:''}</article>`:''}
    ${us&&volatility?`<div class="market-vix"><strong>VIX 波动率</strong><span>${number(volatility.price)} 点</span><span>${esc(volatility.time||volatility.date)}</span></div>`:''}${brief}`;
}
