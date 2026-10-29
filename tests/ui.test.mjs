import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { initialState,validateState,calculate,evaluate } from '../src/domain.mjs';
import { applyInvestmentInfo } from '../src/investments.mjs';
import { applyStockPrices } from '../src/market.mjs';
import { readEventStream } from '../public/sse.js';
import { marketPageHTML,marketBriefsHTML } from '../public/markets.js';

// Pure rendering/event tests over local source; no browser or running page access.
function componentHarness(fetch) {
  const nodes=new Map(),listeners={};
  const node=()=>({innerHTML:'',textContent:'',classList:{add(){},remove(){}},addEventListener(){},focus(){},showModal(){this.open=true;},close(){this.open=false;}});
  class Form {constructor(id,fields){this.actualId=id;this.id={name:'id'};this.fields=fields;} getAttribute(){return this.actualId;} querySelectorAll(){return [];} }
  const context=vm.createContext({document:{querySelector(selector){if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},addEventListener(name,handler){listeners[name]=handler;}},window:{addEventListener(){},scrollTo(){}},location:{hash:'#assistant'},HTMLFormElement:Form,FormData:class extends Map{constructor(form){super(form.fields);}},crypto:webcrypto,structuredClone,fetch,AbortController,readEventStream,marketPageHTML,marketBriefsHTML,setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\nstart\(\);\s*$/,''),context);
  const state=validateState(initialState());
  context.fixture={state,metrics:calculate(state),rules:evaluate(state),history:[],reports:[],messages:[],audit:[],config:{baseUrl:'',model:'',consent:false}};
  vm.runInContext('data=fixture;auth={authenticated:true,preview:true};',context);
  return {context,nodes,Form,listeners,run:code=>vm.runInContext(code,context)};
}
test('问 AI 页面区分真实连接状态，未配置不伪装连接成功，没有独立试算表单',()=>{
  const h=componentHarness();let html=h.run('assistantPage()');assert.match(html,/尚未配置 AI/);assert.ok(!html.includes('决定前试算'));assert.ok(!html.includes('scenario-form'));
  h.run("data.config={baseUrl:'https://example.com/v1',model:'example-model',consent:true};");html=h.run('assistantPage()');assert.match(html,/已配置，尚未验证/);assert.ok(!html.includes('模型文字连接已验证'));
  h.run('data.config.connection={ok:true,tools:true};');assert.match(h.run('assistantPage()'),/模型与计算工具已验证/);
});
test('私人助手称呼在页面与背景表单一致，保存后可修改或留空，文本安全转义',async()=>{
  let saved;
  const h=componentHarness(async(_url,options)=>{saved=validateState(JSON.parse(options.body).state);return {ok:true,json:async()=>({...h.context.fixture,state:saved})};});
  delete h.context.fixture.state.profile.background.displayName;
  assert.match(h.run('assistantPage()'),/你好/);assert.ok(!h.run('assistantPage()').includes('你好，'));
  assert.match(h.run('cashflowPage()'),/name="displayName"[^>]*value=""/);
  for(const displayName of ['JD','']) {
    await h.listeners.submit({target:new h.Form('background-form',Object.entries({displayName,scope:'personal',dependents:'0',incomeFloor:'',retirementYears:'',comfortableLoss:''})),preventDefault(){}});
    assert.equal(saved.profile.background.displayName,displayName);assert.equal(saved.profile.background.dependents,0);
  }
  assert.ok(!h.run('assistantPage()').includes('你好，'));
  h.run("data.state.profile.background.displayName='<img src=x onerror=alert(1)>';");
  assert.ok(!h.run('assistantPage()').includes('<img src=x'));assert.match(h.run('assistantPage()'),/&lt;img/);
});
test('保险估值允许留空，表单编号同名字段不阻断实际保存，保费字段进入账本',async()=>{
  let received;const h=componentHarness(async(url,options)=>{received={url,body:JSON.parse(options.body)};return {ok:true,json:async()=>({...h.context.fixture,state:received.body.state,metrics:calculate(received.body.state),rules:evaluate(received.body.state)})};});
  h.run("data.state.assets=[{id:'policy',name:'保单',type:'insurance',currency:'CNY',value:null,asOf:'2026-10-23',inPool:false,insurance:{premiumFrequency:'yearly'}}];assetDialog('policy');");
  const dialog=h.nodes.get('#dialog').innerHTML;assert.ok(!dialog.match(/<input name="value"[^>]*required/));assert.match(dialog,/name="sumAssured"/);
  const form=new h.Form('asset-form',Object.entries({id:'policy',name:'保单',type:'insurance',currency:'CNY',value:'',asOf:'2026-10-23',account:'',insuranceKind:'savings',valuationBasis:'cash_value',sumAssured:'1000000',paidPremiums:'60000',premiumAmount:'12000',premiumFrequency:'yearly',nextPremiumDate:'2026-11-01'}));
  await h.listeners.submit({target:form,preventDefault(){}});
  assert.equal(received.url,'/api/state');assert.equal(received.body.state.assets[0].value,null);assert.equal(received.body.state.assets[0].insurance.premiumAmount,12000);assert.equal(received.body.state.assets[0].insurance.premiumInExpenses,false);
});
test('模型失败保留问题草稿与错误，不向聊天插入替代的助手回复',async()=>{
  const h=componentHarness(async()=>({ok:false,status:502,json:async()=>({error:'模型连接失败'})}));
  h.run("data.config={baseUrl:'https://example.com/v1',model:'model',consent:true};");
  await h.run("sendQuestion('我想贷款买车')");
  assert.equal(h.run('chatDraft'),'我想贷款买车');assert.equal(h.run('data.messages.length'),0);assert.equal(h.run('chatBusy'),false);assert.match(h.run('assistantPage()'),/模型连接失败/);
});

test('AI 设置提供响应等待时间，并将生成超时和连接失败分开显示',()=>{
  const h=componentHarness();h.run("data.config={baseUrl:'https://example.com/v1',model:'model',consent:true,requestTimeoutSeconds:180,connection:{ok:false,code:'AI_TIMEOUT',message:'等待模型响应超过 180 秒'}};");
  assert.match(h.run('aiSettings()'),/name="requestTimeoutSeconds"[^>]*value="180"/);assert.match(h.run('assistantPage()'),/上次生成超时/);
  h.run("data.config.connection.code='AI_DNS';");assert.match(h.run('assistantPage()'),/上次连接失败/);
});

test('完整页面授权在设置中可见并保存，工具参数与返回数据可展开且安全转义',async()=>{
  let saved;const h=componentHarness(async(_url,options)=>{saved=JSON.parse(options.body);return Response.json({config:{...saved,scopeId:'new-scope'}});});
  h.run("data.config={baseUrl:'https://example.com',model:'synthetic',consent:true,includePageData:true};");
  assert.match(h.run('aiSettings()'),/name="includePageData" checked/);assert.match(h.run('assistantPage()'),/页面资料已接通/);
  await h.listeners.submit({target:new h.Form('ai-form',[['baseUrl','https://example.com'],['model','synthetic'],['consent','on'],['includePageData','on'],['useTools','on'],['requestTimeoutSeconds','180']]),preventDefault(){}});
  assert.equal(saved.includePageData,true);
  h.context.trace={id:'tool-test',name:'get_page_data',label:'读取页面资料',status:'complete',args:{page:'assets'},output:{name:'<img src=x onerror=alert(1)>',value:12345}};
  const html=h.run("messageHTML({role:'assistant',content:'已读取',metadata:{toolCalls:[trace]}})");
  assert.match(html,/调用参数/);assert.match(html,/返回数据/);assert.match(html,/12345/);assert.match(html,/get_page_data/);assert.ok(!html.includes('<img src=x'));assert.match(html,/&lt;img/);
});

