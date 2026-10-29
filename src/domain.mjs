import { randomUUID } from 'node:crypto';
import { security } from './securities.mjs';

export const ASSET_TYPES = ['cash', 'stock', 'fund', 'bond', 'gold_accum', 'gold_physical', 'gold_margin', 'insurance', 'other'];
export const DEFAULT_DISPLAY_NAME = '';
export const DEFAULT_GRID = Object.freeze({enabled:true,stepPercent:5,tranches:4,perStockBudgetCNY:null});
export const nowDate = (timeZone = 'Asia/Shanghai', date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export function initialState() {
  return {
    version: 1, revision: 0, isDemo: false,
    profile: { income: null, expenses: null, incomeStability: 'unknown', payday: 10, emergencyMonths: 6, note: '', autoIncome:{enabled:false,cashAssetId:'',startsOn:'',lastPeriod:''}, background: { displayName: DEFAULT_DISPLAY_NAME } },
    policy: { stockCaution: 50, stockLimit: null, debtRatioLimit: null, issuerLimit: null, buyTranchePercent: null, staleDays: 7, grid: {...DEFAULT_GRID} },
    preferences: { timeZone: 'Asia/Shanghai', reportTime: '20:00', rates: { CNY: 1 }, autoFx: true },
    assets: [], debts: [], upcoming: [], decisions: []
  };
}

function number(value, name, { optional = false, min = 0, max = 1e14 } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}需要是 ${min} 至 ${max} 范围内的数字`);
  return value;
}
function text(value, name, max = 120) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name}格式不正确`);
  return value.trim();
}
function dateField(value, name) {
  const result = text(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new Error(`${name}必须是有效日期 YYYY-MM-DD`);
  return result;
}
export function validateState(input) {
  if (!input || typeof input !== 'object' || input.version !== 1) throw new Error('不支持的备份或数据版本');
  const clean = initialState();
  clean.revision = number(input.revision ?? 0, '数据版本');
  clean.isDemo = input.isDemo === true;
  const p = input.profile ?? {};
  clean.profile = {
    income: number(p.income, '月收入', { optional: true }), expenses: number(p.expenses, '必要月支出', { optional: true }),
    incomeStability: ['stable', 'variable', 'none'].includes(p.incomeStability) ? p.incomeStability : 'unknown',
    payday: number(p.payday ?? 10, '发薪日', { min: 1, max: 31 }), emergencyMonths: number(p.emergencyMonths ?? 6, '应急目标月数', { min: 0, max: 120 }), note: text(p.note ?? '', '备注', 1000)
  };
  const autoIncome=p.autoIncome??{};
  clean.profile.autoIncome={enabled:autoIncome.enabled===true,cashAssetId:text(autoIncome.cashAssetId??'','工资入账账户',100),startsOn:autoIncome.startsOn?dateField(autoIncome.startsOn,'自动入账起始日期'):'',lastPeriod:text(autoIncome.lastPeriod??'','最近工资入账月份',7)};
  if(clean.profile.autoIncome.lastPeriod&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(clean.profile.autoIncome.lastPeriod))throw new Error('最近工资入账月份无效');
  if(clean.profile.autoIncome.enabled&&(!clean.profile.autoIncome.cashAssetId||!clean.profile.autoIncome.startsOn||!Number.isInteger(clean.profile.payday)))throw new Error('自动入账需要现金账户、起始日期与整数发薪日');
  const b = p.background ?? {};
  const choice = (value, allowed) => allowed.includes(value) ? value : '';
  clean.profile.background = {
    displayName: text(b.displayName ?? DEFAULT_DISPLAY_NAME, '希望 AI 如何称呼你', 80),
    scope: choice(b.scope, ['personal','household']),
    ageBand: choice(b.ageBand, ['under30','30to44','45to59','60plus']),
    dependents: number(b.dependents, '需供养人数', { optional: true, max: 50 }),
    incomeFloor: number(b.incomeFloor, '低收入月份的税后收入', { optional: true }),
    retirementYears: number(b.retirementYears, '距离退休年数', { optional: true, max: 80 }),
    comfortableLoss: number(b.comfortableLoss, '主观可接受亏损金额', { optional: true }),
    protection: choice(b.protection, ['unknown','none','social','commercial','both']),
    priorities: text(b.priorities ?? '', '目标与时间安排', 1000),
    constraints: text(b.constraints ?? '', '家庭责任与特殊约束', 1000)
  };
  const policy = input.policy ?? {};
  for (const k of ['stockCaution', 'stockLimit', 'debtRatioLimit', 'issuerLimit']) clean.policy[k] = number(policy[k], '比例规则', { optional: k !== 'stockCaution', max: 100 });
  clean.policy.buyTranchePercent = number(policy.buyTranchePercent, '每笔买入占配置池比例', { optional: true, min: 0.000001, max: 100 });
  clean.policy.staleDays = number(policy.staleDays ?? 7, '数据有效天数', { min: 1, max: 365 });
  const grid=policy.grid??{};
  clean.policy.grid={enabled:grid.enabled!==false,stepPercent:number(grid.stepPercent??DEFAULT_GRID.stepPercent,'网格间距',{min:1,max:30}),tranches:number(grid.tranches??DEFAULT_GRID.tranches,'等额分批数',{min:2,max:12}),perStockBudgetCNY:number(grid.perStockBudgetCNY,'单股本轮预算上限',{optional:true})};
  if(!Number.isInteger(clean.policy.grid.tranches))throw new Error('等额分批数需要为整数');
  if (clean.policy.stockLimit !== null && clean.policy.stockLimit < clean.policy.stockCaution) throw new Error('股票警戒上限不能低于谨慎线');
  const pref = input.preferences ?? {};
  try { new Intl.DateTimeFormat('en', { timeZone: pref.timeZone ?? 'Asia/Shanghai' }).format(); } catch { throw new Error('时区无效'); }
  clean.preferences.timeZone = pref.timeZone ?? 'Asia/Shanghai';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pref.reportTime ?? '20:00')) throw new Error('日报时间无效');
  clean.preferences.reportTime = pref.reportTime ?? '20:00';
  clean.preferences.autoFx = pref.autoFx !== false;
  for (const [currency, rate] of Object.entries(pref.rates ?? {})) {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('币种代码需要为三个大写字母');
    clean.preferences.rates[currency] = number(rate, '人民币汇率', { min: 0.000001, max: 1e6 });
  }
  clean.preferences.rates.CNY = 1;
  for (const key of ['assets', 'debts', 'upcoming', 'decisions']) if (!Array.isArray(input[key]) || input[key].length > 5000) throw new Error(`${key}数据格式错误或记录过多`);
  const usedIds = new Set();
  const id = (v) => { const out = text(v || randomUUID(), '记录编号', 100); if (usedIds.has(out)) throw new Error('存在重复的记录编号'); usedIds.add(out); return out; };
  clean.assets = input.assets.map(a => {
    if (!ASSET_TYPES.includes(a.type)) throw new Error('不支持的资产类型');
    const instrument = a.type === 'stock' && a.security ? security(a.security) : null;
    const autoPrice = a.type === 'stock' && a.autoPrice === true;
    if (autoPrice && (!instrument || a.quantity == null || a.quantity === '' || a.unit !== '股')) throw new Error('股票自动估值需要市场、代码和股数');
    if (instrument && a.currency !== instrument.currency) throw new Error('股票币种与交易市场不一致');
    const value = number(a.value, '资产估值', { optional: a.type === 'insurance' || autoPrice || (a.type === 'fund' && a.fund?.autoNav === true), min: a.type === 'gold_margin' ? -1e14 : 0 });
    let insurance;
    if (a.type === 'insurance') {
      const i = a.insurance ?? {};
      const kind = i.kind ?? 'savings', basis = i.valuationBasis ?? 'cash_value', frequency = i.premiumFrequency ?? 'yearly';
      if (!['savings','annuity','investment','protection'].includes(kind)) throw new Error('保险类型无效');
      if (!['cash_value','account_value','surrender_value'].includes(basis)) throw new Error('保险估值依据无效');
      if (!['monthly','quarterly','yearly','single','paid_up','unknown'].includes(frequency)) throw new Error('保费缴纳周期无效');
      insurance = { kind, valuationBasis: basis,
        sumAssured: number(i.sumAssured, '保障保额', { optional: true }), paidPremiums: number(i.paidPremiums, '累计已缴保费', { optional: true }),
        accessibleValue: number(i.accessibleValue, '可领取金额', { optional: true }),
        premiumAmount: number(i.premiumAmount, '每期保费', { optional: true }), premiumFrequency: frequency,
        premiumInExpenses: i.premiumInExpenses !== false, nextPremiumDate: i.nextPremiumDate ? dateField(i.nextPremiumDate, '下次保费日期') : '' };
    }
    const emergency = number(a.emergency ?? 0, '应急预留');
    const earmarked = number(a.earmarked ?? 0, '专项预留');
    if (a.type !== 'cash' && (emergency || earmarked)) throw new Error('预留资金应登记在现金账户中');
    if (emergency + earmarked > value && a.type === 'cash') throw new Error('应急与专项预留不能超过现金余额');
    if (!/^[A-Z]{3}$/.test(a.currency ?? 'CNY')) throw new Error('币种代码无效');
    let fund, reported, costBasis;
    if (a.type === 'fund' && a.fund) {
      if (!/^\d{6}$/.test(a.fund.code)) throw new Error('基金代码需要为六位数字');
      if (a.fund.autoNav && (a.quantity == null || a.unit !== '份' || a.currency !== 'CNY')) throw new Error('基金自动估值需要人民币基金代码和以份为单位的数量');
      fund = { code: a.fund.code, autoNav: a.fund.autoNav === true };
      if(a.fund.valuationOverride){const v=a.fund.valuationOverride;fund.valuationOverride={value:number(v.value,'确认的持仓金额'),quantity:number(v.quantity,'确认金额对应份数',{min:0.00000001}),date:dateField(v.date,'持仓金额确认日期'),navDate:dateField(v.navDate,'确认时的净值日期')};if(fund.valuationOverride.navDate>fund.valuationOverride.date)throw new Error('确认时的净值日期不能晚于确认日期');if(v.dailyProfit!=null){const dailyProfitDate=dateField(v.dailyProfitDate,'确认的日收益日期');if(dailyProfitDate>fund.valuationOverride.date)throw new Error('日收益日期不能晚于确认日期');fund.valuationOverride.dailyProfit=number(v.dailyProfit,'确认的日收益',{min:-1e14});fund.valuationOverride.dailyProfitDate=dailyProfitDate;}}
    }
    if (a.reported) {
      const r = a.reported;
      reported = { date: dateField(r.date, '原始记录日期'), value: number(r.value, '原始估值', { optional: true }), unrealized: number(r.unrealized, '累计未实现盈亏', { optional: true, min: -1e14 }), dividends: number(r.dividends, '已报告累计分红', { optional: true }), totalReturn: number(r.totalReturn, '已报告累计收益', { optional: true, min: -1e14 }) };
    }
    if (['stock','fund'].includes(a.type) && 'costBasis' in a) {
      if (a.costBasis == null) costBasis = null;
      else {
        const c=a.costBasis;
        if ((c.currency??a.currency??'CNY')!==(a.currency??'CNY')) throw new Error('成本币种与资产币种不一致');
        costBasis={amount:number(c.amount,'持仓总成本'),quantity:number(c.quantity,'成本对应数量',{optional:true}),currency:a.currency??'CNY',method:['reported','inferred_pnl','inferred_return'].includes(c.method)?c.method:'entered'};
      }
    }
    return { id: id(a.id), name: text(a.name, '资产名称'), account: text(a.account ?? '', '账户'), type: a.type, currency: a.currency ?? 'CNY', value,
      asOf: dateField(a.asOf || nowDate(clean.preferences.timeZone), '估值日期'), inPool: a.inPool == null ? !['insurance','other'].includes(a.type) : a.inPool === true, restricted: a.restricted === true, emergency, earmarked,
      equityRatio: number(a.equityRatio, '基金股票占比', { optional: true, max: 100 }),
      quantity: number(a.quantity, '数量', { optional: true }), unit: text(a.unit ?? '', '单位', 20), issuer: text(a.issuer ?? '', '发行人'),
      notional: number(a.notional, '名义敞口', { optional: true }), available: number(a.available, '可提取资金', { optional: true }),
      direction: a.direction === 'short' ? 'short' : 'long', note: text(a.note ?? '', '资产备注', 1000), ...(insurance ? { insurance } : {}), ...(fund ? { fund } : {}), ...(reported ? { reported } : {}), ...(instrument ? { security: instrument, autoPrice } : {}), ...(costBasis!==undefined?{costBasis}:{}) };
  });
  clean.debts = input.debts.map(d => {
    if (!/^[A-Z]{3}$/.test(d.currency ?? 'CNY')) throw new Error('债务币种无效');
    return { id: id(d.id), name: text(d.name, '负债名称'), type: text(d.type ?? 'other', '负债类型', 40), currency: d.currency ?? 'CNY',
      balance: number(d.balance, '剩余本金'), payment: number(d.payment, '每月还款', { optional: true }),
      rate: number(d.rate, '年化利率', { optional: true, max: 100 }), investment: d.investment === true, overdue: d.overdue === true,
      maturity: d.maturity ? dateField(d.maturity, '到期日') : '', note: text(d.note ?? '', '负债备注', 1000) };
  });
  clean.upcoming = input.upcoming.map(u => ({ id: id(u.id), name: text(u.name, '计划名称'), amount: number(u.amount, '计划金额'), date: dateField(u.date, '计划日期') }));
  clean.decisions = input.decisions.slice(-300).map(d => ({ id: id(d.id), createdAt: text(d.createdAt, '记录时间', 40), reason: text(d.reason ?? '', '决定理由', 2000), reviewDate: d.reviewDate ? dateField(d.reviewDate, '复核日期') : '', scenario: d.scenario, result: d.result, snapshotRevision: number(d.snapshotRevision ?? 0, '快照版本') }));
  if (clean.assets.some(a => !a.name) || clean.debts.some(d => !d.name) || clean.upcoming.some(u => !u.name)) throw new Error('名称不能为空');
  return clean;
}

