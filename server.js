const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// BingX demo (VST) execution — optional. If these aren't set, execution
// is silently skipped and everything else (Telegram, tracker) keeps
// working exactly as before. Demo base URL is a genuinely separate
// sandbox from live trading — confirmed via BingX's own API structure.
const BINGX_API_KEY    = process.env.BINGX_API_KEY;
const BINGX_API_SECRET = process.env.BINGX_API_SECRET;
const BINGX_BASE_URL   = "https://open-api-vst.bingx.com"; // demo/VST only, never live

// ============================================================
// OUTCOME TRACKER — v1 (new)
//
// SCOPE, DELIBERATELY: this logs every real TRADE signal fired, with
// enough fields to later match against your actual exchange trade
// history (MEXC export) by symbol + direction + approximate time. It
// does NOT poll price after firing, does NOT know whether TP/SL was
// hit, and does NOT track MFE/MAE — that's a genuinely different,
// bigger system (Tracker v2, needs a position-state-machine + continuous
// price polling) and was deliberately scoped out for now.
//
// IMPORTANT DURABILITY CAVEAT: this writes to a local file on Railway's
// filesystem, which is EPHEMERAL — a redeploy (which happens every time
// you push new code) wipes this file. This is fine for now since v1 is
// meant to be a cheap starting point, but it means: (a) don't treat this
// as a permanent record without exporting it periodically, and (b) if
// you want real durability before v2 exists, either export via the
// /signals or /signals.csv endpoints regularly, or add a Railway volume
// (persistent storage — check Railway's current docs/pricing for this,
// since it may require a paid plan) so the file survives redeploys.
// ============================================================
const SIGNAL_LOG_FILE = path.join(__dirname, "signals.jsonl");

