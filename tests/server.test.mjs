import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApplication } from '../src/server.mjs';
import { readEventStream } from '../public/sse.js';
import { createLedgerService } from '../src/ledger.mjs';

async function setup(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'balance-test-')),app=createApplication({dataDir:dir,disableAuth:false,schedule:false,...options});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});let cookie='';
  const request=async(path,method='GET',body,extra={})=>{const res=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,body:await res.json()};};
  return {app,request,base,dir};
}

test('基金搜索需登录，只向公开目录发送关键词且不修改财务档案',async t=>{
  const {request,app}=await setup(t);
  assert.equal((await request('/market/funds/search?q=008164')).status,401);
  await request('/auth/setup','POST',{password:'search-test-password'});
  const before=app.store.state({raw:true}),nativeFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    const url=new URL(input);
    if(url.hostname==='fundsuggest.eastmoney.com'){
      assert.equal(url.searchParams.get('key'),'南方');assert.equal(url.searchParams.size,2);
      assert.equal(options.headers.Cookie,undefined);
      return Response.json({ErrCode:0,Datas:[{CATEGORY:700,CODE:'008164',NAME:'南方基金',FundBaseInfo:{FCODE:'008164',FTYPE:'指数型'}}]});
    }
    return nativeFetch(input,options);
  });
  const response=await request('/market/funds/search?q='+encodeURIComponent('南方'));assert.equal(response.status,200);assert.equal(response.body.items[0].code,'008164');
  assert.deepEqual(app.store.state({raw:true}),before);
  assert.equal((await request('/market/funds/search?q=')).status,400);
});

test('基金自选持久保存、独立刷新与历史详情沿用登录保护，不创建持仓',async t=>{
  const {request,app}=await setup(t);
  assert.equal((await request('/market/fund-watchlist/refresh','POST',{})).status,401);
  assert.equal((await request('/market/history?id=watch-fund-008164')).status,401);
  await request('/auth/setup','POST',{password:'watch-test-password'});
  let view=(await request('/bootstrap')).body;view.state.fundWatchlist=[{code:'008164',name:'Synthetic watch fund'}];
  view=(await request('/state','PUT',{state:view.state,revision:view.state.revision})).body;
  const nativeFetch=globalThis.fetch;let calls=0;
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    const url=new URL(input);
    if(url.hostname==='api.fund.eastmoney.com'){
      calls++;assert.equal(url.searchParams.get('fundCode'),'008164');
      return Response.json({ErrCode:0,Data:{LSJZList:[{FSRQ:'2026-10-23',DWJZ:'1.2'},{FSRQ:'2026-10-22',DWJZ:'1.1'}]}});
    }
    return nativeFetch(input,options);
  });
  const refreshed=await request('/market/fund-watchlist/refresh','POST',{code:'008164'});assert.equal(refreshed.status,200);view=refreshed.body;
  assert.equal(calls,1);assert.equal(view.state.fundWatchlist[0].valuation.price,1.2);assert.equal(view.state.assets.length,0);assert.equal(view.metrics.totalAssets,0);
  assert.equal((await request('/market/history?id=watch-fund-008164')).body.items[0].price,1.2);
  assert.equal((await request('/market/fund-reference?id=watch-fund-008164')).body.reference.key,'SH.515450');
  view.state.profile.note='Another saved setting';view=(await request('/state','PUT',{state:view.state,revision:view.state.revision})).body;
  assert.deepEqual(app.store.state({raw:true}).fundWatchlist,[{code:'008164',name:'Synthetic watch fund'}]);
  assert.equal((await request('/export')).body.state.fundWatchlist[0].code,'008164');
  view.state.fundWatchlist=[];await request('/state','PUT',{state:view.state,revision:view.state.revision});
  assert.equal((await request('/market/history?id=watch-fund-008164')).status,404);
  assert.equal((await request('/market/fund-reference?id=watch-fund-008164')).status,404);
  assert.equal((await request('/market/fund-watchlist/refresh','POST',{code:'008164'})).status,404);
  assert.equal((await request('/market/fund-watchlist/refresh','POST',{})).status,200);assert.equal(calls,1);
});
test('清空接口原子取消旧待入账；价格披露后不能重新写入空档案',async t=>{
  const {request,app}=await setup(t,{disableAuth:true}),store=app.store;
  const now=new Date('2026-10-29T10:00:00Z'),date='2026-10-29';
  store.saveConfig({baseUrl:'https://example.com',model:'synthetic',consent:true,allowLedgerWrites:true});
  const service=createLedgerService(store,{clock:()=>now,fundOptions:{fetchImpl:async()=>{throw new Error('offline');}}});
  const question='我今天用额外投入买入1000元基金006789';
  const pending=await service.bind({question,requestId:'before-reset',scopeId:store.config().scopeId,startedAt:now.getTime()}).recordHoldingChange({query:'006789',fundCode:'006789',side:'buy',amount:1000,evidence:question});
  assert.equal(pending.status,'pending');
  const failed=await request('/reset','POST',{revision:store.state().revision,confirmation:'错误确认'});
  assert.equal(failed.status,400);assert.equal(store.ledgerEntry(pending.id).status,'pending');assert.equal(store.ledgerGeneration(),0);
  const cleared=await request('/reset','POST',{revision:store.state().revision,confirmation:'清空财务档案'});
  assert.equal(cleared.status,200);assert.equal(cleared.body.state.assets.length,0);assert.equal(cleared.body.ledgerEntries[0].status,'cancelled');assert.equal(store.ledgerGeneration(),1);
  store.setKV('fund_nav:006789',{date,price:2,currency:'CNY',basis:'unit_nav'});await service.processPending();
  assert.equal((await request('/bootstrap')).body.state.assets.length,0);
});
test('首次设置、登录保护、重复导入、旧试算接口移除与版本冲突',async t=>{
  const {request,app}=await setup(t);
  assert.equal((await request('/bootstrap')).status,401);
  assert.equal((await request('/markets?market=US')).status,401);
  assert.equal((await request('/chat/stream','POST',{message:'test'})).status,401);
  assert.equal((await request('/auth/setup','POST',{password:'test-password-only'})).status,200);
  let view=(await request('/bootstrap')).body;assert.equal(view.state.assets.length,0);
  assert.equal((await request('/markets?market=US')).body.market,'US');
  assert.equal((await request('/markets?market=SH')).status,400);
  assert.equal((await request('/markets/refresh','POST',{market:'SH'})).status,400);
  const csv='id,name,type,currency,value,asOf\ncash,现金,cash,CNY,100000,2026-10-22\n';
  const preview=(await request('/import/preview','POST',{csv})).body;
  view=(await request('/import','POST',{assets:preview.assets,revision:0})).body;assert.equal(view.metrics.totalAssets,100000);
  view=(await request('/import','POST',{assets:preview.assets,revision:view.state.revision})).body;assert.equal(view.state.assets.length,1);
  assert.equal((await request('/simulate','POST',{kind:'buy',amount:10000})).status,404);assert.equal(app.store.state().assets.length,1);
  assert.equal((await request('/state','PUT',{state:view.state,revision:0})).status,409);
  const ai=await request('/config','PUT',{baseUrl:'http://127.0.0.1:12345/v1',model:'test',apiKey:'FAKE_TEST_SECRET',consent:false});assert.equal(ai.body.config.hasKey,true);assert.ok(!JSON.stringify(ai.body).includes('FAKE_TEST_SECRET'));
  const backup=(await request('/export')).body;assert.ok(!JSON.stringify(backup).includes('FAKE_TEST_SECRET'));assert.equal(backup.state.assets.length,1);
  const report=(await request('/reports','POST',{})).body;assert.equal(report.report.changes,null);assert.equal(report.report.aiText,null);
  assert.equal((await request('/state','PUT',{state:view.state,revision:view.state.revision},{Origin:'https://attacker.example'})).status,403);
  await request('/auth/logout','POST',{});assert.equal((await request('/bootstrap')).status,401);
  assert.equal((await request('/auth/login','POST',{password:'wrong-password'})).status,401);
  assert.equal((await request('/auth/login','POST',{password:'test-password-only'})).status,200);
});
test('模型代理使用服务端密钥及最少上下文，不回传密钥',async t=>{
  let received;
  const upstream=createServer(async(req,res)=>{let b='';for await(const p of req)b+=p;received={path:req.url,auth:req.headers.authorization,data:JSON.parse(b)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'已收到测试摘要。'}}]}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
  const {request}=await setup(t,{disableAuth:true});
  await request('/config','PUT',{baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,model:'fake-model',apiKey:'FAKE_TEST_KEY',consent:true});
  const result=await request('/chat','POST',{message:'看看我的财务情况'});assert.equal(result.body.mode,'ai');assert.equal(received.path,'/v1/chat/completions');assert.equal(received.auth,'Bearer FAKE_TEST_KEY');assert.ok(!received.data.messages[1].content.includes('apiKey'));assert.ok(!JSON.stringify(result.body).includes('FAKE_TEST_KEY'));
});
test('负债 CSV 重复导入不会翻倍，日报同日不重复创建',async t=>{
  const {request,app}=await setup(t,{disableAuth:true});
  const csv='id,name,currency,balance,payment\nd1,虚构借款,CNY,100000,1000\n';
  const preview=(await request('/import/preview','POST',{csv,kind:'debts'})).body;assert.equal(preview.records[0].balance,100000);
  for(let i=0;i<2;i++)assert.equal((await request('/import','POST',{kind:'debts',records:preview.records,revision:app.store.state().revision})).status,200);
  assert.equal(app.store.state().debts.length,1);await request('/reports','POST',{});await request('/reports','POST',{});assert.equal(app.store.reports().length,1);
});
test('数据库重开后财务档案和加密配置保留',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'balance-persist-'));const app=createApplication({dataDir:dir,disableAuth:true,schedule:false});
  app.store.save({...app.store.state(),profile:{...app.store.state().profile,income:12345}},0);app.store.saveConfig({baseUrl:'http://localhost:123/v1',model:'test',apiKey:'FAKE_SECRET',consent:true,includeHistory:true});
  app.store.close();const reopened=createApplication({dataDir:dir,disableAuth:true,schedule:false});assert.equal(reopened.store.state().profile.income,12345);assert.equal(reopened.store.config({secret:true}).apiKey,'FAKE_SECRET');assert.equal(reopened.store.config().apiKey,'');reopened.store.close();rmSync(dir,{recursive:true,force:true});
});
test('基础资料接口保护资产访问，返回缓存原币指标且不修改账本，基金不套用个股指标',async t=>{
 const {request,app}=await setup(t);assert.equal((await request('/market/details?id=stock')).status,401);
 await request('/auth/setup','POST',{password:'test-password-only'});
 const state=app.store.state();state.assets=[{id:'stock',name:'Synthetic',type:'stock',currency:'HKD',value:100,asOf:'2026-10-23',security:{market:'HK',symbol:'00700'},quantity:1,unit:'股'},{id:'fund',name:'Synthetic fund',type:'fund',currency:'CNY',value:100,asOf:'2026-10-23'}];app.store.save(state,state.revision);
 app.store.setKV('stock_details:HK.00700',{key:'HK.00700',currency:'HKD',time:'2026-10-23 16:00:00',fetchedAt:new Date().toISOString(),metrics:{peTTM:18.5,dividendYieldTTM:1.2}});
 const before=JSON.stringify(app.store.state({raw:true}));
 const result=await request('/market/details?id=stock');assert.equal(result.status,200);assert.equal(result.body.metrics.peTTM,18.5);assert.equal(result.body.currency,'HKD');
 assert.equal((await request('/market/details?id=fund')).body.status,'not_applicable');assert.equal((await request('/market/details?id=missing')).status,404);assert.equal(JSON.stringify(app.store.state({raw:true})),before);
});

