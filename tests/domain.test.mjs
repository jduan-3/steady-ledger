import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, validateState, calculate, evaluate, simulate, cashPaymentImpact, parseCSV, demoState } from '../src/domain.mjs';

const date = '2026-10-22';
function fixture() {
  const s = initialState(); s.profile.income = 30000; s.profile.expenses = 10000;
  s.assets = [{ id:'cash',name:'现金',type:'cash',value:55000,currency:'CNY',asOf:date,inPool:true },{id:'stock',name:'股票',type:'stock',value:45000,currency:'CNY',asOf:date,inPool:true}];
  return validateState(s);
}
test('现有现金买股保持资金守恒，45% 到 55%',()=>{
  const s=fixture(),r=simulate(s,{kind:'buy',target:'平安',amount:10000,source:'cash'});
  assert.equal(r.before.stockRatio,45);assert.ok(Math.abs(r.after.stockRatio-55)<1e-10);assert.equal(r.after.netWorth,r.before.netWorth);assert.equal(r.after.availableCash,45000);assert.ok(r.rules.some(r=>r.id==='stock-caution'));assert.equal(s.assets[0].value,55000);
});
test('50% 等号不触发，略大于时触发',()=>{
  const exact=simulate(fixture(),{kind:'buy',amount:5000});assert.equal(exact.after.stockRatio,50);assert.ok(!exact.rules.some(r=>r.id==='stock-caution'));
  const over=simulate(fixture(),{kind:'buy',amount:5000.01});assert.ok(over.rules.some(r=>r.id==='stock-caution'));
});
test('新增资金与借款买入采用不同分母，费用只损失一次',()=>{
  const ext=simulate(fixture(),{kind:'buy',amount:10000,source:'external',fee:10});
  const loan=simulate(fixture(),{kind:'buy',amount:10000,source:'borrow',payment:1000,fee:10});
  assert.equal(ext.after.pool,110000);assert.equal(loan.after.pool,99990);assert.equal(loan.after.totalDebt,10010);assert.equal(loan.after.netWorth,99990);assert.equal(loan.after.availableCash,55000);
});
test('不能用应急和专项预留补足买入现金',()=>{
  const s=fixture();s.assets[0].emergency=50000;
  const r=simulate(s,{kind:'buy',amount:10000});assert.equal(r.valid,false);assert.equal(r.after,null);assert.ok(r.rules.some(r=>r.id==='funding'));
});
test('借款买车正确揭示月现金缺口和债务增加',()=>{
  const s=fixture();s.assets[0].value=500000;s.debts=[{id:'mortgage',name:'房贷',currency:'CNY',balance:1000000,payment:12000}];
  const r=simulate(s,{kind:'loan',amount:600000,downPayment:200000,payment:9000,extraExpense:3000,assetValue:550000});
  assert.equal(r.before.surplus,8000);assert.equal(r.after.surplus,-4000);assert.equal(r.after.totalDebt,1400000);assert.equal(r.after.debtRatio,70);assert.ok(r.rules.some(r=>r.id==='cashflow'));assert.equal(r.after.netWorth,r.before.netWorth-50000);
});
test('未知月供不被当作零，不声称可以负担',()=>{
  const s=fixture();s.debts=[{id:'loan',name:'借款',currency:'CNY',balance:1000000,payment:null}];
  const m=calculate(s);assert.equal(m.surplus,null);assert.equal(m.debtRatio,null);assert.ok(evaluate(s,m).some(r=>r.id==='missing'));
});
test('本次付款独立计算现金影响，未知保费和月供不阻断余额也不变成完整承受能力',()=>{
  const s=fixture();s.assets[0].value=100000;s.profile.expenses=5500;
  s.assets.push({id:'insurance',name:'未知保费',type:'insurance',currency:'CNY',value:null,insurance:{premiumFrequency:'unknown'}});
  s.debts=[{id:'loan',name:'未知月供',currency:'CNY',balance:10000,payment:null}];
  const before=JSON.stringify(s),r=cashPaymentImpact(s,{amount:50000});
  assert.equal(r.status,'calculated');assert.equal(r.cashBefore,100000);assert.equal(r.cashAfter,50000);
  assert.equal(r.paymentPercentOfCash,50);assert.equal(r.baseExpenseCoverageMonths,9.1);
  assert.equal(r.reserveMonths,undefined);assert.equal(r.netWorth,undefined);assert.equal(r.affordable,undefined);
  assert.equal(JSON.stringify(s),before);
});
test('现金付款不动用应急、专项、受限或外币余额，余额不足不生成假设已支付的结果',()=>{
  const s=fixture();s.assets[0].value=100000;s.assets[0].emergency=40000;s.assets[0].earmarked=20000;
  s.assets.push({id:'locked',name:'受限现金',type:'cash',currency:'CNY',value:1000000,restricted:true});
  s.assets.push({id:'usd',name:'美元',type:'cash',currency:'USD',value:1000000});
  const r=cashPaymentImpact(s,{amount:50000});
  assert.equal(r.cashBefore,1100000);assert.equal(r.availableBefore,40000);assert.equal(r.status,'insufficient_cash');
  assert.equal(r.cashAfter,null);assert.equal(r.availableAfter,null);assert.equal(r.baseExpenseCoverageMonths,null);
  const paid=cashPaymentImpact(s,{amount:40000});assert.equal(paid.availableAfter,0);assert.equal(paid.baseExpenseCoverageMonths,4);
});
test('本次付款保留未知余额和生活支出，明确费用会计入付款，不修改原始资产',()=>{
  const s=fixture();s.assets[0].value=100000;s.profile.expenses=null;
  let r=cashPaymentImpact(s,{amount:50000,fee:100});assert.equal(r.cashAfter,49900);assert.equal(r.payment,50100);assert.equal(r.baseExpenseCoverageMonths,null);
  s.assets[0].value=null;r=cashPaymentImpact(s,{amount:50000});
  assert.equal(r.status,'needs_information');assert.equal(r.cashBefore,null);assert.equal(r.availableBefore,null);assert.equal(r.cashAfter,null);
  for(const amount of [0,-1,NaN,Infinity,'50000',undefined])assert.throws(()=>cashPaymentImpact(s,{amount}));
});
test('保证金账户只计净权益，名义敞口不重复加总',()=>{
  const s=fixture();s.assets.push({id:'gold',name:'黄金保证金',type:'gold_margin',currency:'CNY',value:20000,notional:200000,available:10000,asOf:date,inPool:true});
  const m=calculate(s);assert.equal(m.totalAssets,120000);assert.equal(m.pool,120000);assert.equal(m.availableCash,55000);assert.equal(m.hasLeverage,true);
  s.assets[2].value=-5000;const neg=calculate(s);assert.equal(neg.totalAssets,100000);assert.equal(neg.totalDebt,5000);assert.equal(neg.netWorth,95000);assert.equal(neg.pool,95000);
});
test('股票与基金分开统计，基金历史股票占比不影响股票仓位，也不生成缺失占比提醒',()=>{
  const s=fixture();s.assets[0].value=45000;s.assets.push({id:'fund',name:'混合基金',type:'fund',value:10000,currency:'CNY',equityRatio:null,asOf:date,inPool:true});
  for(const equityRatio of [null,0,100]){s.assets[2].equityRatio=equityRatio;const m=calculate(s);assert.equal(m.stockRatio,45);assert.equal(m.stockRatioMax,45);assert.equal(m.fundValue,10000);assert.equal(m.fundRatio,10);assert.ok(!m.missing.some(x=>x.includes('股票占比未确认')));assert.ok(!evaluate(s,m).some(r=>r.id==='stock-unknown'));}
});

