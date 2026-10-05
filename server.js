const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

const BINGX_API_KEY    = process.env.BINGX_API_KEY;
const BINGX_API_SECRET = process.env.BINGX_API_SECRET;
const BINGX_BASE_URL   = "https://open-api-vst.bingx.com";

const DATA_DIR = process.env.DATA_DIR || __dirname;
const SERVER_VERSION = "v20.3";
const SIGNAL_LOG_FILE = path.join(DATA_DIR, "signals.jsonl");

// ============================================================
// SHARED RESPONSE PARSER (fixed 2026-09-04)
// Previously each Claude call did: parsed.content?.[0]?.text
// That breaks with claude-sonnet-5, which can return a "thinking"
// block as content[0] — index 0 then has no .text, the call silently
// returns falsy, and callers fall back to defaults (or bail entirely,
// which is why lessons.jsonl was never written).
// This filters by block type instead of position.
// ============================================================
function extractClaudeText(parsed) {
  return (parsed.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("")
    .trim();
}

function logSignal(decision, payload, execResult) {
  try {
    const { type, scoreResult, gated, levels, isSwing } = decision;
    const entry = {
      loggedAt: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
      symbol: payload.symbol || "—",
      condition: payload.condition || "",
      type,
      strategy: decision.strategy || "OB_SMC",
      isSwing: !!isSwing,
      zoneAttempt: payload._zoneAttempt || 1,
      isRepeatZone: payload._isRepeatZone || false,
      direction: scoreResult.direction,
      rawScore: scoreResult.rawScore,
      confidence: gated.confidence,
      leverage: gated.leverage,
      entryZone: levels.entryZone,
      stopLoss: levels.stopLoss,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      flags: gated.flags,
      checklist: scoreResult.points.map(p => ({ label: p.label, pass: p.pass })),
      htfTrend: payload.htfTrend || null,
      btcTrend: payload.btcTrend || null,
      smtBias: payload.smtBias || null,
      killzone: bool(payload.killzone),
      bingxOrderId: execResult?.bingxOrderId || null,
      bingxSymbol: execResult?.bingxSymbol || null,
      bingxTpOrderIds: execResult?.tpOrderIds || null,
      riskVST: execResult?.riskVST ?? null,
      marginUSDT: execResult?.marginUSDT ?? null,
      leverageUsed: execResult?.leverageUsed ?? null,
      aggro: execResult?.aggro || false,
      outcome: null,
      realizedR: null,
      notes: null,
      isPaperTrade: false,
    };
    fs.appendFileSync(SIGNAL_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Signal logging failed (non-fatal):", err.message);
  }
}

function readSignalLog() {
  try {
    if (!fs.existsSync(SIGNAL_LOG_FILE)) return [];
    const lines = fs.readFileSync(SIGNAL_LOG_FILE, "utf8").split("\n").filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function writeSignalLog(signals) {
  try {
    const lines = signals.map(s => JSON.stringify(s)).join("\n") + (signals.length ? "\n" : "");
    fs.writeFileSync(SIGNAL_LOG_FILE, lines);
  } catch (err) {
    console.error("Failed to rewrite signal log (non-fatal):", err.message);
  }
}

const MISSED_SIGNAL_LOG_FILE = path.join(DATA_DIR, "missed_signals.jsonl");

function computeHypotheticalLevels(payload, direction, type) {
  try {
    const isSwing = type.startsWith("OB_SWING_");
    const levels = isSwing
      ? computeSwingLevels(payload, direction)
      : type.startsWith("OB_")
        ? computeOBLevels(payload, direction)
        : computeBreakoutLevels(payload, direction);
    if (!levels.entryMidRaw || levels.entryMidRaw <= 0 || isNaN(levels.entryMidRaw)) return null;
    return levels;
  } catch {
    return null;
  }
}

function logMissedSignal(decision, payload) {
  try {
    const { type, scoreResult, reason } = decision;
    if (!type || !scoreResult) return;
    const direction = scoreResult.direction;
    const levels = computeHypotheticalLevels(payload, direction, type);
    const entry = {
      loggedAt: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
      symbol: payload.symbol || "—",
      condition: payload.condition || "",
      type,
      direction,
      rawScore: scoreResult.rawScore,
      rejectionReason: reason,
      checklist: scoreResult.points ? scoreResult.points.map(p => ({ label: p.label, pass: p.pass })) : null,
      htfTrend: payload.htfTrend || null,
      btcTrend: payload.btcTrend || null,
      smtBias: payload.smtBias || null,
      killzone: bool(payload.killzone),
      hypotheticalEntryZone: levels?.entryZone || null,
      hypotheticalStopLoss: levels?.stopLoss || null,
      hypotheticalTp1: levels?.tp1 || null,
      hypotheticalTp2: levels?.tp2 || null,
      hypotheticalTp3: levels?.tp3 || null,
      outcome: null,
      isMissedSignal: true,
    };
    fs.appendFileSync(MISSED_SIGNAL_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Missed-signal logging failed (non-fatal):", err.message);
  }
}

function readMissedSignalLog() {
  try {
    if (!fs.existsSync(MISSED_SIGNAL_LOG_FILE)) return [];
    const lines = fs.readFileSync(MISSED_SIGNAL_LOG_FILE, "utf8").split("\n").filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function writeMissedSignalLog(signals) {
  try {
    const lines = signals.map(s => JSON.stringify(s)).join("\n") + (signals.length ? "\n" : "");
    fs.writeFileSync(MISSED_SIGNAL_LOG_FILE, lines);
  } catch (err) {
    console.error("Failed to rewrite missed-signal log (non-fatal):", err.message);
  }
}

async function resolveMissedSignals() {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;
  const signals = readMissedSignalLog();
  const candidates = signals.filter(s => s.outcome === null && s.hypotheticalEntryZone);
  if (!candidates.length) return;

  let anyUpdated = false;
  for (const sig of candidates) {
    try {
      const symbol = toBingXSymbol(sig.symbol);
             const currentPrice = await getCachedPrice(symbol);
        if (!currentPrice) continue;

      const parsePrice = (str) => parseFloat(String(str).replace(/[^0-9.]/g, ""));
      const sl = parsePrice(sig.hypotheticalStopLoss);
      const tp1 = parsePrice(sig.hypotheticalTp1);
      const isShort = sig.direction === "Short";

      let outcome = null;
      if (isShort) {
        if (currentPrice >= sl) outcome = "WOULD_HAVE_LOST";
        else if (currentPrice <= tp1) outcome = "WOULD_HAVE_WON";
      } else {
        if (currentPrice <= sl) outcome = "WOULD_HAVE_LOST";
        else if (currentPrice >= tp1) outcome = "WOULD_HAVE_WON";
      }

      if (outcome) {
        sig.outcome = outcome;
        anyUpdated = true;
      }
    } catch (err) {
      console.error(`Missed-signal resolution failed for ${sig.symbol}:`, err.message);
    }
  }
  if (anyUpdated) writeMissedSignalLog(signals);
}

const LESSONS_LOG_FILE = path.join(DATA_DIR, "lessons.jsonl");

const POSTMORTEM_SYSTEM_PROMPT = `You are writing a structured post-mortem for one resolved crypto futures trade signal. You are NOT deciding anything and NOT allowed to suggest specific numeric changes to scoring, leverage, or thresholds — only Krysie (the trader) makes that decision, later, using accumulated data across many trades.

If the signal is marked as a PAPER TRADE, explicitly note that this was never a real executed order — it was skipped by the bot's own position rules, and the outcome is inferred from current price versus logged levels, not a real fill confirmation. Treat paper trade conclusions as weaker evidence than real trade evidence.

You MUST separate your answer into exactly these four labeled sections, in this order:

FACT: State only what is directly verifiable from the data given (entry price, SL/TP prices, actual outcome, direction, whether this was a real trade or paper trade). 1 sentence.

OBSERVATION: Note any contextual detail from the checklist/flags that was present at signal time, without yet claiming it caused anything. 1-2 sentences.

HYPOTHESIS: Your inferred explanation for why this trade won or lost. Be explicit this is a guess, not proof. Explicitly consider whether this was a SIGNAL problem (the thesis was wrong) versus a RISK MANAGEMENT problem (SL too tight, entry too late, TP too far) — these require different fixes and must not be conflated. 2-3 sentences.

KNOWLEDGE GAP: State plainly if there isn't enough similar historical data yet to know whether this hypothesis is a real pattern or a one-off. Do not overstate confidence from a single trade.

Output ONLY these four labeled sections. No preamble, no summary, no recommendations.`;

async function generatePostmortem(signal) {
  const userMessage = `Signal type: ${signal.type}
Symbol: ${signal.symbol}
Direction: ${signal.direction}
Trade type: ${signal.isPaperTrade ? "PAPER TRADE (never executed, skipped by position rules)" : "REAL EXECUTED TRADE"}
Checklist: ${(signal.checklist || []).map(c => `[${c.pass ? "PASS" : "FAIL"}] ${c.label}`).join(" | ")}
Confidence: ${signal.confidence}, Raw score: ${signal.rawScore}/5
Risk flags at signal time: ${(signal.flags || []).join("; ") || "none"}
Entry: ${signal.entryZone}, SL: ${signal.stopLoss}, TP1: ${signal.tp1}, TP2: ${signal.tp2}, TP3: ${signal.tp3}
Outcome: ${signal.outcome}
HTF trend: ${signal.htfTrend}, BTC trend: ${signal.btcTrend}, SMT bias: ${signal.smtBias}

Write the four-section post-mortem now.`;

  const body = JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 400,
    system: POSTMORTEM_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return new Promise((resolve) => {
    const req = https.request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = extractClaudeText(parsed);
          if (!text) console.error("generatePostmortem: empty/unexpected response:", data.slice(0, 300));
          resolve(text || null);
        } catch (err) {
          console.error("generatePostmortem: response parse failed. Raw response:", data.slice(0, 300));
          resolve(null);
        }
      });
    });
    req.on("error", (err) => {
      console.error("generatePostmortem: API call failed:", err.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

function readLessonsLog() {
  try {
    if (!fs.existsSync(LESSONS_LOG_FILE)) return [];
    const lines = fs.readFileSync(LESSONS_LOG_FILE, "utf8").split("\n").filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

async function logPostmortem(signal) {
  try {
    if (signal.isPaperTrade) return;
    const postmortem = await generatePostmortem(signal);
    if (!postmortem) return;
    const entry = {
      loggedAt: new Date().toISOString(),
      symbol: signal.symbol,
      direction: signal.direction,
      outcome: signal.outcome,
      rawScore: signal.rawScore,
      confidence: signal.confidence,
      isPaperTrade: !!signal.isPaperTrade,
      postmortem,
      status: "unreviewed",
    };
    fs.appendFileSync(LESSONS_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Post-mortem generation failed (non-fatal):", err.message);
  }
}

// ============================================================
// REAL-TRADE OUTCOME TRACKING (v17)
//
// Three problems in the previous version, all of which misreported real
// trades:
//
//  1. It resolved the trade the moment TP1 filled — but TP1 is only 40% of
//     the position. The other 60% kept running and was never accounted for.
//  2. It never set realizedR, so every real trade showed 0.0R in reports no
//     matter how it actually closed.
//  3. BingX code 109421 ("order not found") was recorded as "not_taken".
//     A MARKET order that BingX accepted has filled — "not taken" was false.
//     With order IDs corrupted by float rounding (fixed in v17 parsing),
//     that path was likely hiding real trades.
//
// Now: the trade stays open until BingX shows no position on the symbol.
// Then each TP order is checked. Filled TPs contribute their slice at their
// actual fill price; any slice not filled by a TP is treated as closed by
// the stop at -1R. R is measured from the ACTUAL entry fill (avgPrice), not
// the zone midpoint the order was sized against.
//
// KNOWN LIMIT, stated rather than hidden: a manual close on BingX looks
// identical to a stop-out here. If you close a position by hand, its
// unfilled slices will be recorded at -1R. The record's notes say so.
// ============================================================
async function checkOpenPositions() {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;
  const signals = readSignalLog();
  const openSignals = signals.filter(s => s.outcome === null && s.bingxOrderId && s.bingxSymbol);
  if (!openSignals.length) return;

  let anyUpdated = false;
  for (const sig of openSignals) {
    try {
      const entryCheck = await bingxRequest("GET", "/openApi/swap/v2/trade/order", {
        symbol: sig.bingxSymbol, orderId: String(sig.bingxOrderId),
      });
      const entryOrder = entryCheck.data?.order;
      const entryStatus = entryOrder?.status;

      if (entryCheck.code === 109421 || (entryCheck.code === 0 && !entryOrder)) {
        sig.outcome = "UNVERIFIABLE";
        sig.notes = `BingX could not find entry order ${sig.bingxOrderId} (code ${entryCheck.code}). For records written before v17 the likely cause is the order ID having been rounded when stored. The trade may well have happened — its outcome is unknown, so it is excluded from win/loss stats rather than guessed.`;
        anyUpdated = true;
        continue;
      }
      if (entryCheck.code !== 0 || !entryOrder) continue; // transient error — retry next cycle

      if (entryStatus === "CANCELED" || entryStatus === "EXPIRED" || entryStatus === "FAILED") {
        sig.outcome = "not_taken";
        sig.notes = `Entry order status ${entryStatus} — never filled.`;
        anyUpdated = true;
        continue;
      }
      if (entryStatus !== "FILLED") continue;

      const fill = parseFloat(entryOrder.avgPrice);
      if (!sig.entryFillPrice && fill > 0) { sig.entryFillPrice = fill; anyUpdated = true; }

      // v19.1: side-aware. With opposite sides allowed in Hedge Mode, "any
      // position on this symbol" would keep a closed LONG looking open while
      // a SHORT is live — so match symbol AND direction.
      const posCheck = await getOpenPositions();
      if (!posCheck.checked) continue;       // could not verify — never guess
      if (posCheck.positions.some(p => p.symbol === sig.bingxSymbol && p.direction === sig.direction)) continue; // still open

      // Position is closed. Account for every slice.
      const sl = parseLevels(sig.stopLoss)[0];
      const isShort = sig.direction === "Short";
      const risk = Math.abs(fill - sl);
      if (!(fill > 0) || !(risk > 0)) {
        sig.outcome = "UNVERIFIABLE";
        sig.notes = `Position closed but entry fill (${entryOrder.avgPrice}) or stop (${sig.stopLoss}) unusable — cannot compute R.`;
        anyUpdated = true;
        continue;
      }

      let realized = 0, filledWeight = 0, highest = null, lookupFailed = false;
      const fills = {};
      for (const { label, weight } of LADDER) {
        const id = sig.bingxTpOrderIds?.[label];
        if (!id) continue;
        const tpCheck = await bingxRequest("GET", "/openApi/swap/v2/trade/order", {
          symbol: sig.bingxSymbol, orderId: String(id),
        });
        if (tpCheck.code !== 0) { lookupFailed = true; continue; }
        const o = tpCheck.data?.order;
        if (o?.status === "FILLED") {
          const px = parseFloat(o.avgPrice) || parseFloat(o.price);
          const r = (isShort ? fill - px : px - fill) / risk;
          realized += weight * r;
          filledWeight += weight;
          highest = label;
          fills[label] = { price: px, r: +r.toFixed(3), weight };
        }
      }

      if (lookupFailed) {
        // A TP lookup failing means we cannot tell whether that slice won.
        // Recording it as a stop-out would risk turning a win into a loss.
        sig.outcome = "UNVERIFIABLE";
        sig.ladderFills = fills;
        sig.notes = "Position closed, but at least one TP order could not be looked up (likely a pre-v17 rounded ID). Outcome not recorded rather than guessed.";
        anyUpdated = true;
        continue;
      }

      const stoppedWeight = +(1 - filledWeight).toFixed(4);
      realized += stoppedWeight * -1;

      sig.outcome = highest || "SL";
      sig.realizedR = +realized.toFixed(3);
      sig.ladderFills = fills;
      sig.stoppedWeight = stoppedWeight;
      sig.resolvedBy = "bingx-orders-v17";
      sig.notes = (highest
          ? `${Object.keys(fills).join(", ")} filled on BingX; remaining ${Math.round(stoppedWeight * 100)}% closed without a TP fill and is recorded at -1R.`
          : `No TP filled; position closed — recorded at -1R.`)
        + ` Entry fill ${fill}. A manual close looks identical to a stop-out and would be recorded the same way.`;
      anyUpdated = true;
      settleAggro(sig).catch(err => console.error("settleAggro failed (non-fatal):", err.message));
      logPostmortem(sig).catch(err => console.error("logPostmortem failed (non-fatal):", err.message));
      console.log(`Real trade resolved ${sig.symbol} ${sig.direction} -> ${sig.outcome} (${sig.realizedR}R)`);
    } catch (err) {
      console.error(`Failed to check signal (order ${sig.bingxOrderId}):`, err.message);
    }
  }
  if (anyUpdated) writeSignalLog(signals);
}

// ============================================================
// PRICE CACHE (v12) — fixes the BingX 429 storm.
// Every consumer was independently hitting /quote/price, producing
// 5-8 identical requests for the same symbol within ~200ms and a
// steady drip of [429] code:100410. A short TTL collapses those into
// one call without changing any behaviour that depends on the price.
// ============================================================
const priceCache = new Map(); // symbol -> { price, at }
const PRICE_TTL_MS = 2000;

async function getCachedPrice(bingxSymbol) {
  const hit = priceCache.get(bingxSymbol);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  const res = await bingxRequest("GET", "/openApi/swap/v2/quote/price", { symbol: bingxSymbol });
  const price = parseFloat(res.data?.price ?? res.price);
  if (!price || isNaN(price)) return null;
  priceCache.set(bingxSymbol, { price, at: Date.now() });
  return price;
}

// ============================================================
// LEVEL PARSING (v12) — replaces the old inline parsePrice.
// Old version stripped every non-digit, so "$105.62-$106.40" became
// the string "105.62106.40" and parseFloat silently returned 105.62.
// Single values were fine, which is why this never surfaced — until
// the entry gate below needs both bounds of the entry zone.
// ============================================================
function parseLevels(str) {
  if (str == null) return [];
  return String(str)
    .replace(/[$,\s]/g, "")
    .split(/[-–—]/)
    .map(x => parseFloat(x))
    .filter(n => !isNaN(n));
}

// ============================================================
// CANDLE-WALK RESOLUTION (v12)
//
// Replaces a resolver that took a SINGLE current-price snapshot and
// asked "which side of the levels is price on now". That had three
// fatal properties:
//   1. No entry gate. A signal was marked SL even if price never
//      traded into the entry zone, so losses were recorded on
//      positions that never existed.
//   2. No sequencing. It could not tell whether SL or TP was touched
//      first, only where price ended up.
//   3. No time bound. Given enough drift every signal eventually
//      resolved, so direction and outcome became mathematically
//      dependent on the prevailing trend rather than on the setup.
//
// Re-resolving all 99 historical signals with the logic below turned
// 82 of them into EXPIRED and revealed that 13 recorded "TP1" wins
// had never reached TP at all.
//
// This walks 5m candles forward from the signal timestamp:
//   entry gate -> first touch of SL or TP -> realizedR
// AMBIGUOUS is returned when both levels are touched inside the same
// candle, because the true order is genuinely unknowable at 5m and
// guessing would reintroduce the bias this replaces.
// ============================================================
const RESOLVE_INTERVAL = "5m";
const RESOLVE_MAX_HOURS = 48;

async function fetchKlines(bingxSymbol, startTime, endTime) {
  const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines`
    + `?symbol=${bingxSymbol}&interval=${RESOLVE_INTERVAL}`
    + `&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (!Array.isArray(j.data)) return null;
    return j.data
      .map(k => ({ t: +k.time, o: +k.open, h: +k.high, l: +k.low, c: +k.close }))
      .sort((a, b) => a.t - b.t);
  } catch (err) {
    console.error(`Kline fetch failed for ${bingxSymbol}:`, err.message);
    return null;
  }
}

// ============================================================
// LADDER-ACCURATE CANDLE WALK (v17)
//
// Previous versions returned the moment TP1 was touched and booked the
// WHOLE position at TP1. The live bot does not do that — executeOnBingX
// closes 40% at TP1, 30% at TP2, 30% at TP3, and anything still open when
// the stop is hit closes at -1R.
//
// With TP1 at 0.5R that difference is large. A TP1 touch followed by a
// reversal to the stop was being recorded as +0.5R. What the live bot
// actually books is 0.4 x 0.5R - 0.6 x 1R = -0.4R — a loss recorded as a
// win. Paper results therefore flattered exactly the change being tested.
//
// This walk now follows the same ladder the live bot runs:
//   - each TP closes its own slice at its own price
//   - the stop closes whatever is still open at -1R
//   - realizedR is the weighted sum across slices
//   - if the 48h window ends with a slice still open, that slice is marked
//     to market at the last close and flagged, never silently dropped
//
// A stop and an unfilled target touched inside one 5m candle is still
// AMBIGUOUS: the order of touches is unknowable at 5m, and guessing would
// reintroduce the bias this exists to remove.
// ============================================================
const LADDER = [
  { label: "TP1", weight: 0.4 },
  { label: "TP2", weight: 0.3 },
  { label: "TP3", weight: 0.3 },
];

function walkCandles(sig, bars) {
  const zone = parseLevels(sig.entryZone);
  const sl   = parseLevels(sig.stopLoss)[0];
  const tpPx = {
    TP1: parseLevels(sig.tp1)[0],
    TP2: parseLevels(sig.tp2)[0],
    TP3: parseLevels(sig.tp3)[0],
  };
  if (!zone.length || !sl || !tpPx.TP1) return { outcome: "BAD_LEVELS" };

  const zLo = Math.min(...zone), zHi = Math.max(...zone);
  const isShort = sig.direction === "Short";
  const entry = (zLo + zHi) / 2;
  const risk = Math.abs(entry - sl);
  if (!risk) return { outcome: "BAD_LEVELS" };

  const rAt = (px) => (isShort ? entry - px : px - entry) / risk;
  const touched = (px, b) => isShort ? b.l <= px : b.h >= px;

  // A missing TP2/TP3 price (should not happen for OB levels) folds its
  // weight into the previous slice rather than silently vanishing.
  const slices = [];
  for (const s of LADDER) {
    if (tpPx[s.label]) slices.push({ ...s, price: tpPx[s.label], done: false });
    else if (slices.length) slices[slices.length - 1].weight += s.weight;
  }

  let filled = false, fillT = null;
  let mfeR = 0, maeR = 0, barsHeld = 0, mfeBarsIn = null;
  let realized = 0, lastClose = null, highest = null;
  const fills = {};

  const excursion = () => ({
    mfeR: +mfeR.toFixed(2), maeR: +maeR.toFixed(2),
    barsHeld, barsToMfe: mfeBarsIn, minutesHeld: barsHeld * 5,
  });

  for (const b of bars) {
    if (!filled) {
      if (b.l <= zHi && b.h >= zLo) { filled = true; fillT = b.t; }
      else continue;
    }
    barsHeld += 1;
    lastClose = b.c;

    const favR = (isShort ? entry - b.l : b.h - entry) / risk;
    const advR = (isShort ? entry - b.h : b.l - entry) / risk;
    if (favR > mfeR) { mfeR = favR; mfeBarsIn = barsHeld; }
    if (advR < maeR) { maeR = advR; }

    const hitSL = isShort ? b.h >= sl : b.l <= sl;
    const open = slices.filter(s => !s.done);
    const hitNow = open.filter(s => touched(s.price, b));

    if (hitSL && hitNow.length) {
      return { outcome: "AMBIGUOUS", entry, fillT, realizedR: null, fills, ...excursion(),
        note: "Stop and an unfilled target touched inside one 5m candle — order unknowable, excluded from win/loss stats. " };
    }

    for (const s of hitNow) {
      s.done = true;
      const r = rAt(s.price);
      realized += s.weight * r;
      fills[s.label] = { price: s.price, r: +r.toFixed(3), weight: s.weight };
      highest = s.label;
    }

    if (hitSL) {
      const openWeight = slices.filter(s => !s.done).reduce((a, s) => a + s.weight, 0);
      realized += openWeight * -1;
      return {
        outcome: highest || "SL", entry, fillT, exit: sl,
        realizedR: +realized.toFixed(3), fills, stoppedWeight: +openWeight.toFixed(2),
        ...excursion(),
        note: highest ? `${highest} filled, remaining ${Math.round(openWeight * 100)}% stopped at -1R. ` : "",
      };
    }

    if (slices.every(s => s.done)) {
      return { outcome: highest, entry, fillT, exit: slices[slices.length - 1].price,
        realizedR: +realized.toFixed(3), fills, ...excursion(), note: "" };
    }
  }

  if (!filled) return { outcome: "NOT_TAKEN", entry, fillT, realizedR: null, fills, ...excursion() };

  // Window ended with part of the position still open.
  const openWeight = slices.filter(s => !s.done).reduce((a, s) => a + s.weight, 0);
  if (!highest) {
    // Nothing filled, nothing stopped — genuinely unresolved, no P&L claimed.
    return { outcome: "EXPIRED", entry, fillT, realizedR: null, fills, ...excursion() };
  }
  const mtmR = lastClose != null ? rAt(lastClose) : 0;
  realized += openWeight * mtmR;
  return {
    outcome: highest, entry, fillT, exit: lastClose,
    realizedR: +realized.toFixed(3), fills,
    openWeightAtExpiry: +openWeight.toFixed(2), openMarkR: +mtmR.toFixed(3),
    ...excursion(),
    note: `${highest} filled; remaining ${Math.round(openWeight * 100)}% still open at the 48h mark, valued at last close (${mtmR.toFixed(2)}R) — unrealized, not a closed result. `,
  };
}

async function resolvePaperTrades() {
  const signals = readSignalLog();
  const candidates = signals.filter(s => s.outcome === null && !s.bingxOrderId);
  if (!candidates.length) return;

  let anyUpdated = false;
  for (const sig of candidates) {
    try {
      const start = Date.parse(sig.loggedAt);
      if (!start) continue;

      const ageHours = (Date.now() - start) / 3600e3;
      const end = Math.min(start + RESOLVE_MAX_HOURS * 3600e3, Date.now());
      const bars = await fetchKlines(toBingXSymbol(sig.symbol), start, end);
      if (!bars || !bars.length) continue;

      const res = walkCandles(sig, bars);

      if ((res.outcome === "EXPIRED" || res.outcome === "NOT_TAKEN") && ageHours < RESOLVE_MAX_HOURS) continue;
      if (res.outcome === "BAD_LEVELS") continue;

      sig.outcome    = res.outcome;
      sig.realizedR  = res.realizedR ?? null;
      sig.isPaperTrade = true;
      sig.resolvedBy = "candle-walk-v17-ladder";
      sig.ladderFills = res.fills || null;
      sig.stoppedWeight = res.stoppedWeight ?? null;
      if (res.openWeightAtExpiry != null) {
        sig.openWeightAtExpiry = res.openWeightAtExpiry;
        sig.openMarkR = res.openMarkR;
      }
      sig.entryFilledAt = res.fillT ? new Date(res.fillT).toISOString() : null;
      sig.mfeR = res.mfeR ?? null;
      sig.maeR = res.maeR ?? null;
      sig.barsHeld = res.barsHeld ?? null;
      sig.minutesHeld = res.minutesHeld ?? null;
      sig.notes = `PAPER TRADE — resolved by 5m candle walk with entry gate and first-touch sequencing. `
        + `Entry zone ${sig.entryZone}${res.fillT ? ` filled ${new Date(res.fillT).toISOString()}` : " never filled"}. `
        + `${res.note || ""}Modelled on the live 40/30/30 ladder. Still weaker evidence than a confirmed BingX fill: no slippage, no fees.`;
      anyUpdated = true;

      if (res.outcome === "SL" || String(res.outcome).startsWith("TP")) {
        logPostmortem(sig).catch(err => console.error("logPostmortem (paper) failed (non-fatal):", err.message));
      }
      console.log(`Resolved ${sig.symbol} ${sig.direction} -> ${res.outcome}${res.realizedR != null ? ` (${res.realizedR}R)` : ""}`);
    } catch (err) {
      console.error(`Paper trade resolution failed for ${sig.symbol}:`, err.message);
    }
  }
  if (anyUpdated) writeSignalLog(signals);
}

function computeStats(signals, options = {}) {
  const { includePaper = false } = options;
  const base = includePaper ? signals : signals.filter(s => isReal(s));
  const resolved = base.filter(s => isClosed(s.outcome));

  function winRate(arr) {
    const won = arr.filter(s => tradeResult(s) === "win").length;
    const lost = arr.filter(s => tradeResult(s) === "loss").length;
    const total = won + lost;
    return { total, won, lost, winRatePct: total > 0 ? Number((won / total * 100).toFixed(1)) : null };
  }

  const htfOpposed = resolved.filter(s => (s.flags || []).some(f => f.includes("HTF trend") && f.includes("opposes")));
  const htfAligned = resolved.filter(s => !(s.flags || []).some(f => f.includes("HTF trend") && f.includes("opposes")));
  const btcOpposed = resolved.filter(s => (s.flags || []).some(f => f.includes("BTC trend opposes")));
  const btcAligned = resolved.filter(s => !(s.flags || []).some(f => f.includes("BTC trend opposes")));
  const repeatZone = resolved.filter(s => (s.flags || []).some(f => f.includes("Repeat signal on the same zone")));
  const freshZone = resolved.filter(s => !(s.flags || []).some(f => f.includes("Repeat signal on the same zone")));

  const realCount = signals.filter(s => isReal(s)).length;
  const paperCount = signals.filter(s => !isReal(s)).length;

  return {
    totalLogged: signals.length,
    totalResolved: resolved.length,
    realTradeCount: realCount,
    paperTradeCount: paperCount,
    filterApplied: includePaper ? "real + paper combined" : "real trades only (default — safer, see HYPOTHESES.md issue #5)",
    ...(includePaper ? {
      warning: "⚠️ PAPER TRADES INCLUDED — these are resolved by a 5m candle walk modelled on the live ladder, not real BingX fills (no fees, no slippage). Do NOT treat this blended win rate as equivalent to real-trade performance. Use default (no ?includePaper=true) for trustworthy numbers.",
    } : {}),
    overall: winRate(resolved),
    byHtfOpposition: { opposed: winRate(htfOpposed), aligned: winRate(htfAligned) },
    byBtcOpposition: { opposed: winRate(btcOpposed), aligned: winRate(btcAligned) },
    byZoneRepeat: { repeat: winRate(repeatZone), fresh: winRate(freshZone) },
    note: "Small sample sizes early on will look noisy — this is descriptive, not statistically confirmed until each bucket has a real sample (see docs/HYPOTHESES.md). Add ?includePaper=true to include paper trades (not recommended for trustworthy stats).",
  };
}

const MIN_SAMPLE_FOR_INSIGHT = 8;

function computeChecklistAnalysis(signals, options = {}) {
  const { includePaper = false } = options;
  const base = includePaper ? signals : signals.filter(s => isReal(s));
  const resolved = base.filter(s => isClosed(s.outcome) && s.checklist);

  function winRateOf(arr) {
    const won = arr.filter(s => tradeResult(s) === "win").length;
    const lost = arr.filter(s => tradeResult(s) === "loss").length;
    const total = won + lost;
    return {
      total, won, lost,
      winRatePct: total > 0 ? Number((won / total * 100).toFixed(1)) : null,
      reliable: total >= MIN_SAMPLE_FOR_INSIGHT,
    };
  }

  const checklistLabels = [...new Set(resolved.flatMap(s => (s.checklist || []).map(c => c.label)))];
  const byChecklistPoint = {};
  for (const label of checklistLabels) {
    const passed = resolved.filter(s => (s.checklist || []).some(c => c.label === label && c.pass === 1));
    const failed = resolved.filter(s => (s.checklist || []).some(c => c.label === label && c.pass === 0));
    byChecklistPoint[label] = { whenPassed: winRateOf(passed), whenFailed: winRateOf(failed) };
  }

  const flagCategories = [
    "BTC trend opposes", "HTF trend", "SMT divergence", "RSI already at",
    "Repeat signal on the same zone", "Outside kill zone", "Market regime",
  ];
  const byFlag = {};
  for (const cat of flagCategories) {
    const withFlag = resolved.filter(s => (s.flags || []).some(f => f.includes(cat)));
    const withoutFlag = resolved.filter(s => !(s.flags || []).some(f => f.includes(cat)));
    byFlag[cat] = { withFlag: winRateOf(withFlag), withoutFlag: winRateOf(withoutFlag) };
  }

  const suggestions = [];
  for (const [label, data] of Object.entries(byChecklistPoint)) {
    if (data.whenPassed.reliable && data.whenFailed.reliable) {
      const gap = data.whenPassed.winRatePct - data.whenFailed.winRatePct;
      if (Math.abs(gap) >= 20) {
        suggestions.push(`Checklist point "${label}": ${gap > 0 ? "passing" : "failing"} this point correlates with a ${Math.abs(gap).toFixed(1)}pt higher win rate (${data.whenPassed.winRatePct}% vs ${data.whenFailed.winRatePct}%, n=${data.whenPassed.total}/${data.whenFailed.total}) — worth reviewing whether this point should carry more weight.`);
      }
    }
  }
  for (const [cat, data] of Object.entries(byFlag)) {
    if (data.withFlag.reliable && data.withoutFlag.reliable) {
      const gap = data.withoutFlag.winRatePct - data.withFlag.winRatePct;
      if (Math.abs(gap) >= 20) {
        suggestions.push(`Flag "${cat}": signals WITH this flag win ${data.withFlag.winRatePct}% vs ${data.withoutFlag.winRatePct}% without (n=${data.withFlag.total}/${data.withoutFlag.total}) — ${gap > 0 ? "supports current caution treatment" : "flag may be over-cautious, worth reviewing"}.`);
      }
    }
  }

  return {
    totalResolved: resolved.length,
    filterApplied: includePaper ? "real + paper combined" : "real trades only (default — safer, see HYPOTHESES.md issue #5)",
    ...(includePaper ? {
      warning: "⚠️ PAPER TRADES INCLUDED — suggestions below may be based on contaminated data. Do not act on suggestions generated with this filter without cross-checking against real-only results.",
    } : {}),
    minSampleForInsight: MIN_SAMPLE_FOR_INSIGHT,
    byChecklistPoint,
    byFlag,
    suggestions: suggestions.length ? suggestions : [`Not enough resolved signals yet for reliable insight — need at least ${MIN_SAMPLE_FOR_INSIGHT} outcomes per bucket before patterns are trustworthy. Currently ${resolved.length} total resolved.`],
    note: "This is descriptive analysis, not automatic adjustment. Scoring logic stays deterministic and manually reviewed — treat suggestions as hypotheses to evaluate, not instructions to follow blindly. Add ?includePaper=true to include paper trades (not recommended for real decisions).",
  };
}

function signalsToCSV(signals) {
  const header = ["loggedAt","symbol","type","direction","rawScore","confidence","leverage","entryZone","stopLoss","tp1","tp2","tp3","htfTrend","btcTrend","smtBias","killzone","outcome","realizedR","bingxOrderId","isPaperTrade"];
  if (!signals.length) return header.join(",") + "\n";
  const rows = signals.map(s => header.map(h => {
    const v = s[h];
    if (v === null || v === undefined) return "";
    const str = String(v).replace(/"/g, '""');
    return `"${str}"`;
  }).join(","));
  return header.join(",") + "\n" + rows.join("\n") + "\n";
}

async function sendSignalBackupToTelegram() {
  const signals = readSignalLog();
  if (!signals.length) {
    console.log("Backup skipped — no signals logged yet.");
    return;
  }
  const csv = signalsToCSV(signals);
  const boundary = "----ProveXBackup" + Date.now();
  const filename = `signals-backup-${new Date().toISOString().slice(0, 10)}.csv`;

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TELEGRAM_CHAT_ID}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n📦 Daily signal log backup — ${signals.length} total signals\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n`,
    `--${boundary}--\r\n`,
  ];
  const body = parts.join("");

  return new Promise((resolve) => {
    const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        console.log("Signal backup sent to Telegram:", res.statusCode);
        resolve();
      });
    });
    req.on("error", (err) => {
      console.error("Signal backup failed (non-fatal):", err.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

// ============================================================
// BIG-INTEGER SAFE PARSING (v17)
//
// BingX order IDs are 19-digit integers. JavaScript numbers are exact only
// to 16 digits (Number.MAX_SAFE_INTEGER = 9007199254740991), so JSON.parse
// silently rounded every order ID to the nearest multiple of 256:
//   BingX sends  2098554729454899201
//   bot stored   2098554729454899200
// Every later "did this order fill?" lookup then asked about an order that
// may not exist. BingX's own developer docs state responses MUST be parsed
// with a big-int-aware parser, not JSON.parse.
//
// Any integer of 16+ digits is converted to a string before parsing. Prices,
// quantities and 13-digit millisecond timestamps are never that long, so
// nothing else is affected. IDs stay strings end to end, which is also how
// BingX's examples pass them back.
//
// Records written before v17 already hold rounded IDs. Those cannot be
// recovered — see the UNVERIFIABLE outcome in checkOpenPositions.
// ============================================================
function parseBingXJson(text) {
  // Walk the raw text once. Outside of string literals, any integer literal
  // of 16+ digits is wrapped in quotes before JSON.parse sees it. Tracking
  // string state (including escapes) means digits inside a string are never
  // touched, and integers anywhere — object values or array elements — are.
  let out = "", i = 0, inStr = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++; continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + (ch === "-" ? 1 : 0);
      while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      const isFloat = j < n && (text[j] === "." || text[j] === "e" || text[j] === "E");
      const digits = j - i - (ch === "-" ? 1 : 0);
      if (!isFloat && digits >= 16) { out += '"' + text.slice(i, j) + '"'; i = j; continue; }
      out += text.slice(i, j); i = j; continue;
    }
    out += ch; i++;
  }
  return JSON.parse(out);
}

function bingxSign(queryString) {
  return require("crypto").createHmac("sha256", BINGX_API_SECRET).update(queryString).digest("hex");
}

async function bingxRequest(method, path, params) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const sortedKeys = Object.keys(allParams).sort();
  const rawParamString = sortedKeys.map(k => `${k}=${allParams[k]}`).join("&");
  const signature = bingxSign(rawParamString);
  const encodedParamString = sortedKeys.map(k => `${k}=${encodeURIComponent(allParams[k])}`).join("&");
  const signedString = `${encodedParamString}&signature=${signature}`;
  const fullPath = `${path}?${signedString}`;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "open-api-vst.bingx.com",
      path: fullPath,
      method,
      headers: {
        "X-BX-APIKEY": BINGX_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": 0,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        console.log(`BingX response [${res.statusCode}]:`, data.slice(0, 500));
        try {
          resolve(parseBingXJson(data));
        } catch {
          resolve({ error: "Failed to parse BingX response", statusCode: res.statusCode, raw: data });
        }
      });
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });
}

function toBingXSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.endsWith("USDT") && !symbol.includes("-")) {
    return symbol.slice(0, -4) + "-USDT";
  }
  return symbol;
}

const symbolPrecisionCache = new Map(); // bingxSymbol -> quantityPrecision (integer)

async function getQuantityPrecision(symbol) {
  if (symbolPrecisionCache.has(symbol)) return symbolPrecisionCache.get(symbol);
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/quote/contracts", {});
    const contracts = Array.isArray(res.data) ? res.data : [];
    const match = contracts.find(c => c.symbol === symbol);
    if (match && match.quantityPrecision !== undefined && match.quantityPrecision !== null) {
      const precision = parseInt(match.quantityPrecision, 10);
      if (!isNaN(precision)) {
        symbolPrecisionCache.set(symbol, precision);
        console.log(`Quantity precision for ${symbol}: ${precision} decimals (fetched from BingX contract specs)`);
        return precision;
      }
    }
    console.error(`Could not find valid contract spec for ${symbol} — falling back to 3-decimal precision (may be incorrect for this specific symbol, watch for rejected orders in logs)`);
    return 3;
  } catch (err) {
    console.error(`Failed to fetch quantity precision for ${symbol} (non-fatal, falling back to 3-decimal default):`, err.message);
    return 3;
  }
}

// ============================================================
// SELF-CALIBRATING RISK ENGINE (v19)
//
// v18 sized at a flat 1% of equity, justified by a prop-firm drawdown cap.
// That was wrong for what this bot is: a general trading system, not a
// challenge-passer. A fixed number chosen from an external rulebook has no
// business deciding how much a strategy risks.
//
// The risk fraction is now DERIVED from the bot's own resolved trades, and
// recomputed as they accumulate. Nothing about any exchange or evaluation
// programme enters the calculation.
//
// HOW THE NUMBER COMES OUT
//
// 1. Edge, measured conservatively.
//    Expectancy is an estimate, and an estimate from 40 trades is worth less
//    than the same figure from 400. So the engine uses the LOWER bound of
//    expectancy (mean minus two standard errors), not the mean. A thin edge
//    on a small sample produces a lower bound near zero — and therefore
//    near-zero risk — automatically, with no special case for "early days".
//
// 2. Kelly, from the actual return distribution.
//    For bets measured in R-multiples, the growth-optimal fraction is
//    approximately E[r] / E[r^2]. Both come from the real trade history,
//    so fat losing tails shrink the fraction on their own.
//
// 3. A fraction of Kelly, not Kelly.
//    Full Kelly maximises growth only if the edge estimate is exact, and is
//    violently volatile when it is not. Quarter-Kelly is the long-standing
//    convention for that reason, and it is what this uses. This is a
//    convention, openly chosen — but it scales WITH the measured edge rather
//    than replacing it.
//
// 4. A survival ceiling, derived from the strategy's own streakiness.
//    Losing runs are measured from the trade history, and compared against
//    the run length probability predicts for a sample this size
//    (log n / log(1/lossRate)) — the longer of the two is assumed. The
//    ceiling is then whatever fraction keeps that run inside
//    MAX_STREAK_DRAWDOWN of equity. A choppier strategy caps itself lower
//    without anyone adjusting anything.
//
// WHAT THIS MEANS IN PRACTICE
//    No proven edge        -> risk floors at RISK_FLOOR, trades stay tiny
//    Edge proven, modest   -> risk rises toward quarter-Kelly
//    Edge strong + long run of evidence -> rises further, capped by survival
//    Account grows         -> same fraction, larger absolute size (compounds)
//    Account shrinks       -> same fraction, smaller absolute size (automatic
//                             de-risking, no drawdown governor needed)
//
// The one genuinely chosen input is MAX_STREAK_DRAWDOWN: how much of the
// account you are willing to lose to a normal bad run. It is stated here,
// configurable, and its consequence is spelled out — rather than smuggled in
// as "1% because a prop firm said 10%".
// ============================================================
const KELLY_FRACTION = 0.25;
const RISK_FLOOR = 0.0025;                 // 0.25% — size while evidence is still being gathered
const MAX_STREAK_DRAWDOWN = Number(process.env.MAX_STREAK_DRAWDOWN || 0.25);
const RISK_MIN_SAMPLE = 30;

function computeRiskFraction() {
  const signals = readSignalLog();
  // v19.3: dedupe by setup first. Duplicate zone alerts were counted as
  // separate trades (137 vs 91 real setups), which made the edge look
  // proven and sized ~4x above what the honest evidence supports.
  // Filter to resolved trades BEFORE deduping, so an unresolved duplicate
  // can never hide a resolved one of the same setup.
  const closed = dedupeBySetup(signals
    .filter(s => isClosed(s.outcome) && typeof s.realizedR === "number"))
    .sort((a, b) => Date.parse(a.loggedAt) - Date.parse(b.loggedAt));
  const rs = closed.map(s => s.realizedR);
  const n = rs.length;

  if (n < RISK_MIN_SAMPLE) {
    return { fraction: RISK_FLOOR, n, reason: `only ${n}/${RISK_MIN_SAMPLE} resolved trades — risk held at the floor until there is enough evidence to size on` };
  }

  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const edgeLow = mean - 2 * se;                 // conservative end of the estimate
  const meanSq = rs.reduce((a, b) => a + b * b, 0) / n;

  if (!(edgeLow > 0) || !(meanSq > 0)) {
    return { fraction: RISK_FLOOR, n, mean, edgeLow,
      reason: `expectancy ${mean.toFixed(3)}R is not distinguishable from zero at this sample size (lower bound ${edgeLow.toFixed(3)}R) — risk held at the floor` };
  }

  const kelly = edgeLow / meanSq;
  let fraction = KELLY_FRACTION * kelly;

  // Survival ceiling from observed and predicted losing runs.
  let run = 0, longest = 0;
  for (const r of rs) { run = r < 0 ? run + 1 : 0; if (run > longest) longest = run; }
  const lossRate = rs.filter(r => r < 0).length / n;
  const predicted = lossRate > 0 && lossRate < 1
    ? Math.log(n) / Math.log(1 / lossRate) : longest;
  const assumedStreak = Math.max(longest, Math.ceil(predicted), 1);
  const ceiling = 1 - Math.pow(1 - MAX_STREAK_DRAWDOWN, 1 / assumedStreak);

  let cappedBy = null;
  if (fraction > ceiling) { fraction = ceiling; cappedBy = "survival ceiling"; }
  if (fraction < RISK_FLOOR) { fraction = RISK_FLOOR; cappedBy = "floor"; }

  return {
    fraction, n, mean, edgeLow, kelly, assumedStreak, ceiling, lossRate, cappedBy,
    reason: cappedBy === "survival ceiling"
      ? `quarter-Kelly wanted ${(KELLY_FRACTION * kelly * 100).toFixed(2)}%, capped at ${(ceiling * 100).toFixed(2)}% so a ${assumedStreak}-loss run costs at most ${(MAX_STREAK_DRAWDOWN * 100).toFixed(0)}% of equity`
      : cappedBy === "floor"
        ? `computed fraction below the floor — held at ${(RISK_FLOOR * 100).toFixed(2)}%`
        : `quarter-Kelly on ${n} trades (expectancy ${mean.toFixed(3)}R, conservative bound ${edgeLow.toFixed(3)}R)`,
  };
}

// ============================================================
// POSITION SIZING
//
// Replaces fixed 900 / 2000 VST margins. Two reasons:
//
// 1. The old tiers were BACKWARDS. HIGH confidence averaged -0.121R over 57
//    trades and MEDIUM +0.149R over 303, so the bot was sizing its worst
//    trades largest. Confidence is no longer used for sizing at all.
//
// 2. Fixed margins cannot compound. At 900 VST the bot risks the same amount
//    whether the account holds 90k or 900k, so growth never feeds back into
//    position size.
//
// Now: risk a constant FRACTION of equity per trade. Because the stop is a
// fixed 5%, required notional follows directly:
//
//     risk    = equity x riskFraction (see the risk engine above)
//     notional = risk / FIXED_SL_PCT
//     margin   = notional / LEVERAGE
//
// WHY 1.0% AND NOT MORE. The prop-firm cap is 10% max drawdown. At the
// observed ~44% win rate, runs of 7-8 consecutive losses occur regularly in
// a few hundred trades. At 1.0% that is a 7-8% drawdown — inside the cap
// with room to spare. At 1.5% the same run breaches it. Raising this number
// does not improve expectancy; it only moves the account closer to the line
// that ends the evaluation.
//
// Sizing has no effect on expectancy measured in R, so changing it does not
// contaminate the HTF filter test running alongside it.
// ============================================================
const SIZING_LEVERAGE = 10;
const MAX_MARGIN_FRACTION = 0.5;   // never commit more than half of free margin to one trade
const FALLBACK_MARGIN = 900;       // the old MEDIUM size, used only if equity cannot be read

let equityCache = { equity: null, available: null, at: 0 };
const EQUITY_TTL_MS = 60000;

async function getAccountEquity() {
  if (equityCache.equity && Date.now() - equityCache.at < EQUITY_TTL_MS) return equityCache;
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/user/balance", {});
    const b = res?.data?.balance ?? res?.data;
    const equity = parseFloat(b?.equity ?? b?.balance);
    const available = parseFloat(b?.availableMargin ?? b?.balance ?? equity);
    if (equity > 0) {
      equityCache = { equity, available: available > 0 ? available : equity, at: Date.now() };
      return equityCache;
    }
    console.error("Equity lookup returned no usable figure:", JSON.stringify(res).slice(0, 200));
  } catch (err) {
    console.error("Equity lookup failed (non-fatal):", err.message);
  }
  return { equity: null, available: null, at: 0 };
}

async function computeBingXSizing() {
  const { equity, available } = await getAccountEquity();
  if (!equity) {
    // Fail SMALL, not large: an unreadable balance must never size up.
    console.error(`Sizing fell back to ${FALLBACK_MARGIN} margin — equity unavailable.`);
    return { marginUSDT: FALLBACK_MARGIN, leverage: SIZING_LEVERAGE,
             riskVST: FALLBACK_MARGIN * SIZING_LEVERAGE * FIXED_SL_PCT, equity: null, sizedBy: "fallback" };
  }
  const rf = computeRiskFraction();
  const risk = equity * rf.fraction;
  const notional = risk / FIXED_SL_PCT;
  let margin = notional / SIZING_LEVERAGE;
  const cap = available * MAX_MARGIN_FRACTION;
  let capped = false;
  if (margin > cap) { margin = cap; capped = true; }
  return {
    marginUSDT: Number(margin.toFixed(2)),
    leverage: SIZING_LEVERAGE,
    riskVST: Number((margin * SIZING_LEVERAGE * FIXED_SL_PCT).toFixed(2)),
    equity: Number(equity.toFixed(2)),
    riskPct: Number((rf.fraction * 100).toFixed(3)),
    sizedBy: capped
      ? `capped by free margin (wanted ${(rf.fraction * 100).toFixed(2)}% of equity)`
      : `${(rf.fraction * 100).toFixed(2)}% of equity — ${rf.reason}`,
  };
}

function confidenceEmoji(confidence, rawScore) {
  if (confidence === "HIGH" && rawScore === 5) return "🟢";
  if (confidence === "HIGH") return "🟠";
  return "🔴";
}

// v19.1 — Hedge Mode position check.
// The old rule blocked ANY open position on the symbol, including the
// opposite side, even though Hedge Mode keeps LONG and SHORT independent.
// That starved fills (1 of 36 Sep trades was real). Now:
//   - same symbol + same side  -> still blocked (no stacking duplicate zones)
//   - opposite side            -> allowed
//   - total open risk across ALL positions capped at
//     OPEN_RISK_MULT x the engine's current per-trade risk
// Open risk of an existing position = notional x FIXED_SL_PCT (the fixed
// 5% stop). Opposite sides are summed, not netted — conservative on purpose.
const OPEN_RISK_MULT = Number(process.env.OPEN_RISK_MULT || 2);

async function getOpenPositions() {
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/user/positions", {});
    if (Array.isArray(res.data)) {
      const live = res.data.filter(p => Math.abs(parseFloat(p.positionAmt ?? 0)) > 0);
      console.log(`BingX positions: ${live.length ? live.map(p => `${p.symbol} ${p.positionSide} ${p.positionAmt} @${p.avgPrice} uPnL ${p.unrealizedProfit}`).join(" | ") : "none"}`);
    } else {
      console.log("BingX position check returned:", JSON.stringify(res).slice(0, 300));
    }
    if (!Array.isArray(res.data)) throw new Error("positions response had no data array");
    const positions = res.data
      .map(p => {
        const amt = Math.abs(parseFloat(p.positionAmt ?? p.positionAmount ?? 0));
        const price = parseFloat(p.avgPrice ?? p.entryPrice ?? p.markPrice ?? 0);
        return {
          symbol: p.symbol,
          direction: p.positionSide === "SHORT" ? "Short" : "Long",
          amt,
          openRiskVST: amt * price * FIXED_SL_PCT,
        };
      })
      .filter(p => p.amt > 0);
    return { checked: true, positions };
  } catch (err) {
    console.error("Position check failed (non-fatal, failing closed):", err.message);
    return { checked: false, positions: [] };
  }
}

// ============================================================
// SAFETY NETS (v19.5)
//
// 1. KILL SWITCH — if account equity falls KILL_SWITCH_DD (default 15%)
//    below its recorded peak, no new trades are opened until re-armed.
//    Open positions keep their own stops; nothing is force-closed.
//    Re-arm: change the Railway variable KILL_SWITCH_RESET to any new
//    value — the peak then resets to current equity.
//
// 2. STOP WATCHDOG — every 15 minutes, every open BingX position must
//    have a live stop-loss order. This exists because two orphan
//    positions ran unmanaged for weeks (Sep 2026). It never trades —
//    it only alerts (at most once per 6h per position).
// ============================================================
const KILL_SWITCH_DD = Number(process.env.KILL_SWITCH_DD || 0.15);
const KILL_SWITCH_RESET = process.env.KILL_SWITCH_RESET || "";
const PEAK_FILE = path.join(DATA_DIR, "equity_peak.json");

async function killSwitchCheck() {
  const { equity } = await getAccountEquity();
  if (!equity) return { tripped: false, reason: "equity unavailable" };
  let st = {};
  try { st = JSON.parse(fs.readFileSync(PEAK_FILE, "utf8")); } catch {}
  if (!st.peak || st.resetToken !== KILL_SWITCH_RESET) st = { peak: equity, resetToken: KILL_SWITCH_RESET, since: new Date().toISOString() };
  if (equity > st.peak) st.peak = equity;
  fs.writeFileSync(PEAK_FILE, JSON.stringify(st));
  const dd = 1 - equity / st.peak;
  return { tripped: dd >= KILL_SWITCH_DD, equity, peak: st.peak, dd };
}

const stopAlertAt = {};
async function stopWatchdog() {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;
  const pos = await getOpenPositions();
  if (!pos.checked || !pos.positions.length) return;
  let orders;
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/trade/openOrders", {});
    orders = res?.data?.orders;
    if (!Array.isArray(orders)) { console.error("Stop watchdog: openOrders returned no list:", JSON.stringify(res).slice(0, 200)); return; }
  } catch (err) { console.error("Stop watchdog failed (non-fatal):", err.message); return; }
  const unprotected = pos.positions.filter(p => {
    const side = p.direction === "Short" ? "SHORT" : "LONG";
    return !orders.some(o => o.symbol === p.symbol && o.positionSide === side
      && /STOP/.test(o.type || "") && !/TAKE_PROFIT/.test(o.type || ""));
  });
  console.log(`Stop watchdog: ${pos.positions.length} position(s), ${unprotected.length} without a stop`);
  for (const p of unprotected) {
    const key = `${p.symbol}|${p.direction}`;
    if (stopAlertAt[key] && Date.now() - stopAlertAt[key] < 6 * 3600 * 1000) continue;
    stopAlertAt[key] = Date.now();
    await sendTelegram(`🚨 <b>Position with NO stop-loss</b>\n${p.symbol} ${p.direction}, size ${p.amt}\nNothing is protecting this position. Set a stop in the BingX app or close it.`);
  }
}

// v20: v19 is paper-only by default (3-year replay: ~breakeven). Signals are
// still logged and paper-resolved. Turn demo orders back on with V19_EXECUTE=on.
const V19_EXECUTE = (process.env.V19_EXECUTE || "off") === "on";

// 🎰 AGGRO MODE (v20.3, DEMO EXPERIMENT) — Krysie's request: trade the v19
// key-level entries with a big, compounding position on a SEPARATE virtual
// budget. Each trade risks AGGRO_RISK of the aggro balance (0.5 = 50%, i.e.
// a position ~10x the budget at the 5% stop, on 10x leverage).
// Research before launch (v19 replay R distribution, 30 trades, 20k sims):
//   risk 50%: hit 5x at some point 11% | end down 50%+ 83% | busted 70%
//   risk 20%: hit 5x 1.4% | end down 50%+ 41% | busted 2%
// It stops itself when its balance falls below 10% of the starting budget.
// It does not touch Core mode's budget. Off switch: AGGRO=off.
const AGGRO = (process.env.AGGRO || "on") === "on";
const AGGRO_BUDGET = Number(process.env.AGGRO_BUDGET || 20000);
const AGGRO_RISK = Math.min(0.5, Math.max(0.01, Number(process.env.AGGRO_RISK || 0.5)));
const AGGRO_FILE = path.join(DATA_DIR, "aggro_state.json");
function readAggro() {
  try { return JSON.parse(fs.readFileSync(AGGRO_FILE, "utf8")); }
  catch { return { start: AGGRO_BUDGET, balance: AGGRO_BUDGET, peak: AGGRO_BUDGET, trades: 0, wins: 0, busted: false, startedAt: new Date().toISOString() }; }
}
function writeAggro(a) { fs.writeFileSync(AGGRO_FILE, JSON.stringify(a)); }
async function settleAggro(sig) {
  if (!sig.aggro || typeof sig.realizedR !== "number" || !sig.riskVST) return;
  const a = readAggro();
  const pnl = sig.riskVST * sig.realizedR;
  a.balance = +(a.balance + pnl).toFixed(2); a.trades += 1; if (sig.realizedR > 0) a.wins += 1;
  a.peak = Math.max(a.peak, a.balance);
  if (a.balance < a.start * 0.1) a.busted = true;
  writeAggro(a);
  await sendTelegram(`🎰 <b>Aggro trade closed</b> (demo)\n${sig.symbol} ${sig.direction}: ${sig.realizedR > 0 ? "+" : ""}${sig.realizedR}R = ${pnl > 0 ? "+" : ""}${pnl.toFixed(0)} VST\nAggro balance: ${a.balance.toFixed(0)} VST (${((a.balance / a.start - 1) * 100).toFixed(0)}% from start) │ ${a.wins}W / ${a.trades - a.wins}L${a.busted ? "\n💀 Below 10% of the starting budget, aggro mode has stopped." : ""}`);
}

async function executeOnBingX(decision, payload) {
  if (!V19_EXECUTE && !AGGRO) { console.log(`v19 paper-only: ${payload.symbol || "—"} signal logged, no order placed`); return; }
  if (AGGRO) {
    const a = readAggro();
    if (a.busted || a.balance < a.start * 0.1) { console.log("Aggro mode busted — no order placed"); return; }
  }
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;

  try {
    const { scoreResult, gated, levels } = decision;
    const symbol = toBingXSymbol(payload.symbol);
    const direction = scoreResult.direction;

    const ks = AGGRO ? { tripped: false } : await killSwitchCheck();   // aggro has its own bust rule
    if (ks.tripped) {
      console.log(`Kill switch: equity ${ks.equity.toFixed(2)} is ${(ks.dd * 100).toFixed(1)}% below peak ${ks.peak.toFixed(2)} — no new trades`);
      await sendTelegram(`🛑 <b>Kill switch active</b>\nEquity ${ks.equity.toFixed(0)} is ${(ks.dd * 100).toFixed(1)}% below its peak (${ks.peak.toFixed(0)}). New ${symbol} ${direction} not placed.\nRe-arm by changing KILL_SWITCH_RESET in Railway.`);
      return;
    }

    const positionCheck = await getOpenPositions();
    if (!positionCheck.checked) {
      await sendTelegram(`⚠️ <b>BingX execution skipped</b>\nSymbol: ${symbol}\nCould not verify current positions (failing closed) — trade not placed.`);
      return;
    }

    const sameSide = positionCheck.positions.find(p => p.symbol === symbol && p.direction === direction);
    if (sameSide) {
      console.log(`Skipping ${symbol} ${direction} — ${direction} already open on this symbol (same-side rule)`);
      await sendTelegram(`🔕 <b>BingX execution skipped</b>\nSymbol: ${symbol}\nSignal: ${direction}, but a ${direction} position is already open. Same-side stacking is blocked; opposite side would be allowed.`);
      return;
    }

    const positionSide = direction === "Short" ? "SHORT" : "LONG";
    const entrySide = direction === "Short" ? "SELL" : "BUY";
    const exitSide = direction === "Short" ? "BUY" : "SELL";

    const sizing = await computeBingXSizing();
    if (AGGRO && sizing.equity) {
      const a = readAggro();
      const { available } = await getAccountEquity();
      const aggroRisk = a.balance * AGGRO_RISK;
      let margin = (aggroRisk / FIXED_SL_PCT) / SIZING_LEVERAGE;
      const cap = (available || 0) * MAX_MARGIN_FRACTION;
      if (margin > cap) margin = cap;
      sizing.marginUSDT = Number(margin.toFixed(2));
      sizing.riskVST = Number((margin * SIZING_LEVERAGE * FIXED_SL_PCT).toFixed(2));
      sizing.riskPct = Number((sizing.riskVST / sizing.equity * 100).toFixed(3));
      sizing.sizedBy = `🎰 AGGRO: ${(AGGRO_RISK * 100).toFixed(0)}% of aggro balance ${a.balance.toFixed(0)} VST`;
    }
    const { marginUSDT, leverage, riskVST } = sizing;

    // Combined open-risk cap. Based on the INTENDED per-trade risk
    // (equity x fraction), not the margin-capped riskVST, so a squeezed
    // trade can't loosen the cap.
    const openRiskVST = positionCheck.positions.reduce((a, p) => a + p.openRiskVST, 0);
    const intendedRiskVST = sizing.equity ? sizing.equity * (sizing.riskPct / 100) : riskVST;
    const openRiskCap = OPEN_RISK_MULT * intendedRiskVST;
    if (openRiskVST + riskVST > openRiskCap) {
      console.log(`Skipping ${symbol} ${direction} — open-risk cap: ${openRiskVST.toFixed(2)} open + ${riskVST} new > ${openRiskCap.toFixed(2)} cap (${OPEN_RISK_MULT}x per-trade)`);
      await sendTelegram(`🔕 <b>BingX execution skipped</b>\nSymbol: ${symbol} ${direction}\nOpen risk ${openRiskVST.toFixed(2)} VST + this trade ${riskVST} VST would exceed the cap of ${openRiskCap.toFixed(2)} VST (${OPEN_RISK_MULT}x per-trade risk).`);
      return;
    }
    console.log(`Sizing: ${marginUSDT} VST margin x ${leverage}x = ${(marginUSDT * leverage).toFixed(0)} notional, risking ${riskVST} VST (${sizing.sizedBy}, equity ${sizing.equity ?? "unknown"})`);
    const entryPrice = levels.entryMidRaw;
    if (!entryPrice || entryPrice <= 0) {
      console.error("BingX execution skipped — invalid entry price", entryPrice);
      return;
    }
    const notional = marginUSDT * leverage;

    const qtyPrecision = await getQuantityPrecision(symbol);
    const quantity = Number((notional / entryPrice).toFixed(qtyPrecision));

    const leverageRes = await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", {
      symbol, side: positionSide, leverage,
    });
    console.log("BingX set leverage:", JSON.stringify(leverageRes));

    const entryRes = await bingxRequest("POST", "/openApi/swap/v2/trade/order", {
      symbol,
      side: entrySide,
      positionSide,
      type: "MARKET",
      quantity,
      stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: levels.slRaw, price: levels.slRaw }),
    });
    console.log("BingX entry order:", JSON.stringify(entryRes));

    if (entryRes.error || entryRes.code !== 0) {
      await sendTelegram(`⚠️ <b>BingX execution failed</b>\nSymbol: ${symbol}\n${JSON.stringify(entryRes).slice(0, 300)}`);
      return;
    }

    const tp1Qty = Number((quantity * 0.4).toFixed(qtyPrecision));
    const tp2Qty = Number((quantity * 0.3).toFixed(qtyPrecision));
    const tp3Qty = Number((quantity - tp1Qty - tp2Qty).toFixed(qtyPrecision));

    const tpTargets = [
      { price: levels.tp1Raw ?? null, qty: tp1Qty, label: "TP1" },
      { price: levels.tp2Raw ?? null, qty: tp2Qty, label: "TP2" },
      { price: levels.tp3Raw ?? null, qty: tp3Qty, label: "TP3" },
    ];

    const tpResults = [];
    const tpOrderIds = {};
    for (const tp of tpTargets) {
      if (!tp.price || tp.price <= 0) { tpResults.push(`${tp.label}: skipped (no price)`); continue; }
      const res = await bingxRequest("POST", "/openApi/swap/v2/trade/order", {
        symbol,
        side: exitSide,
        positionSide,
        type: "LIMIT",
        quantity: tp.qty,
        price: tp.price,
        // v19.2: NO reduceOnly. In Hedge Mode BingX rejects it (code 109400)
        // and every TP silently failed — positionSide + opposite side already
        // makes this a closing order. Live trades were running SL-only.
      });
      tpResults.push(`${tp.label}: ${res.code === 0 ? "placed" : JSON.stringify(res).slice(0, 100)}`);
      const tpOrderId = res.data?.order?.orderId ?? res.orderId ?? null;
      if (tpOrderId) tpOrderIds[tp.label] = tpOrderId;
    }

    const tpFailed = tpResults.filter(r => !r.endsWith("placed") && !r.includes("skipped"));
    if (tpFailed.length) {
      console.error(`⚠️ TP PLACEMENT FAILED on ${symbol} ${direction}:`, tpFailed);
      await sendTelegram(`🚨 <b>TP placement FAILED</b>\n${symbol} ${direction} is open with SL only.\n${tpFailed.join("\n")}\nPlace TPs manually.`);
    }
    await sendTelegram(`${confidenceEmoji(gated.confidence, scoreResult.rawScore)} <b>BingX demo execution</b>\n${symbol} ${direction} │ ${marginUSDT} VST margin │ ${leverage}x\nRisking ${riskVST} VST (${sizing.sizedBy})\nQty: ${quantity}\n${tpResults.join("\n")}`);
    console.log("BingX execution complete", symbol, direction, "| TP results:", tpResults);
    return { bingxOrderId: entryRes.data?.order?.orderId ?? entryRes.orderId ?? null, bingxSymbol: symbol, tpOrderIds, riskVST, marginUSDT, leverageUsed: leverage, aggro: AGGRO };
  } catch (err) {
    console.error("BingX execution error (non-fatal):", err.message);
    try { await sendTelegram(`⚠️ <b>BingX execution error:</b> ${err.message}`); } catch {}
    return null;
  }
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function bool(v) { return v === true || v === "true"; }

const recentSignals = new Map();
const DEDUP_WINDOW_MS = 30000;

function isDuplicateSignal(payload) {
  const key = `${payload.symbol || ""}|${payload.condition || ""}|${payload.price || ""}`;
  const now = Date.now();
  const last = recentSignals.get(key);
  if (recentSignals.size > 500) recentSignals.clear();
  recentSignals.set(key, now);
  if (last && (now - last) < DEDUP_WINDOW_MS) return true;
  return false;
}

const recentZones = new Map();
const ZONE_COOLDOWN_MS = 60 * 60 * 1000;

function checkZoneCooldown(payload, direction) {
  const zoneTop = direction === "Short" ? payload.obTop : payload.pobTop;
  const zoneBottom = direction === "Short" ? payload.obBottom : payload.pobBottom;
  const key = `${payload.symbol || ""}|${direction}|${zoneTop}|${zoneBottom}`;
  const now = Date.now();
  if (recentZones.size > 500) recentZones.clear();

  const existing = recentZones.get(key);
  if (existing && (now - existing.firstSeen) < ZONE_COOLDOWN_MS) {
    existing.count += 1;
    recentZones.set(key, existing);
    return { isRepeat: true, count: existing.count };
  }
  recentZones.set(key, { count: 1, firstSeen: now });
  return { isRepeat: false, count: 1 };
}

const signalHistory = [];
const MAX_HISTORY = 50;

function recordSignal(decision, payload, reasoning) {
  signalHistory.unshift({
    timestamp: new Date().toISOString(),
    payload,
    decision,
    reasoning,
  });
  if (signalHistory.length > MAX_HISTORY) signalHistory.length = MAX_HISTORY;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function classifySignal(condition) {
  if (condition.includes("OB_SHORT_SWING_ELIGIBLE_CONFIRMED"))
    return "OB_SWING_SHORT";
  if (condition.includes("POB_LONG_SWING_ELIGIBLE_CONFIRMED"))
    return "OB_SWING_LONG";
  if (condition.includes("OB_SHORT_REJECTION_CONFIRMED") || condition === "KILLZONE_OB_SHORT_HIGH_PRIORITY")
    return "OB_SHORT";
  if (condition.includes("POB_LONG_REJECTION_CONFIRMED") || condition === "KILLZONE_POB_LONG_HIGH_PRIORITY")
    return "OB_LONG";
  if (condition.includes("BREAKOUT_SHORT_CONFIRMED"))
    return "BREAKOUT_SHORT";
  if (condition.includes("BREAKOUT_LONG_CONFIRMED"))
    return "BREAKOUT_LONG";
  return null;
}

function scoreBTC(payload, direction) {
  const btcTrend = payload.btcTrend || "Unknown";
  const btcDelta = num(payload.btcDelta);
  const matches  = (direction === "Short" && btcTrend === "Bearish") || (direction === "Long" && btcTrend === "Bullish");
  const opposes  = (direction === "Short" && btcTrend === "Bullish") || (direction === "Long" && btcTrend === "Bearish");

  if (opposes) return { score: 0, detail: `BTC trend ${btcTrend} opposes ${direction}`, opposes: true };
  if (btcTrend === "Neutral") return { score: 0.5, detail: "BTC trend neutral", opposes: false };
  if (matches) return { score: 1, detail: `BTC trend ${btcTrend} confirms ${direction}, delta ${btcDelta}`, opposes: false };
  return { score: 0, detail: "BTC trend data missing/unknown", opposes: true };
}

function scoreOB(payload, direction) {
  const obTop    = direction === "Short" ? num(payload.obTop)    : num(payload.pobTop);
  const obBottom = direction === "Short" ? num(payload.obBottom) : num(payload.pobBottom);
  const swingRef = direction === "Short" ? num(payload.swingHigh) : num(payload.swingLow);
  const cumDelta = num(payload.cumDelta);
  const mssDir   = payload.mssDir;
  const mitigated = direction === "Short" ? bool(payload.obMitigated) : bool(payload.pobMitigated);

  const points = [];

  const p1 = direction === "Short"
    ? (obTop > 0 && swingRef > obTop)
    : (obBottom > 0 && swingRef > 0 && swingRef < obBottom);
  points.push({ n: 1, label: "Liquidity sweep", pass: p1 ? 1 : 0,
    detail: p1 ? `Swing ${direction === "Short" ? "high" : "low"} $${swingRef} confirms sweep beyond OB` : "No confirmed sweep beyond OB" });

  const p2 = direction === "Short" ? cumDelta < -50000 : cumDelta > 50000;
  points.push({ n: 2, label: "Delta flip", pass: p2 ? 1 : 0, detail: `cumDelta ${cumDelta}` });

  const p3 = (direction === "Short" && mssDir === "Down") || (direction === "Long" && mssDir === "Up");
  points.push({ n: 3, label: "MSS confirmed", pass: p3 ? 1 : 0, detail: `mssDir=${mssDir}` });

  const btc = scoreBTC(payload, direction);
  points.push({ n: 4, label: "BTC confirmation", pass: btc.score, detail: btc.detail });

  const p5 = !mitigated && obTop > 0 && obBottom > 0;
  points.push({ n: 5, label: "OB retest holding", pass: p5 ? 1 : 0,
    detail: mitigated ? "OB mitigated — zone is dead" : "Rejection confirmed by alert trigger" });

  const rawScore = points.reduce((sum, p) => sum + p.pass, 0);
  return { points, rawScore, direction, mitigated, btcOpposes: btc.opposes, structureOk: !mitigated && obTop > 0 && obBottom > 0 };
}

function scoreBreakout(payload, direction) {
  const origin    = num(payload.boImpulseOrigin);
  const zoneTop   = num(payload.boZoneTop);
  const zoneBottom = num(payload.boZoneBottom);
  const cumDelta  = num(payload.cumDelta);
  const hasStructure = origin > 0 && zoneTop > 0 && zoneBottom > 0;

  const points = [];
  points.push({ n: 1, label: "Displacement occurred", pass: hasStructure ? 1 : 0,
    detail: hasStructure ? "Confirmed by alert trigger (MSS + volume spike)" : "Missing impulse leg data" });
  points.push({ n: 2, label: "Pullback held in zone", pass: hasStructure ? 1 : 0,
    detail: hasStructure ? `Held within $${zoneBottom}-$${zoneTop}` : "Missing zone data" });
  points.push({ n: 3, label: "Rejection candle confirmed", pass: hasStructure ? 1 : 0,
    detail: "Confirmed by alert trigger" });

  const btc = scoreBTC(payload, direction);
  points.push({ n: 4, label: "BTC confirmation", pass: btc.score, detail: btc.detail });

  const p5 = direction === "Short" ? cumDelta < 0 : cumDelta > 0;
  points.push({ n: 5, label: "Delta still supports continuation", pass: p5 ? 1 : 0, detail: `cumDelta ${cumDelta}` });

  const rawScore = points.reduce((sum, p) => sum + p.pass, 0);
  return { points, rawScore, direction, mitigated: false, btcOpposes: btc.opposes, structureOk: hasStructure };
}

function checkSMT(payload, direction) {
  const smt = payload.smtBias || "None";
  if (smt === "None") return null;
  const opposes  = (direction === "Short" && smt === "Bullish") || (direction === "Long" && smt === "Bearish");
  const supports = (direction === "Short" && smt === "Bearish") || (direction === "Long" && smt === "Bullish");
  if (opposes)  return { severity: "caution", text: `${smt} SMT divergence present — early reversal warning against this ${direction.toLowerCase()} (validated lesson, not a soft suggestion)` };
  if (supports) return { severity: "confluence", text: `${smt} SMT divergence adds confluence for this ${direction.toLowerCase()}` };
  return null;
}

function checkRSIExhaustion(payload, direction) {
  const rsi = num(payload.rsi);
  if (rsi <= 0) return null;
  if (direction === "Short" && rsi < 35) return `RSI already at ${rsi} — oversold territory, down-move may be exhausted (absorption risk, don't lean on delta alone)`;
  if (direction === "Long" && rsi > 65) return `RSI already at ${rsi} — overbought territory, up-move may be exhausted (absorption risk, don't lean on delta alone)`;
  return null;
}

function applyRiskGates(payload, scoreResult, killzoneActive, isSwing = false, isBreakout = false) {
  const { rawScore, direction, mitigated, btcOpposes, structureOk } = scoreResult;

  if (mitigated) return { verdict: "NO_TRADE", reason: "OB mitigated — zone is dead, no exceptions" };
  if (!structureOk) return { verdict: "NO_TRADE", reason: "Missing structural data — cannot place a real stop" };
  if (btcOpposes) return { verdict: "NO_TRADE", reason: "BTC trend opposes signal direction — blocked entirely (hard rule, per Krysie's decision after the 2026-08-13 SUI/ETH shorts both went against BTC trend and moved into loss)" };

  const threshold = killzoneActive ? 3.5 : 4;
  if (rawScore < threshold) {
    return { verdict: "NO_TRADE", reason: `Score ${rawScore}/5 below ${threshold} threshold (killzone active: ${killzoneActive})` };
  }

  let confidence = rawScore >= 4 ? "HIGH" : "MEDIUM";
  let leverage = isSwing
    ? (confidence === "HIGH" ? (rawScore === 5 ? "50x-70x" : "30x-50x") : "30x-40x")
    : (confidence === "HIGH" ? (rawScore === 5 ? "12x-15x" : "8x-12x") : "5x-8x");
  const floorLeverage = isSwing ? "30x-40x" : "5x-8x";

  const flags = [];
  const htfTrend  = payload.htfTrend || "Unknown";
  const htfOpposes = (direction === "Short" && htfTrend === "Bullish") || (direction === "Long" && htfTrend === "Bearish");
  const htfKnown  = htfTrend === "Bullish" || htfTrend === "Bearish";

  // ============================================================
  // HTF FILTER (v18) — the direction of this rule is REVERSED from v17.
  //
  // Evidence, re-scored from candles across 360 logged OB signals with the
  // live ladder:
  //
  //     HTF opposes the signal   +0.315R   n=161
  //     HTF aligns with it       -0.063R   n=199
  //
  // The gap held under stratification by session (kill zone and outside),
  // by direction (longs and shorts separately), and across every time
  // period the sample was split into. Confidence tiers turned out to be
  // this same effect relabelled, since v17 forced opposing trades down to
  // MEDIUM — which is why "HIGH confidence" measured worse than MEDIUM.
  //
  // Mechanically this fits: OB is a mean-reversion setup. Taken WITH the
  // higher-timeframe trend it fades nothing; taken AGAINST it, it fades an
  // extended move, which is the setup's actual premise.
  //
  // KNOWN WEAKNESS, recorded rather than hidden: the whole sample sits
  // inside one rising market (SUI roughly 0.67 -> 1.26, 4H trend bullish
  // 71% of the time). Most of the profit came from HTF-opposing LONGS,
  // which in a rally is dip buying. A sustained downtrend has never been
  // observed in this data, and the same logic would then be catching
  // falling knives. This filter is a hypothesis under live test, not a
  // settled rule — if a real downtrend arrives, re-check it before trusting
  // it.
  // ============================================================
  if (htfKnown && !htfOpposes) {
    return { verdict: "NO_TRADE", reason: `HTF trend (${htfTrend}) aligns with the ${direction.toLowerCase()} — these averaged -0.063R over 199 logged signals while counter-trend ones averaged +0.315R. Blocked pending the live test of that finding.` };
  }
  if (htfOpposes) {
    flags.push(`HTF trend (${htfTrend}) opposes signal direction — this is the condition being tested, no longer penalised (v18)`);
  }
  if (!htfKnown) {
    flags.push(`HTF trend unknown — cannot apply the counter-trend filter, trade allowed but unclassified`);
  }

  const smtCheck = checkSMT(payload, direction);
  if (smtCheck) {
    if (smtCheck.severity === "caution") {
      confidence = "MEDIUM";
      if (leverage !== floorLeverage) leverage = floorLeverage;
    }
    flags.push(smtCheck.text);
  }

  const rsiCaution = checkRSIExhaustion(payload, direction);
  if (rsiCaution) flags.push(rsiCaution);

  if (isSwing) {
    flags.push(`Swing signal — 1H structure agreement confirmed, wider R-multiple targets apply (see TP ladder)`);
  }
  if (!killzoneActive) flags.push("Outside kill zone — fakeout risk elevated");

  const regime = payload.marketRegime || "Unknown";
  if (!isBreakout && regime === "Trending") {
    flags.push(`Market regime: Trending (ADX ${payload.adxValue || "?"}) — this is a mean-reversion (OB) setup firing against a strong trend, informational only (H-005, unvalidated)`);
  }
  if (isBreakout && regime === "Choppy") {
    flags.push(`Market regime: Choppy (ADX ${payload.adxValue || "?"}) — breakout/continuation setups are more prone to failure without real trend backing, informational only (H-005, unvalidated)`);
  }

  const topOfBand = parseInt(leverage.split("-")[1], 10);
  if (topOfBand > 40) flags.push("Leverage range extends above 40x — a small adverse wick can liquidate before SL triggers, size accordingly");

  return { verdict: "TRADE", confidence, leverage, flags, rawScore };
}

function fmt(n) { return `$${n.toFixed(4)}`; }

function snapToStructure(direction, floorLevel, nextFloorLevel, candidates) {
  const valid = candidates.filter(c => c > 0);
  if (direction === "Short") {
    const inZone = valid.filter(c => c <= floorLevel && c > nextFloorLevel);
    return inZone.length ? Math.max(...inZone) : floorLevel;
  } else {
    const inZone = valid.filter(c => c >= floorLevel && c < nextFloorLevel);
    return inZone.length ? Math.min(...inZone) : floorLevel;
  }
}

function computeSwingLevels(payload, direction) {
  if (direction === "Short") {
    const obTop = num(payload.obTop), obBottom = num(payload.obBottom);
    const swingLow1h = num(payload.swingLow1h);
    const obHeight = obTop - obBottom;
    const sl = obTop + obHeight * 1.5;
    const entryMid = (obTop + obBottom) / 2;
    const risk = sl - entryMid;

    const tp1Floor = entryMid - risk * 3;
    const tp2Floor = entryMid - risk * 5;
    const tp3Floor = entryMid - risk * 8;

    const tp1Candidates = [num(payload.pobTop), num(payload.pobBottom), num(payload.swingLow)];
    const tp1 = snapToStructure("Short", tp1Floor, tp2Floor, tp1Candidates);

    const tp2Candidates = [num(payload.swingLow), swingLow1h];
    const tp2 = snapToStructure("Short", tp2Floor, tp3Floor, tp2Candidates);

    const tp3 = (swingLow1h > 0 && swingLow1h < tp2) ? swingLow1h : tp3Floor;

    return { entryZone: `${fmt(obBottom)}-${fmt(obTop)}`, stopLoss: fmt(sl), tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3), entryMidRaw: entryMid, slRaw: sl, tp1Raw: tp1, tp2Raw: tp2, tp3Raw: tp3, riskRaw: risk };
  } else {
    const obTop = num(payload.pobTop), obBottom = num(payload.pobBottom);
    const swingHigh1h = num(payload.swingHigh1h);
    const obHeight = obTop - obBottom;
    const sl = obBottom - obHeight * 1.5;
    const entryMid = (obTop + obBottom) / 2;
    const risk = entryMid - sl;

    const tp1Floor = entryMid + risk * 3;
    const tp2Floor = entryMid + risk * 5;
    const tp3Floor = entryMid + risk * 8;

    const tp1Candidates = [num(payload.obTop), num(payload.obBottom), num(payload.swingHigh)];
    const tp1 = snapToStructure("Long", tp1Floor, tp2Floor, tp1Candidates);

    const tp2Candidates = [num(payload.swingHigh), swingHigh1h];
    const tp2 = snapToStructure("Long", tp2Floor, tp3Floor, tp2Candidates);

    const tp3 = (swingHigh1h > 0 && swingHigh1h > tp2) ? swingHigh1h : tp3Floor;

    return { entryZone: `${fmt(obBottom)}-${fmt(obTop)}`, stopLoss: fmt(sl), tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3), entryMidRaw: entryMid, slRaw: sl, tp1Raw: tp1, tp2Raw: tp2, tp3Raw: tp3, riskRaw: risk };
  }
}

const FIXED_SL_PCT = 0.05;

// ============================================================
// TP1 -> 0.5R (2026-09-20)
//
// Retroactive analysis of 82 EXPIRED trades with MFE/MAE data showed 37
// (45%) had MFE >= 0.5R, of which 29 looked "clean" (MAE shallow enough
// that the stop likely wasn't hit first). Estimated +5.8R added across the
// sample on the 40% TP1 slice alone, excluding the 8 ambiguous cases
// entirely.
//
// This is a FORWARD TEST of that finding, not a repeat of the retroactive
// analysis — MFE/MAE proves price reached 0.5R at some point, not that it
// reached 0.5R before the stop. Compare EXPIRED rate and realized R after
// the next ~30-40 resolved trades before treating this as confirmed.
//
// Only OB's TP1 changed here. TP2/TP3 floors (risk * 2, risk * 3) are
// untouched — this stays a single-variable change from the prior 1R TP1.
// ============================================================
function computeOBLevels(payload, direction) {
  if (direction === "Short") {
    const obTop = num(payload.obTop), obBottom = num(payload.obBottom);
    const pobTop = num(payload.pobTop), pobBottom = num(payload.pobBottom);
    const swingLow = num(payload.swingLow);
    const entryMid = (obTop + obBottom) / 2;
    const sl = entryMid * (1 + FIXED_SL_PCT);
    const risk = sl - entryMid;
    const tp1Floor = entryMid - risk * 0.5;
    const tp2Floor = entryMid - risk * 2;
    const tp3Floor = entryMid - risk * 3;
    const tp1 = (pobTop > 0 && pobTop < tp1Floor) ? pobTop : tp1Floor;
    const tp2 = (pobBottom > 0 && pobBottom < tp2Floor && pobBottom < tp1) ? pobBottom : tp2Floor;
    const tp3 = (swingLow > 0 && swingLow < tp3Floor && swingLow < tp2) ? swingLow : tp3Floor;
    return { entryZone: `${fmt(obBottom)}-${fmt(obTop)}`, stopLoss: fmt(sl), tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3), entryMidRaw: entryMid, slRaw: sl, tp1Raw: tp1, tp2Raw: tp2, tp3Raw: tp3 };
  } else {
    const obTop = num(payload.obTop), obBottom = num(payload.obBottom);
    const pobTop = num(payload.pobTop), pobBottom = num(payload.pobBottom);
    const swingHigh = num(payload.swingHigh);
    const entryMid = (pobTop + pobBottom) / 2;
    const sl = entryMid * (1 - FIXED_SL_PCT);
    const risk = entryMid - sl;
    const tp1Floor = entryMid + risk * 0.5;
    const tp2Floor = entryMid + risk * 2;
    const tp3Floor = entryMid + risk * 3;
    const tp1 = (obBottom > 0 && obBottom > tp1Floor) ? obBottom : tp1Floor;
    const tp2 = (obTop > 0 && obTop > tp2Floor && obTop > tp1) ? obTop : tp2Floor;
    const tp3 = (swingHigh > 0 && swingHigh > tp3Floor && swingHigh > tp2) ? swingHigh : tp3Floor;
    return { entryZone: `${fmt(pobBottom)}-${fmt(pobTop)}`, stopLoss: fmt(sl), tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3), entryMidRaw: entryMid, slRaw: sl, tp1Raw: tp1, tp2Raw: tp2, tp3Raw: tp3 };
  }
}

function computeBreakoutLevels(payload, direction) {
  const origin = num(payload.boImpulseOrigin);
  const extreme = num(payload.boImpulseExtreme);
  const zoneTop = num(payload.boZoneTop);
  const zoneBottom = num(payload.boZoneBottom);
  const legRange = Math.abs(origin - extreme);
  const entryMid = (zoneTop + zoneBottom) / 2;

  if (direction === "Short") {
    const sl = origin + legRange * 0.05;
    const tp1 = extreme - legRange * 1.0;
    const tp2 = extreme - legRange * 1.5;
    const tp3 = extreme - legRange * 2.5;
    return { entryZone: `${fmt(zoneBottom)}-${fmt(zoneTop)}`, stopLoss: fmt(sl), tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3), entryMidRaw: entryMid, slRaw: sl, tp1Raw: tp1, tp2Raw: tp2, tp3Raw: tp3 };
  } else {
    const sl = origin - legRange * 0.05;
    const tp1 = extreme + legRange * 1.0;
    const tp2 = extreme + legRange * 1.5;
    const tp3 = extreme + legRange * 2.5;
    return { entryZone: `${fmt(zoneBottom)}-${fmt(zoneTop)}`, stopLoss: fmt(sl), tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3), entryMidRaw: entryMid, slRaw: sl, tp1Raw: tp1, tp2Raw: tp2, tp3Raw: tp3 };
  }
}

function buildDecision(payload) {
  const condition = payload.condition || "";
    if (condition.startsWith("FIB_SR_")) return buildFibDecision(payload);
  const type = classifySignal(condition);
  if (!type) return { verdict: "UNRECOGNIZED" };

  const isSwing = type.startsWith("OB_SWING_");
  const killzoneActive = bool(payload.killzone);
  const direction = type.endsWith("SHORT") ? "Short" : "Long";
  const scoreResult = type.startsWith("OB_")
    ? scoreOB(payload, direction)
    : scoreBreakout(payload, direction);

  const isBreakout = type.startsWith("BREAKOUT_");
  const gated = applyRiskGates(payload, scoreResult, killzoneActive, isSwing, isBreakout);
  if (gated.verdict === "NO_TRADE") return { verdict: "NO_TRADE", reason: gated.reason, type, scoreResult };

  if (type.startsWith("OB_")) {
    const zoneCheck = checkZoneCooldown(payload, direction);
    payload._zoneAttempt = zoneCheck.count;
    payload._isRepeatZone = zoneCheck.isRepeat;
    if (zoneCheck.isRepeat) {
      gated.confidence = "MEDIUM";
      const topOfBand = parseInt(gated.leverage.split("-")[1], 10);
      const localFloorLeverage = isSwing ? "30x-40x" : "5x-8x";
      if (topOfBand > 40) gated.leverage = localFloorLeverage;
      gated.flags.push(`Repeat signal on the same zone (attempt #${zoneCheck.count} within the cooldown window) — needing multiple retests to hold is a lower-conviction sign, confidence capped regardless of this bar's individual flags`);
    }
  }

  const levels = isSwing
    ? computeSwingLevels(payload, direction)
    : type.startsWith("OB_")
      ? computeOBLevels(payload, direction)
      : computeBreakoutLevels(payload, direction);

  const slDistPct = Math.abs(levels.slRaw - levels.entryMidRaw) / levels.entryMidRaw * 100;
  const maxLeverage = parseInt(gated.leverage.split("-")[1], 10);
  const estLiqPct = 100 / maxLeverage;
  if (slDistPct >= estLiqPct * 0.9) {
    gated.flags.push(`⚠️ At ${maxLeverage}x, estimated liquidation distance (~${estLiqPct.toFixed(2)}%) is close to or beyond this trade's stop distance (${slDistPct.toFixed(2)}%) — you may be liquidated before the SL executes. This is an approximation; verify against your exchange's actual liquidation calculator, and consider lower leverage or a smaller position.`);
  } else {
    gated.flags.push(`Stop distance (${slDistPct.toFixed(2)}%) sits inside the estimated liquidation buffer (~${estLiqPct.toFixed(2)}% at ${maxLeverage}x) under normal conditions — approximate only, actual liquidation mechanics vary by exchange.`);
  }

  return { verdict: "TRADE", type, scoreResult, gated, levels, isSwing };
}

const EXPLAIN_SYSTEM_PROMPT = `You are a trading assistant whose ONLY job is to write a short, clear explanation of a trade decision that has ALREADY been made by deterministic code. You are NOT permitted to change the score, direction, confidence, leverage, entry, stop loss, or take-profit values given to you — those are fixed inputs, not suggestions you can adjust.

Your job:
1. Write a 1-2 sentence REASONING explaining why this setup qualifies, referencing the specific checklist points that passed.
2. If any of these known lesson patterns apply to the data given, mention it as a caution (do not change the trade, just flag it):
   - Negative delta during a strong multi-timeframe rally can be absorption, not distribution — don't over-read bearish delta alone if RSI/momentum is strongly bullish across timeframes
   - SMT divergence appearing after a fresh high/low impulse is an early reversal warning worth flagging
   - A directionally correct call can still get stopped out on intraday range noise before resolving — don't overstate certainty

Output ONLY the reasoning text, 1-2 sentences, nothing else — no preamble, no restating the numbers back.`;

async function explainDecision(decision, payload) {
  const { type, scoreResult, gated, levels } = decision;
  const userMessage = `Signal type: ${type}
Direction: ${scoreResult.direction}
Checklist: ${scoreResult.points.map(p => `[${p.pass ? "PASS" : "FAIL"}] ${p.label}: ${p.detail}`).join(" | ")}
Raw score: ${scoreResult.rawScore}/5
Confidence: ${gated.confidence}
Risk flags already applied: ${gated.flags.join("; ") || "none"}
Entry: ${levels.entryZone}, SL: ${levels.stopLoss}, TP1: ${levels.tp1}, TP2: ${levels.tp2}, TP3: ${levels.tp3}
SMT bias: ${payload.smtBias}, RSI: ${payload.rsi}, HTF trend: ${payload.htfTrend}

Write the 1-2 sentence reasoning now.`;

  const body = JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 300,
    system: EXPLAIN_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return new Promise((resolve) => {
    const req = https.request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = extractClaudeText(parsed);
          if (!text) console.error("explainDecision: empty/unexpected response:", data.slice(0, 300));
          resolve(text || "Deterministic checklist cleared threshold — see score breakdown above.");
        } catch (err) {
          console.error("explainDecision: response parse failed. Raw response:", data.slice(0, 300));
          resolve("Deterministic checklist cleared threshold — see score breakdown above.");
        }
      });
    });
    req.on("error", (err) => {
      console.error("explainDecision: API call failed:", err.message);
      resolve("Deterministic checklist cleared threshold — see score breakdown above.");
    });
    req.write(body);
    req.end();
  });
}

