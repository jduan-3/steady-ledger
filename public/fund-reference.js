const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=value=>typeof value==='number'&&Number.isFinite(value);
const tone=value=>!known(value)||value===0?'price-flat':value>0?'price-up':'price-down';
const decimal=(value,digits=3)=>known(value)?value.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
const percent=value=>known(value)?(value>0?'+':value<0?'−':'')+Math.abs(value).toFixed(2)+'%':'—';
const units=(value,unit)=>!known(value)?'—':value>=1e8?decimal(value/1e8,2)+' 亿'+unit:value>=1e4?decimal(value/1e4,2)+' 万'+unit:decimal(value,0)+' '+unit;
const href=url=>/^https:\/\//.test(url||'')?esc(url):'';

export function fundReferenceChartHTML(view,mode='intraday',selectedIndex=null,{currency='CNY',volumeUnit='份',instrumentLabel='参考ETF',selectorLabel='选择行情时间',volumeSelectedIndex=null}={}) {
  const series=mode==='intraday'?view?.intraday:view?.history,points=series?.points||[];
  if(!points.length)return '<p class="fund-reference-empty">暂无可绘制的'+(mode==='intraday'?'分时':'日线')+'数据，更新后再查看。</p>';
  const selectedAt=value=>Number.isInteger(value)?Math.max(0,Math.min(points.length-1,value)):points.length-1;
  const index=selectedAt(selectedIndex),selected=points[index],volumeIndex=selectedAt(volumeSelectedIndex),volumePoint=points[volumeIndex];
  const prices=points.map(p=>p.price),min=Math.min(...prices),max=Math.max(...prices),range=Math.max(max-min,max*.004),low=Math.max(0,min-range*.15),high=max+range*.15;
  const minute=time=>Number(time.slice(0,2))*60+Number(time.slice(3)),start=mode==='intraday'?minute(points[0].time):0,end=mode==='intraday'?minute(points.at(-1).time):points.length-1;
  const x=(point,i)=>start===end?500:4+((mode==='intraday'?minute(point.time):i)-start)/(end-start)*992,y=price=>12+(high-price)/(high-low)*138;
  let path='';
  points.forEach((point,i)=>{const gap=mode==='intraday'&&i>0&&minute(point.time)-minute(points[i-1].time)>5;path+=(i===0||gap?'M':'L')+x(point,i).toFixed(2)+' '+y(point.price).toFixed(2);});
  const peakVolume=Math.max(0,...points.map(p=>known(p.volume)?p.volume:0)),maxVolume=Math.max(1,peakVolume),width=Math.max(1,Math.min(10,760/points.length));
  const label=point=>mode==='intraday'?point.time:point.date;
  const volumeDirection=(point,i)=>{
    const base=i>0?points[i-1].price:mode==='intraday'&&view.quote?.date===series.date?view.quote.previous?.price:null;
    if(!known(base)||base<=0)return {tone:'flat',label:'缺少比较价'};
    const comparison=i>0?(mode==='intraday'?'较上一已返回时点':'较上一条日线收盘'):'较该日昨收';
    return {tone:point.price>base?'up':point.price<base?'down':'flat',label:comparison+(point.price>base?'上涨':point.price<base?'下跌':'持平')};
  };
  const previous=mode==='intraday'&&view.quote?.date===series.date?view.quote?.previous?.price:mode==='daily'&&index>0?points[index-1].price:null;
  const change=known(previous)&&previous>0?(selected.price/previous-1)*100:null;
  const readingTime=point=>mode==='intraday'?series.date+' '+point.time:point.date;
  const volumePeriod=mode==='intraday'?(volumeIndex>0?points[volumeIndex-1].time+'–'+volumePoint.time:'首个返回时点前累计'):'当日成交量';
  const controls=(chart,position)=>`<div class="fund-reference-controls"><label><span>${chart==='price'?'价格时间':'成交量时间'}</span><select data-fund-reference-select data-chart="${chart}" aria-label="${esc(selectorLabel)} · ${chart==='price'?'价格':'成交量'}">${points.map((point,i)=>`<option value="${i}"${i===position?' selected':''}>${esc(label(point))}${i===points.length-1?' · 最新':''}</option>`).join('')}</select></label><div class="fund-reference-steps" role="group" aria-label="${chart==='price'?'价格':'成交量'}选点"><button type="button" data-action="fund-reference-step" data-chart="${chart}" data-step="previous" aria-label="${chart==='price'?'价格':'成交量'}上一个${mode==='intraday'?'时点':'交易日'}"${position===0?' disabled':''}>←</button><button type="button" data-action="fund-reference-step" data-chart="${chart}" data-step="next" aria-label="${chart==='price'?'价格':'成交量'}下一个${mode==='intraday'?'时点':'交易日'}"${position===points.length-1?' disabled':''}>→</button><button type="button" data-action="fund-reference-step" data-chart="${chart}" data-step="latest"${position===points.length-1?' disabled':''}>回到最新</button></div></div>`;
  const targets=(chart,height)=>points.map((point,i)=>{
    const left=i>0?(x(points[i-1],i-1)+x(point,i))/2:0,right=i<points.length-1?(x(point,i)+x(points[i+1],i+1))/2:1000;
    return `<rect class="fund-reference-hit" data-action="fund-reference-point" data-chart="${chart}" data-index="${i}" x="${left}" y="0" width="${right-left}" height="${height}"><title>${esc(label(point))} · ${chart==='price'?decimal(point.price)+' '+esc(currency):units(point.volume,esc(volumeUnit))}</title></rect>`;
  }).join('');
  const slider=(chart,position,value)=>`class="fund-reference-chart" data-reference-chart="${chart}" tabindex="0" role="slider" aria-label="${esc(instrumentLabel)}${chart==='price'?'价格':'成交量'}选点，左右方向键切换" aria-valuemin="0" aria-valuemax="${points.length-1}" aria-valuenow="${position}" aria-valuetext="${esc(readingTime(points[position]))} · ${value}"`;
  const timeLabels=`<div class="fund-reference-x-labels"><span>${esc(label(points[0]))}</span><span>${esc(label(points.at(-1)))}</span></div>`;
  return `<p class="fund-reference-chart-help">点击图中位置查看数据；两张图可分别选择时间。</p>
    <section class="fund-reference-panel" data-reference-panel="price"><div class="fund-reference-panel-heading"><h4>价格走势</h4><span>${esc(currency)} / ${esc(volumeUnit)}</span></div><p class="fund-reference-chart-caption">${mode==='intraday'?'折线表示当天各时点的成交价格，看价格如何变化。':'折线表示各交易日的收盘价；当日未收盘时显示暂计价格。'}</p>
    <div class="fund-reference-reading" aria-live="polite"><div><strong>${decimal(selected.price)} <small>${esc(currency)}</small></strong><span>${esc(readingTime(selected))}${selected.status==='partial'?' · 当日暂计':''}</span></div><div><b class="${tone(change)}">${percent(change)}</b><span>${mode==='intraday'?'较该日昨收':'较上一条日线收盘'}</span></div></div>
    <div class="fund-reference-plot"><div class="fund-reference-axis"><span>${decimal(high)}</span><span>${decimal((high+low)/2)}</span><span>${decimal(low)}</span></div><div class="fund-reference-graph"><svg ${slider('price',index,decimal(selected.price)+' '+esc(currency))} viewBox="0 0 1000 162" preserveAspectRatio="none"><title>${esc(instrumentLabel)}${mode==='intraday'?'分时':'日线'}价格走势</title><path class="fund-reference-grid" d="M0 12H1000M0 81H1000M0 150H1000"/><path class="fund-reference-price" d="${path}"/><line class="fund-reference-guide" x1="${x(selected,index)}" x2="${x(selected,index)}" y1="12" y2="150"/><circle class="fund-reference-selected" cx="${x(selected,index)}" cy="${y(selected.price)}" r="4"/>${targets('price',162)}</svg>${timeLabels}</div></div>${controls('price',index)}</section>
    <section class="fund-reference-panel" data-reference-panel="volume"><div class="fund-reference-panel-heading"><h4>成交量</h4><span>单位：${esc(volumeUnit)}</span></div><p class="fund-reference-chart-caption">${mode==='intraday'?'每根柱子表示一段时间内的成交数量；柱子越高，成交越多。':'每根柱子表示一个交易日的成交数量；柱子越高，成交越多。'}</p>
    <div class="fund-reference-reading" aria-live="polite"><div><strong>${units(volumePoint.volume,esc(volumeUnit))}</strong><span>${esc(readingTime(volumePoint))}${volumePoint.status==='partial'?' · 当日暂计':''}</span></div><div><b>${esc(volumePeriod)}</b><span>${known(volumePoint.volume)?mode==='intraday'?'这一段成交量':'该交易日成交量':'该时点成交量缺失'}</span></div></div>
    <div class="fund-reference-plot"><div class="fund-reference-axis"><span>${points.some(p=>known(p.volume))?units(peakVolume,esc(volumeUnit)):'—'}</span><span>0</span></div><div class="fund-reference-graph"><svg ${slider('volume',volumeIndex,units(volumePoint.volume,esc(volumeUnit)))} viewBox="0 0 1000 92" preserveAspectRatio="none"><title>${esc(instrumentLabel)}成交量，单位为${esc(volumeUnit)}；量柱红涨蓝跌，颜色不代表主动买卖</title><path class="fund-reference-grid" d="M0 8H1000M0 84H1000"/><line class="fund-reference-guide" x1="${x(volumePoint,volumeIndex)}" x2="${x(volumePoint,volumeIndex)}" y1="4" y2="84"/>${points.map((point,i)=>{if(!known(point.volume))return '';const direction=volumeDirection(point,i);return `<rect class="fund-reference-volume volume-${direction.tone}" data-selected="${i===volumeIndex}" x="${x(point,i)-width/2}" y="${84-point.volume/maxVolume*76}" width="${width}" height="${point.volume/maxVolume*76}"><title>${esc(label(point))} · ${units(point.volume,esc(volumeUnit))} · ${direction.label}</title></rect>`;}).join('')}${targets('volume',92)}</svg>${timeLabels}</div></div>${controls('volume',volumeIndex)}</section>
    ${mode==='intraday'&&(series.volumeDecreases||series.amountDecreases)?'<p class="fund-reference-status" role="status">来源累计成交量或成交额有回退，对应时点的量或额留空；保留价格，不估算修正。</p>':''}
    <div class="fund-reference-volume-legend" aria-label="成交量柱颜色说明"><span><i class="volume-up"></i>红：价格上涨</span><span><i class="volume-down"></i>蓝：价格下跌</span><span><i class="volume-flat"></i>灰：持平或缺比较价</span></div>
    <p class="fund-reference-chart-note">${mode==='intraday'?'分时日期 '+esc(series.date)+'；柱形显示相邻已返回时点间的成交量，颜色比较相邻价格；首柱有同日昨收时与昨收比较。缺时点不补零。':'最近 '+points.length+' 条不复权日线；量柱颜色与上一条日线收盘比较，首柱缺少比较价时为灰色。当日未收盘记录单独标为暂计。'}颜色不代表主动买入或卖出，当前来源未提供买卖方向。</p>`;
}