function logSignal(decision, payload, execResult) {
  try {
    const { type, scoreResult, gated, levels, isSwing } = decision;
    const entry = {
      loggedAt: new Date().toISOString(),
      symbol: payload.symbol || "—",
      condition: payload.condition || "",
      type,
      isSwing: !!isSwing,
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
      // Execution tracking — populated only if BingX execution actually
      // succeeded and returned an order ID. This is what makes the
      // outcome-polling step below possible at all; without a real order
      // ID there's nothing to check back on.
      bingxOrderId: execResult?.bingxOrderId || null,
      bingxSymbol: execResult?.bingxSymbol || null,
      bingxTpOrderIds: execResult?.tpOrderIds || null,
      // Outcome fields — left null on purpose. Auto-filled by
      // checkOpenPositions() below once the entry order + TP orders
      // resolve, OR fillable by hand if you're cross-referencing your
      // own trade history in the meantime.
      outcome: null,       // "TP1" | "TP2" | "TP3" | "SL" | "manual_close" | "not_taken"
      realizedR: null,     // actual R multiple achieved, if known
      notes: null,
    };
    fs.appendFileSync(SIGNAL_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Logging must never break the actual signal — if this fails, the
    // Telegram message still goes out regardless
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

// ============================================================
// CLOSING THE LOOP — checkOpenPositions (new)
//
// HONEST SCOPE: this checks back on real BingX orders (via order IDs
// captured at execution time) and auto-fills the tracker's outcome
// field when a TP order actually fills. This is genuinely new — before
// tonight, nothing ever checked back on a trade after it fired.
//
// What this does NOT yet do: distinctly detect a stop-loss hit. The SL
// is attached directly to the entry order as a conditional trigger, not
// tracked as its own separately queryable order ID in the current code
// — so if none of the TPs ever fill and the position later closes, that
// most likely means SL was hit, but this version doesn't confirm that
// automatically yet. That's the next real increment, not built tonight.
//
// Field paths for reading BingX's order-status response are a
// best-informed guess, not confirmed against a real response yet —
// expect this may need a debugging round the same way order placement
// did, once it actually runs against live orders.
// ============================================================
async function checkOpenPositions() {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;
  const signals = readSignalLog();
  const openSignals = signals.filter(s => s.outcome === null && s.bingxOrderId && s.bingxSymbol);
  if (!openSignals.length) return;

  let anyUpdated = false;
  for (const sig of openSignals) {
    try {
      // First confirm the entry itself actually filled — a signal whose
      // entry never filled shouldn't be checked against TP orders at all
      const entryCheck = await bingxRequest("GET", "/openApi/swap/v2/trade/order", {
        symbol: sig.bingxSymbol, orderId: sig.bingxOrderId,
      });
      console.log(`Checked entry order ${sig.bingxOrderId} (${sig.bingxSymbol}):`, JSON.stringify(entryCheck).slice(0, 300));
      const entryOrder = entryCheck.data?.order || entryCheck.data || entryCheck;
      const entryStatus = entryOrder?.status;

      if (entryStatus === "CANCELED" || entryStatus === "EXPIRED" || entryStatus === "FAILED") {
        sig.outcome = "not_taken";
        sig.notes = "Entry order never filled.";
        anyUpdated = true;
        continue;
      }
      if (entryStatus !== "FILLED") continue; // still pending, check again next cycle

      // Entry confirmed filled — now check each TP order to see if any hit
      if (sig.bingxTpOrderIds) {
        for (const [label, orderId] of Object.entries(sig.bingxTpOrderIds)) {
          const tpCheck = await bingxRequest("GET", "/openApi/swap/v2/trade/order", {
            symbol: sig.bingxSymbol, orderId,
          });
          const tpOrder = tpCheck.data?.order || tpCheck.data || tpCheck;
          if (tpOrder?.status === "FILLED") {
            sig.outcome = label; // "TP1" | "TP2" | "TP3"
            sig.notes = `${label} order confirmed filled via BingX. SL-vs-TP distinction for remaining unresolved signals still needs the next increment (see function comment).`;
            anyUpdated = true;
            break;
          }
        }
      }
    } catch (err) {
      console.error(`Failed to check signal (order ${sig.bingxOrderId}):`, err.message);
    }
  }
  if (anyUpdated) writeSignalLog(signals);
}

// ============================================================
// STATS — aggregate breakdowns from whatever outcome data exists
// (auto-filled by checkOpenPositions above, or hand-filled by you while
// the fuller automation catches up). This is the actual "what does the
// bot lack" answer — real counts, not guesses, though small sample
// sizes early on mean don't over-read a handful of results yet.
// ============================================================
function computeStats(signals) {
  const resolved = signals.filter(s => s.outcome && s.outcome !== "not_taken");
  const withOutcome = (arr) => arr.filter(s => s.outcome);

  function winRate(arr) {
    const won = arr.filter(s => s.outcome === "TP1" || s.outcome === "TP2" || s.outcome === "TP3").length;
    const lost = arr.filter(s => s.outcome === "SL").length;
    const total = won + lost;
    return { total, won, lost, winRatePct: total > 0 ? Number((won / total * 100).toFixed(1)) : null };
  }

  const htfOpposed = resolved.filter(s => (s.flags || []).some(f => f.includes("HTF trend") && f.includes("opposes")));
  const htfAligned = resolved.filter(s => !(s.flags || []).some(f => f.includes("HTF trend") && f.includes("opposes")));
  const btcOpposed = resolved.filter(s => (s.flags || []).some(f => f.includes("BTC trend opposes")));
  const btcAligned = resolved.filter(s => !(s.flags || []).some(f => f.includes("BTC trend opposes")));
  const repeatZone = resolved.filter(s => (s.flags || []).some(f => f.includes("Repeat signal on the same zone")));
  const freshZone = resolved.filter(s => !(s.flags || []).some(f => f.includes("Repeat signal on the same zone")));

  return {
    totalLogged: signals.length,
    totalResolved: resolved.length,
    overall: winRate(resolved),
    byHtfOpposition: { opposed: winRate(htfOpposed), aligned: winRate(htfAligned) },
    byBtcOpposition: { opposed: winRate(btcOpposed), aligned: winRate(btcAligned) },
    byZoneRepeat: { repeat: winRate(repeatZone), fresh: winRate(freshZone) },
    note: "Small sample sizes early on will look noisy — this is descriptive, not statistically confirmed until each bucket has a real sample (see docs/HYPOTHESES.md).",
  };
}

function signalsToCSV(signals) {
  if (!signals.length) return "loggedAt,symbol,type,direction,rawScore,confidence,leverage,entryZone,stopLoss,tp1,tp2,tp3,htfTrend,btcTrend,smtBias,killzone,outcome,realizedR\n";
  const header = ["loggedAt","symbol","type","direction","rawScore","confidence","leverage","entryZone","stopLoss","tp1","tp2","tp3","htfTrend","btcTrend","smtBias","killzone","outcome","realizedR"];
  const rows = signals.map(s => header.map(h => {
    const v = s[h];
    if (v === null || v === undefined) return "";
    const str = String(v).replace(/"/g, '""');
    return `"${str}"`;
  }).join(","));
  return header.join(",") + "\n" + rows.join("\n") + "\n";
}

// ============================================================
// BINGX DEMO (VST) EXECUTION — new
//
// HONEST STATUS: this is built to BingX's documented API structure and
// signing scheme, but has NOT been tested against a live BingX account
// yet (no credentials available here to test with). Treat this exactly
// like every first-pass feature tonight — expect it may need a real-
// world debugging round once actual demo credentials are in place,
// same as the OB anchor logic or the zone cooldown fix both needed
// after their first live test. Don't assume it's flawless on the first
// real signal.
//
// SIZING RULE (per Krysie's instruction): execute on EVERY fired TRADE
// signal, no filtering by confidence tier or flags — the point is to
// honestly test the bot's own full range of output, not cherry-pick.
// Margin scales $900 (MEDIUM) to $2000 (HIGH), leverage scales 30x
// (MEDIUM) to 40x (HIGH). TP1/TP2/TP3 split the position 40/30/30.
// ============================================================
function bingxSign(queryString) {
  return require("crypto").createHmac("sha256", BINGX_API_SECRET).update(queryString).digest("hex");
}

async function bingxRequest(method, path, params) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  // Keys MUST be sorted (alphabetical) before building the param string —
  // this is standard convention for Binance-style signed APIs (which
  // BingX explicitly models itself on), and I'd missed it entirely until
  // now. The server reconstructs the signature from parameters in a
  // consistent order on their end; if our order doesn't match theirs,
  // the signature comes out different even with otherwise-correct values
  // — which is exactly the repeated "signature mismatch" symptom, and
  // wasn't fixed by the raw-vs-encoded change alone since that was a
  // separate, independent issue.
  const sortedKeys = Object.keys(allParams).sort();
  const rawParamString = sortedKeys.map(k => `${k}=${allParams[k]}`).join("&");
  const signature = bingxSign(rawParamString);
  const encodedParamString = sortedKeys.map(k => `${k}=${encodeURIComponent(allParams[k])}`).join("&");
  const signedString = `${encodedParamString}&signature=${signature}`;
  const fullPath = `${path}?${signedString}`;

  // Simplified back to query-string-only, no request body — sending the
  // same params in both places at once (previous attempt) is non-standard
  // for this API style and may have added its own confusion on top of
  // the ordering bug. Standard convention here is query-string-only.
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
        // Log status code + raw body every time — if this ever fails again,
        // the actual diagnosis (401 = signing/auth issue, 400 = bad params,
        // 404 = wrong path, etc.) will be right here in Railway's logs
        // instead of a generic parse error with no way to tell what happened.
        console.log(`BingX response [${res.statusCode}]:`, data.slice(0, 500));
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: "Failed to parse BingX response", statusCode: res.statusCode, raw: data });
        }
      });
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });
}

