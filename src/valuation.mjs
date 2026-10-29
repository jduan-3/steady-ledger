import { nowDate } from './domain.mjs';
const round=x=>Math.round(x*100)/100;
export function priceMovement(quote, quantity = null) {
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(quote.previous?.price) || quote.previous.price <= 0) return null;
  const change = quote.price - quote.previous.price;
  return { price: quote.price, previousPrice: quote.previous.price, change, percent: change / quote.previous.price * 100,
    amount: Number.isFinite(quantity) ? round(change * quantity) : null, date: quote.date, currency: quote.currency };
}
export function dailyValuation(state,metrics,history,day=nowDate(state.preferences.timeZone)){
  const yesterday=new Date(Date.parse(day)-86400000).toISOString().slice(0,10),prior=history.find(h=>h.day===yesterday);
  const delta=prior&&metrics.complete&&prior.complete!==false?round(metrics.netWorth-prior.netWorth):null;
  const funds=state.assets.filter(a=>a.fund?.autoNav),ready=funds.filter(a=>['nav','manual'].includes(a.valuation?.status)&&a.valuation.previous&&a.quantity!=null);
  const dates=[...new Set(ready.map(a=>a.valuation.date))],previousDates=[...new Set(ready.map(a=>a.valuation.previous.date))];
  const comparable=funds.length>0&&ready.length===funds.length&&dates.length===1&&previousDates.length===1;
  return {day,delta,baseline:prior?.day??null,bookChanged:prior?prior.revision!==state.revision:false,
    funds:funds.length?{amount:comparable?round(ready.reduce((sum,a)=>sum+a.quantity*(a.valuation.price-a.valuation.previous.price),0)):null,date:dates.length===1?dates[0]:null,count:funds.length,scope:'按当前份额估算的基金净值变化，不含买卖、现金分红和保险价值变化'}:null};
}
