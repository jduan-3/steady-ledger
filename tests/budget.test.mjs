import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,validateState,nowDate,DEFAULT_GRID} from '../src/domain.mjs';
import {stockFundingPlan} from '../src/budget.mjs';
function fixture(){const s=initialState();s.profile={...s.profile,income:20000,expenses:1000,emergencyMonths:2};s.policy.stockLimit=75;s.preferences.rates={CNY:1,HKD:1,USD:7};s.assets=[{id:'cash',name:'PRIVATE CASH',account:'PRIVATE ACCOUNT',type:'cash',currency:'CNY',value:55000,asOf:nowDate()},{id:'stock',name:'PRIVATE STOCK',type:'stock',currency:'CNY',value:45000,asOf:nowDate()}];return validateState(s);}
test('funding uses the confirmed 75% cap rather than the caution line and stages equal amounts without a dividend prerequisite',()=>{const s=fixture(),before=JSON.stringify(s),r=stockFundingPlan(s,{currency:'CNY',totalBudget:20000});assert.equal(r.status,'calculated');assert.equal(r.funding.capacityCNY,30000);assert.equal(r.funding.withinCautionCNY,5000);assert.equal(r.plan.suggestedTranche,5000);assert.equal(r.plan.reservedForLaterCNY,15000);assert.equal(r.grid.hasDividendRequirement,false);assert.equal(r.grid.maxNewTranchesPerReview,1);assert.equal(r.grid.confirmedFilledLevels,null);assert.equal(JSON.stringify(s),before);});
test('funding preserves existing earmarks, replenishes emergency reserves and accounts for upcoming payments',()=>{const s=fixture();s.assets[0].emergency=1000;s.assets[0].earmarked=5000;s.profile.expenses=10000;s.upcoming=[{id:'u',name:'PRIVATE PLAN',amount:15000,date:nowDate()}];const r=stockFundingPlan(s);assert.equal(r.funding.emergencyTopUpCNY,19000);assert.equal(r.funding.plannedReserveCNY,10000);assert.equal(r.funding.liquidCapacityCNY,20000);assert.equal(r.funding.capacityCNY,20000);assert.ok(!JSON.stringify(r).includes('PRIVATE'));});
test('unknown insurance costs block budget; funds are counted separately from stock capacity',()=>{const s=fixture();s.assets.push({id:'insurance',name:'PRIVATE POLICY',type:'insurance',value:50000,currency:'CNY',inPool:false,asOf:nowDate(),insurance:{premiumFrequency:'unknown'}});let r=stockFundingPlan(validateState(s));assert.equal(r.status,'needs_information');assert.equal(r.plan.suggestedTranche,null);s.assets.pop();s.assets[0].value=10000;s.assets.push({id:'f',name:'fund',type:'fund',currency:'CNY',value:45000,asOf:nowDate(),equityRatio:null,inPool:true});r=stockFundingPlan(validateState(s));assert.equal(r.status,'calculated');assert.equal(r.funding.conservativeExposure,false);assert.equal(r.funding.capacityCNY,8000);assert.equal(r.plan.suggestedTrancheCNY,2000);});
test('negative cashflow and an already full allocation block additional funding',()=>{const s=fixture();s.profile.income=0;assert.equal(stockFundingPlan(s).status,'blocked');assert.equal(stockFundingPlan(s).plan.suggestedTranche,0);s.profile.income=20000;s.assets[0].value=15000;assert.equal(stockFundingPlan(s).funding.capacityCNY,0);});
test('US shares use a whole share, Hong Kong shares require a known board lot, and grid triggers are distinct from affordability',()=>{const s=fixture();s.assets[1]={...s.assets[1],currency:'USD',value:45000/7,security:{market:'US',symbol:'GOOG',key:'US.GOOG',currency:'USD'},quantity:7,costBasis:{quantity:7,amount:700,currency:'USD'}};let r=stockFundingPlan(s,{key:'US.GOOG',totalBudget:1000,price:94});assert.equal(r.grid.nextBuyReference,95);assert.equal(r.grid.buyLevelReached,true);assert.equal(r.plan.suggestedTranche,250);assert.equal(r.plan.estimatedShares,2);assert.equal(r.plan.estimatedOrderAmount,188);r=stockFundingPlan(s,{key:'HK.02318',totalBudget:20000,price:50});assert.equal(r.plan.estimatedShares,null);r=stockFundingPlan(s,{key:'HK.02318',totalBudget:20000,price:50,lotSize:100});assert.equal(r.plan.estimatedShares,100);});
test('issuer limits aggregate A/H listings, require identification for a new issuer, and do not leak names',()=>{const s=fixture();s.assets[1]={...s.assets[1],value:10000,issuer:'PRIVATE ISSUER',security:{key:'SH.601318',market:'SH',symbol:'601318',currency:'CNY'}};s.assets.push({...s.assets[1],id:'hk',currency:'HKD',value:10000,security:{key:'HK.02318',market:'HK',symbol:'02318',currency:'HKD'}});s.policy.issuerLimit=30;let r=stockFundingPlan(s,{key:'HK.02318'});assert.equal(r.funding.capacityCNY,2500);assert.ok(!JSON.stringify(r).includes('PRIVATE'));r=stockFundingPlan(s,{key:'US.GOOG'});assert.equal(r.status,'needs_information');});
test('draft grid settings survive validation and reject invalid parameters',()=>{const s=fixture();delete s.policy.grid;assert.deepEqual(validateState(s).policy.grid,DEFAULT_GRID);for(const grid of [{stepPercent:0},{tranches:2.5},{tranches:13},{perStockBudgetCNY:-1}])assert.throws(()=>validateState({...s,policy:{...s.policy,grid}}));});