// TradingView sends "SUIUSDT" — BingX swap symbols use "SUI-USDT"
function toBingXSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.endsWith("USDT") && !symbol.includes("-")) {
    return symbol.slice(0, -4) + "-USDT";
  }
  return symbol;
}

function computeBingXSizing(confidence) {
  // Leverage lowered from the original 30x/40x bands to stay compatible
  // with the new fixed 5% SL. Liquidation is roughly 100/leverage% —
  // at the old 40x, that's ~2.5%, meaning a 5% stop would sit BEYOND
  // liquidation and the position would get liquidated before the stop
  // ever triggers, making the stop-loss purely theoretical. At 15x,
  // liquidation is ~6.7% — genuinely beyond the 5% stop with a real
  // safety margin, so the stop stays meaningful. Confidence is always
  // exactly "HIGH" or "MEDIUM" by this point (NO_TRADE signals never
  // reach execution).
  return confidence === "HIGH"
    ? { marginUSDT: 2000, leverage: 15 }
    : { marginUSDT: 900, leverage: 10 };
}

// ============================================================
// CONFIDENCE-TIER EMOJI (new) — at-a-glance indicator, most useful on
// the BingX execution confirmations specifically, since those fire for
// EVERY trade regardless of tier (execution isn't gated by the
// cleanest-tier Telegram filter), unlike the full reasoning card which
// only ever shows for the cleanest tier anyway.
// 🟢 = HIGH confidence, perfect 5/5 (the cleanest tier)
// 🟠 = HIGH confidence, 4/5 (one point short of clean)
// 🔴 = MEDIUM confidence (lowest tier that still executes)
// ============================================================
function confidenceEmoji(confidence, rawScore) {
  if (confidence === "HIGH" && rawScore === 5) return "🟢";
  if (confidence === "HIGH") return "🟠";
  return "🔴";
}

// ============================================================
// OPPOSING-POSITION CHECK (new) — prevents the exact bug that broke
// every ETH-USDT Short attempt tonight: opening a new trade while an
// existing OPPOSITE-direction position is still open on the same
// symbol. In One-way mode, the new order nets against the existing
// position instead of opening cleanly, which made the TP orders (sized
// for a fresh position) get rejected with "Reduce Only order can only
// decrease the position." Rather than try to model every netting edge
// case, the safe choice is: skip the new trade entirely if an opposing
// position already exists, and log/notify why.
//
// FAILS CLOSED on purpose: if this check itself errors (network issue,
// unexpected response shape), the trade is skipped rather than risking
// a repeat of the exact bug this exists to prevent. A missed trade from
// a transient hiccup is a much smaller cost than silently reintroducing
// the failure this was built to catch.
//
// Field names for reading the position response are a best-informed
// guess (same caveat as every other BingX integration piece tonight) —
// expect this may need a small adjustment once it runs against a real
// response, same pattern as order placement did.
// ============================================================
async function getOpenPosition(symbol) {
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/user/positions", { symbol });
    console.log(`BingX position check for ${symbol}:`, JSON.stringify(res).slice(0, 500));
    const positions = Array.isArray(res.data) ? res.data : [];
    const active = positions.find(p => {
      const amt = parseFloat(p.positionAmt ?? p.positionAmount ?? 0);
      return amt !== 0;
    });
    if (!active) return { checked: true, existing: null };
    const amt = parseFloat(active.positionAmt ?? active.positionAmount ?? 0);
    return { checked: true, existing: { direction: amt > 0 ? "Long" : "Short", amt } };
  } catch (err) {
    console.error(`Position check failed for ${symbol} (non-fatal, failing closed):`, err.message);
    return { checked: false, existing: null };
  }
}