test('不把房产和应急金塞进股票配置分母',()=>{
  const s=fixture();s.assets[0].emergency=10000;s.assets.push({id:'house',name:'房屋',type:'other',value:3000000,currency:'CNY',asOf:date,inPool:true});
  const m=calculate(s);assert.equal(m.totalAssets,3100000);assert.equal(m.pool,90000);assert.equal(m.stockRatio,50);assert.equal(m.availableCash,45000);
});
test('缺汇率不按零值给出精确比例；非正净值不显示 0%',()=>{
  const s=fixture();s.assets[0].currency='USD';assert.equal(calculate(s).complete,false);assert.equal(calculate(s).stockRatio,null);
  const n=fixture();n.debts=[{balance:100000,currency:'CNY',name:'融资',payment:0,investment:true}];assert.equal(calculate(n).pool,0);assert.equal(calculate(n).stockRatio,null);
});
test('提前还款更新净值与未知月供，消费可使用配置池外现金',()=>{
  const s=fixture();s.debts=[{id:'loan',name:'贷款',currency:'CNY',balance:20000,payment:2000}];
  const r=simulate(s,{kind:'repay',debtId:'loan',amount:5000});assert.equal(r.after.netWorth,r.before.netWorth);assert.equal(r.after.surplus,null);
  s.assets[0].inPool=false;assert.equal(simulate(s,{kind:'purchase',amount:1000,assetValue:0}).valid,true);
});
test('校验拒绝非法数字、日期、重复 id 和预留透支',()=>{
  const s=fixture();s.assets[0].emergency=60000;assert.throws(()=>validateState(s));s.assets[0].emergency=0;s.assets[0].asOf='2026-02-30';assert.throws(()=>validateState(s));s.assets[0].asOf=date;s.profile.income=Infinity;assert.throws(()=>validateState(s));
});
test('CSV 支持 BOM、引号和稳定编号；重复记录明确报错',()=>{
  const csv='\uFEFFname,type,account,currency,value,asOf\r\n"黄金,实物",gold_physical,A,CNY,10000,2026-10-22\r\n';
  const a=parseCSV(csv),b=parseCSV(csv);assert.equal(a[0].name,'黄金,实物');assert.equal(a[0].id,b[0].id);assert.equal(a[0].value,10000);
  assert.throws(()=>parseCSV(csv+'"黄金,实物",gold_physical,A,CNY,10000,2026-10-22\n'),/重复/);
});
test('演示数据标注清晰且不携带实际个人信息',()=>{const s=demoState(),m=calculate(s);assert.equal(s.isDemo,true);assert.equal(m.totalAssets,1280000);assert.equal(m.totalDebt,1000000);assert.equal(m.surplus,8000);});
test('负债 CSV 月供缺失保持 null，而非零',()=>{
  const rows=parseCSV('id,name,currency,balance,payment\nd1,负债示例,CNY,100000,\n','debts');const s=initialState();s.debts=rows;const validated=validateState(s);assert.equal(validated.debts[0].payment,null);assert.equal(calculate(validated).paymentComplete,false);
});
test('受限的专项预留不能掩盖近期支出缺口',()=>{
  const s=fixture();s.assets[0].restricted=true;s.assets[0].earmarked=20000;s.upcoming=[{id:'plan',name:'支出',amount:20000,date:'2026-10-23'}];
  assert.equal(calculate(s,date).upcomingGap,20000);
});