const LEGACY_SYSTEM_PROMPT = `You are a professional crypto futures trade signal generator. A manual price level the trader marked has just been crossed. Give a brief, honest read: is this level crossing significant given the RSI, delta, and session context provided, or likely noise? Keep it to 2-3 sentences. Do not fabricate a full trade plan with entry/SL/TP for a simple level cross — that requires the structural checklist, which doesn't apply here.`;

async function generateLegacyNote(payload) {
  const userMessage = `Manual level crossed. Condition: ${payload.condition}. Symbol: ${payload.symbol}. Price: $${payload.price}. RSI: ${payload.rsi}. Cumulative Delta: ${payload.cumDelta}. Session: ${payload.session}. Kill zone active: ${payload.killzone}.`;

  const body = JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 300,
    system: LEGACY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return new Promise((resolve) => {
    const req = https.request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = extractClaudeText(parsed);
          if (!text) console.error("generateLegacyNote: empty/unexpected response:", data.slice(0, 300));
          resolve(text || "No commentary available.");
        } catch (err) {
          console.error("generateLegacyNote: response parse failed. Raw response:", data.slice(0, 300));
          resolve("No commentary available.");
        }
      });
    });
    req.on("error", (err) => {
      console.error("generateLegacyNote: API call failed:", err.message);
      resolve("No commentary available.");
    });
    req.write(body);
    req.end();
  });
}

