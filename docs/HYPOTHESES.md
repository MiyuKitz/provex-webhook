# Trading Bot Hypotheses Log

Method note: these findings come from reconstructing real outcomes for
historical signals that were never resolved by the bot itself (skipped by
one-position-per-symbol, so `checkOpenPositions` never saw them). Outcomes
were determined by checking real ETH/SUI 4h candle highs/lows against each
signal's logged entry/SL/TP1 price, walking forward from the signal's
timestamp to find whichever level was touched first.

**Precision limit:** 4h candle resolution means "which level was hit
first" is only accurate to within a 4-hour window. If TP1 and SL were both
touched inside the same 4h candle, true sequencing cannot be determined
from high/low alone — this could overstate wins in rare cases. Treat these
numbers as directionally reliable, not exact.

**Coverage:** Aug 18–24, 2026 only (68 resolved signals). Earlier dates
(Aug 14–17) were outside available candle history depth at the time of
this analysis and are not included.

## Evidence Classification

This document uses these status labels consistently. Do not invent new
ones without adding them here first.

- **SUPPORTED — LIMITED TO OBSERVED WINDOW**: evidence currently supports
  the hypothesis within the stated dataset and date range, but does NOT
  establish that the pattern holds across other market regimes or time
  periods. Requires re-testing against new/different data before being
  treated as general.
- **OBSERVATION**: a pattern exists in the data, but causality or
  persistence is not established. Weaker than SUPPORTED — no claim about
  reliability is being made yet, just that something was noticed.
- **INCONCLUSIVE**: available sample size is insufficient to draw a
  reliable conclusion either way.
- **ENGINEERING ISSUE**: a software/data-pipeline defect affecting data
  quality or reliability, not a trading hypothesis.
- **REGIME-DEPENDENT**: reserved for a hypothesis that has been tested
  across multiple distinct market regimes and found to hold in some but
  not others — this is a genuinely stronger, more useful finding than a
  single-window SUPPORTED status.
- **CONFIRMED**: reserved for findings that remain supported after
  sufficient additional data AND at least one different market regime.
  Nothing in this document currently qualifies for this label.

---

## H-006: OB_LONG signals substantially outperform OB_SHORT signals

**Status: SUPPORTED — LIMITED TO OBSERVED WINDOW (real market data, n=66 combined)**

| Type | Result |
|---|---|
| OB_LONG | 38W / 11L — **77.6% win rate** (n=49) |
| OB_SHORT | 2W / 15L — **11.8% win rate** (n=17) |
| BREAKOUT_LONG | 2W / 0L (n=2, too small to conclude anything) |

This is the single largest, clearest signal in the data. Long OB
rejections won roughly 4 out of 5 times; Short OB rejections lost roughly
5 out of 6 times, over the same 6-day window, same two symbols.

**Honest read — likely NOT a property of "shorts are bad" in general.**
This window (Aug 18–24) coincides with a broadly bullish market for both
ETH and SUI (visible directly in the candle data — both trended up hard
from roughly Aug 18 lows toward Aug 22 highs before pulling back). A
mean-reversion Short signal fighting a strong uptrend is structurally
disadvantaged regardless of checklist quality — this matches the "Market
regime: Trending" flag already built into the bot, and the newer BTC hard-
block and HTF-opposition downgrade were built for exactly this reason.

**What this hypothesis actually establishes, and what it does not:**
established — in this specific window (Aug 18–24, broadly bullish
regime), OB_LONG massively outperformed OB_SHORT. **Not established** —
that OB_LONG generally outperforms OB_SHORT across market regimes. Those
are different claims, and only the first one has evidence behind it right
now.

**What's NOT yet known:** whether OB_SHORT performs this poorly across a
genuinely bearish or ranging window too, or whether the underperformance
is specific to fighting this particular bull run. This needs testing
against a different market regime before treating "Shorts underperform"
as a standing rule rather than a regime-specific observation. If future
data eventually shows OB_SHORT outperforming in a bearish regime, this
hypothesis should be relabeled REGIME-DEPENDENT rather than rewritten —
that would itself be a more valuable finding than either static win-rate
number alone (e.g., "OB_SHORT underperforms specifically when the broader
market is strongly bullish" is a smarter, more actionable rule than
"OB_SHORT is bad").

**Action taken already:** the BTC-opposition hard block (shipped 2026-08-
13) and HTF-opposition confidence downgrade already suppress a meaningful
share of exactly this failure mode going forward. This data is retroactive
confirmation those changes were pointed at a real problem, not a guess.

**Suggested next step (not yet done):** once enough OB_SHORT signals
accumulate post-BTC-block, compare their win rate against this historical
11.8% baseline. If it's still low even with BTC/HTF alignment enforced,
that's evidence the OB_SHORT structural logic itself (not just trend
opposition) needs review.

---

## H-007: Confidence tier (MEDIUM vs HIGH) showed little separation in this window

**Status: INCONCLUSIVE (small HIGH-tier sample)**

| Confidence | Result |
|---|---|
| MEDIUM | 36W / 22L — 62.1% win rate (n=58) |
| HIGH | 6W / 4L — 60.0% win rate (n=10) |

At face value, HIGH confidence signals performed almost identically to
MEDIUM ones — which would be a concerning finding if confirmed, since the
whole point of the confidence tier is to signal "this one's better."