async function modelServer(t,handler) {
  const calls=[];
  const upstream=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;
    const payload=JSON.parse(text);calls.push(payload);
    try{const reply=await handler(payload,calls.length);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:reply,finish_reason:reply.tool_calls?'tool_calls':'stop'}]}));}
    catch(error){res.writeHead(503);res.end('test upstream unavailable');}
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
  return {baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,calls};
}
test('基金盘中参考接口需要登录，读取缓存和刷新均不改变正式净值或账本',async t=>{
  const {request,app,base}=await setup(t);
  assert.equal((await request('/market/fund-reference?id=fund')).status,401);
  assert.equal((await request('/market/fund-reference/refresh','POST',{id:'fund'})).status,401);
  await request('/auth/setup','POST',{password:'test-reference-password'});
  const state=app.store.state();state.assets=[{id:'fund',name:'Synthetic fund',type:'fund',currency:'CNY',quantity:100,unit:'份',value:100,asOf:'2026-10-30',fund:{code:'011609',autoNav:true}}];app.store.save(state,state.revision);
  app.store.setKV('fund_nav:011609',{date:'2026-10-30',price:1,basis:'unit_nav',currency:'CNY'});
  app.store.setKV('fund_reference:SH.588080',{attemptedAt:new Date().toISOString(),quote:{key:'SH.588080',price:1.2,time:'2026-10-30 15:00:00'},errors:{}});
  const before=app.store.state({raw:true}),audit=app.store.audit();
  for(const result of [await request('/market/fund-reference?id=fund'),await request('/market/fund-reference/refresh','POST',{id:'fund'})]){assert.equal(result.status,200);assert.equal(result.body.quote.price,1.2);assert.match(result.body.notice,/不是本基金净值/);}
  assert.equal((await request('/market/fund-reference?id=missing')).status,404);assert.equal((await request('/market/fund-reference/refresh','POST',{id:'missing'})).status,404);
  assert.deepEqual(app.store.state({raw:true}),before);assert.deepEqual(app.store.audit(),audit);assert.equal(app.store.ledgerEntries().length,0);
  const component=await fetch(base+'/fund-reference.js');assert.equal(component.status,200);assert.match(await component.text(),/fundReferenceHTML/);
});
const toolReply=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
test('意外现金经聊天接口允许证据空白差异和旧对话现金补答，收入只记一次',async t=>{
  for(const recover of [false,true])await t.test(recover?'补答现金':'原话多空格',async t=>{
    const original='多了3000的意外现金   帮我加入一下';
    const upstream=await modelServer(t,(payload,n)=>{
      if(n===1)return toolReply('record_cash_flow',{evidence:'多了3000的意外现金 帮我加入一下'+(recover?'；现金':''),side:'income',amount:3000,description:'意外现金收入',...(recover?{}:{cashAssetId:'cash',currency:'CNY'})});
      const output=JSON.parse(payload.messages.at(-1).content);assert.equal(output.status,'applied');assert.equal(output.after.cash,13000);
      return {content:'已记录意外现金收入3000元，现金余额13000元。'};
    });
    const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state();state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000}];app.store.save(state,state.revision);
    await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
    const config=app.store.config(),conversation=app.store.createConversation(config.scopeId,original);
    if(recover){
      const metadata={aiChat:true,scopeId:config.scopeId,conversationId:conversation.id,toolCalls:[{name:'record_cash_flow',status:'complete',output:{status:'needs_information'}}]};
      for(const message of [original,'现金'])app.store.addConversation(message,'这笔要更新哪项记录、具体缺少的内容是什么？请结合本次对话已确认的信息核对。',state.revision,metadata);
    }
    const input={message:recover?'现金':original,conversationId:conversation.id,requestId:'windfall-income'},result=await request('/chat','POST',input);
    assert.equal(result.status,200);assert.equal(result.body.state.assets[0].value,13000);assert.equal(result.body.ledgerEntries.length,1);assert.equal(upstream.calls.length,2);
    assert.equal(result.body.messages.at(-1).metadata.toolCalls[0].output.status,'applied');
    const replay=await request('/chat','POST',input);assert.equal(replay.status,200);assert.equal(replay.body.state.assets[0].value,13000);assert.equal(replay.body.ledgerEntries.length,1);assert.equal(upstream.calls.length,2);
  });
});
test('聊天接口处理云铝200股成本23.53的原话和旧追问补答，现金扣4706且请求重放不重复',async t=>{
  for(const recover of [false,true])await t.test(recover?'接续200股补答':'直接买入',async t=>{
    const original='我买了200 股云铝股份 帮我记录一下， 用的现金， 成本是 23.53';
    const upstream=await modelServer(t,(payload,n)=>{
      if(n===1)return toolReply('record_holding_change',{query:'云铝股份',evidence:recover?original+'；200 股':original,side:'buy',quantity:200,price:23.53,cashSource:'registered',currency:'CNY',...(recover?{}:{key:'SZ.000807'})});
      const output=JSON.parse(payload.messages.at(-1).content);
      assert.equal(output.status,'applied');assert.equal(output.amount,4706);assert.equal(output.after.quantity,201);assert.equal(output.after.cash,5294);
      return {content:'已记录云铝股份买入200股，每股23.53元，现金扣除4706元，未含未提供的费用。'};
    });
    const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state();
    state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000},{id:'yunlv',name:'云铝股份',type:'stock',security:{market:'SZ',symbol:'000807'},currency:'CNY',value:20,quantity:1,unit:'股',costBasis:{amount:20,quantity:1,currency:'CNY'}}];
    app.store.save(state,state.revision);
    await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
    const config=app.store.config(),conversation=app.store.createConversation(config.scopeId,original);
    if(recover){
      const metadata={aiChat:true,scopeId:config.scopeId,conversationId:conversation.id,toolCalls:[{name:'record_holding_change',status:'complete',output:{status:'needs_information'}}]};
      for(const message of [original,'200 股'])app.store.addConversation(message,'这笔的金额或股数／份额是多少？请核对数字的用途和单位。',state.revision,metadata);
    }
    const input={message:recover?'200 股':original,conversationId:conversation.id,requestId:'buy-yunlv'},result=await request('/chat','POST',input);
    assert.equal(result.status,200);assert.equal(result.body.state.assets[1].quantity,201);assert.equal(result.body.state.assets[0].value,5294);assert.equal(result.body.ledgerEntries.length,1);
    assert.equal(result.body.messages.at(-1).metadata.toolCalls[0].output.status,'applied');assert.equal(upstream.calls.length,2);
    const replay=await request('/chat','POST',input);
    assert.equal(replay.status,200);assert.equal(replay.body.state.assets[0].value,5294);assert.equal(replay.body.ledgerEntries.length,1);assert.equal(upstream.calls.length,2);
  });
});
test('harness 将全部卖了记为清仓，并能从旧版重复追问中用南方啊接续，不重复入账',async t=>{
  for(const recover of [false,true])await t.test(recover?'接续旧对话':'直接清仓',async t=>{
    const original='然后我把南方全部卖了，2026-10-29成交',message=recover?'南方啊':original;
    const upstream=await modelServer(t,(payload,n)=>{
      if(n===1){
        assert.match(payload.messages[0].content,/全部卖了/);
        if(recover)assert.ok(payload.messages.some(m=>m.role==='user'&&m.content==='全部 然后变成 cash'));
        return toolReply('record_holding_change',{query:'南方',side:'sell',quantity:999,evidence:original});
      }
      const output=JSON.parse(payload.messages.at(-1).content);
      assert.equal(output.status,'applied');assert.equal(output.quantity,100);assert.equal(output.after.quantity,0);assert.equal(output.after.cash,10200);
      return {content:'南方已按当日净值估算清仓，现金增加200元。'};
    });
    const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state(),date='2026-10-29';
    state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'south',name:'南方基金',type:'fund',fund:{code:'008164',autoNav:true},currency:'CNY',value:200,quantity:100,unit:'份',asOf:date,costBasis:{amount:100,quantity:100,currency:'CNY'}}];
    app.store.save(state,state.revision);app.store.setKV('fund_nav:008164',{date,price:2,basis:'unit_nav',currency:'CNY'});
    await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
    const config=app.store.config(),conversation=app.store.createConversation(config.scopeId,original);
    if(recover){
      const metadata={aiChat:true,scopeId:config.scopeId,conversationId:conversation.id,toolCalls:[{name:'record_holding_change',status:'complete',output:{status:'needs_information'}}]};
      app.store.addConversation(original,'这笔的金额或股数／份额是多少？请核对数字的用途和单位。',state.revision,metadata);
      app.store.addConversation('全部 然后变成 cash','这笔要更新哪项记录、具体缺少的内容是什么？请结合本次对话已确认的信息核对。',state.revision,metadata);
    }
    const input={message,conversationId:conversation.id,requestId:'sell-south-all'},result=await request('/chat','POST',input);
    assert.equal(result.status,200);assert.equal(result.body.state.assets[1].quantity,0);assert.equal(result.body.state.assets[0].value,10200);assert.equal(result.body.ledgerEntries.length,1);
    assert.equal(result.body.messages.at(-1).metadata.toolCalls[0].output.status,'applied');assert.equal(upstream.calls.length,2);
    const replay=await request('/chat','POST',input);assert.equal(replay.status,200);assert.equal(replay.body.state.assets[0].value,10200);assert.equal(replay.body.ledgerEntries.length,1);assert.equal(upstream.calls.length,2);
  });
});
test('股票图表接口需要登录，缓存刷新独立于正式估值和账本',async t=>{
  const {request,app,base}=await setup(t);
  assert.equal((await request('/market/stock-data?id=stock')).status,401);assert.equal((await request('/market/stock-data/refresh','POST',{id:'stock'})).status,401);
  await request('/auth/setup','POST',{password:'test-stock-market-password'});
  const state=app.store.state();state.assets=[{id:'stock',name:'Synthetic stock',type:'stock',currency:'HKD',value:100,quantity:1,unit:'股',asOf:'2026-10-30',security:{market:'HK',symbol:'00700'}}];app.store.save(state,state.revision);
  const official={key:'HK.00700',price:100,currency:'HKD',date:'2026-10-30'};app.store.setKV('stock_quote:HK.00700',official);app.store.setKV('stock_market_data:HK.00700',{attemptedAt:new Date().toISOString(),quote:{key:'HK.00700',price:120,currency:'HKD',time:'2026-10-30 16:08:00'},errors:{}});
  const before=app.store.state({raw:true}),audit=app.store.audit(),history=app.store.history();
  for(const result of [await request('/market/stock-data?id=stock'),await request('/market/stock-data/refresh','POST',{id:'stock'})]){assert.equal(result.status,200);assert.equal(result.body.quote.price,120);assert.equal(result.body.instrument.timeZone,'Asia/Hong_Kong');assert.match(result.body.notice,/不产生交易或现金变动/);}
  assert.equal((await request('/market/stock-data?id=missing')).status,404);assert.equal((await request('/market/stock-data/refresh','POST',{id:'missing'})).status,404);
  assert.deepEqual(app.store.state({raw:true}),before);assert.deepEqual(app.store.audit(),audit);assert.deepEqual(app.store.history(),history);assert.deepEqual(app.store.getKV('stock_quote:HK.00700'),official);assert.equal(app.store.ledgerEntries().length,0);
  const component=await fetch(base+'/stock-market.js');assert.equal(component.status,200);assert.match(await component.text(),/stockMarketHTML/);
});
test('自然语言记账先追问资金来源，后续确认额外投入后通过 harness 更新持仓且不扣现金',async t=>{
  const original='我在2026-10-29加了1000元科创';
  const upstream=await modelServer(t,(payload,n)=>{
    if(n===1||n===2)return toolReply('record_holding_change',{query:'科创',side:'buy',amount:1000,date:'2026-10-29',evidence:original,...(n===2?{cashSource:'outside'}:{})});
    const result=JSON.parse(payload.messages.at(-1).content);
    assert.equal(result.status,'applied');assert.equal(result.after.quantity,600);return {content:'已按指定日期净值估算记入1000元加仓，使用额外投入。'};
  });
  const {request,app}=await setup(t,{disableAuth:true});const date='2026-10-29',state=app.store.state();
  state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'star',name:'科创基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',value:200,quantity:100,unit:'份',asOf:date,costBasis:{amount:100,quantity:100,currency:'CNY'}}];app.store.save(state,state.revision);app.store.setKV('fund_nav:011609',{date,price:2,basis:'unit_nav',currency:'CNY'});
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
  const first=await request('/chat','POST',{message:original,requestId:'ask-source'});assert.equal(app.store.state().assets[1].quantity,100);assert.equal(app.store.ledgerEntries().length,0);
  assert.match(first.body.content,/现有现金.*额外投入/);assert.equal(upstream.calls.length,1);
  const second=await request('/chat','POST',{message:'额外投入',conversationId:first.body.conversation.id,requestId:'confirm-source'});
  assert.equal(second.status,200);assert.equal(second.body.state.assets[1].quantity,600);assert.equal(second.body.state.assets[0].value,10000);assert.equal(second.body.ledgerEntries[0].status,'applied');assert.equal(second.body.messages.at(-1).metadata.toolCalls[0].name,'record_holding_change');
  assert.ok(upstream.calls[0].messages[0].content.includes('必须先问'));assert.ok(upstream.calls[2].messages[0].content.includes('本地账本'));
});
test('口语买入原话经日期补答完成模型与记账工具往返，不要求重说金额和资金来源',async t=>{
  const original='我买了 1000 的科创50 几天 我自己有的那个 基金 从现金里加入的',reply='2026-10-29买的';
  const upstream=await modelServer(t,(payload,n)=>{
    if(n===1||n===2)return toolReply('record_holding_change',{query:'买入科创50基金1000元，从现金里加入',evidence:n===1?original:original+'。'+reply,side:'buy',assetId:'star',amount:1000,cashSource:'registered',...(n===2?{date:'2026-10-29'}:{})});
    const output=JSON.parse(payload.messages.at(-1).content);
    assert.equal(output.status,'applied');assert.equal(output.after.cash,9000);assert.equal(output.date,'2026-10-29');return {content:'已按指定日期净值估算入账，现金扣除1000元。'};
  });
  const {request,app}=await setup(t,{disableAuth:true}),date='2026-10-29',state=app.store.state();
  state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'star',name:'科创50基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',value:200,quantity:100,unit:'份',asOf:date,costBasis:{amount:100,quantity:100,currency:'CNY'}}];
  app.store.save(state,state.revision);app.store.setKV('fund_nav:011609',{date,price:2,basis:'unit_nav',currency:'CNY'});
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
  const first=await request('/chat','POST',{message:original,requestId:'colloquial-date-question'});
  assert.equal(first.status,200);assert.equal(first.body.ledgerEntries.length,0);assert.equal(first.body.state.assets[0].value,10000);
  assert.match(first.body.content,/哪天/);assert.equal(upstream.calls.length,1);
  const second=await request('/chat','POST',{message:reply,conversationId:first.body.conversation.id,requestId:'colloquial-date-answer'});
  assert.equal(second.status,200);assert.equal(second.body.ledgerEntries[0].status,'applied');assert.equal(second.body.state.assets[0].value,9000);assert.equal(second.body.state.assets[1].quantity,600);
  assert.ok(upstream.calls[1].messages.some(m=>m.role==='user'&&m.content===original));
  assert.ok(upstream.calls[1].messages[0].content.includes('不要求用户重说整句'));assert.ok(upstream.calls[1].messages[0].content.includes('持仓、成本和现金都尚未更新'));
  const replay=await request('/chat','POST',{message:reply,conversationId:first.body.conversation.id,requestId:'colloquial-date-answer'});
  assert.equal(replay.status,200);assert.equal(replay.body.ledgerEntries.length,1);assert.equal(replay.body.state.assets[0].value,9000);assert.equal(upstream.calls.length,3);
});
test('harness 区分校准与买入，缺现金处理直接追问，补答后切换工具并按用户总份额纠正参数',async t=>{
  const original='请更新科创持仓，目前持有23671.48份，单位成本1.1141元';
  const upstream=await modelServer(t,(payload,n)=>{
    if(n===1)return toolReply('set_holding_balance',{query:'科创',evidence:original,quantity:23671.48,averageCost:1.1141});
    if(n===2)return toolReply('record_holding_change',{query:'科创',evidence:original+'；现金-1000',side:'buy',quantity:3218.48,cashSource:'registered'});
    const output=JSON.parse(payload.messages.at(-1).content);
    if(n===3){assert.equal(output.status,'use_other_tool');return toolReply('set_holding_balance',{query:'科创',evidence:'现金-1000',quantity:3218.48,averageCost:1.1141,cashDelta:-1000});}
    assert.equal(output.status,'applied');assert.equal(output.after.quantity,23671.48);assert.equal(output.after.cash,9000);return {content:'已校准总持仓并按确认金额调整现金。'};
  });
  const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state(),date='2026-10-29';
  state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'star',name:'科创基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',value:200,quantity:100,unit:'份',asOf:date}];
  app.store.save(state,state.revision);app.store.setKV('fund_nav:011609',{date,price:0.9132,basis:'unit_nav',currency:'CNY'});
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
  const first=await request('/chat','POST',{message:original,requestId:'harness-balance-start'});
  assert.equal(first.status,200);assert.match(first.body.content,/现金保持不变/);assert.equal(upstream.calls.length,1);assert.equal(first.body.ledgerEntries.length,0);
  const second=await request('/chat','POST',{message:'现金 -1000 其他的不管',conversationId:first.body.conversation.id,requestId:'harness-balance-cash'});
  assert.equal(second.status,200);assert.equal(second.body.state.assets[1].quantity,23671.48);assert.equal(second.body.state.assets[1].costBasis.amount,26372.4);assert.equal(second.body.state.assets[0].value,9000);assert.equal(second.body.ledgerEntries.length,1);
  assert.equal(upstream.calls.length,4);assert.ok(upstream.calls[0].tools.some(t=>t.function.name==='set_holding_balance'));
  const replay=await request('/chat','POST',{message:'现金 -1000 其他的不管',conversationId:first.body.conversation.id,requestId:'harness-balance-cash'});
  assert.equal(replay.status,200);assert.equal(replay.body.state.assets[0].value,9000);assert.equal(upstream.calls.length,4);
});
test('harness 原样回放科创50亏损校准，短答不变后正确保存24775.11份，不重复询问标的',async t=>{
  const original='科创50 的数据更新一下， 持仓收益率是 -百分之16.03 亏损时 4283.93';
  const replies=[original,'24775.11 份','单位成本 1.0790','不变'];
  const upstream=await modelServer(t,(payload,n)=>{
    if(n<=4)return toolReply('set_holding_balance',{
      query:'科创50',assetId:'star',evidence:replies.slice(0,n).join('；'),
      // The model initially invents quantity/cost, then supplies a wrong quantity
      // on the last turn. Only the user's original numbers can correct it.
      quantity:n===1?24775.11094581:n===4?11:24775.11,averageCost:n<=2?1.0787:1.079,cashDelta:0
    });
    const result=JSON.parse(payload.messages.at(-1).content);
    assert.equal(result.status,'applied');assert.equal(result.after.quantity,24775.11);assert.equal(result.after.cost,26732.34);
    return {content:'已校准科创50持仓，现金保持不变。'};
  });
  const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state(),date='2026-11-03';
  state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'star',name:'科创50基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',value:200,quantity:100,unit:'份',asOf:date}];
  app.store.save(state,state.revision);app.store.setKV('fund_nav:011609',{date,price:0.9061,basis:'unit_nav',currency:'CNY'});
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
  let conversationId,result;
  for(let i=0;i<replies.length;i++){
    result=await request('/chat','POST',{message:replies[i],...(conversationId?{conversationId}:{}),requestId:'star-exact-'+i});
    assert.equal(result.status,200);conversationId=result.body.conversation.id;
    if(i<3){
      assert.match(result.body.content,[/总份额|总股数/,/单位成本/,/现金保持不变/][i]);
      assert.equal(result.body.ledgerEntries.length,0);assert.equal(result.body.state.assets[1].quantity,100);
    }
  }
  assert.equal(upstream.calls.length,5);assert.match(result.body.content,/已校准/);
  assert.equal(result.body.state.assets[1].quantity,24775.11);assert.equal(result.body.state.assets[1].costBasis.amount,26732.34);
  assert.equal(result.body.state.assets[0].value,10000);assert.equal(result.body.ledgerEntries.length,1);
  const replay=await request('/chat','POST',{message:'不变',conversationId,requestId:'star-exact-3'});
  assert.equal(replay.status,200);assert.equal(replay.body.ledgerEntries.length,1);assert.equal(upstream.calls.length,5);
});
test('harness 本地核验能恢复超过6轮的未完成校准，模型上下文仍限定最近6轮',async t=>{
  const original='科创50 的数据更新一下， 持仓收益率是 -百分之16.03 亏损时 4283.93';
  const upstream=await modelServer(t,(payload,n)=>{
    if(n===1){
      assert.ok(!payload.messages.some(m=>m.content===original));
      assert.equal(payload.messages.filter(m=>m.role==='user').length,7);
      return toolReply('set_holding_balance',{query:'科创50',evidence:'科创50'});
    }
    const result=JSON.parse(payload.messages.at(-1).content);
    assert.equal(result.status,'applied');assert.equal(result.after.quantity,24775.11);assert.equal(result.after.cost,26732.34);
    return {content:'已承接之前确认的资料完成校准。'};
  });
  const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state(),date='2026-11-03';
  state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'star',name:'科创50基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',value:200,quantity:100,unit:'份',asOf:date}];
  app.store.save(state,state.revision);
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
  const scopeId=app.store.config().scopeId,thread=app.store.createConversation(scopeId,original);
  const turns=[
    [original,'更新后的总份额／总股数是多少？'],
    ['24775.11 份','更新后的单位成本是多少？未知时可以先留空。'],
    ['单位成本 1.0790','现金保持不变，还是另有明确的现金调整金额？'],
    ['不变','你要按最新总份额校准哪一项持仓？'],
    ['科创50','你要按最新总份额校准哪一项持仓？'],
    ['啥意思','你要按最新总份额校准哪一项持仓？'],
    ['科创50','你要按最新总份额校准哪一项持仓？']
  ];
  for(const [question,answer]of turns)app.store.addConversation(question,answer,state.revision,{scopeId,conversationId:thread.id,aiChat:true,toolCalls:[{name:'set_holding_balance',output:{status:'needs_information',question:answer}}]});
  const result=await request('/chat','POST',{message:'科创50',conversationId:thread.id,requestId:'star-legacy-long'});
  assert.equal(result.status,200);assert.match(result.body.content,/完成校准/);assert.equal(result.body.state.assets[1].quantity,24775.11);
  assert.equal(result.body.state.assets[0].value,10000);assert.equal(result.body.ledgerEntries.length,1);assert.equal(upstream.calls.length,2);
});
test('Pi 完成模型→只读计算→模型回答，45% 买入后变为 55%，账本不变',async t=>{
  const upstream=await modelServer(t,(payload,n)=>{
    if(n===1)return toolReply('assess_financial_action',{kind:'buy',amount:10000,source:'cash'});
    const result=JSON.parse(payload.messages.at(-1).content);
    assert.equal(result.status,'calculated');assert.equal(result.before.stockRatio,45);assert.ok(Math.abs(result.after.stockRatio-55)<1e-8);assert.ok(result.rules.some(r=>r.id==='stock-caution'));
    return {role:'assistant',content:'买入后股票比例为 55%，超过你设置的 50% 谨慎线，建议谨慎。'};
  });
  const {request,app}=await setup(t,{disableAuth:true}),s=app.store.state();
  s.profile={...s.profile,income:30000,expenses:10000};s.assets=[{id:'cash',name:'私密现金昵称',account:'私密账户',type:'cash',value:55000,currency:'CNY',asOf:'2026-10-23'},{id:'stock',name:'私密持仓昵称',type:'stock',value:45000,currency:'CNY',asOf:'2026-10-23'}];
  app.store.save(s,0);const before=JSON.stringify(app.store.state());
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'tool-model',apiKey:'FAKE_KEY',consent:true,useTools:true});
  const result=await request('/chat','POST',{message:'用现有现金买入 10000 元平安'});
  assert.equal(result.status,200);assert.equal(result.body.mode,'ai');assert.match(result.body.content,/55%/);assert.equal(result.body.messages.length,2);assert.equal(result.body.toolsUsed[0].ok,true);assert.equal(result.body.config.connection.tools,true);
  assert.equal(JSON.stringify(app.store.state()),before);assert.equal(upstream.calls.length,2);assert.ok(upstream.calls[0].tools.some(t=>t.function.name==='assess_financial_action'));assert.ok(!JSON.stringify(upstream.calls).includes('私密'));
});
test('未配置、未授权和上游失败均不生成虚假的 AI 回复',async t=>{
  const {request,app}=await setup(t,{disableAuth:true});
  assert.equal((await request('/chat','POST',{message:'你好'})).status,409);
  const upstream=await modelServer(t,()=>{throw new Error('simulate failure');});
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'fake',consent:false});
  assert.equal((await request('/chat','POST',{message:'你好'})).status,403);assert.equal(upstream.calls.length,0);
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'fake',consent:true});
  const failed=await request('/chat','POST',{message:'买车可以吗'});assert.equal(failed.status,502);assert.match(failed.body.error,/503/);assert.equal(failed.body.config.connection.ok,false);assert.equal(app.store.messages().length,0);
});
test('连续追问使用最新财务快照，授权或连接变化后不沿用旧对话',async t=>{
  const upstream=await modelServer(t,(_payload,n)=>({role:'assistant',content:`回答 ${n}`})),{request,app}=await setup(t,{disableAuth:true});
  const config={baseUrl:upstream.baseUrl,model:'fake',consent:true,includeHistory:true};await request('/config','PUT',config);
  await request('/chat','POST',{message:'第一轮问题'});
  let s=app.store.state();s.profile.income=42000;app.store.save(s,s.revision);
  await request('/chat','POST',{message:'接着聊'});
  assert.ok(upstream.calls[1].messages.some(m=>m.content==='第一轮问题'));assert.ok(upstream.calls[1].messages.some(m=>m.content==='回答 1'));assert.ok(upstream.calls[1].messages[0].content.includes('"income":42000'));
  await request('/config','PUT',{...config,includeHoldings:true});
  assert.equal((await request('/bootstrap')).body.messages.length,0);
  await request('/chat','POST',{message:'新授权问题'});assert.ok(!JSON.stringify(upstream.calls[2]).includes('第一轮问题'));
  assert.equal(app.store.messages().length,6);
});
test('未授权最近对话时不外发历史，也不把旧版本的本地回复传给模型',async t=>{
  const upstream=await modelServer(t,()=>({role:'assistant',content:'测试回复'})),{request,app}=await setup(t,{disableAuth:true});
  app.store.db.prepare('INSERT INTO messages(id,role,content,mode,created_at) VALUES(?,?,?,?,?)').run('legacy','assistant','旧版本地内容','local',new Date().toISOString());
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'fake',consent:true,includeHistory:false});
  await request('/chat','POST',{message:'不应自动重发的历史问题'});await request('/chat','POST',{message:'本轮问题'});
  assert.ok(!JSON.stringify(upstream.calls[1]).includes('不应自动重发'));assert.ok(!JSON.stringify(upstream.calls).includes('旧版本地内容'));
});
test('保存并测试验证真正的工具往返，只发空白测试档案，修改模型使验证失效',async t=>{
  const upstream=await modelServer(t,(payload,n)=>n===1?toolReply('get_stock_budget',{}):{role:'assistant',content:'工具连接正常'}),{request,app}=await setup(t,{disableAuth:true});
  const s=app.store.state();s.profile.income=987654;s.profile.background={constraints:'不应传入测试的家庭信息'};app.store.save(s,0);
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'fake',consent:false});
  const result=await request('/config/test','POST',{});assert.equal(result.status,200);assert.equal(result.body.config.connection.tools,true);assert.ok(!JSON.stringify(upstream.calls).includes('987654'));assert.ok(!JSON.stringify(upstream.calls).includes('不应传入测试'));
  assert.equal(app.store.messages().length,0);await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'another',consent:false});assert.equal(app.store.config().connection,null);
});
test('模型只返回文字时不能把工具连接标记为成功',async t=>{
  const upstream=await modelServer(t,()=>({role:'assistant',content:'OK'})),{request}=await setup(t,{disableAuth:true});
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'text-only',consent:true});
  const test=await request('/config/test','POST',{});assert.equal(test.status,502);assert.equal(test.body.config.connection.ok,false);
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'text-only',consent:true,useTools:false});
  const text=await request('/config/test','POST',{});assert.equal(text.status,200);assert.equal(text.body.config.connection.tools,false);
});
test('保险与选填背景经 CSV 导入、保存、导出恢复后仍保留',async t=>{
  const {request,app}=await setup(t,{disableAuth:true});
  const csv='name,type,currency,value,asOf,insuranceKind,sumAssured,premiumAmount,premiumFrequency,premiumInExpenses\n储蓄保险,insurance,CNY,80000,2026-10-23,savings,1000000,12000,yearly,false\n';
  const preview=await request('/import/preview','POST',{csv});assert.equal(preview.status,200);assert.equal(preview.body.assets[0].inPool,false);
  await request('/import','POST',{assets:preview.body.assets,revision:0});
  const s=app.store.state();s.profile={...s.profile,income:30000,expenses:10000,background:{scope:'household',dependents:2,priorities:'五年后退休'}};
  await request('/state','PUT',{state:s,revision:s.revision});const backup=(await request('/export')).body;
  const restored=await request('/restore/preview','POST',backup);assert.equal(restored.body.state.assets[0].insurance.sumAssured,1000000);assert.equal(restored.body.state.profile.background.dependents,2);
  const view=(await request('/bootstrap')).body;assert.equal(view.metrics.totalAssets,80000);assert.equal(view.metrics.availableCash,0);assert.equal(view.metrics.surplus,19000);
});