export function calculate(state, currentDate = nowDate(state.preferences.timeZone)) {
  const rates = state.preferences.rates;
  const result = { totalAssets: 0, totalDebt: 0, netWorth: 0, pool: 0, equity: 0, equityMax: 0, stockRatio: null, stockRatioMax: null, fundValue:0, fundRatio:null,
    cash: 0, availableCash: 0, availableEarmarked: 0, emergency: 0, earmarked: 0, liquidReserve: 0, payment: 0, paymentComplete: true,
    income: state.profile.income, expenses: state.profile.expenses, surplus: null, debtRatio: null, reserveMonths: null, emergencyTarget: null,
    baseExpenses: state.profile.expenses, insuranceExpense: 0, insuranceExpenseComplete: true, insurancePremiumDue: 0, insurancePremiumCount: 0,
    categories: {}, missing: [], stale: [], outsidePool: [], issuers: {}, upcomingTotal: 0, upcomingGap: 0, hasLeverage: false, complete: true, poolComplete: true };
  const convert = (value, currency, label) => {
    if (!rates[currency]) { result.missing.push(`${label}缺少 ${currency}/CNY 汇率`); result.complete = false; return null; }
    return value * rates[currency];
  };
  for (const a of state.assets) {
    const included = a.inPool && a.type !== 'other';
    if (a.autoPrice && a.valuation?.status !== 'quote') { result.complete = false; if (included) result.poolComplete = false; result.missing.push(`${a.name}的股票行情待同步，已有金额仅为此前估值`); }
    if (a.fund?.autoNav && !['nav','manual'].includes(a.valuation?.status)) {
      result.missing.push(`${a.name}的单位净值待同步，已有金额仅为此前估值`);
      result.complete = false;
      if (included) result.poolComplete = false;
    }
    if (a.type === 'insurance') {
      const i = a.insurance ?? {};
      if (i.premiumFrequency === 'unknown') { result.insuranceExpenseComplete = false; result.missing.push(`${a.name}的保费缴纳周期待确认`); }
      const factor = { monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, single: 0, paid_up: 0 }[i.premiumFrequency ?? 'yearly'];
      if (factor && i.premiumInExpenses === false) {
        if (i.premiumAmount == null || !rates[a.currency]) {
          result.insuranceExpenseComplete = false;
          result.missing.push(`${a.name}的未计入生活支出的保费金额或汇率待补充`);
        } else result.insuranceExpense += i.premiumAmount * factor * rates[a.currency];
      }
      if (i.nextPremiumDate && Date.parse(i.nextPremiumDate) <= Date.parse(currentDate) + 30 * 86400000 && !['single','paid_up'].includes(i.premiumFrequency)) {
        result.insurancePremiumCount++;
        if (i.premiumAmount != null && rates[a.currency]) result.insurancePremiumDue += i.premiumAmount * rates[a.currency];
      }
    }
    if (a.value == null) {
      result.complete = false;
      if (included) result.poolComplete = false;
      result.missing.push(`${a.name}的当前价值待补充，保额与已缴保费不替代估值`);
      continue;
    }
    const v = convert(a.value, a.currency, a.name);
    if (v === null) { if (included) result.poolComplete = false; continue; }
    const e = (a.emergency || 0) * rates[a.currency], earmarked = (a.earmarked || 0) * rates[a.currency];
    if (v >= 0) result.totalAssets += v; else result.totalDebt += -v;
    result.categories[a.type] = (result.categories[a.type] || 0) + Math.max(0, v);
    if (included) result.pool += v - (a.type === 'cash' ? e + earmarked : 0);
    if(a.type==='fund'){if(included)result.fundValue+=v;else result.outsidePool.push(a.name);}
    if (a.type==='stock' || (a.type === 'insurance' && a.insurance?.kind === 'investment')) {
      if (!included) result.outsidePool.push(a.name);
      const proportion = a.type === 'stock' ? 1 : a.equityRatio == null ? 0 : a.equityRatio / 100;
      if (included) {
        result.equity += v * proportion;
        result.equityMax += v * (a.type !== 'stock' && a.equityRatio == null ? 1 : proportion);
        if (a.type !== 'stock' && a.equityRatio == null) result.missing.push(`${a.name}的股票占比未确认`);
        if (a.type === 'stock') { const issuer = a.issuer || a.name; result.issuers[issuer] = (result.issuers[issuer] || 0) + v; }
      }
    }
    if (a.type === 'cash') {
      result.cash += v; result.emergency += e; result.earmarked += earmarked;
      if (!a.restricted) { result.availableCash += Math.max(0, v - e - earmarked); result.availableEarmarked += earmarked; result.liquidReserve += Math.max(0, v - earmarked); }
    }
    if (a.type === 'gold_margin') { result.hasLeverage = true; if (a.notional === null) result.missing.push(`${a.name}的名义敞口未填写`); }
    if ((Date.parse(currentDate) - Date.parse(a.asOf)) / 86400000 > state.policy.staleDays) result.stale.push(a.name);
  }
  for (const d of state.debts) {
    const balance = convert(d.balance, d.currency, d.name);
    if (balance === null) { result.paymentComplete = false; if (d.investment) result.poolComplete = false; continue; }
    result.totalDebt += balance;
    if (d.investment) { result.pool -= balance; result.hasLeverage = true; }
    if (d.payment === null) { result.paymentComplete = false; result.missing.push(`${d.name}的月供未填写`); }
    else result.payment += d.payment * rates[d.currency];
  }
  result.insuranceExpense = Math.round(result.insuranceExpense * 100) / 100;
  if (result.expenses !== null) result.expenses = result.insuranceExpenseComplete ? result.expenses + result.insuranceExpense : null;
  result.netWorth = result.totalAssets - result.totalDebt;
  if (result.poolComplete && result.pool > 0) { result.stockRatio = result.equity / result.pool * 100; result.stockRatioMax = result.equityMax / result.pool * 100; result.fundRatio=result.fundValue/result.pool*100; }
  if (result.paymentComplete && result.income !== null && result.expenses !== null) result.surplus = result.income - result.expenses - result.payment;
  if (result.paymentComplete && result.income > 0) result.debtRatio = result.payment / result.income * 100;
  const necessary = result.expenses === null || !result.paymentComplete ? null : result.expenses + result.payment;
  if (necessary > 0) { result.reserveMonths = result.liquidReserve / necessary; result.emergencyTarget = necessary * state.profile.emergencyMonths; }
  const horizon = Date.parse(currentDate) + 90 * 86400000;
  for (const u of state.upcoming) if (Date.parse(u.date) <= horizon) result.upcomingTotal += u.amount;
  for (const d of state.debts) if (d.maturity && Date.parse(d.maturity) <= horizon) {
    // A maturity date denotes principal due in full, not an amortizing loan end date.
    result.upcomingTotal += d.balance * (rates[d.currency] ?? 0);
  }
  result.upcomingGap = Math.max(0, result.upcomingTotal - result.availableCash - result.availableEarmarked);
  return result;
}