async function executeOnBingX(decision, payload) {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return; // not configured — silent no-op, nothing else affected

  try {
    const { scoreResult, gated, levels } = decision;
    const symbol = toBingXSymbol(payload.symbol);
    const direction = scoreResult.direction; // "Short" | "Long"

    // Check for an existing opposing position BEFORE doing anything else
    const positionCheck = await getOpenPosition(symbol);
    if (!positionCheck.checked) {
      await sendTelegram(`⚠️ <b>BingX execution skipped</b>\nSymbol: ${symbol}\nCould not verify current position (failing closed to avoid the opposing-position bug) — trade not placed.`);
      return;
    }
    if (positionCheck.existing && positionCheck.existing.direction !== direction) {
      console.log(`Skipping ${symbol} ${direction} — existing opposing ${positionCheck.existing.direction} position open`);
      await sendTelegram(`🔕 <b>BingX execution skipped</b>\nSymbol: ${symbol}\nSignal: ${direction}, but an existing ${positionCheck.existing.direction} position is already open on this symbol — opening now would net against it and break TP placement (the exact bug from earlier tonight). Skipped intentionally.`);
      return;
    }

    // A signal already flagged as a same-zone REPEAT is explicitly lower
    // conviction by design (that's the whole point of the flag) — it
    // shouldn't be allowed to silently keep adding fresh capital to an
    // already-open position just because the direction matches. Without
    // this check, repeated re-tests of the same zone can quietly stack a
    // position's real size and margin far beyond what any single
    // signal's own confidence tier was ever sized for — exactly what
    // happened with the SUIUSDT position that grew to 7 stacked entries
    // and ~7x its intended per-signal margin.
    const isRepeatZone = gated.flags.some(f => f.includes("Repeat signal on the same zone"));
    if (isRepeatZone && positionCheck.existing) {
      console.log(`Skipping ${symbol} ${direction} — repeat-zone signal, position already open (${positionCheck.existing.direction}, avoiding uncontrolled stacking)`);
      await sendTelegram(`🔕 <b>BingX execution skipped</b>\nSymbol: ${symbol}\nSignal: ${direction} (repeat-zone, lower conviction) — a ${positionCheck.existing.direction} position is already open on this symbol. Not adding more capital to it; the repeat-zone flag exists precisely to avoid treating this as a fresh, independently-sized trade.`);
      return;
    }

    // positionSide is ALWAYS "BOTH" for a One-way mode account — LONG/SHORT
    // values are only valid in Hedge Mode (which allows simultaneous long +
    // short positions on the same symbol). In One-way mode, direction is
    // controlled purely by "side" (BUY/SELL), which is exactly what the
    // "In the One-way mode, the 'PositionSide' field can only be set to
    // BOTH" rejection was telling us.
    const positionSide = "BOTH";
    const entrySide = direction === "Short" ? "SELL" : "BUY";
    const exitSide = direction === "Short" ? "BUY" : "SELL"; // opposite side, reduceOnly, to close

    const { marginUSDT, leverage } = computeBingXSizing(gated.confidence);
    const entryPrice = levels.entryMidRaw;
    if (!entryPrice || entryPrice <= 0) {
      console.error("BingX execution skipped — invalid entry price", entryPrice);
      return;
    }
    const notional = marginUSDT * leverage;
    // Known simplification: quantity precision varies per symbol on BingX
    // and isn't queried here (would need an extra exchangeInfo call per
    // symbol). Rounded to 3 decimals as a reasonable default — if BingX
    // rejects an order for invalid precision on a specific symbol, this
    // is the first place to look.
    const quantity = Number((notional / entryPrice).toFixed(3));

    // 1) Set leverage for this symbol/position side before opening
    const leverageRes = await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", {
      symbol, side: positionSide, leverage,
    });
    console.log("BingX set leverage:", JSON.stringify(leverageRes));

    // 2) Open the position — market entry with stop-loss attached directly
    // (real protection from the moment the order fills, not a separate
    // call placed after — avoids a gap where the position is briefly
    // unprotected)
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

    // 3) Partial take-profit orders — 40% at TP1, 30% at TP2, 30% at TP3,
    // each a separate reduce-only LIMIT order (BingX's own takeProfit
    // param only supports a single price, not a 3-tier split)
    const tp1Qty = Number((quantity * 0.4).toFixed(3));
    const tp2Qty = Number((quantity * 0.3).toFixed(3));
    const tp3Qty = Number((quantity - tp1Qty - tp2Qty).toFixed(3)); // remainder, avoids rounding leftover

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
        reduceOnly: true,
      });
      tpResults.push(`${tp.label}: ${res.code === 0 ? "placed" : JSON.stringify(res).slice(0, 100)}`);
      // Capture the TP order's ID too — this is what makes it possible to
      // later tell WHICH target actually got hit, not just whether the
      // entry filled. Field path is a best guess pending confirmation
      // against a real response (same caveat as the entry order ID below).
      const tpOrderId = res.data?.order?.orderId ?? res.orderId ?? null;
      if (tpOrderId) tpOrderIds[tp.label] = tpOrderId;
    }

    await sendTelegram(`${confidenceEmoji(gated.confidence, scoreResult.rawScore)} <b>BingX demo execution</b>\n${symbol} ${direction} │ ${marginUSDT} VST margin │ ${leverage}x\nQty: ${quantity}\n${tpResults.join("\n")}`);
    console.log("BingX execution complete", symbol, direction, "| TP results:", tpResults);
    // Return the entry order's ID + BingX symbol so the tracker can log
    // them — this is what actually makes checking back on the trade
    // possible at all. Without this, execution and tracking were two
    // completely disconnected systems with no way to reconnect them later.
    return { bingxOrderId: entryRes.data?.order?.orderId ?? entryRes.orderId ?? null, bingxSymbol: symbol, tpOrderIds };
  } catch (err) {
    console.error("BingX execution error (non-fatal):", err.message);
    try { await sendTelegram(`⚠️ <b>BingX execution error:</b> ${err.message}`); } catch {}
    return null;
  }
}

// ============================================================
// ARCHITECTURE NOTE (v10)
// Score, direction, confidence, leverage, and entry/SL/TP levels are
// ALL computed by deterministic code below — never by an LLM. Claude's
// only role is to explain an already-final decision in plain language.
// This exists because LLM output is not perfectly reproducible run to
// run, which is fine for writing an explanation but not for being the
// decision engine itself when real risk is attached.
//
// This is SIGNAL-ONLY. Nothing in this file places, modifies, or closes
// an order on any exchange — it only sends Telegram messages. Adding
// real execution would be a deliberate, separate decision, not something
// bundled in here.
// ============================================================

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function bool(v) { return v === true || v === "true"; }