async function sendTelegram(message) {
  const url  = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id:    TELEGRAM_CHAT_ID,
    text:       message,
    parse_mode: "HTML",
  });
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end",  () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function formatAlertHeader(payload) {
  const now = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne", dateStyle: "short", timeStyle: "short"
  });
  const killzone  = bool(payload.killzone);
  const kzTag     = killzone ? " ⚡ KILL ZONE" : "";
  const condition = payload.condition || "unknown";
  const isPriority = condition.includes("HIGH_PRIORITY") || condition.includes("BREAKOUT") || condition.includes("SWING");
  const isShort   = condition.includes("OB_SHORT") || condition.includes("BREAKOUT_SHORT") || condition.includes("cross_below");
  const isLong    = condition.includes("POB_LONG")  || condition.includes("BREAKOUT_LONG") || condition.includes("cross_above");
  const emoji     = isPriority ? "🚨" : isShort ? "🔴" : isLong ? "🟢" : "🔔";

  return `${emoji} <b>TRADE ALERT${kzTag}</b>
─────────────────
<b>Signal:</b>   ${condition}
<b>Symbol:</b>   ${payload.symbol || "—"}
<b>Price:</b>    $${payload.price}
<b>RSI:</b>      ${payload.rsi}
<b>Delta:</b>    ${payload.cumDelta}
<b>Session:</b>  ${payload.session}
<b>TF:</b>       ${payload.timeframe}
<b>-OB Zone:</b> $${payload.obBottom} – $${payload.obTop}${bool(payload.obMitigated) ? " (mitigated)" : ""}
<b>+OB Zone:</b> $${payload.pobBottom} – $${payload.pobTop}${bool(payload.pobMitigated) ? " (mitigated)" : ""}
<b>SMT:</b>      ${payload.smtBias}  |  <b>MSS:</b> ${payload.mssDir}
<b>HTF Trend:</b> ${payload.htfTrend || "Unknown"}
─────────────────
⏳ <i>Scoring deterministically...</i>
<b>Time (AEDT):</b> ${now}`;
}

