const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=value=>typeof value==='number'&&Number.isFinite(value);
const tone=value=>!known(value)||value===0?'price-flat':value>0?'price-up':'price-down';
const decimal=(value,digits=3)=>known(value)?value.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
const percent=value=>known(value)?(value>0?'+':value<0?'−':'')+Math.abs(value).toFixed(2)+'%':'—';
const units=(value,unit)=>!known(value)?'—':value>=1e8?decimal(value/1e8,2)+' 亿'+unit:value>=1e4?decimal(value/1e4,2)+' 万'+unit:decimal(value,0)+' '+unit;
const href=url=>/^https:\/\//.test(url||'')?esc(url):'';

export function fundReferenceChartHTML(view,mode='intraday',selectedIndex=null) {
  const series=mode==='intraday'?view?.intraday:view?.history,points=series?.points||[];
  if(!points.length)return '<p class="fund-reference-empty">暂无可绘制的'+(mode==='intraday'?'分时':'日线')+'数据，更新后再查看。</p>';
  const index=Number.isInteger(selectedIndex)?Math.max(0,Math.min(points.length-1,selectedIndex)):points.length-1,selected=points[index];
  const prices=points.map(p=>p.price),min=Math.min(...prices),max=Math.max(...prices),range=Math.max(max-min,max*.004),low=Math.max(0,min-range*.15),high=max+range*.15;
  const minute=time=>Number(time.slice(0,2))*60+Number(time.slice(3)),start=mode==='intraday'?minute(points[0].time):0,end=mode==='intraday'?minute(points.at(-1).time):points.length-1;
  const x=(point,i)=>start===end?500:4+((mode==='intraday'?minute(point.time):i)-start)/(end-start)*992,y=price=>12+(high-price)/(high-low)*138;
  let path='';
  points.forEach((point,i)=>{const gap=mode==='intraday'&&i>0&&minute(point.time)-minute(points[i-1].time)>5;path+=(i===0||gap?'M':'L')+x(point,i).toFixed(2)+' '+y(point.price).toFixed(2);});
  const maxVolume=Math.max(1,...points.map(p=>known(p.volume)?p.volume:0)),width=Math.max(1,Math.min(10,760/points.length));
  const label=point=>mode==='intraday'?point.time:point.date;
  const previous=mode==='intraday'&&view.quote?.date===series.date?view.quote?.previous?.price:mode==='daily'&&index>0?points[index-1].price:null;
  const change=known(previous)&&previous>0?(selected.price/previous-1)*100:null;
  const readingTime=mode==='intraday'?series.date+' '+selected.time:selected.date;
  return `<div class="fund-reference-reading" aria-live="polite"><div><strong>${decimal(selected.price)} <small>CNY</small></strong><span>${esc(readingTime)}${selected.status==='partial'?' · 当日暂计':''}</span></div><div><b class="${tone(change)}">${percent(change)}</b><span>${mode==='intraday'?'较该日昨收':'较上一条日线收盘'}</span></div><div><b>${units(selected.volume,'份')}</b><span>${mode==='intraday'?'相邻时点成交量':'当日成交量'}</span></div></div>
    <div class="fund-reference-plot"><div class="fund-reference-axis"><span>${decimal(high)}</span><span>${decimal((high+low)/2)}</span><span>${decimal(low)}</span></div><div class="fund-reference-graph"><svg class="fund-reference-chart" viewBox="0 0 1000 210" preserveAspectRatio="none" role="img" aria-label="${mode==='intraday'?'分时':'日线'}价格走势与成交量"><title>参考ETF${mode==='intraday'?'分时':'日线'}走势，成交量单位为份</title><path class="fund-reference-grid" d="M0 12H1000M0 81H1000M0 150H1000M0 170H1000"/><path class="fund-reference-price" d="${path}"/><line class="fund-reference-guide" x1="${x(selected,index)}" x2="${x(selected,index)}" y1="12" y2="207"/><circle class="fund-reference-selected" cx="${x(selected,index)}" cy="${y(selected.price)}" r="4"/>${points.map((point,i)=>!known(point.volume)?'':`<rect class="fund-reference-volume" x="${x(point,i)-width/2}" y="${207-point.volume/maxVolume*32}" width="${width}" height="${point.volume/maxVolume*32}"><title>${esc(label(point))} · ${units(point.volume,'份')}</title></rect>`).join('')}</svg><div class="fund-reference-x-labels"><span>${esc(label(points[0]))}</span><span>${esc(label(points.at(-1)))}</span></div></div></div>
    <label class="fund-reference-selector"><span>查看时点</span><input type="range" data-fund-reference-range aria-label="选择盘中参考时点" min="0" max="${points.length-1}" step="1" value="${index}"${points.length===1?' disabled':''}><span>${esc(label(selected))}</span></label>
    <p class="fund-reference-chart-note">${mode==='intraday'?'分时日期 '+esc(series.date)+'；柱形显示相邻已返回时点间的成交量，缺时点不补零。':'最近 '+points.length+' 条不复权日线；当日未收盘记录单独标为暂计。'}</p>`;
}

export function fundReferenceHTML(view,{mode='intraday',selectedIndex=null,loading=false,error=''}={}) {
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
    ${fundReferenceChartHTML(view,mode,selectedIndex)}
    <details class="fund-reference-sources"><summary>参考关系与数据来源</summary><p>${relation}：${esc(reference.name)}（${esc(reference.key)}），对应${esc(reference.index)}。${reference.relation==='same_index_etf'?'这只基金不是该 ETF 的联接基金，二者仅跟踪同一指数。':'联接关系依据基金管理人披露资料核验。'}</p><p>报价及走势图：腾讯证券公开行情；以各自显示的日期和时点为准，休市时保留最近记录。成交量统一为份，成交额统一为人民币元。</p>${q?.sourceUrl&&href(q.sourceUrl)?`<p><a href="${href(q.sourceUrl)}" target="_blank" rel="noreferrer">腾讯参考标的行情 ↗</a></p>`:''}${(reference.sources||[]).filter(source=>href(source.url)).map(source=>`<p><a href="${href(source.url)}" target="_blank" rel="noreferrer">${esc(source.title)} ↗</a></p>`).join('')}<p>参考关系核验日期：${esc(reference.verifiedAt||'—')}。参考 ETF 市价及涨跌不作为本基金的成交净值、当前持仓市值或实际收益。</p></details>`;
}
