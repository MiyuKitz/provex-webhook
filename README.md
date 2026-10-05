# Two-Speed bot (v20.9)

Crypto trading bot running on Railway, executing on the BingX demo (VST) account.
Two speeds: 🛡️ **Core** grows steadily and survives crashes, 🎰 **Aggro** swings big on key-level setups.
(Repo and service are still called `provex-webhook`, the original ProveX prop-firm project, kept so the deploy and webhook URL don't break.)

## Modules

| Module | What it does | Mode |
|---|---|---|
| 🛡️ Core | Long only. Holds each coin while its 28-day return is positive, sized by volatility targeting (40%/yr). Checked daily, rebalances when >10% off target. 15% disaster stop on every position. Principal at 1x, profits above the starting balance at up to 3x (profit sleeve). Coins set by `CORE_COINS`. | Live on demo |
| 🎰 Aggro | Trades the TradingView v14 key-level signals (order-block rejection/retest) with a stop just beyond the order block and up to 40x leverage (auto-lowered so liquidation always sits beyond the stop). Separate 20k VST budget, 50% of its balance at risk per trade, compounding. Stops itself below 10% of its budget. **Demo experiment.** | Live on demo |
| 🔥 Funding watch | When a coin's 72h average funding reaches 0.05%/8h (longs extremely crowded), logs a 3-day paper short. | Paper |
| v19 (15m OB) | The original strategy. Same TradingView signals, logged and paper-resolved. | Paper |

## Coins

- **Core**: Railway variable `CORE_COINS` (now `BTC,ETH,SOL,SUI,DOGE,1000PEPE,FLOKI,INJ,NEAR`). Use BingX names: `1000PEPE`, `1000SHIB`, `1000BONK`. Unknown names are skipped with a Telegram warning.
- **Aggro / v19**: whatever coins have TradingView alerts (15m chart, "Claude Alerts v14 — Krysie 15M", Any alert() function call, webhook URL ending in `/webhook`).

## Safety nets

- **Stop watchdog**: every 15 min, every BingX position must have a stop-loss, otherwise 🚨 Telegram alert. Core re-places its own missing stops automatically.
- **Disaster stops**: −15% on every Core position, placed with the actual filled quantity.
- **Aggro bust rule**: Aggro stops trading below 10% of its starting budget.
- **Kill switch**: no new v19 trades if equity falls 15% below its peak (Aggro uses its own bust rule instead).
- **Fail-closed**: if positions or equity can't be read, nothing is traded.
- Core tracks its own positions and stop orders, so it never mixes with Aggro trades on the same coin.

## Railway variables (switches)

| Variable | Default | Effect |
|---|---|---|
| `CORE_EXECUTE` | `on` | `off` stops Core from placing orders |
| `CORE_COINS` | `BTC,ETH` | Coins Core trades (comma separated) |
| `CORE_ALLOC` | `0.5` | Share of account equity given to Core (use `1` when Core is the only live module) |
| `CORE_LEVERAGE` | `1` | Leverage on Core's principal (max 2) |
| `CORE_PROFIT_LEV` | `3` | Leverage on profits above the starting balance (max 3) |
| `CORE_START_EQUITY` | first-seen equity | Override the starting balance for the profit sleeve |
| `AGGRO` | `on` | `off` stops Aggro |
| `AGGRO_BUDGET` | `20000` | Aggro's separate starting budget |
| `AGGRO_RISK` | `0.5` | Share of the Aggro balance risked per trade (max 0.5) |
| `AGGRO_LEVERAGE` | `40` | Max leverage for Aggro (max 50) |
| `AGGRO_STOP` | `structure` | `structure` = stop beyond the order block, `fixed` = 5% stop |
| `V19_EXECUTE` | `off` | `on` lets v19 place demo trades at its original sizing |
| `KILL_SWITCH_DD` / `KILL_SWITCH_RESET` | `0.15` / — | Kill switch threshold / change to any new value to re-arm |
| `CHALLENGE_START` | — | Start date of the weekly report window |

## Pages

- `/core` — Core equity, drawdown, positions, trend and exit levels
- `/aggro` — Aggro balance, wins/losses, return
- `/funding` — funding watch paper trades
- `/challenge` — weekly report
- `/signals`, `/missed-signals` — v19 signal logs

## Research

`research/` holds the backtests behind every decision: the v14 Pine port (87% signal match), the 3-year v19 replay (~breakeven), chart patterns, CRT, trend followers, fast trend, coin rotation, funding extremes, and the 2018-2026 BTC/ETH trend-filter + volatility-targeting tests that Core is built on. `docs/HYPOTHESES.md` is the v19-era evidence log.

Key numbers: Core rules (BTC+ETH, 2018-2026) +30%/yr vs +26% buy & hold, max drawdown −44% vs −84%. Leverage: 2x +37%/yr (−71% DD), 5x worse than 1x, 10x wiped. Aggro odds at 50% risk per trade (30 trades): ~11% chance of hitting 5x, ~70% chance of busting.