test('流式工具调用即时展示状态与结果，完成后从历史恢复，展开状态跨文字增量保留',async()=>{
  let controller;const body=new ReadableStream({start(c){controller=c;}});
  const h=componentHarness(async()=>new Response(body));h.run("data.config={baseUrl:'https://example.com',model:'synthetic',consent:true};");
  const sending=h.run("sendQuestion('读取页面资料')");await new Promise(r=>setImmediate(r));
  const send=(event,data)=>controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const call={id:'visible-read',name:'get_page_data',label:'读取页面资料',args:{page:'assets'},status:'running'};
  send('tool',{call});await new Promise(r=>setImmediate(r));assert.match(h.nodes.get('#live-answer').innerHTML,/正在执行/);
  h.listeners.toggle({target:{dataset:{toolId:call.id},open:true}});
  call.status='complete';call.output={data:[{name:'测试资产',value:125}]};send('tool',{call});send('delta',{text:'已读取'});await new Promise(r=>setImmediate(r));
  const live=h.nodes.get('#live-answer').innerHTML;assert.match(live,/测试资产/);assert.match(live,/已完成/);assert.match(live,/data-tool-id="visible-read" open/);
  send('done',{messages:[{role:'user',content:'读取页面资料'},{role:'assistant',content:'已读取',metadata:{toolCalls:[call]}}]});controller.close();await sending;
  assert.equal(h.run('chatToolCalls.length'),0);assert.match(h.run('assistantPage()'),/测试资产/);
});

test('工具默认只显示一条紧凑提示，待入账可核对或取消，完成事件同步更新页面数据',()=>{
  const h=componentHarness();h.context.calls=[{id:'one',name:'get_page_data',status:'complete',args:{page:'assets'},output:{value:1}},{id:'two',name:'record_holding_change',status:'complete',args:{},output:{status:'pending'}}];
  const html=h.run('toolCallsHTML(calls)');assert.match(html,/class="chat-tool-summary"/);assert.match(html,/有待确认或入账的事项/);assert.ok(!html.match(/class="chat-tool-summary"[^>]*\bopen\b/));
  h.run("data.ledgerEntries=[{id:'queued',kind:'holding',label:'对话记账 · 加仓 · 科创',status:'pending',date:'2026-10-29',amount:1000,asset:{currency:'CNY'},cashSource:'outside'}];");
  const records=h.run('ledgerEntriesHTML()');assert.match(records,/待入账/);assert.match(records,/额外投入/);assert.match(records,/cancel-ledger-entry/);
  h.context.update={state:{...h.context.fixture.state,revision:9},ledgerEntries:[{status:'applied'}]};h.run('applyChatData(update)');assert.equal(h.run('data.state.revision'),9);assert.equal(h.run('data.ledgerEntries[0].status'),'applied');
});

test('investment settings display and save the issuer cap and portfolio purchase percentage together',async()=>{
  let received;const h=componentHarness(async(_url,options)=>{received=JSON.parse(options.body);return {ok:true,json:async()=>({...h.context.fixture,state:received.state,metrics:calculate(received.state),rules:evaluate(received.state)})};});
  h.run('data.state.policy.issuerLimit=30;data.state.policy.buyTranchePercent=1;');
  const html=h.run('ruleSettings()');assert.match(html,/name="buyTranchePercent"[^>]*value="1"/);
  const form=new h.Form('rules-form',Object.entries({stockCaution:'50',stockLimit:'75',debtRatioLimit:'',issuerLimit:'30',buyTranchePercent:'1',staleDays:'7',gridEnabled:'on',gridStep:'5',gridTranches:'4',gridBudget:'',reportTime:'20:00',timeZone:'Asia/Shanghai',rates:'HKD=0.91'}));
  await h.listeners.submit({target:form,preventDefault(){}});
  const state=validateState(received.state);assert.equal(state.policy.issuerLimit,30);assert.equal(state.policy.buyTranchePercent,1);
});

test('本地问答和日报显示纯文本，星号格式不会出现在助手回复中',()=>{
  const h=componentHarness();
  assert.equal(h.run("adviceText('**保留** -500.25 元')"),'保留 -500.25 元');
  assert.equal(h.run("adviceText('2 * 3')"),'2 × 3');
  assert.ok(!h.run("messageHTML({role:'assistant',content:'**建议谨慎**',metadata:{}})").includes('**'));
  assert.ok(h.run("messageHTML({role:'user',content:'**用户原文**'})").includes('**用户原文**'));
});

test('本地资产表单按类型显示字段，自动基金保持份额、代码和原始累计记录',async()=>{
  let received;const h=componentHarness(async(url,options)=>{received=JSON.parse(options.body);return {ok:true,json:async()=>({...h.context.fixture,state:received.state,metrics:calculate(received.state),rules:evaluate(received.state)})};});
  h.run("assetDialog();");let html=h.nodes.get('#dialog').innerHTML;assert.ok(!html.includes('name=\"unit\"'));assert.ok(!html.includes('盎司'));
  h.run("data.state.assets=[{id:'f',name:'Synthetic fund',type:'fund',currency:'CNY',value:250,asOf:'2026-10-23',quantity:100,unit:'份',fund:{code:'123456',autoNav:true},reported:{date:'2026-10-23',value:250,totalReturn:20,dividends:10}}];assetDialog('f');");
  html=h.nodes.get('#dialog').innerHTML;assert.match(html,/持有数量 \/ 份/);assert.ok(!html.includes('盎司'));assert.match(html,/name="fundCode"/);
  const form=new h.Form('asset-form',Object.entries({id:'f',name:'Synthetic fund',type:'fund',currency:'CNY',value:'250',asOf:'2026-10-23',quantity:'100',unit:'份',fundCode:'123456',autoNav:'on',account:''}));
  await h.listeners.submit({target:form,preventDefault(){}});assert.equal(received.state.assets[0].fund.autoNav,true);assert.equal(received.state.assets[0].reported.dividends,10);
});

test('本地日变化在没有昨日基线时显示首日记录，并标明基金单位净值日期',()=>{
  const h=componentHarness();h.run("data.valuation={delta:null,baseline:null,funds:{amount:10,date:'2026-10-23',scope:'按当前份额估算'}};");const html=h.run('dashboard()');assert.match(html,/首日记录/);assert.match(html,/基金净值日变动/);assert.match(html,/按当前份额估算/);assert.match(html,/10-23/);
});

test('股票和基金涨跌用带正负号的颜色区分，未取得行情时不显示假 0%',()=>{
  const h=componentHarness();let html=h.run("movementHTML({id:'up',type:'fund',movement:{change:.1,percent:10,amount:20,date:'2026-10-23',currency:'CNY'},valuation:{status:'nav'}})");assert.match(html,/price-up/);assert.match(html,/\+10\.00%/);assert.match(html,/\+20\.00 CNY/);
  html=h.run("movementHTML({id:'down',type:'stock',movement:{change:-.1,percent:-1,amount:-10,date:'2026-10-23',currency:'HKD'},valuation:{status:'quote'}})");assert.match(html,/price-down/);assert.match(html,/−1\.00%/);
  html=h.run("movementHTML({id:'missing',type:'stock',autoPrice:true})");assert.match(html,/等待行情/);assert.ok(!html.includes('0.00%'));
});