test('a configured purchase percentage uses the whole allocation pool, takes priority over grid counts and respects smaller budgets',()=>{
  const s=fixture();s.policy.buyTranchePercent=1;
  let r=stockFundingPlan(s,{totalBudget:20000});
  assert.equal(r.plan.suggestedTrancheCNY,1000);assert.equal(r.plan.reservedForLaterCNY,19000);assert.equal(r.plan.tranchePortfolioPercent,1);assert.equal(r.plan.trancheBasis,'allocation_pool_net_value');
  s.policy.grid.enabled=false;r=stockFundingPlan(s,{currency:'USD',totalBudget:1000});
  assert.equal(r.plan.suggestedTrancheCNY,1000);assert.equal(r.plan.suggestedTranche,142.85);
  r=stockFundingPlan(s,{totalBudget:500});assert.equal(r.plan.suggestedTrancheCNY,500);
  s.profile.income=null;assert.equal(stockFundingPlan(s).plan.suggestedTrancheCNY,null);
});
test('a one percent purchase shrinks to remaining issuer capacity and stops at the thirty percent limit',()=>{
  const s=fixture();s.policy.issuerLimit=30;s.policy.buyTranchePercent=1;
  s.assets[1]={...s.assets[1],value:29500,issuer:'TEST ISSUER',security:{key:'SH.601318',market:'SH',symbol:'601318',currency:'CNY'}};
  s.assets.push({id:'other',name:'OTHER',type:'stock',currency:'CNY',value:15500,asOf:nowDate(),inPool:true,issuer:'OTHER ISSUER'});
  let r=stockFundingPlan(s,{key:'SH.601318'});
  assert.equal(r.funding.issuerLimitPercent,30);assert.equal(r.funding.issuerCapacityCNY,500);assert.equal(r.plan.suggestedTrancheCNY,500);
  s.assets[1].value=30000;s.assets[0].value=54500;r=stockFundingPlan(s,{key:'SH.601318'});
  assert.equal(r.funding.issuerCapacityCNY,0);assert.equal(r.plan.suggestedTrancheCNY,0);
  r=stockFundingPlan(s,{key:'US.GOOG'});assert.equal(r.status,'needs_information');assert.equal(r.plan.suggestedTrancheCNY,null);
});
test('purchase percentages survive saved-state validation, old states remain compatible and invalid percentages are rejected',()=>{
  const s=fixture();delete s.policy.buyTranchePercent;assert.equal(validateState(s).policy.buyTranchePercent,null);
  s.policy.buyTranchePercent=1;assert.equal(validateState(s).policy.buyTranchePercent,1);
  for(const value of [0,-1,101,Infinity,'1'])assert.throws(()=>validateState({...s,policy:{...s.policy,buyTranchePercent:value}}));
});
