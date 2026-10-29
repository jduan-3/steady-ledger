import test from 'node:test';
import assert from 'node:assert/strict';
import {marketRecap} from '../src/market-summary.mjs';
const date='2026-10-27',row=(name,percent,key=name,day=date)=>({name,percent,key,date:day});
const indices=[row('标普 500',.6),row('道琼斯',.03),row('纳斯达克综合',1.18)];
test('美股摘要归纳强弱、所有行业的广度和首尾差，不复述三大指数',()=>{
  const sectors=['科技','金融','能源','医疗','可选消费','必需消费','工业','原材料','房地产','公用事业','通信服务'].map((name,i)=>row(name,[2,.3,-1,.1,1,0,.5,-.2,.3,0,.8][i]));
  const summary=marketRecap({market:'US',date,indices,sectors});
  assert.equal(summary.headline,'三大指数齐涨');
  assert.deepEqual(summary.sections.map(s=>s.label),['市场主线','行业广度','行业强弱']);
  assert.match(summary.sections[0].text,/纳斯达克综合相对领先，道琼斯相对落后.*1.15 个百分点/);
  assert.ok(!summary.sections[0].text.includes('0.60%'));
  assert.deepEqual(summary.sectorBreadth,{up:7,down:2,flat:2,total:11});
  assert.match(summary.sections[1].text,/11 只行业 ETF.*7 涨、2 跌、2 平/);
  assert.match(summary.sections[2].text,/科技（\+2.00%）领涨，能源（−1.00%）跌幅最大.*3.00 个百分点/);
});
test('摘要排除跨日和无前收行情，保留零涨跌，并标明样本覆盖',()=>{
  const summary=marketRecap({market:'US',date,indices:[indices[0],row('OLD',20,'old','2026-10-26'),row('UNKNOWN',null)],sectors:[row('平盘',0),row('OLD SECTOR',30,'old','2026-10-26'),row('INVALID',NaN)],sectorTotal:11});
  assert.equal(summary.headline,'已更新指数上涨');assert.match(summary.sections[0].text,/1\/3/);
  assert.equal(summary.sectorCoverage.covered,1);assert.match(summary.sections[1].text,/1\/11.*0 涨、0 跌、1 平/);
  assert.ok(!JSON.stringify(summary).includes('OLD'));assert.equal(summary.sections.length,2);
});
test('指数齐涨但多数行业下跌时直接指出两者分化',()=>{
  const s=marketRecap({market:'US',date,indices,sectors:[row('A',1),row('B',-1),row('C',-2)]});
  assert.match(s.sections[0].text,/三大指数齐涨，但行业 ETF 跌多于涨/);
});
test('行业全涨、全跌或并列时描述真实方向，不把抗跌当上涨',()=>{
  let s=marketRecap({market:'US',date,indices,sectors:[row('A',-1),row('B',-2),row('C',-1)]});
  assert.match(s.sections[1].text,/全部下跌/);assert.match(s.sections[2].text,/A、C.*相对抗跌/);assert.ok(!s.sections[2].text.includes('领涨'));
  s=marketRecap({market:'US',date,indices,sectors:[row('A',2),row('B',1)]});assert.match(s.sections[2].text,/涨幅落后/);assert.ok(!s.sections[2].text.includes('跌幅最大'));
  s=marketRecap({market:'US',date,indices:[row('A',0),row('B',.00001),row('C',-.00001)]});assert.equal(s.headline,'三大指数持平');
});
test('港股以恒指为基准总结科技与国企的相对强弱，不伪造行业排名',()=>{
  const s=marketRecap({market:'HK',date,indices:[row('恒生指数',-1,'HK.800000'),row('恒生国企',-1.4,'HK.800100'),row('恒生科技',-.5,'HK.800700')]});
  assert.equal(s.headline,'三大指数齐跌');assert.deepEqual(s.sections.map(r=>r.label),['市场主线','指数分化']);
  assert.match(s.sections[1].text,/恒生国企落后恒指 0.40 个百分点；恒生科技跑赢恒指 0.50 个百分点/);
  assert.ok(!JSON.stringify(s.sections).includes('行业'));
});
test('VIX 和情绪只使用同日、有效且成功取得的读数，零分有效',()=>{
  const input={market:'US',date,indices,volatility:{date:'2026-09-15',price:21.67},sentiment:{date,score:50,error:'fetch failed'}};
  let s=marketRecap(input);assert.equal(s.volatility,null);assert.equal(s.sentiment,null);assert.equal(s.sections.length,1);
  s=marketRecap({...input,volatility:{date,price:20,percent:-5},sentiment:{date,score:0,rating:'极度恐惧'}});
  assert.match(s.sections.at(-1).text,/VIX 20.00 点，较前收下降 5.00%.*0.00（极度恐惧）/);
});
