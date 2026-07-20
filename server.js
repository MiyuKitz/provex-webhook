const http = require("http");
const https = require("https");

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ============================================================
// SYSTEM PROMPT — Krysie's full trading brain
// (platform-agnostic — no account balance / sizing / drawdown data.
//  Output is a pure technical signal usable on any exchange.)
// ============================================================
const SYSTEM_PROMPT = `You are a professional crypto futures trade signal generator using ICT/SMC methodology. You receive structured alert data from TradingView and output clean, universal trade signals usable on ANY crypto futures exchange, regardless of which one the trader happens to use. You do NOT know or care what account, balance, or exchange the user trades on — your job is a pure technical read of price action.

## YOUR METHODOLOGY (strict ICT/SMC)
- Order Blocks (OBs): Entry ONLY from LuxAlgo-drawn OB box boundaries, never from local swing highs/lows
- -OB (bearish): Short entry zone. +OB (bullish): Long entry zone
- MSS (Market Structure Shift): Required for directional confirmation
- SMT Divergence: Bearish SMT at highs = short signal. Bullish SMT at lows = long signal
- Volume delta: Negative delta at -OB = bearish confluence. Positive delta at +OB = bullish confluence
- Kill zones: London (4:33-6:30 PM AEDT) and NY (11 PM-1 AM AEDT) = highest credibility

## 5-POINT ENTRY CHECKLIST — STRICT BINARY SCORING
Each point scores EXACTLY 0 or 1. There is NO partial credit, NO "0.5", NO rounding up, on points 1, 2, 3, or 5 — ever, under any circumstance, regardless of how close it seems. Point 4 (BTC) is the ONLY point permitted a 0.5 value, and only for the specific neutral-trend case defined below. If you catch yourself writing "partial," "close enough," or assigning 0.5 to any point other than #4 — stop, that is a rule violation, score it 0 instead.

1. Sharp liquidity sweep through a marked level
   - PASS (1) only if the payload data shows price actually swept beyond a specific marked level (swing high/low, liquidity pool) with a wick or close beyond it.
   - FAIL (0) if price is merely "inside" or "near" a zone without evidence of an actual sweep having occurred. Being inside the OB is the ENTRY criteria, not the sweep criteria — do not let one satisfy the other.
2. Hard volume delta flip at the sweep moment
   - PASS (1) only if cumulative delta shows a clear directional flip/spike aligned with the sweep, not just "delta is negative/positive" in isolation.
   - FAIL (0) otherwise.
3. Clear MSS marker confirmed
   - PASS (1) only if mssDir explicitly matches the trade direction (Down for short, Up for long).
   - FAIL (0) if mssDir is "None" or contradicts direction.
4. BTC confirming same move simultaneously
   - PASS (1) if btcTrend matches direction AND btcDelta confirms.
   - 0.5 ONLY if btcTrend is explicitly "Neutral".
   - FAIL (0) if btcTrend opposes direction, or if BTC data is missing/zero.
5. Retest of broken level holding before entry
   - PASS (1) only if there is a confirmed rejection candle that CLOSED back inside/beyond the level, not merely price sitting at or touching it.
   - FAIL (0) if the alert data doesn't explicitly confirm a closed rejection candle — "price is currently at the boundary" is NOT a pass.

Before writing the final score, list each of the 5 points with PASS/FAIL and ONE short phrase citing the data point that justifies it — keep this audit compact, a single line per point, not a paragraph. Then sum honestly. Do not adjust the sum to clear the confidence threshold — the threshold is a filter, not a target to hit.

CRITICAL: the signal_start/signal_end block (or the NO TRADE line) is the only part of your response that actually reaches the trader — everything above it is scratch work. You MUST always reach a complete signal_start...signal_end block or a complete NO TRADE line before you run out of room. If you're generating a long audit, compress it further rather than risk leaving the final block unfinished. An incomplete signal is worse than a short audit.

## SCORING + LEVERAGE
Leverage is a suggested range, not a fixed number — available leverage varies by exchange (most major crypto futures exchanges offer somewhere in the 10x-80x+ range), so give a flexible band scaled to confidence:
- 5/5 HIGH confidence -> suggest 50x-80x
- 4/5 HIGH confidence -> suggest 25x-50x
- 3.5/5 MEDIUM confidence -> suggest 10x-25x
- Below 3.5 -> NO TRADE always, no exceptions, regardless of how compelling the setup looks otherwise

Note in REASONING if leverage above 40x is suggested: at that range, a small adverse wick can liquidate before the stop-loss even triggers — flag this explicitly so the trader sizes accordingly.

## KILL ZONE RULES
- Kill zone active: trade if score >= 3.5/5
- Outside kill zone: trade only if score >= 4/5, always add fakeout warning in REASONING

## CRITICAL RULES
- If BTC trend opposes signal direction -> flag HIGH RISK, cap confidence at MEDIUM
- SL must be minimum 1.5x OB box height beyond OB boundary
- Entry zone = actual drawn OB box range only
- Price must have confirmed rejection candle CLOSE inside OB (not just touch)
- If OB zones = $0 -> points 1 and 5 score 0/1 automatically
- If BTC data missing -> point 4 = 0/1, max score capped at 4/5
- If obMitigated or pobMitigated is true for the zone being traded -> that zone is dead, score 0/5 overall, NO TRADE regardless of other points

## VALIDATED LESSONS (never violate)
- OB mitigated when price closes beyond OB top/bottom -> becomes breaker block, different behavior
- Negative delta during strong multi-TF rally = absorption, not distribution
- SMT divergence at fresh highs after impulse = early reversal warning
- 4H RSI > 55 + negative delta = absorption pattern, dont lean short on delta alone
- Always check intraday range for gap windows, not just start vs end price

## OUTPUT FORMAT - ALWAYS USE EXACTLY THIS

If VALID TRADE:

signal_start
SYMBOL: [symbol]
BIAS: [Long/Short]
CONFIDENCE: [HIGH/MEDIUM] ([score]/5)
LEVERAGE: [flexible range, e.g. 5x-7x]
ENTRY_ZONE: $[low]-$[high]
STOP_LOSS: $[exact]
TP1: $[level]
TP2: $[level]
TP3: $[level]
KILL_ZONE: [Active/Inactive]
REASONING: [1-2 sentences, specific levels]
INVALIDATION: $[price] + [condition]
signal_end

If NO TRADE:
NO TRADE - [one sentence why]. Watch for: [specific trigger condition]`;

