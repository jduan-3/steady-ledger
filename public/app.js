import { readEventStream } from './sse.js';
import { marketPageHTML, marketBriefsHTML } from './markets.js';

function adviceText(value) {
  return String(value??'').replace(/\r\n?/g,'\n')
    .replace(/&#0*42;|&#x0*2a;|&ast;/gi,'*').replace(/\uff0a/g,'*')
    .replace(/\\+([*`_~])/g,'$1').replace(/\*[\u200b-\u200d\ufeff]+(?=\*)/g,'*')
    .replace(/^\s*(?:```|~~~).*$/gm,'')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'$1（$2）')
    .replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/^\s*>\s?/gm,'')
    .replace(/^\s*[-+*]\s+/gm,'').replace(/^\s*\d+[.)]\s+/gm,'')
    .replace(/^\s*[-*_]{3,}\s*$/gm,'')
    .replace(/\*{2,}|__|~~|`/g,'')
    .replace(/(\d)\s*\*\s*(?=\d)/g,'$1 × ')
    .replace(/(?<![\p{L}\p{N}])\*([^*\n]+)\*(?![\p{L}\p{N}])/gu,'$1')
    .replace(/\*/g,'')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g,'$1')
    .split('\n').map(line=>{
      if(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))return '';
      return /^\s*\|.*\|\s*$/.test(line)?line.trim().slice(1,-1).split('|').map(x=>x.trim()).join(' · '):line;
    }).join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

const paths = {
  overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wallet:'<path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6"/><path d="M20 12h-5v4h5M17 14h.01"/>',
  flow:'<path d="M7 3v17m-4-4 4 4 4-4M17 21V4m-4 4 4-4 4 4"/>',
  spark:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3ZM20 3v4m-2-2h4"/>',
  report:'<path d="M14 3H5v18h14V8l-5-5ZM14 3v6h5M8 13h8m-8 4h5"/>',
  settings:'<path d="M4 7h16M4 17h16M8 4v6m8 4v6"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>', plus:'<path d="M12 5v14M5 12h14"/>', arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>', chevron:'<path d="m9 5 7 7-7 7"/>',
  shield:'<path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  chart:'<path d="M3 3v18h18M7 14l4-5 4 3 6-8"/>', gold:'<path d="m7 6-4 13h18L17 6H7Zm-2 8h14M9 6l-2 13m8-13 2 13"/>',
  bank:'<path d="m3 8 9-5 9 5M3 21h18M5 10v8m5-8v8m4-8v8m5-8v8"/>',
  car:'<path d="m5 8 2-5h10l2 5M3 8h18v10H3V8Zm2 10v3m14-3v3M6 12h3m6 0h3"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  upload:'<path d="M12 16V4m-4 4 4-4 4 4M4 16v5h16v-5"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>', edit:'<path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>', user:'<circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
  send:'<path d="M12 19V5m-6 6 6-6 6 6"/>', check:'<path d="m5 12 4 4L19 6"/>', info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>', logout:'<path d="M9 4H4v16h5m0-8h12m-5-5 5 5-5 5"/>', refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>', link:'<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>'
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.wallet}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const money = value => value === null || value === undefined ? '待补充' : '¥ ' + new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const percent = value => value === null || value === undefined ? '—' : value.toFixed(1) + '%';
const stockPercent = m => m.stockRatioMax!=null && Math.abs(m.stockRatioMax-m.stockRatio)>.01 ? percent(m.stockRatio)+'–'+percent(m.stockRatioMax) : percent(m.stockRatio);
const today = (timeZone='Asia/Shanghai') => new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const typeNames = {cash:'现金与存款',stock:'股票',fund:'基金与 ETF',bond:'债券',gold_accum:'积存金',gold_physical:'实物黄金',gold_margin:'保证金黄金',insurance:'保险',other:'其他资产'};
const routes = [['dashboard','overview','财务总览'],['assets','wallet','资产与负债'],['cashflow','flow','收入与计划'],['us-market','chart','美国市场'],['hk-market','chart','港股市场'],['assistant','spark','个人助手'],['reports','report','每日总结'],['settings','settings','设置']];
let data, auth, route = 'dashboard', assetFilter = 'all', settingsTab = 'ai', selectedReport = '', pending = null, chatBusy = false, chatDraft = '', chatError = '', chatPendingMessage = '';
let chatStreamText='',chatStage='thinking',chatAbort=null;
let chatToolCalls=[];
const expandedToolCalls=new Set();
let chatRunId='',chatRequestId='',chatReconnectTimer,chatStopping=false,chatResuming=false;
let chatEpoch=0;
let chatActiveConversationId='',chatViewEpoch=0,chatOriginViewEpoch=0,chatSelecting=0;
const chatDrafts=new Map();
const currentChatRun=()=>chatActiveConversationId?data.conversation?.id===chatActiveConversationId:chatOriginViewEpoch===chatViewEpoch;
function applyChatData(value,select=false) {
  if(value.config)data.config=value.config;
  for(const key of ['state','metrics','rules','history','valuation','incomeSchedule','ledgerEntries','reports','audit'])if(key in value)data[key]=value[key];
  if(value.conversations)data.conversations=value.conversations;
  if('run' in value)data.chatRun=value.run;
  if(select||!('conversation' in value)||value.conversation?.id===data.conversation?.id||(currentChatRun()&&!data.conversation)) {
    if('conversation' in value)data.conversation=value.conversation;
    if(value.messages)data.messages=value.messages;
  }
}
async function selectChat(id) {
  const selection=++chatSelecting;
  chatDrafts.set(data.conversation?.id||'',chatDraft);
  const value=await api('/conversations?id='+encodeURIComponent(id));
  if(selection!==chatSelecting)return;
  chatViewEpoch++;applyChatData(value,true);chatDraft=chatDrafts.get(id)||'';render();
}
function newChat() {
  chatSelecting++;chatDrafts.set(data.conversation?.id||'',chatDraft);chatViewEpoch++;
  data.conversation=null;data.messages=[];chatDraft=chatDrafts.get('')||'';render();$('#chat-form textarea')?.focus();
}
async function preserveChatView(value) {
  const previous=data;
  if(previous?.conversation&&previous.conversation.id!==value.conversation?.id) {
    try {Object.assign(value,await api('/conversations?id='+encodeURIComponent(previous.conversation.id)));}catch{}
  } else if(previous&&previous.conversation===null){value.conversation=null;value.messages=[];}
  return value;
}
let selectedTrendDay='',trendRange='recent',assetQuery='',stockMarketFilter='all',reportBusy=false,navCollapsed=false;
const revealedAmounts=new Set();
function privateAmount(key,value,label,{hero=false,format=money}={}) {
  if(value==null)return money(value);
  const visible=revealedAmounts.has(key),formatted=format(value);
  const display=visible?(hero?`<span class="currency">¥</span>${esc(formatted.replace(/^¥\s*/,''))}`:esc(formatted)):'***';
  return `<button type="button" class="private-amount${visible?'':' is-masked'}" data-action="toggle-private-amount" data-amount-key="${esc(key)}" aria-pressed="${visible}" aria-label="${esc(label)}${visible?' '+formatted+'，点击隐藏':'已隐藏，点击显示'}" title="点击${visible?'隐藏':'显示'}金额"><span class="private-amount-value">${display}</span><small class="amount-toggle-hint">${visible?'隐藏':'显示'}</small></button>`;
}
const formDrafts=new Map();
const draftFormIds=new Set(['profile-form','background-form','ai-form','rules-form']);
function draftNotice(id) {
  return `<span class="draft-status" data-draft-status="${id}" title="仅在本次页面打开期间保留；刷新或关闭页面后清除" ${formDrafts.has(id)?'':'hidden'}>有未保存的更改 <button type="button" class="text-btn" data-action="discard-draft" data-form="${id}">放弃更改</button></span>`;
}
function rememberFormDraft(event) {
  const input=event.target,form=input.form,id=form?.getAttribute('id');
  if(!draftFormIds.has(id)||!input.name)return;
  if(!formDrafts.has(id))formDrafts.set(id,new Map());
  formDrafts.get(id).set(input.name,{value:input.value,checked:input.checked});
  const notice=form.querySelector('[data-draft-status]');if(notice)notice.hidden=false;
}
function restoreFormDrafts() {
  for(const [id,draft] of formDrafts) {
    const form=$('#'+id);if(!form)continue;
    for(const input of form.querySelectorAll('[name]')) {
      const value=draft.get(input.name);if(!value)continue;
      input.value=value.value;if(input.type==='checkbox')input.checked=value.checked;
    }
  }
}
function assetStockMarket(asset) {
  const known=['SH','SZ','HK','US','BJ'];
  return [asset.security?.market,String(asset.security?.key||'').split('.')[0],asset.stockMarket].find(m=>known.includes(m))||'unknown';
}
const stockMarketGroup=asset=>['SH','SZ'].includes(assetStockMarket(asset))?'CN':assetStockMarket(asset);
const stockMarketLabel=asset=>({SH:'沪市',SZ:'深市',HK:'港股',US:'美股',BJ:'北交所'}[assetStockMarket(asset)]||'市场待补充');
function stockMarketFiltersHTML() {
  if(assetFilter!=='stock')return '';
  const stocks=data.state.assets.filter(a=>a.type==='stock'),count=market=>market==='all'?stocks.length:stocks.filter(a=>stockMarketGroup(a)===market).length;
  const groups=[['all','全部股票'],['CN','沪深'],['HK','港股'],['US','美股'],...(['BJ','unknown'].filter(m=>count(m)||stockMarketFilter===m).map(m=>[m,m==='BJ'?'北交所':'市场待补充']))];
  return `<div class="stock-market-filters"><div class="stock-market-tabs" role="group" aria-label="股票市场"><span class="stock-market-caption">交易市场</span>${groups.map(([market,label])=>`<button type="button" class="stock-market-filter${stockMarketFilter===market?' active':''}" data-action="stock-market-filter" data-market="${market}" aria-pressed="${stockMarketFilter===market}">${label}<span>${count(market)}</span></button>`).join('')}</div><span class="stock-market-note">占比按全部股票组合计算</span></div>`;
}
function assetResultCount(assets) {
  const stock=assetFilter==='stock',total=stock?data.state.assets.filter(a=>a.type==='stock').length:data.state.assets.length;
  return `${assets.length} / ${total} 项${stock?'股票':'资产'}`;
}
function sortPortfolioAssets(assets) {
  const rates=data.state.preferences.rates;
  const value=a=>Number.isFinite(a.value)&&a.value>=0&&Number.isFinite(rates[a.currency])&&rates[a.currency]>0?a.value*rates[a.currency]:-1;
  return assets.sort((a,b)=>value(b)-value(a));
}
function filteredAssets() {
  const query=assetQuery.trim().toLocaleLowerCase();
  const assets=data.state.assets.filter(a=>(assetFilter==='all'||(assetFilter==='gold'?a.type.startsWith('gold'):a.type===assetFilter))&&(assetFilter!=='stock'||stockMarketFilter==='all'||stockMarketGroup(a)===stockMarketFilter)&&(!query||[a.name,a.account,a.currency,a.security?.key,a.security?.symbol,a.fund?.code,a.type==='stock'?stockMarketLabel(a):''].some(v=>String(v??'').toLocaleLowerCase().includes(query))));
  if(['stock','fund'].includes(assetFilter))sortPortfolioAssets(assets);
  return assets;
}
function paintAssetResults() {
  const assets=filteredAssets();
  $('#asset-results').innerHTML=assetTable(assets,false,assetFilter!=='all'||Boolean(assetQuery.trim()));
  $('#asset-result-count').textContent=assetResultCount(assets);
  $('#clear-asset-search').hidden=!assetQuery;
}
const marketViews={US:null,HK:null},marketBusy={US:false,HK:false},marketAttempted={US:false,HK:false},marketSelections={US:{},HK:{}},marketErrors={US:'',HK:''};
const currentMarket=()=>route==='us-market'?'US':route==='hk-market'?'HK':null;
async function loadMarket(market,force=false,poll=false) {
  if(marketBusy[market])return;
  marketBusy[market]=true;marketAttempted[market]=true;if(!poll)marketErrors[market]='';if(currentMarket()===market)render();
  if(!marketViews[market]&&!poll) {
    try{marketViews[market]=await api('/markets?market='+market);if(currentMarket()===market)render();}catch{}
  }
  try { marketViews[market]=await api('/markets/refresh',{method:'POST',body:{market,force,poll}});if(!marketViews[market].latestError)marketErrors[market]='';try{data=await preserveChatView(await api('/bootstrap'));}catch{}if(marketViews[market].brief?.ai?.status==='generating')pollMarketBriefs(); }
  catch(error){marketErrors[market]=error.message;}
  finally{marketBusy[market]=false;if(currentMarket()===market)render();}
}
function marketPage(market){
  const assets=sortPortfolioAssets(data.state.assets.filter(a=>a.type==='stock'&&stockMarketGroup(a)===market));
  const holdings=`<section class="card market-assets"><div class="card-header"><h2>我的${market==='US'?'美股':'港股'}持仓</h2><p>${assets.length} 项股票</p></div>${assetTable(assets)}</section>`;
  return marketPageHTML(market,marketViews[market],{loading:marketBusy[market],error:marketErrors[market],...marketSelections[market]})+holdings;
}
let briefPollTimer;
function applyMarketBriefs(value){data.marketBriefs=value;for(const market of ['US','HK'])if(marketViews[market])marketViews[market].brief=value.latest.find(b=>b.market===market)||null;if(currentMarket()||route==='reports')render();}
function pollMarketBriefs(){clearTimeout(briefPollTimer);briefPollTimer=setTimeout(async()=>{try{const value=await api('/market-briefs');applyMarketBriefs(value);if(value.latest.some(b=>b.ai?.status==='generating'))pollMarketBriefs();}catch{}},3000);}

const $ = s => document.querySelector(s);
async function api(path, options = {}) {
  const res = await fetch('/api' + path, { ...options, headers: { 'Content-Type':'application/json', ...options.headers }, ...(options.body !== undefined ? {body:JSON.stringify(options.body)} : {}) });
  const value = await res.json();
  if (!res.ok) { if (res.status === 401 && !path.startsWith('/auth/')) { auth.authenticated = false; formDrafts.clear(); renderAuth(); } if(value.config&&data)data.config=value.config; throw new Error(value.error || '请求失败'); }
  return value;
}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
function showDialog(title, subtitle, html) { const d = $('#dialog'); d.innerHTML = `<div class="dialog-header"><div><h2 id="dialog-title">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button class="icon-btn" data-action="close-dialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body">${html}</div>`; if (!d.open) d.showModal(); }
const closeDialog = () => { clearTimeout(stockLookupTimer); stockSearchEpoch++; $('#dialog').close(); };
function field(label, name, value = '', options = {}) {
  const {type='number',help='',full=false,required=false,placeholder='',step='any',min='0',max,maxlength} = options;
  return `<label class="form-field${full ? ' full' : ''}"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value ?? '')}" ${type==='number' ? `min="${min}" step="${step}" ${max !== undefined ? `max="${max}"` : ''}` : ''} ${required?'required':''} ${maxlength!==undefined?`maxlength="${maxlength}"`:''} placeholder="${esc(placeholder)}" autocomplete="${type==='password'?'new-password':'off'}" />${help ? `<small>${help}</small>` : ''}</label>`;
}
function select(label, name, value, choices, full = false) { return `<label class="form-field${full?' full':''}"><span>${label}</span><select name="${name}">${choices.map(([v,l]) => `<option value="${v}"${v===value?' selected':''}>${l}</option>`).join('')}</select></label>`; }
const checkbox = (name,label,checked = false) => `<label class="check"><input type="checkbox" name="${name}" ${checked?'checked':''}/><span>${label}</span></label>`;
const numberValue = (form, name) => {const value=form.get(name);return value==null||value===''?null:Number(value);};
function heading(title, subtitle, actions = '') { return `<div class="page-heading mobile-wrap"><div><h1>${title}</h1>${subtitle?`<p>${subtitle}</p>`:''}</div><div class="heading-actions">${actions}</div></div>`; }
const button = (action, label, _symbol, style='secondary', attrs='') => `<button class="btn btn-${style}" data-action="${action}" ${attrs}>${label}</button>`;
const empty = (title, description, action='') => `<div class="empty"><h3>${title}</h3><p>${description}</p>${action}</div>`;
const rulesHTML = (rules, limit=20, foldDetails=false) => rules.length ? rules.slice(0,limit).map(r => `<div class="rule-item"><span class="rule-dot ${r.level}"></span><div><strong>${esc(r.title)}</strong>${foldDetails&&r.detail.length>160?`<p>${esc(r.detail.slice(0,110))}…</p><details class="rule-details"><summary>查看完整说明</summary><p>${esc(r.detail)}</p></details>`:`<p>${esc(r.detail)}</p>`}</div></div>`).join('') : `<div class="rule-item"><span class="rule-dot"></span><div><strong>未触发已配置的规则</strong><p>请继续关注资金用途和数据完整性，这不代表没有风险。</p></div></div>`;
function routeTo(next) { if (location.hash === '#' + next) render(); else location.hash = next; }
async function saveState(next, label, formId) { data = await preserveChatView(await api('/state', {method:'PUT',body:{state:next,revision:data.state.revision,label}})); if(formId)formDrafts.delete(formId); render(); }
async function refresh() { data = await preserveChatView(await api('/bootstrap')); render(); }