test('响应等待时间经接口校验并持久化，单独修改不丢失密钥和对话范围',async t=>{
  const {request,app}=await setup(t,{disableAuth:true});
  let result=await request('/config','PUT',{baseUrl:'https://example.com/v1',model:'model',apiKey:'FAKE_TIMEOUT_KEY',consent:true,includeHistory:true});
  assert.equal(result.body.config.requestTimeoutSeconds,120);
  const scope=result.body.config.scopeId;
  result=await request('/config','PUT',{baseUrl:'https://example.com/v1',model:'model',consent:true,includeHistory:true,requestTimeoutSeconds:180});
  assert.equal(result.body.config.requestTimeoutSeconds,180);assert.equal(result.body.config.scopeId,scope);assert.equal(result.body.config.hasKey,true);assert.equal(app.store.config({secret:true}).apiKey,'FAKE_TIMEOUT_KEY');
  assert.equal((await request('/config','PUT',{baseUrl:'https://example.com/v1',model:'model',requestTimeoutSeconds:1})).status,400);
  assert.equal(app.store.config().requestTimeoutSeconds,180);
});

test('本地行情搜索、报价和私人资产历史都保留登录保护，历史按资产身份读取',async t=>{
 const {request,app}=await setup(t);
 for(const path of ['/market/search?q=test','/market/history?id=f'])assert.equal((await request(path)).status,401);
 assert.equal((await request('/market/quote','POST',{market:'SH',symbol:'601318'})).status,401);
 await request('/auth/setup','POST',{password:'test-password-only'});
 const s=app.store.state();s.assets=[{id:'f',name:'Synthetic',type:'fund',currency:'CNY',value:100,asOf:'2026-10-23',quantity:100,unit:'份',fund:{code:'123456',autoNav:true}}];app.store.save(s,s.revision);
 app.store.recordPrice('FUND.123456',{date:'2026-10-23',price:1,previous:{price:.9},currency:'CNY'});
 const r=await request('/market/history?id=f');assert.equal(r.status,200);assert.equal(r.body.items.length,1);assert.equal(r.body.items[0].price,1);
 assert.equal((await request('/market/history?id=unknown')).status,404);
});

