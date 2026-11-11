import { nowDate } from './domain.mjs';

const monthIndex=day=>Number(day.slice(0,4))*12+Number(day.slice(5,7))-1;
const periodAt=index=>String(Math.floor(index/12)).padStart(4,'0')+'-'+String(index%12+1).padStart(2,'0');
const monthEnd=period=>new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);

export function expensePlan(state,debits=[],now=new Date()) {
  const p=state.profile,config=p.autoExpenses;
  if(!config?.enabled)return {enabled:false,status:'disabled',due:[],nextDate:null};
  const account=state.assets.find(a=>a.id===config.cashAssetId&&a.type==='cash'&&a.currency==='CNY'&&!a.restricted&&Number.isFinite(a.value));
  if(!account)return {enabled:true,status:'blocked',due:[],nextDate:null,message:'必要支出的人民币现金账户不可用，请重新选择。'};
  if(!Number.isFinite(p.expenses)||p.expenses<=0)return {enabled:true,status:'blocked',due:[],nextDate:null,message:'填写大于零的每月必要生活支出后才能自动扣减。'};
  const today=nowDate(state.preferences.timeZone,now),posted=new Set(debits.map(d=>d.period)),due=[];
  const start=monthIndex(config.startsOn),end=monthIndex(today);
  for(let month=start;month<=end;month++) {
    const period=periodAt(month),date=monthEnd(period);
    if(date>=config.startsOn&&date<=today&&period>(config.lastPeriod||'')&&!posted.has(period))due.push({period,date,amount:p.expenses,assetId:account.id});
  }
  let nextDate=due[0]?.date||null;
  if(!nextDate)for(let month=Math.max(start,end,config.lastPeriod?monthIndex(config.lastPeriod+'-01')+1:0);month<=119999;month++) {
    const period=periodAt(month),date=monthEnd(period);
    if(date>=config.startsOn&&date>today&&period>(config.lastPeriod||'')&&!posted.has(period)){nextDate=date;break;}
  }
  const result={enabled:true,status:'ready',due,nextDate,accountName:account.name,amount:p.expenses};
  const required=Math.round(due.reduce((sum,item)=>sum+item.amount,0)*100)/100;
  if(required>account.value)return {...result,status:'blocked',due:[],message:`现金账户余额不足，待扣必要支出 ${required.toLocaleString('zh-CN')} 元；尚未扣减，请核对账户余额。`};
  return result;
}