function renderAuth() {
  revealedAmounts.clear();
  $('#app').innerHTML = `<main class="auth-screen"><form class="card auth-card" id="auth-form"><h1>${auth.initialized?'账本登录':'设置访问密码'}</h1><p>${auth.initialized?'输入密码访问账本。':'设置至少 8 个字符的密码。'}</p>${field('访问密码','password','',{type:'password',required:true,placeholder:'至少 8 个字符'})}<div id="auth-error" class="error-text" role="alert"></div><button class="btn btn-primary" type="submit">${auth.initialized?'登录':'保存并进入'}</button></form></main>`;
  $('#auth-form input').minLength = 8;
}
function render() {
  const briefPanel=$('.market-archive[data-market]'),briefMarket=briefPanel?.dataset?.market;
  if(marketSelections[briefMarket])marketSelections[briefMarket].briefOpen=briefPanel.open;
  route = location.hash.slice(1).split('?')[0] || 'dashboard'; if (!routes.some(r=>r[0]===route)) route='dashboard';
  if (!auth?.authenticated || !data) return;
  $('#app').innerHTML = `<div class="workspace${navCollapsed?' nav-collapsed':''}"><aside id="main-sidebar" class="sidebar"><nav class="nav" aria-label="主导航">${routes.map(([r,,label])=>`${r==='settings'?'<span class="nav-spacer"></span>':''}<a href="#${r}" data-route="${r}" class="${r===route?'active':''}" ${r===route?'aria-current="page"':''}>${label}</a>`).join('')}<button class="mobile-nav-more ${['us-market','hk-market','reports','settings'].includes(route)?'active':''}" data-action="more-pages" aria-haspopup="dialog" aria-label="更多页面">更多</button></nav><div class="sidebar-bottom workspace-status">${auth.preview?'本机访问':'已登录'}</div></aside><div class="app-main"><header class="topbar"><div class="workspace-breadcrumb"><button class="text-btn workspace-toggle" data-action="toggle-sidebar" aria-controls="main-sidebar" aria-expanded="${!navCollapsed}">${navCollapsed?'显示导航':'收起导航'}</button><span class="breadcrumb-divider">/</span><span>${routes.find(([r])=>r===route)?.[2]}</span></div><div class="workspace-toolbar"><span>${new Intl.DateTimeFormat('zh-CN',{timeZone:data.state.preferences.timeZone,year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(new Date())}</span><button class="text-btn" data-action="account">数据与备份</button></div></header><main class="content${route==='assistant'?' content-assistant':''}">${data.state.isDemo ? `<div class="demo-banner"><span>演示数据，均为虚构金额。</span><button data-action="reset">清空并开始记账</button></div>`:''}${({dashboard:dashboard,assets:assetsPage,cashflow:cashflowPage,assistant:assistantPage,reports:reportsPage,settings:settingsPage,'us-market':()=>marketPage('US'),'hk-market':()=>marketPage('HK')}[route])()}</main></div></div>`;
  restoreFormDrafts();
  if (route==='assistant') { const chat=$('#chat-messages'); chat.scrollTop=chat.scrollHeight; fitChatInput(); }
  const market=currentMarket();if(market&&!marketViews[market]&&!marketBusy[market]&&!marketAttempted[market])loadMarket(market);
}