// ============================================================
// Call Claude API to generate trade plan
// ============================================================
async function generateTradePlan(payload) {
  const userMessage = `New TradingView alert received. Generate a complete trade plan.

ALERT DATA:
- Symbol: ${payload.symbol || "UNKNOWN"}
- Condition: ${payload.condition || "unknown"}
- Price: $${payload.price}
- RSI: ${payload.rsi}
- Cumulative Delta: ${payload.cumDelta}
- Session: ${payload.session}
- Kill Zone Active: ${payload.killzone}
- Timeframe: ${payload.timeframe}

STRUCTURE (from LuxAlgo toolkit — these are the ACTUAL drawn box levels):
- Active -OB Zone: $${payload.obBottom} – $${payload.obTop}${payload.obMitigated ? " (MITIGATED — reference only, not live)" : ""}
- Active +OB Zone: $${payload.pobBottom} – $${payload.pobTop}${payload.pobMitigated ? " (MITIGATED — reference only, not live)" : ""}
- Latest SMT Tag: ${payload.smtBias}
- Latest MSS Direction: ${payload.mssDir}
- Last Swing High: $${payload.swingHigh || 0}
- Last Swing Low: $${payload.swingLow || 0}

BTC LIVE CORRELATION DATA (use for checklist point 4):
- BTC Price: $${payload.btcPrice || 0}
- BTC Cumulative Delta: ${payload.btcDelta || 0}
- BTC RSI: ${payload.btcRsi || 0}
- BTC 3-bar Trend: ${payload.btcTrend || "Unknown"}
- BTC scoring: if btcTrend matches signal direction AND btcDelta confirms → point 4 = 1/1. If btcTrend neutral → 0.5/1. If btcTrend opposes signal direction → 0/1 AND flag as high risk`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return new Promise((resolve, reject) => {
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
          const text = parsed.content?.[0]?.text || "Error: no response from Claude";
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse Claude response"));
        }
      });
    });
    req.on("error", reject);
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
  const killzone  = payload.killzone === true || payload.killzone === "true";
  const kzTag     = killzone ? " ⚡ KILL ZONE" : "";
  const condition = payload.condition || "unknown";
  const isPriority = condition.includes("HIGH_PRIORITY");
  const isShort   = condition.includes("OB_SHORT") || condition.includes("overbought") || condition.includes("cross_below");
  const isLong    = condition.includes("POB_LONG")  || condition.includes("oversold")  || condition.includes("cross_above");
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
<b>-OB Zone:</b> $${payload.obBottom} – $${payload.obTop}${payload.obMitigated ? " (mitigated)" : ""}
<b>+OB Zone:</b> $${payload.pobBottom} – $${payload.pobTop}${payload.pobMitigated ? " (mitigated)" : ""}
<b>SMT:</b>      ${payload.smtBias}  |  <b>MSS:</b> ${payload.mssDir}
─────────────────
⏳ <i>Generating trade plan...</i>
<b>Time (AEDT):</b> ${now}`;
}

// ============================================================
// Format the final, platform-agnostic trade setup message
// ============================================================
function formatTradeSetup(lines, payload) {
  return `📊 Trade Setup:
- Symbol: ${payload.symbol || "—"}
- Bias: ${lines.BIAS || "—"}
- Ideal leverage (be flexible): ${lines.LEVERAGE || "—"}
- Entry Zone: ${lines.ENTRY_ZONE || "—"}
- Stop Loss: ${lines.STOP_LOSS || "—"}
- Take Profit 1: ${lines.TP1 || "—"}
- Take Profit 2: ${lines.TP2 || "—"}
- Take Profit 3: ${lines.TP3 || "—"}`;
}

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200); res.end("Trade alert server v6 — Claude-powered, platform-agnostic ✅"); return;
  }

  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { condition: body }; }

      // Respond to TradingView IMMEDIATELY (before Claude API call)
      // This prevents webhook timeout errors
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));

      // Now process async in background — TradingView already got its 200 OK
      try {
        // PRE-FILTER — only call Claude API for high priority signals
        // Weak signals (RSI, MSS alone, SMT alone, outside OB watch) are skipped
        // This saves ~90% of API credits
        const condition = payload.condition || "";
        const highPrioritySignals = [
          "KILLZONE_OB_SHORT_HIGH_PRIORITY",
          "KILLZONE_POB_LONG_HIGH_PRIORITY",
          "OB_SHORT_REJECTION_CONFIRMED",
          "POB_LONG_REJECTION_CONFIRMED",
          "cross_manual_level1",
          "cross_manual_level2",
          "cross_manual_level3",
        ];

        const isHighPriority = highPrioritySignals.some(s => condition.includes(s));

        if (!isHighPriority) {
          console.log("Low priority signal — skipping Claude API ⏭️", new Date().toISOString(), "| condition:", condition);
          return;
        }

        // Call Claude API FIRST — only send anything to Telegram if valid trade
        const tradePlan = await generateTradePlan(payload);

        // NO TRADE — complete silence, zero Telegram messages
        if (tradePlan.includes("NO TRADE") || tradePlan.includes("DIRECTION: NO TRADE") || tradePlan.includes("CHECKLIST SCORE: 2") || tradePlan.includes("CHECKLIST SCORE: 1") || tradePlan.includes("CHECKLIST SCORE: 0")) {
          console.log("No trade — complete silence ⏭️", new Date().toISOString(), "| condition:", payload.condition);
          return;
        }

        // VALID TRADE — now send header + plan
        const header = formatAlertHeader(payload);
        await sendTelegram(header);

        // Parse the structured signal format
        let planMsg;
        const hasStart = tradePlan.includes("signal_start");
        const hasEnd   = tradePlan.includes("signal_end");

        if (hasStart && hasEnd) {
          // Clean, complete signal — normal path
          const signalContent = tradePlan.split("signal_start")[1].split("signal_end")[0].trim();
          const lines = {};
          signalContent.split("\n").forEach(line => {
            const [key, ...val] = line.split(":");
            if (key && val.length) lines[key.trim()] = val.join(":").trim();
          });
          planMsg = formatTradeSetup(lines, payload);
        } else if (hasStart && !hasEnd) {
          // Truncated mid-generation (hit max_tokens before finishing).
          // Salvage what's there, but NEVER present it as a clean plan without
          // a loud warning — an incomplete SL/entry is worse than no signal.
          const signalContent = tradePlan.split("signal_start")[1].trim();
          const lines = {};
          signalContent.split("\n").forEach(line => {
            const [key, ...val] = line.split(":");
            if (key && val.length) lines[key.trim()] = val.join(":").trim();
          });
          const missingCritical = !lines.BIAS || !lines.ENTRY_ZONE || !lines.STOP_LOSS;
          if (missingCritical) {
            planMsg = `⚠️ <b>Signal generation was cut off before completing</b> — critical levels (entry/SL) never finished generating. This is NOT a valid trade plan — do not act on it.`;
          } else {
            planMsg = formatTradeSetup(lines, payload) + `\n\n⚠️ <i>Response was truncated — TP levels or leverage may be missing above. Verify manually before entry.</i>`;
          }
        } else {
          // No structured block at all — malformed response, show raw for debugging
          planMsg = `📊 <b>TRADE SETUP — ${payload.symbol || "—"}</b>\n─────────────────\n<pre>${tradePlan}</pre>`;
        }
        await sendTelegram(planMsg);

        console.log("Alert + plan sent ✅", new Date().toISOString(), "| condition:", payload.condition);
      } catch (err) {
        console.error("Error:", err.message);
        try { await sendTelegram(`⚠️ <b>Bot error:</b> ${err.message}`); } catch {}
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`Server v6 running on port ${PORT}`));
