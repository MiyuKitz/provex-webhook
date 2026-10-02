# Hypotheses & Evidence Register

*Last rewritten 2 October 2026, at server v19. The previous version of this file is preserved in git history; its findings predate the v17 measurement audit and should not be relied on.*

This file records what has been tested, what the evidence showed, and why the bot is built the way it is. Every live rule in `server.js` should trace back to an entry here.

**Status labels**

| Label | Meaning |
|---|---|
| `REFUTED` | Tested properly, did not hold. Do not re-introduce without new evidence. |
| `LEAD` | Survived retroactive scrutiny. Not yet proven live. |
| `UNDER TEST` | Experiment currently running. |
| `PARTIAL` | Real but narrower than first appeared. |
| `SUPERSEDED` | Replaced by a better-measured finding. |

---

## 1. Read this first: measurement before v17 is not comparable

Results recorded before server v17 (1 Sep – 21 Sep 2026) were produced by instruments with known defects. An audit found:

1. **Order IDs corrupted.** BingX order IDs are 19 digits; `JSON.parse` silently rounded them to the nearest 256. Lookups then asked BingX about orders that did not exist, which could turn real trades into "not taken" or record a win as a loss. BingX's own documentation requires a big-integer-aware parser.
2. **Paper results flattered by ~0.9R per trade.** The paper resolver booked the *whole* position at TP1 the moment it was touched. Live, only 40% closes at TP1; the rest runs to TP2/TP3 or the stop. A TP1-then-stop trade was recorded as +0.5R when the live bot actually books −0.4R.
3. **Real trades never scored.** No `realizedR` was ever written for real fills, so they reported 0.0R regardless of outcome.
4. **Wins counted by label, not money.** A TP1 fill followed by a stop-out was counted as a win.

v17 fixed all four. **Any figure from before v17 overstates performance and should be treated as unreliable.**

---

## 2. Current live configuration (v19)

| Component | Setting | Evidence |
|---|---|---|
| Strategy | OB (ICT order block rejection), 15M | — |
| Symbols | SUI, ETH | Deliberate narrowing, Oct 2026 |
| BTC filter | Hard block when BTC trend opposes | H-013 — *under test* |
| HTF filter | **Block** trades where the 4H trend aligns with the signal | H-012 — *lead* |
| Score gate | ≥ 4.0 (≥ 3.5 in kill zone) | H-011 — gate shown to carry no information |
| Entry | OB zone midpoint, market order | — |
| Stop | Fixed 5% | H-010 |
| Targets | TP1 0.5R (40%) · TP2 2R (30%) · TP3 3R (30%) | H-009 |
| Leverage | Fixed 10x, isolated | Liquidation sits ~10% away vs a 5% stop, so the stop fires first |
| Sizing | Self-calibrating — see §4 | — |
| Positions | One per symbol, any side | Known issue — see §6 |

---

## 3. Hypothesis register

### H-012 — Counter-trend OB trades outperform trend-aligned ones · `LEAD`

**Claim.** OB setups taken *against* the 4H trend outperform those taken with it.

**Evidence** (360 OB signals re-scored from candles under the live ladder, Aug 28 – Oct 1 2026):

| | n | Expectancy |
|---|---|---|
| HTF opposes signal | 161 | **+0.315R** |
| HTF aligns with signal | 199 | **−0.063R** |

Held under every check applied:

- **By session** — kill zone −0.505R gap, outside −0.295R gap; both significant
- **By direction** — longs −0.581R gap, shorts −0.348R gap; both significant
- **By time** — same sign in all five period cells (halves and thirds); effect *grew* rather than decayed

**Mechanism.** OB is a mean-reversion setup. Taken with the trend it fades nothing; taken against an extended move, it fades exactly what it is designed to fade.

**Known weakness — read before trusting it.** The entire sample sits inside one rising market: SUI went from ~0.67 to ~1.26, and the 4H trend read bullish 71% of the time. Most of the profit came from HTF-opposing **longs**, which during a rally is simply dip-buying. A sustained downtrend has never been observed in this data. The time-split tested *time*, not *regime*. In a real downtrend the same logic would be catching falling knives.

**Contradiction on record.** Pattern 4 in the earlier manual-trading log (29 June 2026) concluded the opposite — *"weight HTF trend as dominant thesis and treat counter-trend as tight-leash secondary"* — from a single BTC trade. That observation is the likely origin of the bot's former HTF penalty. Systematic evidence across 360 trades now points the other way. The manual pattern is `SUPERSEDED` for this strategy, though it may still hold for discretionary trend trades.

**Status.** Live forward test since 2026-10-01 22:38 UTC. Target: 30 resolved trades. Success bar: beating **+0.10R net**. Expected to land below the retroactive +0.315R, since the filter was derived from the same data it is being measured on.

---

### H-013 — The BTC hard block improves results · `UNDER TEST`

**Origin.** Added after two losing shorts on 13 Aug 2026 (SUI and ETH, both against BTC trend). Two trades is thin evidence for a hard block. Earlier backtests suggested removing it worsened profit factor, win rate and drawdown together — but those backtests predate the v17 fixes.

