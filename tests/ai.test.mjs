import test from 'node:test';
import assert from 'node:assert/strict';
import { demoState, simulate } from '../src/domain.mjs';
import { contextForAI, validateConfig } from '../src/ai.mjs';

test('关闭持仓外发时，当前与试算快照均不泄露账户及持仓名称',()=>{
  const s=demoState();s.assets[1].issuer='不应外发的发行人';s.assets[1].account='不应外发的账号';s.assets[1].name='不应外发的持仓';s.policy.issuerLimit=1;
  const scenario=simulate(s,{kind:'buy',amount:1000,target:'不应外发的目标'});
  const json=JSON.stringify(contextForAI(s,scenario,false));assert.ok(!json.includes('不应外发'));assert.ok(!json.includes('演示账户'));
  assert.ok(JSON.stringify(contextForAI(s,scenario,true)).includes('不应外发的持仓'));
});
test('模型 URL 不允许内嵌凭据及远程明文传输，本机 HTTP 可以使用',()=>{
  assert.throws(()=>validateConfig({baseUrl:'https://key@example.com/v1'}));assert.throws(()=>validateConfig({baseUrl:'http://example.com/v1'}));
  assert.equal(validateConfig({baseUrl:'http://127.0.0.1:11434/v1/'}).baseUrl,'http://127.0.0.1:11434/v1');
});

test('DeepSeek-compatible requests receive current issuer and purchase rules, including after an old conversation',async t=>{
  const {runAssistant}=await import('../src/ai.mjs');
  const s=demoState();s.policy.issuerLimit=30;s.policy.buyTranchePercent=1;s.profile.background.displayName='Sample User';
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,{body})=>{
    const req=JSON.parse(body),system=req.messages.find(m=>m.role==='system').content;
    const snapshot=JSON.parse(system.split('当前已授权财务快照（JSON 数据）：\n')[1]);
    assert.equal(snapshot.policy.issuerLimit,30);assert.equal(snapshot.policy.buyTranchePercent,1);
    assert.equal(snapshot.profile.background.displayName,'Sample User');
    if(++calls===1)return Response.json({choices:[{message:{content:null,tool_calls:[{id:'current-policy',type:'function',function:{name:'get_stock_funding_plan',arguments:'{}'}}]}}]});
    const output=JSON.parse(req.messages.find(m=>m.role==='tool').content);
    assert.equal(output.funding.issuerLimitPercent,30);assert.equal(output.plan.tranchePortfolioPercent,1);
    return Response.json({choices:[{message:{content:'采用当前保存的仓位与分批规则。'}}]});
  });
  const config={baseUrl:'https://example.com/v1',model:'deepseek-flash',consent:true,useTools:true,includeHistory:true,scopeId:'rules-test'};
  const history=[{role:'assistant',content:'旧规则未设置单股上限。',mode:'ai',metadata:{aiChat:true,scopeId:'rules-test'}}];
  const result=await runAssistant(config,s,'我的投资规则是什么？',{history});
  assert.equal(calls,2);assert.ok(result.toolsUsed.some(t=>t.name==='get_stock_funding_plan'&&t.ok));
});