function allocation() {
  const m=data.metrics, c=m.categories;
  const groups=[['股票',c.stock||0],['基金',c.fund||0],['现金与存款',c.cash||0],['黄金',(c.gold_accum||0)+(c.gold_physical||0)+(c.gold_margin||0)],['保险',c.insurance||0],['其他资产',(c.bond||0)+(c.other||0)]];
  return `<section class="card allocation-card"><div class="wealth-top"><h2>资产分类</h2><span class="muted">占总资产</span></div>${groups.length?`<dl class="allocation-list">${groups.map(([name,value])=>`<div><dt>${name}</dt><dd>${m.totalAssets?(value/m.totalAssets*100).toFixed(1)+'%':'—'}</dd></div>`).join('')}</dl>`:'<p class="inline-note">暂无资产记录。</p>'}</section>`;
}
function dashboard() {
  const m=data.metrics, s=data.state, risk=data.rules.filter(r=>r.level!=='info').length, hasData=s.assets.length||s.debts.length;
  return `${heading('财务总览','',button('market-refresh','更新行情','refresh')+button('open-ai','个人助手','spark')+button('add-asset','记录资产','plus','primary'))}
  ${!hasData?`<div class="card welcome"><div><h2>还没有资产记录</h2><p>添加资产、负债和收支后计算汇总。</p></div><div class="welcome-actions">${button('demo','载入演示数据','','secondary')}${button('add-asset','开始记录','arrow','primary')}</div></div>`:''}
  <div class="dashboard-hero"><div class="card wealth-card"><div><div class="wealth-top"><span class="label">已登记净资产${!m.complete?' · 部分估值待补充':''}</span></div><div class="net-worth">${privateAmount('dashboard-net-worth',m.netWorth,'已登记净资产',{hero:true})}</div>${dailyChangeHTML()}</div><div class="wealth-bottom"><div><span class="label">总资产</span><div class="money">${privateAmount('dashboard-total-assets',m.totalAssets,'总资产')}</div></div><div><span class="label">总负债</span><div class="money">${privateAmount('dashboard-total-debt',m.totalDebt,'总负债')}</div></div></div></div>${allocation()}</div>
  ${dailyHistoryHTML()}<div class="metrics-grid">${metric('可支配现金',privateAmount('dashboard-cash',m.availableCash,'可支配现金'),'不含受限、应急与专项预留','wallet')}${metric('股票配置比例',stockPercent(m),`谨慎线 ${s.policy.stockCaution}% · ${m.stockRatio!==null && m.stockRatio>s.policy.stockCaution?'当前超过':'基金配置 '+percent(m.fundRatio)+' · 分开统计'}`,'chart',m.stockRatio>s.policy.stockCaution)}${metric('每月经常性结余',privateAmount('dashboard-surplus',m.surplus,'每月经常性结余'),m.surplus===null?'补齐收入、生活支出和月供后计算':'税后收入 − 必要开支 − 月供','flow',m.surplus!==null&&m.surplus<0)}${metric('必要支出储备',m.reserveMonths===null?'—':m.reserveMonths.toFixed(1)+' 个月',`目标 ${s.profile.emergencyMonths} 个月 · 按流动现金储备`,'shield')}</div>
  ${netWorthTrendHTML()}
  <div class="dashboard-bottom"><div class="card"><div class="card-header"><div><h2>我的资产</h2><p>${s.assets.length} 项已登记资产</p></div><a class="text-btn" href="#assets">查看全部 ${icon('chevron',12)}</a></div>${assetTable(s.assets.slice(0,5),true)}</div><div class="card"><div class="card-header"><div><h2>待处理</h2></div><span class="pill ${risk?'caution':'info'}">${risk?risk+' 项提醒':'档案检查'}</span></div><div class="rule-list">${rulesHTML(data.rules,4,true)}</div></div></div>`;
}
function metric(label,value,sub,_symbol,caution=false) { return `<div class="card metric"><div class="metric-heading">${label}</div><div class="metric-value ${caution?'negative':''}">${value}</div><div class="metric-sub ${caution?'caution':''}">${sub}</div></div>`; }
const changeAmount=value=>(value>0?'+':value<0?'−':'')+'¥ '+Math.abs(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
function dailyChangeHTML(){
  const v=data.valuation;
  if(!v)return '<div class="wealth-note">按已登记估值计算</div>';
  return `<div class="wealth-note">较昨日净资产 ${v.delta==null?(v.baseline?'待补齐估值':'首日记录'):changeAmount(v.delta)} <span title="包含资金进出、负债变化和资料补录，不代表投资收益">${icon('info',12)}</span></div>`+
    (v.funds?`<div class="wealth-note" title="${esc(v.funds.scope)}">基金净值日变动 <span class="${v.funds.amount==null?'':movementClass(v.funds.amount)}">${v.funds.amount==null?'待更新':changeAmount(v.funds.amount)}</span>${v.funds.date?' · '+esc(v.funds.date.slice(5)):''}<small>按当前份额估算</small></div>`:'');
}
function dailyHistoryHTML(){
  if(!data.history?.length)return '';
  const history=[...data.history].sort((a,b)=>b.day.localeCompare(a.day));
  return `<details class="card daily-history"><summary>每日净变化</summary><div class="table-scroll"><table><thead><tr><th>日期</th><th>登记净资产</th><th>较前一日</th></tr></thead><tbody>${history.map(h=>{const previous=data.history.find(p=>Date.parse(p.day)===Date.parse(h.day)-86400000),change=previous&&h.complete!==false&&previous.complete!==false?h.netWorth-previous.netWorth:null;return `<tr><td>${esc(h.day)}</td><td>¥ ${h.netWorth.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${change==null?'—':changeAmount(change)}</td></tr>`;}).join('')}</tbody></table></div><p class="inline-note">包含资金进出与资料补录，不代表投资收益。</p></details>`;
}
function netWorthTrendHTML(){
  const day=data.valuation?.day||today(),end=Date.parse(day),allDays=(data.history||[]).filter(h=>Number.isFinite(h.netWorth)&&Date.parse(h.day)<=end&&Date.parse(h.day)>=end-29*86400000).sort((a,b)=>a.day.localeCompare(b.day));
  const adjustmentIndex=allDays.findLastIndex((h,i)=>i>0&&h.revision!=null&&allDays[i-1].revision!=null&&h.revision!==allDays[i-1].revision);
  const days=trendRange==='recent'&&adjustmentIndex>0?allDays.slice(adjustmentIndex):trendRange==='7'?allDays.filter(h=>Date.parse(h.day)>=end-6*86400000):allDays;
  const rangeLabel=trendRange==='recent'&&adjustmentIndex>0?'最近账本调整后 · '+days[0].day+' 起':trendRange==='7'?'近 7 天':'近 30 天';
  const controls=`<div class="trend-controls" role="group" aria-label="资产走势观察窗口">${[['recent','近期变化'],['7','近 7 天'],['30','30 天全貌']].map(([key,label])=>`<button class="filter ${trendRange===key?'active':''}" data-action="trend-range" data-range="${key}" aria-pressed="${trendRange===key}">${label}</button>`).join('')}</div>`;
  const selected=days.find(h=>h.day===selectedTrendDay)||days.at(-1);
  const head=`<div class="trend-heading"><div><h2>资产走势</h2><p>${esc(rangeLabel)} · 净资产 · 局部刻度</p></div>${selected?`<div class="trend-reading"><strong>${privateAmount('trend-net-worth',selected.netWorth,'所选日期净资产')}</strong><span>${esc(selected.day)}${selected.complete===false?' · 部分估值':''}</span></div>`:''}</div>${controls}`;
  if(!days.length)return `<section class="card net-worth-trend">${head}<div class="trend-empty">记录资产后，从第一天开始积累。</div></section>`;
  const values=days.map(h=>h.netWorth),min=Math.min(...values),max=Math.max(...values),padding=max>min?(max-min)*.12:Math.max(.01,Math.abs(max)*.000001),low=min-padding,high=max+padding;
  const first=Date.parse(days[0].day),last=Date.parse(days.at(-1).day),x=h=>last===first?50:(Date.parse(h.day)-first)/(last-first)*100,y=h=>(high-h.netWorth)/(high-low)*100;
  const segments=[];let adjustment=false;
  for(let i=1;i<days.length;i++){
    const a=days[i-1],b=days[i];if(a.complete===false||b.complete===false||Date.parse(b.day)-Date.parse(a.day)!==86400000)continue;
    if(a.revision!==b.revision)adjustment=true;
    segments.push(`<path d="M${x(a)*10} ${y(a)*1.8}L${x(b)*10} ${y(b)*1.8}" ${a.revision!==b.revision?'stroke-dasharray="5 5"':''}/>`);
  }
  const axis=value=>money(value);
  return `<section class="card net-worth-trend">${head}<div class="trend-chart"><div class="trend-y-axis"><span>${axis(high)}</span><span>${axis((high+low)/2)}</span><span>${axis(low)}</span></div><div class="trend-plot"><svg viewBox="0 0 1000 180" preserveAspectRatio="none" aria-hidden="true"><path class="trend-grid" d="M0 0H1000M0 90H1000M0 180H1000"/><g class="trend-line">${segments.join('')}</g></svg>${days.map(h=>`<button type="button" class="trend-dot ${h.day===selected.day?'selected':''} ${h.complete===false?'partial':''}" style="left:${x(h)}%;top:${y(h)}%" data-action="trend-point" data-day="${esc(h.day)}" aria-pressed="${h.day===selected.day}" aria-label="${esc(h.day)} ${money(h.netWorth)}${h.complete===false?'，估值不完整':''}" title="${esc(h.day)} · ${money(h.netWorth)}${h.complete===false?' · 部分估值':''}"></button>`).join('')}<div class="trend-x-axis"><span>${esc(days[0].day.slice(5))}</span>${days.length>1?`<span>${esc(days.at(-1).day.slice(5))}</span>`:''}</div></div></div><p class="trend-note">${days.length===1?'已记录 1 天，可切换窗口查看更早记录。':''}${trendRange==='recent'&&adjustmentIndex>0?'近期窗口从最近一次账本调整起算，完整记录见“30 天全貌”。':''}纵轴随当前窗口缩放。${adjustment?'虚线表示账本有调整。':''}按已登记估值，不代表投资收益。</p></section>`;
}
const signed=value=>(value>0?'+':value<0?'−':'')+Math.abs(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const movementClass=value=>value>0?'price-up':value<0?'price-down':'price-flat';
function movementHTML(a){
  if(!['stock','fund'].includes(a.type))return '<span class="muted">—</span>';
  const m=a.movement;
  if(!m)return `<span class="muted">${a.autoPrice||a.fund?.autoNav?'等待行情':'未连接行情'}</span>`;
  if(m.kind==='reported_daily')return `<button class="price-movement ${movementClass(m.amount)}" data-action="asset-price-history" data-id="${esc(a.id)}" title="${esc(m.source)} · ${esc(m.date)}"><strong>${signed(m.amount)} ${esc(m.currency)}</strong><small>${esc(m.date.slice(5))} · 已确认日收益</small></button>`;
  return `<button class="price-movement ${movementClass(m.change)}" data-action="asset-price-history" data-id="${esc(a.id)}" title="${esc(m.source||a.valuation?.source||'')} · ${esc(m.date)} · 金额按当前持有数量估算"><strong>${m.change>0?'↗':m.change<0?'↘':'→'} ${signed(m.percent)}%</strong><small>${m.amount==null?'':signed(m.amount)+' '+esc(m.currency)}</small>${a.valuation?.status==='pending'?'<small class="muted">待更新</small>':''}</button>`;
}
function portfolioAllocation(type) {
  const assets=data.state.assets.filter(a=>a.type===type),rates=data.state.preferences.rates,values=new Map();
  for(const asset of assets) {
    const rate=rates[asset.currency];
    values.set(asset.id,Number.isFinite(asset.value)&&asset.value>=0&&Number.isFinite(rate)&&rate>0?asset.value*rate:null);
  }
  const complete=[...values.values()].every(value=>value!==null),total=complete?[...values.values()].reduce((sum,value)=>sum+value,0):null;
  return {count:assets.length,total,complete,estimated:assets.some(a=>type==='fund'?a.fund?.autoNav&&!['nav','manual'].includes(a.valuation?.status):a.autoPrice&&a.valuation?.status!=='quote'),weights:new Map([...values].map(([id,value])=>[id,total>0?value/total*100:null]))};
}
const stockAllocation=()=>portfolioAllocation('stock');
const fundAllocation=()=>portfolioAllocation('fund');
function portfolioWeightHTML(asset,allocation,compact=false) {
  if(!['stock','fund'].includes(asset.type))return '<span class="muted">—</span>';
  const name=asset.type==='fund'?'基金':'股票';
  const weight=allocation.weights.get(asset.id),label=weight==null?(allocation.complete?'—':'待补齐'):weight.toFixed(2)+'%';
  const help=`本条${name}持仓的当前估值折人民币 ÷ 全部${name}持仓估值；${asset.type==='fund'?'不含股票和其他资产':'不含基金'}，筛选不改变分母。`+(allocation.estimated?'部分行情待更新，暂按已有估值计算。':'');
  if(compact)return `<small class="valuation-note" title="${help}">占${name}组合 ${label}</small>`;
  return `<div class="stock-weight" title="${help}"><strong>${label}</strong>${weight==null?'':`<span class="stock-weight-track" aria-hidden="true"><i style="width:${Math.min(100,Math.max(0,weight)).toFixed(6)}%"></i></span>`}</div>`;
}
const stockWeightHTML=(asset,allocation,compact=false)=>asset.type==='stock'?portfolioWeightHTML(asset,allocation,compact):'<span class="muted">—</span>';
function allocationSummaryHTML(type,allocation) {
  if(!allocation.count)return '';
  const name=type==='fund'?'基金':'股票';
  return `<div><span>${name}估值合计 · ${allocation.count} 项持仓</span><strong class="money">${privateAmount('assets-'+type+'-total',allocation.total,name+'估值合计')}</strong><small class="stock-allocation-note">${!allocation.complete?'缺少估值或汇率，暂不计算占比':allocation.estimated?'部分行情待更新，暂按已有估值':'已登记'+(type==='stock'?'直接股票':'基金')+'估值，统一折人民币'}</small></div>`;
}
function assetTable(assets,compact=false,filtered=false) {
  const allocations={stock:stockAllocation(),fund:fundAllocation()},types=['stock','fund'].filter(type=>assets.some(a=>a.type===type)),showWeights=!compact&&types.length;
  const weightTitle=types.length===1?'占'+(types[0]==='fund'?'基金':'股票')+'组合':'组合内占比';
  const weightHTML=(a,compact=false)=>types.includes(a.type)?portfolioWeightHTML(a,allocations[a.type],compact):'<span class="muted">—</span>';
  if(!assets.length&&filtered)return empty('没有匹配的资产','试试其他名称、代码或分类。',button('clear-asset-filters','清除筛选','close','soft'));
  if (!assets.length) return empty('还没有登记资产','从一笔存款或一项持仓开始。',button('add-asset','添加第一项资产','plus','soft'));
  return `<div class="table-scroll"><table><thead><tr><th>资产名称</th><th>当前估值</th>${showWeights?`<th class="stock-weight-cell" title="股票、基金分别按各自全部持仓当前估值计算，统一折人民币；筛选不改变分母。">${weightTitle}</th>`:''}<th title="市值减成本，不含现金分红">浮动盈亏</th><th>最新涨跌</th><th>数据日期</th>${compact?'':'<th><span class="sr-only">操作</span></th>'}</tr></thead><tbody>${assets.map(a=>`<tr><td><div class="asset-name"><span><strong><button type="button" class="asset-title" data-action="${['stock','fund'].includes(a.type)?'asset-price-history':'edit-asset'}" data-id="${esc(a.id)}" aria-label="${esc(a.name)}${['stock','fund'].includes(a.type)?'详情':'编辑'}">${esc(a.name)}</button></strong><small>${a.type==='stock'?esc(stockMarketLabel(a))+' · ':''}${a.security?esc(a.security.key)+' · '+esc(a.quantity)+' 股':a.fund?esc(a.fund.code)+' · '+esc(a.quantity)+' 份':typeNames[a.type]}</small></span></div></td><td class="asset-value money">${a.value==null?'待补充':a.currency==='CNY'?money(a.value):esc(a.currency)+' '+a.value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}${a.type==='insurance'?'<small class="valuation-note">'+({cash_value:'现金价值',account_value:'账户价值',surrender_value:'退保净值'}[a.insurance?.valuationBasis]||'保单价值')+'</small>':''}${types.includes(a.type)?(compact?weightHTML(a,true):`<span class="mobile-stock-weight">${weightHTML(a,true)}</span>`):''}</td>${showWeights?`<td class="stock-weight-cell">${weightHTML(a)}${types.length>1&&types.includes(a.type)?`<small class="valuation-note">${a.type==='fund'?'基金':'股票'}组合</small>`:''}</td>`:''}<td>${investmentHTML(a)}</td><td>${movementHTML(a)}</td><td class="asset-date" title="${esc(a.valuation?.message||a.valuation?.source||'')}">${esc(a.asOf)}${a.valuation?.status==='manual'?`<small class="valuation-note">已确认持仓金额${a.valuation.navValue!=null?' · 公开净值估值 '+money(a.valuation.navValue):''}</small>`:a.valuation?.price?`<small class="valuation-note">${a.fund?'净值':'股价'} ${esc(a.valuation.price)}${a.valuation.time?' · '+esc(a.valuation.time.slice(11,16)):''}</small>`:''}</td>${compact?'':`<td><div class="actions-cell">${['stock','fund'].includes(a.type)?`<button class="text-btn row-action" data-action="asset-price-history" data-id="${esc(a.id)}" aria-label="${esc(a.name)}涨跌记录">详情</button>`:''}<button class="text-btn row-action" data-action="edit-asset" data-id="${esc(a.id)}" aria-label="编辑${esc(a.name)}">编辑</button><button class="text-btn row-action" data-action="delete-asset" data-id="${esc(a.id)}" aria-label="删除${esc(a.name)}">删除</button></div></td>`}</tr>`).join('')}</tbody></table></div>`;
}
let activePriceHistory=null;
const quotePercent=q=>Number.isFinite(q.previous?.price)&&q.previous.price>0?(q.price-q.previous.price)/q.previous.price*100:null;
const quoteNumber=value=>value.toLocaleString('zh-CN',{maximumFractionDigits:4});
function priceHistoryChartHTML(asset,items,selectedDate='') {
  const rows=items.slice().reverse(),selected=rows.find(q=>q.date===selectedDate)||rows.at(-1),fund=asset.type==='fund';
  if(!selected)return '<div class="history-empty">暂无可绘制的历史数据，连接行情后开始记录。</div>';
  const values=rows.map(q=>q.price),min=Math.min(...values),max=Math.max(...values),range=Math.max(max-min,max*.01,.0001);
  const low=Math.max(0,min-range*.15),high=max+range*.15,first=Date.parse(rows[0].date),last=Date.parse(rows.at(-1).date);
  const x=q=>last===first?50:4+(Date.parse(q.date)-first)/(last-first)*92,y=q=>(high-q.price)/(high-low)*100;
  const segments=[];let gaps=false;
  for(let i=1;i<rows.length;i++) {
    const a=rows[i-1],b=rows[i],gap=Date.parse(b.date)-Date.parse(a.date)>86400000;
    if(gap)gaps=true;
    segments.push(`<path d="M${x(a)*10} ${y(a)*2}L${x(b)*10} ${y(b)*2}"${gap?' stroke-dasharray="4 5"':''}/>`);
  }
  const pct=quotePercent(selected),axis=value=>value.toLocaleString('zh-CN',{minimumFractionDigits:high-low<.05?4:2,maximumFractionDigits:high-low<.05?4:2});
  return `<div class="history-chart-heading"><div><h3>${fund?'单位净值走势':'股价走势'}</h3><p>${rows.length} 条已保存记录 · ${esc(asset.currency)}</p></div><label class="history-date-select"><span>选择日期</span><select data-history-date aria-label="选择记录日期">${items.map(q=>`<option value="${esc(q.date)}"${q.date===selected.date?' selected':''}>${esc(q.date)}</option>`).join('')}</select></label></div>
    <div class="history-reading" aria-live="polite"><div><strong>${quoteNumber(selected.price)} <small>${esc(asset.currency)}</small></strong><span>${esc(selected.date)}${selected===rows.at(-1)?' · 最新记录':''}</span></div><div class="history-daily"><span>当日涨跌</span><b class="${pct===null?'muted':movementClass(pct)}">${pct===null?'—':signed(pct)+'%'}</b></div></div>
    <div class="trend-chart price-history-chart"><div class="trend-y-axis"><span>${axis(high)}</span><span>${axis((high+low)/2)}</span><span>${axis(low)}</span></div><div class="trend-plot"><svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true"><path class="trend-grid" d="M0 0H1000M0 100H1000M0 200H1000"/><path class="history-guide" d="M${x(selected)*10} 0V200"/><g class="trend-line">${segments.join('')}</g></svg>${rows.map(q=>`<button type="button" class="trend-dot history-point ${q===selected?'selected':''}" style="left:${x(q)}%;top:${y(q)}%" data-action="history-point" data-date="${esc(q.date)}" aria-pressed="${q===selected}" aria-label="${esc(q.date)}，${fund?'单位净值':'股价'} ${quoteNumber(q.price)} ${esc(asset.currency)}" title="${esc(q.date)} · ${quoteNumber(q.price)} ${esc(asset.currency)}"></button>`).join('')}<div class="trend-x-axis"><span>${esc(rows[0].date)}</span>${rows.length>1?`<span>${esc(rows.at(-1).date)}</span>`:''}</div></div></div>
    <p class="history-chart-note">${rows.length===1?'目前只有 1 条记录，积累更多数据后显示连线。':gaps?'虚线表示日期间隔（含休市），不补齐中间数据。':'仅连接已保存的记录。'}${fund?'单位净值未计现金分红。':'股价未复权。'}</p>`;
}
function instrumentBasicsHTML(asset,details) {
  const cell=(label,value,help='')=>`<div class="instrument-stat"><span>${label}</span><strong${help?` title="${esc(help)}"`:''}>${value}</strong></div>`;
  if(asset.type==='fund')return `<section class="instrument-basics"><h3>基金与持仓资料</h3><div class="instrument-stats">${cell('基金代码',esc(asset.fund?.code||'—'))}${cell('净值币种',esc(asset.currency))}${cell('已登记份额',Number.isFinite(asset.quantity)?quoteNumber(asset.quantity)+' 份':'—')}${cell('已登记累计分红',Number.isFinite(asset.reported?.dividends)?quoteNumber(asset.reported.dividends)+' '+esc(asset.currency):'未登记')}</div><p class="instrument-note">分红为${asset.reported?.date?esc(asset.reported.date)+' 的':'你的'}持仓累计记录，不是基金每份派息；基金不使用个股 PE 口径。</p></section>`;
  if(!asset.security)return '<section class="instrument-basics"><h3>基础资料</h3><p class="instrument-note">补充股票代码后可读取 PE、股息等基础资料。</p></section>';
  if(!details)return '<section class="instrument-basics" aria-busy="true"><h3>估值与股息</h3><p class="instrument-note">正在读取基础资料…</p></section>';
  const m=details.metrics||{},number=(value,digits=2)=>Number.isFinite(value)?value.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
  const ratio=value=>Number.isFinite(value)?value===0?'不适用':number(value)+' 倍':'—';
  const amount=value=>Number.isFinite(value)?number(value,4)+' '+esc(details.currency||asset.currency):'—';
  const marketCap=Number.isFinite(m.marketCap)?number(m.marketCap>=1e8?m.marketCap/1e8:m.marketCap)+' '+(m.marketCap>=1e8?'亿 ':'')+esc(details.currency||asset.currency):'—';
  return `<section class="instrument-basics"><div class="history-section-heading"><h3>估值与股息</h3>${['cached','unavailable'].includes(details.status)?`<button class="text-btn" data-action="retry-instrument-details">重试读取 ${icon('refresh',13)}</button>`:''}</div><p class="instrument-snapshot-note">最新可用快照，不随图表日期切换。</p>${details.message?`<p class="instrument-status" role="status">${esc(details.message)}</p>`:''}<div class="instrument-stats">${cell('PE · TTM',ratio(m.peTTM),'数据源的滚动市盈率；负值按原值展示，源值为 0 时显示不适用。')}${cell('股息率 · TTM',Number.isFinite(m.dividendYieldTTM)?number(m.dividendYieldTTM)+'%':'—')}${cell('每股股息 · TTM',amount(m.dividendTTM))}${cell('PB · 市净率',ratio(m.pb))}${cell('PE · 数据源口径',ratio(m.pe))}${cell('总市值',marketCap)}${cell('每股盈利',amount(m.eps))}${cell('每股净资产',amount(m.bookValuePerShare))}${cell('每股股息 · 上一财年',amount(m.dividendLFY))}${cell('股息率 · 上一财年',Number.isFinite(m.dividendYieldLFY)?number(m.dividendYieldLFY)+'%':'—')}</div>${details.time?`<p class="instrument-source">${esc(details.source)} · ${esc(details.time)}（${esc(details.timeZone)}）${details.status==='cached'?' · 缓存记录':''}</p>`:''}<details class="instrument-method"><summary>指标口径与来源</summary><p>TTM 为近 12 个月，上一财年为 LFY。股息按每股和来源币种展示，不是你的已收分红，也不代表未来派息。缺失指标显示“—”；数值为 0 时按来源显示。<a href="https://openapi.futunn.com/futu-api-doc/quote/get-market-snapshot.html" target="_blank" rel="noreferrer">查看数据源说明 ↗</a></p></details></section>`;
}
async function loadInstrumentDetails(view) {
  if(view.asset.type!=='stock'||!view.asset.security)return;
  const section=$('#instrument-basics');if(section)section.innerHTML=instrumentBasicsHTML(view.asset,null);
  let details;
  try{details=await api('/market/details?id='+encodeURIComponent(view.asset.id));}
  catch(error){details={status:'unavailable',message:error.message};}
  if(activePriceHistory===view&&$('#dialog').open&&$('#instrument-basics'))$('#instrument-basics').innerHTML=instrumentBasicsHTML(view.asset,details);
}
function selectHistoryDate(date) {
  const view=activePriceHistory;if(!view||!view.items.some(q=>q.date===date))return;
  view.selectedDate=date;
  $('#price-history-chart').innerHTML=priceHistoryChartHTML(view.asset,view.items,date);
}
async function priceHistoryDialog(id){
  const a=data.state.assets.find(a=>a.id===id);if(!a)return;
  showDialog(a.name+' · 涨跌记录',a.valuation?.source||'', '<div id="price-history-view"><p class="inline-note">正在读取…</p></div>');
  const view={asset:a,items:[],selectedDate:''};activePriceHistory=view;
  try {
    const {items}=await api('/market/history?id='+encodeURIComponent(id));
    if(activePriceHistory!==view||!$('#dialog').open||!$('#price-history-view'))return;
    view.items=items.filter(q=>Number.isFinite(q.price)&&q.price>0&&/^\d{4}-\d{2}-\d{2}$/.test(q.date)&&Number.isFinite(Date.parse(q.date))).sort((a,b)=>b.date.localeCompare(a.date));
    $('#price-history-view').innerHTML=`<section id="price-history-chart">${priceHistoryChartHTML(a,view.items)}</section><div id="instrument-basics">${instrumentBasicsHTML(a,null)}</div>${view.items.length?`<details class="history-records"><summary>逐日明细 <span>${view.items.length} 条记录</span></summary><div class="table-scroll"><table><thead><tr><th>日期</th><th>${a.type==='fund'?'单位净值':'价格'}</th><th>涨跌幅</th></tr></thead><tbody>${view.items.map(q=>{const pct=quotePercent(q);return `<tr><td>${esc(q.date)}</td><td>${quoteNumber(q.price)} ${esc(q.currency)}</td><td class="${pct===null?'muted':movementClass(pct)}">${pct===null?'—':signed(pct)+'%'}</td></tr>`;}).join('')}</tbody></table></div></details>`:''}<p class="instrument-note history-footnote">按披露日／交易日保存，最多展示最近 60 条记录。价格变化不代表你的实际投资收益。</p>`;
    await loadInstrumentDetails(view);
  } catch(error) {
    if(activePriceHistory===view&&$('#dialog').open&&$('#price-history-view'))$('#price-history-view').innerHTML=`<p class="instrument-status" role="alert">${esc(error.message)}</p>${button('asset-price-history','重新读取','refresh','secondary',`data-id="${esc(id)}"`)}`;
  }
}
function ledgerEntriesHTML() {
  const entries=data.ledgerEntries||[];if(!entries.length)return '';
  const pending=entries.filter(e=>e.status==='pending').length,names={pending:'待入账',applied:'已入账',blocked:'需核对',cancelled:'已取消'};
  return `<details class="ledger-records" ${pending?'open':''}><summary>对话记账${pending?' · '+pending+' 笔待入账':''}</summary>${entries.slice(0,12).map(e=>`<div class="ledger-record"><div><strong>${esc(e.label)}</strong><small>${esc(e.date)} · ${names[e.status]||esc(e.status)}${e.amount!=null?' · '+Number(e.amount).toLocaleString('zh-CN',{maximumFractionDigits:2})+' '+esc(e.asset.currency):''}${e.cashSource?' · '+(e.cashSource==='outside'?'额外投入／账外资金':'已登记现金'):''}${e.estimated?' · 按价格估算':''}</small>${e.status==='pending'?'<p>等待指定日期的收盘价／披露净值，取得后自动更新持仓与现金。</p>':e.message?'<p>'+esc(e.message)+'</p>':''}</div>${e.status==='pending'?`<button type="button" class="text-btn" data-action="cancel-ledger-entry" data-id="${esc(e.id)}">取消</button>`:''}</div>`).join('')}</details>`;
}
function assetsPage() {
  const s=data.state,m=data.metrics;
  const assets=filteredAssets();
  return `${heading('资产与负债','',button('import-csv','导入 CSV','upload')+button('add-asset','记录资产','plus','primary'))}
    ${ledgerEntriesHTML()}
    <div class="asset-tools"><label class="asset-search"><input id="asset-search" type="search" aria-label="搜索资产" placeholder="搜索名称、股票代码、基金代码或账户" value="${esc(assetQuery)}"/><button id="clear-asset-search" type="button" class="icon-btn" data-action="clear-asset-search" aria-label="清空搜索" ${assetQuery?'':'hidden'}>${icon('close',14)}</button></label><span id="asset-result-count" class="asset-result-count" role="status">${assetResultCount(assets)}</span></div>
    <div class="filter-bar">${[['all','全部资产'],['cash','现金'],['stock','股票'],['fund','基金'],['bond','债券'],['gold','黄金'],['insurance','保险'],['other','其他']].map(([v,l])=>`<button class="filter ${assetFilter===v?'active':''}" data-action="asset-filter" data-filter="${v}">${l}</button>`).join('')}<div class="toolbar-end"><a class="text-btn" href="/api/template">下载模板 ${icon('download',12)}</a></div></div>
    ${stockMarketFiltersHTML()}
    <div class="card"><div class="asset-summary"><div><span>已登记总资产</span><strong class="money">${privateAmount('assets-total-assets',m.totalAssets,'已登记总资产')}</strong></div><div><span>配置资产池净值</span><strong class="money">${privateAmount('assets-pool',m.pool,'配置资产池净值')}</strong></div>${['all','stock'].includes(assetFilter)?allocationSummaryHTML('stock',stockAllocation()):''}${['all','fund'].includes(assetFilter)?allocationSummaryHTML('fund',fundAllocation()):''}</div><div id="asset-results">${assetTable(assets,false,assetFilter!=='all'||Boolean(assetQuery.trim()))}</div></div>
    <div class="section-heading"><h2>我的负债</h2><div class="heading-actions"><a class="text-btn" href="/api/template?kind=debts">负债模板</a>${button('import-debts','导入负债','upload','secondary')}${button('add-debt','记录负债','plus','secondary')}</div></div><div class="card">${s.debts.length?`<div class="table-scroll"><table><thead><tr><th>负债名称</th><th>剩余本金</th><th>每月还款</th><th>类型</th><th>操作</th></tr></thead><tbody>${s.debts.map(d=>`<tr><td><div class="asset-name"><span><strong>${esc(d.name)}</strong><small>${d.rate!==null?'实际年化 '+d.rate+'%':'利率待补充'}${d.overdue?' · 已登记逾期':''}</small></span></div></td><td class="money">${d.currency==='CNY'?money(d.balance):esc(d.currency)+' '+d.balance.toLocaleString('zh-CN')}</td><td class="money">${d.payment===null?'待补充':d.currency==='CNY'?money(d.payment):esc(d.currency)+' '+d.payment.toLocaleString('zh-CN')}</td><td><span class="pill ${d.investment?'caution':'info'}">${d.investment?'投资融资':'生活负债'}</span></td><td><button class="text-btn row-action" data-action="edit-debt" data-id="${esc(d.id)}" aria-label="编辑${esc(d.name)}">编辑</button><button class="text-btn row-action" data-action="delete-debt" data-id="${esc(d.id)}" aria-label="删除${esc(d.name)}">删除</button></td></tr>`).join('')}</tbody></table></div>`:empty('暂未登记负债','如果有贷款或分期，请一并记录；没有负债可以留空。')}</div>
    <div class="inline-note">${icon('info',12)} 配置池排除房产、车辆、应急及专项预留，投资融资从池净值扣除。保证金黄金按净权益入账，名义敞口单列。<button class="text-btn" data-action="show-calculation">查看我的计算口径 ${icon('chevron',11)}</button></div>`;
}
function incomeScheduleHTML(){
  const schedule=data.incomeSchedule;
  if(!schedule?.enabled)return '<p class="inline-note">启用后按月收入金额更新本地现金账本；应用运行时自动处理，关闭期间错过的发薪日会在下次启动补记。</p>';
  if(schedule.status==='blocked')return `<p class="error-text" role="status">${esc(schedule.message)}</p>`;
  const credits=schedule.credits||[];
  return `<p class="inline-note">已启用工资自动记账 · ${esc(schedule.accountName)} · 每月 ${data.state.profile.payday} 日入账 ${money(schedule.amount)}${schedule.nextDate?' · 下次 '+esc(schedule.nextDate):''}。同月仅记一次，应用关闭期间会在下次启动补记。</p>${credits.length?`<details class="income-credit-history"><summary>最近工资入账记录</summary><div class="table-scroll"><table><thead><tr><th>工资月份</th><th>应入账日</th><th>记账金额</th><th>实际记账日</th></tr></thead><tbody>${credits.map(c=>`<tr><td>${esc(c.period)}</td><td>${esc(c.dueDate)}</td><td>${money(c.amount)}</td><td>${esc(new Intl.DateTimeFormat('en-CA',{timeZone:data.state.preferences.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c.postedAt)))}</td></tr>`).join('')}</tbody></table></div></details>`:''}`;
}
function cashflowPage() {
  const p=data.state.profile,m=data.metrics,b=p.background||{},auto=p.autoIncome||{},cash=data.state.assets.filter(a=>a.type==='cash'&&a.currency==='CNY'&&!a.restricted);
  return `${heading('收入与计划','')}
    ${ledgerEntriesHTML()}
    <div class="two-columns cashflow-layout"><form class="card form-card" id="profile-form"><h2>每月现金流</h2><p class="form-intro">填写税后经常性收入与必要开支。奖金等不确定收入暂不计入。</p><div class="form-grid">${field('税后经常性月收入 / 元','income',p.income,{placeholder:'例如 30000'})}${field('每月必要生活支出 / 元','expenses',p.expenses,{placeholder:'不含贷款月供'})}${select('收入稳定程度','incomeStability',p.incomeStability,[['unknown','尚未说明'],['stable','固定工资为主'],['variable','收入有波动'],['none','暂时无收入']])}${field('每月发薪日','payday',p.payday,{min:1,max:31,step:1})}<div class="full">${checkbox('incomeAutoCredit','每月按发薪日自动记入现金',auto.enabled)}</div>${select('工资入账账户','incomeCashAssetId',auto.cashAssetId||cash[0]?.id||'',[['','请选择现金账户'],...cash.map(a=>[a.id,a.name+' · CNY'])])}${field('自动入账起始日期','incomeStartsOn',auto.startsOn||today(data.state.preferences.timeZone),{type:'date',help:'从此日期起的发薪日开始记账；遇到不存在的日期按月末。'})}<div class="full">${incomeScheduleHTML()}</div>${field('应急储备目标 / 月','emergencyMonths',p.emergencyMonths,{help:'初始建议值可调整，属于现代适配，不是原著要求。',full:true})}</div><div class="form-actions">${draftNotice('profile-form')}<button class="btn btn-primary" type="submit">保存现金流</button></div></form>
    <div class="card form-card"><h2>现金流汇总</h2><p class="form-intro">按当前已登记资料计算</p><div class="cash-flow-line"><span>税后经常性收入</span><b class="money">${money(m.income)}</b></div><div class="cash-flow-line"><span>已登记生活支出</span><b class="money">${money(m.baseExpenses)}</b></div><div class="cash-flow-line"><span>额外续期保费（月均）</span><b class="money">${money(m.insuranceExpenseComplete?m.insuranceExpense:null)}</b></div><div class="cash-flow-line"><span>每月债务偿还</span><b class="money">${money(m.paymentComplete?m.payment:null)}</b></div><div class="cash-flow-total"><span>月度经常性结余</span><strong class="money ${m.surplus!==null&&m.surplus<0?'negative':''}">${privateAmount('cashflow-surplus',m.surplus,'月度经常性结余')}</strong></div><p class="inline-note">保费只补计未包含在生活开支中的部分；年缴保费仍须准备缴费日现金。投资投入、可选消费和一次性支出需另行考虑；未到账收入不计入可支配现金。</p></div>
    <div class="card form-card full"><div class="wealth-top"><h2>未来支出计划</h2><button class="text-btn" data-action="add-upcoming">${icon('plus',13)} 添加计划</button></div>${data.state.upcoming.length?`<p class="plan-summary">${data.state.upcoming.length} 项计划 · 计划金额合计 <b class="money">${money(data.state.upcoming.reduce((sum,u)=>sum+u.amount,0))}</b></p>`+data.state.upcoming.slice().sort((a,b)=>a.date.localeCompare(b.date)).map(u=>`<div class="upcoming-item"><div class="upcoming-name"><strong>${esc(u.name)}</strong><small>${esc(u.date)} · ${u.date<today()?'<span class="plan-date-past">日期已过，请核对</span>':'计划支出'}</small></div><div class="upcoming-end"><span class="money">${money(u.amount)}</span><div class="actions-cell"><button class="text-btn row-action" data-action="edit-upcoming" data-id="${esc(u.id)}" aria-label="编辑计划${esc(u.name)}">编辑</button><button class="text-btn row-action" data-action="delete-upcoming" data-id="${esc(u.id)}" aria-label="删除计划${esc(u.name)}">删除</button></div></div></div>`).join(''):'<p class="form-intro" style="margin:17px 0 0">学费、装修或医疗等近期必要支出，提前列在这里。请同时在现金账户中设置专项预留。</p>'}</div>
    <form class="card form-card background-card full" id="background-form"><h2>关于你 <span class="pill info">选填</span></h2><p class="form-intro">让建议考虑你的家庭、生活阶段和目标。称呼可用昵称；无需填写身份证、账号、保单号或精确住址。启用 AI 后，这些资料会随已授权摘要发送。</p><div class="form-grid">
    ${field('希望 AI 如何称呼你','displayName',b.displayName??'',{type:'text',maxlength:80,placeholder:'姓名或昵称',help:'用于页面欢迎语和 AI 对话，可随时修改或留空。',full:true})}
    ${select('这份账本的范围','scope',b.scope||'',[['','暂不填写'],['personal','个人财务'],['household','家庭合计']])}
    ${select('年龄阶段','ageBand',b.ageBand||'',[['','暂不填写'],['under30','30 岁以下'],['30to44','30–44 岁'],['45to59','45–59 岁'],['60plus','60 岁及以上']])}
    ${field('需供养人数（不含自己）','dependents',b.dependents,{max:50,step:1,placeholder:'没有填 0；未知留空'})}
    ${field('低收入月份的税后收入 / 元','incomeFloor',b.incomeFloor,{placeholder:'浮动收入可填写保守值'})}
    ${field('预计距离退休 / 年','retirementYears',b.retirementYears,{max:80})}
    ${field('主观可接受的投资亏损 / 元','comfortableLoss',b.comfortableLoss,{help:'仅表示意愿，AI 仍须检查实际承受能力。'})}
    ${select('已知的医疗 / 人身保障概况','protection',b.protection||'',[['','暂不填写'],['unknown','尚未梳理'],['none','暂未配置'],['social','主要为社保'],['commercial','主要为商业保障'],['both','社保和商业保障']])}
    <label class="form-field full"><span>目标与用钱时间</span><textarea name="priorities" maxlength="1000" placeholder="例如：两年后准备 20 万首付，希望长期保留半年应急金">${esc(b.priorities)}</textarea></label>
    <label class="form-field full"><span>家庭责任与特殊约束</span><textarea name="constraints" maxlength="1000" placeholder="例如：赡养父母、孩子教育、自营业务、未来收入变化、不能动用的资金。避免填写身份和健康隐私。">${esc(b.constraints)}</textarea></label>
    </div><p class="inline-note">收入、支出、负债请使用相同的个人 / 家庭口径。近期有明确金额和日期的支出，继续在“未来支出计划”中登记。保障类型不代表保障已经充分。</p><div class="form-actions">${draftNotice('background-form')}<button class="btn btn-primary" type="submit">保存个人背景</button></div></form></div>`;
}

function aiStatus() {
  const c=data.config;
  if(!c.baseUrl||!c.model)return {ready:false,label:'尚未配置 AI',detail:'填写模型服务 URL、模型名称和密钥后即可提问。'};
  if(!c.consent)return {ready:false,label:'等待摘要授权',detail:'请在设置中允许向所选服务发送财务摘要。'};
  if(c.connection?.ok)return {ready:true,label:c.connection.tools?'模型与计算工具已验证':'模型文字连接已验证',detail:c.connection.checkedAt?'最近验证：'+new Date(c.connection.checkedAt).toLocaleString('zh-CN'):''};
  if(c.connection?.ok===false)return {ready:true,label:['AI_TIMEOUT','AI_ROUND_TIMEOUT'].includes(c.connection.code)?'上次生成超时':'上次连接失败',detail:c.connection.message};
  return {ready:true,label:'已配置，尚未验证',detail:'可以在设置中测试连接，也可以直接提问。'};
}
function chatHistoryHTML() {
  const items=data.conversations||[],selected=data.conversation?.id;
  return `<aside class="chat-history" id="chat-history" aria-label="历史对话"><div class="chat-history-heading"><span>对话记录</span></div><button class="chat-new" data-action="new-chat">${icon('plus',15)} 新建对话</button><nav class="chat-history-list" aria-label="选择历史对话">${items.length?items.map(item=>`<div class="chat-history-row${selected===item.id?' is-selected':''}"><button class="chat-history-select" data-action="select-chat" data-id="${esc(item.id)}" ${selected===item.id?'aria-current="true"':''} title="${esc(item.title)}"><span>${esc(item.title)}</span><small>${chatBusy&&chatActiveConversationId===item.id?'正在回答':new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:data.state.preferences.timeZone}).format(new Date(item.updated_at))}</small></button><button class="chat-history-delete" data-action="delete-chat" data-id="${esc(item.id)}" aria-label="删除对话：${esc(item.title)}" title="删除对话">${icon('trash',14)}</button></div>`).join(''):'<p class="chat-history-empty">还没有历史对话<br>聊完后会自动保存在这里</p>'}</nav><p class="chat-history-foot">保存在本机<br>各段对话的上下文互相独立</p></aside>`;
}
function assistantPage() {
  const c=data.config,m=data.metrics,status=aiStatus(),name=data.state.profile.background?.displayName??'';
  const current=currentChatRun(),busy=chatBusy&&current,readOnly=Boolean(data.conversation&&data.conversation.scope_id!==(c.scopeId||''));
  const hasConversation=data.messages.length||(current&&(chatPendingMessage||chatBusy||chatStreamText));
  const suggestions=[['spark','一起理清选择','我有件拿不定主意的事，想听听你的看法。'],['clock','安排今天的事','帮我理一理今天要做的事，先从最重要的开始。'],['wallet','规划我的加仓','按我的网格策略，给谷歌加仓建议安排多少钱？']];
  return `<header class="assistant-header"><div class="assistant-title"><h1>个人助手</h1><span>生活、工作与财务，都可以聊</span></div><div class="assistant-header-actions"><details class="assistant-context"><summary>财务背景 ${icon('chevron',13)}</summary><div class="assistant-context-panel"><p>根据当前已登记的财务资料</p><dl><div><dt>净资产${!m.complete?' · 部分估值':''}</dt><dd>${money(m.netWorth)}</dd></div><div><dt>股票比例</dt><dd>${stockPercent(m)}</dd></div><div><dt>每月结余</dt><dd>${money(m.surplus)}</dd></div></dl><a href="#cashflow">编辑关于你与财务资料 ${icon('arrow',14)}</a></div></details></div></header>
    <div class="ai-workspace">${chatHistoryHTML()}<div class="chat-card">
    ${!status.ready?`<div class="ai-setup-note"><div><strong>${status.label}</strong><p>${esc(status.detail)}</p></div>${button('configure-ai','前往设置','link','soft')}</div>`:''}
    ${readOnly?'<div class="chat-context-note">模型或授权设置已变更，这段历史仍可查看。<button class="text-btn" data-action="new-chat">新建对话继续</button></div>':chatBusy&&!current?'<div class="chat-context-note">另一段对话正在回答。<button class="text-btn" data-action="select-chat" data-id="'+esc(chatActiveConversationId)+'">返回那段对话</button></div>':''}
    <div class="chat-messages${hasConversation?'':' is-empty'}" id="chat-messages" aria-live="polite"><div class="chat-thread">${data.messages.length?data.messages.map(messageHTML).join(''):hasConversation?'':`<div class="assistant-welcome"><span class="assistant-welcome-label">你的个人助手</span><h2>${name?'你好，'+esc(name):'你好'}</h2><p>有什么想聊的，或需要我帮你理清的？</p><div class="suggestions">${suggestions.map(([symbol,title,q])=>`<button class="suggestion" data-action="ask" data-question="${esc(q)}"><span class="suggestion-symbol">${icon(symbol,20)}</span><strong>${title}</strong><span>${q}</span></button>`).join('')}</div></div>`}
    ${current&&chatPendingMessage?`<div class="message user"><div class="message-label">你</div><div class="message-content">${esc(chatPendingMessage)}</div></div>`:''}${current&&(chatBusy||chatStreamText||chatToolCalls.length)?`<div class="message" id="live-answer">${liveAnswerHTML()}</div>`:''}</div></div>
    ${current&&chatError?`<div class="chat-error" role="alert"><strong>这次未能完成回答</strong><p>${esc(chatError)}</p><span>${chatRunId||chatRequestId?'回答已保存在后台，正在重新连接。':'问题已保留，你可以检查设置后重新发送。'}</span>${chatRunId||chatRequestId?'<button type="button" class="text-btn" data-action="resume-chat">重新连接回答</button>':''}</div>`:''}
    <form class="chat-compose" id="chat-form"><div class="chat-input-wrap"><textarea name="message" rows="1" aria-label="向个人助手提问" placeholder="问问你的个人助手" required maxlength="4000" ${busy||readOnly?'disabled':''}>${esc(chatDraft)}</textarea><div class="composer-actions"><button type="button" class="chat-model" data-action="configure-ai" title="${esc((c.model||'选择模型')+' · '+status.label+(status.detail?' · '+status.detail:''))}" aria-label="模型设置：${esc(c.model||'未选择模型')}"><span>${esc(c.model||'选择模型')}</span>${icon('chevron',13)}</button>${busy?'<button class="send-btn stop-btn" type="button" data-action="stop-chat" aria-label="停止回答"><span></span></button>':`<button class="send-btn" type="submit" aria-label="发送问题" ${!status.ready||chatBusy||readOnly?'disabled':''}>${icon('send',19)}</button>`}</div></div><div class="chat-compose-meta"><button type="button" class="chat-context-setting" data-action="configure-ai">${c.includePageData?'页面资料已接通 · ':''}${c.includeHistory?'上下文 · 当前对话最近 6 轮':'上下文未开启 · 去设置'}</button><span class="chat-connection${c.connection?.ok?' is-verified':''}">${status.label}</span><span class="chat-disclaimer">${status.ready?`将发送问题、${c.includePageData?'完整页面业务资料':'财务摘要'}${c.includeHistory?'与当前对话上下文':''}至你配置的模型 · ${c.useTools===false?'工具已关闭':c.allowLedgerWrites?'可按你的明确指令记账，不执行真实交易':'只读计算，不会改账或交易'}`:'配置并授权后才会向模型发送资料'}</span></div></form></div></div>`;
}
function fitChatInput(input=$('#chat-form textarea')) {
  if(!input?.style)return;
  input.style.height='auto';input.style.height=Math.min(input.scrollHeight,144)+'px';
}
function messageHTML(m) {
  return `<div class="message ${m.role==='user'?'user':''}"><div class="message-label">${m.role==='user'?'你':'AI'}</div>${m.role==='user'?'':toolCallsHTML(m.metadata?.toolCalls||[])}<div class="message-content">${esc(m.role==='user'?m.content:adviceText(m.content))}</div></div>`;
}
function toolCallsHTML(calls) {
  if(!calls.length)return '';
  const json=value=>esc(JSON.stringify(value??null,null,2));
  const group='tools-'+calls[0].id,running=calls.some(c=>c.status==='running'),waiting=calls.some(c=>['needs_information','pending','blocked'].includes(c.output?.status)),failed=calls.some(c=>c.status==='error');
  const label=running?'正在处理':failed?'部分处理未完成':waiting?'有待确认或入账的事项':`已完成 ${calls.length} 项处理`;
  return `<details class="chat-tool-summary" data-tool-id="${esc(group)}" ${expandedToolCalls.has(group)?'open':''}><summary>${running?'<span class="thinking-spinner" aria-hidden="true"></span>':icon('check',11)}<span>${label}</span></summary><div class="chat-tool-calls" aria-label="工具调用记录">${calls.map(call=>`<details class="chat-tool-call" data-tool-id="${esc(call.id)}" ${expandedToolCalls.has(call.id)?'open':''}><summary><span>${esc(call.label||call.name)}</span><small class="tool-state ${call.status==='error'?'is-error':''}">${call.status==='running'?'正在执行':call.status==='error'?'执行失败':'已完成'}</small></summary><div class="chat-tool-body"><code>${esc(call.name)}</code><h4>调用参数</h4><pre>${json(call.args)}</pre><h4>返回数据</h4>${Object.hasOwn(call,'output')?`<pre>${json(call.output)}</pre>`:'<p>正在等待工具返回…</p>'}</div></details>`).join('')}</div></details>`;
}
function liveAnswerHTML(){
  const label=chatStage==='calculating'?'正在核算':chatStage==='answering'?'正在回答':'正在思考';
  return `<div class="message-label">AI</div>${toolCallsHTML(chatToolCalls)}${chatStreamText?`<div class="message-content">${esc(adviceText(chatStreamText))}</div>`:''}<div class="generation-state" role="status">${chatBusy?`<span class="thinking-spinner" aria-hidden="true"></span>${label}`:'回答未完成'}</div>`;
}
function paintLiveAnswer(){
  if(route!=='assistant'||!currentChatRun())return;
  const chat=$('#chat-messages'),follow=chat.scrollHeight-chat.scrollTop-chat.clientHeight<100;
  $('#live-answer').innerHTML=liveAnswerHTML();
  if(follow)chat.scrollTop=chat.scrollHeight;
}

function reportsPage() {
  const reports=data.reports, report=reports.find(r=>r.day===selectedReport)||reports[0];
  const briefs=data.marketBriefs?.latest||[],stale=report&&report.day===today(data.state.preferences.timeZone)&&Number.isInteger(report.revision)&&report.revision!==data.state.revision;
  const tasks=report?.rules.slice(0,3).map(r=>r.id==='stale'?'更新过期资产估值':r.id==='missing'?'补齐收入、支出及缺失字段':r.id==='stock-caution'?'新增投资前，个人助手 复核股票比例与资金用途':r.id==='cashflow'?'核对必要开支与还款安排，优先处理每月缺口':r.id==='empty'?'添加第一项资产与每月收支':`复核“${r.title}”的依据`)||[];
  return `${heading('每日总结','',button('generate-report',reportBusy?'正在生成…':'生成今日总结','refresh','primary',reportBusy?'disabled aria-busy="true"':''))}
    ${!report?`<div class="card report-empty">${empty('给今天留下一份财务快照','总结会保留数据时点、配置提醒和待办事项。无 AI 连接也可以生成。',button('generate-report',reportBusy?'正在生成…':'生成第一份总结','report','soft',reportBusy?'disabled':''))}</div>`:`
    <div class="report-layout">
      <nav class="report-nav" aria-label="历史日报"><span class="report-nav-label">${icon('clock',15)} 日报归档</span><div class="report-date-list">${reports.map(r=>`<button type="button" class="report-day ${r.day===report.day?'active':''}" data-action="select-report" data-day="${esc(r.day)}" aria-pressed="${r.day===report.day}"><time datetime="${esc(r.day)}">${esc(r.day)}</time>${r.isDemo||r.late?`<small>${r.isDemo?'演示':r.late?'补生成':''}</small>`:''}</button>`).join('')}</div></nav>
      ${stale?`<div class="report-stale" role="status"><div>${icon('clock',16)}<span>账本已更新，这份快照尚未重新生成。</span></div>${button('generate-report',reportBusy?'正在生成…':'更新今日快照','refresh','soft',reportBusy?'disabled':'')}</div>`:''}
      <article class="card report-detail">
        <div class="report-top"><div><h2>财务快照</h2><p>${esc(report.day)} · 生成于 ${esc(new Date(report.generatedAt).toLocaleString('zh-CN',{timeZone:data.state.preferences.timeZone}))}${report.late?' · 离线后补生成':''}${Number.isInteger(report.revision)?' · 账本版本 '+report.revision:''}</p></div><span class="pill info">${report.aiText?'附 AI 解读':'本地规则报告'}</span></div>
        <div class="report-metrics">
          <div class="report-metric-primary"><small>已登记净资产${report.metrics.complete===false?' · 部分估值待补充':''}</small><strong class="money">${privateAmount('report-net-worth-'+report.day,report.metrics.netWorth,'日报净资产')}</strong><span>按各项资产标示日期估值</span></div>
          <div><small>股票配置比例</small><strong class="money${report.metrics.stockRatio==null?' is-pending':report.metrics.stockRatioMax!=null&&Math.abs(report.metrics.stockRatioMax-report.metrics.stockRatio)>.01?' is-range':''}">${stockPercent(report.metrics)}</strong><span>长期配置资产池口径</span></div>
          <div><small>月度经常性结余</small><strong class="money${report.metrics.surplus==null?' is-pending':''}">${privateAmount('report-surplus-'+report.day,report.metrics.surplus,'日报月度结余')}</strong>${report.metrics.surplus==null?'<a href="#cashflow">完善收支资料 ↗</a>':'<span>按已登记收支与还款计算</span>'}</div>
        </div>
        <div class="report-change"><div><h3>与上次已登记日期相比</h3><p>${report.changes==null?'尚无更早的已登记快照，暂不展示变化。':esc(report.changeLabel)+'。'}</p></div><strong class="money">${report.changes==null?'—':privateAmount('report-change-'+report.day,report.changes,'与上次相比的估值变化',{format:changeAmount})}</strong></div>
        <div class="report-insights">
          <section class="report-section"><h3>当前值得留意<span class="report-count">${report.rules.length}</span></h3><div class="report-rule-list">${rulesHTML(report.rules,20,true)}</div></section>
          <section class="report-section report-next"><h3>接下来可以做</h3><ol>${(tasks.length?tasks:['定期更新资产与支出计划，维持自己的纪律。']).map(task=>`<li>${esc(task)}</li>`).join('')}</ol></section>
        </div>
        ${report.aiText?`<section class="report-section report-ai"><h3>${icon('spark',16)} AI 解读 <span>以事实卡片为准</span></h3><p style="white-space:pre-wrap">${esc(adviceText(report.aiText))}</p></section>`:''}
        ${report.aiError?`<p class="inline-note">${esc(report.aiError)}</p>`:''}
      </article>
    </div>`}
    ${briefs.length?`<section class="report-markets"><div class="report-market-heading"><h2>市场回顾</h2><p>各市场最近已记录交易日</p></div>${marketBriefsHTML(briefs)}</section>`:''}`;
}

function settingsPage() {
  return `${heading('设置','')}<div class="filter-bar settings-tabs">${[['ai','AI 连接'],['rules','投资纪律'],['data','数据与备份']].map(([v,l])=>`<button class="filter ${settingsTab===v?'active':''}" data-action="settings-tab" data-tab="${v}">${l}</button>`).join('')}</div><div class="settings-layout">${settingsTab==='ai'?aiSettings():settingsTab==='rules'?ruleSettings():dataSettings()}</div>`;
}
function aiSettings() {
  const c=data.config,status=aiStatus();
  return `<form class="card form-card" id="ai-form"><div class="wealth-top"><h2>模型连接</h2><span class="pill ${c.connection?.ok?'info':'caution'}">${status.label}</span></div><p class="form-intro">支持 Chat Completions 兼容接口，可结合财务摘要、市场行情与只读计算回答问题。</p><div class="form-grid">${field('服务 Base URL','baseUrl',c.baseUrl,{type:'url',full:true,placeholder:'https://your-provider.example/v1',help:'填写接口基础地址，系统会追加 /chat/completions。'})}${field('模型名称','model',c.model,{type:'text',placeholder:'填写服务提供的模型 ID',full:true})}${field('API Key','apiKey','',{type:'password',full:true,placeholder:c.hasKey?'已保存密钥；留空保持不变':'本机服务不要求密钥时可留空',help:'密钥仅在服务端加密保存，不回传、不进入普通导出。'})}</div>${field('单次模型响应等待时间 / 秒','requestTimeoutSeconds',c.requestTimeoutSeconds??120,{min:10,max:300,step:1,help:'默认 120 秒，可设为 10–300 秒。复杂分析和工具调用可能需要更长时间；整轮最长为此值的 3 倍。',full:true})}${c.hasKey?checkbox('clearKey','删除当前保存的密钥'):''}
    <div class="privacy-preview" style="margin-top:23px"><strong>哪些资料会发给模型</strong><br>你的问题、资产负债汇总、保险现金价值与保费、收支、投资纪律、支出计划及已填写的个人背景。未开启完整页面资料时，不发送账户名称、借款机构、资产备注；开启后这些已保存业务资料也可读取。开启上下文后，只追加当前对话、同一连接及授权设置下最近的问答，其他对话不会混入。完整记录保存在本机，可从左侧历史查看。问题和个人背景中的文字也会发送，请避免填写身份与账户凭据。${c.baseUrl?'<br>当前目标：'+esc(c.baseUrl):''}</div>
    ${checkbox('consent','允许向上述服务发送财务摘要与选填个人背景',c.consent)}
    ${checkbox('includeHoldings','同时发送持仓、保单与负债的名称、类型、估值与日期',c.includeHoldings)}
    ${checkbox('includePageData','允许 AI 读取全部页面业务资料，包括账户名称、备注、成本、历史、日报及市场数据',c.includePageData)}<p class="inline-note">开启后，每轮自动提供完整已保存财务档案与各页最新数据；图表历史、日报归档由只读工具直接读取。包含上方的持仓名称范围，不受金额隐藏或页面筛选影响；未保存草稿不发送。登录密码、API Key 和密钥文件不进入模型上下文。</p>
    ${checkbox('includeHistory','携带当前对话上下文，支持连续追问（最近 6 轮，最多 24,000 字符）',c.includeHistory)}
    ${checkbox('useTools','启用行情、财务计算及已授权的记账工具（模型需支持工具调用）',c.useTools!==false)}
    ${checkbox('allowLedgerWrites','允许 AI 根据我的明确指令更新本地持仓和现金记录',c.allowLedgerWrites)}<p class="inline-note">买入先确认现有现金或额外投入；行情未披露时保存待入账记录。只更新本地账本，不连接券商交易。记账变动可在最近修改中恢复。</p>
    ${checkbox('marketBriefsAI','让 AI 每个交易日总结港股和美股（各一份，自动缓存）',c.marketBriefsAI)}${checkbox('autoReport','每日总结自动调用该模型',c.autoReport)}
    <div class="form-actions">${draftNotice('ai-form')}<button class="btn btn-secondary" type="submit" value="save">仅保存</button><button class="btn btn-primary" type="submit" value="test">保存并测试连接</button></div><p class="inline-note">${esc(status.detail)}<br>连接测试使用空白测试档案，不发送你的财务资料。关闭工具后只进行文字问答，AI 不会计算决定后的精确变化。未配置模型时仍可使用账本、规则提醒和本地日报。</p></form>`;
}
function ruleSettings() {
  const p=data.state.policy,g=p.grid||{enabled:true,stepPercent:5,tranches:4,perStockBudgetCNY:null},pref=data.state.preferences;
  return `<form class="card form-card" id="rules-form"><h2>投资与财务纪律</h2><p class="form-intro">初始股票谨慎线为 50%，可按自己的纪律调整。其他上限留空即不启用；这些是你的配置规则，不替代个股研究。</p><div class="form-grid">${field('股票比例谨慎线 / %','stockCaution',p.stockCaution,{required:true,max:100})}${field('股票比例警戒上限 / %','stockLimit',p.stockLimit,{max:100,placeholder:'可选，例如 75'})}${field('税后月供收入比上限 / %','debtRatioLimit',p.debtRatioLimit,{max:100,placeholder:'可选，由你设定'})}${field('单一发行人直接持仓上限 / %','issuerLimit',p.issuerLimit,{max:100,placeholder:'可选，由你设定',help:'占配置池净值的比例，同一公司的 A/H 持仓合并计算。'})}${field('默认每笔买入占配置池 / %','buyTranchePercent',p.buyTranchePercent,{min:0.01,max:100,step:0.01,placeholder:'可选，例如 1',help:'包含可投资现金；填写后优先于等额分批数，接近仓位或资金上限时缩小金额。'})}${field('估值更新提醒 / 天','staleDays',p.staleDays,{min:1,max:365,step:1})}${field('每日总结生成时间','reportTime',pref.reportTime,{type:'time',required:true})}${select('日报时区','timeZone',pref.timeZone,[['Asia/Shanghai','Asia/Shanghai · 中国标准时间'],['Asia/Hong_Kong','Asia/Hong_Kong'],['UTC','UTC']])}<div class="full">${checkbox('autoFx','自动更新港币与美元参考汇率',pref.autoFx!==false)}</div>${field('外币汇率（1 外币 = 人民币）','rates',Object.entries(pref.rates).filter(([k])=>k!=='CNY').map(([k,v])=>`${k}=${v}`).join(', '),{type:'text',placeholder:'例如 USD=7.1, HKD=0.91',help:'关闭自动更新后使用手工值；缺少汇率时标为待补充。',full:true})}</div><div class="inline-note">股票比例 = 配置池内股票敞口 ÷ 配置池净值。超过谨慎线会提醒；“特别看好”也可在对话中说明理由，提醒仍保留。日报需要自托管服务持续运行。</div><h3 class="grid-policy-heading">价格网格与分批</h3>${checkbox('gridEnabled','使用价格网格分批（无股息股票也适用）',g.enabled)}<div class="form-grid">${field('每格价格间距 / %','gridStep',g.stepPercent,{min:1,max:30})}${field('等额分批数','gridTranches',g.tranches,{min:2,max:12,step:1})}${field('单只股票本轮预算上限 / 元（可选）','gridBudget',g.perStockBudgetCNY,{placeholder:'留空按资金承受上限规划',full:true})}</div><p class="inline-note">先核定总预算；设置每笔占配置池比例时按该比例介入，留空则按等额分批数安排。不倍投、不追补跨过的格子，每笔重新核对现金和仓位。</p><div class="form-actions">${draftNotice('rules-form')}<button class="btn btn-primary" type="submit">保存纪律与偏好</button></div></form>`;
}
function dataSettings() {
  return `<div class="card form-card"><h2>备份与恢复</h2><p class="form-intro">财务档案存放在自托管服务的 SQLite 数据库中。普通备份包含资产、保险、个人背景与纪律；旧版决定记录继续保留，排除登录信息、API 密钥和对话。</p><div class="setting-row"><div><strong>导出财务档案</strong><p>下载 JSON 备份，可用于迁移或恢复。</p></div><a class="btn btn-secondary" href="/api/export">${icon('download',14)} 导出备份</a></div><div class="setting-row"><div><strong>恢复备份</strong><p>先预览，再替换当前档案。不会修改 AI 密钥。</p></div>${button('restore','选择备份','upload')}</div><div class="setting-row"><div><strong>对话记录</strong><p>对话保存在本机服务中，可单独删除。</p></div>${button('clear-chat','删除全部对话','trash')}</div><div class="setting-row"><div><strong>清空财务档案</strong><p>清空后重新开始，近期历史可恢复；建议先导出备份。</p></div>${button('reset','清空档案','trash','danger')}</div><div class="setting-row"><div><strong>访问保护</strong><p>${auth.preview?'当前为本机免登录预览。正常启动后会要求设置访问密码。':'访问密码已启用，登录会话有效期为 24 小时。'}</p></div>${auth.preview?'':button('logout','退出登录','logout')}</div></div><div class="card form-card" style="margin-top:22px"><h2>最近修改</h2><p class="form-intro">保留最近 100 次财务修改，此处显示最近 20 次。恢复会生成一条新的修改记录。</p>${data.audit.length?data.audit.map(a=>`<div class="audit-row"><div>${esc(a.label)}<small>${esc(new Date(a.created_at).toLocaleString('zh-CN'))}</small></div><button class="text-btn" data-action="restore-version" data-id="${a.id}">恢复修改前 ${icon('refresh',12)}</button></div>`).join(''):'<p class="muted" style="font-size:11px">还没有修改记录。</p>'}</div>`;
}

let stockResults=[],stockSearchEpoch=0,stockLookupTimer;
const stockQuoteCache=new Map();
const stockMarkets=[['ALL','全部市场'],['SH','沪市 A 股'],['SZ','深市 A 股'],['HK','港股'],['US','美股']];
function readAssetDraft(){
  const f=new FormData($('#asset-form')),id=f.get('id'),prev=data.state.assets.find(a=>a.id===id)||{},market=f.get('stockMarket'),symbol=f.get('stockSymbol');
  return {...prev,id:id||undefined,type:f.get('type'),name:f.get('name'),account:f.get('account'),currency:f.get('currency'),value:numberValue(f,'value'),asOf:f.get('asOf'),quantity:numberValue(f,'quantity'),unit:f.get('unit'),inPool:f.has('inPool'),autoPrice:f.has('autoPrice'),costEntryMode:f.get('costMode')||'average',costEntryAmount:numberValue(f,'costAmount'),costReferenceValue:numberValue(f,'costReferenceValue'),confirmPositionValue:f.has('confirmPositionValue'),fund:f.get('type')==='fund'?{...(prev.fund?.code===f.get('fundCode')?prev.fund:{}),code:f.get('fundCode')||'',autoNav:f.has('autoNav')}:undefined,stockMarket:market,security:symbol?{market,symbol,key:market+'.'+symbol}:null};
}
async function findStock(){
  const form=$('#asset-form');if(!form)return;
  const f=new FormData(form);if(f.get('type')&&f.get('type')!=='stock')return;
  const query=f.get('name')?.trim(),market=f.get('stockMarket')||'ALL',epoch=++stockSearchEpoch;
  if(!query)return toast('请输入股票名称或代码');
  $('[data-stock-results]').innerHTML='<p class="inline-note" role="status">正在搜索…</p>';
  try{
    const result=await api('/market/search?q='+encodeURIComponent(query)+'&market='+encodeURIComponent(market));
    if(epoch!==stockSearchEpoch||$('#asset-form')!==form)return;
    stockResults=result.items;
    $('[data-stock-results]').innerHTML=stockResults.length?stockResults.map((x,i)=>`<button type="button" class="security-result" data-action="select-security" data-index="${i}"><span>${esc(x.name)}<small>${esc(stockMarkets.find(([m])=>m===x.market)?.[1]||x.market)} · ${esc(x.currency)}</small></span><b>${esc(x.key)}</b></button>`).join(''):`<p class="inline-note">${esc(result.message||'未找到匹配股票，可试试股票代码或选择全部市场。')}</p>`;
  }catch(e){if(epoch===stockSearchEpoch&&$('#asset-form')===form)$('[data-stock-results]').innerHTML=`<p class="error-text">${esc(e.message)}</p>`;}
}
function costFields(a){
  if(!['stock','fund'].includes(a.type))return '';
  const stock=a.type==='stock',mode=a.costEntryMode||(a.costBasis?.method==='inferred_pnl'?'pnl':a.costBasis?.method==='inferred_return'?'return':'average'),cost=a.costBasis?.quantity===a.quantity?a.costBasis?.amount:null;
  const amount=a.costEntryAmount!==undefined?a.costEntryAmount:mode==='average'?(cost!=null&&a.quantity>0?Number((cost/a.quantity).toFixed(10)):null):mode==='cost'?cost:mode==='pnl'?(a.investment?.profit??(cost!=null&&Number.isFinite(a.value)?Math.round((a.value-cost)*100)/100:null)):mode==='return'?(a.investment?.returnPercent??null):null;
  const choices=[['average',stock?'每股成本':'平均单位成本'],['pnl','持仓收益金额'],['return','持仓收益率'],['cost','持仓总成本']];
  const label=mode==='average'?(stock?'每股成本':'平均单位成本')+'（'+a.currency+' / '+(stock?'股':'份')+'）':mode==='pnl'?'持仓收益金额 / '+a.currency:mode==='return'?'持仓收益率 / %':'持仓总成本 / '+a.currency;
  const note=mode==='average'?(stock?'总成本 = 每股成本 × 持有股数。':'总成本 = 平均单位成本 × 持有份数。'):mode==='return'?'按对应持仓金额 ÷（1 + 收益率）估算成本；亏损填负百分比，例如 -11.95。四舍五入可能造成差异。':'成本或持仓收益填一个即可，亏损填负数。';
  return `<details class="cost-entry full" open><summary>成本与盈亏（选填）</summary><div class="form-grid">${select('你知道的是','costMode',mode,choices)}${field(label,'costAmount',amount,{min:mode==='pnl'?-1e14:mode==='return'?-100:0,placeholder:mode==='average'?'平均买入单位成本':mode==='return'?'例如 -11.95':mode==='pnl'?'盈利填正数，亏损填负数':'整笔持仓的总成本'})}${['pnl','return'].includes(mode)?field('对应的持仓金额 / '+a.currency,'costReferenceValue',a.costReferenceValue??(a.valuation?.status==='manual'?a.value:null),{placeholder:'按行情计算时可留空',help:'截图收益请填写同一张截图的持仓金额；留空则用当前份数与已取得行情计算。',full:true}):''}${a.type==='fund'&&a.fund?.autoNav&&['pnl','return'].includes(mode)?`<div class="full">${checkbox('confirmPositionValue','同时用上述持仓金额校准当前估值',a.confirmPositionValue??a.valuation?.status==='manual')}<p class="inline-note">保留自动净值；取得更新日期的净值后恢复按份数估值。</p></div>`:''}</div><p class="inline-note">${note} 不含另行登记的现金分红。</p></details>`;
}
function readCostBasis(f,item){
  const entry=numberValue(f,'costAmount');if(entry==null)return null;
  const mode=f.get('costMode');let amount=entry;
  if(mode==='average'){
    if(!['stock','fund'].includes(item.type)||!Number.isFinite(item.quantity)||item.quantity<=0)throw new Error('请先填写大于 0 的持有'+(item.type==='stock'?'股数':'份数'));
    if(!Number.isFinite(entry)||entry<0)throw new Error((item.type==='stock'?'每股成本':'平均单位成本')+'需要为非负数');
    amount=Math.round(entry*item.quantity*100)/100;
  }
  if(['pnl','return'].includes(mode)){
    const old=data.state.assets.find(a=>a.id===item.id),same=item.type==='stock'?old?.security?.key===item.security?.market+'.'+item.security?.symbol:old?.fund?.code===item.fund?.code;
    const quote=item.type==='stock'?stockQuoteCache.get(item.security?.market+'.'+item.security?.symbol)||(same?old?.valuation:null):(same?old?.valuation:null);
    let reference=numberValue(f,'costReferenceValue');
    if(reference==null&&same&&old?.valuation?.status==='manual'&&old.quantity===item.quantity)reference=old.value;
    if(reference==null&&quote?.price!=null&&item.quantity!=null)reference=Math.round(quote.price*item.quantity*100)/100;
    if(reference==null&&!item.autoPrice&&!item.fund?.autoNav)reference=item.value;
    if(reference==null)throw new Error('填写对应的持仓金额，或先保存份额取得行情后再补收益');
    if(!Number.isFinite(reference)||reference<0)throw new Error('持仓金额需要为非负数');
    if(mode==='return'&&entry<=-100)throw new Error('收益率必须大于 -100%，无法从完全亏损反推成本');
    amount=Math.round((mode==='pnl'?reference-entry:reference/(1+entry/100))*100)/100;
  }
  if(!Number.isFinite(amount)||amount<0)throw new Error('反推成本小于零或无效，请核对持仓金额与收益');
  return {amount,quantity:item.quantity,currency:item.currency,method:mode==='pnl'?'inferred_pnl':mode==='return'?'inferred_return':'entered'};
}

function investmentHTML(a){
  if(!['stock','fund'].includes(a.type))return '<span class="muted">—</span>';
  const m=a.investment;if(m?.profit==null)return '<span class="muted">待补成本</span>';
  return `<span class="price-movement ${movementClass(m.profit)}" title="当前市值减持仓成本，不含现金分红"><strong>${signed(m.profit)} ${esc(a.currency)}</strong>${m.returnPercent==null?'':`<small>${signed(m.returnPercent)}%</small>`}</span>`;
}
function assetDialog(id, draft) {
  clearTimeout(stockLookupTimer);stockSearchEpoch++;
  const a=draft||data.state.assets.find(x=>x.id===id)||{type:'cash',currency:'CNY',asOf:today(),inPool:true,emergency:0,earmarked:0},i=a.insurance||{},autoStock=a.type==='stock'&&(a.autoPrice===true||(!id&&a.autoPrice!==false)),auto=(a.type==='fund'&&(a.fund?.autoNav===true||(!id&&!a.fund)))||autoStock;
  const units=a.type==='stock'?'股':a.type==='fund'?'份':'';
  const quantity=units?field('持有数量 / '+units,'quantity',a.quantity,{required:auto})+`<input type="hidden" name="unit" value="${units}"/>`:a.type.startsWith('gold')?field('持有数量','quantity',a.quantity)+select('单位','unit',a.unit||'盎司',[['盎司','盎司'],['克','克']]):'';
  showDialog(id?'编辑资产':'记录资产','',`<form id="asset-form"><input type="hidden" name="id" value="${esc(id||'')}"/><div class="form-grid">
  ${field(a.type==='stock'?'股票名称或代码':'资产名称','name',a.name,{type:'text',required:true,full:true,placeholder:a.type==='stock'?'例如：中国平安、601318、AAPL':''})}
  ${select('资产类型','type',a.type,Object.entries(typeNames))}${field('所属账户','account',a.account,{type:'text'})}
  ${a.type==='stock'?`${select('交易市场','stockMarket',a.security?.market||a.stockMarket||'ALL',stockMarkets)}<div class="form-field"><span>查找股票</span>${button('search-security','搜索股票','search','secondary','type="button"')}</div><div class="security-results full" data-stock-results></div><input type="hidden" name="stockSymbol" value="${esc(a.security?.symbol||'')}"/>${a.security?`<div class="security-selected full">${icon('check',15)} ${esc(a.name)} · ${esc(a.security.key)} · ${esc(a.currency)}</div>`:''}<div class="full">${checkbox('autoPrice','自动更新股票行情',autoStock)}</div><p class="inline-note full" data-stock-status>${a.security?'休市时使用最近交易日行情。':'搜索后选择准确的股票与市场。'}</p>`:''}
  ${auto?`<input type="hidden" name="currency" value="${a.type==='stock'?esc(a.currency):'CNY'}"/>`:select('币种','currency',a.currency,[['CNY','人民币'],['HKD','港币'],['USD','美元']])}
  ${auto?`<input type="hidden" name="value" value="${esc(a.value??'')}"/>`:field(a.type==='insurance'?'当前保单价值':a.type==='gold_margin'?'账户净权益':'当前估值','value',a.value,{required:a.type!=='insurance',min:a.type==='gold_margin'?-1e14:0})}
  ${auto?`<input type="hidden" name="asOf" value="${esc(a.asOf||today())}"/>`:''}${quantity}
  ${costFields(a)}
  ${a.type==='stock'?field('同一发行人','issuer',a.issuer,{type:'text'}):''}
  ${a.type==='fund'?`${field('基金代码','fundCode',a.fund?.code||'',{type:'text',required:auto,placeholder:'六位数字'})}<div class="full">${checkbox('autoNav','按份额自动更新单位净值',auto)}</div>`:''}
  ${a.type==='insurance'?`${select('保险类型','insuranceKind',i.kind||'savings',[['savings','储蓄 / 增额寿险'],['annuity','年金保险'],['investment','投资连结保险'],['protection','保障型保险']])}
  ${select('估值依据','valuationBasis',i.valuationBasis||'cash_value',[['cash_value','现金价值'],['account_value','账户价值'],['surrender_value','退保净值']])}
  ${field('保障保额（不计入资产）','sumAssured',i.sumAssured)}${field('累计已缴保费','paidPremiums',i.paidPremiums)}
  ${field('已确认可领取金额','accessibleValue',i.accessibleValue)}${field('每期保费','premiumAmount',i.premiumAmount)}
  ${select('缴费周期','premiumFrequency',i.premiumFrequency||'unknown',[['unknown','待确认'],['monthly','每月'],['quarterly','每季'],['yearly','每年'],['single','一次性已缴'],['paid_up','已缴清']])}
  ${field('下次缴费日期','nextPremiumDate',i.nextPremiumDate,{type:'date'})}
  ${i.kind==='investment'?field('已确认股票占比 / %','insuranceEquityRatio',a.equityRatio,{max:100,placeholder:'未知留空'}):''}
  <div class="full">${checkbox('premiumInExpenses','续期保费已包含在每月生活支出中',i.premiumInExpenses!==false)}</div><p class="inline-note full">保额和已缴保费不替代当前保单价值；保单价值不等于可支取现金。</p>`:''}
  ${a.type==='cash'?field('应急预留','emergency',a.emergency??0)+field('专项预留','earmarked',a.earmarked??0):''}
  ${a.type==='gold_margin'?field('名义敞口','notional',a.notional)+field('可提取资金','available',a.available)+select('持仓方向','direction',a.direction||'long',[['long','多头'],['short','空头']]):''}
  ${auto?'':`<details class="full cost-entry"><summary>补充信息（选填）</summary>${field('这笔估值对应的日期','asOf',a.asOf||today(),{type:'date',help:'通常无需修改，留空按本次记录。'})}</details>`}
  </div>${checkbox('inPool','纳入长期配置资产池',a.inPool)}${a.type==='cash'?checkbox('restricted','资金受限',a.restricted):''}
  ${a.reported?`<p class="inline-note">原始记录 ${esc(a.reported.date)} · 累计收益 ${money(a.reported.totalReturn)} · 累计分红 ${money(a.reported.dividends)}。分红不另计入现金。</p>`:''}
  ${a.note?`<p class="inline-note">${esc(a.note)}</p>`:''}<div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">保存资产</button></div></form>`);
}
function upcomingDialog(id) {
  const plan=id?data.state.upcoming.find(u=>u.id===id):{name:'',amount:null,date:today()};
  if(!plan)return toast('这项计划已不存在');
  showDialog(id?'编辑支出计划':'添加支出计划','登记未来必要支出，并在现金账户中为它预留资金。',`<form id="upcoming-form"><input type="hidden" name="id" value="${esc(id||'')}"/><div class="form-grid">${field('计划名称','name',plan.name,{type:'text',required:true,full:true,placeholder:'例如：学费、装修'})}${field('所需金额 / 元','amount',plan.amount,{required:true})}${field('计划日期','date',plan.date,{type:'date',required:true})}</div><div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">保存计划</button></div></form>`);
}
function debtDialog(id) {
  const d=data.state.debts.find(x=>x.id===id)||{currency:'CNY',type:'mortgage'};
  showDialog(id?'编辑负债':'记录一项负债','月供包括本金和利息；不确定的信息可以留空。',`<form id="debt-form"><input type="hidden" name="id" value="${esc(id||'')}"/><div class="form-grid">${field('负债名称','name',d.name,{type:'text',required:true,full:true,placeholder:'例如：住房贷款'})}${select('类型','type',d.type,[['mortgage','住房贷款'],['consumer','消费贷款'],['credit','信用卡分期'],['investment','投资融资'],['other','其他借款']])}${select('币种','currency',d.currency,[['CNY','CNY · 人民币'],['HKD','HKD · 港币'],['USD','USD · 美元']])}${field('剩余本金 / 账户币种','balance',d.balance,{required:true})}${field('每月债务偿还 / 账户币种','payment',d.payment,{placeholder:'不知道请留空'})}${field('实际年化利率 / %（可选）','rate',d.rate,{max:100,help:'勿直接填写分期手续费率或平息费率。'})}${field('本金集中到期日（可选）','maturity',d.maturity,{type:'date',help:'仅登记需集中还本的债务，不填普通房贷的最后一期日期。'})}</div>${checkbox('investment','这笔借款用于投资，需要从配置池净值扣除',d.investment)}${checkbox('overdue','这笔债务已逾期',d.overdue)}<p class="inline-note">保证金账户净权益中已扣除的融资，不在这里重复登记。</p><div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">保存负债</button></div></form>`);
}
function confirmDialog(title,description,action,id) {
  pending={action,id}; showDialog(title,description,`<div class="form-actions"><button class="btn btn-secondary" data-action="close-dialog">取消</button><button class="btn btn-danger" data-action="confirm-pending">确认${title}</button></div>`);
}
async function consumeChatStream(response,epoch=chatEpoch) {
  if(!response.ok){const value=await response.json();if(value.config)data.config=value.config;throw Object.assign(new Error(value.error||'请求失败'),{terminal:true});}
  let completed=false;
  await readEventStream(response.body,({event,data:payload})=>{
    if(epoch!==chatEpoch)return false;
    const value=JSON.parse(payload);
    if(event==='run') {
      chatRunId=value.id;
      if(value.conversationId) {
        chatActiveConversationId=value.conversationId;
        if(chatOriginViewEpoch===chatViewEpoch&&!data.conversation) {
          data.conversation={id:value.conversationId,title:chatPendingMessage.slice(0,36),scope_id:data.config.scopeId,updated_at:new Date().toISOString()};
          data.conversations=[data.conversation,...(data.conversations||[]).filter(c=>c.id!==value.conversationId)];
          if(route==='assistant')render();
        }
      }
    }
    if(event==='status')chatStage=value.stage;
    if(event==='tools')chatToolCalls=value.calls||[];
    if(event==='tool'){const index=chatToolCalls.findIndex(call=>call.id===value.call.id);if(index<0)chatToolCalls.push(value.call);else chatToolCalls[index]=value.call;}
    if(event==='reset')chatStreamText='';
    if(event==='delta'){chatStreamText+=value.text;chatStage='answering';}
    if(event==='error'){if(value.config)data.config=value.config;throw Object.assign(new Error(value.error||'回答中断，请重试'),{terminal:true});}
    if(event==='done'){applyChatData(value);completed=true;return false;}
    paintLiveAnswer();
  });
  if(epoch!==chatEpoch)return;
  if(!completed)throw new Error('连接已断开，正在重新连接回答。');
  chatRunId='';chatRequestId='';chatStreamText='';chatToolCalls=[];chatPendingMessage='';chatError='';
}
function reconnectChatLater() {
  clearTimeout(chatReconnectTimer);
  chatReconnectTimer=setTimeout(()=>{void resumeChat();},2000);
}
function restoreChatDraft(message) {
  if(currentChatRun())chatDraft=message;else if(chatActiveConversationId)chatDrafts.set(chatActiveConversationId,message);
}
function failedChat(error,message) {
  const cancelled=chatStopping||error.name==='AbortError';
  if(error.terminal||cancelled||(!chatRunId&&!chatRequestId)) {
    restoreChatDraft(message);
    chatError=cancelled?'已停止生成，未完成的回答未保存。':error.message;
    chatRunId='';chatRequestId='';chatBusy=false;
    if(!chatStreamText&&!chatToolCalls.length)chatPendingMessage='';
  } else {
    chatBusy=true;chatError='连接已断开，正在重新连接同一轮回答。';reconnectChatLater();
  }
}
async function resumeChat() {
  if(chatAbort||chatStopping||chatResuming)return;
  chatResuming=true;
  const epoch=chatEpoch;
  clearTimeout(chatReconnectTimer);
  try {
    const value=await api('/chat/run'),run=value.run;
    if(epoch!==chatEpoch)return;
    applyChatData(value);
    chatToolCalls=run?.toolCalls||[];
    if(run&&chatRequestId&&run.requestId!==chatRequestId){
      restoreChatDraft(chatPendingMessage||chatDraft);chatBusy=false;chatRunId='';chatRequestId='';chatStreamText='';chatToolCalls=[];chatPendingMessage='';chatError='这条问题尚未提交成功，请确认后重试。';return;
    }
    if(!run||run.status==='done') {
      if(!run||chatRequestId&&run.requestId!==chatRequestId)restoreChatDraft(chatPendingMessage||chatDraft);
      chatBusy=false;chatRunId='';chatRequestId='';chatStreamText='';chatToolCalls=[];chatPendingMessage='';chatError='';
      if(route==='assistant')render();return;
    }
    chatActiveConversationId=run.conversationId||chatActiveConversationId;
    if(run.status==='failed') {
      chatPendingMessage=run.question;
      failedChat(Object.assign(new Error(run.error),{terminal:true}),run.question);
      if(route==='assistant')render();return;
    }
    chatRunId=run.id;chatRequestId=run.requestId;chatBusy=true;chatPendingMessage=run.question;chatStreamText=run.text;chatStage=run.stage;chatError='';
    chatAbort=new AbortController();if(route==='assistant')render();
    await consumeChatStream(await fetch('/api/chat/stream?run='+encodeURIComponent(run.id),{headers:{Accept:'text/event-stream'},signal:chatAbort.signal}),epoch);
    chatBusy=false;
  } catch(error){if(epoch===chatEpoch)failedChat(error,chatPendingMessage||chatDraft);}
  finally {chatResuming=false;if(epoch===chatEpoch){chatAbort=null;if(route==='assistant')render();}}
}
async function sendQuestion(message) {
  if(chatBusy||!message.trim())return;
  chatDraft=message;chatError='';
  if(!aiStatus().ready){render();return;}
  if(data.conversation&&data.conversation.scope_id!==(data.config.scopeId||'')){toast('请新建对话继续');return;}
  clearTimeout(chatReconnectTimer);chatStopping=false;chatRequestId=crypto.randomUUID();chatRunId='';
  chatActiveConversationId=data.conversation?.id||'';chatOriginViewEpoch=chatViewEpoch;chatDrafts.delete(data.conversation?.id||'');
  const epoch=++chatEpoch;
  chatBusy=true;chatPendingMessage=message;chatStreamText='';chatToolCalls=[];chatStage='thinking';chatDraft='';chatAbort=new AbortController();render();
  try {
    const response=await fetch('/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({message,requestId:chatRequestId,conversationId:data.conversation?.id||null}),signal:chatAbort.signal});
    await consumeChatStream(response,epoch);if(epoch===chatEpoch)chatBusy=false;
  } catch(error){if(epoch===chatEpoch)failedChat(error,message);}
  finally {if(epoch===chatEpoch){chatAbort=null;if(route==='assistant')render();}}
}
async function stopChat() {
  clearTimeout(chatReconnectTimer);chatStopping=true;
  try {
    await api('/chat/stop',{method:'POST',body:{id:chatRunId||undefined}});
    if(chatAbort)chatAbort.abort();
    else {failedChat(new Error('已停止回答'),chatPendingMessage||chatDraft);if(route==='assistant')render();}
  } catch(error){chatError='暂时无法确认停止，请恢复连接后重试。';if(route==='assistant')render();}
  finally {chatStopping=false;}
}
function chooseFile(accept, handler) {
  const input=document.createElement('input');input.type='file';input.accept=accept;
  input.addEventListener('change',async()=>{ if(!input.files[0])return;try{if(input.files[0].size>1.8e6)throw new Error('文件不能超过 1.8 MB');await handler(await input.files[0].text());}catch(e){toast(e.message);} });input.click();
}
function calculationDialog() {
  const m=data.metrics;
  showDialog('计算口径','基准币种为人民币，以下金额来自当前已登记资料。',`<div class="comparison">${[['总资产',money(m.totalAssets)],['总负债（含负权益）',money(m.totalDebt)],['配置资产池净值',money(m.pool)],['配置池内股票敞口',money(m.equity)],['配置池内基金估值',money(m.fundValue)],['基金配置比例',percent(m.fundRatio)],['股票比例',stockPercent(m)],['应急预留',money(m.emergency)],['专项预留',money(m.earmarked)],['可支配现金',money(m.availableCash)]].map(([l,v])=>`<div class="compare-row" style="grid-template-columns:1.3fr 1fr"><span>${l}</span><span>${v}</span></div>`).join('')}</div><p class="inline-note">股票比例采用同一配置池的分子与分母；房产、车辆、应急及专项预留不在配置池中。保险默认在池外，可单独调整。投资融资从池净值扣除。基金单独统计，不折算计入股票比例；这不是格雷厄姆原著的纯股债比例。必要支出储备包括非受限现金，扣除专项款，可包含应急预留。</p>`);
}

document.addEventListener('keydown',event=>{
  if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-action="market-point"]')){event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
});
document.addEventListener('toggle',event=>{
  const id=event.target.dataset?.toolId;if(!id)return;
  if(event.target.open)expandedToolCalls.add(id);else expandedToolCalls.delete(id);
},true);
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action;
  try {
    if(action==='retry-start')return start();
    if(action==='cancel-ledger-entry'){data=await preserveChatView(await api('/ledger/entries',{method:'DELETE',body:{id:target.dataset.id}}));render();return;}
    if(action==='toggle-sidebar'){navCollapsed=!navCollapsed;render();$('[data-action="toggle-sidebar"]')?.focus?.();return;}
    if(action==='toggle-private-amount'){
      const key=target.dataset.amountKey;
      if(revealedAmounts.has(key))revealedAmounts.delete(key);else revealedAmounts.add(key);
      render();$(`[data-amount-key="${key}"]`)?.focus?.();return;
    }
    if(action==='generate-market-brief'){const result=await api('/market-briefs/generate',{method:'POST',body:{market:target.dataset.market}});applyMarketBriefs(result);pollMarketBriefs();return toast('市场简报正在生成');}
    if(action==='refresh-markets')return loadMarket(currentMarket(),true);
    if(action==='market-series'){marketSelections[currentMarket()]={seriesKey:target.dataset.key};return render();}
    if(action==='market-point'){marketSelections[currentMarket()].selectedDate=target.dataset.date;return render();}
    if(action==='more-pages'){showDialog('更多页面','市场、日报与个人设置',`<div class="mobile-page-menu">${routes.filter(([r])=>['us-market','hk-market','reports','settings'].includes(r)).map(([r,,label])=>`<a href="#${r}" class="${route===r?'active':''}" data-action="navigate" data-route="${r}">${label}</a>`).join('')}</div>`);return;}
    if(action==='navigate'){event.preventDefault();closeDialog();return routeTo(target.dataset.route);}
    if(action==='discard-draft'){formDrafts.delete(target.dataset.form);return render();}
    if(action==='clear-asset-search'||action==='clear-asset-filters'){assetQuery='';if(action==='clear-asset-filters'){assetFilter='all';stockMarketFilter='all';}render();$('#asset-search').focus();return;}
    if(action==='stop-chat')return stopChat();
    if(action==='resume-chat'){void resumeChat();return;}
    if(action==='close-dialog')return closeDialog();
    if(action==='add-asset'||action==='edit-asset')return assetDialog(target.dataset.id);
    if(action==='search-security')return findStock();
    if(action==='select-security'){
      const selected=stockResults[Number(target.dataset.index)];if(!selected)return;
      const draft=readAssetDraft(),id=draft.id;if(draft.security?.key!==selected.key){draft.costBasis=null;draft.costEntryAmount=null;delete draft.reported;}draft.name=selected.name;draft.security=selected;draft.currency=selected.currency;draft.autoPrice=true;assetDialog(id,draft);
      const form=$('#asset-form');$('[data-stock-status]').textContent='正在读取行情…';
      try{const result=await api('/market/quote',{method:'POST',body:{market:selected.market,symbol:selected.symbol}});const q=result.quote;if(q)stockQuoteCache.set(selected.key,q);if($('#asset-form')!==form)return;$('[data-stock-status]').textContent=q?'最新 '+q.price+' '+q.currency+' · '+q.time+' · '+q.source:result.attempt?.error||'行情暂不可用，可先保存股数。';}catch(e){if($('#asset-form')===form)$('[data-stock-status]').textContent=e.message;}
      return;
    }
    if(action==='asset-price-history')return priceHistoryDialog(target.dataset.id);
    if(action==='history-point'){selectHistoryDate(target.dataset.date);$('#price-history-chart [aria-pressed="true"]')?.focus?.();return;}
    if(action==='retry-instrument-details'){if(activePriceHistory)return loadInstrumentDetails(activePriceHistory);return;}
    if(action==='add-debt'||action==='edit-debt')return debtDialog(target.dataset.id);
    if(action==='asset-filter'){assetFilter=target.dataset.filter;return render();}
    if(action==='stock-market-filter'){if(!['all','CN','HK','US','BJ','unknown'].includes(target.dataset.market))return;stockMarketFilter=target.dataset.market;return render();}
    if(action==='settings-tab'){settingsTab=target.dataset.tab;return render();}
    if(action==='open-ai')return routeTo('assistant');
    if(action==='configure-ai'){settingsTab='ai';return routeTo('settings');}
    if(action==='trend-range'&&['recent','7','30'].includes(target.dataset.range)){trendRange=target.dataset.range;selectedTrendDay='';render();return;}
    if(action==='trend-point'){selectedTrendDay=target.dataset.day;render();return;}
    if(action==='show-calculation')return calculationDialog();
    if(action==='select-report'){selectedReport=target.dataset.day;return render();}
    if(action==='account'){settingsTab='data';return routeTo('settings');}
    if(action==='demo'){target.disabled=true;data=await api('/demo',{method:'POST',body:{revision:data.state.revision}});render();return toast('已载入虚构演示档案');}
    if(action==='generate-report'){
      if(reportBusy)return;reportBusy=true;render();
      try{const result=await api('/reports',{method:'POST',body:{}});data.reports=result.reports;selectedReport=result.report.day;routeTo('reports');toast('今日财务总结已生成');}
      finally{reportBusy=false;render();}return;
    }
    if(action==='new-chat')return newChat();
    if(action==='select-chat')return await selectChat(target.dataset.id);
    if(action==='delete-chat')return confirmDialog('删除这段对话？','将永久删除这段对话及其上下文。若正在回答，会一并停止。其他对话和财务档案不受影响。','delete-chat',target.dataset.id);
    if(action==='clear-chat')return confirmDialog('删除全部对话？','将永久删除所有历史对话及上下文，并停止正在生成的回答。财务档案不受影响。','clear-chat');
    if(action==='delete-asset'||action==='delete-debt'||action==='delete-upcoming')return confirmDialog('删除记录','此操作将修改财务档案，可从设置中的最近修改恢复。',action,target.dataset.id);
    if(action==='restore-version')return confirmDialog('恢复历史版本','将替换当前财务档案，AI 配置不受影响。','restore-version',target.dataset.id);
    if(action==='reset'){showDialog('清空财务档案','建议先导出备份。对话与日报会一并清空，财务档案保留近期恢复记录。',`<form id="reset-form">${field('输入“清空财务档案”以确认','confirmation','',{type:'text',required:true,full:true})}<div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button><button class="btn btn-danger" type="submit">清空并重新开始</button></div></form>`);return;}
    if(action==='confirm-pending'){
      const p=pending;
      if(p.action==='clear-chat'){await api('/chat',{method:'DELETE',body:{}});chatEpoch++;chatSelecting++;clearTimeout(chatReconnectTimer);chatAbort?.abort();chatAbort=null;chatRunId='';chatRequestId='';chatActiveConversationId='';chatDrafts.clear();chatDraft='';chatStreamText='';chatToolCalls=[];expandedToolCalls.clear();chatPendingMessage='';chatError='';chatBusy=false;data.messages=[];data.conversation=null;data.conversations=[];data.chatRun=null;}
      else if(p.action==='delete-chat') {
        const value=await api('/conversations',{method:'DELETE',body:{id:p.id}}),selected=data.conversation?.id===p.id;
        chatSelecting++;chatDrafts.delete(p.id);
        if(chatActiveConversationId===p.id) {
          chatEpoch++;clearTimeout(chatReconnectTimer);chatAbort?.abort();chatAbort=null;chatRunId='';chatRequestId='';chatActiveConversationId='';chatStreamText='';chatToolCalls=[];chatPendingMessage='';chatError='';chatBusy=false;
        }
        applyChatData(value,selected);if(selected){chatViewEpoch++;chatDraft=chatDrafts.get(data.conversation?.id||'')||'';}
      }
      else if(p.action==='restore-version'){data=await preserveChatView(await api('/undo',{method:'POST',body:{id:p.id,revision:data.state.revision}}));formDrafts.clear();}
      else{const next=structuredClone(data.state);const key={'delete-asset':'assets','delete-debt':'debts','delete-upcoming':'upcoming'}[p.action];next[key]=next[key].filter(a=>a.id!==p.id);await saveState(next,'删除一项财务记录');}
      closeDialog();render();return toast('已更新');
    }
    if(action==='ask'){chatDraft=target.dataset.question;render();$('#chat-form textarea').focus();return;}
    if(action==='add-upcoming'||action==='edit-upcoming')return upcomingDialog(target.dataset.id);
    if(action==='import-csv'||action==='import-debts')return chooseFile('.csv,text/csv',async csv=>{
      const preview=await api('/import/preview',{method:'POST',body:{csv,kind:action==='import-debts'?'debts':'assets'}});pending={action:'import',...preview};
      showDialog(preview.kind==='debts'?'预览负债导入':'预览资产导入',`共 ${preview.records.length} 项；${preview.existing} 项将按相同编号替换，其余新增。`,`<div>${preview.records.map(a=>`<div class="import-row"><span>${esc(a.name)} · ${esc(a.currency)}</span><b>${a.value==null&&a.balance==null?'待补充':(a.value??a.balance).toLocaleString('zh-CN')}</b></div>`).join('')}</div><p class="inline-note">资产和负债分别导入，请使用对应模板。相同编号会替换当前记录；请勿加入账户汇总行。导入时保留已有的其他记录。</p><div class="form-actions">${button('close-dialog','取消','','secondary')}${button('confirm-import','确认导入','upload','primary')}</div>`);
    });
    if(action==='confirm-import'){data=await preserveChatView(await api('/import',{method:'POST',body:{records:pending.records,kind:pending.kind,revision:pending.revision}}));closeDialog();render();return toast('导入完成，相同编号的记录已替换');}
    if(action==='restore')return chooseFile('.json,application/json',async text=>{
      let backup;try{backup=JSON.parse(text);}catch{throw new Error('备份不是有效 JSON');}
      const preview=await api('/restore/preview',{method:'POST',body:backup});pending={action:'restore',...preview};
      showDialog('预览备份恢复','确认后会替换当前财务档案；不会恢复或更改 API 密钥。',`<p class="form-intro">备份包含 ${preview.state.assets.length} 项资产、${preview.state.debts.length} 项负债，以及个人背景与纪律。</p><p class="inline-note">当前日报与对话保留原有快照时点；恢复档案后请重新生成今日总结。</p><div class="form-actions">${button('close-dialog','取消','','secondary')}${button('confirm-restore','替换当前档案','upload','primary')}</div>`);
    });
    if(action==='confirm-restore'){data=await preserveChatView(await api('/state',{method:'PUT',body:{state:pending.state,revision:pending.revision,label:'从备份恢复财务档案'}}));formDrafts.clear();closeDialog();render();return toast('财务档案已恢复');}
    if(action==='market-refresh'){target.disabled=true;try{data=await preserveChatView(await api('/market/refresh',{method:'POST',body:{}}));render();toast(data.result.errors.length?'部分行情待更新，已保留上次记录':'行情已更新');}finally{target.disabled=false;}return;}
    if(action==='logout'){await api('/auth/logout',{method:'POST',body:{}});auth.authenticated=false;formDrafts.clear();renderAuth();return;}
  }catch(e){toast(e.message);if(target.isConnected)target.disabled=false;}
});
document.addEventListener('input',event=>{rememberFormDraft(event);if(event.target.matches('#asset-search')){assetQuery=event.target.value;paintAssetResults();return;}if(event.target.matches('#asset-form [name=quantity]')){const input=$('#asset-form [name=costAmount]');if(input){input.value='';input.placeholder=$('#asset-form [name=costMode]').value==='average'?'股数变化后，请重新填写每股成本':'数量变化后，可重新填写成本或盈亏';}const reference=$('#asset-form [name=costReferenceValue]');if(reference)reference.value='';}if(event.target.matches('#chat-form textarea')){chatDraft=event.target.value;fitChatInput(event.target);}if(!event.isComposing&&event.target.matches('#asset-form [name=name]')&&$('#asset-form [name=type]').value==='stock'){$('#asset-form [name=stockSymbol]').value='';stockSearchEpoch++;clearTimeout(stockLookupTimer);stockLookupTimer=setTimeout(()=>findStock(),350);}});
document.addEventListener('change',event=>{
  rememberFormDraft(event);
  if(event.target.matches('[data-history-date]')){selectHistoryDate(event.target.value);$('[data-history-date]')?.focus?.();return;}
  if(event.target.matches('#asset-form [name=costMode]')){const draft=readAssetDraft();draft.costEntryAmount=null;draft.costPanelOpen=true;assetDialog(draft.id,draft);}

  if(event.target.matches('#asset-form [name=autoPrice]')){const draft=readAssetDraft();assetDialog(draft.id,draft);}
  if(event.target.matches('#asset-form [name=stockMarket]')){$('#asset-form [name=stockSymbol]').value='';stockSearchEpoch++;findStock();}

  if(event.target.matches('#asset-form [name=autoNav]')){
    const f=new FormData($('#asset-form')),id=f.get('id'),prev=data.state.assets.find(a=>a.id===id)||{};
    assetDialog(id,{...prev,...readAssetDraft(),type:'fund',name:f.get('name'),account:f.get('account'),currency:event.target.checked?'CNY':f.get('currency'),value:numberValue(f,'value'),asOf:f.get('asOf'),quantity:numberValue(f,'quantity'),unit:'份',equityRatio:numberValue(f,'equityRatio'),inPool:f.has('inPool'),fund:{code:f.get('fundCode'),autoNav:event.target.checked}});
  }
  if(event.target.matches('#asset-form [name=type]')){
    const f=new FormData($('#asset-form')),type=f.get('type');
    assetDialog(f.get('id'),{name:f.get('name'),account:f.get('account'),type,currency:f.get('currency'),value:['stock','fund'].includes(type)?null:numberValue(f,'value'),asOf:f.get('asOf')||today(),inPool:!['other','insurance'].includes(type),quantity:null,unit:'',fund:type==='fund'?{code:'',autoNav:true}:undefined});
  }
});
document.addEventListener('keydown',event=>{
  if(event.target.matches('#asset-form [name=name]')&&$('#asset-form [name=type]').value==='stock'&&event.key==='Enter'&&!event.isComposing){event.preventDefault();findStock();}

  if(event.target.matches('#chat-form textarea')&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#chat-form').requestSubmit();}
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();
  const formId=form.getAttribute('id'), f=new FormData(form), submits=[...form.querySelectorAll('[type=submit]')];submits.forEach(button=>button.disabled=true);
  try{
    if(formId==='auth-form'){await api(auth.initialized?'/auth/login':'/auth/setup',{method:'POST',body:{password:f.get('password')}});auth.authenticated=true;auth.initialized=true;data=await api('/bootstrap');render();return;}
    if(formId==='asset-form'){
      const next=structuredClone(data.state), id=f.get('id')||crypto.randomUUID(),type=f.get('type');
      const item={...next.assets.find(a=>a.id===id),id,type,name:f.get('name'),account:f.get('account'),currency:f.get('currency'),value:numberValue(f,'value'),asOf:f.get('asOf')||today(),inPool:f.has('inPool'),restricted:f.has('restricted'),emergency:type==='cash'?numberValue(f,'emergency')||0:0,earmarked:type==='cash'?numberValue(f,'earmarked')||0:0,equityRatio:type==='fund'?numberValue(f,'equityRatio'):type==='insurance'?numberValue(f,'insuranceEquityRatio'):null,quantity:numberValue(f,'quantity'),unit:f.get('unit'),issuer:f.get('issuer'),notional:type==='gold_margin'?numberValue(f,'notional'):null,available:type==='gold_margin'?numberValue(f,'available'):null,direction:f.get('direction')};
      if(type==='stock'&&f.has('autoPrice')&&!f.get('stockSymbol'))throw new Error('请先搜索并选择股票');
      if(type==='stock'&&f.get('stockSymbol')){item.security={market:f.get('stockMarket'),symbol:f.get('stockSymbol')};item.autoPrice=f.has('autoPrice');}else{delete item.security;delete item.autoPrice;}
      if(type==='fund'&&f.get('fundCode')){
        const code=f.get('fundCode').trim(),old=next.assets.find(a=>a.id===id);
        item.fund={...(old?.fund?.code===code?old.fund:{}),code,autoNav:f.has('autoNav')};
        if(item.fund.valuationOverride?.quantity!==item.quantity)delete item.fund.valuationOverride;
        if(f.has('confirmPositionValue')){
          const value=numberValue(f,'costReferenceValue'),date=today(next.preferences.timeZone);
          if(value==null||!Number.isFinite(value)||value<0||!(item.quantity>0))throw new Error('校准估值需要对应的持仓金额和有效份数');
          item.fund.valuationOverride={value,quantity:item.quantity,date,navDate:old?.valuation?.navDate||old?.valuation?.date||date};
        }else if(['pnl','return'].includes(f.get('costMode')))delete item.fund.valuationOverride;
      }else delete item.fund;
      if(['stock','fund'].includes(type))item.costBasis=readCostBasis(f,item);else delete item.costBasis;
      if(type!=='insurance')delete item.insurance;
      if(type==='insurance')item.insurance={kind:f.get('insuranceKind'),valuationBasis:f.get('valuationBasis'),sumAssured:numberValue(f,'sumAssured'),paidPremiums:numberValue(f,'paidPremiums'),accessibleValue:numberValue(f,'accessibleValue'),premiumAmount:numberValue(f,'premiumAmount'),premiumFrequency:f.get('premiumFrequency'),premiumInExpenses:f.has('premiumInExpenses'),nextPremiumDate:f.get('nextPremiumDate')};
      const index=next.assets.findIndex(a=>a.id===id);if(index<0)next.assets.push(item);else next.assets[index]=item;
      await saveState(next,index<0?'记录一项资产':'更新资产估值');closeDialog();return toast('资产已保存');
    }
    if(formId==='debt-form'){
      const next=structuredClone(data.state),id=f.get('id')||crypto.randomUUID();const item={id,name:f.get('name'),type:f.get('type'),currency:f.get('currency'),balance:numberValue(f,'balance'),payment:numberValue(f,'payment'),rate:numberValue(f,'rate'),maturity:f.get('maturity'),investment:f.has('investment'),overdue:f.has('overdue')};
      const index=next.debts.findIndex(d=>d.id===id);if(index<0)next.debts.push(item);else next.debts[index]=item;
      await saveState(next,'更新负债记录');closeDialog();return toast('负债已保存');
    }
    if(formId==='profile-form'){
      const next=structuredClone(data.state);next.profile={...next.profile,income:numberValue(f,'income'),expenses:numberValue(f,'expenses'),payday:numberValue(f,'payday'),emergencyMonths:numberValue(f,'emergencyMonths'),incomeStability:f.get('incomeStability'),autoIncome:{...next.profile.autoIncome,enabled:f.has('incomeAutoCredit'),cashAssetId:f.get('incomeCashAssetId')||'',startsOn:f.get('incomeStartsOn')||''}};await saveState(next,'更新每月收入与支出',formId);return toast('现金流资料已保存');
    }
    if(formId==='upcoming-form'){
      const next=structuredClone(data.state),id=f.get('id'),index=next.upcoming.findIndex(u=>u.id===id);
      if(id&&index<0)throw new Error('这项计划已不存在，请关闭后重新打开');
      const item={id:id||crypto.randomUUID(),name:f.get('name'),amount:numberValue(f,'amount'),date:f.get('date')};
      if(index<0)next.upcoming.push(item);else next.upcoming[index]=item;
      await saveState(next,index<0?'添加近期支出计划':'更新近期支出计划');closeDialog();return toast('支出计划已保存');
    }
    if(formId==='background-form'){
      const next=structuredClone(data.state);next.profile.background={...Object.fromEntries(f)};
      for(const key of ['dependents','incomeFloor','retirementYears','comfortableLoss'])next.profile.background[key]=numberValue(f,key);
      await saveState(next,'更新个人背景',formId);return toast('个人背景已保存');
    }
    if(formId==='chat-form'){const message=f.get('message').trim();if(message)await sendQuestion(message);return;}
    if(formId==='ai-form'){
      const result=await api('/config',{method:'PUT',body:{...Object.fromEntries(f),requestTimeoutSeconds:numberValue(f,'requestTimeoutSeconds'),consent:f.has('consent'),includeHoldings:f.has('includeHoldings'),includePageData:f.has('includePageData'),allowLedgerWrites:f.has('allowLedgerWrites'),includeHistory:f.has('includeHistory'),useTools:f.has('useTools'),autoReport:f.has('autoReport'),marketBriefsAI:f.has('marketBriefsAI'),clearKey:f.has('clearKey')}});
      const sameScope=data.config.scopeId===result.config.scopeId,chatResult=sameScope?await preserveChatView(result):result;
      if(!sameScope){chatDrafts.set(data.conversation?.id||'',chatDraft);chatDraft=chatDrafts.get(chatResult.conversation?.id||'')||'';}
      chatViewEpoch++;applyChatData(chatResult,true);chatError='';formDrafts.delete(formId);
      if(event.submitter?.value==='test'){
        try{const test=await api('/config/test',{method:'POST',body:{}});data.config=test.config;toast(test.message);}
        finally{render();}
      }else{render();toast('AI 设置已保存，连接状态见上方');}
      return;
    }
    if(formId==='rules-form'){
      const next=structuredClone(data.state);for(const k of ['stockCaution','stockLimit','debtRatioLimit','issuerLimit','buyTranchePercent','staleDays'])next.policy[k]=numberValue(f,k);next.policy.grid={enabled:f.has('gridEnabled'),stepPercent:numberValue(f,'gridStep'),tranches:numberValue(f,'gridTranches'),perStockBudgetCNY:numberValue(f,'gridBudget')};
      next.preferences.timeZone=f.get('timeZone');next.preferences.reportTime=f.get('reportTime');next.preferences.autoFx=f.has('autoFx');next.preferences.rates={CNY:1};
      for(const pair of f.get('rates').split(/[,，]/).map(x=>x.trim()).filter(Boolean)){const [code,rate]=pair.split('=');if(!code||!rate)throw new Error('汇率格式示例：USD=7.1, HKD=0.91');next.preferences.rates[code.trim().toUpperCase()]=Number(rate.trim());}
      await saveState(next,'修改投资纪律与日报偏好',formId);return toast('纪律与偏好已保存');
    }
    if(formId==='reset-form'){
      data=await api('/reset',{method:'POST',body:{revision:data.state.revision,confirmation:f.get('confirmation')}});closeDialog();formDrafts.clear();assetQuery='';assetFilter='all';stockMarketFilter='all';chatDraft='';chatError='';routeTo('dashboard');return toast('已清空档案，可以开始记录你的财务');
    }
  }catch(e){if(formId==='auth-form')$('#auth-error').textContent=e.message;else toast(e.message);}
  finally{submits.forEach(button=>{if(button.isConnected)button.disabled=false;});}
});
$('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog')){const r=$('#dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
window.addEventListener('hashchange',()=>{render();window.scrollTo(0,0);});
async function start(){try{auth=await api('/auth/status');if(!auth.authenticated)return renderAuth();data=await api('/bootstrap');render();if(data.chatRun?.status==='running'){chatRunId=data.chatRun.id;chatRequestId=data.chatRun.requestId;void resumeChat();}if(data.marketBriefs?.latest.some(b=>b.ai?.status==='generating'))pollMarketBriefs();setInterval(async()=>{if(document.visibilityState==='hidden'||$('#dialog').open||chatBusy||document.activeElement?.matches('input,textarea,select'))return;if(currentMarket()){await loadMarket(currentMarket(),false,true);return;}if(!['dashboard','assets','reports'].includes(route))return;try{await refresh();}catch{}},60000);}catch(e){$('#app').innerHTML=`<div class="loading"><p>暂时无法打开财务空间</p><p style="font-size:12px;margin-top:12px">${esc(e.message)}</p><button class="btn btn-secondary" style="margin-top:18px" data-action="retry-start">重新连接</button></div>`;}}
start();