test('股票名称搜索可以返回中国平安 A/H 两个代码，并明确市场和币种',async()=>{
  let called;const h=componentHarness(async url=>{called=url;return {ok:true,json:async()=>({items:[{name:'中国平安',market:'SH',symbol:'601318',key:'SH.601318',currency:'CNY'},{name:'中国平安',market:'HK',symbol:'02318',key:'HK.02318',currency:'HKD'}]})};});
  h.nodes.set('#asset-form',new h.Form('asset-form',Object.entries({id:'',name:'中国平安',stockMarket:'ALL'})));
  await h.run('findStock()');const html=h.nodes.get('[data-stock-results]').innerHTML;
  assert.match(called,/market=ALL/);assert.match(html,/SH\.601318/);assert.match(html,/HK\.02318/);assert.match(html,/CNY/);assert.match(html,/HKD/);
});

test('自动股票保存的是市场和股数，尚未获取行情时不要求手填总价',async()=>{
  let received;const h=componentHarness(async(url,options)=>{received=JSON.parse(options.body);return {ok:true,json:async()=>({...h.context.fixture,state:received.state,metrics:calculate(received.state),rules:evaluate(received.state)})};});
  h.run("assetDialog(undefined,{type:'stock',name:'Synthetic stock',currency:'HKD',asOf:'2026-10-23',security:{market:'HK',symbol:'01234',key:'HK.01234'},autoPrice:true});");const html=h.nodes.get('#dialog').innerHTML;assert.match(html,/name="value" value=""/);assert.match(html,/持有数量 \/ 股/);
  await h.listeners.submit({target:new h.Form('asset-form',Object.entries({name:'Synthetic stock',type:'stock',currency:'HKD',value:'',quantity:'100',unit:'股',asOf:'2026-10-23',stockMarket:'HK',stockSymbol:'01234',autoPrice:'on'})),preventDefault(){}});
  assert.equal(received.state.assets[0].autoPrice,true);assert.equal(received.state.assets[0].security.market,'HK');assert.equal(received.state.assets[0].quantity,100);assert.equal(received.state.assets[0].value,null);
});

test('记录资产不要求日期，日期只在选填补充项内显示，代码份额可直接保存',()=>{
 const h=componentHarness();h.run('assetDialog();');let html=h.nodes.get('#dialog').innerHTML;assert.match(html,/补充信息（选填）/);assert.ok(!html.match(/name="asOf"[^>]*required/));
 h.run("assetDialog(undefined,{type:'fund',name:'Synthetic',currency:'CNY',fund:{code:'123456',autoNav:true}});");html=h.nodes.get('#dialog').innerHTML;assert.match(html,/type="hidden" name="asOf"/);assert.match(html,/成本与盈亏（选填）/);
});
test('成本和当前盈亏两种输入得到相同持仓成本，平均成本不依赖买入日期',()=>{
 const h=componentHarness();h.run("costAsset={id:'x',type:'fund',fund:{code:'123456',autoNav:true},quantity:100,currency:'CNY',value:150};");
 h.context.costForm=new Map([['costMode','cost'],['costAmount','100']]);assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),100);
 h.context.costForm=new Map([['costMode','pnl'],['costAmount','50'],['costReferenceValue','150']]);assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),100);
 h.context.costForm=new Map([['costMode','pnl'],['costAmount','-50'],['costReferenceValue','150']]);assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),200);
 h.context.costForm=new Map([['costMode','pnl'],['costAmount','200'],['costReferenceValue','150']]);assert.throws(()=>h.run('readCostBasis(costForm,costAsset)'),/成本小于零/);
 h.context.costForm=new Map([['costMode','average'],['costAmount','1']]);assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),100);
 h.context.costForm=new Map([['costMode','return'],['costAmount','50'],['costReferenceValue','150']]);assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),100);
 h.context.costForm=new Map([['costMode','pnl'],['costAmount','-2727.13'],['costReferenceValue','20089.48']]);assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),22816.61);
 for(const entry of ['-100','-101']){h.context.costForm=new Map([['costMode','return'],['costAmount',entry],['costReferenceValue','150']]);assert.throws(()=>h.run('readCostBasis(costForm,costAsset)'),/必须大于 -100/);}
});

test('股票默认填写每股成本，编辑已有总成本时换算为均价且保留小数精度',()=>{
 const h=componentHarness();
 h.run("assetDialog(undefined,{type:'stock',currency:'HKD'});");let html=h.nodes.get('#dialog').innerHTML;
 assert.match(html,/<option value="average" selected>每股成本<\/option>/);assert.match(html,/每股成本（HKD \/ 股）/);assert.match(html,/总成本 = 每股成本 × 持有股数/);
 h.run("assetDialog(undefined,{type:'stock',currency:'CNY',quantity:200,costBasis:{amount:14624.94,quantity:200,currency:'CNY'}});");
 html=h.nodes.get('#dialog').innerHTML;assert.match(html,/name="costAmount" type="number" value="73.1247"/);
 h.run("assetDialog(undefined,{type:'fund',currency:'CNY'});");assert.match(h.nodes.get('#dialog').innerHTML,/<option value="average" selected>平均单位成本<\/option>/);
});

test('每股成本保存为股数乘均价，行情低于均价时显示亏损，重新编辑保存保持总成本',async()=>{
 let received;const h=componentHarness(async(url,options)=>{
   received=JSON.parse(options.body);
   const state=applyInvestmentInfo(applyStockPrices(validateState(received.state),key=>key==='stock_quote:HK.01234'?{key:'HK.01234',price:480,previous:{price:485},currency:'HKD',date:'2026-10-23'}:null));
   return {ok:true,json:async()=>({...h.context.fixture,state,metrics:calculate(state),rules:evaluate(state)})};
 });
 const fields={name:'Synthetic stock',type:'stock',currency:'HKD',value:'',quantity:'80',unit:'股',stockMarket:'HK',stockSymbol:'01234',autoPrice:'on',costMode:'average',costAmount:'500'};
 await h.listeners.submit({target:new h.Form('asset-form',Object.entries(fields)),preventDefault(){}});
 assert.equal(received.state.assets[0].costBasis.amount,40000);assert.equal(h.run('data.state.assets[0].investment.profit'),-1600);assert.equal(h.run('data.state.assets[0].investment.returnPercent'),-4);
 const html=h.run('investmentHTML(data.state.assets[0])');assert.match(html,/price-down/);assert.match(html,/−1,600\.00 HKD/);
 h.run('assetDialog(data.state.assets[0].id);');assert.match(h.nodes.get('#dialog').innerHTML,/name="costAmount" type="number" value="500"/);
 const id=h.run('data.state.assets[0].id');
 await h.listeners.submit({target:new h.Form('asset-form',Object.entries({...fields,id})),preventDefault(){}});
 assert.equal(received.state.assets.length,1);assert.equal(received.state.assets[0].costBasis.amount,40000);
});

test('每股成本必须对应有效股数，总成本入口仍按整笔金额处理',()=>{
 const h=componentHarness();h.context.costForm=new Map([['costMode','average'],['costAmount','73.1247']]);
 h.run("costAsset={type:'stock',quantity:200,currency:'CNY'};");assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),14624.94);
 for(const quantity of [null,0,-1,NaN]){h.context.costAsset.quantity=quantity;assert.throws(()=>h.run('readCostBasis(costForm,costAsset)'),/持有股数/);}
 h.context.costAsset.quantity=200;h.context.costForm.set('costAmount','-1');assert.throws(()=>h.run('readCostBasis(costForm,costAsset)'),/每股成本/);
 h.context.costForm=new Map([['costMode','cost'],['costAmount','1000']]);assert.equal(h.run('readCostBasis(costForm,costAsset).amount'),1000);
});