test('财务工具缺少贷款条件时返回追问项，不按零猜测也不改账',async()=>{
  const {financialTools}=await import('../src/ai.mjs'),s=demoState(),before=JSON.stringify(s);
  const result=await financialTools(s)[0].execute('test',{kind:'loan',amount:600000});
  assert.equal(result.details.status,'needs_information');assert.ok(result.details.missing.includes('新增贷款的实际月供'));assert.ok(result.details.missing.includes('首付金额'));assert.equal(JSON.stringify(s),before);
});
test('个人助手可仅测算本次付款，赠借性质与持续支出未知时仍返回余额，工具往返不改账',async t=>{
  const {runAssistant}=await import('../src/ai.mjs');
  const s=demoState();s.assets=[{id:'cash',name:'PRIVATE_CASH_ACCOUNT',type:'cash',currency:'CNY',value:100000,emergency:0,earmarked:0,inPool:true,asOf:'2026-10-26'}];
  s.debts=[];s.profile.expenses=5500;const before=JSON.stringify(s);let requests=0;
  t.mock.method(globalThis,'fetch',async(_url,{body})=>{
    const req=JSON.parse(body);assert.ok(!body.includes('PRIVATE_CASH_ACCOUNT'));
    if(++requests===1)return Response.json({choices:[{message:{content:null,tool_calls:[{id:'cash-payment',type:'function',function:{name:'assess_financial_action',arguments:JSON.stringify({kind:'cash-outflow',amount:50000})}}]}}]});
    const result=JSON.parse(req.messages.find(m=>m.role==='tool').content);
    assert.equal(result.status,'calculated');assert.equal(result.cashAfter,50000);assert.equal(result.paymentPercentOfCash,50);
    assert.equal(result.baseExpenseCoverageMonths,9.1);assert.deepEqual(result.missing,[]);
    return Response.json({choices:[{message:{content:'虚构现金付款测算完成。'}}]});
  });
  const result=await runAssistant({baseUrl:'https://example.com',model:'mock',consent:true,useTools:true},s,'考虑给别人五万元，先看看本次现金影响');
  assert.equal(requests,2);assert.equal(result.content,'虚构现金付款测算完成。');
  assert.deepEqual(result.toolsUsed,[{name:'assess_financial_action',ok:true}]);assert.equal(JSON.stringify(s),before);
});
test('现金付款工具不把借款或外部资金当作现有余额',async()=>{
  const {financialTools}=await import('../src/ai.mjs');
  for(const source of ['borrow','external']) {
    const r=await financialTools(demoState())[0].execute('test',{kind:'cash-outflow',amount:50000,source});
    assert.equal(r.details.status,'needs_information');assert.equal(r.details.cashAfter,undefined);
  }
});
test('可买入额度不把外币或池外现金当作可用人民币',async()=>{
  const {financialTools}=await import('../src/ai.mjs'),s=demoState();
  s.assets[0].currency='USD';s.preferences.rates.USD=1;assert.equal((await financialTools(s)[1].execute()).details.amount,0);
});
test('匿名快照包含保险、个人背景和信息缺口，排除账号及备注',()=>{
  const s=demoState();s.profile.background={scope:'household',dependents:2,priorities:'两年后买房'};
  s.assets.push({name:'隐私保单昵称',account:'隐私账号',note:'隐私备注',type:'insurance',value:50000,currency:'CNY',asOf:'2026-10-22',insurance:{sumAssured:1000000,premiumAmount:12000,premiumFrequency:'yearly'}});
  const context=contextForAI(s,null,false),json=JSON.stringify(context);assert.ok(!json.includes('隐私'));assert.equal(context.insurance[0].value,50000);assert.equal(context.insurance[0].sumAssured,1000000);assert.equal(context.profile.background.dependents,2);
});
test('已授权背景传递可修改的称呼，旧档案使用默认称呼，留空不回填',()=>{
  const s=demoState();delete s.profile.background;
  assert.equal(contextForAI(s).profile.background.displayName,'');
  s.profile.background={displayName:'我的昵称'};
  assert.equal(contextForAI(s).profile.background.displayName,'我的昵称');
  s.profile.background.displayName='';assert.equal(contextForAI(s).profile.background.displayName,'');
});
test('已登记的生活支出不因保费未知而被再次列作缺项，缺失保费仍需明确',()=>{
  const s=demoState();s.profile.expenses=5500;
  s.assets.push({name:'保单',type:'insurance',value:0,currency:'CNY',inPool:false,asOf:'2026-10-23',insurance:{premiumFrequency:'unknown',premiumInExpenses:false}});
  let c=contextForAI(s);assert.equal(c.metrics.baseExpenses,5500);assert.equal(c.metrics.expenses,null);assert.ok(c.missingForAdvice.includes('续期保费周期、金额或是否已计入生活支出'));assert.ok(!c.missingForAdvice.includes('每月必要生活支出'));
  s.profile.expenses=null;c=contextForAI(s);assert.ok(c.missingForAdvice.includes('每月必要生活支出'));
});

