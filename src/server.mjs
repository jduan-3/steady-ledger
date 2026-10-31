import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { validateState, calculate, evaluate, demoState, parseCSV, CSV_HEADER, nowDate } from './domain.mjs';
import { openStore } from './store.mjs';
import { validateConfig, explain, requireAI, testConnection } from './ai.mjs';
import { refreshFundNAV } from './funds.mjs';
import { dailyValuation } from './valuation.mjs';
import { searchSecurities, refreshStocks, refreshFX } from './market.mjs';
import { security } from './securities.mjs';
import { refreshMarketOverview, marketOverview } from './markets.mjs';
import { monthlyPerformance, refreshMonthlyPerformance } from './monthly-performance.mjs';
import { watchboard, refreshWatchboard } from './watchboard.mjs';
import { createMarketBriefGenerator, readMarketBriefs, saveMarketBriefs } from './market-briefs.mjs';
import { createAssistantServices } from './market-access.mjs';
import { stockDetails } from './instrument-details.mjs';
import { createAssistantRuns } from './assistant-runs.mjs';
import { buildAssistantData } from './assistant-data.mjs';
import { createLedgerService } from './ledger.mjs';
import { fundReference, refreshFundReference } from './fund-reference.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let size = 0, out = ''; for await (const part of req) { size += part.length; if (size > 2e6) { const e = new Error('请求过大'); e.status = 413; throw e; } out += part; }
  try { return JSON.parse(out || '{}'); } catch { throw new Error('请求需要为有效 JSON'); }
}
const hash = x => createHash('sha256').update(x).digest('hex');
const passwordHash = (password, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(password, salt, 64).toString('hex') });

