import test from 'node:test';
import assert from 'node:assert/strict';
import {readEventStream} from '../public/sse.js';

test('SSE handles fragmented UTF-8, CRLF, comments and multi-line data, and cancels when completed',async()=>{
 const bytes=new TextEncoder().encode(': heartbeat\r\nevent: delta\r\ndata: 中文\r\ndata: 第二行\r\n\r\nevent: done\r\ndata: {}\r\n\r\n');
 let index=0,cancelled=false;const events=[];
 const body=new ReadableStream({pull(c){if(index<bytes.length)c.enqueue(bytes.slice(index,index+=1));},cancel(){cancelled=true;}});
 await readEventStream(body,event=>{events.push(event);if(event.event==='done')return false;});
 assert.deepEqual(events,[{event:'delta',data:'中文\n第二行'},{event:'done',data:'{}'}]);assert.equal(cancelled,true);
});
test('SSE never delivers an incomplete frame or accepts unbounded data',async()=>{
 const stream=text=>new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}}),events=[];
 await readEventStream(stream('data: incomplete'),event=>events.push(event));assert.equal(events.length,0);
 await assert.rejects(readEventStream(stream('data: too large\n\n'),()=>{},{maxBytes:3}),e=>e.code==='SSE_SIZE');
});

test('SSE limits individual frames, independent of connection length and transport chunking',async()=>{
 const frame='data: 中文\r\n\r\n',bytes=new TextEncoder().encode(frame.repeat(100));
 for(const chunkSize of [1,17,bytes.length]){
   let offset=0;const events=[];
   const body=new ReadableStream({pull(c){if(offset>=bytes.length){c.close();return;}c.enqueue(bytes.slice(offset,offset+=chunkSize));}});
   await readEventStream(body,e=>events.push(e),{maxBytes:new TextEncoder().encode(frame).length});
   assert.equal(events.length,100);assert.ok(events.every(e=>e.data==='中文'));
 }
});

test('SSE bounds fragmented unterminated lines and multi-line frames, cancelling the reader',async()=>{
 for(const text of ['data: '+'中'.repeat(30),'data: x\ndata: y\ndata: z\n\n']){
   const bytes=new TextEncoder().encode(text);let offset=0,cancelled=false;
   const body=new ReadableStream({pull(c){c.enqueue(bytes.slice(offset,++offset));},cancel(){cancelled=true;}});
   await assert.rejects(readEventStream(body,()=>assert.fail('oversized frame dispatched'),{maxBytes:20}),e=>e.code==='SSE_SIZE');
   assert.equal(cancelled,true);
 }
});
