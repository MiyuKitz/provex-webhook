const http = require("http");
const https = require("https");

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ============================================================
// PROVEX ACCOUNT CONFIG
// ============================================================
const PROVEX = {
  totalCapital:    10000,
  currentPnl:      -605.86,  // updated Jul 11 2026
  maxRiskPerTrade: 50,
  maxLeverage:     10,       // ProveX max
  dailyLossLimit:  500,
  drawdownLimit:   1000,
};

// Dynamic leverage based on confidence + session
function getLeverage(score, inKillZone, exchange) {
  if (exchange === "provex") {
    if (inKillZone) {
      if (score >= 5)   return 10;  // 5/5 KZ → max leverage
      if (score >= 4)   return 7;   // 4/5 KZ → high leverage
      if (score >= 3.5) return 5;   // 3.5/5 KZ → standard
    } else {
      if (score >= 5)   return 7;   // 5/5 outside → slightly reduced
      if (score >= 4)   return 5;   // 4/5 outside → standard
      return 0;                     // below 4/5 outside → no trade
    }
  }
  return 5; // default fallback
}

// Calculate position size based on risk, leverage, price, stop distance
function calcPosition(riskAmount, entryPrice, slPrice, leverage) {
  const stopDistance = Math.abs(entryPrice - slPrice);
  if (stopDistance === 0) return { size: 0, margin: 0, liqPrice: 0 };
  const positionSize = (riskAmount / stopDistance);
  const notional     = positionSize * entryPrice;
  const margin       = notional / leverage;
  const liqPrice     = entryPrice * (1 + (1 / leverage)); // short liq (above entry)
  return {
    size:     positionSize.toFixed(3),
    margin:   margin.toFixed(2),
    liqPrice: liqPrice.toFixed(2),
    notional: notional.toFixed(2),
  };
}

