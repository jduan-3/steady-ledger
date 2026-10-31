import {fundReferenceChartHTML} from './fund-reference.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=value=>typeof value==='number'&&Number.isFinite(value);
const decimal=(value,digits=3)=>known(value)?value.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
const percent=value=>known(value)?(value>0?'+':value<0?'−':'')+Math.abs(value).toFixed(2)+'%':'—';
const tone=value=>!known(value)||value===0?'price-flat':value>0?'price-up':'price-down';
const units=(value,unit)=>!known(value)?'—':value>=1e8?decimal(value/1e8,2)+' 亿'+unit:value>=1e4?decimal(value/1e4,2)+' 万'+unit:decimal(value,0)+' '+unit;
const zones={SH:'上海时间',SZ:'上海时间',HK:'香港时间',US:'纽约时间'};

export function stockMarketHTML(view,{mode='intraday',selectedIndex=null,loading=false,error=''}={}){
  const header='<div class="fund-reference-heading"><div><span class="fund-reference-eyebrow">市场观察</span><h3>股票行情</h3></div>';
  if(!view)return header+(error?'<button type="button" class="text-btn" data-action="fund-reference-refresh">重新读取</button>':'')+'</div><p class="fund-reference-empty">'+esc(error||'正在读取股票行情…')+'</p>';
  if(!view.instrument)return header+'</div><p class="fund-reference-empty">'+esc(view.message||'补充证券代码后可查看行情。')+'</p>';
  const s=view.instrument,q=view.quote,cell=(title,value)=>`<div><span>${title}</span><strong>${value}</strong></div>`,currency=esc(s.currency);
  const hasMinutes=Boolean(view.intraday?.points?.length),hasHistory=Boolean(view.history?.points?.length);
  if(mode==='intraday'&&!hasMinutes&&hasHistory)mode='daily';
  return header+`<button type="button" class="text-btn" data-action="fund-reference-refresh"${loading?' disabled':''}>${loading?'更新中…':'更新股票行情'}</button></div>
    <div class="fund-reference-identity"><span class="fund-reference-badge">${esc(s.marketLabel)}</span><strong>${esc(s.name)}</strong><span>${esc(s.key)}</span></div>
    <p class="fund-reference-purpose">${s.market==='US'?'美股常规交易时段行情，盘前盘后单独报价不混入图表。':'价格与量能按来源的实际时点展示。'}市场涨跌不等于你的实际持仓收益。</p>
    ${q?`<div class="fund-reference-quote"><strong>${decimal(q.price)} <small>${currency}</small></strong><b class="${tone(q.percent)}">${percent(q.percent)}</b><span>报价 ${esc(q.time)} · ${zones[s.market]||esc(s.timeZone)}${q.delayed?' · 来源标记为延迟行情':''}</span></div>`:'<p class="fund-reference-empty">股票报价暂不可用。</p>'}
    <div class="fund-reference-stats">${cell('今开',decimal(q?.open))}${cell('最高',decimal(q?.high))}${cell('最低',decimal(q?.low))}${cell('成交量',units(q?.volume,'股'))}${cell('成交额',units(q?.amount,' '+currency))}${cell('换手率',known(q?.turnover)?decimal(q.turnover,2)+'%':'—')}</div>
    ${error?`<p class="fund-reference-status" role="status">${esc(error)}</p>`:''}${Object.values(view.errors||{}).map(message=>`<p class="fund-reference-status" role="status">${esc(message)}</p>`).join('')}
    <div class="fund-reference-modes" role="group" aria-label="股票行情周期"><button type="button" class="filter ${mode==='intraday'?'active':''}" data-action="fund-reference-mode" data-mode="intraday" aria-pressed="${mode==='intraday'}"${!hasMinutes?' disabled':''}>分时</button><button type="button" class="filter ${mode==='daily'?'active':''}" data-action="fund-reference-mode" data-mode="daily" aria-pressed="${mode==='daily'}"${!hasHistory?' disabled':''}>日线 · 近60条</button></div>
    ${fundReferenceChartHTML(view,mode,selectedIndex,{currency:s.currency,volumeUnit:'股',instrumentLabel:'股票',selectorLabel:'选择股票行情时点'})}
    <details class="fund-reference-sources"><summary>行情口径与来源</summary><p>${esc(s.marketLabel)} · ${currency} · ${esc(s.timeZone)}。成交量以股计，成交额以来源原币计，不自动换汇。港股未核验的换手率显示“—”。</p><p>报价、分时和日线分别保留各自时间；公开行情可能延迟，休市时保留最近记录。日线采用不复权价格，除权或拆并股可能形成价格跳变。</p>${q?.sourceUrl&&/^https:\/\//.test(q.sourceUrl)?`<p><a href="${esc(q.sourceUrl)}" target="_blank" rel="noreferrer">腾讯证券行情来源 ↗</a></p>`:''}</details>`;
}