**Why it has never been measured live.** Every signal it blocks is diverted to `missed_signals.jsonl`, so it shows `PASS 360 / FAIL 0` in `signals.jsonl` and is invisible to normal analysis.

**Test.** `btc_test.js` scores the blocked signals under the same live config. The decisive comparison is *within HTF-opposing trades* (the only kind v19 takes), restricted to blocked signals that would have cleared every other gate.

**Interaction to be aware of.** Combined with H-012, the bot only trades when BTC and the coin *disagree* — long when BTC is bullish but the coin's 4H is bearish, and the reverse. That is narrow, and is the main reason trade flow is slow.

**Open design question.** Correlation with BTC varies by coin and over time. A blanket rule may suit BTC-correlated majors and filter nothing useful elsewhere. A better version would measure each coin's actual correlation.

---

### H-011 — The 5-point checklist predicts outcome · `REFUTED`

Of the five points, three never vary:

| Point | Pass / Fail |
|---|---|
| MSS confirmed | 359 / 1 |
| BTC confirmation | 360 / 0 |
| OB retest holding | 360 / 0 |

They are true by construction — BTC opposition is a hard block, OB validity triggers the alert, MSS is a standing state. A condition that never varies cannot predict anything.

The two that do vary both came back as noise:

| Point | Gap | Noise band |
|---|---|---|
| Liquidity sweep | +0.032R | ±0.167R |
| Delta flip | +0.051R | ±0.145R |

Score 5 did *worse* than score 4 (+0.058R vs +0.133R), within noise. **The score gate is decoration.** Raising the threshold to 5/5 would roughly halve trade count without improving expectancy.

---

### H-014 — Kill zone trades outperform · `PARTIAL`

Headline: kill zone +0.233R vs outside +0.046R, significant.

Stratified: within HTF-aligned trades the effect **vanishes** (+0.057R gap, noise). Within HTF-opposing trades it **holds** (+0.267R gap).

So the session effect is mostly a shadow of H-012, with a real residual only for counter-trend trades. Best single cell in the data: **HTF-opposing and in kill zone, +0.484R over 58 trades.** Not yet acted on — testing two filters at once would make the result unreadable.

---

### H-007 — HIGH confidence outperforms MEDIUM · `REFUTED` (explained)

Previously marked inconclusive for small sample. With 360 trades: **HIGH −0.121R, MEDIUM +0.149R** — significant, and backwards.

Cause: v17's `applyRiskGates` forced confidence down to MEDIUM whenever HTF opposed. So "MEDIUM" was largely "HTF opposes" relabelled. This is H-012 measured a second time, not an independent finding. As a consequence the old sizing tiers put the *largest* positions on the *worst* trades. Confidence no longer affects sizing as of v18.

---

### H-006 — Longs outperform shorts · `SUPERSEDED`

Earlier: OB_LONG 77.6% win rate vs OB_SHORT 11.8%, flagged as likely regime-specific.

Now: longs +0.142R vs shorts +0.048R — gap within noise. The earlier asymmetry was produced partly by the defective pre-v17 resolver and partly by a bullish window. Direction on its own is not a reliable filter; its apparent effect is largely explained by H-012.

---

### H-010 — A structure-based stop beats a fixed 5% stop · `REFUTED`

Retroactive A/B over 358 signals, stop placed just beyond the OB boundary with buffers of 0.25×, 0.5× and 1.0× zone height.

Gross expectancy was positive and consistent across all three (+0.123R, +0.096R, +0.081R fully closed). Then costs:

| | Stop | Cost in R | Gross | Net |
|---|---|---|---|---|
| Fixed 5% | 5.00% | 0.020R | +0.103R | +0.083R |
| Structural 0.25× | 0.65% | 0.154R | +0.123R | **−0.031R** |
| Structural 0.5× | 0.76% | 0.132R | +0.096R | **−0.036R** |
| Structural 1.0× | 1.02% | 0.098R | +0.081R | **−0.017R** |

Fees are a percentage of *notional*; R is a percentage of *risk*. Cost in R = fee% ÷ stop%. A tighter stop always makes every fee larger in R terms. **This is arithmetic, not a tunable.**

The fixed 5% figure is hollow too: 75% of its trades were still open at the 48-hour mark, so its result is mostly unrealised marks.

---

### H-009 — Moving TP1 from 1R to 0.5R improves results · `REFUTED`

**Motivation.** 61% of outcomes were EXPIRED, with an average best excursion of 0.47R — trades got halfway and stalled.

**Retroactive check.** 37 of 82 expired trades reached 0.5R. Looked promising.

**Forward test** (36 resolved, 3 symbols): **−0.028R**, 17W / 19L, max drawdown 6.07%.

The expired share did fall (61% → 42%), so the change converted some stalled trades into small wins — but +0.5R wins cannot outrun −1R losses.

