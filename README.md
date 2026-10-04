# ProveX bot (v20)

Crypto trading bot running on Railway, executing on the BingX demo (VST) account.

## Modules

| Module | What it does | Mode |
|---|---|---|
| 🛡️ Core mode | BTC + ETH long only, 1x. Holds each coin only while its 28-day return is positive, sized by volatility targeting (40%/yr). Checked daily, rebalances when >10% off target. 15% disaster stop on every position. | Live on demo |
| 🔥 Funding watch | When a coin's 72h average funding reaches 0.05%/8h (longs extremely crowded), logs a 3-day paper short. | Paper |
| v19 (15m OB) | TradingView v14 alerts (SUI, ETH, ZRO). Signals logged and paper-resolved only. | Paper |

## Safety nets

- **Kill switch**: no new v19 trades if equity falls 15% below its peak.
- **Stop watchdog**: every 15 min, every BingX position must have a stop-loss, otherwise 🚨 Telegram alert.
- **Fail-closed**: if positions or equity can't be read, nothing is traded.

## Railway variables (switches)

| Variable | Default | Effect |
|---|---|---|
| `CORE_EXECUTE` | `on` | `off` stops Core mode from placing orders |
| `CORE_ALLOC` | `0.5` | Share of account equity given to Core mode |
| `V19_EXECUTE` | `off` | `on` lets v19 place demo trades again |
| `KILL_SWITCH_DD` | `0.15` | Kill switch drawdown threshold |
| `KILL_SWITCH_RESET` | — | Change to any new value to re-arm the kill switch |
| `CHALLENGE_START` | — | Start date of the weekly report window |

## Pages

- `/core` — Core mode equity, drawdown, positions
- `/funding` — funding watch paper trades
- `/challenge` — weekly report
- `/signals`, `/missed-signals` — v19 signal logs

## Research

`research/` holds the backtests behind every decision: the v14 Pine port (87% signal match), the 3-year v19 replay (~breakeven), chart-pattern, CRT, trend-follower, rotation, funding and BTC/ETH trend-filter tests (2018-2026). `docs/HYPOTHESES.md` is the v19-era evidence log.
