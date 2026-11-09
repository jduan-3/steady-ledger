# Steady Ledger

A self-hosted personal ledger, portfolio tracker, and conversational finance assistant. Built with Node.js, SQLite, and a browser UI, with no frontend build step.

The interface is Chinese-first and works on desktop and mobile. Each installation keeps its own ledger and configuration.

## Features

- Track assets, debts, cost basis, portfolio allocation, and unrealized gains or losses.
- Plan income, expenses, insurance premiums, and cash reserves, with optional monthly salary entries.
- View fund NAVs and mainland Chinese, Hong Kong, and US stock quotes, intraday charts, daily history, and volume.
- Track pending purchases with target amounts, dates and conditions, and keep completed or cancelled plans for review.
- Search funds by name or code, keep a watchlist with published NAVs and reference charts, and add watched funds to purchase plans.
- Follow mainland Chinese, US and Hong Kong market dashboards, macro indicators, and daily summaries.
- Monitor six mainland broad-market ETFs with intraday order-flow estimates and exchange-published daily share changes, with source dates and failure caching.
- Chat with a configurable AI provider using Pi Durable, with optional access to saved page data and local bookkeeping tools.
- Import CSV files, export financial records, and restore earlier ledger versions.

## Quick start

Requires **Node.js 22.19 or later**.

```sh
npm ci --ignore-scripts
npm start
```

Open [http://127.0.0.1:3210](http://127.0.0.1:3210) and create an access password of at least eight characters. You can start with synthetic demo data or an empty ledger. Basic bookkeeping and rule-based reports work without a model API key.

| Command | Purpose | Default address | Data directory |
| --- | --- | --- | --- |
| `npm start` | Password-protected server | `127.0.0.1:3210` | `data/` |
| `npm run local` | Personal use on this computer, without login | `127.0.0.1:3211` | `data/` |
| `npm run preview` | Isolated demo and development workspace, without login | `127.0.0.1:3211` | `work/preview-data/` |

Local and preview modes bind only to loopback and share the same port, so run one at a time. Use `npm start` for hosting behind a trusted HTTPS reverse proxy.

### Docker

```sh
docker compose up -d --build
```

The bundled Compose configuration binds to `127.0.0.1:3210` and stores data in the `balance-data` volume.

## AI setup

In **Settings → AI connection**, enter a Chat Completions-compatible base URL, model ID, and API key, then save and test the connection. Local providers that do not require authentication can leave the key blank. Provider compatibility varies.

Choose which financial data and conversation history the model may receive. Full-page access includes saved holdings, account names, notes, costs, and other business data; hiding amounts in the UI does not reduce that permission. API keys stay on the server, encrypted at rest.

Local bookkeeping requires a separate opt-in and explicit instructions. The assistant can ask for missing details and continue from your reply. Fund transactions awaiting the requested day's published NAV remain pending until that value is available. These tools update the local ledger; they do not place brokerage orders.

With local bookkeeping enabled, the assistant can also delete a specified stock or fund holding record, or remove a fund from the watchlist. Holdings and watchlist entries are separate; unclear targets or scopes are clarified in chat. Deletion preserves cash and trade history, blocks holdings with pending entries, and can be restored from recent changes in Settings.

## Market data

Stock quotes use Tencent public market data and optional local Futu OpenD access. Fund valuations use published unit NAVs from Eastmoney. Market dashboards also use Cboe daily VIX closes, Tencent Hang Seng volatility quotes, and public US macro sources. Data may be delayed; the app keeps source timestamps, retains cached values on failure, and leaves unavailable values empty.

**买入待办** supports both manual status tracking and **登记成交**. Registering a confirmed purchase links the plan to a ledger entry and updates holdings and cash together. If the requested price is pending, the plan waits for settlement.

**资产与负债 → 账户对账** compares a statement balance or quantity with the saved account snapshot. A cash adjustment requires a reason and explicit selection. **收入与计划 → 90 天现金流** projects daily balances with an optional purchase-plan scenario. **每日总结 → 月度变化拆解** uses a complete prior month-end snapshot and attributes verified movements, keeping unexplained amounts separate.

In **基金 → 自选 → 添加自选**, search a fund name or six-digit code and select a result, or enter a code directly to look up its name. Search uses [Eastmoney's public fund directory](https://fund.eastmoney.com/) and falls back to saved funds when unavailable; manual code/name entry remains available. Use **更新净值** for the whole watchlist or **更新** on a row. Watchlists and purchase plans do not affect asset totals.

Stock and fund-reference charts show intraday prices, up to 60 unadjusted daily bars, and volume. Prices and turnover amounts retain their source currency. Volume bars use red for rising prices, blue for falling prices, and gray for unchanged prices or a missing comparison price; colors do not identify buying or selling. A reference ETF's market price is separate from the fund's published NAV.

For optional OpenD access, install the Python dependencies in [scripts/market-requirements.txt](scripts/market-requirements.txt) and set `STEADY_MARKET_PYTHON` to that Python interpreter. Automatic updates and scheduled reports require the app to be running.

## Configuration and backups

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Server bind address; the Docker image uses `0.0.0.0`. |
| `PORT` | `3210` | Server port; local mode defaults to `3211`. |
| `DATA_DIR` | `data/` | Ledger database and encryption key directory; preview uses its own directory. |
| `TRUST_PROXY` | Unset | Set to `1` only behind a trusted HTTPS proxy for secure session cookies. |
| `STEADY_MARKET_PYTHON` | Auto-detected or `python3` | Python interpreter for optional Futu OpenD access. |

Startup reads the process environment; `.env` files are not loaded automatically. Configure model credentials in the app.

For a complete backup or migration, stop the service and copy the entire data directory, including `balance.sqlite`, `secret.key`, and any uploaded avatar. Financial JSON exports omit model credentials, passwords, conversations, and report history, so they are not complete installation backups.

Keep runtime data, credentials, backups, and screenshots private. See [SECURITY.md](SECURITY.md) for details.

## Development

```sh
npm run dev          # Restart the server when source files change
npm run check        # Check JavaScript syntax
npm test             # Run tests with temporary databases and mock model services
npm run check:public # Check files before committing or publishing
```

Source code lives in `src/`, browser assets in `public/`, and tests in `tests/`. Synthetic import templates and a sample backup are available in [examples/](examples/).

## Documentation

- [Market data sources and freshness](docs/market-data-sources.md)
- [Mainland market and ETF flow data](docs/cn-market-data.md)
- [Stock market data](docs/stock-market-data.md)
- [Fund reference mappings and data](docs/fund-reference-data.md)
- [Market summary format](docs/market-summary-format.md)
- [Security and private data](SECURITY.md)

Detailed market documentation is currently in Chinese.

## License

[MIT](LICENSE)