test('聊天先显示思考动画，SSE 到达即显示纯文本，完成前不加入历史',async()=>{
 let controller;const body=new ReadableStream({start(c){controller=c;}});
 const h=componentHarness(async(url,options)=>{assert.equal(url,'/api/chat/stream');assert.ok(options.signal);return new Response(body,{headers:{'Content-Type':'text/event-stream'}});});
 h.run("data.config={baseUrl:'https://example.com',model:'synthetic',consent:true};");
 const sending=h.run("sendQuestion('虚构测试问题')");await new Promise(r=>setImmediate(r));
 assert.match(h.nodes.get('#app').innerHTML,/正在思考/);assert.match(h.nodes.get('#app').innerHTML,/thinking-spinner/);assert.match(h.nodes.get('#app').innerHTML,/停止回答/);
 const send=(event,data)=>controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
 send('delta',{text:'**测试建议**'});await new Promise(r=>setImmediate(r));
 assert.equal(h.run('data.messages.length'),0);assert.match(h.nodes.get('#live-answer').innerHTML,/测试建议/);assert.ok(!h.nodes.get('#live-answer').innerHTML.includes('**'));
 send('done',{messages:[{role:'user',content:'虚构测试问题'},{role:'assistant',content:'**测试建议**'}],config:h.context.fixture.config});controller.close();await sending;
 assert.equal(h.run('data.messages.length'),2);assert.equal(h.run('chatBusy'),false);assert.equal(h.run('chatStreamText'),'');assert.equal(h.run('chatError'),'');
});

test('停止回答会取消请求并保留草稿和未完成文字，不把部分回答写进历史',async()=>{
 let controller;const body=new ReadableStream({start(c){controller=c;}});
 const h=componentHarness(async(url,{signal})=>{if(url==='/api/chat/stop')return Response.json({run:{status:'failed'}});signal.addEventListener('abort',()=>controller.error(new DOMException('Stopped','AbortError')),{once:true});return new Response(body);});
 h.run("data.config={baseUrl:'https://example.com',model:'synthetic',consent:true};");const sending=h.run("sendQuestion('停止测试')");await new Promise(r=>setImmediate(r));
 controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"部分回答"}\n\n'));await new Promise(r=>setImmediate(r));
 await h.listeners.click({target:{closest(){return {dataset:{action:'stop-chat'}};}}});await sending;
 assert.equal(h.run('data.messages.length'),0);assert.equal(h.run('chatDraft'),'停止测试');assert.equal(h.run('chatStreamText'),'部分回答');assert.match(h.run('chatError'),/已停止/);assert.match(h.run('assistantPage()'),/回答未完成/);
});

test('恢复持久回答通过 GET 连接原任务，替换已有片段，不重新提交问题',async()=>{
 const calls=[],messages=[{role:'user',content:'原问题'},{role:'assistant',content:'原片段，继续完成。'}];
 const h=componentHarness(async(url,options={})=>{
   calls.push({url,method:options.method||'GET'});
   if(url==='/api/chat/run')return Response.json({run:{id:'saved-run',requestId:'saved-request',question:'原问题',status:'running',text:'原片段',stage:'answering'},messages:[],config:{baseUrl:'https://example.com',model:'synthetic',consent:true}});
   assert.equal(url,'/api/chat/stream?run=saved-run');
   return new Response('event: run\ndata: {"id":"saved-run"}\n\nevent: reset\ndata: {}\n\nevent: delta\ndata: {"text":"原片段，继续完成。"}\n\nevent: done\ndata: '+JSON.stringify({messages,config:{baseUrl:'https://example.com',model:'synthetic',consent:true}})+'\n\n');
 });
 h.run("chatRunId='saved-run';chatRequestId='saved-request';");await h.run('resumeChat()');
 assert.ok(calls.every(c=>c.method==='GET'));assert.equal(h.run('data.messages.length'),2);assert.equal(h.run('data.messages[1].content'),'原片段，继续完成。');assert.equal(h.run('chatBusy'),false);assert.equal(h.run('chatDraft'),'');assert.equal(h.run('chatRunId'),'');
});

test('重连发现另一条问题时保留当前草稿，不误接别的回答',async()=>{
 let calls=0;const h=componentHarness(async()=>{calls++;return Response.json({run:{id:'other',requestId:'other-request',question:'旧问题',status:'running'},messages:[],config:{}});});
 h.run("chatRequestId='new-request';chatPendingMessage='新问题';chatBusy=true;");await h.run('resumeChat()');
 assert.equal(calls,1);assert.equal(h.run('chatDraft'),'新问题');assert.equal(h.run('chatBusy'),false);assert.match(h.run('chatError'),/尚未提交成功/);
});

test('删除对话后延迟抵达的旧流不能重新插入对话或恢复草稿',async()=>{
 let controller;const stream=new ReadableStream({start(c){controller=c;}});
 const h=componentHarness(async(url,options)=>url==='/api/chat'&&options.method==='DELETE'?Response.json({ok:true}):new Response(stream));
 h.run("data.config={baseUrl:'https://example.com',model:'synthetic',consent:true};");const sending=h.run("sendQuestion('删除前的问题')");await new Promise(r=>setImmediate(r));
 h.run("pending={action:'clear-chat'};");await h.listeners.click({target:{closest(){return {dataset:{action:'confirm-pending'}};}}});
 controller.enqueue(new TextEncoder().encode('event: done\ndata: {"messages":[{"role":"assistant","content":"不应再出现"}],"config":{}}\n\n'));controller.close();await sending;
 assert.equal(h.run('data.messages.length'),0);assert.equal(h.run('chatDraft'),'');assert.equal(h.run('chatStreamText'),'');assert.equal(h.run('chatBusy'),false);
});

