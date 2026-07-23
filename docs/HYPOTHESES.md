# Hypotheses

This file exists to separate **trading principles currently coded as rules** from
**trading principles actually proven by this bot's own results**. Every entry
below is presently enforced as if confirmed. None of them are — they're
carried-over assumptions from general ICT/SMC practice, not evidence from
this specific bot's own trade history.

Rule for this file: a hypothesis only moves out of "Untested" once real
logged outcomes exist to check it against — not because it "feels right"
after watching a few trades. A single trade, or even a handful, is not
evidence; note it under Evidence, but don't change Status off of it alone.

Status values: `Untested` → `Confirmed` / `Rejected` / `Partially confirmed`
(with the actual finding stated, not just the label).

---

## H-001 — HTF trend opposition reduces win rate / expectancy

**Claim:** When 4H structure (HTF trend) opposes the trade direction, the
setup is meaningfully less likely to succeed than an HTF-aligned setup with
the same raw checklist score.

**Currently enforced as:** `applyRiskGates()` in server.js — any HTF
opposition forces confidence to MEDIUM and caps leverage to the floor band
(10x-25x scalp / 30x-40x swing), regardless of raw score.

**Status:** Untested

**Evidence:** None yet (n=0 systematically logged). One observed case
(SUI short, HTF Bullish + SMT Bullish both opposing) was stopped out — a
single data point, consistent with the hypothesis but not proof of it.

**What would confirm/reject it:** Win rate and average R for HTF-opposed
signals vs HTF-aligned signals, same checklist score, over a meaningful
sample (dozens, not a handful).

---

## H-002 — BTC trend opposition reduces win rate / expectancy

**Claim:** When BTC's own trend opposes the trade direction, win rate drops
relative to an otherwise-identical BTC-aligned setup.

**Currently enforced as:** `scoreBTC()` + `applyRiskGates()` — BTC opposition
scores 0/1 on checklist point 4 AND separately forces the leverage floor,
regardless of the other four points.

**Status:** Untested

**Evidence:** None yet. One earlier session logged a BTC-opposing 4/5
MEDIUM-capped signal that resolved profitably (hit TP1+TP2) — a single
counter-example, not a refutation, given n=1.

**What would confirm/reject it:** Same comparison as H-001, split by
BTC-aligned vs BTC-opposed.

---

## H-003 — Bullish/Bearish SMT divergence opposing trade direction is an early reversal warning

**Claim:** SMT divergence appearing against the trade direction meaningfully
increases the chance of the setup failing or reversing.

**Currently enforced as:** `checkSMT()` in server.js — opposing SMT forces
the same confidence/leverage downgrade as BTC/HTF opposition.

**Status:** Untested

**Evidence:** None yet. One observed case (bullish SMT opposing a short)
was stopped out — consistent with the hypothesis, n=1.

**What would confirm/reject it:** Win rate for signals with opposing SMT
present vs SMT absent/neutral vs SMT confirming.

---

## H-004 — A repeat signal on the same zone within the cooldown window is lower-conviction than a fresh signal

**Claim:** When the same OB zone re-fires a rejection signal within 60
minutes of a prior fire, it needed multiple attempts to hold — which is a
worse sign than a clean first-attempt confirmation, not a neutral or better
one.

**Currently enforced as:** `checkZoneCooldown()` in server.js — any repeat
within the window forces confidence to MEDIUM and the leverage floor,
regardless of what that specific bar's individual flags say.

**Status:** Untested

**Evidence:** None yet. Built specifically after observing a real case where
a repeat-zone signal's confidence silently escalated (MEDIUM → HIGH) between
attempts as a momentary SMT tag aged out of the payload, which prompted this
fix — that's a reason the *fix* is needed, not evidence the underlying
directional claim ("repeats are worse") is true.

**What would confirm/reject it:** Win rate for first-attempt vs repeat-zone
signals (attempt #2, #3+) on the same underlying zone.

---

## Adding new hypotheses

When a new risk rule, filter, or scoring adjustment gets added to the code,
add it here in the same format *before* or *alongside* the code change —
not as an afterthought. If a rule exists in the scoring logic that isn't
listed here, that's a gap in this file, not a sign the rule is safe to
assume.