function titleCase(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatTradeSetup(decision, payload, reasoning) {
  const { scoreResult, gated, levels, isSwing } = decision;
  const checklistLines = scoreResult.points.map(p => `${p.pass === 1 ? "✅" : p.pass === 0.5 ? "➖" : "❌"} ${p.label}`).join("\n");
  const flagLines = gated.flags.length ? `\n\n<b>Risk Flags:</b>\n${gated.flags.map(f => `⚠️ ${f}`).join("\n")}` : "";
  const htfPart = payload.htfTrend ? ` - HTF Trend: ${payload.htfTrend}` : "";
  const swingLine = isSwing && payload.swingTrend ? `\n1H Structure: ${payload.swingTrend} (swing-eligible)` : "";
  const titleTag = (isSwing ? " 🌙" : "") + (AGGRO ? ` 🎰 AGGRO ${SIZING_LEVERAGE}x` : V19_EXECUTE ? "" : " (v19 paper, no order)");

  let rMultLine = "";
  if (isSwing && levels.riskRaw > 0) {
    const r1 = Math.abs(levels.tp1Raw - levels.entryMidRaw) / levels.riskRaw;
    const r2 = Math.abs(levels.tp2Raw - levels.entryMidRaw) / levels.riskRaw;
    const r3 = Math.abs(levels.tp3Raw - levels.entryMidRaw) / levels.riskRaw;
    rMultLine = `\nR achieved: ${r1.toFixed(1)}R / ${r2.toFixed(1)}R / ${r3.toFixed(1)}R (min floor: 3R/5R/8R)`;
  }

  return `📊 <b>Trade Setup${titleTag}</b>

<b>${payload.symbol || "—"}</b>${htfPart}
${scoreResult.direction} bias  │  ${titleCase(gated.confidence)} ${scoreResult.rawScore}/5  │  ${gated.leverage}

Entry: ${levels.entryZone}
Tp1 ${levels.tp1}  │  Tp2 ${levels.tp2}  │  Tp3 ${levels.tp3}
Stop loss: ${levels.stopLoss}${rMultLine}${swingLine}

<b>Checklist:</b>
${checklistLines}${flagLines}

<b>Reasoning:</b> ${reasoning}`;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const includePaper = urlObj.searchParams.get("includePaper") === "true";

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200); res.end("Trade alert server v19 — deterministic scoring, Claude explains only, signal-only (no execution) ✅"); return;
  }

  if (req.method === "GET" && pathname === "/signals") {
    const signals = readSignalLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: signals.length, signals }, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/signals.csv") {
    const signals = readSignalLog();
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=signals.csv" });
    res.end(signalsToCSV(signals));
    return;
  }
  if (req.method === "GET" && pathname === "/stats") {
    const signals = readSignalLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(computeStats(signals, { includePaper }), null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/analysis") {
    const signals = readSignalLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(computeChecklistAnalysis(signals, { includePaper }), null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/report") {
    const days = parseInt(urlObj.searchParams.get("days") || "7", 10);
    const r = buildPerformanceReport(days);
    if (urlObj.searchParams.get("send") === "true") sendPerformanceReport(days);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/challenge") {
    const c = buildChallengeReport();
    if (urlObj.searchParams.get("send") === "true") sendChallengeReport();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(c, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/lessons") {
    const lessons = readLessonsLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: lessons.length, lessons }, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/aggro") {
    const a = readAggro();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ on: AGGRO, riskPerTrade: AGGRO_RISK, ...a, returnPct: +((a.balance / a.start - 1) * 100).toFixed(1) }, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/funding") {
    const rows = readFundingWatch();
    const closed = rows.filter(r => r.closed);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rule: "72h avg funding >= 0.05%/8h -> paper short 3 days", open: rows.filter(r => !r.closed), closedCount: closed.length,
      avgResultPct: closed.length ? +(closed.reduce((a, r) => a + r.resultPct, 0) / closed.length).toFixed(2) : null, closed: closed.slice(-50) }, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/core") {
    const log = readCoreLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ strategy: "BTC+ETH, 28d trend filter, 40% vol target, daily (paper)", state: readCoreState(), days: log.length, log: log.slice(-60) }, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/missed-signals") {
    const missed = readMissedSignalLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: missed.length, missed }, null, 2));
    return;
  }

  if (req.method === "GET" && pathname === "/test-postmortem") {
    const signals = readSignalLog();
    const resolved = signals.filter(s => s.outcome && s.outcome !== "not_taken");
    if (!resolved.length) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "No resolved signals available to test against." }, null, 2));
      return;
    }
    const idxParam = urlObj.searchParams.get("index");
    const idx = idxParam !== null ? parseInt(idxParam, 10) : resolved.length - 1;
    const sig = resolved[Math.max(0, Math.min(idx, resolved.length - 1))];
    const postmortem = await generatePostmortem(sig);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: !!postmortem,
      testedSignal: { symbol: sig.symbol, direction: sig.direction, outcome: sig.outcome, loggedAt: sig.loggedAt },
      resolvedAvailable: resolved.length,
      postmortem: postmortem || null,
      note: postmortem
        ? "Generation succeeded — the full chain works. This test does NOT write to lessons.jsonl."
        : "Generation returned empty — check Railway logs for the raw API response.",
    }, null, 2));
    return;
  }

  if (req.method === "POST" && pathname === "/webhook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { condition: body }; }

      res.writeHead(200); res.end(JSON.stringify({ ok: true }));

      try {
        const condition = payload.condition || "";

        if (isDuplicateSignal(payload)) {
          console.log("Duplicate signal within dedup window — skipping ⏭️", new Date().toISOString(), "| condition:", condition, "| symbol:", payload.symbol, "| price:", payload.price);
          return;
        }

        if (condition === "WATCH_HTF_RESISTANCE_NEARBY" || condition === "WATCH_HTF_SUPPORT_NEARBY") {
          const zoneType = condition === "WATCH_HTF_RESISTANCE_NEARBY" ? "resistance" : "support";
          const htfLevel = condition === "WATCH_HTF_RESISTANCE_NEARBY" ? payload.htfSwingHigh : payload.htfSwingLow;
          console.log("HTF watch alert sent 👀", new Date().toISOString(), "| symbol:", payload.symbol || "—", "| condition:", condition);
          return;
        }

        const decision = buildDecision(payload);

        if (decision.verdict === "UNRECOGNIZED") {
          const legacyConditions = ["cross_manual_level1", "cross_manual_level2", "cross_manual_level3"];
          if (!legacyConditions.some(s => condition.includes(s))) {
            console.log("Low priority / unrecognized signal — skipping ⏭️", new Date().toISOString(), "| symbol:", payload.symbol || "—", "| condition:", condition);
            return;
          }
          const note = await generateLegacyNote(payload);
          await sendTelegram(`🔔 <b>Manual Level Cross</b>
Symbol: ${payload.symbol || "—"} | Price: $${payload.price}
${note}`);
          console.log("Legacy manual-cross note sent 🔔", new Date().toISOString(), "| condition:", condition);
          return;
        }

        if (decision.verdict === "NO_TRADE") {
          console.log("No trade (deterministic) — complete silence ⏭️", new Date().toISOString(), "| symbol:", payload.symbol || "—", "| condition:", condition, "| reason:", decision.reason);
          logMissedSignal(decision, payload);
          return;
        }

        const reasoning = await explainDecision(decision, payload);
        const header = formatAlertHeader(payload);
        await sendTelegram(header);
        const planMsg = formatTradeSetup(decision, payload, reasoning);
        await sendTelegram(planMsg);
        const execResult = await executeOnBingX(decision, payload);
        logSignal(decision, payload, execResult);

        const execOk = !execResult || !!execResult.bingxOrderId;
        console.log(`Trade signal — alert sent ${execOk ? "+ executed ✅" : "⚠️ ORDER REJECTED"}`, new Date().toISOString(), "| condition:", condition, "| score:", decision.scoreResult.rawScore, "/5", "| confidence:", decision.gated.confidence);
      } catch (err) {
        console.error("Error:", err.message);
        try { await sendTelegram(`⚠️ <b>Bot error:</b> ${err.message}`); } catch {}
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ============================================================
// 🛡️ CORE MODE — SHADOW TRACKER (v19.4, paper only, no orders)
//
// Research (2018-2026 daily, research/voltarget_test.py): BTC+ETH held
// only while each one's 28-day return is positive, checked daily, sized by
// volatility targeting (40% annualised, never above 1x). Across 8 years it
// beat buy & hold on risk-adjusted return (Sharpe ~1.04 vs 0.68) with about
// half the max drawdown (-44% vs -84%), and the result held across every
// lookback (21/28/35d) and vol target (30/40/60%) tested.
//
// This block only TRACKS that strategy on a virtual 10,000 balance so we
// get honest forward evidence. It places no orders and is fully separate
// from v19: it never touches executeOnBingX, the open-risk cap, or sizing.
// ============================================================
const CORE_ASSETS = ["BTC-USDT", "ETH-USDT"];
const CORE_LOOKBACK = 28;        // days
const CORE_VOL_TARGET = 0.40;    // annualised
const CORE_FEE = 0.001;          // per unit of weight traded
const CORE_STATE_FILE = path.join(DATA_DIR, "core_state.json");
const CORE_LOG_FILE = path.join(DATA_DIR, "core_log.jsonl");
const DAY_MS = 86400000;

async function fetchDailyCloses(symbol) {
  const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=1d&limit=80`;
  const r = await fetch(url);
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error(`no daily data for ${symbol}`);
  const now = Date.now();
  return j.data
    .map(k => ({ t: +k.time, c: +k.close }))
    .filter(k => k.t + DAY_MS <= now)          // closed candles only
    .sort((a, b) => a.t - b.t);
}

function coreTargetWeight(closes) {
  const n = closes.length;
  if (n < CORE_LOOKBACK + 21) return null;
  const mom = closes[n - 1].c / closes[n - 1 - CORE_LOOKBACK].c - 1;
  const on = mom > 0;
  let ss = 0;
  for (let k = n - 20; k < n; k++) ss += Math.log(closes[k].c / closes[k - 1].c) ** 2;
  const vol = Math.sqrt(ss / 20) * Math.sqrt(365);
  const size = vol > 0 ? Math.min(1, CORE_VOL_TARGET / vol) : 1;
  return { on, mom, vol, size, ref: closes[n - 1 - CORE_LOOKBACK].c, weight: on ? size / CORE_ASSETS.length : 0 };
}

function readCoreState() {
  try { return JSON.parse(fs.readFileSync(CORE_STATE_FILE, "utf8")); }
  catch { return { equity: 10000, startedAt: null, lastDay: null, weights: {}, prices: {} }; }
}

async function runCoreMode() {
  const data = {};
  for (const s of CORE_ASSETS) data[s] = await fetchDailyCloses(s);
  const day = Math.min(...CORE_ASSETS.map(s => data[s][data[s].length - 1].t));
  const st = readCoreState();
  if (st.lastDay !== null && day <= st.lastDay) return null;   // already processed this day

  const px = {};
  for (const s of CORE_ASSETS) px[s] = data[s].find(k => k.t === day)?.c ?? data[s][data[s].length - 1].c;

  // 1. mark yesterday's weights to today's close
  let dayRet = 0;
  for (const s of CORE_ASSETS) {
    const w = st.weights[s] || 0, p0 = st.prices[s];
    if (w && p0) dayRet += w * (px[s] / p0 - 1);
  }
  // 2. new target weights
  const detail = {}, newW = {};
  let turnover = 0;
  for (const s of CORE_ASSETS) {
    const tw = coreTargetWeight(data[s].filter(k => k.t <= day));
    if (!tw) return null;
    detail[s] = tw; newW[s] = tw.weight;
    turnover += Math.abs(tw.weight - (st.weights[s] || 0));
  }
  const cost = turnover * CORE_FEE;
  const prevEq = st.equity;
  st.equity = prevEq * (1 + dayRet) - prevEq * cost;
  st.peak = Math.max(st.peak || st.equity, st.equity);
  st.startedAt = st.startedAt || new Date(day).toISOString();
  st.lastDay = day; st.weights = newW; st.prices = px;
  fs.writeFileSync(CORE_STATE_FILE, JSON.stringify(st));

  const entry = {
    day: new Date(day).toISOString().slice(0, 10), serverVersion: SERVER_VERSION,
    equity: +st.equity.toFixed(2), dayRetPct: +(dayRet * 100).toFixed(3), costPct: +(cost * 100).toFixed(3),
    drawdownPct: +((st.equity / st.peak - 1) * 100).toFixed(2),
    positions: Object.fromEntries(CORE_ASSETS.map(s => [s, {
      inMarket: detail[s].on, weightPct: +(detail[s].weight * 100).toFixed(1),
      vol: +(detail[s].vol * 100).toFixed(0), momPct: +(detail[s].mom * 100).toFixed(1), refPrice: detail[s].ref, price: px[s] }])),
  };
  fs.appendFileSync(CORE_LOG_FILE, JSON.stringify(entry) + "\n");
  return { entry, changed: turnover > 0.05 };
}

function readCoreLog() {
  try { return fs.readFileSync(CORE_LOG_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

async function coreModeTick() {
  try {
    const res = await runCoreMode();
    if (!res) return;
    const e = res.entry;
    const pos = Object.entries(e.positions)
      .map(([s, p]) => `${s.replace("-USDT", "")}: ${p.inMarket ? `IN ${p.weightPct}%` : "cash"}`).join(" | ");
    console.log(`🛡️ Core mode ${e.day}: equity ${e.equity} (${e.dayRetPct}%), DD ${e.drawdownPct}% | ${pos}`);
    if (res.changed) {
      await sendTelegram(`🛡️ <b>Core mode (paper)</b> — position change\n${pos}\nVirtual equity: ${e.equity} (DD ${e.drawdownPct}%)`);
    }
  } catch (err) {
    console.error("Core mode tick failed (non-fatal):", err.message);
  }
}

// ============================================================
// 🔥 FUNDING WATCH — PAPER TRACKER (v19.6, no orders)
//
// Research (research/funding_test.py, 18 coins, 2022-2025): when a coin's
// average funding over 72h reached >= 0.05% per 8h (longs extremely
// crowded), shorting for 3 days returned +2.0% per trade, 60% win,
// n=282 — robust to dropping any single coin. BUT 251 of 282 trades came
// from the 2024 euphoria, so it is effectively 1-2 market events, and 2026
// had none to verify against. Status: promising, unconfirmed.
// This tracks it on paper and pings Telegram when it fires.
// ============================================================
const FUND_COINS = ["BTC","ETH","SOL","SUI","BNB","XRP","DOGE","ADA","AVAX","LINK","DOT","LTC","NEAR","APT","ARB","OP","INJ","TIA"];
const FUND_THRESHOLD = 0.0005;       // 0.05% per 8h, 72h average
const FUND_HOLD_MS = 3 * 86400000;
const FUND_FILE = path.join(DATA_DIR, "funding_watch.jsonl");

async function fundingHistory(coin, sinceMs) {
  const r = await fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/fundingRate?symbol=${coin}-USDT&limit=100`);
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error(`no funding data for ${coin}`);
  return j.data.map(x => ({ t: +x.fundingTime, f: +x.fundingRate })).filter(x => x.t > sinceMs);
}
async function lastPrice(coin) {
  const r = await fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/price?symbol=${coin}-USDT`);
  const j = await r.json();
  return +j?.data?.price;
}
function readFundingWatch() {
  try { return fs.readFileSync(FUND_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}
function writeFundingWatch(rows) { fs.writeFileSync(FUND_FILE, rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")); }

async function fundingWatchTick() {
  try {
    const rows = readFundingWatch(); const now = Date.now(); let dirty = false;
    // 1. resolve paper trades whose 3 days are up
    for (const r of rows.filter(r => !r.closed && now >= r.openedAt + FUND_HOLD_MS)) {
      const px = await lastPrice(r.coin);
      const carry = (await fundingHistory(r.coin, r.openedAt)).filter(x => x.t <= r.openedAt + FUND_HOLD_MS).reduce((a, x) => a + x.f, 0);
      r.closePrice = px; r.carryPct = +(carry * 100).toFixed(3);
      r.resultPct = +((-(px / r.entryPrice - 1) + carry - 0.001) * 100).toFixed(2);
      r.closed = true; dirty = true;
      await sendTelegram(`🔥 <b>Funding watch (paper) closed</b>\n${r.coin} short: ${r.resultPct > 0 ? "+" : ""}${r.resultPct}% after 3 days (funding carry ${r.carryPct}%)`);
    }
    // 2. scan for new extremes
    for (const coin of FUND_COINS) {
      if (rows.some(r => r.coin === coin && !r.closed)) continue;
      const h = await fundingHistory(coin, now - 72 * 3600000);
      if (!h.length) continue;
      const f3 = h.reduce((a, x) => a + x.f, 0) / h.length;
      if (f3 >= FUND_THRESHOLD) {
        const px = await lastPrice(coin);
        rows.push({ coin, side: "Short", openedAt: now, opened: new Date(now).toISOString(), entryPrice: px,
                    f3Pct: +(f3 * 100).toFixed(4), serverVersion: SERVER_VERSION, closed: false });
        dirty = true;
        await sendTelegram(`🔥 <b>Funding extreme (paper)</b>\n${coin}: 72h avg funding ${(f3 * 100).toFixed(3)}% per 8h, longs very crowded.\nPaper short logged at ${px}, resolves in 3 days. No real order placed.`);
      }
      await new Promise(res => setTimeout(res, 150));
    }
    if (dirty) writeFundingWatch(rows);
  } catch (err) {
    console.error("Funding watch tick failed (non-fatal):", err.message);
  }
}

// ============================================================
// 🛡️ CORE MODE — DEMO EXECUTION (v20)
//
// Mirrors the Core mode target weights onto the BingX demo (VST) account:
// BTC and ETH LONG only, 1x leverage, sized as weight x equity x CORE_ALLOC.
// Rebalances only when a position is >10% away from target, so it trades
// a few times a month, not every hour. Every Core position also carries a
// disaster stop 15% below the current price, refreshed on each rebalance:
// the daily trend filter is the normal exit, the stop only covers a crash
// between daily checks (and keeps the stop watchdog happy).
// Switch off with Railway variable CORE_EXECUTE=off.
// ============================================================
const CORE_EXECUTE = (process.env.CORE_EXECUTE || "on") === "on";
const CORE_ALLOC = Number(process.env.CORE_ALLOC || 0.5);
const CORE_DISASTER_STOP = 0.15;
// Leverage applied to Core's weights. Research (2018-2026, incl. funding):
// 1x +22%/yr maxDD -45% | 2x +37%/yr maxDD -71% | 3x +42%/yr maxDD -85% |
// 5x +18%/yr maxDD -97% | 10x wiped. Hard-capped at 2x.
const CORE_LEVERAGE = Math.min(2, Math.max(1, Number(process.env.CORE_LEVERAGE || 1)));
// PROFIT SLEEVE: the starting balance (principal) trades at CORE_LEVERAGE,
// only PROFITS above it trade at CORE_PROFIT_LEV (max 3x). If the profits are
// lost, the sleeve shrinks to zero by itself; principal never runs above 1-2x.
// Research ($500, 2018-2026): profits at 3x -> $6,001, maxDD -74%;
// profits at 5x -> $2,613, maxDD -92% (worse), so 3x is the hard cap.
// Starting balance = equity the first time this runs, or CORE_START_EQUITY.
const CORE_PROFIT_LEV = Math.min(3, Math.max(1, Number(process.env.CORE_PROFIT_LEV || 3)));

async function coreStopOrders(symbol) {
  const res = await bingxRequest("GET", "/openApi/swap/v2/trade/openOrders", { symbol });
  const orders = res?.data?.orders;
  if (!Array.isArray(orders)) return null;
  return orders.filter(o => o.positionSide === "LONG" && /STOP/.test(o.type || "") && !/TAKE_PROFIT/.test(o.type || ""));
}

async function placeCoreStop(symbol, qty, price) {
  const old = await coreStopOrders(symbol);
  if (old === null) { console.error(`Core exec: could not read open orders for ${symbol}; stop not refreshed`); return false; }
  for (const o of old) await bingxRequest("DELETE", "/openApi/swap/v2/trade/order", { symbol, orderId: o.orderId });
  if (qty <= 0) return true;
  const stopPrice = +(price * (1 - CORE_DISASTER_STOP)).toPrecision(6);
  const r = await bingxRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol, side: "SELL", positionSide: "LONG", type: "STOP_MARKET", quantity: qty, stopPrice, workingType: "MARK_PRICE",
  });
  if (r.error || r.code !== 0) {
    await sendTelegram(`🚨 <b>Core mode: disaster stop FAILED</b>\n${symbol} LONG ${qty}\n${JSON.stringify(r).slice(0, 200)}`);
    return false;
  }
  return true;
}

function formatCoreTrade({ symbol, side, qty, px, targetQty, curQty, w, equity, stopOk, principal = 0, profit = 0 }) {
  const coin = symbol.replace("-USDT", "");
  const info = (readCoreLog().slice(-1)[0]?.positions || {})[symbol] || {};
  const fmt = (v, d = 2) => (v == null || isNaN(v)) ? "?" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
  const closing = targetQty === 0;
  const action = closing ? "CLOSE" : curQty === 0 ? "OPEN" : side === "BUY" ? "ADD" : "TRIM";
  const trend = info.momPct == null ? "?" : `${info.momPct > 0 ? "Bullish" : "Bearish"} (${info.momPct > 0 ? "+" : ""}${info.momPct}%)`;
  const sizePct = info.vol ? Math.min(100, Math.round(4000 / info.vol)) : null;
  const levels = closing
    ? `<b>Exit:</b> $${fmt(px)}\n<b>Reason:</b> daily close fell below the 28-day reference ($${fmt(info.refPrice)})`
    : `<b>Entry:</b> $${fmt(px)}
<b>Exit trigger:</b> daily close below $${fmt(info.refPrice)} (28-day reference, moves daily)
<b>Disaster stop:</b> $${fmt(px * (1 - CORE_DISASTER_STOP))} (−15%)
<b>Take profit:</b> none, rides the trend until the exit trigger`;
  const checklist = closing
    ? `❌ 28-day trend negative\n✅ Position closed, disaster stop cancelled`
    : `✅ 28-day trend positive
${sizePct === 100 ? "✅" : "➖"} Volatility ${info.vol ?? "?"}% → size ${sizePct ?? "?"}% of full (target 40%)
${stopOk ? "✅ Disaster stop placed" : "❌ Disaster stop NOT confirmed, check BingX"}`;
  const reasoning = closing
    ? `${coin}'s 28-day trend turned negative, so Core steps out to cash and waits for the trend to recover.`
    : action === "OPEN"
      ? `${coin} is above where it traded 28 days ago, so Core holds it. Size is scaled by volatility so a wild market means a smaller position.`
      : `Rebalance only: volatility moved, so the position was resized to stay near the 40% volatility target. Trend unchanged.`;
  return `🛡️ <b>Core Mode Trade</b> (demo)

<b>${coin}USDT</b> - 28d Trend: ${trend}
Long  │  ${action}  │  principal ${CORE_LEVERAGE}x${profit > 0 ? ` + profits ${CORE_PROFIT_LEV}x` : ""}

${levels}

<b>Size:</b> ${side} ${qty} ${coin} → holding ${targetQty} ${coin} (≈ ${fmt(targetQty * px, 0)} VST)
<b>Weight:</b> ${(w * 100).toFixed(1)}% of Core budget │ Core gets ${CORE_ALLOC * 100}% of ${fmt(equity, 0)} VST
<b>Profit sleeve:</b> ${profit > 0 ? `${fmt(profit, 0)} VST of profit trading at ${CORE_PROFIT_LEV}x, principal ${fmt(principal, 0)} at ${CORE_LEVERAGE}x` : `no profit above the starting balance yet, all at ${CORE_LEVERAGE}x`}

<b>Checklist:</b>
${checklist}

<b>Reasoning:</b> ${reasoning}`;
}

async function coreExecute() {
  if (!CORE_EXECUTE || !BINGX_API_KEY || !BINGX_API_SECRET) return;
  const st = readCoreState();
  if (!st.lastDay || !st.weights) return;
  const { equity } = await getAccountEquity();
  if (!equity) { console.error("Core exec: equity unavailable, skipping"); return; }
  const pos = await getOpenPositions();
  if (!pos.checked) { console.error("Core exec: positions unavailable, skipping"); return; }
  if (!st.coreStart) { st.coreStart = Number(process.env.CORE_START_EQUITY) || equity; fs.writeFileSync(CORE_STATE_FILE, JSON.stringify(st)); }
  const coreStart = st.coreStart;
  for (const symbol of CORE_ASSETS) {
    try {
      const w = st.weights[symbol] || 0;
      const px = await lastPrice(symbol.replace("-USDT", ""));
      if (!px) continue;
      const prec = await getQuantityPrecision(symbol);
      const principal = Math.min(equity, coreStart), profit = Math.max(0, equity - coreStart);
      const exposure = principal * CORE_LEVERAGE + profit * CORE_PROFIT_LEV;
      const targetQty = Number(((w * exposure * CORE_ALLOC) / px).toFixed(prec));
      const cur = pos.positions.find(p => p.symbol === symbol && p.direction === "Long");
      const curQty = cur ? cur.amt : 0;
      const diff = Number((targetQty - curQty).toFixed(prec));
      const needTrade = targetQty === 0 ? curQty > 0 : Math.abs(diff) * px > 0.10 * targetQty * px;
      if (!needTrade) {
        // self-heal: a Core position must always have its disaster stop
        if (curQty > 0) {
          const stops = await coreStopOrders(symbol);
          if (stops && stops.length === 0) await placeCoreStop(symbol, curQty, px);
        }
        continue;
      }
      await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol, side: "LONG", leverage: Math.ceil(Math.max(CORE_LEVERAGE, profit > 0 ? CORE_PROFIT_LEV : 1)) });
      const side = diff > 0 ? "BUY" : "SELL";
      const qty = targetQty === 0 ? curQty : Math.abs(diff);
      const r = await bingxRequest("POST", "/openApi/swap/v2/trade/order", { symbol, side, positionSide: "LONG", type: "MARKET", quantity: qty });
      if (r.error || r.code !== 0) {
        await sendTelegram(`⚠️ <b>Core mode order failed</b>\n${symbol} ${side} ${qty}\n${JSON.stringify(r).slice(0, 200)}`);
        continue;
      }
      const stopOk = await placeCoreStop(symbol, targetQty, px);
      const msg = formatCoreTrade({ symbol, side, qty, px, targetQty, curQty, w, equity, stopOk, principal, profit });
      console.log(msg.replace(/<[^>]+>/g, ""));
      await sendTelegram(msg);
    } catch (err) {
      console.error(`Core exec ${symbol} failed (non-fatal):`, err.message);
    }
  }
}