export function evaluate(state, m = calculate(state)) {
  const rules = [];
  const add = (id, level, title, detail) => rules.push({ id, level, title, detail });
  if (!state.assets.length) add('empty', 'info', '先建立你的财务档案', '添加现金、持仓和负债后，才能检查你的资产配置。');
  if (m.stockRatio !== null && m.stockRatio > state.policy.stockCaution) add('stock-caution', 'caution', '股票比例超过谨慎线', `当前为 ${m.stockRatio.toFixed(1)}%，高于你设置的 ${state.policy.stockCaution}%。继续投入前，先检查资金用途与承受损失的能力。`);
  if (state.policy.stockLimit !== null && m.stockRatio > state.policy.stockLimit) add('stock-limit', 'high', '股票比例超过警戒上限', `当前为 ${m.stockRatio.toFixed(1)}%，超过设定上限 ${state.policy.stockLimit}%。`);
  if (m.stockRatioMax !== null && m.stockRatioMax > state.policy.stockCaution && m.stockRatio <= state.policy.stockCaution) add('stock-unknown', 'caution', '股票比例可能越线', `投连险敞口未完整确认，股票比例可能在 ${m.stockRatio.toFixed(1)}% 至 ${m.stockRatioMax.toFixed(1)}% 之间。`);
  if (m.surplus !== null && m.surplus < 0) add('cashflow', 'high', '经常性现金流存在缺口', `每月收入不足以覆盖必要开支和还款，缺口为 ${Math.round(-m.surplus).toLocaleString('zh-CN')} 元。`);
  if (m.emergencyTarget !== null && m.liquidReserve < m.emergencyTarget) add('emergency', 'caution', '流动储备低于目标', `可动用储备可覆盖 ${m.reserveMonths.toFixed(1)} 个月必要开支，你的目标为 ${state.profile.emergencyMonths} 个月。`);
  if (state.policy.debtRatioLimit !== null && m.debtRatio !== null && m.debtRatio > state.policy.debtRatioLimit) add('payment', 'caution', '月供压力超过设定值', `月供占税后经常性收入 ${m.debtRatio.toFixed(1)}%，高于你设定的 ${state.policy.debtRatioLimit}%。`);
  if (state.policy.issuerLimit !== null && m.pool > 0) for (const [issuer, value] of Object.entries(m.issuers)) if (value / m.pool * 100 > state.policy.issuerLimit) add(`issuer-${issuer}`, 'caution', `${issuer}的直接持仓较集中`, `占配置资产池 ${(value / m.pool * 100).toFixed(1)}%。基金内部持仓尚未穿透。`);
  if (m.upcomingGap > 0) add('upcoming', 'high', '未来 90 天存在已知资金缺口', `已登记支出及集中还本比现有可用现金与专项预留多 ${Math.round(m.upcomingGap).toLocaleString('zh-CN')} 元，尚未计入未来收入。`);
  if (m.hasLeverage) add('leverage', 'caution', '存在杠杆或保证金账户', '账户权益与名义敞口分开记录。股票比例不能代表全部风险，不提供强平预测。');
  if (m.insurancePremiumCount) add('insurance-premium', 'info', '核对近期保费安排', `${m.insurancePremiumCount} 份保单的缴费日期已到或在未来 30 天内；已知每期保费合计 ${Math.round(m.insurancePremiumDue).toLocaleString('zh-CN')} 元，请核实实际缴费状态。`);
  if (state.debts.some(d => d.overdue)) add('overdue', 'high', '存在已登记逾期债务', '请先核对还款安排，再考虑新增负债。');
  if (state.assets.length && m.pool <= 0) add('pool', 'caution', '配置资产池净值不为正', '无法按常规股票比例衡量，请检查预留资金与投资融资负债。');
  if (m.outsidePool.length) add('outside', 'caution', '部分风险持仓未纳入配置池', `${m.outsidePool.join('、')}不在比例分母范围内，不能据此判断整体稳健。`);
  if (m.stale.length) add('stale', 'info', '部分估值需要更新', `${m.stale.join('、')}已超过 ${state.policy.staleDays} 天未更新。`);
  const missing = [...m.missing];
  if (state.profile.income === null) missing.push('税后月收入未填写');
  if (state.profile.expenses === null) missing.push('每月必要支出未填写');
  if (missing.length) add('missing', 'info', '还有资料待补充', missing.join('；'));
  return rules.sort((a, b) => ['high', 'caution', 'info'].indexOf(a.level) - ['high', 'caution', 'info'].indexOf(b.level));
}