test('SSE 先发送思考和文字片段，完成后才保存完整对话，不发送思考内容或密钥',async t=>{
 let release;const wait=new Promise(r=>release=r);
 const upstream=createServer(async(req,res)=>{
   let body='';for await(const part of req)body+=part;assert.equal(JSON.parse(body).stream,true);
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const write=delta=>res.write('data: '+JSON.stringify({choices:[{delta}]})+'\n\n');
   write({reasoning_content:'SYNTHETIC_HIDDEN_REASONING'});write({content:'第一部分'});
   await wait;write({content:'，第二部分。'});
   res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
 const {app,request,base}=await setup(t,{disableAuth:true});
 await request('/config','PUT',{baseUrl:`http://127.0.0.1:${upstream.address().port}`,model:'synthetic',apiKey:'FAKE_STREAM_KEY',consent:true});
 const before=JSON.stringify(app.store.state());
 const response=await fetch(base+'/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'虚构流式测试'}),signal:AbortSignal.timeout(5000)});
 assert.match(response.headers.get('content-type'),/text\/event-stream/);const events=[];
 await readEventStream(response.body,event=>{
   const payload=JSON.parse(event.data);events.push({event:event.event,...payload});
   if(event.event==='delta'&&payload.text==='第一部分'){assert.equal(app.store.messages().length,0);release();}
 });
 assert.equal(events[0].stage,'thinking');assert.equal(events.filter(e=>e.event==='delta').map(e=>e.text).join(''),'第一部分，第二部分。');assert.equal(events.at(-1).event,'done');assert.equal(app.store.messages().length,2);assert.equal(app.store.messages()[1].content,'第一部分，第二部分。');
 assert.ok(!JSON.stringify(events).includes('FAKE_STREAM_KEY'));assert.ok(!JSON.stringify(events).includes('HIDDEN_REASONING'));assert.equal(JSON.stringify(app.store.state()),before);
});

test('SSE 上游中断会发送错误，部分回答不会保存为成功对话',async t=>{
 const upstream=createServer(async(req,res)=>{
   for await(const _part of req){}res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"部分文字"}}]}\n\n');
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
 const {app,request,base}=await setup(t,{disableAuth:true});
 await request('/config','PUT',{baseUrl:`http://127.0.0.1:${upstream.address().port}`,model:'synthetic',consent:true});
 const response=await fetch(base+'/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"message":"测试中断"}'}),events=[];
 await readEventStream(response.body,event=>events.push({event:event.event,...JSON.parse(event.data)}));
 assert.ok(events.some(e=>e.event==='delta'));assert.equal(events.at(-1).event,'error');assert.equal(events.at(-1).code,'AI_STREAM');assert.equal(app.store.messages().length,0);assert.ok(!events.some(e=>e.event==='done'));
});

