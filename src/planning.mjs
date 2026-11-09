import { nowDate } from './domain.mjs';

const round=value=>Math.round(value*100)/100;
const shift=(day,delta)=>new Date(Date.parse(day)+86400000*delta).toISOString().slice(0,10);
const monthEnd=day=>new Date(Date.UTC(+day.slice(0,4),+day.slice(5,7),0)).getUTCDate();
const monthIndex=day=>Number(day.slice(0,4))*12+Number(day.slice(5,7));

export function cashCalendar(state,{day=nowDate(state.preferences.timeZone),includePlans=false}={}) {
  const rows=[],missing=new Set(),rates=state.preferences.rates;
  let balance=0;
  const convert=(value,currency,label)=>{
    if(!Number.isFinite(value)||!(rates[currency]>0)){missing.add(label+'金额或汇率待补');return null;}
    return value*rates[currency];
  };
  for(const a of state.assets.filter(a=>a.type==='cash'&&!a.restricted)){
    const value=convert(a.value,a.currency,a.name);
    if(value!==null)balance+=value;
  }
  const opening=round(balance),profile=state.profile,debts=state.debts.filter(d=>d.balance>0);
  let low=opening,lowDate=day;
  // Opening balance is today's closing assumption. Forecast the next 90 days.
  for(let i=1;i<=90;i++){
    const date=shift(day,i),dom=Number(date.slice(-2)),end=monthEnd(date),events=[];
    const add=(name,amount,currency='CNY')=>{
      const value=convert(amount,currency,name);
      if(value!==null&&value!==0)events.push({name,amount:round(value)});
    };
    if(dom===Math.min(profile.payday||1,end))add('预计工资',profile.income);
    if(profile.expenses==null)missing.add('每月生活支出待补');
    else add('生活支出（日均）',-(round(profile.expenses*dom/end)-round(profile.expenses*(dom-1)/end)));
    for(const debt of debts){
      if(debt.maturity&&date>debt.maturity)continue;
      if(debt.payment==null)missing.add(debt.name+'月供待补');
      if(dom===end&&debt.payment!=null)add(debt.name+'月供（月末估算）',-debt.payment,debt.currency);
      if(debt.maturity===date)missing.add(debt.name+'到期剩余应还本金需核实，未计入');
    }
    for(const a of state.assets.filter(a=>a.insurance)){
      const ins=a.insurance,anchor=ins.nextPremiumDate;
      if(ins.premiumInExpenses||ins.premiumFrequency==='paid_up')continue;
      if(ins.premiumFrequency==='single'){if(anchor===date&&ins.premiumAmount!=null)add(a.name+'一次性保费',-ins.premiumAmount,a.currency);continue;}
      const interval={monthly:1,quarterly:3,yearly:12}[ins.premiumFrequency];
      if(!anchor||!interval||ins.premiumAmount==null){missing.add(a.name+'保费日期、周期或金额待补');continue;}
      if(date>=anchor&&(monthIndex(date)-monthIndex(anchor))%interval===0&&dom===Math.min(+anchor.slice(-2),end))add(a.name+'保费',-ins.premiumAmount,a.currency);
    }
    for(const item of state.upcoming.filter(u=>u.date===date))add(item.name,-item.amount);
    if(includePlans)for(const p of (state.buyPlans||[]).filter(p=>p.status==='pending')){
      if(!p.plannedDate||p.plannedDate<=day||p.amount==null){missing.add(p.name+'计划日期或金额待确认');continue;}
      if(p.plannedDate===date)add(p.name+'（计划买入）',-p.amount,p.currency);
    }
    balance=round(balance+events.reduce((sum,e)=>sum+e.amount,0));
    rows.push({date,events,balance});
    if(balance<low){low=balance;lowDate=date;}
  }
  return {day,opening,low,lowDate,rows,missing:[...missing],includePlans};
}

export function financialSnapshot(s,m,day) {
  const positions=s.assets.map(a=>({id:a.id,type:a.type,currency:a.currency,value:a.value,quantity:a.quantity,quoted:a.valuation?.status==='quote'||a.valuation?.status==='nav'}));
  for(const d of s.debts)positions.push({id:'debt:'+d.id,type:'debt',currency:d.currency,value:-d.balance});
  return {day,netWorth:m.netWorth,totalAssets:m.totalAssets,debt:m.totalDebt,revision:s.revision,complete:m.complete,...(!m.complete?{missing:m.missing}:{}),rates:s.preferences.rates,positions};
}

export function monthlyBridge(month,base,rows,entries,credits) {
  const last=rows.at(-1),result={month,from:base?.day,to:last?.day,complete:false};
  if(!last||!base||base.day!==shift(month+'-01',-1)||[base,...rows].some(r=>r.complete!==true))return {...result,reason:'缺少完整的上月末或本月估值快照'};
  let fx=0,market=0,cash=0,adjustments=0,previous=base;
  for(const row of rows){
    const changes=entries.filter(e=>e.status==='applied'&&e.revision>previous.revision&&e.revision<=row.revision);
    const traded=new Set(changes.filter(e=>['holding','balance','remove'].includes(e.kind)).map(e=>e.asset.id));
    const earlier=new Map((previous.positions||[]).map(a=>[a.id,a]));
    for(const a of row.positions||[]){
      const p=earlier.get(a.id);
      if(!p||p.currency!==a.currency)continue;
      const r=row.rates?.[a.currency],old=previous.rates?.[a.currency];
      if(!(r>0&&old>0)||p.value==null||a.value==null)continue;
      fx+=p.value*(r-old);
      if(!traded.has(a.id)&&a.quoted&&p.quoted&&a.quantity===p.quantity&&a.quantity>0)market+=(a.value-p.value)*r;
    }
    for(const e of changes){
      const rate=row.rates?.[e.asset?.currency]??(e.asset?.currency==='CNY'?1:null);
      if(!rate)continue;
      if(e.kind==='cash')cash+=(e.side==='income'?1:-1)*e.amount*rate;
      if(e.kind==='reconcile'&&e.unit==='金额'&&e.adjusted)adjustments+=e.difference*rate;
    }
    previous=row;
  }
  cash+=credits.filter(c=>c.revision>base.revision&&c.revision<=last.revision).reduce((s,c)=>s+c.amount,0);
  const total=round(last.netWorth-base.netWorth);
  return {...result,complete:true,total,cash:round(cash),market:round(market),fx:round(fx),adjustments:round(adjustments),other:round(total-round(cash)-round(market)-round(fx)-round(adjustments))};
}