// A cash payment can be assessed without deciding whether it is a gift, loan or purchase.
// This does not value anything received or assume future income, repayments or expenses.
export function cashPaymentImpact(state, input) {
  const amount = number(input.amount, '本次支付金额');
  if (!amount) throw new Error('本次支付金额需要大于零');
  const fee = number(input.fee ?? 0, '本次支付费用'), payment = amount + fee;
  const cash = state.assets.filter(a => a.type === 'cash' && a.currency === 'CNY');
  const usable = cash.filter(a => !a.restricted);
  const known = cash.every(a => a.value != null), usableKnown = usable.every(a => a.value != null);
  const money = value => Math.round(value * 100) / 100;
  const total = known ? money(cash.reduce((sum,a) => sum + a.value, 0)) : null;
  const available = usableKnown ? money(usable.reduce((sum,a) => sum + Math.max(0,a.value - (a.emergency || 0) - (a.earmarked || 0)), 0)) : null;
  const reserve = usableKnown ? money(usable.reduce((sum,a) => sum + Math.max(0,a.value - (a.earmarked || 0)), 0)) : null;
  const covered = available == null ? null : available >= payment;
  const cashAfter = covered && total != null ? money(total - payment) : null;
  const reserveAfter = covered ? money(reserve - payment) : null;
  return {
    status: covered === null ? 'needs_information' : covered ? 'calculated' : 'insufficient_cash',
    snapshotRevision: state.revision, currency: 'CNY', amount, fee, payment,
    cashBefore: total, cashAfter, availableBefore: available, availableAfter: covered ? money(available - payment) : null,
    paymentPercentOfCash: total > 0 ? payment / total * 100 : null,
    baseExpenses: state.profile.expenses,
    baseExpenseCoverageMonths: reserveAfter != null && state.profile.expenses > 0 ? Math.round(reserveAfter / state.profile.expenses * 10) / 10 : null,
    missing: usableKnown ? [] : ['可动用人民币现金的余额'],
    scope: '仅假设从现有人民币现金支付本次金额，不动用已登记的应急和专项预留，不使用外币或受限资金；不推断这笔钱是赠与、借款还是消费。',
    limitations: [input.fee == null ? '未提供额外费用，仅计算本次金额；不包含未来持续付款或回款。' : '已扣除本次明确提供的费用，不包含未来持续付款或回款。','基础生活费覆盖月数只使用未受限且未专项预留的剩余人民币现金，未扣除保费、月供及其他计划支出，不等于完整应急储备月数。','本工具不判断值得给、应该给或总体负担得起，也不估算净资产变化。']
  };
}