test('显式停止回答取消上游生成，释放问答占用且不保存部分回答',async t=>{
 let closed;const disconnected=new Promise(r=>closed=r);
 const upstream=createServer(async(req,res)=>{
   for await(const _part of req){}res.on('close',closed);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"部分文字"}}]}\n\n');
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
 const {app,request,base}=await setup(t,{disableAuth:true});
 await request('/config','PUT',{baseUrl:`http://127.0.0.1:${upstream.address().port}`,model:'synthetic',consent:true});
 const controller=new AbortController(),response=await fetch(base+'/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"message":"测试停止"}',signal:controller.signal});
 await assert.rejects(readEventStream(response.body,event=>{if(event.event==='delta')controller.abort();}),e=>e.name==='AbortError');
 await request('/chat/stop','POST',{});await disconnected;assert.equal(app.store.messages().length,0);
 const unconfigured={...(await request('/bootstrap')).body.config,baseUrl:'',model:''};await request('/config','PUT',unconfigured);
 assert.equal((await request('/chat','POST',{message:'下一轮'})).status,409);
});

test('断开 SSE 后回答继续运行，重新连接原任务不会重发问题或重复保存',async t=>{
 let release,calls=0;const waiting=new Promise(r=>release=r);t.after(()=>release());
 const upstream=createServer(async(req,res)=>{
   for await(const _part of req){}calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.write('data: {"choices":[{"delta":{"content":"已保存的片段"}}]}\n\n');await waiting;
   res.end('data: {"choices":[{"delta":{"content":"，回答完成。"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
 const {app,request,base}=await setup(t,{disableAuth:true});await request('/config','PUT',{baseUrl:`http://127.0.0.1:${upstream.address().port}`,model:'synthetic',consent:true});
 const controller=new AbortController(),first=await fetch(base+'/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"message":"虚构重连测试","requestId":"reconnect-one"}',signal:controller.signal});let id;
 await assert.rejects(readEventStream(first.body,event=>{const value=JSON.parse(event.data);if(event.event==='run')id=value.id;if(event.event==='delta')controller.abort();}),e=>e.name==='AbortError');
 const progress=(await request('/chat/run')).body;assert.equal(progress.run.id,id);assert.equal(progress.run.status,'running');assert.equal(progress.run.text,'已保存的片段');assert.equal(app.store.messages().length,0);assert.equal(calls,1);
 const second=await fetch(base+'/api/chat/stream?run='+id,{signal:AbortSignal.timeout(5000)}),events=[];release();
 await readEventStream(second.body,event=>events.push({type:event.event,...JSON.parse(event.data)}));assert.equal(events.at(-1).type,'done');assert.equal(app.store.messages().length,2);assert.equal(app.store.messages()[1].content,'已保存的片段，回答完成。');assert.equal(calls,1);
 await request('/chat','POST',{message:'虚构重连测试',requestId:'reconnect-one'});assert.equal(calls,1);assert.equal(app.store.messages().length,2);
});

test('私人头像需登录访问、文件留在数据目录且不进入财务导出',async t=>{
 const {app,request,base,dir}=await setup(t);const photo=Buffer.from([255,216,255,217]);
 mkdirSync(join(dir,'profile'),{mode:0o700});writeFileSync(join(dir,'profile','avatar.jpg'),photo,{mode:0o600});app.store.setKV('profile_avatar_version','synthetic-version');
 assert.equal((await fetch(base+'/api/profile/avatar')).status,401);assert.equal((await fetch(base+'/profile/avatar.jpg')).status,404);
 const login=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-password-only'})}),cookie=login.headers.get('set-cookie').split(';')[0];await login.body.cancel();
 const response=await fetch(base+'/api/profile/avatar',{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.match(response.headers.get('cache-control'),/private/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),photo);
 const view=await fetch(base+'/api/bootstrap',{headers:{Cookie:cookie}}).then(r=>r.json());assert.equal(view.avatarUrl,'/api/profile/avatar?v=synthetic-version');
 const backup=await fetch(base+'/api/export',{headers:{Cookie:cookie}}).then(r=>r.json());assert.ok(!JSON.stringify(backup).includes('avatar'));assert.equal(backup.state.assets.length,0);
});

test('market summary routes require login and enabling AI, and cached summaries are returned without leaking credentials',async t=>{
 const {app,request}=await setup(t);assert.equal((await request('/market-briefs')).status,401);assert.equal((await request('/market-briefs/generate','POST',{market:'US'})).status,401);await request('/auth/setup','POST',{password:'test-password-only'});
 app.store.setKV('market_daily_briefs',[{market:'US',date:'2026-10-23',facts:{headline:'上涨',publicLines:['指数上涨']},ai:{status:'complete',scope:'market_only',summary:{headline:'已缓存',points:['沿用本地结果']}}}]);
 assert.equal((await request('/market-briefs?date=2026-10-23')).body.latest[0].ai.summary.headline,'已缓存');assert.equal((await request('/bootstrap')).body.marketBriefs.latest.length,1);assert.equal((await request('/market-briefs?date=bad-date')).status,400);assert.equal((await request('/market-briefs/generate','POST',{market:'US'})).status,409);
 const c=await request('/config','PUT',{baseUrl:'https://example.com/v1',model:'mock',apiKey:'FAKE_SECRET',consent:true,marketBriefsAI:true});assert.equal(c.body.config.marketBriefsAI,true);assert.ok(!JSON.stringify(c.body).includes('FAKE_SECRET'));
});

test('并发生成日报共用一次模型请求，完成后允许重新生成',async t=>{
 let release;const gate=new Promise(r=>release=r);
 const upstream=await modelServer(t,async()=>{await gate;return {role:'assistant',content:'本机模拟日报'};});
 const {request,app}=await setup(t,{disableAuth:true});
 await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'mock-report',consent:true,autoReport:true});
 let incoming=0,entered;const bothEntered=new Promise(r=>entered=r);
 app.server.on('request',req=>{if(req.url==='/api/reports')req.on('end',()=>{if(++incoming===2)entered();});});
 const first=request('/reports','POST',{});
 while(!upstream.calls.length)await new Promise(r=>setImmediate(r));
 const second=request('/reports','POST',{});
 // Both request bodies are read before releasing the upstream response.
 await bothEntered;await new Promise(r=>setImmediate(r));release();
 const results=await Promise.all([first,second]);
 assert.equal(upstream.calls.length,1);assert.ok(results.every(r=>r.status===200));assert.equal(results[0].body.report.generatedAt,results[1].body.report.generatedAt);assert.equal(app.store.reports().length,1);
 await request('/reports','POST',{});assert.equal(upstream.calls.length,2);
});

test('历史对话可切换与单独删除，连续追问只发送当前对话最近六轮',async t=>{
  const upstream=await modelServer(t,(_payload,n)=>({role:'assistant',content:`虚构回答 ${n}`})),{request,app}=await setup(t,{disableAuth:true});
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'fake',consent:true,includeHistory:true});
  const first=(await request('/chat','POST',{message:'A 独立问题 0',conversationId:null})).body,id=first.conversation.id;
  for(let i=1;i<=7;i++)assert.equal((await request('/chat','POST',{message:`A 独立问题 ${i}`,conversationId:id})).status,200);
  const last=upstream.calls.at(-1).messages;
  assert.ok(!last.some(m=>m.content==='A 独立问题 0'));assert.ok(last.some(m=>m.content==='A 独立问题 1'));
  const second=(await request('/chat','POST',{message:'B 完全不同的话题',conversationId:null})).body;
  assert.notEqual(second.conversation.id,id);assert.ok(!JSON.stringify(upstream.calls.at(-1)).includes('A 独立问题'));
  let old=(await request('/conversations?id='+id)).body;
  assert.equal(old.messages.length,16);assert.equal(old.conversations.length,2);assert.equal(old.conversation.title,'A 独立问题 0');
  await request('/chat','POST',{message:'A 继续讨论',conversationId:id});
  assert.ok(upstream.calls.at(-1).messages.some(m=>m.content==='A 独立问题 7'));assert.ok(!JSON.stringify(upstream.calls.at(-1)).includes('B 完全不同'));
  const before=JSON.stringify(app.store.state({raw:true}));
  assert.equal((await request('/conversations','DELETE',{id})).status,200);
  assert.equal((await request('/conversations?id='+id)).status,404);
  assert.equal((await request('/chat','POST',{message:'不能复活',conversationId:id})).status,404);
  old=(await request('/conversations?id='+second.conversation.id)).body;assert.equal(old.messages.length,2);assert.equal(old.conversations.length,1);
  assert.equal(JSON.stringify(app.store.state({raw:true})),before);
  assert.equal((await request('/chat','DELETE',{})).status,200);assert.equal((await request('/conversations')).body.conversations.length,0);
});