server.listen(PORT, () => console.log(`Server ${SERVER_VERSION} running on port ${PORT}`));

// Core mode shadow tracker: check hourly, processes each new daily close once.
setInterval(() => coreModeTick().then(coreExecute).catch(e => console.error("core loop:", e.message)), 60 * 60 * 1000);
setTimeout(() => coreModeTick().then(coreExecute).catch(e => console.error("core loop:", e.message)), 2 * 60 * 1000);
setInterval(fundingWatchTick, 60 * 60 * 1000);
setTimeout(fundingWatchTick, 3 * 60 * 1000);

setInterval(() => {
  checkOpenPositions().catch(err => console.error("checkOpenPositions failed (non-fatal):", err.message));
  resolvePaperTrades().catch(err => console.error("resolvePaperTrades failed (non-fatal):", err.message));
  resolveMissedSignals().catch(err => console.error("resolveMissedSignals failed (non-fatal):", err.message));
  stopWatchdog().catch(err => console.error("stopWatchdog failed (non-fatal):", err.message));
}, 15 * 60 * 1000);
setTimeout(() => stopWatchdog().catch(() => {}), 90 * 1000);

setInterval(() => {
  sendSignalBackupToTelegram().catch(err => console.error("Backup interval failed (non-fatal):", err.message));
}, 24 * 60 * 60 * 1000);

