# Two-Speed bot (v25.0)

Crypto trading bot on Railway, executing on the BingX demo (VST) account. Clean build: only the two new strategies + safety.
(Repo/service are still named `provex-webhook` so the deploy doesn't break.)

## Strategies

| | 🛡️ Core (hold) | 🎰 Aggro (hunt) |
|---|---|---|
| Style | Trend-following holds, weeks–months | Krysie's 10-strategy confluence setups, hours–days |
| Signals | Daily: coin's 28-day return (+ swing-low key-level exit) | Confluence engine: Krysie's 10 strategies (S/R, demand/supply, structure, break & retest, reversals, trendline, fib, consolidation, price+volume, CRT); trades when 4+ agree on 4H |
| Stop | 15% disaster stop | Just beyond the setup (0.3–10% on 4H) |
| Exit | Swing-low break or 28-day trend flip | 40% at 1R, stop to breakeven, 60% trails under swings |
| Leverage | 1x on principal, up to 3x on profits | Up to 40x, auto-lowered so liquidation sits beyond the stop |
| Coins | `CORE_COINS` | `AGGRO_COINS` (keep the two lists separate) |
| Budget | `CORE_ALLOC` share of equity | Own `AGGRO_BUDGET` (20k VST), 50% of its balance at risk per trade |


## The 10 strategies (Aggro confluence + shadow log)
Key level S/R · Demand/Supply zone · Swing structure (BOS/CHoCH) · Break & retest · Reversal pattern (failed high/low, double top/bottom) ·
Trendline bounce/break · Fib 50–61.8% · Consolidation breakout · Price + volume (Tim Ord, volume climax) · CRT timing (NY 4H purge).
Each setup's **confluence score** = how many agree on the direction. Aggro trades when the score ≥ `AGGRO_MIN_CONF`.
`AGGRO_STRATS` is the strategy menu (comma list: `sr,zone,structure,retest,reversal,trendline,fib,consolidation,volume,crt`).

## 👁️ Shadow log
Every setup on 1H and 4H (score 1+, traded or not) for all Aggro + Core coins is logged and tracked with Aggro's exits.
`/shadow` shows win rate and average R by score, by strategy and by trigger — used at each review to tune the settings.

**No shorts in a bull market.** Bull market = BTC's 28-day return > 0. While that's true, neither strategy opens a short.
Core shorts only exist if `CORE_SHORTS=on` **and** the market is bearish.

## Two accounts (hold + hunt on the same coin)
Set `AGGRO_BINGX_API_KEY` + `AGGRO_BINGX_API_SECRET` (a BingX sub-account) and Aggro trades on its own account.
Positions never merge, so Core can hold a coin at 1x while Aggro hunts the same coin at up to 40x.
Aggro then sizes from that account's real equity, so its profits compound there. When Aggro reaches 2x, 3x… its start,
Telegram suggests ♻️ moving half the profit to the main account for Core to hold. On a shared account (demo) this happens automatically: half the profit is banked out of Aggro and Core sizes from it.
Without these keys, Aggro shares the main account and skips any coin+side Core holds.

## 👻 Shadow log
Every setup the 10 strategies find (score 1+, on 1H and 4H, all Core + Aggro coins) is recorded and tracked on paper with the Aggro exit.
`/shadow` shows results by timeframe, by confluence score and by strategy, so the demo tells us what works in today's market.

## Safety
- Stop watchdog every 15 min: any position without a stop → 🚨 Telegram. Core re-places its own missing stops.
- Stops use the quantity BingX actually filled.
- Stop watchdog checks both accounts. On a shared account, Core and Aggro never share a coin+side (leverage on BingX is per coin+side).
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
| `AGGRO_TF` | `4h` | Aggro's timeframe (`4h` or `1h`) |
| `AGGRO_MIN_CONF` | `4` | Min strategies agreeing to trade |
| `AGGRO_STRATS` | all 10 | Strategy menu |
| `SHADOW_COINS` | Aggro + Core coins | Coins the shadow log watches |
| `AGGRO_BUDGET` / `AGGRO_RISK` / `AGGRO_LEVERAGE` | `20000` / `0.5` / `40` | Budget (shared mode) / risk per trade (max 0.5) / max leverage (max 50) |
| `AGGRO_BINGX_API_KEY` / `AGGRO_BINGX_API_SECRET` | — | Aggro's own sub-account keys |
| `AGGRO_TF` | `4h` | Aggro's timeframe (`4h` or `1h`) |
| `AGGRO_MIN_SCORE` | `4` | How many strategies must agree to trade |
| `AGGRO_STRATEGIES` | all 10 | Strategy menu: `sr,zone,structure,retest,reversal,trendline,fib,consolidation,volume,crt` |
| `CORE_TRAIL` | `on` | Core's swing-low key-level exit |

## Pages
`/` status · `/core` Core equity & positions · `/aggro` Aggro balance, open trades, history · `/shadow` every setup + results · `/shadow` every setup the 10 strategies found and how it did

## Removed in v23
The v19 order-block system and TradingView pipeline, Claude explanations, paper resolvers, weekly challenge report, signal backups, funding watch and kill switch. Research behind every decision stays in `research/`; old code is in git history.