test('连接变更后历史仍可本机查看，但不能把旧授权下的上下文外发',async t=>{
  const upstream=await modelServer(t,()=>({role:'assistant',content:'虚构旧回复'})),{request}=await setup(t,{disableAuth:true});
  const config={baseUrl:upstream.baseUrl,model:'first-model',consent:true,includeHistory:true};
  await request('/config','PUT',config);
  const id=(await request('/chat','POST',{message:'旧授权内容',conversationId:null})).body.conversation.id;
  await request('/config','PUT',{...config,model:'new-model'});
  assert.equal((await request('/bootstrap')).body.messages.length,0);
  assert.equal((await request('/conversations?id='+id)).body.messages.length,2);
  assert.equal((await request('/chat','POST',{message:'新模型不能直接沿用',conversationId:id})).status,409);
  assert.equal(upstream.calls.length,1);
});

test('历史对话读写删除接口均需要登录',async t=>{
  const {request}=await setup(t);
  for(const [method,body] of [['GET',undefined],['POST',{}],['DELETE',{id:'any'}]])assert.equal((await request('/conversations',method,body)).status,401);
});

test('开启当前对话上下文后可接着原对话聊，关闭后仍可查看但不再外发历史',async t=>{
 const upstream=await modelServer(t,()=>({role:'assistant',content:'虚构回答'})),{request}=await setup(t,{disableAuth:true});
 const config={baseUrl:upstream.baseUrl,model:'same-model',consent:true,includeHistory:false};await request('/config','PUT',config);
 const first=(await request('/chat','POST',{message:'本对话的用钱目的',conversationId:null})).body;
 const enabled=(await request('/config','PUT',{...config,includeHistory:true})).body;
 assert.equal(enabled.config.scopeId,first.config.scopeId);assert.equal(enabled.conversation.id,first.conversation.id);
 await request('/chat','POST',{message:'记得用途吗',conversationId:first.conversation.id});assert.ok(upstream.calls.at(-1).messages.some(m=>m.content==='本对话的用钱目的'));
 await request('/config','PUT',config);await request('/chat','POST',{message:'关闭上下文后的独立问题',conversationId:first.conversation.id});
 assert.ok(!JSON.stringify(upstream.calls.at(-1)).includes('本对话的用钱目的'));assert.equal((await request('/conversations?id='+first.conversation.id)).body.messages.length,6);
});