// ============================================================
// DEDUP CACHE (v10.1) — blocks duplicate signals from triggering
// duplicate Claude API calls / Telegram sends. Same symbol + condition
// + price arriving again within DEDUP_WINDOW_MS is treated as a repeat
// of the same real-world event (e.g. multiple stale TradingView alerts
// all firing for one price move) and silently dropped before any cost
// is incurred. This is a safety net, not the root fix — the root fix
// is having exactly one active TradingView alert per symbol.
// ============================================================
const recentSignals = new Map(); // key -> last-seen timestamp (ms)
const DEDUP_WINDOW_MS = 30000; // 30 seconds

function isDuplicateSignal(payload) {
  const key = `${payload.symbol || ""}|${payload.condition || ""}|${payload.price || ""}`;
  const now = Date.now();
  const last = recentSignals.get(key);
  // prevent unbounded memory growth over a long-running process
  if (recentSignals.size > 500) recentSignals.clear();
  recentSignals.set(key, now);
  if (last && (now - last) < DEDUP_WINDOW_MS) return true;
  return false;
}

// ============================================================
// ZONE COOLDOWN (new) — catches a real gap the exact-price dedup above
// doesn't: the SAME OB zone re-confirming on consecutive 15M candles
// with slightly different prices each time (so exact-dedup never
// triggers), while a checklist point that's failing (usually delta)
// stays failing the whole time. Without this, confidence can silently
// escalate between repeats just because a momentary flag (like an SMT
// tag) aged out of visibility, even though nothing underlying actually
// improved. This does NOT block the repeat signal — it flags it and
// forces confidence back to MEDIUM, since a zone that needs multiple
// consecutive attempts to "confirm" is inherently lower-conviction,
// not higher, regardless of what any single bar's flags say.
// ============================================================
const recentZones = new Map(); // key -> { count, firstSeen }
const ZONE_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

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

// ============================================================
// SIGNAL HISTORY (for /dashboard) — in-memory only, resets on restart.
// This is NOT the outcome tracker (no win/loss/fill data — that's a
// separate, bigger build). This just gives a real, styled view of what
// fired recently, since Telegram genuinely cannot render color, layout,
// or history the way a browser page can.
// ============================================================
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

// ============================================================
// SIGNAL CLASSIFICATION
// ============================================================
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

// ============================================================
// DETERMINISTIC CHECKLIST SCORING
// Strict binary (0 or 1) on every point except BTC confirmation, which
// permits exactly 0.5 for an explicitly neutral BTC trend. No other
// partial credit exists anywhere in this file.
// ============================================================
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

  // Point 1: liquidity sweep — swing point sits beyond the OB, implying
  // price swept past it before the reversal into the zone
  const p1 = direction === "Short"
    ? (obTop > 0 && swingRef > obTop)
    : (obBottom > 0 && swingRef > 0 && swingRef < obBottom);
  points.push({ n: 1, label: "Liquidity sweep", pass: p1 ? 1 : 0,
    detail: p1 ? `Swing ${direction === "Short" ? "high" : "low"} $${swingRef} confirms sweep beyond OB` : "No confirmed sweep beyond OB" });

  // Point 2: delta flip — meaningfully directional, not just nonzero
  const p2 = direction === "Short" ? cumDelta < -50000 : cumDelta > 50000;
  points.push({ n: 2, label: "Delta flip", pass: p2 ? 1 : 0, detail: `cumDelta ${cumDelta}` });

  // Point 3: MSS confirmed in trade direction
  const p3 = (direction === "Short" && mssDir === "Down") || (direction === "Long" && mssDir === "Up");
  points.push({ n: 3, label: "MSS confirmed", pass: p3 ? 1 : 0, detail: `mssDir=${mssDir}` });

  // Point 4: BTC confirmation
  const btc = scoreBTC(payload, direction);
  points.push({ n: 4, label: "BTC confirmation", pass: btc.score, detail: btc.detail });

  // Point 5: retest holding — guaranteed by the alert only firing on a
  // confirmed close-inside-zone rejection candle, gated on mitigation
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
  // Points 1-3 are guaranteed true by the Pine script's own gating — it
  // only fires this alert once MSS + volume-spike displacement happened
  // AND the pullback held in the fib zone AND a rejection candle closed.
  // The only thing to actually verify here is that the structural data
  // needed to trade it safely actually came through.
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

