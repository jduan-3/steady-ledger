import { nowDate } from './domain.mjs';

const monthIndex=day=>Number(day.slice(0,4))*12+Number(day.slice(5,7))-1;
const periodAt=index=>String(Math.floor(index/12)).padStart(4,'0')+'-'+String(index%12+1).padStart(2,'0');
function paydayAt(period,payday) {
  const end=new Date(period+'-01T00:00:00Z');end.setUTCMonth(end.getUTCMonth()+1,0);
  return period+'-'+String(Math.min(payday,end.getUTCDate())).padStart(2,'0');
}
export function incomePlan(state,credits=[],now=new Date()) {
  const p=state.profile,config=p.autoIncome;
  if(!config?.enabled)return {enabled:false,status:'disabled',due:[],nextDate:null};
  const account=state.assets.find(a=>a.id===config.cashAssetId&&a.type==='cash'&&a.currency==='CNY'&&!a.restricted&&Number.isFinite(a.value));
  if(!account)return {enabled:true,status:'blocked',due:[],nextDate:null,message:'自动入账的人民币现金账户不可用，请重新选择。'};
  if(!Number.isFinite(p.income)||p.income<=0)return {enabled:true,status:'blocked',due:[],nextDate:null,message:'填写大于零的月收入后才能自动入账。'};
  const today=nowDate(state.preferences.timeZone,now),posted=new Set(credits.map(c=>c.period)),due=[];
  const start=monthIndex(config.startsOn),end=monthIndex(today);
  for(let month=start;month<=end;month++) {
    const period=periodAt(month),date=paydayAt(period,p.payday);
    if(date>=config.startsOn&&date<=today&&period>(config.lastPeriod||'')&&!posted.has(period))due.push({period,date,amount:p.income,assetId:account.id});
  }
  let nextDate=due[0]?.date||null;
  if(!nextDate)for(let month=Math.max(start,end,config.lastPeriod?monthIndex(config.lastPeriod+'-01')+1:0);month<=119999;month++) {
    const period=periodAt(month),date=paydayAt(period,p.payday);
    if(date>=config.startsOn&&date>today&&period>(config.lastPeriod||'')&&!posted.has(period)){nextDate=date;break;}
  }
  return {enabled:true,status:'ready',due,nextDate,accountName:account.name,amount:p.income};
}