export function fundReferenceHTML(view,{mode='intraday',selectedIndex=null,volumeSelectedIndex=null,loading=false,error=''}={}) {
  const header='<div class="fund-reference-heading"><div><span class="fund-reference-eyebrow">市场观察</span><h3>盘中参考</h3></div>';
  if(!view)return header+(error?'<button type="button" class="text-btn" data-action="fund-reference-refresh">重新读取</button>':'')+'</div>'+(error?'<p class="fund-reference-status" role="alert">'+esc(error)+'</p>':'<p class="fund-reference-empty">正在读取参考行情…</p>');
  if(!view.reference)return header+'</div><p class="fund-reference-empty">'+esc(view.message||'该基金尚无已核验的参考标的。')+'</p>';
  const reference=view.reference,q=view.quote,relation=reference.relation==='target_etf'?'目标 ETF':'同指数参考 ETF';
  const cell=(title,value)=>`<div><span>${title}</span><strong>${value}</strong></div>`;
  const hasMinutes=Boolean(view.intraday?.points?.length),hasHistory=Boolean(view.history?.points?.length);
  if(mode==='intraday'&&!hasMinutes&&hasHistory)mode='daily';
  return header+`<button type="button" class="text-btn" data-action="fund-reference-refresh"${loading?' disabled':''}>${loading?'更新中…':'更新参考行情'}</button></div>
    <div class="fund-reference-identity"><span class="fund-reference-badge">${relation}</span><strong>${esc(reference.name)}</strong><span>${esc(reference.key)}</span></div>
    <p class="fund-reference-purpose">${esc(reference.index)} · ETF 市场价格供盘中观察，基金估值仍按正式披露净值计算。</p>
    ${q?`<div class="fund-reference-quote"><strong>${decimal(q.price)} <small>CNY</small></strong><b class="${tone(q.percent)}">${percent(q.percent)}</b><span>报价 ${esc(q.time)} · 上海时间</span></div>`:'<p class="fund-reference-empty">参考报价暂不可用。</p>'}
    <div class="fund-reference-stats">${cell('今开',decimal(q?.open))}${cell('最高',decimal(q?.high))}${cell('最低',decimal(q?.low))}${cell('成交量',units(q?.volume,'份'))}${cell('成交额',units(q?.amount,'元'))}${cell('换手率',known(q?.turnover)?decimal(q.turnover,2)+'%':'—')}</div>
    ${error?`<p class="fund-reference-status" role="status">${esc(error)}</p>`:''}${Object.values(view.errors||{}).map(message=>`<p class="fund-reference-status" role="status">${esc(message)}</p>`).join('')}
    <div class="fund-reference-modes" role="group" aria-label="参考走势周期"><button type="button" class="filter ${mode==='intraday'?'active':''}" data-action="fund-reference-mode" data-mode="intraday" aria-pressed="${mode==='intraday'}"${!hasMinutes?' disabled':''}>分时</button><button type="button" class="filter ${mode==='daily'?'active':''}" data-action="fund-reference-mode" data-mode="daily" aria-pressed="${mode==='daily'}"${!hasHistory?' disabled':''}>日线 · 近60条</button></div>
    ${fundReferenceChartHTML(view,mode,selectedIndex,{volumeSelectedIndex})}
    <details class="fund-reference-sources"><summary>参考关系与数据来源</summary><p>${relation}：${esc(reference.name)}（${esc(reference.key)}），对应${esc(reference.index)}。${reference.relation==='same_index_etf'?'这只基金不是该 ETF 的联接基金，二者仅跟踪同一指数。':'联接关系依据基金管理人披露资料核验。'}</p><p>报价及走势图：腾讯证券公开行情；以各自显示的日期和时点为准，休市时保留最近记录。成交量统一为份，成交额统一为人民币元。</p>${q?.sourceUrl&&href(q.sourceUrl)?`<p><a href="${href(q.sourceUrl)}" target="_blank" rel="noreferrer">腾讯参考标的行情 ↗</a></p>`:''}${(reference.sources||[]).filter(source=>href(source.url)).map(source=>`<p><a href="${href(source.url)}" target="_blank" rel="noreferrer">${esc(source.title)} ↗</a></p>`).join('')}<p>参考关系核验日期：${esc(reference.verifiedAt||'—')}。参考 ETF 市价及涨跌不作为本基金的成交净值、当前持仓市值或实际收益。</p></details>`;
}
