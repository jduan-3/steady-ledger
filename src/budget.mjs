import { calculate, nowDate, DEFAULT_GRID } from './domain.mjs';
import { securityKey } from './securities.mjs';

const floor = n => Math.floor((n+1e-9)*100)/100;
const money = n => Math.round(n*100)/100;
const positive = n => typeof n==='number'&&Number.isFinite(n)&&n>0;

// Funding and staging only. Does not determine a company's investment merits or place orders.
export function stockFundingPlan(state,input={}) {
  const m=calculate(state),grid={...DEFAULT_GRID,...state.policy.grid},missing=[],blocked=[];
  const target=input.key?securityKey(input.key):null,currency=target?.currency||input.currency||'CNY',rate=state.preferences.rates[currency];
  if(!['CNY','HKD','USD'].includes(currency))throw new Error('不支持的预算币种');
  for(const k of ['totalBudget','desiredAmount','price','anchorPrice'])if(input[k]!=null&&(!positive(input[k])||input[k]>1e14))throw new Error('金额及参考价需要为大于零的有效数字');
  if(!positive(rate))missing.push('目标币种的人民币汇率');
  const cash=state.assets.filter(a=>a.type==='cash'&&a.currency==='CNY'&&!a.restricted);
  const free=cash.reduce((s,a)=>s+Math.max(0,a.value-(a.emergency||0)-(a.earmarked||0)),0);
  const poolFree=cash.filter(a=>a.inPool).reduce((s,a)=>s+Math.max(0,a.value-(a.emergency||0)-(a.earmarked||0)),0);
  const emergency=cash.reduce((s,a)=>s+(a.emergency||0),0),earmarked=cash.reduce((s,a)=>s+(a.earmarked||0),0);
  if(!m.poolComplete||m.pool<=0)missing.push('配置池内的有效估值与汇率');
  if(!m.paymentComplete)missing.push('债务月供');
  if(m.expenses==null)missing.push(m.insuranceExpenseComplete?'必要生活支出':'续期保费周期、金额或是否已计入生活开支');
  if(m.income==null)missing.push('税后经常性月收入');
  if(m.surplus!=null&&m.surplus<0)blocked.push('经常性现金流为负');
  if(state.debts.some(d=>d.overdue))blocked.push('存在已登记逾期债务');
  if(m.stale.length)missing.push('超过有效天数的持仓估值');
  const targetReserve=m.emergencyTarget??(m.expenses===0&&m.paymentComplete&&m.payment===0?0:null);
  if(targetReserve==null)missing.push('可核定的应急储备目标');
  const reserveTopUp=targetReserve==null?null:Math.max(0,targetReserve-emergency);
  const plannedReserve=Math.max(0,m.upcomingTotal-earmarked)+m.insurancePremiumDue;
  const liquidCapacity=reserveTopUp==null?null:floor(Math.max(0,Math.min(poolFree,free-reserveTopUp-plannedReserve)));
  const cap=state.policy.stockLimit??state.policy.stockCaution;
  const ratioCapacity=m.poolComplete&&m.pool>0?floor(Math.max(0,cap/100*m.pool-m.equityMax)):null;
  const cautionCapacity=m.poolComplete&&m.pool>0?floor(Math.max(0,state.policy.stockCaution/100*m.pool-m.equityMax)):null;
  if(m.poolComplete&&m.pool>0&&m.equity/m.pool*100>=cap)blocked.push('股票敞口已达到设置的仓位上限');
  const holdings=target?state.assets.filter(a=>a.type==='stock'&&a.security?.key===target.key):[];
  const issuer=holdings[0]?.issuer||null;
  let issuerCapacity=null;
  if(state.policy.issuerLimit!=null){
    if(!target)missing.push('拟买入股票的代码，用于核对发行人集中度');
    else if(!issuer)missing.push('拟买入股票与现有 A/H 持仓的发行人归属');
    else issuerCapacity=floor(Math.max(0,state.policy.issuerLimit/100*m.pool-(m.issuers[issuer]||0)));
  }
  const conservative=m.equityMax>m.equity;
  if(ratioCapacity===0&&conservative&&!blocked.length)missing.push('投连险的实际股票占比；保守上界已用完新增仓位空间');
  const constraints=[liquidCapacity,ratioCapacity,issuerCapacity,grid.perStockBudgetCNY].filter(n=>n!=null);
  const known=missing.length===0,capacity=known?(blocked.length?0:floor(Math.min(...constraints))):null;
  const budgetCNY=capacity==null?null:floor(Math.min(capacity,input.totalBudget==null?capacity:input.totalBudget*rate));
  const tranchePercent=state.policy.buyTranchePercent??null;
  const trancheCNY=budgetCNY==null?null:floor(tranchePercent==null?budgetCNY/(grid.enabled?grid.tranches:1):Math.min(budgetCNY,m.pool*tranchePercent/100));
  const amount=trancheCNY==null||!positive(rate)?null:floor(trancheCNY/rate);
  const quantity=holdings.reduce((s,a)=>s+(a.quantity||0),0),costs=holdings.map(a=>a.costBasis?.quantity===a.quantity?a.costBasis?.amount:null);
  const average=quantity>0&&costs.every(n=>n!=null)?costs.reduce((a,b)=>a+b,0)/quantity:null;
  const anchor=input.anchorPrice??average??input.price??null;
  const nextBuy=anchor==null?null:Number((anchor*(1-grid.stepPercent/100)).toFixed(6));
  const triggered=quantity>0&&positive(input.price)&&nextBuy!=null?input.price<=nextBuy:null;
  const lot=target?.market==='US'?1:Number.isInteger(input.lotSize)&&input.lotSize>0?input.lotSize:null;
  const shares=positive(input.price)&&lot&&amount!=null?Math.floor(amount/input.price/lot)*lot:null;
  const orderAmount=shares==null?null:money(shares*input.price);
  return {status:missing.length?'needs_information':blocked.length?'blocked':'calculated',snapshotRevision:state.revision,asOf:nowDate(state.preferences.timeZone),currency,
    missing:[...new Set(missing)],blocked,scope:'只评估资金能力与分批安排，不判断个股是否值得买，不会下单或改账',
    funding:{freeCNY:money(free),poolFreeCNY:money(poolFree),emergencyTopUpCNY:reserveTopUp==null?null:money(reserveTopUp),plannedReserveCNY:money(plannedReserve),liquidCapacityCNY:liquidCapacity,
      portfolioLimitPercent:cap,portfolioCapacityCNY:ratioCapacity,cautionPercent:state.policy.stockCaution,withinCautionCNY:cautionCapacity,conservativeExposure:conservative,
      currentStockPercent:m.stockRatio,currentStockPercentMax:m.stockRatioMax,issuerLimitPercent:state.policy.issuerLimit,issuerCapacityCNY:issuerCapacity,capacityCNY:capacity,capacity:capacity==null||!positive(rate)?null:floor(capacity/rate)},
    plan:{totalBudgetCNY:budgetCNY,totalBudget:budgetCNY==null||!positive(rate)?null:floor(budgetCNY/rate),suggestedTrancheCNY:trancheCNY,suggestedTranche:amount,
      tranchePortfolioPercent:tranchePercent,trancheBasis:tranchePercent==null?'equal_budget_tranches':'allocation_pool_net_value',
      reservedForLaterCNY:budgetCNY==null?null:money(budgetCNY-trancheCNY),estimatedShares:shares,estimatedOrderAmount:orderAmount,lotSize:lot,
      affordable:input.desiredAmount==null||capacity==null?null:input.desiredAmount*rate<=capacity,
      stockPercentAfter:m.pool>0&&trancheCNY!=null?(m.equity+trancheCNY)/m.pool*100:null,
      stockPercentMaxAfter:m.pool>0&&trancheCNY!=null?(m.equityMax+trancheCNY)/m.pool*100:null},
    grid:{...grid,hasDividendRequirement:false,reference:input.anchorPrice?'本轮指定参考价':average!=null?'当前持仓平均成本（临时参考）':anchor!=null?'本轮报价（建仓参考）':'参考价待补',anchorPrice:anchor,nextBuyReference:nextBuy,
      nextSellReviewReference:anchor==null?null:Number((anchor*(1+grid.stepPercent/100)).toFixed(6)),buyLevelReached:triggered,maxNewTranchesPerReview:1,confirmedFilledLevels:null},
    assumptions:['新增投入仅使用现有人民币配置现金，外币金额是按已登记汇率折算的换汇计划，不代表券商内已有外币余额。','金额未包含交易及换汇费用，实际下单金额应预留费用。','先扣除未补足的应急目标、未由专项款覆盖的近期支出和临近保费；不计入未来尚未到账的收入。','每笔重新核对预算与仓位；跨多格不补齐、不倍投，现有持仓不擅自分配到已成交格子。'],
    instruction:'简明回答资金层面能否承担。能核定时给资金上限、本笔金额和剩余安排；不能核定时仅说关键约束和真正缺项。capacityCNY或建议金额为null表示尚不可核定，不能称已核定额度为0；portfolioCapacityCNY为0仅表示保守仓位空间为0。谨慎线是提醒，不替代已确认的上限；超线需说明。网格条件与资金结论分开，未触格不等于资金不足。不要重问档案已有的生活支出或应急月数。'};
}