**Why this is NOT yet a real finding:** our current internal threshold
(`MIN_SAMPLE_FOR_INSIGHT = 8`) is a conservative, self-chosen engineering
rule, not a universal statistical standard — it should not be read as
"8 is when a result becomes statistically valid." n=10 for HIGH confidence
is below even this conservative internal bar, and for a meaningful
real comparison we'd ideally want substantially more observations in
both outcome classes (wins and losses) than either tier currently has. A
60% vs 62% gap on this sample size is easily noise.

---

## H-008: SUI underperformed ETH in this window, magnitude unclear if regime-driven

**Status: OBSERVATION, not yet a tested hypothesis**

| Symbol | Result |
|---|---|
| ETHUSDT | 27W / 14L — 65.9% win rate (n=41) |
| SUIUSDT | 15W / 12L — 55.6% win rate (n=27) |

A 10-point win-rate gap between the two symbols the bot trades. Not yet
enough evidence to say why — could be symbol-specific volatility/liquidity
differences, could be that SUI's OB_SHORT signals (which we know
underperform generally per H-006) happened to cluster more heavily on SUI
in this window. Needs a symbol-by-type cross-tab on a larger dataset
before treating this as a real per-symbol effect.

---

## Known data-pipeline issues surfaced by this analysis (engineering, not trading)

1. **Signals blocked by one-position-per-symbol never resolve** in the
   bot's own tracking — confirmed via 121 signals logged Aug 14–24 with
   zero outcomes recorded natively. Fixed 2026-08-26 via
   `resolvePaperTrades()`, which resolves stranded signals against
   current price. This document's findings had to be reconstructed
   manually via historical candles specifically because that fix didn't
   exist yet when this data was generated.

2. **[ENGINEERING ISSUE — 🔴 IMPORTANT INFRASTRUCTURE DEBT] Every
   redeploy wipes `signals.jsonl`** (Railway ephemeral filesystem, no
   persistent volume available on current plan). This is not merely an
   inconvenience — this entire learning architecture depends on
   preserving accumulated experience over time. If this bot eventually
   accumulates thousands of signals, a single redeploy without a
   completed backup could destroy a large portion of the dataset the
   whole "self-improving" premise depends on. The daily Telegram CSV
   backup is a mitigation, not a fix — it only survives if it fires
   *before* the next redeploy, and on nights with frequent pushes,
   multiple signals have already been lost to this before ever reaching
   a backup. Should be prioritized above cosmetic/strategy features
   (additional signal types, MFE/MAE tracking, etc.) even though it isn't
   a "drop everything today" emergency.

3. **`explainDecision`'s Claude-generated reasoning fell back to the
   generic default text** ("Deterministic checklist cleared
   threshold...") on multiple live signals throughout this period. Root
   cause found and fixed 2026-08-28: the code was calling an invalid
   model string (`claude-sonnet-4-6`, which does not match any real
   Anthropic model), and the failure was being silently swallowed with
   no error logging at all — so this had been failing invisibly the
   entire time. Fixed by correcting the model name to `claude-sonnet-5`
   and adding real `console.error` logging at every failure point across
   all three Claude API call sites (`explainDecision`,
   `generateLegacyNote`, `generatePostmortem`), so any future failure is
   diagnosable instead of silent. Not yet confirmed against a live signal
   post-fix — next real signal will be the actual test.

4. **Signals that fail the checklist or get risk-blocked were logged
   nowhere at all** prior to 2026-08-28 — meaning there was no way to
   ever check "is the rejection threshold too strict, and are we missing
   real winners?" Fixed via `logMissedSignal()` / `resolveMissedSignals()`
   and the new `/missed-signals` endpoint, which tracks hypothetical
   entry/SL/TP for every rejected structural signal and resolves them
   against current price the same way paper trades are resolved. No data
   exists yet under this system — it only started tonight. **Not yet
   verified against a real live event** — no NO_TRADE signal has fired
   since this code deployed, so the logging path is implemented but
   unconfirmed in production. Needs verification the first time a real
   rejected signal comes through.

5. **[ENGINEERING ISSUE — 🔴 MAJOR ANALYTICAL DISTINCTION] `resolvePaperTrades`
   and `checkOpenPositions` (real trades) use genuinely different outcome
   methodologies, confirmed by code review 2026-08-28.** Real trades
   resolve via each TP order's actual BingX fill status, checked
   individually and in the order they actually fill. Paper trades resolve
   via a single current-price snapshot checked against TP3, then TP2,
   then TP1, then SL, assuming whichever level current price has reached
   is "the" outcome. These are not equivalent: a paper trade could show
   "TP3" simply because price is currently past that level right now,
   even if the real intraday path never held there, spiked through and
   reversed, or would have hit SL first before ever reaching TP1.

   **Hard rule going forward: paper and real outcomes must remain
   analytically separate unless their resolution methodology is made
   equivalent.** This matters specifically because this is a learning
   system — if the bot (or Claude, via post-mortems) is ever allowed to
   learn from a blended number like "TP3 hit rate: 42%" that actually
   mixes an optimistic paper-resolution method with a strict real-fill
   method, that's exactly the kind of silent data contamination this
   whole logging architecture exists to prevent. `isPaperTrade` filtering
   exists in `computeStats`/`computeChecklistAnalysis` via `?real=true`,
   but the default (unfiltered) view still combines both into one win
   rate — worth revisiting whether that default should change to
   real-only, with paper trades opt-in rather than opt-out.