export function simulate(state, input) {
  const before = calculate(state), copy = structuredClone(state), warnings = [];
  const kind = input.kind;
  if (!['buy', 'purchase', 'loan', 'repay', 'income-stress', 'stock-stress'].includes(kind)) throw new Error('不支持的试算类型');
  const amount = number(input.amount ?? 0, '试算金额');
  const fee = number(input.fee ?? 0, '费用');
  const source = input.source ?? 'cash';
  if (!['cash', 'external', 'borrow'].includes(source)) throw new Error('资金来源无效');
  const spend = (value) => {
    let remaining = value;
    for (const a of copy.assets.filter(a => a.type === 'cash' && !a.restricted && (kind !== 'buy' || a.inPool) && a.currency === 'CNY')) {
      const use = Math.min(remaining, Math.max(0, a.value - a.emergency - a.earmarked)); a.value -= use; a.asOf = nowDate(state.preferences.timeZone); remaining -= use;
    }
    if (remaining > 0.005) warnings.push({ id: 'funding', level: 'high', title: '可用人民币现金不足', detail: `本情景可使用的人民币现金还差 ${Math.round(remaining).toLocaleString('zh-CN')} 元，尚不能完整执行，未动用应急或专项资金。股票买入仅使用配置池内现金。` });
    return remaining < 0.005;
  };
  const payment = number(input.payment, '新增月供', { optional: true });
  if (kind === 'buy') {
    if (!amount) throw new Error('买入金额需要大于零');
    const target = text(input.target || '拟买入股票', '标的');
    if (source === 'cash') { if (!spend(amount + fee)) return { kind, scenario: input, before, after: null, rules: warnings, valid: false }; }
    if (source === 'borrow') copy.debts.push({ id: randomUUID(), name: '试算投资借款', balance: amount + fee, currency: 'CNY', payment, investment: true });
    copy.assets.push({ id: randomUUID(), name: target, issuer: target, type: 'stock', currency: 'CNY', value: amount, asOf: nowDate(), inPool: true, emergency: 0, earmarked: 0 });
  }
  if (kind === 'purchase' || kind === 'loan') {
    if (!amount) throw new Error('消费金额需要大于零');
    const down = kind === 'loan' ? number(input.downPayment ?? 0, '首付') : amount;
    if (down > amount) throw new Error('首付不能大于总价');
    if (!spend(down + fee)) return { kind, scenario: input, before, after: null, rules: warnings, valid: false };
    const value = number(input.assetValue, '购入资产估值', { optional: true });
    if (value !== null) copy.assets.push({ id: randomUUID(), name: text(input.target || '购入物品', '名称'), type: 'other', value, currency: 'CNY', inPool: false, asOf: nowDate() });
    else warnings.push({ id: 'valuation', level: 'info', title: '消费品估值尚未提供', detail: '可以评估现金流，但净资产变化未包含购入物品的价值。' });
    if (kind === 'loan' && amount > down) copy.debts.push({ id: randomUUID(), name: '试算消费贷款', balance: amount - down, currency: 'CNY', payment, investment: false });
    const extra = number(input.extraExpense ?? 0, '新增月开支');
    if (copy.profile.expenses !== null) copy.profile.expenses += extra;
  }
  if (kind === 'repay') {
    const debt = copy.debts.find(d => d.id === input.debtId);
    if (!debt || debt.currency !== 'CNY') throw new Error('请选择人民币负债');
    if (amount > debt.balance) throw new Error('提前还款不能超过剩余本金');
    if (!spend(amount + fee)) return { kind, scenario: input, before, after: null, rules: warnings, valid: false };
    debt.balance -= amount;
    debt.payment = debt.balance === 0 ? 0 : number(input.newPayment, '还款后月供', { optional: true });
    if (debt.payment === null) warnings.push({ id: 'repayment', level: 'info', title: '还款后月供待核实', detail: '请根据贷款合同确认月供和费用；当前不估算节省利息。' });
  }
  if (kind === 'income-stress') copy.profile.income = 0;
  if (kind === 'stock-stress') {
    const decline = number(input.decline ?? 20, '假设跌幅', { max: 100 });
    for (const a of copy.assets) if (a.type === 'stock') a.value *= 1 - decline / 100;
    warnings.push({ id: 'stress', level: 'info', title: '这是一项假设情景', detail: '仅对直接股票施加跌幅，未模拟基金及保证金产品，不是行情预测。' });
  }
  const after = calculate(copy);
  return { kind, scenario: input, before, after, rules: [...warnings, ...evaluate(copy, after)], valid: true, netWorthIncomplete: ['loan', 'purchase'].includes(kind) && input.assetValue == null };
}