test('模型响应超时默认 120 秒，可配置且拒绝非法等待时长',()=>{
  assert.equal(validateConfig({}).requestTimeoutSeconds,120);
  assert.equal(validateConfig({requestTimeoutSeconds:'180'}).requestTimeoutSeconds,180);
  for(const value of [0,-1,9,301,Infinity,'abc',25.5])assert.throws(()=>validateConfig({requestTimeoutSeconds:value}),/超时/);
});
test('请求和 Pi 对话循环保留生成超时类别，不误报网络错误',async t=>{
  const {runAssistant}=await import('../src/ai.mjs');
  const timeouts=[];
  t.mock.method(AbortSignal,'timeout',ms=>{
    timeouts.push(ms);const c=new AbortController();
    if(ms===180000)queueMicrotask(()=>c.abort(new DOMException('test timeout','TimeoutError')));
    return c.signal;
  });
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
  await assert.rejects(runAssistant({baseUrl:'https://example.com/v1',model:'mock',consent:true,requestTimeoutSeconds:180},demoState(),'虚构测试'),e=>e.code==='AI_TIMEOUT'&&/180 秒/.test(e.message)&&!e.message.includes('网络'));
  assert.ok(timeouts.includes(180000));assert.ok(timeouts.includes(540000));
});
test('DNS 错误、响应中断与取消分别处理，原始连接错误不泄露信息',async t=>{
  const {callModel}=await import('../src/ai.mjs'),c={baseUrl:'https://example.com/v1',model:'mock'};
  const mock=t.mock.method(globalThis,'fetch',async()=>{throw Object.assign(new TypeError('FAKE_SECRET'),{cause:{code:'ENOTFOUND'}});});
  await assert.rejects(callModel(c,[]),e=>e.code==='AI_DNS'&&/域名解析/.test(e.message)&&!e.message.includes('FAKE_SECRET'));
  mock.mock.mockImplementation(async()=>new Response(new ReadableStream({start(controller){controller.error(Object.assign(new TypeError('terminated'),{cause:{code:'ECONNRESET'}}));}})));
  await assert.rejects(callModel(c,[]),e=>e.code==='AI_CONNECTION'&&/连接中断/.test(e.message));
  const controller=new AbortController();controller.abort();const before=mock.mock.callCount();
  await assert.rejects(callModel(c,[],{signal:controller.signal}),e=>e.code==='AI_CANCELLED');assert.equal(mock.mock.callCount(),before);
});
test('响应体读取期间超时也显示明确的等待时长',async t=>{
  const {callModel}=await import('../src/ai.mjs');
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){controller.error(new DOMException('test','TimeoutError'));}})));
  await assert.rejects(callModel({baseUrl:'https://example.com/v1',model:'mock',requestTimeoutSeconds:240},[]),e=>e.code==='AI_TIMEOUT'&&/240 秒/.test(e.message));
});

test('思考模型的工具轮次保留供应商续接字段，最终回答只包含可见文字',async t=>{
  const {runAssistant}=await import('../src/ai.mjs');let requests=0;
  const state=demoState(),before=JSON.stringify(state);
  t.mock.method(globalThis,'fetch',async(_url,{body})=>{
    const request=JSON.parse(body);requests++;
    if(requests===1)return Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,reasoning_content:'SYNTHETIC_PROVIDER_CONTINUATION',tool_calls:[{id:'synthetic-budget',type:'function',function:{name:'get_stock_budget',arguments:'{}'}}]}}]});
    const assistant=request.messages.find(m=>m.role==='assistant'&&m.tool_calls?.length);
    assert.equal(assistant.reasoning_content,'SYNTHETIC_PROVIDER_CONTINUATION');
    assert.ok(request.messages.some(m=>m.role==='tool'&&m.tool_call_id==='synthetic-budget'));
    return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'虚构测试已完成。',reasoning_content:'SYNTHETIC_FINAL_CONTINUATION'}}]});
  });
  const result=await runAssistant({baseUrl:'https://example.com/v1',model:'synthetic-thinking-model',consent:true,useTools:true},state,'调用配置额度工具进行虚构测试');
  assert.equal(requests,2);assert.equal(result.content,'虚构测试已完成。');assert.deepEqual(result.toolsUsed,[{name:'get_stock_budget',ok:true}]);assert.ok(!JSON.stringify(result).includes('CONTINUATION'));assert.equal(JSON.stringify(state),before);
});

test('流式工具参数可跨分段拼接，续接思考内容但只推送状态与可见回答',async t=>{
 const {runAssistant}=await import('../src/ai.mjs');let requests=0;const events=[];
 const response=frames=>new Response(frames.map(frame=>'data: '+(typeof frame==='string'?frame:JSON.stringify({choices:[frame]}))+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
   const payload=JSON.parse(body);assert.equal(payload.stream,true);requests++;
   if(requests===1)return response([
     {delta:{reasoning_content:'SYNTHETIC_STREAM_CONTINUATION'}},
     {delta:{tool_calls:[{index:0,id:'stream-tool',type:'function',function:{name:'get_stock_budget',arguments:'{'}}]}},
     {delta:{tool_calls:[{index:0,function:{arguments:'}'}}]},finish_reason:'tool_calls'},'[DONE]']);
   assert.equal(payload.messages.find(m=>m.tool_calls)?.reasoning_content,'SYNTHETIC_STREAM_CONTINUATION');
   return response([{delta:{content:'测试'}},{delta:{content:'完成。'},finish_reason:'stop'},'[DONE]']);
 });
 const result=await runAssistant({baseUrl:'https://example.com',model:'synthetic',consent:true},demoState(),'测试',{onEvent:event=>events.push(event)});
 assert.equal(result.content,'测试完成。');assert.equal(events.filter(e=>e.type==='delta').map(e=>e.text).join(''),'测试完成。');assert.ok(events.some(e=>e.stage==='calculating'));assert.ok(events.some(e=>e.type==='reset'));assert.ok(!JSON.stringify(events).includes('CONTINUATION'));
});