// ============================================================
// RISK GATES — kill zone threshold, BTC/HTF opposition, mitigation kill
// ============================================================
// ============================================================
// SMT + RSI CHECKS (new) — these were being computed and sent to
// Claude for narrative color, but never actually enforced. Now they
// carry real weight: SMT opposition gets the same treatment as
// BTC/HTF opposition (this is a documented "never violate" lesson,
// not a soft suggestion), RSI exhaustion is a softer flag-only caution.
// ============================================================
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

  const threshold = killzoneActive ? 3.5 : 4;
  if (rawScore < threshold) {
    return { verdict: "NO_TRADE", reason: `Score ${rawScore}/5 below ${threshold} threshold (killzone active: ${killzoneActive})` };
  }

  let confidence = rawScore >= 4 ? "HIGH" : "MEDIUM";
  // Swing signals use a separate 30x-70x band, untouched — their SL
  // formula (computeSwingLevels) wasn't changed, still OB-height-based.
  // Non-swing (plain scalp) bands lowered from the old 10x-80x range
  // because the SL is now a fixed 5% price distance (per Krysie's
  // formula) instead of a structural OB-height stop. At the old 50x-80x,
  // liquidation (~100/leverage%) sits well INSIDE a 5% stop, meaning
  // the position would get liquidated before the stop-loss could ever
  // trigger — making the stop purely theoretical. These bands keep
  // liquidation genuinely beyond the 5% stop with real safety margin.
  let leverage = isSwing
    ? (confidence === "HIGH" ? (rawScore === 5 ? "50x-70x" : "30x-50x") : "30x-40x")
    : (confidence === "HIGH" ? (rawScore === 5 ? "12x-15x" : "8x-12x") : "5x-8x");
  const floorLeverage = isSwing ? "30x-40x" : "5x-8x";

  const flags = [];
  const htfTrend  = payload.htfTrend || "Unknown";
  const htfOpposes = (direction === "Short" && htfTrend === "Bullish") || (direction === "Long" && htfTrend === "Bearish");

  if (btcOpposes) {
    confidence = "MEDIUM";
    leverage = floorLeverage;
    flags.push("BTC trend opposes signal direction — HIGH RISK");
  }
  if (htfOpposes) {
    confidence = "MEDIUM";
    if (leverage !== floorLeverage) leverage = floorLeverage;
    flags.push(`HTF trend (${htfTrend}) opposes signal direction — headwind`);
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

  // Market regime check (v14, new) — INFORMATIONAL ONLY, does not cap
  // confidence or leverage. Unlike BTC/HTF/SMT opposition (carried-over
  // principles already held before tonight), this is a NEW hypothesis
  // (see docs/HYPOTHESES.md H-005) — it gets surfaced for you to see and
  // for the tracker to eventually check against real outcomes, but it
  // does not get to silently change trade sizing until real data
  // actually confirms it matters.
  const regime = payload.marketRegime || "Unknown";
  if (!isBreakout && regime === "Trending") {
    flags.push(`Market regime: Trending (ADX ${payload.adxValue || "?"}) — this is a mean-reversion (OB) setup firing against a strong trend, informational only (H-005, unvalidated)`);
  }
  if (isBreakout && regime === "Choppy") {
    flags.push(`Market regime: Choppy (ADX ${payload.adxValue || "?"}) — breakout/continuation setups are more prone to failure without real trend backing, informational only (H-005, unvalidated)`);
  }

  // Parse the top of whichever band got assigned dynamically, instead of
  // hardcoding every possible string — works for both scalp and swing bands
  const topOfBand = parseInt(leverage.split("-")[1], 10);
  if (topOfBand > 40) flags.push("Leverage range extends above 40x — a small adverse wick can liquidate before SL triggers, size accordingly");

  return { verdict: "TRADE", confidence, leverage, flags, rawScore };
}

// ============================================================
// DETERMINISTIC LEVEL CALCULATION
// ============================================================
function fmt(n) { return `$${n.toFixed(4)}`; }