test('净资产图表标记账本调整，缺失或不完整日期不连线，点选日期显示对应金额',async()=>{
 const h=componentHarness();h.run("location.hash='#dashboard';trendRange='30';data.valuation={day:'2026-10-25'};data.history=[{day:'2026-09-01',netWorth:999999,revision:0},{day:'2026-10-22',netWorth:1000,complete:true,revision:1},{day:'2026-10-23',netWorth:1100,complete:false,revision:1},{day:'2026-10-24',netWorth:1200,complete:true,revision:2},{day:'2026-10-25',netWorth:2000,complete:true,revision:3}];");
 let html=h.run('netWorthTrendHTML()');const lines=html.match(/<g class="trend-line">([\s\S]*?)<\/g>/)[1];
 assert.equal((lines.match(/<path/g)||[]).length,1);assert.match(lines,/stroke-dasharray/);assert.match(html,/账本有调整/);assert.ok(!html.includes('2026-09-01'));assert.match(html,/2026-10-23[^>]*估值不完整/);
 await h.listeners.click({target:{closest(){return {dataset:{action:'trend-point',day:'2026-10-24'}};}}});
 h.run("revealedAmounts.add('trend-net-worth');");html=h.run('netWorthTrendHTML()');assert.match(html,/private-amount-value">¥ 1,200\.00<\/span>/);assert.match(html,/<span>2026-10-24<\/span>/);assert.ok(!h.run('dashboard()').includes('有个想法，问问 AI'));
});
test('净资产走势图不填造缺失日期，也能显示负值、单日记录和空账本',()=>{
 const h=componentHarness();h.run("data.valuation={day:'2026-10-25'};");assert.ok(!h.run('netWorthTrendHTML()').includes('<svg'));
 h.run("data.history=[{day:'2026-10-23',netWorth:-100,complete:true},{day:'2026-10-25',netWorth:0,complete:true}];");
 let html=h.run('netWorthTrendHTML()');assert.match(html,/<g class="trend-line"><\/g>/);assert.ok(!html.includes('2026-10-24'));assert.ok(!/NaN|Infinity/.test(html));
 h.run("data.history=[{day:'2026-10-25',netWorth:100,complete:false}];");html=h.run('netWorthTrendHTML()');assert.match(html,/已记录 1 天/);assert.match(html,/部分估值/);assert.ok(!/NaN|Infinity/.test(html));
});

test('近期资产窗口排除调整前的大幅差异，小额波动使用局部刻度，切换全貌保留全部记录',async()=>{
 const h=componentHarness();h.run("location.hash='#dashboard';data.valuation={day:'2026-10-28'};data.history=[{day:'2026-10-24',netWorth:400000,revision:1},{day:'2026-10-25',netWorth:700000,revision:2},{day:'2026-10-26',netWorth:700100,revision:2},{day:'2026-10-27',netWorth:700050,revision:2},{day:'2026-10-28',netWorth:700150,revision:2}];");
 let html=h.run('netWorthTrendHTML()');assert.match(html,/最近账本调整后 · 2026-10-25 起/);assert.ok(!html.includes('data-day="2026-10-24"'));assert.match(html,/局部刻度/);
 const y=[...html.matchAll(/class="trend-dot[^>]*style="left:[^;]+;top:([\d.]+)%/g)].map(m=>Number(m[1]));assert.ok(Math.max(...y)-Math.min(...y)>70);assert.ok(!/NaN|Infinity/.test(html));
 await h.listeners.click({target:{closest(){return {dataset:{action:'trend-range',range:'30'}};}}});html=h.run('netWorthTrendHTML()');assert.match(html,/data-day="2026-10-24"/);assert.match(html,/stroke-dasharray/);
 await h.listeners.click({target:{closest(){return {dataset:{action:'trend-range',range:'7'}};}}});assert.equal(h.run('trendRange'),'7');
});

test('reports render shared market summaries safely, and grid settings round-trip through the existing save form',async()=>{
 let received;const h=componentHarness(async(_url,options)=>{received=JSON.parse(options.body);return {ok:true,json:async()=>({...h.context.fixture,state:received.state})};});
 h.run("data.marketBriefs={latest:[{market:'US',date:'2026-10-23',facts:{headline:'备用',publicLines:[]},ai:{status:'complete',scope:'market_only',summary:{headline:'美股简报',points:['<script>alert(1)</script>']}}}]};");const html=h.run('reportsPage()');assert.match(html,/美股每日简报/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>'));
 assert.match(h.run('ruleSettings()'),/无股息股票也适用/);
 await h.listeners.submit({target:new h.Form('rules-form',Object.entries({stockCaution:'50',stockLimit:'75',debtRatioLimit:'',issuerLimit:'',staleDays:'7',reportTime:'20:00',timeZone:'Asia/Shanghai',rates:'USD=7, HKD=1',autoFx:'on',gridEnabled:'on',gridStep:'6',gridTranches:'4',gridBudget:'20000'})),preventDefault(){}});assert.equal(received.state.policy.grid.stepPercent,6);assert.equal(received.state.policy.grid.perStockBudgetCNY,20000);assert.equal(received.state.policy.stockLimit,75);
});

test('market brief fallback and legacy summaries do not expose private positions or personal profit',()=>{const h=componentHarness();h.run("data.marketBriefs={latest:[{market:'US',date:'2026-10-23',facts:{headline:'指数上涨',publicLines:['标普上涨'],personalLine:'PRIVATE PERSONAL PROFIT'},ai:{status:'complete',includeHoldings:true,summary:{headline:'PRIVATE OLD SUMMARY',points:['PRIVATE HOLDING']}}}]};");const html=h.run('reportsPage()');assert.ok(!html.includes('PRIVATE'));assert.match(html,/标普上涨/);});

test('资产搜索覆盖名称、账户与证券代码，分类可与搜索组合，空结果不会伪装成空账本',()=>{
 const h=componentHarness();h.run(`data.state.assets=[
  {id:'s',name:'Alphabet',account:'海外账户',type:'stock',currency:'USD',value:100,security:{key:'US.GOOG',symbol:'GOOG'}},
  {id:'f',name:'指数联接',account:'长期账户',type:'fund',currency:'CNY',value:200,fund:{code:'123456'}},
  {id:'b',name:'国债',type:'bond',currency:'CNY',value:300}];`);
 for(const query of ['alphabet','goog','海外账户']){h.context.searchQuery=query;h.run('assetQuery=searchQuery;');assert.equal(h.run('filteredAssets()[0].id'),'s');}
 h.run("assetQuery='123456';");assert.equal(h.run('filteredAssets()[0].id'),'f');
 h.run("assetFilter='bond';assetQuery='';");assert.equal(h.run('filteredAssets()[0].id'),'b');
 h.run("assetQuery='not found';");assert.equal(h.run('filteredAssets().length'),0);
 const html=h.run('assetsPage()');assert.match(html,/没有匹配的资产/);assert.match(html,/清除筛选/);assert.ok(!html.includes('添加第一项资产'));
 h.run(`assetQuery='<img src=x onerror=alert(1)>';`);assert.ok(!h.run('assetsPage()').includes('value="<img'));
});

test('编辑支出计划保留编号及其他计划，新增与编辑共用表单，失效编号不会新增副本',async()=>{
 let received;const h=componentHarness(async(_url,options)=>{received=JSON.parse(options.body);return {ok:true,json:async()=>({...h.context.fixture,state:received.state})};});
 h.run("data.state.upcoming=[{id:'one',name:'学费',amount:3000,date:'2026-11-01'},{id:'two',name:'家电',amount:2000,date:'2026-12-01'}];upcomingDialog('one');");
 assert.match(h.nodes.get('#dialog').innerHTML,/编辑支出计划/);assert.match(h.nodes.get('#dialog').innerHTML,/name="id" value="one"/);
 await h.listeners.submit({target:new h.Form('upcoming-form',Object.entries({id:'one',name:'学费调整',amount:'4000',date:'2026-11-10'})),preventDefault(){}});
 assert.equal(received.state.upcoming.length,2);assert.deepEqual(received.state.upcoming[0],{id:'one',name:'学费调整',amount:4000,date:'2026-11-10'});assert.equal(received.state.upcoming[1].amount,2000);
 await h.listeners.submit({target:new h.Form('upcoming-form',Object.entries({id:'',name:'新增计划',amount:'100',date:'2026-11-12'})),preventDefault(){}});
 assert.equal(received.state.upcoming.length,3);
 const before=received;await h.listeners.submit({target:new h.Form('upcoming-form',Object.entries({id:'missing',name:'失效',amount:'100',date:'2026-11-12'})),preventDefault(){}});
 assert.equal(received,before);assert.match(h.nodes.get('#toast').textContent,/已不存在/);
});

test('页面草稿能恢复输入，保存一张表单只清除它自己的草稿，失败时仍保留',async()=>{
 let fail=false;const h=componentHarness(async(_url,options)=>fail?{ok:false,status:400,json:async()=>({error:'模拟保存失败'})}:{ok:true,json:async()=>({...h.context.fixture,state:JSON.parse(options.body).state})});
 const notice={hidden:true},input={name:'income',type:'number',value:'32100'},form={getAttribute:()=> 'profile-form',querySelector:()=>notice,querySelectorAll:()=>[input]};input.form=form;
 h.context.inputEvent={target:input};h.run('rememberFormDraft(inputEvent);');assert.equal(notice.hidden,false);assert.equal(h.run("formDrafts.get('profile-form').get('income').value"),'32100');
 input.value='';h.nodes.set('#profile-form',form);h.run('restoreFormDrafts();');assert.equal(input.value,'32100');
 h.run("formDrafts.set('background-form',new Map([['priorities',{value:'保留的目标草稿'}]]));");h.nodes.set('#background-form',{querySelectorAll:()=>[]});
 await h.listeners.submit({target:new h.Form('profile-form',Object.entries({income:'32100',expenses:'10000',payday:'10',emergencyMonths:'6',incomeStability:'stable'})),preventDefault(){}});
 assert.equal(h.run("formDrafts.has('profile-form')"),false);assert.equal(h.run("formDrafts.has('background-form')"),true);
 fail=true;h.run("formDrafts.set('profile-form',new Map([['income',{value:'999'}]]));");
 await h.listeners.submit({target:new h.Form('profile-form',Object.entries({income:'999',expenses:'100',payday:'10',emergencyMonths:'6',incomeStability:'stable'})),preventDefault(){}});
 assert.equal(h.run("formDrafts.get('profile-form').get('income').value"),'999');
});

test('仅当天且账本版本已变化的日报显示过期提示，生成时禁用重复入口',()=>{
 const h=componentHarness();h.run("data.state.revision=2;data.reports=[{day:today(),generatedAt:new Date().toISOString(),revision:1,metrics:data.metrics,rules:[],changes:null}];");
 assert.match(h.run('reportsPage()'),/账本已更新/);assert.match(h.run('reportsPage()'),/账本版本 1/);
 h.run('reportBusy=true;');assert.match(h.run('reportsPage()'),/正在生成…/);assert.match(h.run('reportsPage()'),/disabled aria-busy="true"/);
 h.run("reportBusy=false;data.reports[0].revision=2;");assert.ok(!h.run('reportsPage()').includes('账本已更新'));
 h.run("data.reports[0].revision=1;data.reports[0].day='2020-01-01';");assert.ok(!h.run('reportsPage()').includes('账本已更新'));
});

test('行情请求失败后保留缓存，显示持续错误和重试入口',async()=>{
 const h=componentHarness(async url=>url.startsWith('/api/markets?')?{ok:true,json:async()=>({market:'US',date:'2026-10-23',benchmarks:[],sectors:[],holdings:[],portfolio:{amount:null,total:0,covered:0}})}:{ok:false,status:503,json:async()=>({error:'模拟网络不可用'})});
 h.run("location.hash='#dashboard';");await h.run("loadMarket('US')");
 assert.equal(h.run('marketViews.US.date'),'2026-10-23');assert.match(h.run('marketErrors.US'),/网络不可用/);assert.equal(h.run('marketBusy.US'),false);
 await h.run("loadMarket('US',false,true)");assert.match(h.run('marketErrors.US'),/网络不可用/);
 const html=h.run("marketPage('US')");assert.match(html,/保留上次数据/);assert.match(html,/重试/);assert.match(html,/role="alert"/);
});

test('每只股票占比按全部直接股票的人民币估值计算，包含池外股票，排除基金和现金',()=>{
 const h=componentHarness();h.run(`data.state.preferences.rates={CNY:1,HKD:.9,USD:7};data.state.assets=[
  {id:'cn',name:'人民币股票',type:'stock',currency:'CNY',value:1000,inPool:true,costBasis:{amount:99999}},
  {id:'hk',name:'港币股票',type:'stock',currency:'HKD',value:1000,inPool:true},
  {id:'us',name:'美元股票',type:'stock',currency:'USD',value:100,inPool:false},
  {id:'fund',name:'基金',type:'fund',currency:'CNY',value:100000,equityRatio:100},
  {id:'cash',name:'现金',type:'cash',currency:'CNY',value:100000}];`);
 const before=h.run('JSON.stringify(data.state)');assert.equal(h.run('stockAllocation().total'),2600);assert.equal(h.run('stockAllocation().count'),3);
 assert.ok(Math.abs(h.run("stockAllocation().weights.get('hk')")-900/2600*100)<1e-10);
 assert.ok(Math.abs(h.run('[...stockAllocation().weights.values()].reduce((a,b)=>a+b,0)')-100)<1e-10);
 h.run("assetFilter='stock';assetQuery='港币';revealedAmounts.add('assets-stock-total');");const html=h.run('assetsPage()');assert.match(html,/占股票组合/);assert.match(html,/34\.62%/);assert.ok(!html.includes('100.00%'));assert.match(html,/¥ 2,600\.00/);
 assert.equal(h.run('JSON.stringify(data.state)'),before);
});

test('股票占比缺估值或汇率时不按零补齐；真实零持仓、空组合和零总额不产生 NaN',()=>{
 const h=componentHarness();h.run("data.state.assets=[{id:'a',name:'A',type:'stock',currency:'CNY',value:100},{id:'b',name:'B',type:'stock',currency:'USD',value:100}];");
 assert.equal(h.run('stockAllocation().complete'),false);assert.equal(h.run('stockAllocation().total'),null);assert.equal(h.run("stockAllocation().weights.get('a')"),null);
 h.run("data.state.preferences.rates.USD=7;data.state.assets[1].value=null;");assert.equal(h.run('stockAllocation().complete'),false);
 h.run('data.state.assets[1].value=0;');assert.equal(h.run("stockAllocation().weights.get('a')"),100);assert.equal(h.run("stockAllocation().weights.get('b')"),0);assert.match(h.run("stockWeightHTML(data.state.assets[1],stockAllocation())"),/0\.00%/);
 h.run('data.state.assets[0].value=0;');assert.equal(h.run('stockAllocation().total'),0);assert.equal(h.run("stockAllocation().weights.get('a')"),null);assert.ok(!/NaN|Infinity/.test(h.run('assetsPage()')));
 h.run('data.state.assets=[];');assert.equal(h.run('stockAllocation().count'),0);assert.ok(!/NaN|Infinity/.test(h.run('assetsPage()')));
});

test('行情未同步但仍有已登记估值时标注暂按已有估值，紧凑表格也显示股内占比',()=>{
 const h=componentHarness();h.run("data.state.assets=[{id:'one',name:'暂存股票',type:'stock',currency:'CNY',value:100,autoPrice:true,valuation:{status:'pending'}}];");
 assert.equal(h.run('stockAllocation().estimated'),true);assert.equal(h.run('stockAllocation().total'),100);
 assert.match(h.run('assetsPage()'),/部分行情待更新，暂按已有估值/);assert.match(h.run('assetTable(data.state.assets,true)'),/占股票组合 100\.00%/);
});

test('基金组合占比按全部基金当前估值计算，币种统一，筛选不改变分母，默认按占比降序',()=>{
 const h=componentHarness();h.run(`data.state.preferences.rates={CNY:1,USD:7};data.state.assets=[
  {id:'small',name:'美元基金',type:'fund',currency:'USD',value:100,inPool:false,costBasis:{amount:99999}},
  {id:'large',name:'人民币基金',type:'fund',currency:'CNY',value:1300,inPool:true},
  {id:'stock',name:'股票',type:'stock',currency:'CNY',value:100000},
  {id:'cash',name:'现金',type:'cash',currency:'CNY',value:100000}];assetFilter='fund';`);
 const before=h.run('JSON.stringify(data.state)');assert.equal(h.run('fundAllocation().total'),2000);assert.equal(h.run('fundAllocation().count'),2);assert.equal(h.run("fundAllocation().weights.get('small')"),35);assert.equal(h.run("fundAllocation().weights.get('large')"),65);
 assert.equal(h.run('filteredAssets().map(a=>a.id).join()'),'large,small');
 h.run("assetQuery='美元';");let html=h.run('assetsPage()');assert.match(html,/占基金组合/);assert.match(html,/35\.00%/);assert.ok(!html.includes('100.00%'));assert.match(html,/基金估值合计已隐藏/);
 assert.match(h.run('assetTable(filteredAssets(),true)'),/占基金组合 35\.00%/);
 h.run("assetQuery='';assetFilter='all';");html=h.run('assetsPage()');assert.match(html,/组合内占比/);assert.match(html,/基金组合/);assert.match(html,/股票组合/);assert.equal(h.run('JSON.stringify(data.state)'),before);
});

test('基金组合缺失估值或汇率时等待补齐，净值待更新保留已有估值并说明，零组合不会产生假占比',()=>{
 const h=componentHarness();h.run("data.state.assets=[{id:'a',name:'A',type:'fund',currency:'CNY',value:100,fund:{autoNav:true},valuation:{status:'pending'}},{id:'b',name:'B',type:'fund',currency:'USD',value:100}];assetFilter='fund';");
 assert.equal(h.run('fundAllocation().complete'),false);assert.equal(h.run('fundAllocation().total'),null);assert.equal(h.run("fundAllocation().weights.get('a')"),null);assert.match(h.run('assetsPage()'),/待补齐/);
 h.run('data.state.preferences.rates.USD=7;data.state.assets[1].value=null;');assert.equal(h.run('fundAllocation().complete'),false);
 h.run('data.state.assets[1].value=0;');assert.equal(h.run('fundAllocation().estimated'),true);assert.equal(h.run("fundAllocation().weights.get('b')"),0);assert.match(h.run('assetsPage()'),/部分行情待更新，暂按已有估值/);
 h.run('data.state.assets[0].value=0;');assert.equal(h.run('fundAllocation().total'),0);assert.equal(h.run("fundAllocation().weights.get('a')"),null);assert.ok(!/NaN|Infinity/.test(h.run('assetsPage()')));
 h.run('data.state.assets=[];');assert.equal(h.run('fundAllocation().count'),0);assert.ok(!/NaN|Infinity/.test(h.run('assetsPage()')));
});

test('基金和股票历史展示真实价格点与日期间隔，点选只读取当日涨跌，不推断缺失数据',async()=>{
 const rows=[{date:'2026-10-23',price:1.1,currency:'CNY',previous:{price:1}},{date:'2026-10-20',price:1,currency:'CNY'}];
 const h=componentHarness(async()=>({ok:true,json:async()=>({items:rows})}));
 h.run("data.state.assets=[{id:'fund',name:'南方基金',type:'fund',currency:'CNY',quantity:100,fund:{code:'008164'},reported:{date:'2026-10-23',dividends:10}}];");
 await h.run("priceHistoryDialog('fund')");let html=h.nodes.get('#price-history-view').innerHTML;
 assert.match(html,/单位净值走势/);assert.match(html,/stroke-dasharray="4 5"/);assert.match(html,/\+10\.00%/);assert.match(html,/逐日明细/);assert.match(html,/已登记累计分红/);assert.ok(!html.includes('2026-10-21'));
 h.run("selectHistoryDate('2026-10-20')");html=h.nodes.get('#price-history-chart').innerHTML;assert.match(html,/2026-10-20/);assert.match(html,/class="muted">—/);assert.ok(!html.includes('+10.00%'));
 h.context.rows=rows;assert.match(h.run("priceHistoryChartHTML({type:'stock',currency:'CNY'},rows)"),/股价走势/);
});
test('历史图表处理空、单点与平价，不画虚构走势，不产生 NaN 或 Infinity',()=>{
 const h=componentHarness();
 assert.match(h.run("priceHistoryChartHTML({type:'stock',currency:'USD'},[])"),/暂无可绘制/);
 for(const rows of [[{date:'2026-10-23',price:1}], [{date:'2026-10-23',price:1},{date:'2026-10-22',price:1}]]) {
   h.context.rows=rows;const html=h.run("priceHistoryChartHTML({type:'stock',currency:'USD'},rows)");assert.ok(!/NaN|Infinity/.test(html));
   if(rows.length===1){assert.match(html,/只有 1 条/);assert.match(html,/<g class="trend-line"><\/g>/);}
 }
});
test('基础资料区分估值倍数、股息百分比、每股金额与缺失值，并保留缓存日期',()=>{
 const h=componentHarness();h.context.details={status:'cached',currency:'HKD',source:'Futu OpenD',time:'2026-10-23 16:08:00',timeZone:'Asia/Hong_Kong',message:'保留上次记录',metrics:{peTTM:-2,pe:0,dividendYieldTTM:1.2,dividendTTM:0,marketCap:3000000000}};
 const html=h.run("instrumentBasicsHTML({type:'stock',currency:'HKD',security:{key:'HK.00700'}},details)");
 assert.match(html,/−?\-2\.00 倍/);assert.match(html,/不适用/);assert.match(html,/1\.20%/);assert.match(html,/0\.0000 HKD/);assert.match(html,/30\.00 亿 HKD/);assert.match(html,/缓存记录/);assert.match(html,/2026-10-23 16:08:00/);assert.match(html,/每股盈利<\/span><strong>—/);
});
test('关闭历史弹窗后到达的请求不再打开弹窗，历史失败可在弹窗中重试',async()=>{
 let finish;const h=componentHarness(()=>new Promise(resolve=>{finish=resolve;}));h.run("data.state.assets=[{id:'s',name:'股票',type:'stock',currency:'CNY'}];");
 const pending=h.run("priceHistoryDialog('s')");h.run('closeDialog()');finish({ok:true,json:async()=>({items:[]})});await pending;assert.equal(h.nodes.get('#dialog').open,false);
 const failure=componentHarness(async()=>({ok:false,status:503,json:async()=>({error:'模拟读取失败'})}));failure.run("data.state.assets=[{id:'s',name:'股票',type:'stock',currency:'CNY'}];");
 await failure.run("priceHistoryDialog('s')");assert.match(failure.nodes.get('#price-history-view').innerHTML,/模拟读取失败/);assert.match(failure.nodes.get('#price-history-view').innerHTML,/重新读取/);
});

test('左侧历史支持切换、独立草稿与新建空白对话，历史标题安全转义',async()=>{
 const conversations=[{id:'a',title:'规划现金',scope_id:'scope',updated_at:'2026-10-26T01:00:00Z'},{id:'b',title:'<script>其他话题</script>',scope_id:'scope',updated_at:'2026-10-25T01:00:00Z'}];
 const h=componentHarness(async url=>Response.json({conversation:conversations.find(c=>url.endsWith(c.id)),conversations,messages:[{role:'assistant',content:url.endsWith('b')?'B 的内容':'A 的内容'}]}));
 h.context.fixture.conversation=conversations[0];h.context.fixture.conversations=conversations;
 h.run("chatDraft='A 未发送的问题';");await h.run("selectChat('b')");
 assert.equal(h.run('data.messages[0].content'),'B 的内容');assert.equal(h.run('chatDraft'),'');
 let html=h.run('assistantPage()');assert.match(html,/aria-label="历史对话"/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>其他'));
 h.run("chatDraft='B 的草稿';");await h.run("selectChat('a')");assert.equal(h.run('chatDraft'),'A 未发送的问题');
 h.run('newChat()');assert.equal(h.run('data.conversation'),null);assert.equal(h.run('data.messages.length'),0);assert.equal(h.run('chatDraft'),'');
 await h.run("selectChat('b')");assert.equal(h.run('chatDraft'),'B 的草稿');
});

test('切换历史不会中止后台回答，完成后不覆盖正在查看的另一段对话',async()=>{
 let controller;const body=new ReadableStream({start(c){controller=c;}}),a={id:'a',title:'A 对话',scope_id:'scope',updated_at:'2026-10-26T01:00:00Z'},b={id:'b',title:'B 对话',scope_id:'scope',updated_at:'2026-10-25T01:00:00Z'};
 const config={baseUrl:'https://example.com',model:'synthetic',consent:true,scopeId:'scope',includeHistory:true};
 const h=componentHarness(async(url,options)=>{if(url==='/api/conversations?id=b')return Response.json({conversation:b,conversations:[a,b],messages:[{role:'assistant',content:'B 保留内容'}]});assert.equal(JSON.parse(options.body).conversationId,'a');return new Response(body);});
 Object.assign(h.context.fixture,{config,conversation:a,conversations:[a,b]});
 const sending=h.run("sendQuestion('A 当前问题')");await new Promise(r=>setImmediate(r));
 const send=(event,value)=>controller.enqueue(new TextEncoder().encode('event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n'));
 send('run',{id:'run',conversationId:'a'});await new Promise(r=>setImmediate(r));
 await h.run("selectChat('b')");send('delta',{text:'A 流式回答'});await new Promise(r=>setImmediate(r));
 assert.ok(!h.run('assistantPage()').includes('A 流式回答'));assert.equal(h.run('chatBusy'),true);
 send('done',{conversation:a,conversations:[a,b],messages:[{role:'user',content:'A 当前问题'},{role:'assistant',content:'A 已完成'}],config});controller.close();await sending;
 assert.equal(h.run('data.conversation.id'),'b');assert.equal(h.run('data.messages[0].content'),'B 保留内容');assert.equal(h.run('chatBusy'),false);
});

test('单独删除当前对话保留其他历史，并清除被删除线程的草稿',async()=>{
 const b={id:'b',title:'保留',scope_id:'scope',updated_at:'2026-10-26T01:00:00Z'};
 const h=componentHarness(async(url,options)=>{assert.equal(url,'/api/conversations');assert.equal(options.method,'DELETE');assert.equal(JSON.parse(options.body).id,'a');return Response.json({conversation:b,conversations:[b],messages:[{role:'assistant',content:'保留回复'}],run:null});});
 h.run("data.conversation={id:'a'};chatActiveConversationId='a';chatDrafts.set('a','旧草稿');chatBusy=true;pending={action:'delete-chat',id:'a'};");
 await h.listeners.click({target:{closest(){return {dataset:{action:'confirm-pending'}};}}});
 assert.equal(h.run('data.conversation.id'),'b');assert.equal(h.run('data.messages[0].content'),'保留回复');assert.equal(h.run("chatDrafts.has('a')"),false);assert.equal(h.run('chatBusy'),false);
});

test('股票按证券交易市场区分沪深、港股和美股，不按币种误判，筛选仍按当前市值降序',()=>{
 const h=componentHarness();h.run(`data.state.preferences.rates={CNY:1,HKD:.9,USD:7};data.state.assets=[
  {id:'sh',name:'同公司 A 股',type:'stock',currency:'CNY',value:300,security:{market:'SH',key:'SH.601234',symbol:'601234'}},
  {id:'sz',name:'深圳股票',type:'stock',currency:'CNY',value:100,security:{market:'SZ',key:'SZ.001234',symbol:'001234'}},
  {id:'hk',name:'同公司港股人民币柜台',type:'stock',currency:'CNY',value:200,security:{market:'HK',key:'HK.81234',symbol:'81234'}},
  {id:'us',name:'美国股票',type:'stock',currency:'USD',value:100,security:{key:'US.TEST',symbol:'TEST'}},
  {id:'unknown',name:'手工股票',type:'stock',currency:'CNY',value:100},
  {id:'bj',name:'北交所股票',type:'stock',currency:'CNY',value:50,security:{market:'BJ',key:'BJ.920001',symbol:'920001'}},
  {id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000},
  {id:'fund',name:'基金',type:'fund',currency:'CNY',value:50000}];assetFilter='stock';`);
 const before=h.run('JSON.stringify(data.state)');
 assert.equal(h.run("filteredAssets().map(a=>a.id).join(',')"),'us,sh,hk,sz,unknown,bj');
 h.run("stockMarketFilter='CN';");assert.equal(h.run("filteredAssets().map(a=>a.id).join(',')"),'sh,sz');
 h.run("stockMarketFilter='HK';");assert.equal(h.run("filteredAssets().map(a=>a.id).join(',')"),'hk');assert.equal(h.run('stockAllocation().total'),1450);
 assert.match(h.run('assetsPage()'),/13\.79%/);assert.match(h.run('assetsPage()'),/港股 · HK\.81234/);assert.match(h.run('assetResultCount(filteredAssets())'),/1 \/ 6 项股票/);
 h.run("stockMarketFilter='US';");assert.equal(h.run("filteredAssets()[0].id"),'us');
 h.run("stockMarketFilter='unknown';");assert.equal(h.run("filteredAssets()[0].id"),'unknown');assert.match(h.run('stockMarketFiltersHTML()'),/市场待补充/);
 h.run("stockMarketFilter='BJ';");assert.equal(h.run("filteredAssets()[0].id"),'bj');
 assert.equal(h.run('JSON.stringify(data.state)'),before);
});

test('股票市场与搜索组合，切到其他资产不受市场限制，清除全部筛选会重置市场',async()=>{
 const h=componentHarness();h.run(`data.state.assets=[
  {id:'hk1',name:'港股甲',type:'stock',currency:'HKD',value:200,security:{market:'HK',key:'HK.00123'}},
  {id:'hk2',name:'港股乙',type:'stock',currency:'HKD',value:100,stockMarket:'HK'},
  {id:'us',name:'美国股票',type:'stock',currency:'USD',value:100,security:{market:'US',key:'US.TEST'}},
  {id:'fund',name:'基金',type:'fund',currency:'CNY',value:100}];assetFilter='stock';assetQuery='甲';`);
 const click=dataset=>h.listeners.click({target:{closest(){return {dataset};}}});
 await click({action:'stock-market-filter',market:'HK'});assert.equal(h.run('filteredAssets().length'),1);assert.equal(h.run('filteredAssets()[0].id'),'hk1');assert.match(h.run('stockMarketFiltersHTML()'),/data-market="HK" aria-pressed="true"/);
 h.run("assetQuery='没有';");assert.match(h.run('assetsPage()'),/没有匹配的资产/);
 await click({action:'clear-asset-search'});assert.equal(h.run('stockMarketFilter'),'HK');assert.equal(h.run('filteredAssets().length'),2);
 await click({action:'asset-filter',filter:'fund'});assert.equal(h.run('filteredAssets()[0].id'),'fund');assert.equal(h.run('stockMarketFiltersHTML()'),'');
 await click({action:'clear-asset-filters'});assert.equal(h.run('stockMarketFilter'),'all');assert.equal(h.run('assetFilter'),'all');assert.equal(h.run('filteredAssets().length'),4);
});
