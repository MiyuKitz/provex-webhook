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
  currentPnl:      -605.86,  // updated Jul 11 2026 — switch to 15M
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
const SYSTEM_PROMPT = `You are a professional crypto futures trade signal generator using ICT/SMC methodology. You receive structured alert data from TradingView and output clean, universal trade signals usable on ANY platform (BingX, MEXC, Binance, etc).

## YOUR METHODOLOGY (strict ICT/SMC)
- Order Blocks (OBs): Entry ONLY from LuxAlgo-drawn OB box boundaries, never from local swing highs/lows
- -OB (bearish): Short entry zone. +OB (bullish): Long entry zone
- MSS (Market Structure Shift): Required for directional confirmation
- SMT Divergence: Bearish SMT at highs = short signal. Bullish SMT at lows = long signal
- Volume delta: Negative delta at -OB = bearish confluence. Positive delta at +OB = bullish confluence
- Kill zones: London (4:33-6:30 PM AEDT) and NY (11 PM-1 AM AEDT) = highest credibility

## 5-POINT ENTRY CHECKLIST (strict, no rounding up)
1. Sharp liquidity sweep through a marked level
2. Hard volume delta flip at the sweep moment
3. Clear MSS marker confirmed
4. BTC confirming same move simultaneously
5. Retest of broken level holding before entry

## SCORING + LEVERAGE
- 5/5 HIGH confidence -> 10x leverage
- 4/5 HIGH confidence -> 7x leverage
- 3.5/5 MEDIUM confidence -> 5x leverage
- Below 3.5 -> NO TRADE always

## KILL ZONE RULES
- Kill zone active: trade if score >= 3.5/5
- Outside kill zone: trade only if score >= 4/5, always add fakeout warning

## CRITICAL RULES
- If BTC trend opposes signal direction -> flag HIGH RISK, cap confidence at MEDIUM
- SL must be minimum 1.5x OB box height beyond OB boundary
- Entry zone = actual drawn OB box range only
- Price must have confirmed rejection candle CLOSE inside OB (not just touch)
- If OB zones = $0 -> points 1 and 5 score 0/1 automatically
- If BTC data missing -> point 4 = 0/1, max score capped at 4/5

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
ENTRY_ZONE: $[low]-$[high]
STOP_LOSS: $[exact]
TP1: $[level]
TP2: $[level]
TP3: $[level]
LEVERAGE: [X]x
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
        if (tradePlan.includes("signal_start") && tradePlan.includes("signal_end")) {
          const signalContent = tradePlan.split("signal_start")[1].split("signal_end")[0].trim();
          const lines = {};
          signalContent.split("\n").forEach(line => {
            const [key, ...val] = line.split(":");
            if (key && val.length) lines[key.trim()] = val.join(":").trim();
          });
          planMsg = `📊 <b>TRADE SETUP — ${lines.SYMBOL || payload.symbol || "ETH"}</b>
─────────────────
<b>Bias:</b>         ${lines.BIAS || "—"}
<b>Confidence:</b>  ${lines.CONFIDENCE || "—"}

<b>Entry Zone:</b>  ${lines.ENTRY_ZONE || "—"}
<b>Stop Loss:</b>   ${lines.STOP_LOSS || "—"}
<b>TP1:</b>         ${lines.TP1 || "—"}
<b>TP2:</b>         ${lines.TP2 || "—"}
<b>TP3:</b>         ${lines.TP3 || "—"}

<b>Leverage:</b>    ${lines.LEVERAGE || "—"}
<b>Kill Zone:</b>   ${lines.KILL_ZONE || "—"}

<b>Reasoning:</b>   ${lines.REASONING || "—"}
<b>Invalidation:</b> ${lines.INVALIDATION || "—"}`;
        } else {
          planMsg = `📊 <b>TRADE SETUP — ${payload.symbol || "ETH"}</b>\n─────────────────\n<pre>${tradePlan}</pre>`;
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

server.listen(PORT, () => console.log(`Server v5 running on port ${PORT}`));