// ============================================================
// SWING LEVELS (v12, new) — same entry/SL as the base OB signal (the
// 15M OB is still the real structural invalidation point regardless of
// intended hold time), but a much wider R-multiple TP ladder, since
// 1H structure agreement justifies expecting a bigger move than a
// pure 15M scalp. TP3 snaps to the real 1H swing high/low when one
// sits beyond the formulaic target — genuine S/R, not just a number.
// ============================================================
// ============================================================
// STRUCTURE SNAPPING (new) — R-multiples act as a MINIMUM floor, not
// an exact target. If a genuine structural level (a real swing point,
// an OB zone edge) sits between the floor and the next tier's floor,
// use it instead of the raw formula. This is why the actual R-multiple
// hit can vary trade to trade (3.1R here, 3.6R there) — it's snapping
// to what's really on the chart, not guessing a score. No invented
// weights anywhere in this function.
// ============================================================
function snapToStructure(direction, floorLevel, nextFloorLevel, candidates) {
  const valid = candidates.filter(c => c > 0);
  if (direction === "Short") {
    // Looking for a real level at or beyond the floor (lower price) but
    // not as far as the next tier's floor — the least extreme candidate
    // in that zone is the honest, nearest real target
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

    const tp1Floor = entryMid - risk * 3; // minimum acceptable reward, not the exact exit
    const tp2Floor = entryMid - risk * 5;
    const tp3Floor = entryMid - risk * 8;

    // Real structural candidates that could sit between each tier —
    // 15M OB/POB edges, 15M swing low, 1H swing low, 4H swing low
    const tp1Candidates = [num(payload.pobTop), num(payload.pobBottom), num(payload.swingLow)];
    const tp1 = snapToStructure("Short", tp1Floor, tp2Floor, tp1Candidates);

    const tp2Candidates = [num(payload.swingLow), swingLow1h];
    const tp2 = snapToStructure("Short", tp2Floor, tp3Floor, tp2Candidates);

    // TP3 keeps the same logic as before — snap to 1H structure if
    // genuinely beyond TP2, otherwise use the formulaic 8R floor
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

// Fixed stop-loss %, applied as a straight price distance regardless of
// leverage — same rule at 2x or 40x, per Krysie's formula ("5% of your
// leveraged amount" mathematically reduces to a flat 5% price move,
// since leverage only changes how much of your margin that % represents,
// not the price distance itself). Kept as a named constant since it's
// referenced from more than one place (levels + leverage sizing).
const FIXED_SL_PCT = 0.05;

function computeOBLevels(payload, direction) {
  if (direction === "Short") {
    const obTop = num(payload.obTop), obBottom = num(payload.obBottom);
    const pobTop = num(payload.pobTop), pobBottom = num(payload.pobBottom);
    const swingLow = num(payload.swingLow);
    const entryMid = (obTop + obBottom) / 2;
    // Fixed 5% SL instead of OB-height × 1.5 — this is also why TP1/2/3
    // now come out meaningfully wider: they're R-multiples of THIS risk,
    // and a narrow OB used to make risk (and everything downstream) tiny.
    const sl = entryMid * (1 + FIXED_SL_PCT);
    const risk = sl - entryMid;
    // R-multiples are the FLOOR (minimum distance), not a target to snap
    // toward loosely. A structural level only replaces the floor if it's
    // genuinely BEYOND that floor — comparing against entryMid alone (the
    // old bug) let TP1 land inside the entry zone itself whenever a nearby
    // +OB happened to sit between obBottom and entryMid, which is exactly
    // the "already hit before you're even filled" problem.
    const tp1Floor = entryMid - risk;
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
    const tp1Floor = entryMid + risk;
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

// ============================================================
// DECISION ORCHESTRATOR — the one function that decides everything.
// No LLM call anywhere in this function. Fully reproducible: same
// payload in, same decision out, every time.
// ============================================================
function buildDecision(payload) {
  const condition = payload.condition || "";
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

  // -- Zone cooldown check (new) — only applies to OB-based types, since
  // breakout signals use a transient impulse leg rather than a fixed
  // zone that can genuinely "re-test." A repeat on the same zone within
  // the cooldown window means the setup has needed multiple attempts to
  // hold — that's lower conviction, not higher, regardless of what any
  // single bar's checklist/flags say. This intentionally OVERRIDES any
  // confidence escalation a momentary flag aging out might have allowed.
  if (type.startsWith("OB_")) {
    const zoneCheck = checkZoneCooldown(payload, direction);
    if (zoneCheck.isRepeat) {
      gated.confidence = "MEDIUM";
      const topOfBand = parseInt(gated.leverage.split("-")[1], 10);
      if (topOfBand > 40) gated.leverage = floorLeverage;
      gated.flags.push(`Repeat signal on the same zone (attempt #${zoneCheck.count} within the cooldown window) — needing multiple retests to hold is a lower-conviction sign, confidence capped regardless of this bar's individual flags`);
    }
  }

  const levels = isSwing
    ? computeSwingLevels(payload, direction)
    : type.startsWith("OB_")
      ? computeOBLevels(payload, direction)
      : computeBreakoutLevels(payload, direction);

  // -- Liquidation buffer check (new) — compares actual SL distance
  // against the ESTIMATED liquidation distance at the top of the
  // assigned leverage band. This is an approximation (isolated margin,
  // ignoring maintenance margin/fees/funding, which vary by exchange)
  // — not a guarantee. It's checked at the top of the band specifically
  // because that's the riskier case if someone picks max leverage from
  // within the suggested range.
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

// ============================================================
// CLAUDE AS EXPLAINER — not decision-maker. Given the fully-computed
// decision above, Claude's only job is to write 1-2 sentences of plain
// -language reasoning. It cannot change score, direction, confidence,
// leverage, or any price level — those are already final by the time
// this function is called.
// ============================================================
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
    model: "claude-sonnet-4-6",
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
          resolve((parsed.content?.[0]?.text || "").trim() || "Deterministic checklist cleared threshold — see score breakdown above.");
        } catch {
          resolve("Deterministic checklist cleared threshold — see score breakdown above.");
        }
      });
    });
    // If Claude is down/errors, the trade signal still sends — explanation
    // just falls back to a generic line. The decision itself never depends
    // on this call succeeding.
    req.on("error", () => resolve("Deterministic checklist cleared threshold — see score breakdown above."));
    req.write(body);
    req.end();
  });
}

// ============================================================
// LEGACY PATH — manual level crosses only (cross_manual_level1/2/3).
// These were never part of the 5-point checklist system (they're simple
// price crosses, not structural setups), so they keep the old
// full-prompt-decides-everything approach rather than being force-fit
// into the deterministic engine above.
// ============================================================
const LEGACY_SYSTEM_PROMPT = `You are a professional crypto futures trade signal generator. A manual price level the trader marked has just been crossed. Give a brief, honest read: is this level crossing significant given the RSI, delta, and session context provided, or likely noise? Keep it to 2-3 sentences. Do not fabricate a full trade plan with entry/SL/TP for a simple level cross — that requires the structural checklist, which doesn't apply here.`;

async function generateLegacyNote(payload) {
  const userMessage = `Manual level crossed. Condition: ${payload.condition}. Symbol: ${payload.symbol}. Price: $${payload.price}. RSI: ${payload.rsi}. Cumulative Delta: ${payload.cumDelta}. Session: ${payload.session}. Kill zone active: ${payload.killzone}.`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
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
          resolve((parsed.content?.[0]?.text || "").trim() || "No commentary available.");
        } catch { resolve("No commentary available."); }
      });
    });
    req.on("error", () => resolve("No commentary available."));
    req.write(body);
    req.end();
  });
}

// ============================================================
// Send Telegram message
// ============================================================
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

// ============================================================
// Format the incoming alert header (fires immediately)
// ============================================================
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

