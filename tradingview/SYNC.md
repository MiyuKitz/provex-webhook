# TS Flow sync contract

Two copies of the same engine:

| Copy | File | Role |
|---|---|---|
| TradingView indicator | `tradingview/TwoSpeedFlow.pine` | Krysie's chart + HUD |
| Bot engine | `tsflow.js` (used by `server.js` flowTag) | Analyst for the trade bot. Never places orders |

**Rule:** any change to trading logic, defaults or HUD calculations goes into BOTH files in the same commit,
and the version in the Pine header (`TWO-SPEED FLOW vX`) and the tsflow.js header (`TwoSpeedFlow.pine vX`) is bumped together.
`node scripts/check-tsflow-sync.js` fails when they differ; the server logs a warning at start and shows it on `/`.

Pure chart cosmetics (label case, transparency, font size, line width) live only in Pine; bump the Pine version and the
engine header version together anyway so the check stays green.

## Feature parity (v2.1.4)

| Feature | Pine | tsflow.js |
|---|---|---|
| Structure (BOS/CHoCH, close-based) | yes | yes |
| OB / mitigation / FVG, purge on first tap | yes | yes |
| Liquidity pools (minor/major), HTF pools on own resolution | yes | yes (`opts.htfLiq`) |
| Session boxes (NY-anchored), breakout incl. last tracking candle | yes | yes |
| Session volume profile POC | yes | yes |
| Chop / ADX / ADR / EMA-extension filters | yes | yes |
| TAKE / WAIT / AVOID grading (setup rules, soft/hard liquidity) | yes | yes |
| Classic mode, 3-bar cooldown, opposite-signal exit | yes | yes |
| Trade plan: SL 3xATR, TP 0.5/2/3R, BE at TP1, trail 1.5/1.0 ATR | yes | yes |
| WAIT retest recovery (default off) | yes | yes |
| Auto HTF (15-30m->1H, 1H->4H, 2-4H->1D) | yes | yes (`autoHtf`, server passes 1D for 4H, 4H for 1H) |
| Next-Trade Scout: triggers, 7 checks, lean, HTF block | yes (HUD) | yes (trace: buyTrig, sellTrig, ckL/ckS, lean, htfBlock) |
| Chart-only: labels, colours, normal-case old signals, HUD text | yes | n/a |

Regression check for v2.1.4: 28 coins x (4H, 1H) = 56 runs, 57,535 trades identical to the previous engine.
