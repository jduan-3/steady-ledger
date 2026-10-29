#!/usr/bin/env python3
"""Local read-only market data. No positions, account, cash or trading APIs."""
import json
import math
from contextlib import redirect_stdout
import signal
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ZONES = {"SH": "Asia/Shanghai", "SZ": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "US": "America/New_York"}

def market_extras(row, equity=False):
    def value(field):
        v = row.get(field)
        return float(v) if v is not None and math.isfinite(float(v)) else None
    result = {k: value(k) for k in ('volume', 'turnover')}
    if equity and bool(row.get('equity_valid', False)):
        result['equityValid'] = True
        result['fundamentals'] = {k: value(f) for k, f in (('peTTM', 'pe_ttm_ratio'), ('pb', 'pb_ratio'), ('dividendYieldTTM', 'dividend_ratio_ttm'))}
    return result

def run(data):
    from futu import OpenQuoteContext, RET_OK, Market, SecurityType, SysConfig, KLType, AuType
    SysConfig.set_all_thread_daemon(True)
    quote = OpenQuoteContext(host='127.0.0.1', port=11111)
    result = {"catalog": [], "quotes": [], "history": [], "errors": []}
    try:
        if data.get('action') == 'catalog':
            for market in ZONES:
                ret, rows = quote.get_stock_basicinfo(getattr(Market, market), stock_type=SecurityType.STOCK)
                if ret != RET_OK:
                    result['errors'].append(market)
                    continue
                for _, row in rows.iterrows():
                    result['catalog'].append({"key": str(row['code']), "name": str(row['name'])})
        elif data.get('action') == 'details':
            keys = data.get('keys', [])[:1]
            ret, rows = quote.get_market_snapshot(keys)
            if ret != RET_OK or rows.empty:
                raise ValueError('股票基础资料暂不可用')
            row = rows.iloc[0]
            fields = ('pe_ratio', 'pe_ttm_ratio', 'pb_ratio', 'dividend_ttm', 'dividend_ratio_ttm',
                      'dividend_lfy', 'dividend_lfy_ratio', 'total_market_val', 'earning_per_share', 'net_asset_per_share')
            values = {}
            for field in fields:
                value = row.get(field)
                values[field] = float(value) if value is not None and math.isfinite(float(value)) else None
            return {'details': {'key': str(row['code']), 'time': str(row['update_time']),
                                'equityValid': bool(row.get('equity_valid', False)), 'metrics': values}}
        elif data.get('action') in ('overview', 'overview-live'):
            now = datetime.now(timezone.utc)
            ret, state = quote.get_global_state()
            result['global'] = {k: state.get(k) for k in ('market_us', 'market_hk', 'qot_logined')} if ret == RET_OK else {}
            result['calendars'] = {}
            if not result['global'].get('qot_logined'):
                result['errors'].append('OpenD 行情服务器尚未登录')
                return result
            for market in ('US', 'HK'):
                local = now.astimezone(ZoneInfo(ZONES[market]))
                if data.get('action') == 'overview':
                    ret, days = quote.request_trading_days(getattr(Market, market), start=(local.date()-timedelta(days=70)).isoformat(), end=local.date().isoformat())
                    if ret == RET_OK:
                        result['calendars'][market] = days
                # OpenD does not support US index snapshots. US sector ETFs and HK indices do work when entitled.
                keys = [key for key in data.get('keys', []) if key.startswith(market+'.') and not key.startswith('US..')]
                if not keys:
                    continue
                # HK BMP permits at most 20 securities in one snapshot request.
                for offset in range(0, len(keys), 20):
                    ret, rows = quote.get_market_snapshot(keys[offset:offset+20])
                    if ret == RET_OK:
                        for _, row in rows.iterrows():
                            result['quotes'].append({'key': str(row['code']), 'price': float(row['last_price']), 'previous': {'price': float(row['prev_close_price'])}, 'time': str(row['update_time']), **market_extras(row, equity=True)})
                    else:
                        result['errors'].append(market+' 行情暂不可用或权限不足')
            for code in data.get('historyKeys', [])[:8]:
                if code.startswith('US..'):
                    continue
                market = code.split('.', 1)[0]
                local = now.astimezone(ZoneInfo(ZONES[market]))
                ret, rows, _ = quote.request_history_kline(code, start=(local.date()-timedelta(days=65)).isoformat(), end=local.date().isoformat(), ktype=KLType.K_DAY, autype=AuType.NONE, max_count=50)
                if ret == RET_OK:
                    for _, row in rows.iterrows():
                        result['history'].append({'key': code, 'date': str(row['time_key'])[:10], 'price': float(row['close']), 'previous': {'price': float(row['last_close'])}, **market_extras(row)})
            return result
        else:
            now = datetime.now(timezone.utc)
            for code in data.get('keys', [])[:50]:
                market = code.split('.', 1)[0]
                if market not in ZONES:
                    continue
                ret, rows = quote.get_market_snapshot([code])
                if ret == RET_OK and not rows.empty:
                    row = rows.iloc[0]
                    result['quotes'].append({"key": str(row['code']), "price": float(row['last_price']), "previous": {"price": float(row['prev_close_price'])}, "time": str(row['update_time']), "lotSize": int(row['lot_size']) if row.get('lot_size', 0) > 0 else None})
                else:
                    result['errors'].append(code)
                if code in data.get('historyKeys', []):
                    local = now.astimezone(ZoneInfo(ZONES[market]))
                    ret, rows, _ = quote.request_history_kline(code, start=(local.date()-timedelta(days=45)).isoformat(), end=local.date().isoformat(), ktype=KLType.K_DAY, autype=AuType.NONE, max_count=60)
                    if ret == RET_OK:
                        for _, row in rows.iterrows():
                            date = str(row['time_key'])[:10]
                            # A same-day bar can still be in progress. The live snapshot handles it.
                            if date >= local.date().isoformat():
                                continue
                            result['history'].append({"key": str(row['code']), "price": float(row['close']), "previous": {"price": float(row['last_close'])}, "date": date})
        return result
    finally:
        quote.close()

if __name__ == '__main__':
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(50)
    try:
        # SDK log threads must not interleave with the JSON protocol, especially
        # while writing a large securities catalogue.
        with redirect_stdout(sys.stderr):
            result = run(json.load(sys.stdin))
        print('STEADY_JSON:' + json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception:
        print('STEADY_JSON:' + json.dumps({"error": "OpenD 未连接或行情权限不足，请检查本机 OpenD。"}, ensure_ascii=False))
        sys.exit(1)