function withPolicy(overrides={}) {
  const s=fixture();s.assets.push({id:'policy',name:'储蓄保险',type:'insurance',currency:'CNY',asOf:date,value:80000,insurance:{sumAssured:1000000,paidPremiums:100000,premiumFrequency:'paid_up'},...overrides});return validateState(s);
}
test('保险只按当前价值入资产，默认池外，保额保费与可领取额不重复入账',()=>{
  const s=withPolicy({insurance:{sumAssured:1000000,paidPremiums:100000,accessibleValue:70000,premiumFrequency:'paid_up'}}),m=calculate(s,date);
  assert.equal(m.totalAssets,180000);assert.equal(m.pool,100000);assert.equal(m.availableCash,55000);assert.equal(m.stockRatio,45);assert.equal(m.categories.insurance,80000);
  assert.equal(s.assets[2].inPool,false);
});
test('保险未知价值与确认零价值有区别，不能用保额代替',()=>{
  const unknown=withPolicy({value:null}),m=calculate(unknown,date);
  assert.equal(m.totalAssets,100000);assert.equal(m.complete,false);assert.equal(m.stockRatio,45);assert.ok(m.missing.some(x=>x.includes('当前价值')));
  const zero=calculate(withPolicy({value:0}),date);assert.equal(zero.complete,true);assert.equal(zero.totalAssets,100000);
  assert.equal(calculate(withPolicy({value:null,inPool:true}),date).stockRatio,null);
});
test('续期保费按月折算，仅补计未包含于生活支出的部分',()=>{
  const s=withPolicy({insurance:{premiumAmount:12000,premiumFrequency:'yearly',premiumInExpenses:false,nextPremiumDate:'2026-11-01'}}),m=calculate(s,date);
  assert.equal(m.insuranceExpense,1000);assert.equal(m.expenses,11000);assert.equal(m.surplus,19000);assert.equal(m.insurancePremiumDue,12000);assert.ok(evaluate(s,m).some(r=>r.id==='insurance-premium'));
  s.assets[2].insurance.premiumInExpenses=true;assert.equal(calculate(s,date).expenses,10000);
  s.assets[2].insurance.premiumInExpenses=false;s.assets[2].insurance.premiumFrequency='quarterly';assert.equal(calculate(s,date).insuranceExpense,4000);
  s.assets[2].insurance.premiumFrequency='paid_up';assert.equal(calculate(s,date).insuranceExpense,0);assert.equal(calculate(s,date).insurancePremiumCount,0);
});
test('未计入生活开支的未知续期保费使结余待补充；外币保费需汇率',()=>{
  const s=withPolicy({insurance:{premiumFrequency:'yearly',premiumInExpenses:false}});assert.equal(calculate(s,date).surplus,null);assert.equal(calculate(s,date).insuranceExpenseComplete,false);
  s.assets[2].insurance.premiumAmount=12000;s.assets[2].currency='USD';assert.equal(calculate(s,date).surplus,null);
  s.preferences.rates.USD=7;assert.equal(calculate(s,date).insuranceExpense,7000);
});
test('投连险纳入配置池时保留未知股票敞口区间',()=>{
  const s=withPolicy({value:10000,inPool:true,insurance:{kind:'investment',premiumFrequency:'paid_up'}}),m=calculate(s,date);
  assert.equal(m.pool,110000);assert.equal(m.equity,45000);assert.equal(m.equityMax,55000);
  s.assets[2].equityRatio=60;assert.equal(calculate(s,date).equity,51000);assert.equal(calculate(s,date).equityMax,51000);
});
test('保险 CSV 支持空估值、保费字段、默认池外及备份往返',()=>{
  const s=fixture();s.assets.push(...parseCSV('name,type,currency,value,asOf,insuranceKind,sumAssured,paidPremiums,premiumAmount,premiumFrequency,premiumInExpenses\n年金,insurance,CNY,,2026-10-22,annuity,1000000,60000,12000,yearly,false\n'));
  const clean=validateState(s),a=clean.assets.at(-1);assert.equal(a.value,null);assert.equal(a.inPool,false);assert.equal(a.insurance.sumAssured,1000000);assert.equal(a.insurance.premiumInExpenses,false);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(clean))),clean);
});
test('选填背景保留未知与零，旧档案无需补字段即可打开',()=>{
  const s=fixture();s.profile.background={scope:'household',dependents:0,incomeFloor:0,comfortableLoss:0,priorities:'两年后首付'};
  const clean=validateState(s);assert.equal(clean.profile.background.dependents,0);assert.equal(clean.profile.background.incomeFloor,0);assert.equal(clean.profile.background.retirementYears,null);
  delete s.profile.background;assert.equal(validateState(s).profile.background.scope,'');
});
test('私人助手称呼兼容旧档案，可修改、留空并随备份往返',()=>{
  const s=fixture();delete s.profile.background;
  assert.equal(validateState(s).profile.background.displayName,'');
  s.profile.background={displayName:'  Sample User  '};
  const clean=validateState(s);assert.equal(clean.profile.background.displayName,'Sample User');
  assert.equal(validateState(JSON.parse(JSON.stringify(clean))).profile.background.displayName,'Sample User');
  s.profile.background.displayName='';assert.equal(validateState(s).profile.background.displayName,'');
  s.profile.background.displayName='a'.repeat(81);assert.throws(()=>validateState(s),/称呼/);
  assert.equal(demoState().profile.background.displayName,'');
});