// ============================================================
// SYSTEM PROMPT — Krysie's full trading brain
// ============================================================
const SYSTEM_PROMPT = `You are Krysie's personal ICT/SMC trade plan generator for crypto futures trading. You receive structured alert data from TradingView and must output a complete, precise trade plan.

## YOUR METHODOLOGY (strict ICT/SMC)
- Order Blocks (OBs): Entry ONLY from the actual LuxAlgo-drawn OB box boundaries — never from local swing highs/lows
- -OB (bearish): Short entry zone. +OB (bullish): Long entry zone
- MSS (Market Structure Shift): Required for directional confirmation
- SMT Divergence: Bearish SMT at highs = short warning. Bullish SMT at lows = long warning
- Liquidity sweeps: Sharp wick through a level = sweep. Price must react immediately
- Volume delta: Negative delta at -OB = bearish confluence. Positive delta at +OB = bullish confluence
- Kill zones: London (4:33-6:30 PM AEDT) and NY (11 PM-1 AM AEDT) = high credibility. Outside = lower credibility, downweight signals

## 5-POINT ENTRY CHECKLIST (strict, no rounding up)
1. Sharp liquidity sweep through a marked level
2. Hard volume delta flip at the sweep moment
3. Clear MSS marker on chart
4. BTC confirming same move simultaneously
5. Retest of broken level holding before entry

## TIERED SCORING BASED ON SESSION

KILL ZONE ACTIVE (London 4:33-6:30 PM AEDT | NY 11 PM-1 AM AEDT):
- 5/5 → Full size ($50 risk), full plan
- 4/5 → Full size ($50 risk), full plan  
- 3.5/5 → Half size ($25 risk), half plan
- Below 3.5 → NO TRADE

OUTSIDE KILL ZONE:
- 5/5 → Reduced size ($35 risk), full plan, note fakeout risk
- 4/5 → Half size ($25 risk), plan with caution note
- 3.5/5 → NO TRADE (insufficient edge without kill zone)
- Below 3.5 → NO TRADE always

CRITICAL SCORING RULES:
- If BTC data missing (btcPrice = 0) → point 4 = 0/1, max score capped at 4/5
- If score 3.5/5 AND BTC missing → NO TRADE regardless of session
- If drawdown buffer < $400 → minimum 4/5 required in kill zone, 5/5 required outside
- Signal "OB_SHORT_REJECTION_CONFIRMED" = bearish candle closed inside OB → point 5 = 1/1
- Signal "price_entering_OB_zone" = touch only → point 5 = 0/1
- SL minimum 1.5× OB box height above -OB top
- Outside kill zone: always add warning "FAKEOUT RISK — lower volume session"

## PROVEX RULES
- Max risk per trade: $50 (half size = $25)
- Max leverage: 5x
- TP target per trade: $70-110 profit. Partial close if running past $110-120. Hard ceiling ~$150
- Consistency rule: no single trade can exceed 40% of total profit
- Daily loss limit: $500 (closed PnL only)
- Hard stop orders on exchange immediately — no mental stops

## VALIDATED LESSONS (never violate these)
1. -OB rejection + sustained negative delta = bearish continuation
2. Sharp drop + delta flipping positive = absorption, possible exhaustion — don't read delta only at sweep point
3. SMT divergence at fresh highs after impulsive move = early reversal warning — flag explicitly
4. Higher timeframe trend dominates counter-trend bounce calls
5. SUI lags BTC directionally but not reliably — always check own structure
6. Directional bias confirmed over gap ≠ tradeable path — check intraday high/low
7. Delta pause mid-downtrend ≠ seller exhaustion if price still making lower lows
8. Negative delta during strong multi-TF rally = absorption, can flip bullish before delta confirms
9. ALWAYS anchor entry to the actual drawn OB box boundaries, never to local swing highs
9b. SL placement: minimum 1.5× OB box height above -OB top for shorts, below +OB bottom for longs. Never place SL just $1-2 above/below the OB — wicks through OBs before rejecting are common during kill zones
10. Before any short retest entry: (a) confirm actual -OB box level, (b) check for unmitigated +OB below acting as magnet, (c) check if 4H delta negative + RSI >55 = absorption not distribution
11. OB identification: -OB = highest-high candle between swing pivot and MSS close. Mitigated when price closes above ob.top → becomes breaker block
12. Don't anchor retest zones to swing highs. Always use the drawn LuxAlgo box. Confirmed Jul 7-8 2026 ETH

## OUTPUT FORMAT (always follow exactly)
Respond in this exact structure, no deviations:

CHECKLIST SCORE: X/5
DIRECTION: [LONG/SHORT/NO TRADE]
CONFIDENCE: [HIGH/MEDIUM/LOW]
BIAS REASONING: [2-3 sentences max, specific]

ENTRY: $X
SL: $X  
TP1: $X (60% close)
TP2: $X (40% runner, SL→BE after TP1)
LEVERAGE: Xx (calculated from confidence + session)
POSITION SIZE: X ETH/BTC/SUI
MARGIN REQUIRED: $X
LIQUIDATION PRICE: $X
MAX RISK: $X

PROFIT IF TP1: +$X
PROFIT IF FULL: +$X
LOSS IF SL: -$X

LEVERAGE REASONING: [why this leverage — e.g. "5/5 kill zone = 10x", "4/5 outside KZ = 5x"]
INVALIDATION: [specific price + condition that kills this trade]
KILL ZONE: [Active/Inactive — if inactive, note fakeout risk]

If NO TRADE: explain exactly what condition would trigger an entry instead (Watch Plan).

LEVERAGE RULES TO APPLY:
Kill zone 5/5 → 10x | Kill zone 4/5 → 7x | Kill zone 3.5/5 → 5x
Outside KZ 5/5 → 7x | Outside KZ 4/5 → 5x | Outside KZ 3.5/5 → NO TRADE
Max risk always $50 ProveX regardless of leverage — only position size changes`;