test('流中断不会把部分回答当作成功，输出到达后仍受模型超时约束',async t=>{
 const {runAssistant}=await import('../src/ai.mjs');const events=[];
 t.mock.method(globalThis,'fetch',async()=>new Response('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n',{headers:{'Content-Type':'text/event-stream'}}));
 await assert.rejects(runAssistant({baseUrl:'https://example.com',model:'synthetic',consent:true},demoState(),'测试',{onEvent:e=>events.push(e)}),e=>e.code==='AI_STREAM');assert.equal(events.find(e=>e.type==='delta').text,'未完成');
});

test('Pi dispatches dated market data and funding tools on demand without injecting private holdings into an unauthorized snapshot',async t=>{
 const {runAssistant,financialTools}=await import('../src/ai.mjs');const s=demoState();s.assets[1].name='PRIVATE_HOLDING';let requests=0,marketArgs;
 const services={getMarketData:async args=>{marketArgs=args;return {market:'US',date:'2026-10-23',indices:[{name:'标普500',percent:-.52}]};},getStockQuote:async()=>({quote:{key:'US.GOOG',price:100,currency:'USD',date:'2026-10-23',time:'2026-10-23 16:00:00'}})};
 const schema=financialTools(s,services).find(t=>t.name==='get_market_data').parameters.properties.date;assert.ok(new RegExp(schema.pattern).test('2026-10-23'));
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{const req=JSON.parse(body);requests++;assert.ok(!JSON.stringify(req).includes('PRIVATE_HOLDING'));assert.ok(req.tools.some(t=>t.function.name==='get_stock_quote'));
 if(requests===1)return Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'market',type:'function',function:{name:'get_market_data',arguments:JSON.stringify({market:'US',date:'2026-10-23'})}},{id:'funding',type:'function',function:{name:'get_stock_funding_plan',arguments:JSON.stringify({key:'US.GOOG',totalBudget:1000})}}]}}]});
 const toolResults=req.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));assert.equal(toolResults.length,2);assert.equal(toolResults[0].indices[0].percent,-.52);assert.equal(toolResults[1].grid.hasDividendRequirement,false);assert.equal(toolResults[1].quote.price,100);return Response.json({choices:[{message:{content:'已按实际交易日和资金工具核对。'}}]});});
 const result=await runAssistant({baseUrl:'https://example.com/v1',model:'mock',consent:true,useTools:true,includeHoldings:false},s,'美股昨日怎样，加仓能安排多少？',{services});assert.equal(result.content,'已按实际交易日和资金工具核对。');assert.deepEqual(marketArgs,{market:'US',date:'2026-10-23'});assert.deepEqual(result.toolsUsed.map(t=>t.name),['get_market_data','get_stock_funding_plan']);assert.ok(result.toolsUsed.every(t=>t.ok));
});

test('short summaries can disable supported thinking and a reasoning-only length stop is reported as an output limit',async t=>{const {callModel}=await import('../src/ai.mjs');let received;const m=t.mock.method(globalThis,'fetch',async(_url,{body})=>{received=JSON.parse(body);return Response.json({choices:[{finish_reason:'stop',message:{content:'ok'}}]});});await callModel({baseUrl:'https://example.com/v1',model:'mock'},[],{maxTokens:550,thinking:'disabled'});assert.equal(received.max_tokens,550);assert.equal(received.thinking.type,'disabled');m.mock.mockImplementation(async()=>Response.json({choices:[{finish_reason:'length',message:{content:null,reasoning_content:'PRIVATE REASONING'}}]}));await assert.rejects(callModel({baseUrl:'https://example.com/v1',model:'mock'},[]),e=>e.code==='AI_OUTPUT_LIMIT'&&!e.message.includes('PRIVATE'));});
