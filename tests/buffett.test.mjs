import test from 'node:test';
import assert from 'node:assert/strict';
import {BUFFETT_SERIES,parseFredQuarterly,calculateBuffettIndicator,refreshBuffett,availableBuffett} from '../src/buffett.mjs';
const now=new Date('2026-10-28T02:00:00Z');
const caps=[{date:'2026-04-01',value:40000000}],gdps=[{date:'2026-04-01',value:20000}];
const csv=(id,rows)=>'observation_date,'+id+'\n'+rows.map(r=>r.date+','+r.value).join('\n');
test('巴菲特指标转换百万/十亿美元单位，并严格配对同季度',()=>{
  const v=calculateBuffettIndicator(caps,gdps,now);assert.equal(v.percent,200);assert.equal(v.period,'2026 Q2');assert.equal(v.marketCapBillions,40000);assert.equal(v.gdpBillions,20000);
  assert.equal(calculateBuffettIndicator(caps,[{date:'2026-07-01',value:21000}],now),null);
  assert.equal(calculateBuffettIndicator([{date:'2026-01-01',value:30000000}],gdps,now),null);
  assert.equal(calculateBuffettIndicator([{date:'2026-10-01',value:1}],[{date:'2026-10-01',value:1}],now),null);
  assert.equal(calculateBuffettIndicator(caps,[{date:'2026-04-01',value:0}],now),null);
});
test('FRED 解析按已完成季度接收数据，不把缺失、未来、无效日期或错误序列当数字',()=>{
  const text='\uFEFFobservation_date,GDP\r\n2026-04-01,20000\r\n2026-07-01,.\r\n2026-10-01,25000\r\n2026-02-30,123\r\n2026-04-01,-1';
  assert.deepEqual(parseFredQuarterly(text,'GDP',now),gdps);
  assert.throws(()=>parseFredQuarterly('observation_date,OTHER\n2026-04-01,1','GDP',now));
  assert.throws(()=>parseFredQuarterly('<html>Denied</html>','GDP',now));
});
test('官方季度数据自动下载计算，成功一天内复用，失败隐藏并按间隔恢复',async()=>{
  let calls=0;
  const fetchImpl=async url=>{calls++;const id=new URL(url).searchParams.get('id');return new Response(csv(id,id===BUFFETT_SERIES.marketCap?caps:gdps));};
  const first=await refreshBuffett(null,{fetchImpl,now});assert.equal(calls,2);assert.equal(availableBuffett(first,now).percent,200);
  await refreshBuffett(first,{fetchImpl,now:new Date(now.getTime()+60000)});assert.equal(calls,2);
  const later=new Date(now.getTime()+86400000),failed=await refreshBuffett(first,{fetchImpl:async()=>{throw new Error('PRIVATE UPSTREAM');},now:later});
  assert.ok(!JSON.stringify(failed).includes('PRIVATE'));assert.equal(availableBuffett(failed,later),null);
  await refreshBuffett(failed,{fetchImpl,now:new Date(later.getTime()+60000)});assert.equal(calls,2);
  const recovered=await refreshBuffett(failed,{fetchImpl,now:new Date(later.getTime()+1800000)});assert.equal(calls,4);assert.equal(availableBuffett(recovered,later).percent,200);
  assert.equal(availableBuffett(first,new Date('2027-01-01T00:00:00Z')),null);
});
