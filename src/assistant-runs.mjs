import { mkdirSync, openSync, closeSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openAssistantRun, requireAI } from './ai.mjs';
import { buildAssistantData } from './assistant-data.mjs';

const KEY='assistant_active_run';
const error=(message,status=409)=>Object.assign(new Error(message),{status});

// The durable file is a checkpoint for unfinished work. Once its final answer is
// atomically copied into the existing chat history, the checkpoint is disposable.
export function createAssistantRuns(store,{dataDir,services}) {
  const directory=join(dataDir,'assistant-runs');
  let active=null,opening=null,suspended=false;
  const currentScope=()=>store.config().scopeId;
  const filename=id=>join(directory,id+'.sqlite');
  const remove=id=>{if(!/^[a-f0-9-]{36}$/.test(id))return;for(const suffix of ['','-wal','-shm'])rmSync(filename(id)+suffix,{force:true});};
  const publish=(run,event)=>{
    if(event.type==='delta')run.text+=event.text;
    if(event.type==='reset')run.text='';
    if(event.type==='status')run.stage=event.stage;
    if(event.type==='tools')run.toolCalls=event.calls;
    if(event.type==='tool'){const index=run.toolCalls.findIndex(call=>call.id===event.call.id);if(index<0)run.toolCalls.push(event.call);else run.toolCalls[index]=event.call;}
    for(const listener of run.listeners)try{listener(event);}catch{}
  };
  const saveTerminal=(run,status,extra={})=>{
    run.meta={id:run.meta.id,requestId:run.meta.requestId,scopeId:run.meta.scopeId,conversationId:run.meta.conversationId,question:run.meta.question,status,startedAt:run.meta.startedAt,toolCalls:run.toolCalls,...extra};
    store.setKV(KEY,run.meta);
  };
  const launch=async meta=>{
    const config=store.config({secret:true});
    if(!config.consent||!config.baseUrl||!config.model||config.scopeId!==meta.scopeId||(meta.ledgerGeneration??0)!==store.ledgerGeneration()||(meta.contextEnabled!==undefined&&meta.contextEnabled!==config.includeHistory)||(meta.contextEnabled===undefined&&meta.history?.length&&!config.includeHistory)) {
      store.setKV(KEY,null);remove(meta.id);return null;
    }
    if(!meta.conversationId) {
      meta.conversationId=(store.latestConversation(meta.scopeId)||store.createConversation(meta.scopeId,meta.question)).id;
      store.setKV(KEY,meta);
    }
    if(!store.conversation(meta.conversationId)){store.setKV(KEY,null);remove(meta.id);return null;}
    const run={meta,text:'',stage:'thinking',toolCalls:[],listeners:new Set(),session:null,promise:null,stopping:false};active=run;
    try {
      mkdirSync(directory,{recursive:true,mode:0o700});
      const fd=openSync(filename(meta.id),'a',0o600);closeSync(fd);chmodSync(filename(meta.id),0o600);
      const storage=await openNodeSqliteStorage(filename(meta.id));
      run.session=await openAssistantRun(config,meta.snapshot,meta.question,{storage,history:meta.history,pageData:meta.pageData,services:services(config,meta,{isActive:()=>!run.stopping&&!suspended}),startedAt:meta.startedAt,onEvent:event=>publish(run,event)});
      run.promise=run.session.run().then(result=>{
        if(suspended)return;
        if(run.stopping||config.scopeId!==currentScope()||config.includeHistory!==store.config().includeHistory)throw Object.assign(new Error('回答已停止，或授权范围已更新'),{code:'AI_CANCELLED'});
        store.addConversation(meta.question,result.content,result.revision,{aiChat:true,scopeId:config.scopeId,conversationId:meta.conversationId,model:config.model,toolsUsed:result.toolsUsed,toolCalls:result.toolCalls,durableRunId:meta.id,requestId:meta.requestId});
        store.setConnection(config.scopeId,{ok:true,tools:result.toolsUsed.some(t=>t.ok)||config.connection?.tools===true,message:'最近一次问答成功'});
        saveTerminal(run,'done',{revision:result.revision});
        return result;
      }).catch(cause=>{
        if(suspended)return;
        const message=cause.code==='AI_CANCELLED'?'已停止回答，可以修改问题后重新发送。':cause.message;
        saveTerminal(run,'failed',{error:message,code:cause.code||'AI_GENERATION'});
        if(cause.code!=='AI_CANCELLED')store.setConnection(config.scopeId,{ok:false,message,code:cause.code});
        throw Object.assign(new Error(message),{code:cause.code||'AI_GENERATION'});
      }).finally(async()=>{
        await run.session.close();
        if(!suspended)remove(meta.id);
      });
      // Work keeps running even while no HTTP client is attached.
      void run.promise.catch(()=>{});
      return run;
    } catch(cause) {
      if(!suspended)saveTerminal(run,'failed',{error:'持久会话暂时无法打开，请重试',code:'AI_STORAGE'});
      await run.session?.close();
      throw cause;
    }
  };
  const resume=()=>{
    if(suspended)return Promise.resolve(null);
    if(opening)return opening;
    if(active)return Promise.resolve(active);
    const meta=store.getKV(KEY);
    if(!meta||meta.status!=='running'){if(meta?.id)remove(meta.id);return Promise.resolve(null);}
    opening=launch(meta).finally(()=>{opening=null;});return opening;
  };
  const view=()=>{
    const meta=active?.meta||store.getKV(KEY);
    if(!meta||meta.scopeId!==currentScope())return null;
    return {id:meta.id,requestId:meta.requestId,conversationId:meta.conversationId,question:meta.question,status:meta.status,stage:active?.stage||'thinking',text:active?.text||'',toolCalls:active?.toolCalls||meta.toolCalls||[],...(meta.error?{error:meta.error,code:meta.code}:{})};
  };
  return {
    view,resume,
    async start(question,requestId=randomUUID(),conversationId) {
      await resume();
      if(suspended)throw error('服务正在重启，请稍后重新连接',503);
      const config=store.config({secret:true});requireAI(config);
      if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))throw error('问题标识无效',400);
      if(active?.meta.requestId===requestId&&active.meta.scopeId===config.scopeId) {
        if(active.meta.question!==question||(conversationId&&conversationId!==active.meta.conversationId))throw error('该问题标识已用于其他内容');
        return active;
      }
      const saved=store.messages(),answer=saved.find(m=>m.role==='assistant'&&m.metadata.requestId===requestId&&m.metadata.scopeId===config.scopeId);
      if(answer) {
        const prior=saved.find(m=>m.role==='user'&&m.metadata.requestId===requestId&&m.metadata.scopeId===config.scopeId);
        if(prior?.content!==question||(conversationId&&conversationId!==answer.conversation_id))throw error('该问题标识已用于其他内容');
        return {meta:{id:answer.metadata.durableRunId,conversationId:answer.conversation_id,status:'done'},text:answer.content,toolCalls:answer.metadata.toolCalls||[],stage:'answering',listeners:new Set(),promise:Promise.resolve({content:answer.content,toolsUsed:answer.metadata.toolsUsed||[],toolCalls:answer.metadata.toolCalls||[],revision:answer.revision})};
      }
      if(active?.meta.status==='running')throw error('已有问题正在回答，请稍候',429);
      if(conversationId!==undefined&&conversationId!==null&&typeof conversationId!=='string')throw error('对话标识无效',400);
      let thread=conversationId?store.conversation(conversationId):conversationId===null?null:store.latestConversation(config.scopeId);
      if(conversationId&&!thread)throw error('对话不存在或已删除',404);
      if(thread&&thread.scope_id!==config.scopeId)throw error('模型或授权设置已变更，请新建对话继续');
      thread??=store.createConversation(config.scopeId,question);
      const meta={id:randomUUID(),requestId,scopeId:config.scopeId,ledgerGeneration:store.ledgerGeneration(),conversationId:thread.id,contextEnabled:config.includeHistory,question,status:'running',snapshot:store.state(),history:config.includeHistory?store.messages(thread.id).slice(-12):[],startedAt:Date.now()};
      if(config.includePageData)meta.pageData=buildAssistantData(store,meta.snapshot);
      // Saving the frozen context precedes both opening and submitting work.
      store.setKV(KEY,meta);
      opening=launch(meta).finally(()=>{opening=null;});return opening;
    },
    async existing(id) {
      await resume();
      if(!active||active.meta.id!==id||active.meta.scopeId!==currentScope())throw error('这轮回答已结束，请刷新对话记录',404);
      return active;
    },
    subscribe(run,listener) {
      run.listeners.add(listener);
      listener({type:'run',id:run.meta.id,conversationId:run.meta.conversationId});
      listener({type:'status',stage:run.stage});
      listener({type:'tools',calls:run.toolCalls||[]});
      if(run.text){listener({type:'reset'});listener({type:'delta',text:run.text});}
      return ()=>run.listeners.delete(listener);
    },
    async stop(id) {
      await resume();
      if(active?.meta.status!=='running'||(id&&active.meta.id!==id))return;
      active.stopping=true;
      await active.session.stop();await active.promise.catch(()=>{});
    },
    async invalidate() {
      await this.stop();
      active=null;store.setKV(KEY,null);
    },
    async deleteConversation(id) {
      await resume();
      if(view()?.conversationId===id)await this.invalidate();
      store.deleteConversation(id);
    },
    async close() {
      suspended=true;
      await opening?.catch(()=>{});
      await active?.session?.close();
      await active?.promise?.catch(()=>{});
    }
  };
}
