const day = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('净值日期无效');
  return value;
};

export function applyFundNAV(input, getKV) {
  const state = structuredClone(input);
  for (const asset of state.assets) {
    if (!asset.fund?.autoNav) continue;
    const q = getKV('fund_nav:' + asset.fund.code), attempt = getKV('fund_attempt:' + asset.fund.code);
    const manual=asset.fund.valuationOverride;
    if(manual&&manual.quantity===asset.quantity&&(!q||q.date<=manual.navDate)){
      asset.value=manual.value;asset.asOf=manual.date;
      asset.valuation={...q,status:'manual',source:'用户确认持仓金额',date:q?.date||manual.navDate,navDate:q?.date||null,navValue:q?Math.round(asset.quantity*q.price*100)/100:null,message:'按确认金额记账；取得更新净值日期后恢复自动估值。'};
      const movement=q?priceMovement(q,asset.quantity):null;asset.movement=movement?{...movement,source:q.source}:null;
      if(Number.isFinite(manual.dailyProfit))asset.movement={kind:'reported_daily',date:manual.dailyProfitDate,amount:manual.dailyProfit,currency:asset.currency,source:'用户截图确认的日收益'};
      continue;
    }
    if (q && (asset.value == null || q.date >= asset.asOf) && asset.quantity != null && asset.unit === '份' && asset.currency === 'CNY') {
      asset.value = Math.round(asset.quantity * q.price * 100) / 100;
      asset.asOf = q.date;
      asset.valuation = { ...q, status: attempt?.error ? 'pending' : 'nav', message: attempt?.error || '' };
      asset.movement = priceMovement(q, asset.quantity);
    } else asset.valuation = { status: 'pending', message: attempt?.error || '等待基金单位净值' };
  }
  return state;
}

export async function refreshFundNAV(store, { now = new Date(), fetchImpl = fetch, retryFailed = false, force = false, codes:requestedCodes } = {}) {
  const codes = [...new Set(requestedCodes||store.state({ raw: true }).assets.filter(a => a.fund?.autoNav).map(a => a.fund.code))];
  let updated = 0; const errors = [];
  for (const code of codes.slice(0, 100)) {
    const previous = store.getKV('fund_nav:' + code), attempt = store.getKV('fund_attempt:' + code);
    if (!force && attempt?.at && now - Date.parse(attempt.at) < (attempt.error ? 5 : 30) * 60000 && !(retryFailed && attempt.error)) continue;
    try {
      const url = new URL('https://api.fund.eastmoney.com/f10/lsjz');
      url.search = new URLSearchParams({ fundCode: code, pageIndex: '1', pageSize: '30' });
      const response = await fetchImpl(url, { headers: { Referer: 'https://fundf10.eastmoney.com/', 'User-Agent': 'Steady/1.0' }, signal: AbortSignal.timeout(12000) });
      const body = await response.json();
      if (!response.ok || body.ErrCode !== 0 || !Array.isArray(body.Data?.LSJZList)) throw new Error();
      const rows = body.Data.LSJZList.map(r => ({ date: day(r.FSRQ), price: Number(r.DWJZ) })).sort((a, b) => b.date.localeCompare(a.date));
      if (!rows.length || rows.some(r => !Number.isFinite(r.price) || r.price <= 0 || r.date > now.toISOString().slice(0, 10)) || (rows[1] && rows[1].date === rows[0].date)) throw new Error();
      const q = { code, ...rows[0], previous: rows[1] ?? null, source: '天天基金公开披露净值', sourceUrl: 'https://fundf10.eastmoney.com/jjjz_' + code + '.html', basis: 'unit_nav', currency: 'CNY', fetchedAt: now.toISOString() };
      if (previous && q.date < previous.date) throw new Error();
      store.setKV('fund_nav:' + code, q);
      for (let i=0;i<rows.length;i++) store.recordPrice('FUND.'+code,{...rows[i],code,currency:'CNY',source:q.source,basis:'unit_nav',previous:rows[i+1]??null});
      store.setKV('fund_attempt:' + code, { at: now.toISOString() });
      updated++;
    } catch {
      store.setKV('fund_attempt:' + code, { at: now.toISOString(), error: '基金净值暂不可用，保留上次估值' });
      errors.push(code);
    }
  }
  return { updated, errors };
}
import { priceMovement } from './valuation.mjs';