// ============================================================
// Call Claude API to generate trade plan
// ============================================================
async function generateTradePlan(payload) {
  const accountBalance = PROVEX.totalCapital + PROVEX.currentPnl;
  const remainingDrawdown = PROVEX.drawdownLimit + PROVEX.currentPnl;

  const userMessage = `New TradingView alert received. Generate a complete trade plan.

ALERT DATA:
- Symbol: ${payload.symbol || "ETHUSDT"}
- Condition: ${payload.condition || "unknown"}
- Price: $${payload.price}
- RSI: ${payload.rsi}
- Cumulative Delta: ${payload.cumDelta}
- Session: ${payload.session}
- Kill Zone Active: ${payload.killzone}
- Timeframe: ${payload.timeframe}

STRUCTURE (from LuxAlgo toolkit — these are the ACTUAL drawn box levels):
- Active -OB Zone: $${payload.obBottom} – $${payload.obTop}
- Active +OB Zone: $${payload.pobBottom} – $${payload.pobTop}
- Latest SMT Tag: ${payload.smtBias}
- Latest MSS Direction: ${payload.mssDir}
- Last Swing High: $${payload.swingHigh || 0}
- Last Swing Low: $${payload.swingLow || 0}

BTC LIVE CORRELATION DATA (use for checklist point 4):
- BTC Price: $${payload.btcPrice || 0}
- BTC Cumulative Delta: ${payload.btcDelta || 0}
- BTC RSI: ${payload.btcRsi || 0}
- BTC 3-bar Trend: ${payload.btcTrend || "Unknown"}
- BTC scoring: if btcTrend matches ETH direction AND btcDelta confirms → point 4 = 1/1. If btcTrend neutral → 0.5/1. If btcTrend opposes ETH direction → 0/1 AND flag as high risk

PROVEX ACCOUNT STATUS:
- Effective Balance: $${accountBalance.toFixed(2)}
- Remaining Drawdown Buffer: $${remainingDrawdown.toFixed(2)}
- Max Risk This Trade: $${PROVEX.maxRiskPerTrade}
- Daily Loss Limit Remaining: $${PROVEX.dailyLossLimit}`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
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

  return `${emoji} <b>PROVEX ALERT${kzTag}</b>
─────────────────
<b>Signal:</b>   ${condition}
<b>Symbol:</b>   ${payload.symbol || "—"}
<b>Price:</b>    $${payload.price}
<b>RSI:</b>      ${payload.rsi}
<b>Delta:</b>    ${payload.cumDelta}
<b>Session:</b>  ${payload.session}
<b>TF:</b>       ${payload.timeframe}
<b>-OB Zone:</b> $${payload.obBottom} – $${payload.obTop}
<b>+OB Zone:</b> $${payload.pobBottom} – $${payload.pobTop}
<b>SMT:</b>      ${payload.smtBias}  |  <b>MSS:</b> ${payload.mssDir}
─────────────────
⏳ <i>Generating trade plan...</i>
<b>Time (AEDT):</b> ${now}`;
}

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200); res.end("Provex alert server v4 — Claude-powered ✅"); return;
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

        // Generate trade plan FIRST — don't waste credits on no-trade
        const tradePlan = await generateTradePlan(payload);

        // NO TRADE — skip Telegram entirely, save credits
        if (tradePlan.includes("NO TRADE") || tradePlan.includes("DIRECTION: NO TRADE")) {
          console.log("No trade — skipping Telegram ⏭️", new Date().toISOString(), "| condition:", payload.condition);
          return;
        }

        // Valid trade plan — send alert header + plan to Telegram
        const header = formatAlertHeader(payload);
        await sendTelegram(header);

        const planMsg = `📋 <b>TRADE PLAN — ${payload.symbol || "ETH"}</b>
─────────────────
<pre>${tradePlan}</pre>`;
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

server.listen(PORT, () => console.log(`Server v4 running on port ${PORT}`));
