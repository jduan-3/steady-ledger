export const MARKETS = {
  SH: { label: '沪市 A 股', currency: 'CNY', timeZone: 'Asia/Shanghai' },
  SZ: { label: '深市 A 股', currency: 'CNY', timeZone: 'Asia/Shanghai' },
  BJ: { label: '北交所', currency: 'CNY', timeZone: 'Asia/Shanghai' },
  HK: { label: '港股', currency: 'HKD', timeZone: 'Asia/Hong_Kong' },
  US: { label: '美股', currency: 'USD', timeZone: 'America/New_York' },
};
export function security(input) {
  if (!input || !MARKETS[input.market]) throw new Error('请选择股票市场');
  const market = input.market;
  let symbol = String(input.symbol ?? '').trim().toUpperCase();
  if (market === 'HK' && /^\d{1,5}$/.test(symbol)) symbol = symbol.padStart(5, '0');
  if (!(market === 'US' ? /^[A-Z][A-Z0-9.-]{0,14}$/ : market === 'HK' ? /^\d{5}$/ : /^\d{6}$/).test(symbol)) throw new Error('股票代码格式不正确');
  return { market, symbol, currency: market === 'HK' && /^8\d{4}$/.test(symbol) ? 'CNY' : MARKETS[market].currency, key: market + '.' + symbol };
}
export function securityKey(value) {
  const key=String(value),separator=key.indexOf('.');
  const s=security({market:key.slice(0,separator),symbol:key.slice(separator+1)});
  if(s.key!==key)throw new Error('股票身份无效');
  return s;
}
export function isoDay(value) {
  const s = String(value ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new Error('行情交易日期无效');
  return s;
}
export function marketDay(market, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: MARKETS[market].timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function completedDay(market, calendar, now = new Date()) {
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: MARKETS[market].timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(now);
  const today = marketDay(market, now);
  return calendar.filter(d => d.day < today || (d.day === today && local >= d.close)).sort((a, b) => a.day.localeCompare(b.day)).at(-1)?.day ?? null;
}