**The lesson that matters more than the result.** The interim numbers drifted steadily toward zero as the sample grew: +0.39R at 12 trades, +0.15R at 29, −0.028R at 36. Small samples flatter. Only the full-sample forward number counts.

---

### FIB_SR `minQualifyingTouches` · `REFUTED`

The parameter's effect inverted between SUI and ETH, and ETH swung from PF 1.398 out-of-sample to PF 0.383 in-sample in an adjacent window. A gradient that reverses between symbols is a sign of overfitting, not structure.

### Score threshold 5/5 vs 4/5 · `REFUTED`

5/5 backtested well but produced 3 trades in 5 months out of sample — unusable frequency. Combined with H-011, there is no reason to raise it.

---

## 4. How position sizing works (v19)

Sizing is derived from the bot's own resolved trades. No external rule — prop-firm, exchange, or otherwise — enters the calculation.

1. **Edge, measured conservatively.** Uses the *lower bound* of expectancy (mean − 2 standard errors), not the mean. A thin edge on a small sample produces a bound near zero, and therefore near-zero risk, automatically.
2. **Kelly from the real distribution.** For R-multiple outcomes the growth-optimal fraction is approximately `E[r] / E[r²]`. Fat losing tails shrink it on their own.
3. **Quarter-Kelly.** Full Kelly assumes the edge estimate is exact. Quarter-Kelly is the standard convention for uncertainty. This is a chosen convention, openly stated.
4. **Survival ceiling.** The strategy's longest losing run is measured, and compared with the run length probability predicts for the sample size (`log n / log(1/lossRate)`). The longer is assumed. The ceiling keeps that run within `MAX_STREAK_DRAWDOWN` of equity (default 25%, env-configurable).

| Situation | Risk per trade |
|---|---|
| Fewer than 30 resolved trades | 0.25% floor |
| Expectancy not distinguishable from zero | 0.25% floor |
| Proven edge | rises toward quarter-Kelly |
| Account grows | same fraction, larger size — compounds |
| Account shrinks | same fraction, smaller size — de-risks automatically |

**Leverage is not a risk dial.** Loss per trade is stop distance × position size. Leverage only determines margin locked up and where liquidation sits. At 10x isolated, liquidation is ~10% away versus a 5% stop. At 20x it would land on top of the stop.

---

## 5. Methodology rules

These were each learned the hard way in this project.

1. **Retroactive is a reason to forward-test, never a result.** H-009 looked good retroactively and failed live.
2. **Watch the interim drift.** If expectancy shrinks steadily as the sample grows, the edge was probably noise.
3. **Measure every gap against its own noise band.** With ~15 comparisons, one will look significant by chance alone.
4. **Stratify before believing.** Two of three "significant" results in the entry test turned out to be one finding counted twice.
5. **Check for conditions that never vary.** A filter that is always true cannot predict anything, and looks perfect in a pass-rate table.
6. **Price costs in R, not in percent.** A tight stop can turn a gross edge net-negative.
7. **One variable at a time.** Changing two things at once makes the result unattributable.
8. **Never compare samples of different composition.** Dropping unresolved trades from one side of a comparison and not the other produces a false winner (as in H-010's first run).
9. **Instruments must be audited too.** The worst errors in this project were in the measuring tools, not the strategy.
10. **Parameter gradients that reverse between symbols mean overfitting.**

---

## 6. Open questions and known issues

- **Regime dependence of H-012.** Untested until a sustained downtrend occurs. Plan to re-check the HTF split by trend direction once one does.
- **One-position-per-symbol rule.** Blocks any new trade while a position is open — including the opposite side — even though the account is in Hedge Mode, where opposite positions are independent. Main reason only 1 of 36 trades in the Sep test was a real fill. Options: leave it; allow opposite sides; or allow opposite sides with a combined open-risk cap.
- **Stale SUI alert.** Created 28 July 2026; the indicator has been edited since. TradingView freezes the script version at alert creation, so SUI may be running older logic than ETH. Recreate against the same indicator as the ETH alert.
- **Per-coin BTC correlation.** Whether a blanket BTC rule should become a measured per-coin one.
- **Kill zone within counter-trend trades** (H-014 residual) — a second filter to test only after H-012 resolves.
- **FIB_SR regime dependence** — whether its poor in-sample ETH result reflects regime or a real refutation.

---

## 7. Research tools

All read `/data/signals.jsonl` and share a candle cache at `/data/walk_cache.json`, so repeat analyses are near-instant. All score trades with the same live ladder, so their results are directly comparable.

| Script | Purpose |
|---|---|
| `cross_tab.js` | Builds the candle cache; stratifies HTF by session and direction |
| `time_split.js` | Tests whether the HTF effect holds across time periods |
| `entry_test.js` | Breaks outcomes down by each checklist point, score, session, direction and confidence |
| `btc_test.js` | Scores signals the BTC rule blocked, compared with those it allowed |
| `sl_test.js` | Structural vs fixed stop comparison — kept as the record for H-010 |

Every finding above rests on roughly 360 retroactive trades. **Re-running these on 600 or 1,000 trades is how a lead becomes a confirmed result.**