setTimeout(() => {
  sendSignalBackupToTelegram().catch(err => console.error("Startup backup failed (non-fatal):", err.message));
}, 60 * 1000);

const MIN_SAMPLE_FOR_CONFIDENCE = 20;

function isWin(outcome) { return outcome === "TP1" || outcome === "TP2" || outcome === "TP3"; }
function isLoss(outcome) { return outcome === "SL"; }
function isClosed(outcome) { return isWin(outcome) || isLoss(outcome); }

// ============================================================
// WIN / LOSS / REAL — single definitions (v17)
//
// A trade is REAL only if BingX gave it an order ID. Previously "real" meant
// "isPaperTrade is not true", which also counted every signal still waiting
// to be resolved as a real trade.
//
// A trade WINS or LOSES by its net realizedR, not by its outcome label.
// With a 40/30/30 ladder a trade can fill TP1 and still lose overall
// (0.4 x 0.5R - 0.6 x 1R = -0.4R). Counting that as a win because its label
// says "TP1" was a misreport. The label is kept — it records how far the
// trade got — but the win/loss count uses the money.
// ============================================================
function isReal(s) { return !!s.bingxOrderId; }

function tradeResult(s) {
  if (!isClosed(s.outcome)) return null;
  if (typeof s.realizedR === "number") {
    if (s.realizedR > 0) return "win";
    if (s.realizedR < 0) return "loss";
    return "flat";
  }
  return isWin(s.outcome) ? "win" : "loss";
}