export function createApplication({ dataDir = process.env.DATA_DIR || join(root, 'data'), disableAuth = process.env.APP_PREVIEW === '1', schedule = true } = {}) {
  const store = openStore(dataDir), attempts = new Map();
  const marketBriefGenerator=createMarketBriefGenerator(store);
  const avatarPath=join(dataDir,'profile','avatar.jpg');
  const avatarUrl=()=>{const version=store.getKV('profile_avatar_version');return version&&existsSync(avatarPath)?'/api/profile/avatar?v='+encodeURIComponent(version):null;};
  const chatView = id => {
    const thread=id?store.conversation(id):store.latestConversation(store.config().scopeId);
    if(id&&!thread)throw Object.assign(new Error('对话不存在或已删除'),{status:404});
    return {conversation:thread,conversations:store.conversations(),messages:thread?store.messages(thread.id):[]};
  };
  const view = () => { const state = store.state(), metrics = calculate(state), history = store.history(); return { state, metrics, rules: evaluate(state, metrics), history, valuation: dailyValuation(state, metrics, history), incomeSchedule:store.incomeStatus(),ledgerEntries:store.ledgerEntries(), config: store.config(), reports: store.reports(), marketBriefs:readMarketBriefs(store), ...chatView(), chatRun:assistantRuns.view(), audit: store.audit(), avatarUrl:avatarUrl() }; };
  const authenticated = req => {
    if (disableAuth) return true;
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(x => x.startsWith('balance_session='))?.slice('balance_session='.length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const row = store.db.prepare('SELECT expires FROM sessions WHERE token=?').get(hash(token));
    return Boolean(row && row.expires > Date.now());
  };
  const secureCookie = req => req.socket.encrypted || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
  const setSession = (req, res) => { const token = randomBytes(32).toString('hex'); store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(token), Date.now() + 86400000); res.setHeader('Set-Cookie', `balance_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureCookie(req) ? '; Secure' : ''}`); };
  let pendingReport = false, reportTask = null;
  let pendingNAV = null;
  let pendingMarkets = null;
  const updateMarkets = (options={}) => pendingMarkets || (pendingMarkets=refreshMarketOverview(store,options).then(result=>{saveMarketBriefs(store);return result;}).finally(()=>{pendingMarkets=null;}));
  const ledger=createLedgerService(store);
  const assistantServices=(config,meta,control)=>({...createAssistantServices(store,{refreshOverview:updateMarkets,includeHoldings:config.includeHoldings||config.includePageData,includePageData:config.includePageData}),...(meta&&config.allowLedgerWrites?{...ledger.bind(meta,control),refreshLedgerContext:()=>({state:store.state(),pageData:config.includePageData?buildAssistantData(store):null}),ledgerWasChanged:()=>store.ledgerEntries({limit:5000}).some(e=>e.requestId===meta.requestId&&e.status==='applied')}:{} )});
  let pendingLedger=null;
  const assistantRuns=createAssistantRuns(store,{dataDir,services:assistantServices});
  const marketView=market=>({...marketOverview(store,market),brief:readMarketBriefs(store,{market}).latest.find(b=>b.market===market)||null});
  let pendingBriefs=null;
  const generateBriefs=(options={})=>pendingBriefs||(pendingBriefs=marketBriefGenerator.generate(store.config({secret:true}),options).finally(()=>{pendingBriefs=null;}));
  const updateNAV = (options = {}) => pendingNAV || (pendingNAV = (async () => {
    const funds = await refreshFundNAV(store, options), stocks = await refreshStocks(store, { force: options.force });
    await refreshFX(store);
    if (funds.updated || stocks.updated) store.snapshot(store.state());
    return { updated: funds.updated + stocks.updated, errors: [...funds.errors,...stocks.errors] };
  })().finally(() => { pendingNAV = null; }));
  function makeReport(late = false) {
    if (reportTask) return reportTask;
    reportTask = (async () => {
      const s = store.state(); const report = store.generateReport(s, { late });
      const config = store.config({ secret: true });
      if (config.autoReport && config.consent && config.baseUrl && config.model) {
        try { report.aiText = await explain(config, s, '根据这份快照生成今日财务总结，最多三项待办，不编造当日收益。', {services:assistantServices(config),pageData:config.includePageData?buildAssistantData(store,s):null}); }
        catch { report.aiError = 'AI 解读暂不可用，以下为完整的本地规则报告。'; }
        store.updateReport(report);
      }
      return report;
    })().finally(() => { reportTask = null; });
    return reportTask;
  }
  async function tick() {
    store.applyIncome();
    if (pendingReport) return;
    await Promise.all([updateNAV(),updateMarkets()]);
    await (pendingLedger||(pendingLedger=ledger.processPending().finally(()=>{pendingLedger=null;})));
    void generateBriefs().catch(()=>{});
    const s = store.state();
    if (!s.assets.length && !s.debts.length) return;
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: s.preferences.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format();
    if (time >= s.preferences.reportTime && !store.report(nowDate(s.preferences.timeZone))) { pendingReport = true; try { await makeReport(time !== s.preferences.reportTime); } finally { pendingReport = false; } }
  }
  const timer = schedule ? setInterval(() => tick().catch(() => {}), 60000) : null;
  timer?.unref();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, { error: '跨站请求已拒绝' }, 403);
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, { error: '跨站请求已拒绝' }, 403);
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, { error: '请求需要使用 application/json' }, 415);
      }
      if (path === '/api/auth/status' && req.method === 'GET') return json(res, { initialized: Boolean(store.getKV('auth')), authenticated: authenticated(req), preview: disableAuth });
      if (['/api/auth/setup','/api/auth/login'].includes(path) && req.method === 'POST') {
        if (disableAuth) return json(res, { ok: true });
        const { password } = await body(req);
        if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new Error('访问密码需要 8 至 200 个字符');
        const remote = req.socket.remoteAddress, attempt = attempts.get(remote) ?? { count: 0, until: Date.now() + 60000 };
        if (Date.now() > attempt.until) { attempt.count = 0; attempt.until = Date.now() + 60000; }
        if (++attempt.count > 10) return json(res, { error: '尝试过于频繁，请一分钟后重试' }, 429); attempts.set(remote, attempt);
        const auth = store.getKV('auth');
        if (path.endsWith('setup')) { if (auth) return json(res, { error: '已设置访问密码，请登录' }, 409); store.setKV('auth', passwordHash(password)); }
        else if (!auth || !timingSafeEqual(Buffer.from(auth.hash, 'hex'), Buffer.from(passwordHash(password, auth.salt).hash, 'hex'))) return json(res, { error: '访问密码不正确' }, 401);
        attempts.delete(remote); setSession(req, res); return json(res, { ok: true });
      }
      if (path.startsWith('/api/')) {
        if (!authenticated(req)) return json(res, { error: '请先登录' }, 401);
        if (path === '/api/bootstrap' && req.method === 'GET') return json(res, view());
        if(path==='/api/ledger/entries'&&req.method==='DELETE'){const {id}=await body(req);store.cancelLedgerEntry(id);return json(res,view());}
        if (path === '/api/markets/watchboard' && req.method === 'GET') return json(res,watchboard(store,{mode:url.searchParams.get('mode')||'latest'}));
        if (path === '/api/markets/watchboard/refresh' && req.method === 'POST') { const input=await body(req);return json(res,await refreshWatchboard(store,{mode:input.mode||'latest'})); }
        if (path === '/api/markets/monthly' && req.method === 'GET') return json(res, monthlyPerformance(store));
        if (path === '/api/markets/monthly/refresh' && req.method === 'POST') { const input=await body(req);return json(res, await refreshMonthlyPerformance(store,{force:input.force===true})); }
        if (path === '/api/markets' && req.method === 'GET') return json(res, marketView(url.searchParams.get('market')));
        if (path === '/api/market-briefs' && req.method === 'GET') return json(res,readMarketBriefs(store,{date:url.searchParams.get('date')||undefined}));
        if (path === '/api/market-briefs/generate' && req.method === 'POST') {
          const input=await body(req);if(input.market&&!['US','HK'].includes(input.market))throw new Error('请选择美国或港股市场');
          const c=store.config();requireAI(c);if(!c.marketBriefsAI)throw new Error('请先在AI设置中启用每日市场简报');
          await updateMarkets();void generateBriefs({market:input.market,force:true}).catch(()=>{});return json(res,readMarketBriefs(store));
        }
        if (path === '/api/markets/refresh' && req.method === 'POST') {
          const input=await body(req);if(!['US','HK'].includes(input.market))throw new Error('请选择美国或港股市场');
          await updateMarkets({force:input.force===true,live:true,market:input.market});if(!input.poll)void generateBriefs().catch(()=>{});return json(res,marketView(input.market));
        }
        if (path === '/api/profile/avatar' && req.method === 'GET') {
          if(!avatarUrl())return json(res,{error:'尚未设置头像'},404);
          const photo=await readFile(avatarPath);res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-cache'});return res.end(photo);
        }
        if (path === '/api/market/refresh' && req.method === 'POST') { await body(req); const result = await updateNAV({ retryFailed: true, force: true }); return json(res, { result, ...view() }); }
        if(path==='/api/market/fund-reference'&&req.method==='GET')return json(res,fundReference(store,url.searchParams.get('id')));
        if(path==='/api/market/fund-reference/refresh'&&req.method==='POST'){const input=await body(req);return json(res,await refreshFundReference(store,input.id));}
        if (path === '/api/market/search' && req.method === 'GET') return json(res, await searchSecurities(store, url.searchParams.get('q'), url.searchParams.get('market') || 'ALL'));
        if (path === '/api/market/quote' && req.method === 'POST') { const s=security(await body(req)); await refreshStocks(store,{keys:[s.key],force:true}); return json(res,{quote:store.getKV('stock_quote:'+s.key),attempt:store.getKV('stock_attempt:'+s.key)}); }
        if (path === '/api/market/history' && req.method === 'GET') {
          const a=store.state().assets.find(a=>a.id===url.searchParams.get('id'));if(!a)return json(res,{error:'资产不存在'},404);
          const instrument=a.fund?.autoNav?'FUND.'+a.fund.code:a.security?.key;
          return json(res,{items:instrument?store.priceHistory(instrument):[]});
        }
        if (path === '/api/market/details' && req.method === 'GET') {
          const a=store.state().assets.find(a=>a.id===url.searchParams.get('id'));
          if(!a)return json(res,{error:'资产不存在'},404);
          if(a.type!=='stock'||!a.security)return json(res,{status:'not_applicable'});
          return json(res,await stockDetails(store,a.security.key));
        }
        if (path === '/api/auth/logout' && req.method === 'POST') { const token = req.headers.cookie?.match(/balance_session=([a-f0-9]{64})/)?.[1]; if (token) store.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token)); res.setHeader('Set-Cookie', 'balance_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, { ok: true }); }
        if (path === '/api/state' && req.method === 'PUT') { const input = await body(req); store.save(input.state, input.revision, String(input.label || '更新财务档案').slice(0,100)); store.applyIncome(); return json(res, view()); }
        if (path === '/api/demo' && req.method === 'POST') { const { revision } = await body(req), s = store.state(); if (s.assets.length || s.debts.length) throw new Error('请先导出并清空现有档案，再载入演示'); store.save(demoState(), revision, '载入虚构演示数据'); return json(res, view()); }
        if (path === '/api/reset' && req.method === 'POST') { const { revision, confirmation } = await body(req); if (confirmation !== '清空财务档案') throw new Error('请输入完整确认文字'); store.reset(revision); await assistantRuns.invalidate(); store.clearMessages(); store.clearReports(); return json(res, view()); }
        if (path === '/api/undo' && req.method === 'POST') { const { id, revision } = await body(req); store.undo(Number(id), revision); return json(res, view()); }
        if (path === '/api/import/preview' && req.method === 'POST') { const { csv, kind: inputKind } = await body(req), kind = inputKind === 'debts' ? 'debts' : 'assets', state = store.state(), records = parseCSV(csv, kind); const map = new Map(state[kind].map(a => [a.id, a])); for (const a of records) map.set(a.id, a); const clean = validateState({ ...state, [kind]: [...map.values()] }); const validated = clean[kind].filter(a => records.some(x => x.id === a.id)); return json(res, { records: validated, ...(kind === 'assets' ? { assets: validated } : {}), kind, existing: records.filter(a => state[kind].some(x => x.id === a.id)).length, revision: state.revision }); }
        if (path === '/api/import' && req.method === 'POST') { const input = await body(req), kind = input.kind === 'debts' ? 'debts' : 'assets', records = input.records ?? input.assets, state = store.state(); if (!Array.isArray(records)) throw new Error('导入记录无效'); const map = new Map(state[kind].map(a => [a.id,a])); for (const a of records) map.set(a.id, a); store.save({ ...state, [kind]: [...map.values()] }, input.revision, 'CSV 导入（相同编号替换）'); return json(res, view()); }
        if (path === '/api/export' && req.method === 'GET') { const backup = { app: 'steady-finance', exportedAt: new Date().toISOString(), state: store.state() }; res.setHeader('Content-Disposition', 'attachment; filename="steady-backup.json"'); return json(res, backup); }
        if (path === '/api/template' && req.method === 'GET') {
          const debts = url.searchParams.get('kind') === 'debts';
          res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':`attachment; filename="steady-${debts ? 'debts' : 'assets'}-template.csv"` });
          const example = {id:'example-cash',name:'现金账户',type:'cash',account:'我的账户',currency:'CNY',value:10000,asOf:nowDate(),inPool:true,emergency:2000,earmarked:0,restricted:false};
          return res.end('\uFEFF' + (debts ? 'id,name,type,currency,balance,payment,rate,investment,overdue,maturity\nexample-debt,贷款示例,mortgage,CNY,100000,1000,,false,false,\n' : CSV_HEADER.join(',')+'\n'+CSV_HEADER.map(k=>example[k]??'').join(',')+'\n'));
        }
        if (path === '/api/restore/preview' && req.method === 'POST') { const input = await body(req); return json(res, { state: validateState(input.state ?? input), revision: store.state().revision }); }
        if (path === '/api/config' && req.method === 'PUT') { const input = validateConfig(await body(req)),previous=store.config(); store.saveConfig(input); const next=store.config();if(previous.scopeId!==next.scopeId||previous.includeHistory!==next.includeHistory)await assistantRuns.invalidate(); return json(res, { config:next, ...chatView() }); }
        if (path === '/api/config/test' && req.method === 'POST') {
          await body(req); const c=store.config({secret:true});
          try { const result=await testConnection(c); store.setConnection(c.scopeId,result); return json(res,{...result,config:store.config()}); }
          catch(error) { store.setConnection(c.scopeId,{ok:false,message:error.message,code:error.code}); return json(res,{error:error.message,code:error.code,config:store.config()},502); }
        }
        if(path==='/api/conversations'&&req.method==='POST'){await body(req);const thread=store.createConversation();return json(res,chatView(thread.id));}
        if(path==='/api/conversations'&&req.method==='GET')return json(res,{...chatView(url.searchParams.get('id')),run:assistantRuns.view()});
        if(path==='/api/conversations'&&req.method==='DELETE'){
          const {id}=await body(req);if(typeof id!=='string'||!store.conversation(id))return json(res,{error:'对话不存在或已删除'},404);
          await assistantRuns.deleteConversation(id);return json(res,{...chatView(),run:assistantRuns.view()});
        }
        if(path==='/api/chat/run'&&req.method==='GET'){await assistantRuns.resume();const run=assistantRuns.view();return json(res,{run,...chatView(run?.conversationId),config:store.config()});}
        if(path==='/api/chat/stop'&&req.method==='POST'){const input=await body(req);await assistantRuns.stop(input.id);return json(res,{run:assistantRuns.view()});}
        if ((path === '/api/chat' || path === '/api/chat/stream') && (req.method==='POST'||(path==='/api/chat/stream'&&req.method==='GET'))) {
          let run;
          if(req.method==='GET')run=await assistantRuns.existing(url.searchParams.get('run'));
          else {
            const input=await body(req),message=typeof input.message==='string'?input.message.trim():'';
            if(!message||message.length>4000)throw new Error('问题需为 1 至 4000 个字符');
            run=await assistantRuns.start(message,input.requestId,input.conversationId);
          }
          const streaming=path==='/api/chat/stream';let heartbeat,unsubscribe=()=>{};
          const send=(event,payload)=>{
            if(res.destroyed||res.writableEnded)return;
            if(res.writableLength>1e6){res.destroy();return;}
            res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
          };
          const detach=()=>{unsubscribe();if(heartbeat)clearInterval(heartbeat);};res.on('close',detach);
          if(streaming){
            res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
            send('status',{stage:'thinking'});
            unsubscribe=assistantRuns.subscribe(run,event=>send(event.type,event));
            heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);heartbeat.unref();
          }
          try {
            const result=await run.promise;
            if(res.destroyed||!result)return;
            if(!store.conversation(run.meta.conversationId))throw new Error('这段对话已删除');
            const output={...result,mode:'ai',...view(),...chatView(run.meta.conversationId)};
            if(streaming){send('done',output);return;}
            return json(res,output);
          } catch(cause) {
            if(!res.destroyed){const output={error:cause.message,code:cause.code,config:store.config()};if(streaming){send('error',output);return;}return json(res,output,502);}
          } finally {detach();res.off('close',detach);if(streaming&&!res.writableEnded)res.end();}
          return;
        }
        if (path === '/api/chat' && req.method === 'DELETE') { await body(req);await assistantRuns.invalidate();store.clearMessages();return json(res,{ok:true}); }
        if (path === '/api/reports' && req.method === 'POST') { await body(req); return json(res, { report: await makeReport(), reports: store.reports() }); }
        return json(res, { error: '接口不存在' }, 404);
      }
      if (!['GET','HEAD'].includes(req.method)) return json(res, { error: '方法不支持' }, 405);
      const files = { '/': ['index.html','text/html'], '/index.html': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/markets.js': ['markets.js','text/javascript'], '/monthly-performance.js': ['monthly-performance.js','text/javascript'], '/watchboard.js': ['watchboard.js','text/javascript'], '/fund-reference.js': ['fund-reference.js','text/javascript'], '/watchboard-logos.js': ['watchboard-logos.js','text/javascript'], '/logos/LICENSE.txt': ['logos/LICENSE.txt','text/plain'], '/sse.js': ['sse.js','text/javascript'], '/styles.css': ['styles.css','text/css'], '/favicon.svg': ['favicon.svg','image/svg+xml'] };
      const file = files[path] || (/^\/logos\/[a-z0-9-]+\.svg$/.test(path)&&existsSync(join(root,'public',path.slice(1)))?[path.slice(1),'image/svg+xml']:null); if (!file) return json(res, { error: '页面不存在' }, 404);
      const data = await readFile(join(root,'public',file[0])); res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) { if (!res.headersSent) json(res, { error: error.status && error.status >= 500 ? '服务暂不可用' : error.message || '请求失败' }, error.status || 400); else res.end(); }
  });
  server.on('listening', () => { void assistantRuns.resume().catch(()=>{});if (schedule) tick().catch(() => {}); });
  return { server, store, tick, close: async () => { if (timer) clearInterval(timer); marketBriefGenerator.stop();await assistantRuns.close();await new Promise(r => server.close(r)); if (pendingNAV) await pendingNAV;if(pendingLedger)await pendingLedger; if (pendingMarkets) await pendingMarkets; if(pendingBriefs)await pendingBriefs;await marketBriefGenerator.pending();store.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3210);
  if (process.env.APP_PREVIEW === '1' && !['127.0.0.1','localhost','::1'].includes(host)) throw new Error('预览免登录模式只允许绑定本机回环地址');
  const app = createApplication();
  app.server.listen(port, host, () => console.log(`Steady 已启动：http://${host}:${port}\n数据目录：${process.env.DATA_DIR || join(root,'data')}\n首次访问请设置访问密码。`));
  const shutdown = () => app.close().then(() => process.exit(0)); process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
