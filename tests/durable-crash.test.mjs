import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('进程被强制终止后自动恢复同一问题，保留已完成工具且最终回答只入账一次',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'finance-durable-crash-'));let child,calls=0,reached;
 const waiting=new Promise(r=>reached=r),requests=[];
 const upstream=createServer(async(req,res)=>{
   let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));calls++;
   res.setHeader('Content-Type','application/json');
   if(calls===1)return res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'saved-calculation',type:'function',function:{name:'get_stock_budget',arguments:'{}'}}]}}]}));
   assert.ok(requests.at(-1).messages.some(m=>m.role==='tool'&&m.tool_call_id==='saved-calculation'));
   if(calls===2){res.writeHead(200);res.flushHeaders();reached();return;}
   res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'进程重启后已继续完成。'}}]}));
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const kill=async()=>{if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');});};
 t.after(async()=>{await kill();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(dir,{recursive:true,force:true});});
 const start=async()=>{
   const source=`import {createApplication} from ${JSON.stringify(new URL('../src/server.mjs',import.meta.url).href)};const app=createApplication({dataDir:process.env.FINANCE_DURABLE_TEST_DIR,disableAuth:true,schedule:false});app.server.listen(0,'127.0.0.1',()=>console.log('DURABLE_TEST_PORT:'+app.server.address().port));`;
   child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,FINANCE_DURABLE_TEST_DIR:dir},stdio:['ignore','pipe','pipe']});
   let output='';child.stderr.resume();
   return new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>reject(new Error('Child did not start')),5000);timer.unref();
     child.once('error',reject);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/DURABLE_TEST_PORT:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});
   });
 };
 let base=await start();
 const json=async(path,body)=>fetch(base+'/api'+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(5000)}).then(r=>r.json());
 await fetch(base+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:`http://127.0.0.1:${upstream.address().port}`,model:'synthetic',apiKey:'FAKE_CRASH_KEY',consent:true,useTools:true})}).then(r=>r.json());
 const pending=json('/chat',{message:'虚构崩溃恢复问题',requestId:'crash-once'}).catch(()=>{});
 await Promise.race([waiting,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Model did not reach checkpoint')),5000);timer.unref();})]);
 const original=(await json('/chat/run')).run.id;await kill();await pending;
 base=await start();let view;
 for(let i=0;i<100;i++){view=await json('/bootstrap');if(view.messages.length===2)break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(view.messages.length,2);assert.equal(view.messages[1].content,'进程重启后已继续完成。');assert.equal(view.messages[1].metadata.durableRunId,original);assert.equal(calls,3);assert.equal(view.state.revision,0);
 await json('/chat',{message:'虚构崩溃恢复问题',requestId:'crash-once'});assert.equal(calls,3);assert.equal((await json('/bootstrap')).messages.length,2);assert.equal(readdirSync(join(dir,'assistant-runs')).length,0);
});