// Records resolved before v17 by the old paper resolver booked the whole
// position at the first TP touched, which overstates R. Counted separately
// in reports so they are never mistaken for current-method results.
function isLegacyResolution(s) {
  return !isReal(s) && isClosed(s.outcome) && s.resolvedBy !== "candle-walk-v17-ladder";
}

function dedupeBySetup(signals) {
  const seen = new Map();
  for (const s of signals) {
    const key = [s.symbol, s.direction, s.entryZone, s.stopLoss].join("|");
    const cur = seen.get(key);
    if (!cur) { seen.set(key, { ...s, _dupCount: 1 }); continue; }
    cur._dupCount += 1;
    // If the same setup has both a paper record and a real BingX fill, keep
    // the real one. Keeping whichever came first could hide a real trade
    // behind a paper duplicate of the same zone.
    if (!isReal(cur) && isReal(s)) seen.set(key, { ...s, _dupCount: cur._dupCount });
  }
  return [...seen.values()];
}

function bucketStats(arr) {
  const wins = arr.filter(s => tradeResult(s) === "win").length;
  const losses = arr.filter(s => tradeResult(s) === "loss").length;
  const total = wins + losses;
  const r = arr.reduce((a, s) => a + (Number(s.realizedR) || 0), 0);
  return {
    wins, losses, total,
    winRate: total > 0 ? Number((wins / total * 100).toFixed(1)) : null,
    totalR: Number(r.toFixed(2)),
  };
}

function groupBy(arr, keyFn) {
  const m = {};
  for (const s of arr) {
    const k = keyFn(s) ?? "unknown";
    (m[k] = m[k] || []).push(s);
  }
  return m;
}

// Padding never truncates (v17). The old versions sliced anything longer
// than the column, which could silently cut digits off a number.
function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}
function padL(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function buildPerformanceReport(days = 7) {
  const all = readSignalLog();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inPeriod = all.filter(s => {
    const t = Date.parse(s.loggedAt);
    return !isNaN(t) && t >= cutoff;
  });

  const rawCount = inPeriod.length;
  const setups = dedupeBySetup(inPeriod);
  const inflation = setups.length > 0 ? (rawCount / setups.length) : 1;

  const real = setups.filter(s => isReal(s));
  const paper = setups.filter(s => !isReal(s));
  const realClosed = real.filter(s => isClosed(s.outcome));
  const paperClosed = paper.filter(s => isClosed(s.outcome));
  const pending = setups.filter(s => !s.outcome);
  const notTaken = setups.filter(s => s.outcome === "not_taken" || s.outcome === "NOT_TAKEN");
  const unverifiable = setups.filter(s => s.outcome === "UNVERIFIABLE");
  const ambiguous = setups.filter(s => s.outcome === "AMBIGUOUS");
  const expired = setups.filter(s => s.outcome === "EXPIRED");
  const legacy = paperClosed.filter(s => isLegacyResolution(s));

  const realStats = bucketStats(realClosed);
  const paperStats = bucketStats(paperClosed);

  const closedAll = [...realClosed, ...paperClosed];
  const byDirection = groupBy(closedAll, s => s.direction);
  const bySymbol = groupBy(closedAll, s => s.symbol);
  const byConfidence = groupBy(closedAll, s => s.confidence);
  const byKillzone = groupBy(closedAll, s => (s.killzone ? "In kill zone" : "Outside"));

  const missed = readMissedSignalLog().filter(s => {
    const t = Date.parse(s.loggedAt);
    return !isNaN(t) && t >= cutoff;
  });
  const missedWouldWin = missed.filter(s => s.outcome === "WOULD_HAVE_WON").length;
  const missedWouldLose = missed.filter(s => s.outcome === "WOULD_HAVE_LOST").length;

  return {
    days, rawCount, setupCount: setups.length, inflation: Number(inflation.toFixed(2)),
    realCount: real.length, paperCount: paper.length,
    pendingCount: pending.length, notTakenCount: notTaken.length,
    unverifiableCount: unverifiable.length, ambiguousCount: ambiguous.length,
    expiredCount: expired.length, legacyCount: legacy.length,
    realStats, paperStats,
    byDirection: Object.fromEntries(Object.entries(byDirection).map(([k, v]) => [k, bucketStats(v)])),
    bySymbol: Object.fromEntries(Object.entries(bySymbol).map(([k, v]) => [k, bucketStats(v)])),
    byConfidence: Object.fromEntries(Object.entries(byConfidence).map(([k, v]) => [k, bucketStats(v)])),
    byKillzone: Object.fromEntries(Object.entries(byKillzone).map(([k, v]) => [k, bucketStats(v)])),
    missed: { total: missed.length, wouldHaveWon: missedWouldWin, wouldHaveLost: missedWouldLose },
    sampleAdequate: realStats.total >= MIN_SAMPLE_FOR_CONFIDENCE,
    minSampleForConfidence: MIN_SAMPLE_FOR_CONFIDENCE,
  };
}

function formatReportForTelegram(r) {
  // Every column is separated by an explicit space, so two values can never
  // run together (v16 printed 18 losses + 53.8% as "1853.8%").
  const rate = (b) => b.winRate === null ? "—" : b.winRate + "%";
  const line = (label, b) => `${pad(label, 12)} ${padL(b.wins, 3)} ${padL(b.losses, 3)} ${padL(rate(b), 6)} ${padL(b.totalR.toFixed(1) + "R", 7)}`;

  let out = `📈 <b>ProveX Bot — ${r.days}-Day Performance</b>\n`;
  out += `<i>${new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "short" })} AEDT</i>\n\n`;

  out += `<b>SIGNAL VOLUME</b>\n<pre>`;
  out += `Raw alerts     ${padL(r.rawCount, 5)}\n`;
  out += `Unique setups  ${padL(r.setupCount, 5)}   (${r.inflation}x dup)\n`;
  out += `Still pending  ${padL(r.pendingCount, 5)}\n`;
  out += `Expired        ${padL(r.expiredCount, 5)}\n`;
  out += `Not taken      ${padL(r.notTakenCount, 5)}\n`;
  out += `Ambiguous      ${padL(r.ambiguousCount, 5)}\n`;
  out += `Unverifiable   ${padL(r.unverifiableCount, 5)}\n`;
  out += `</pre>\n`;

  out += `<b>OUTCOMES</b>  <i>(deduped setups)</i>\n<pre>`;
  out += `${pad("", 12)} ${padL("W", 3)} ${padL("L", 3)} ${padL("Rate", 6)} ${padL("Total", 7)}\n`;
  out += line("REAL fills", r.realStats) + `\n`;
  out += line("PAPER only", r.paperStats) + `\n`;
  out += `</pre>\n`;

  const sections = [
    ["BY DIRECTION", r.byDirection],
    ["BY SYMBOL", r.bySymbol],
    ["BY CONFIDENCE", r.byConfidence],
    ["BY SESSION", r.byKillzone],
  ];
  for (const [title, data] of sections) {
    const entries = Object.entries(data).filter(([, b]) => b.total > 0);
    if (!entries.length) continue;
    out += `<b>${title}</b>\n<pre>`;
    for (const [k, b] of entries) out += line(k, b) + `\n`;
    out += `</pre>\n`;
  }

  if (r.missed.total) {
    out += `<b>BLOCKED SIGNALS</b>\n<pre>`;
    out += `Rejected       ${padL(r.missed.total, 5)}\n`;
    out += `Would've won   ${padL(r.missed.wouldHaveWon, 5)}\n`;
    out += `Would've lost  ${padL(r.missed.wouldHaveLost, 5)}\n`;
    out += `</pre>\n`;
  }

  out += `\n<b>READ THIS BEFORE TRUSTING THE NUMBERS</b>\n`;
  if (!r.sampleAdequate) {
    out += `⚠️ Only ${r.realStats.total} real closed trade(s). Nothing here is statistically meaningful below ~${r.minSampleForConfidence}. Treat every rate above as noise.\n`;
  }
  if (r.paperStats.total > 0) {
    out += `⚠️ Paper trades are resolved by a 5m candle walk modelled on the live 40/30/30 ladder — not real BingX fills, so no fees or slippage. Weaker evidence, kept in a separate row deliberately.\n`;
  }
  if (r.legacyCount > 0) {
    out += `⚠️ ${r.legacyCount} paper result(s) above were resolved before v17 by the old method, which booked the whole position at the first TP touched. Those overstate R — read the PAPER total as optimistic until they age out.\n`;
  }
  if (r.unverifiableCount > 0) {
    out += `⚠️ ${r.unverifiableCount} real trade(s) could not be verified on BingX (likely pre-v17 rounded order IDs). Excluded from win/loss rather than guessed.\n`;
  }
  if (r.inflation > 1.2) {
    out += `ℹ️ ${r.rawCount} raw alerts collapsed to ${r.setupCount} setups (${r.inflation}x). Same OB re-alerting; deduped figures are the honest ones.\n`;
  }
  out += `ℹ️ Results are shown in R-multiples, not % return. Summing leveraged percentages across different position sizes gives a meaningless total.`;

  return out;
}

async function sendPerformanceReport(days = 7) {
  try {
    const r = buildPerformanceReport(days);
    await sendTelegram(formatReportForTelegram(r));
    console.log(`Performance report sent (${days}d): ${r.setupCount} setups, ${r.realStats.total} real closed`);
  } catch (err) {
    console.error("Performance report failed (non-fatal):", err.message);
  }
}

let lastReportDay = null;
setInterval(() => {
  const nowAEDT = new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour: "2-digit", hour12: false });
  const dayKey = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Melbourne" });
  if (parseInt(nowAEDT, 10) === 8 && lastReportDay !== dayKey) {
    lastReportDay = dayKey;
    sendPerformanceReport(7).catch(err => console.error("Daily report failed:", err.message));
    sendChallengeReport().catch(err => console.error("Challenge report failed:", err.message));
  }
}, 60 * 60 * 1000);