export function demoState() {
  const s = initialState(), date = nowDate();
  s.isDemo = true; s.profile = { ...s.profile, income: 30000, expenses: 10000, background: { displayName: '' } };
  const asset = (id, name, type, value, rest = {}) => ({ id, name, type, value, currency: 'CNY', asOf: date, inPool: true, restricted: false, emergency: 0, earmarked: 0, equityRatio: null, account: '演示账户', ...rest });
  s.assets = [asset('demo-cash', '银行存款', 'cash', 500000, { emergency: 120000, earmarked: 40000 }), asset('demo-pa', '中国平安', 'stock', 250000, { issuer: '中国平安' }), asset('demo-stock', '其他股票组合', 'stock', 180000), asset('demo-fund', '宽基指数基金', 'fund', 150000, { equityRatio: 100 }), asset('demo-gold', '积存金', 'gold_accum', 80000, { quantity: 100, unit: '克' }), asset('demo-physical', '实物黄金', 'gold_physical', 120000, { quantity: 150, unit: '克' })];
  s.debts = [{ id: 'demo-debt', name: '住房贷款', type: 'mortgage', balance: 1000000, payment: 12000, rate: null, currency: 'CNY', investment: false, overdue: false, maturity: '', note: '虚构演示数据；房屋估值未登记，总资产不代表完整家底。' }];
  return validateState(s);
}

