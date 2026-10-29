import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { initialState, validateState, calculate, evaluate, nowDate } from './domain.mjs';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS } from './ai.mjs';
import { applyFundNAV } from './funds.mjs';
import { applyStockPrices } from './market.mjs';
import { isoDay } from './securities.mjs';
import { inferredCostBasis, applyInvestmentInfo } from './investments.mjs';
import { incomePlan } from './income.mjs';

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'secret.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(keyPath);
  const db = new DatabaseSync(join(directory, 'balance.sqlite'));
  chmodSync(join(directory, 'balance.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports (day TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (day TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS price_history (instrument TEXT NOT NULL, day TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(instrument,day));
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, scope_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'revision')) db.exec('ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'metadata')) db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
  if (!db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'conversation_id')) db.exec("ALTER TABLE messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at)');
  const conversationTitle = question => String(question).trim().split('\n')[0].slice(0,36) || '历史对话';
  // Older versions kept one continuous transcript per authorization scope.
  // Preserve every row, including local replies, without inventing chat boundaries.
  db.exec('BEGIN IMMEDIATE');
  try {
    const groups=new Map();
    for(const row of db.prepare("SELECT * FROM messages WHERE conversation_id='' ORDER BY created_at,rowid").all()) {
      const scope=JSON.parse(row.metadata).scopeId||'';
      if(!groups.has(scope))groups.set(scope,[]);
      groups.get(scope).push(row);
    }
    for(const [scope,rows] of groups) {
      const id=randomUUID(),title=conversationTitle(rows.find(r=>r.role==='user')?.content||'历史对话');
      db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(id,title,scope,rows[0].created_at,rows.at(-1).created_at);
      for(const row of rows)db.prepare('UPDATE messages SET conversation_id=? WHERE id=?').run(id,row.id);
    }
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
  const getKV = (key, fallback = null) => { const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; };
  const setKV = (key, value) => db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  if (!getKV('state')) setKV('state', initialState());
  const encrypt = (value) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join('.'); };
  const decrypt = value => { const [iv, tag, body] = value.split('.').map(v => Buffer.from(v, 'hex')); const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag); return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8'); };
  const project = input => {
    const state=structuredClone(input);
    for(const a of state.assets)if(!('costBasis' in a)){const cost=inferredCostBasis(a);if(cost)a.costBasis=cost;}
    return applyInvestmentInfo(applyStockPrices(applyFundNAV(state, getKV), getKV));
  };
  const state = ({ raw = false } = {}) => raw ? getKV('state') : project(getKV('state'));
  const recordPrice = (instrument, input) => {
    const day = isoDay(input.date);
    if (!Number.isFinite(input.price) || input.price <= 0 || day > nowDate()) throw new Error('历史行情无效');
    const row = db.prepare('SELECT payload FROM price_history WHERE instrument=? AND day=?').get(instrument,day),old = row ? JSON.parse(row.payload) : null;
    if (old?.time && input.time && old.time > input.time) return;
    const next = { ...input, ...(input.previous ? {} : old?.previous ? { previous: old.previous } : {}) };
    db.prepare('INSERT INTO price_history(instrument,day,payload) VALUES(?,?,?) ON CONFLICT(instrument,day) DO UPDATE SET payload=excluded.payload').run(instrument,day,JSON.stringify(next));
  };
  const priceHistory = instrument => db.prepare('SELECT payload FROM price_history WHERE instrument=? ORDER BY day DESC LIMIT 60').all(instrument).map(r=>JSON.parse(r.payload));
  for (const a of getKV('state').assets.filter(a=>a.fund?.autoNav)) {
    const q=getKV('fund_nav:'+a.fund.code);
    if(q){if(q.previous)recordPrice('FUND.'+a.fund.code,{...q.previous,code:a.fund.code,currency:'CNY',basis:'unit_nav',source:q.source});recordPrice('FUND.'+a.fund.code,q);}
  }
  const history = () => db.prepare('SELECT payload FROM history ORDER BY day DESC LIMIT 30').all().map(r => JSON.parse(r.payload)).reverse();
  const snapshot = (s, day=nowDate(s.preferences.timeZone)) => { const m = calculate(s); db.prepare('INSERT INTO history(day,payload) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').run(day, JSON.stringify({ day, netWorth: m.netWorth, totalAssets: m.totalAssets, debt: m.totalDebt, revision: s.revision, complete: m.complete })); };
  const persistState=(next,current,label,day)=>{
    db.prepare('INSERT INTO audit(created_at,label,state) VALUES(?,?,?)').run(new Date().toISOString(),label,JSON.stringify(current));
    setKV('state',next);snapshot(project(next),day);
    db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 100)').run();
  };
  const save = (input, expectedRevision, label = '更新财务档案') => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = state({ raw: true });
      if (current.revision !== expectedRevision) { const e = new Error('数据已在其他窗口更新，请刷新后重试'); e.status = 409; throw e; }
      const next = validateState(input); next.revision = current.revision + 1;
      for (const a of next.assets.filter(a => a.fund?.autoNav || a.autoPrice)) {
        const prev = current.assets.find(p => p.id === a.id && (a.fund?.autoNav ? p.fund?.autoNav && p.fund.code === a.fund.code : p.autoPrice && p.security?.key === a.security.key));
        if (prev) { a.value = prev.quantity === a.quantity ? prev.value : null; a.asOf = prev.asOf; }
      }
      persistState(next,current,label);
      db.exec('COMMIT');
      return next;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const applyIncome=(now=new Date())=>{
    db.exec('BEGIN IMMEDIATE');
    try{
      const current=state({raw:true}),credits=getKV('income_credits',[]),plan=incomePlan(current,credits,now);
      if(!plan.due.length){db.exec('COMMIT');return {posted:0,...plan};}
      const next=structuredClone(current),cash=next.assets.find(a=>a.id===current.profile.autoIncome.cashAssetId);
      const amount=plan.due.reduce((sum,item)=>sum+item.amount,0),day=nowDate(current.preferences.timeZone,now);
      cash.value=Math.round((cash.value+amount)*100)/100;cash.asOf=day;
      next.profile.autoIncome.lastPeriod=plan.due.at(-1).period;next.revision=current.revision+1;
      const validated=validateState(next);
      const receipts=plan.due.map(item=>({period:item.period,dueDate:item.date,amount:item.amount,assetId:item.assetId,postedAt:now.toISOString()}));
      persistState(validated,current,`工资自动入账 · ${receipts.map(r=>r.period).join('、')} · ${amount.toLocaleString('zh-CN')} 元`.slice(0,100),day);
      setKV('income_credits',[...credits,...receipts]);
      db.exec('COMMIT');return {...incomePlan(validated,[...credits,...receipts],now),posted:receipts.length,totalAmount:amount};
    }catch(error){db.exec('ROLLBACK');throw error;}
  };
  const incomeStatus=(now=new Date())=>{const credits=getKV('income_credits',[]);return {...incomePlan(state({raw:true}),credits,now),credits:credits.slice(-12).reverse()};};
  const ledgerEntry=id=>{const row=db.prepare('SELECT payload FROM ledger_entries WHERE id=?').get(id);return row?JSON.parse(row.payload):null;};
  const ledgerEntries=({pending=false,limit=50}={})=>db.prepare("SELECT payload FROM ledger_entries"+(pending?" WHERE json_extract(payload,'$.status')='pending'":'')+" ORDER BY json_extract(payload,'$.createdAt') DESC,rowid DESC LIMIT ?").all(limit).map(row=>JSON.parse(row.payload));
  const postLedgerEntry=(entry,transition)=>{
    db.exec('BEGIN IMMEDIATE');
    try{
      const existing=ledgerEntry(entry.id);
      if(existing&&existing.signature!==entry.signature)throw new Error('本轮已登记过这项资产的另一笔变动，请另发一条消息记录新变动');
      if(existing&&existing.status!=='pending'){db.exec('COMMIT');return {...existing,replayed:true};}
      let result=existing||entry;
      if(transition){
        const current=state({raw:true}),change=transition(structuredClone(current),result);
        if(change.state){const next=validateState(change.state);next.revision=current.revision+1;persistState(next,current,entry.label.slice(0,100));result={...result,...change.receipt,revision:next.revision,status:'applied',appliedAt:new Date().toISOString()};}
        else result={...result,...change.receipt};
      }
      db.prepare('INSERT INTO ledger_entries VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(result.id,JSON.stringify(result));
      db.exec('COMMIT');return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  };
  const config = ({ secret = false } = {}) => {
    const value = { baseUrl: '', model: '', apiKey: '', consent: false, includeHoldings: false, includePageData: false, allowLedgerWrites: false, includeHistory: true, useTools: true, autoReport: false, marketBriefsAI: false, requestTimeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS, ...getKV('ai', {}) };
    return { ...value, apiKey: secret && value.apiKey ? decrypt(value.apiKey) : '', hasKey: Boolean(value.apiKey) };
  };
  const conversation = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id) || null;
  const latestConversation = scope => db.prepare('SELECT * FROM conversations WHERE scope_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(scope||'') || null;
  const createConversation = (scope=config().scopeId||'',title='新对话') => {
    const id=randomUUID(),time=new Date().toISOString();
    db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(id,conversationTitle(title),scope,time,time);
    return conversation(id);
  };
  const messages = id => db.prepare('SELECT * FROM messages'+(id?' WHERE conversation_id=?':'')+' ORDER BY created_at,rowid').all(...(id?[id]:[])).map(m=>({...m,metadata:JSON.parse(m.metadata)}));
  return {
    db, state, getKV, setKV, save, history, snapshot, recordPrice, priceHistory, applyIncome, incomeStatus,ledgerEntry,ledgerEntries,postLedgerEntry,
    cancelLedgerEntry(id){const entry=ledgerEntry(id);if(!entry||entry.status!=='pending')throw new Error('只能取消尚未入账的记录');return postLedgerEntry(entry,()=>({receipt:{status:'cancelled'}}));},
    audit: () => db.prepare('SELECT id,created_at,label FROM audit ORDER BY id DESC LIMIT 20').all(),
    undo: (id, revision) => { const row = db.prepare('SELECT state FROM audit WHERE id=?').get(id); if (!row) throw new Error('找不到该历史版本'); return save(JSON.parse(row.state), revision, '恢复历史版本'); },
    config,
    saveConfig: (input) => {
      const prev = config({ secret: true });
      const nextKey = input.clearKey ? '' : input.apiKey || prev.apiKey;
      const value = { baseUrl: input.baseUrl, model: input.model, consent: input.consent === true, includeHoldings: input.includeHoldings === true, includeHistory: input.includeHistory===undefined?prev.includeHistory:input.includeHistory===true, useTools: input.useTools !== false, autoReport: input.autoReport === true, marketBriefsAI: input.marketBriefsAI === true };
      value.includePageData=input.includePageData===undefined?prev.includePageData:input.includePageData===true;
      value.allowLedgerWrites=input.allowLedgerWrites===undefined?prev.allowLedgerWrites:input.allowLedgerWrites===true;
      value.requestTimeoutSeconds = input.requestTimeoutSeconds ?? prev.requestTimeoutSeconds;
      // Context is now confined to the selected conversation. Toggling it keeps
      // that transcript usable; changes to its recipient or data scope isolate it.
      const changed = nextKey !== prev.apiKey || ['baseUrl','model','consent','includeHoldings','includePageData','allowLedgerWrites','useTools'].some(k => value[k] !== prev[k]);
      const connectionChanged = nextKey !== prev.apiKey || ['baseUrl','model','useTools'].some(k => value[k] !== prev[k]);
      value.scopeId = changed || !prev.scopeId ? randomUUID() : prev.scopeId;
      value.connection = connectionChanged ? null : prev.connection ?? null;
      value.apiKey = nextKey ? encrypt(nextKey) : '';
      setKV('ai', value); return config();
    },
    setConnection: (scopeId, connection) => { const value = getKV('ai', {}); if (value.scopeId === scopeId) { value.connection = { ...connection, checkedAt: new Date().toISOString() }; setKV('ai', value); } return config(); },
    reports: () => db.prepare('SELECT payload FROM reports ORDER BY day DESC LIMIT 60').all().map(r => JSON.parse(r.payload)),
    report: (day) => { const row = db.prepare('SELECT payload FROM reports WHERE day=?').get(day); return row ? JSON.parse(row.payload) : null; },
    generateReport: (s, { late = false } = {}) => {
      const day = nowDate(s.preferences.timeZone), metrics = calculate(s), prior = history().filter(h => h.day < day).at(-1);
      const report = { day, generatedAt: new Date().toISOString(), late, revision: s.revision, isDemo: s.isDemo, metrics, rules: evaluate(s, metrics),
        changes: prior ? metrics.netWorth - prior.netWorth : null, changeLabel: '估值差额，包含出入金及修正，不代表投资收益', aiText: null };
      snapshot(s); db.prepare('INSERT INTO reports(day,payload) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').run(day, JSON.stringify(report)); return report;
    },
    updateReport: r => db.prepare('UPDATE reports SET payload=? WHERE day=?').run(JSON.stringify(r), r.day),
    conversation, latestConversation, createConversation, messages,
    conversations: () => db.prepare('SELECT c.*,COUNT(m.id) AS message_count FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC,c.rowid DESC').all(),
    deleteConversation: id => {
      db.exec('BEGIN IMMEDIATE');
      try {db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);db.prepare('DELETE FROM conversations WHERE id=?').run(id);db.exec('COMMIT');}
      catch(error){db.exec('ROLLBACK');throw error;}
    },
    addConversation: (question, answer, revision, metadata) => {
      const stmt = db.prepare('INSERT INTO messages(id,role,content,mode,created_at,revision,metadata,conversation_id) VALUES(?,?,?,?,?,?,?,?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        // A crash can happen after saving an answer but before retiring its run.
        if(metadata?.durableRunId&&db.prepare("SELECT 1 FROM messages WHERE json_extract(metadata,'$.durableRunId')=? LIMIT 1").get(metadata.durableRunId)){db.exec('COMMIT');return;}
        const thread=metadata?.conversationId?conversation(metadata.conversationId):(latestConversation(metadata?.scopeId)||createConversation(metadata?.scopeId));
        if(!thread)throw new Error('对话已删除，无法保存回答');
        const time=new Date().toISOString();
        for (const [role, content] of [['user',question],['assistant',answer]]) stmt.run(randomUUID(), role, content, 'ai', time, revision, JSON.stringify(metadata||{}),thread.id);
        db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').run(thread.title==='新对话'?conversationTitle(question):thread.title,time,thread.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    clearMessages: () => db.exec('DELETE FROM messages; DELETE FROM conversations;'),
    clearReports: () => db.exec('DELETE FROM reports; DELETE FROM history;'),
    close: () => db.close()
  };
}