test('monthly public-market data requires login, serves the local component, and does not change portfolio state',async t=>{
  const {request,app,base}=await setup(t);
  assert.equal((await request('/markets/monthly')).status,401);assert.equal((await request('/markets/monthly/refresh','POST',{})).status,401);
  await request('/auth/setup','POST',{password:'synthetic-password-only'});
  const revision=app.store.state().revision;
  const empty=(await request('/markets/monthly')).body;assert.equal(empty.rows.length,3);assert.equal(empty.completedSamples,0);
  const current=new Date(),period=current.toISOString().slice(0,7);
  app.store.setKV('nasdaq_monthly',{attemptedAt:current.toISOString(),updatedAt:current.toISOString(),points:[{period,date:current.toISOString().slice(0,10),close:100,complete:false}]});
  const cached=await request('/markets/monthly/refresh','POST',{});assert.equal(cached.status,200);assert.equal(cached.body.symbol,'IXIC');assert.equal(app.store.state().revision,revision);
  const component=await fetch(base+'/monthly-performance.js');assert.equal(component.status,200);assert.match(await component.text(),/monthlyPageHTML/);
});

test('watchboard APIs require authentication, validate modes and serve local logos without expanding external script access',async t=>{
  const {app,request,base}=await setup(t);
  assert.equal((await request('/markets/watchboard')).status,401);assert.equal((await request('/markets/watchboard/refresh','POST',{mode:'latest'})).status,401);
  await request('/auth/setup','POST',{password:'synthetic-password-only'});
  const revision=app.store.state().revision;
  let result=await request('/markets/watchboard?mode=close');assert.equal(result.status,200);assert.equal(result.body.mode,'close');assert.equal(result.body.total,116);assert.equal(result.body.available,0);
  assert.equal((await request('/markets/watchboard?mode=extended')).status,400);assert.equal((await request('/markets/watchboard/refresh','POST',{mode:'extended'})).status,400);
  app.store.setKV('us_watchboard',{attemptedAt:{latest:new Date().toISOString()}});
  result=await request('/markets/watchboard/refresh','POST',{mode:'latest'});assert.equal(result.status,200);assert.equal(app.store.state().revision,revision);
  for(const path of ['/watchboard.js','/watchboard-logos.js','/logos/apple.svg','/logos/LICENSE.txt']){const r=await fetch(base+path);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);await r.body.cancel();}
  assert.equal((await fetch(base+'/logos/missing.svg')).status,404);assert.equal((await fetch(base+'/logos/%2e%2e%2fsrc%2fstore.mjs')).status,404);
});