export const CSV_HEADER = ['id','name','type','account','currency','value','asOf','inPool','emergency','earmarked','equityRatio','quantity','unit','issuer','notional','available','direction','restricted','insuranceKind','valuationBasis','sumAssured','paidPremiums','accessibleValue','premiumAmount','premiumFrequency','premiumInExpenses','nextPremiumDate'];
export function parseCSV(content, kind = 'assets') {
  if (typeof content !== 'string' || content.length > 1e6) throw new Error('CSV 文件过大或无效');
  const rows = []; let row = [], field = '', quoted = false;
  const str = content.replace(/^\uFEFF/, '');
  for (let i = 0; i < str.length; i++) { const c = str[i];
    if (c === '"') { if (quoted && str[i + 1] === '"') { field += '"'; i++; } else if (!quoted && field) throw new Error('CSV 引号位置无效'); else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && str[i + 1] === '\n') i++; row.push(field); if (row.some(x => x.trim())) rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('CSV 存在未闭合引号');
  row.push(field); if (row.some(x => x.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一条记录');
  const header = rows.shift().map(x => x.trim());
  const required = kind === 'debts' ? ['name','currency','balance'] : ['name','type','currency','value'];
  if (new Set(header).size !== header.length || !required.every(x => header.includes(x))) throw new Error(`CSV 表头需包含 ${required.join(',')}`);
  const seen = new Set();
  return rows.map((cells, index) => { if (cells.length !== header.length) throw new Error(`第 ${index + 2} 行列数不匹配`); const out = Object.fromEntries(header.map((key,i) => [key,cells[i].trim()]));
    for (const k of ['value','emergency','earmarked','equityRatio','quantity','notional','available','balance','payment','rate']) out[k] = out[k] === '' || out[k] === undefined ? (['emergency','earmarked'].includes(k) ? 0 : null) : Number(out[k]);
    for (const k of ['inPool','restricted','investment','overdue','premiumInExpenses']) { if (out[k] && !['true','false'].includes(out[k])) throw new Error(`第 ${index + 2} 行 ${k} 需为 true 或 false`); out[k] = out[k] ? out[k] === 'true' : k === 'premiumInExpenses' || (k === 'inPool' && !['insurance','other'].includes(out.type)); }
    if (out.type === 'insurance') {
      out.insurance = { kind: out.insuranceKind || 'savings', valuationBasis: out.valuationBasis || 'cash_value', premiumFrequency: out.premiumFrequency || 'yearly', premiumInExpenses: out.premiumInExpenses, nextPremiumDate: out.nextPremiumDate || '' };
      for (const k of ['sumAssured','paidPremiums','accessibleValue','premiumAmount']) out.insurance[k] = out[k] === '' || out[k] === undefined ? null : Number(out[k]);
    }
    out.id ||= `csv-${Buffer.from(`${out.account}\0${out.currency}\0${out.type}\0${out.name}`).toString('base64url')}`;
    if (seen.has(out.id)) throw new Error(`第 ${index + 2} 行记录编号重复，请合并或使用不同 id`);
    seen.add(out.id);
    return out;
  });
}
