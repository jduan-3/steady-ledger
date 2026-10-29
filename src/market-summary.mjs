const fixed=n=>n.toFixed(2),signed=n=>(n>0?'+':n<0?'−':'')+fixed(Math.abs(n));
const breadth=rows=>({up:rows.filter(r=>r.percent>0).length,down:rows.filter(r=>r.percent<0).length,flat:rows.filter(r=>r.percent===0).length,total:rows.length});
// A recap compares only observations from its own trading day, never old cache rows.
export function marketRecap({market,date,indices=[],sectors=[],indexTotal=3,sectorTotal=sectors.length,volatility=null,sentiment=null}) {
  const current=rows=>rows.filter(r=>date&&r.date===date&&Number.isFinite(r.percent)).map(r=>({...r,percent:Number(fixed(r.percent))}));
  indices=current(indices);sectors=current(sectors);
  const indexBreadth=breadth(indices),sectorBreadth=sectors.length?breadth(sectors):null,sections=[];
  const direction=indexBreadth.up===indices.length?'上涨':indexBreadth.down===indices.length?'下跌':indexBreadth.flat===indices.length?'持平':'分化';
  const headline=indices.length?(indices.length===indexTotal?`三大指数${direction==='上涨'?'齐涨':direction==='下跌'?'齐跌':direction}`:`已更新指数${direction}`):sectors.length?'行业表现概览':'等待同日行情';
  if(indices.length){
    let text=headline+'。';
    if(market==='US'&&indices.length===indexTotal&&sectorBreadth&&sectors.length===sectorTotal){
      if(indexBreadth.up===indices.length&&sectorBreadth.down>sectorBreadth.up)text=headline+'，但行业 ETF 跌多于涨。';
      else if(indexBreadth.down===indices.length&&sectorBreadth.up>sectorBreadth.down)text=headline+'，但行业 ETF 涨多于跌。';
    }
    if(indices.length<indexTotal)text+=`同日有效指数 ${indices.length}/${indexTotal} 项。`;
    if(market==='US'&&indices.length>1){
      const sorted=[...indices].sort((a,b)=>b.percent-a.percent),gap=sorted[0].percent-sorted.at(-1).percent;
      if(gap>0){const leaders=sorted.filter(r=>r.percent===sorted[0].percent).map(r=>r.name).join('、'),laggards=sorted.filter(r=>r.percent===sorted.at(-1).percent).map(r=>r.name).join('、');text+=`${leaders}相对领先，${laggards}相对落后，首尾相差 ${fixed(gap)} 个百分点。`;}
      else text+='各指数涨跌幅相同。';
    }
    sections.push({label:'市场主线',text});
  }
  if(market==='HK'&&indices.length>1){
    const base=indices.find(r=>r.key==='HK.800000'),comparisons=base?indices.filter(r=>r!==base).map(r=>{const gap=r.percent-base.percent;return gap===0?`${r.name}与恒指同步`:`${r.name}${gap>0?'跑赢':'落后'}恒指 ${fixed(Math.abs(gap))} 个百分点`; }):[];
    if(!base){const sorted=[...indices].sort((a,b)=>b.percent-a.percent),gap=sorted[0].percent-sorted.at(-1).percent;comparisons.push(gap>0?`${sorted[0].name}相对${sorted.at(-1).name}领先 ${fixed(gap)} 个百分点`:'已更新指数涨跌幅相同');}
    sections.push({label:'指数分化',text:comparisons.join('；')+'。'});
  }
  if(sectors.length){
    const b=sectorBreadth,scope=sectors.length<sectorTotal?`已更新 ${sectors.length}/${sectorTotal} 只行业 ETF`:`${sectors.length} 只行业 ETF`;
    const pattern=b.up===b.total?'全部上涨':b.down===b.total?'全部下跌':b.flat===b.total?'全部持平':b.up>b.down?'上涨多于下跌':b.down>b.up?'下跌多于上涨':'涨跌数量相当';
    sections.push({label:'行业广度',text:`${scope} 中，${b.up} 涨、${b.down} 跌、${b.flat} 平，${pattern}；仅代表行业 ETF 样本。`});
    const sorted=[...sectors].sort((a,b)=>b.percent-a.percent),gap=sorted[0].percent-sorted.at(-1).percent;
    if(gap>0){
      const group=value=>sorted.filter(r=>r.percent===value).map(r=>r.name).join('、');
      sections.push({label:'行业强弱',text:`${group(sorted[0].percent)}（${signed(sorted[0].percent)}%）${sorted[0].percent>0?'领涨':'相对抗跌'}，${group(sorted.at(-1).percent)}（${signed(sorted.at(-1).percent)}%）${sorted.at(-1).percent<0?'跌幅最大':'涨幅落后'}；首尾相差 ${fixed(gap)} 个百分点。`});
    }
  }
  volatility=market==='US'&&date&&volatility?.date===date&&Number.isFinite(volatility.price)&&volatility.price>0?volatility:null;
  sentiment=market==='US'&&date&&sentiment?.date===date&&Number.isFinite(sentiment.score)&&sentiment.score>=0&&sentiment.score<=100&&!sentiment.error?sentiment:null;
  const context=[];
  if(volatility)context.push(`VIX ${fixed(volatility.price)} 点${Number.isFinite(volatility.percent)?`，较前收${volatility.percent>0?'上升':volatility.percent<0?'下降':'持平'}${volatility.percent===0?'':` ${fixed(Math.abs(volatility.percent))}%`}`:''}`);
  if(sentiment)context.push(`CNN 恐惧与贪婪指数 ${fixed(sentiment.score)}${sentiment.rating?`（${sentiment.rating}）`:''}`);
  if(context.length)sections.push({label:'波动与情绪',text:context.join('；')+'。'});
  return {date,headline,sections,indices,sectors,indexBreadth,sectorBreadth,indexCoverage:{covered:indices.length,total:indexTotal},sectorCoverage:{covered:sectors.length,total:sectorTotal},volatility,sentiment};
}