// ============================================================
// Format the final trade setup — score/levels are already final by
// this point; reasoning is the only Claude-generated piece.
// ============================================================
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
  const titleTag = isSwing ? " 🌙" : "";

  // Actual R-multiple achieved at each target — computed from real
  // levels, not a fixed label. This is what actually varies trade to
  // trade (3.1R here, 3.6R there) when a real structural level sits
  // closer than the raw multiple would have reached.
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

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200); res.end("Trade alert server v10 — deterministic scoring, Claude explains only, signal-only (no execution) ✅"); return;
  }

  // -- Outcome tracker v1 export endpoints (new). Visit these in a
  // browser or curl to pull everything logged so far — worth doing
  // periodically given Railway's filesystem is ephemeral (a redeploy
  // wipes this file), so treat these as "export before you forget",
  // not a permanent archive.
  if (req.method === "GET" && req.url === "/signals") {
    const signals = readSignalLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: signals.length, signals }, null, 2));
    return;
  }
  if (req.method === "GET" && req.url === "/signals.csv") {
    const signals = readSignalLog();
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=signals.csv" });
    res.end(signalsToCSV(signals));
    return;
  }
  if (req.method === "GET" && req.url === "/stats") {
    const signals = readSignalLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(computeStats(signals), null, 2));
    return;
  }

  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { condition: body }; }

      // Respond to TradingView IMMEDIATELY (before any processing)
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));

      try {
        const condition = payload.condition || "";

        // DEDUP CHECK — must run before ANY branch below, since every branch
        // (WATCH, main decision, legacy) can call Claude or send Telegram.
        // A duplicate here means zero further processing of any kind.
        if (isDuplicateSignal(payload)) {
          console.log("Duplicate signal within dedup window — skipping ⏭️", new Date().toISOString(), "| condition:", condition, "| symbol:", payload.symbol, "| price:", payload.price);
          return;
        }

        // WATCH TIER — HTF proximity heads-ups. No scoring, no Claude call,
        // just a direct low-cost ping. Forward-looking context only.
        if (condition === "WATCH_HTF_RESISTANCE_NEARBY" || condition === "WATCH_HTF_SUPPORT_NEARBY") {
          const zoneType = condition === "WATCH_HTF_RESISTANCE_NEARBY" ? "resistance" : "support";
          const htfLevel = condition === "WATCH_HTF_RESISTANCE_NEARBY" ? payload.htfSwingHigh : payload.htfSwingLow;
          await sendTelegram(`👀 <b>WATCH — HTF ${zoneType} nearby</b>
Symbol: ${payload.symbol || "—"}
Price: $${payload.price} approaching HTF ${zoneType} at $${htfLevel}
HTF Trend: ${payload.htfTrend || "Unknown"}
This is a heads-up only, not a trade plan — watch for an actual 15M rejection/confirmation before acting.`);
          console.log("HTF watch alert sent 👀", new Date().toISOString(), "| condition:", condition);
          return;
        }

        // MAIN DECISION — fully deterministic, no LLM involved in the
        // score/direction/confidence/leverage/levels at all
        const decision = buildDecision(payload);

        if (decision.verdict === "UNRECOGNIZED") {
          const legacyConditions = ["cross_manual_level1", "cross_manual_level2", "cross_manual_level3"];
          if (!legacyConditions.some(s => condition.includes(s))) {
            console.log("Low priority / unrecognized signal — skipping ⏭️", new Date().toISOString(), "| condition:", condition);
            return;
          }
          // Legacy manual-level-cross path — commentary only, no fabricated levels
          const note = await generateLegacyNote(payload);
          await sendTelegram(`🔔 <b>Manual Level Cross</b>
Symbol: ${payload.symbol || "—"} | Price: $${payload.price}
${note}`);
          console.log("Legacy manual-cross note sent 🔔", new Date().toISOString(), "| condition:", condition);
          return;
        }

        if (decision.verdict === "NO_TRADE") {
          console.log("No trade (deterministic) — complete silence ⏭️", new Date().toISOString(), "| condition:", condition, "| reason:", decision.reason);
          return;
        }

        // TRADE — score/levels are already final. Claude only explains.
        // Tracking and execution ALWAYS run, regardless of tier — this
        // keeps the honest full-range testing intact. Only the Telegram
        // notification is gated, so MEDIUM/flagged signals stop reaching
        // your phone as a "should I take this" decision, without hiding
        // them from the tracker or BingX.
        //
        // UPDATED per Krysie's request: send BOTH Medium and HIGH tier
        // signals now, not just the cleanest tier. The card already
        // shows the full checklist + risk flags clearly, so she can
        // read those notes herself and decide whether to take each
        // trade, rather than the bot silently pre-filtering. This is a
        // deliberate reversal of the earlier "cleanest tier only"
        // change — not a bug, a preference change.
        const reasoning = await explainDecision(decision, payload);
        const header = formatAlertHeader(payload);
        await sendTelegram(header);
        const planMsg = formatTradeSetup(decision, payload, reasoning);
        await sendTelegram(planMsg);
        const execResult = await executeOnBingX(decision, payload);
        logSignal(decision, payload, execResult);

        console.log("Trade signal — alert sent + executed ✅", new Date().toISOString(), "| condition:", condition, "| score:", decision.scoreResult.rawScore, "/5", "| confidence:", decision.gated.confidence);
      } catch (err) {
        console.error("Error:", err.message);
        try { await sendTelegram(`⚠️ <b>Bot error:</b> ${err.message}`); } catch {}
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`Server v10 running on port ${PORT}`));

// Check open positions every 15 minutes — frequent enough to catch
// outcomes reasonably promptly, infrequent enough not to hammer BingX's
// API for what's likely a small number of open signals at any given time.
setInterval(() => {
  checkOpenPositions().catch(err => console.error("checkOpenPositions failed (non-fatal):", err.message));
}, 15 * 60 * 1000);