test('harness 承接成本是和份额是，单位成本补答后完成同一笔校准且现金不变',async t=>{
  const original='科创50 我需要更新一下持仓， 持仓收益率是 -百分之16.03 其他都不变';
  const details='成本是 1.0790 份额是 24775.11    持仓收益率是 -百分之16.03';
  const upstream=await modelServer(t,(payload,n)=>{
    if(n===1)return {content:'显示的成本金额（或持仓金额）是多少？有这一个数我就能直接把账本校准到位。'};
    if(n<=3)return toolReply('set_holding_balance',{query:'科创50',assetId:'star',evidence:n===2?details:'成本是 1.0790',quantity:24775.11,averageCost:1.079,cashDelta:0});
    const result=JSON.parse(payload.messages.at(-1).content);
    assert.equal(result.status,'applied');assert.equal(result.after.quantity,24775.11);assert.equal(result.after.cost,26732.34);
    return {content:'已按单位成本1.0790与24775.11份完成校准，现金保持不变。'};
  });
  const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state(),date='2026-11-03';
  state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:10000,asOf:date},{id:'star',name:'科创50基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',value:200,quantity:100,unit:'份',asOf:date}];
  app.store.save(state,state.revision);
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
  const first=await request('/chat','POST',{message:original,requestId:'prefixed-start'});
  const conversationId=first.body.conversation.id;
  const second=await request('/chat','POST',{message:details,conversationId,requestId:'prefixed-details'});
  assert.equal(second.status,200);assert.match(second.body.content,/单位成本/);assert.equal(second.body.ledgerEntries.length,0);
  const third=await request('/chat','POST',{message:'成本是 1.0790',conversationId,requestId:'prefixed-cost'});
  assert.equal(third.status,200);assert.match(third.body.content,/完成校准/);assert.equal(third.body.ledgerEntries.length,1);
  assert.equal(third.body.state.assets[1].quantity,24775.11);assert.equal(third.body.state.assets[1].costBasis.amount,26732.34);assert.equal(third.body.state.assets[0].value,10000);assert.equal(upstream.calls.length,4);
});

test('harness 删除工具按范围补答执行，持仓自选独立且不会再转交手动操作',async t=>{
  const upstream=await modelServer(t,(payload,n)=>{
    assert.ok(payload.tools.some(t=>t.function.name==='remove_instrument'));
    if(n===1||n===2)return toolReply('remove_instrument',{query:'科创',target:n===1?'holding':'watchlist'});
    const result=JSON.parse(payload.messages.at(-1).content);assert.equal(result.status,'applied');assert.equal(result.target,'watchlist');
    return {content:'已移除科创自选基金。'};
  });
  const {request,app}=await setup(t,{disableAuth:true}),state=app.store.state(),date='2026-11-03';
  state.assets=[{id:'star',name:'科创基金',type:'fund',fund:{code:'011609',autoNav:true},currency:'CNY',value:0,quantity:0,unit:'份',asOf:date}];state.fundWatchlist=[{code:'011609',name:'科创基金'}];app.store.save(state,state.revision);
  await request('/config','PUT',{baseUrl:upstream.baseUrl,model:'synthetic',consent:true,includeHistory:true,allowLedgerWrites:true});
  const first=await request('/chat','POST',{message:'删除科创',requestId:'remove-start'});
  assert.equal(first.status,200);assert.match(first.body.content,/持仓.*自选/);assert.equal(first.body.ledgerEntries.length,0);
  const conversationId=first.body.conversation.id;
  const second=await request('/chat','POST',{message:'自选',conversationId,requestId:'remove-watch'});
  assert.equal(second.status,200);assert.equal(second.body.state.fundWatchlist.length,0);assert.equal(second.body.state.assets.length,1);assert.match(second.body.content,/已移除/);assert.equal(upstream.calls.length,3);
  const replay=await request('/chat','POST',{message:'自选',conversationId,requestId:'remove-watch'});assert.equal(replay.body.ledgerEntries.length,1);assert.equal(upstream.calls.length,3);
});

test('保存月末支出设置后执行到期扣减，刷新与重复保存不重复，页面返回记账状态',async t=>{
  const {request}=await setup(t,{disableAuth:true});
  let view=(await request('/bootstrap')).body;
  view.state.assets=[{id:'cash',name:'现金',type:'cash',currency:'CNY',value:30000}];
  view.state.profile.expenses=5500;
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:view.state.preferences.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const previousEnd=new Date(Date.UTC(+day.slice(0,4),+day.slice(5,7)-1,0)).toISOString().slice(0,10);
  view.state.profile.autoExpenses={enabled:true,cashAssetId:'cash',startsOn:previousEnd,lastPeriod:''};
  const dueCount=+day.slice(-2)===new Date(Date.UTC(+day.slice(0,4),+day.slice(5,7),0)).getUTCDate()?2:1;
  let response=await request('/state','PUT',{state:view.state,revision:view.state.revision});
  assert.equal(response.status,200);view=response.body;
  assert.equal(view.state.assets[0].value,30000-dueCount*5500);
  assert.equal(view.expenseSchedule.debits.length,dueCount);
  response=await request('/state','PUT',{state:view.state,revision:view.state.revision});
  assert.equal(response.status,200);assert.equal(response.body.state.assets[0].value,view.state.assets[0].value);
  assert.equal((await request('/bootstrap')).body.expenseSchedule.debits.length,dueCount);
});
