# Two-Speed bot (v23.0)

Crypto trading bot on Railway, executing on the BingX demo (VST) account. Clean build: only the two new strategies + safety.
(Repo/service are still named `provex-webhook` so the deploy doesn't break.)

## Strategies

| | 🛡️ Core (hold) | 🎰 Aggro (hunt) |
|---|---|---|
| Style | Trend-following holds, weeks–months | With-trend break & retest, hours–days |
| Signals | Daily: coin's 28-day return | 1H breakout of a swing level + retest, only in the direction of the 4H trend |
| Stop | 15% disaster stop | Just beyond the retest wick (0.3–5%) |
| Exit | When the 28-day trend flips | 40% at 1R, stop to breakeven, 60% trails under 1H swings |
| Leverage | 1x on principal, up to 3x on profits | Up to 40x, auto-lowered so liquidation sits beyond the stop |
| Coins | `CORE_COINS` | `AGGRO_COINS` (keep the two lists separate) |
| Budget | `CORE_ALLOC` share of equity | Own `AGGRO_BUDGET` (20k VST), 50% of its balance at risk per trade |

**No shorts in a bull market.** Bull market = BTC's 28-day return > 0. While that's true, neither strategy opens a short.
Core shorts only exist if `CORE_SHORTS=on` **and** the market is bearish.

## Safety
- Stop watchdog every 15 min: any position without a stop → 🚨 Telegram. Core re-places its own missing stops.
- Stops use the quantity BingX actually filled.
- Core and Aggro never share a coin+side (leverage on BingX is per coin+side).
- Aggro stops itself below 10% of its budget. Fail-closed if positions/equity can't be read.

## Railway variables
| Variable | Default | Effect |
|---|---|---|
| `CORE_COINS` | `BTC,ETH` | Core's coins (BingX names, e.g. `1000PEPE`) |
| `CORE_ALLOC` | `0.5` | Share of equity for Core |
| `CORE_LEVERAGE` / `CORE_PROFIT_LEV` | `1` / `3` | Leverage on principal (max 2) / on profits (max 3) |
| `CORE_SHORTS` | `off` | `on` = short downtrending coins, only in a bear market |
| `CORE_EXECUTE` | `on` | `off` = paper only |
| `AGGRO` | `on` | `off` stops Aggro |
| `AGGRO_COINS` | `ZRO,XRP,LINK,AVAX,ADA,OP` | Aggro's coins |
| `AGGRO_BUDGET` / `AGGRO_RISK` / `AGGRO_LEVERAGE` | `20000` / `0.5` / `40` | Budget / risk per trade (max 0.5) / max leverage (max 50) |

## Pages
`/` status · `/core` Core equity & positions · `/aggro` Aggro balance, open trades, history

## Removed in v23
The v19 order-block system and TradingView pipeline, Claude explanations, paper resolvers, weekly challenge report, signal backups, funding watch and kill switch. Research behind every decision stays in `research/`; old code is in git history.
