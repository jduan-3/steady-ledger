import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';

test('旧版混合记录按授权范围迁移，不丢记录，重开不会重复迁移',t=>{
  const dir=mkdtempSync(join(tmpdir(),'finance-conversations-'));let store;
  t.after(()=>{store?.close();rmSync(dir,{recursive:true,force:true});});
  const legacy=new DatabaseSync(join(dir,'balance.sqlite'));
  legacy.exec("CREATE TABLE messages (id TEXT PRIMARY KEY,role TEXT NOT NULL,content TEXT NOT NULL,mode TEXT NOT NULL,created_at TEXT NOT NULL,revision INTEGER DEFAULT 0,metadata TEXT DEFAULT '{}')");
  const insert=legacy.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)');
  const rows=[['one','user','旧问题','ai','2026-10-23T00:00:00Z',2,{scopeId:'a',aiChat:true}],['two','assistant','旧回复','ai','2026-10-23T00:00:00Z',2,{scopeId:'a',aiChat:true}],['three','assistant','本地旧记录','local','2026-10-24T00:00:00Z',0,{}],['four','user','其他授权','ai','2026-10-25T00:00:00Z',3,{scopeId:'b',aiChat:true}]];
  for(const row of rows)insert.run(...row.slice(0,6),JSON.stringify(row[6]));legacy.close();
  store=openStore(dir);assert.equal(store.messages().length,4);assert.equal(store.conversations().length,3);
  const thread=store.conversations().find(c=>c.scope_id==='a');assert.equal(store.messages(thread.id).length,2);assert.equal(store.messages(thread.id)[0].revision,2);
  store.close();store=openStore(dir);assert.equal(store.conversations().length,3);assert.equal(store.messages().length,4);
  store.deleteConversation(thread.id);assert.equal(store.messages().length,2);assert.ok(store.messages().some(m=>m.mode==='local'));
});

test('对话记录不再因全局一百条上限被悄悄裁掉',t=>{
  const dir=mkdtempSync(join(tmpdir(),'finance-conversations-')),store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const a=store.createConversation('a'),b=store.createConversation('a');
  for(let i=0;i<55;i++)store.addConversation(`问题 ${i}`,`回复 ${i}`,0,{scopeId:'a',aiChat:true,conversationId:a.id});
  store.addConversation('另一段问题','另一段回复',0,{scopeId:'a',aiChat:true,conversationId:b.id});
  assert.equal(store.messages(a.id).length,110);assert.equal(store.messages(b.id).length,2);assert.equal(store.messages().length,112);
  assert.throws(()=>store.addConversation('无效对话','不能保存',0,{conversationId:'missing'}),/已删除/);assert.equal(store.messages().length,112);
});