const FIB_MIN_TOUCHES = 3;        // matches the Pine default
const FIB_SL_ATR_MULT = 1.5;
const FIB_MAX_ZONE_ATR = 2.0;     // a zone wider than this is a poor entry
const FIB_THRESHOLD_KZ = 3.5;
const FIB_THRESHOLD_NO_KZ = 4.0;

function scoreFib(payload, direction) {
  const touches   = num(payload.touches);
  const zoneTop   = num(payload.zoneTop);
  const zoneBottom = num(payload.zoneBottom);
  const atr       = num(payload.atr);
  const htfTrend  = payload.htfTrend || "Unknown";
  const zoneWidth = zoneTop - zoneBottom;
  const hasStructure = zoneTop > 0 && zoneBottom > 0 && zoneWidth > 0;

  const points = [];

  const p1 = touches >= FIB_MIN_TOUCHES;
  points.push({ n: 1, label: "Zone quality", pass: p1 ? 1 : 0,
    detail: `${touches} confirmed touches (min ${FIB_MIN_TOUCHES})` });

  const p2 = (direction === "Long" && htfTrend === "Bullish") || (direction === "Short" && htfTrend === "Bearish");
  points.push({ n: 2, label: "4H trend agreement", pass: p2 ? 1 : 0,
    detail: `HTF ${htfTrend} vs ${direction}` });

  const btc = scoreBTC(payload, direction);
  points.push({ n: 3, label: "BTC confirmation", pass: btc.score, detail: btc.detail });

  const p4 = hasStructure && touches > 0;
  points.push({ n: 4, label: "Fib/SR confluence", pass: p4 ? 1 : 0,
    detail: p4 ? `Overlap zone $${zoneBottom}-$${zoneTop}` : "No qualifying S/R zone at the Fib level" });

  const p5 = hasStructure && atr > 0 && zoneWidth <= atr * FIB_MAX_ZONE_ATR;
  points.push({ n: 5, label: "Entry precision", pass: p5 ? 1 : 0,
    detail: atr > 0 ? `Zone width ${(zoneWidth / atr).toFixed(2)} ATR (max ${FIB_MAX_ZONE_ATR})` : "ATR unavailable" });

  const rawScore = points.reduce((s, p) => s + p.pass, 0);
  return { points, rawScore, direction, btcOpposes: btc.opposes, structureOk: hasStructure, touches };
}

function applyFibGates(payload, scoreResult, killzoneActive) {
  const { rawScore, direction, btcOpposes, structureOk, touches } = scoreResult;

  if (!structureOk) return { verdict: "NO_TRADE", reason: "Missing zone structure — cannot place a real stop" };
  if (btcOpposes)   return { verdict: "NO_TRADE", reason: "BTC trend opposes signal direction — blocked entirely (validated across the OB backtests; removing it worsened profit factor, win rate and drawdown together)" };
  if (touches < FIB_MIN_TOUCHES) {
    return { verdict: "NO_TRADE", reason: `Zone has only ${touches} touches, below the ${FIB_MIN_TOUCHES} minimum (2-touch zones lost money in backtest)` };
  }

  const threshold = killzoneActive ? FIB_THRESHOLD_KZ : FIB_THRESHOLD_NO_KZ;
  if (rawScore < threshold) {
    return { verdict: "NO_TRADE", reason: `Score ${rawScore}/5 below ${threshold} threshold (killzone active: ${killzoneActive})` };
  }

  let confidence = rawScore >= 4.5 ? "HIGH" : "MEDIUM";
  let leverage = confidence === "HIGH" ? "5x-8x" : "3x-5x";

  const flags = [];
  if (!killzoneActive) flags.push("Outside kill zone — fakeout risk elevated");
  if (touches >= 5) flags.push(`Zone respected ${touches} times — higher-conviction level`);

  const smtCheck = checkSMT(payload, direction);
  if (smtCheck) {
    if (smtCheck.severity === "caution") {
      confidence = "MEDIUM";
      leverage = "3x-5x";
    }
    flags.push(smtCheck.text);
  }

  const rsiCaution = checkRSIExhaustion(payload, direction);
  if (rsiCaution) flags.push(rsiCaution);

  flags.push("FIB_SR strategy — independent from the OB engine. Its evidence base is separate and must not be pooled with OB results.");

  return { verdict: "TRADE", confidence, leverage, flags, rawScore };
}

function computeFibLevels(payload, direction) {
  const price = num(payload.price);
  const atr   = num(payload.atr);
  const zoneTop = num(payload.zoneTop);
  const zoneBottom = num(payload.zoneBottom);

  const entryMid = price;
  const slDist = atr > 0 ? atr * FIB_SL_ATR_MULT : price * 0.02;
  const sl = direction === "Long" ? entryMid - slDist : entryMid + slDist;
  const risk = Math.abs(entryMid - sl);

  const tp1 = direction === "Long" ? entryMid + risk * 1 : entryMid - risk * 1;
  const tp2 = direction === "Long" ? entryMid + risk * 2 : entryMid - risk * 2;
  const tp3 = direction === "Long" ? entryMid + risk * 3 : entryMid - risk * 3;

  return {
    entryZone: `${fmt(Math.min(zoneBottom, entryMid))}-${fmt(Math.max(zoneTop, entryMid))}`,
    stopLoss: fmt(sl), tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3),
    entryMidRaw: entryMid, slRaw: sl, tp1Raw: tp1, tp2Raw: tp2, tp3Raw: tp3, riskRaw: risk,
  };
}

function buildFibDecision(payload) {
  const condition = payload.condition || "";
  const direction = condition.includes("LONG") ? "Long" : "Short";
  const killzoneActive = bool(payload.killzone);

  const scoreResult = scoreFib(payload, direction);
  const gated = applyFibGates(payload, scoreResult, killzoneActive);
  if (gated.verdict === "NO_TRADE") {
    return { verdict: "NO_TRADE", reason: gated.reason, type: "FIB_" + direction.toUpperCase(), scoreResult };
  }

  const levels = computeFibLevels(payload, direction);
  if (!levels.entryMidRaw || levels.riskRaw <= 0) {
    return { verdict: "NO_TRADE", reason: "Invalid entry or zero risk distance", type: "FIB_" + direction.toUpperCase(), scoreResult };
  }

  const slDistPct = levels.riskRaw / levels.entryMidRaw * 100;
  const maxLeverage = parseInt(gated.leverage.split("-")[1], 10);
  const estLiqPct = 100 / maxLeverage;
  if (slDistPct >= estLiqPct * 0.9) {
    gated.flags.push(`⚠️ At ${maxLeverage}x, estimated liquidation distance (~${estLiqPct.toFixed(2)}%) is close to this trade's stop distance (${slDistPct.toFixed(2)}%) — you may be liquidated before the SL executes. Approximate; verify against the exchange's own calculator.`);
  }

  return { verdict: "TRADE", type: "FIB_" + direction.toUpperCase(), scoreResult, gated, levels, isSwing: false, strategy: "FIB_SR" };
}

// Evidence tracking (v19). These were prop-firm evaluation rules —
// a 30,000 VST target and a 10% hard drawdown cap. The bot is no longer
// built to pass an evaluation, so the target is now an optional personal
// goal (unset by default, in which case no profit target is reported at
// all) and the drawdown figure is the engine's own survival assumption
// rather than somebody else's rule.
const PROFIT_TARGET = Number(process.env.PROFIT_TARGET || 0);   // 0 = no target
const CHALLENGE_DAYS = Number(process.env.REVIEW_WINDOW_DAYS || 7);
const CHALLENGE_MIN_SAMPLE = 30;
const CHALLENGE_MAX_DD_PCT = MAX_STREAK_DRAWDOWN * 100;
const CHALLENGE_START = process.env.CHALLENGE_START || null;

// Sizing is no longer fixed, so the VST value of 1R must come from what the
// trade actually risked. Older records predate that field and fall back to
// the sizing that was in force when they were taken.
function vstPerR(sig) {
  if (typeof sig.riskVST === "number" && sig.riskVST > 0) return sig.riskVST;
  const margin = sig.confidence === "HIGH" ? 2000 : 900;
  const lev = sig.confidence === "HIGH" ? 15 : 10;
  return margin * lev * FIXED_SL_PCT;
}

function buildChallengeReport() {
  const all = readSignalLog();

  const start = CHALLENGE_START
    ? Date.parse(CHALLENGE_START + "T00:00:00+10:00")
    : Date.now() - CHALLENGE_DAYS * 864e5;
  const end = start + CHALLENGE_DAYS * 864e5;
  const now = Date.now();
  const dayNum = Math.min(CHALLENGE_DAYS, Math.max(1, Math.ceil((now - start) / 864e5)));
  const complete = now >= end;

  const inWindow = all.filter(s => {
    const t = Date.parse(s.loggedAt);
    return !isNaN(t) && t >= start && t < end;
  });

  const setups = dedupeBySetup(inWindow);
  const closed = setups.filter(s => isClosed(s.outcome));
  const real = closed.filter(s => isReal(s));
  const paper = closed.filter(s => !isReal(s));

  const netVST = real.reduce((a, s) => a + (Number(s.realizedR) || 0) * vstPerR(s), 0);

  const rs = closed.map(s => Number(s.realizedR) || 0);
  const expectancy = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

  const ordered = [...closed].sort((a, b) => Date.parse(a.loggedAt) - Date.parse(b.loggedAt));
  let cum = 0, peak = 0, maxDDR = 0;
  for (const s of ordered) {
    cum += Number(s.realizedR) || 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDDR) maxDDR = dd;
  }
  const avgVstPerR = real.length ? real.reduce((a, s) => a + vstPerR(s), 0) / real.length : 3000;
  const maxDDPct = (maxDDR * avgVstPerR) / 96437 * 100;

  const wins = closed.filter(s => tradeResult(s) === "win").length;
  const losses = closed.filter(s => tradeResult(s) === "loss").length;
  const symbols = [...new Set(closed.map(s => s.symbol))];
  const expired = setups.filter(s => s.outcome === "EXPIRED").length;

  const performance = PROFIT_TARGET > 0 ? {
    netVST: Number(netVST.toFixed(2)),
    target: PROFIT_TARGET,
    pctOfTarget: Number((netVST / PROFIT_TARGET * 100).toFixed(1)),
    status: complete
      ? (netVST >= PROFIT_TARGET ? "HIT" : "MISSED")
      : (netVST >= PROFIT_TARGET ? "HIT (early)" : "IN PROGRESS"),
  } : {
    netVST: Number(netVST.toFixed(2)),
    target: null,
    pctOfTarget: null,
    status: "no profit target set — P&L reported, not graded",
  };

  let verdict, note;
  if (closed.length < CHALLENGE_MIN_SAMPLE) {
    verdict = "INSUFFICIENT";
    note = `${closed.length}/${CHALLENGE_MIN_SAMPLE} resolved trades. No verdict is possible below the minimum sample regardless of P&L — a handful of winners is luck until proven otherwise.`;
  } else if (expectancy > 0.15 && maxDDPct < CHALLENGE_MAX_DD_PCT && symbols.length >= 2) {
    verdict = "STRONG";
    note = `Positive expectancy (${expectancy.toFixed(2)}R) across ${symbols.length} symbols with drawdown inside the cap. This is the result worth extending — run it again on a fresh window before trusting it.`;
  } else if (expectancy > 0) {
    verdict = "PROMISING";
    note = `Expectancy is positive (${expectancy.toFixed(2)}R) but ${maxDDPct >= CHALLENGE_MAX_DD_PCT ? "drawdown breached the cap" : "the result rests on too few symbols"}. Worth another window, not worth sizing up.`;
  } else {
    verdict = "NEGATIVE";
    note = `Expectancy is ${expectancy.toFixed(2)}R over ${closed.length} trades. That is a real answer: this configuration does not have an edge.`;
  }

  const evidence = {
    resolvedTrades: closed.length,
    minSample: CHALLENGE_MIN_SAMPLE,
    realFills: real.length,
    paperTrades: paper.length,
    wins, losses,
    winRatePct: (wins + losses) ? Number((wins / (wins + losses) * 100).toFixed(1)) : null,
    expectancyR: expectancy !== null ? Number(expectancy.toFixed(3)) : null,
    maxDrawdownPct: Number(maxDDPct.toFixed(2)),
    maxDrawdownCapPct: CHALLENGE_MAX_DD_PCT,
    symbolsTraded: symbols,
    expiredCount: expired,
    verdict, note,
  };

  return {
    day: dayNum, of: CHALLENGE_DAYS, complete,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    performance,
    evidence,
    frozen: [
      "position sizing", "leverage bands", "score thresholds",
      "risk gates", "symbol set", "strategy logic",
    ],
    readThis: "PERFORMANCE and EVIDENCE are graded separately on purpose. Crossing the P&L target does not validate the strategy, and missing it does not refute one — a week of good expectancy that lands under target is a better outcome than a large number from three trades. Nothing in this report can alter the bot's behaviour; every parameter above is frozen for the duration, which is what makes the result mean anything.",
  };
}

function formatChallengeForTelegram(c) {
  const e = c.evidence, p = c.performance;
  const bar = (pct) => {
    const n = Math.max(0, Math.min(20, Math.round(pct / 5)));
    return "█".repeat(n) + "░".repeat(20 - n);
  };

  let out = `🎯 <b>7-DAY CHALLENGE — Day ${c.day}/${c.of}</b>\n\n`;

  out += `<b>PERFORMANCE</b>\n<pre>`;
  out += `${bar(p.pctOfTarget)} ${p.pctOfTarget}%\n`;
  out += `Net      ${padL(p.netVST.toFixed(0), 9)} VST\n`;
  out += `Target   ${padL(p.target, 9)} VST\n`;
  out += `Status   ${p.status}\n`;
  out += `</pre>\n`;

  out += `<b>EVIDENCE</b>\n<pre>`;
  out += `Resolved    ${padL(e.resolvedTrades + "/" + e.minSample, 10)}\n`;
  out += `Real fills  ${padL(e.realFills, 10)}\n`;
  out += `W / L       ${padL(e.wins + " / " + e.losses, 10)}\n`;
  out += `Expectancy  ${padL(e.expectancyR !== null ? e.expectancyR + "R" : "—", 10)}\n`;
  out += `Max DD      ${padL(e.maxDrawdownPct + "%", 10)}  (cap ${e.maxDrawdownCapPct}%)\n`;
  out += `Symbols     ${padL(e.symbolsTraded.length, 10)}\n`;
  out += `Expired     ${padL(e.expiredCount, 10)}\n`;
  out += `</pre>\n`;

  const icon = { STRONG: "🟢", PROMISING: "🟡", NEGATIVE: "🔴", INSUFFICIENT: "⚪" }[e.verdict];
  out += `<b>VERDICT: ${icon} ${e.verdict}</b>\n<i>${e.note}</i>\n\n`;
  out += `🔒 Frozen: ${c.frozen.join(", ")}.\n`;
  out += `<i>P&L crossing the target is not the same as the strategy working. The verdict above is the one that carries past Sunday.</i>`;

  return out;
}

async function sendChallengeReport() {
  try {
    const c = buildChallengeReport();
    await sendTelegram(formatChallengeForTelegram(c));
    console.log(`Challenge report sent — day ${c.day}/${c.of}, ${c.evidence.verdict}`);
  } catch (err) {
    console.error("Challenge report failed (non-fatal):", err.message);
  }
}
