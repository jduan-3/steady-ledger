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
