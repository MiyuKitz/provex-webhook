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
const SIGNAL_LOG_FILE = path.join(DATA_DIR, "signals.jsonl");

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
      bingxOrderId: execResult?.bingxOrderId || null,
      bingxSymbol: execResult?.bingxSymbol || null,
      bingxTpOrderIds: execResult?.tpOrderIds || null,
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
      const tickerRes = await bingxRequest("GET", "/openApi/swap/v2/quote/price", { symbol });
      const currentPrice = parseFloat(tickerRes.data?.price ?? tickerRes.price);
      if (!currentPrice || isNaN(currentPrice)) continue;

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
          const text = (parsed.content?.[0]?.text || "").trim();
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
    const tag = signal.isPaperTrade ? " (PAPER)" : "";
    await sendTelegram(`🧠 <b>Post-mortem${tag}: ${signal.symbol} ${signal.direction} — ${signal.outcome}</b>\n\n${postmortem}`);
  } catch (err) {
    console.error("Post-mortem generation failed (non-fatal):", err.message);
  }
}

async function checkOpenPositions() {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;
  const signals = readSignalLog();
  const openSignals = signals.filter(s => s.outcome === null && s.bingxOrderId && s.bingxSymbol);
  if (!openSignals.length) return;

  let anyUpdated = false;
  for (const sig of openSignals) {
    try {
      const entryCheck = await bingxRequest("GET", "/openApi/swap/v2/trade/order", {
        symbol: sig.bingxSymbol, orderId: sig.bingxOrderId,
      });
      console.log(`Checked entry order ${sig.bingxOrderId} (${sig.bingxSymbol}):`, JSON.stringify(entryCheck).slice(0, 300));
      const entryOrder = entryCheck.data?.order || entryCheck.data || entryCheck;
      const entryStatus = entryOrder?.status;

      if (entryCheck.code === 109421 || entryOrder === undefined) {
        sig.outcome = "not_taken";
        sig.notes = "Order no longer exists on BingX (code 109421) — likely manually closed outside the bot's tracking. Cannot confirm TP/SL outcome.";
        anyUpdated = true;
        continue;
      }

      if (entryStatus === "CANCELED" || entryStatus === "EXPIRED" || entryStatus === "FAILED") {
        sig.outcome = "not_taken";
        sig.notes = "Entry order never filled.";
        anyUpdated = true;
        continue;
      }
      if (entryStatus !== "FILLED") continue;

      if (sig.bingxTpOrderIds) {
        for (const [label, orderId] of Object.entries(sig.bingxTpOrderIds)) {
          const tpCheck = await bingxRequest("GET", "/openApi/swap/v2/trade/order", {
            symbol: sig.bingxSymbol, orderId,
          });
          const tpOrder = tpCheck.data?.order || tpCheck.data || tpCheck;
          if (tpOrder?.status === "FILLED") {
            sig.outcome = label;
            sig.notes = `${label} order confirmed filled via BingX.`;
            anyUpdated = true;
            logPostmortem(sig).catch(err => console.error("logPostmortem failed (non-fatal):", err.message));
            break;
          }
        }
      }

      if (!sig.outcome) {
        const posCheck = await getOpenPosition(sig.bingxSymbol);
        if (posCheck.checked && !posCheck.existing) {
          sig.outcome = "SL";
          sig.notes = "Position closed with no TP fill detected — inferred SL hit (BingX doesn't expose SL as a separately trackable order ID; a manual close would look identical).";
          anyUpdated = true;
          logPostmortem(sig).catch(err => console.error("logPostmortem failed (non-fatal):", err.message));
        }
      }
    } catch (err) {
      console.error(`Failed to check signal (order ${sig.bingxOrderId}):`, err.message);
    }
  }
  if (anyUpdated) writeSignalLog(signals);
}

async function resolvePaperTrades() {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;
  const signals = readSignalLog();
  const paperCandidates = signals.filter(s => s.outcome === null && !s.bingxOrderId);
  if (!paperCandidates.length) return;

  let anyUpdated = false;
  for (const sig of paperCandidates) {
    try {
      const symbol = toBingXSymbol(sig.symbol);
      const tickerRes = await bingxRequest("GET", "/openApi/swap/v2/quote/price", { symbol });
      const currentPrice = parseFloat(tickerRes.data?.price ?? tickerRes.price);
      if (!currentPrice || isNaN(currentPrice)) continue;

      const parsePrice = (str) => parseFloat(String(str).replace(/[^0-9.]/g, ""));
      const sl = parsePrice(sig.stopLoss);
      const tp1 = parsePrice(sig.tp1);
      const tp2 = parsePrice(sig.tp2);
      const tp3 = parsePrice(sig.tp3);
      const isShort = sig.direction === "Short";

      let outcome = null;
      if (isShort) {
        if (currentPrice >= sl) outcome = "SL";
        else if (currentPrice <= tp3) outcome = "TP3";
        else if (currentPrice <= tp2) outcome = "TP2";
        else if (currentPrice <= tp1) outcome = "TP1";
      } else {
        if (currentPrice <= sl) outcome = "SL";
        else if (currentPrice >= tp3) outcome = "TP3";
        else if (currentPrice >= tp2) outcome = "TP2";
        else if (currentPrice >= tp1) outcome = "TP1";
      }

      if (outcome) {
        sig.outcome = outcome;
        sig.notes = `PAPER TRADE — WEAKER METHODOLOGY THAN REAL TRADES (see HYPOTHESES.md issue #5): resolved via a single current-price snapshot check against logged levels, NOT a real BingX fill confirmation. Cannot detect true intraday sequencing. Current price ${currentPrice} vs entry ${sig.entryZone}. Never executed on BingX — skipped by position rules.`;
        sig.isPaperTrade = true;
        anyUpdated = true;
        logPostmortem(sig).catch(err => console.error("logPostmortem (paper) failed (non-fatal):", err.message));
      }
    } catch (err) {
      console.error(`Paper trade check failed for ${sig.symbol}:`, err.message);
    }
  }
  if (anyUpdated) writeSignalLog(signals);
}

function computeStats(signals, options = {}) {
  const { includePaper = false } = options;
  const base = includePaper ? signals : signals.filter(s => !s.isPaperTrade);
  const resolved = base.filter(s => s.outcome && s.outcome !== "not_taken");

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

  const realCount = signals.filter(s => !s.isPaperTrade).length;
  const paperCount = signals.filter(s => s.isPaperTrade).length;

  return {
    totalLogged: signals.length,
    totalResolved: resolved.length,
    realTradeCount: realCount,
    paperTradeCount: paperCount,
    filterApplied: includePaper ? "real + paper combined" : "real trades only (default — safer, see HYPOTHESES.md issue #5)",
    ...(includePaper ? {
      warning: "⚠️ PAPER TRADES INCLUDED — these use a weaker, single-price-snapshot resolution methodology, not real BingX fill confirmations. Do NOT treat this blended win rate as equivalent to real-trade performance. Use default (no ?includePaper=true) for trustworthy numbers.",
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
  const base = includePaper ? signals : signals.filter(s => !s.isPaperTrade);
  const resolved = base.filter(s => s.outcome && s.outcome !== "not_taken" && s.checklist);

  function winRateOf(arr) {
    const won = arr.filter(s => s.outcome === "TP1" || s.outcome === "TP2" || s.outcome === "TP3").length;
    const lost = arr.filter(s => s.outcome === "SL").length;
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

function toBingXSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.endsWith("USDT") && !symbol.includes("-")) {
    return symbol.slice(0, -4) + "-USDT";
  }
  return symbol;
}

// ============================================================
// SYMBOL PRECISION LOOKUP (new) — replaces the previous hardcoded
// .toFixed(3) quantity rounding used for EVERY coin regardless of
// symbol. That worked for ETH/SUI by coincidence, but is not safe in
// general: BingX requires different quantity precision per symbol, and
// an incorrect precision causes the real order to be silently REJECTED
// by BingX — not caught by any of the bot's own safety rules, just a
// formatting mismatch. This matters now that SOLUSDT has been added,
// and will matter for any future coin. Queries BingX's real contract
// specs once per symbol and caches the result in memory, so this stays
// correct automatically without needing a manual code change every
// time a new coin is added to the Pine Script alerts.
//
// FAILS SAFE: if the lookup fails for any reason (network issue,
// symbol not found, unexpected response shape), falls back to the
// previous hardcoded 3-decimal behavior rather than blocking execution
// entirely — same fail-safe philosophy as getOpenPosition's failing-
// closed pattern elsewhere in this file, but here failing OPEN with a
// logged warning, since a slightly-wrong quantity precision on an
// unfamiliar symbol is a much smaller risk than silently never trading
// a coin at all due to a lookup hiccup.
// ============================================================
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

function computeBingXSizing(confidence) {
  return confidence === "HIGH"
    ? { marginUSDT: 2000, leverage: 15 }
    : { marginUSDT: 900, leverage: 10 };
}

function confidenceEmoji(confidence, rawScore) {
  if (confidence === "HIGH" && rawScore === 5) return "🟢";
  if (confidence === "HIGH") return "🟠";
  return "🔴";
}

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
    const direction = active.positionSide === "SHORT" ? "Short" : "Long";
    return { checked: true, existing: { direction, amt } };
  } catch (err) {
    console.error(`Position check failed for ${symbol} (non-fatal, failing closed):`, err.message);
    return { checked: false, existing: null };
  }
}

async function executeOnBingX(decision, payload) {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;

  try {
    const { scoreResult, gated, levels } = decision;
    const symbol = toBingXSymbol(payload.symbol);
    const direction = scoreResult.direction;

    const positionCheck = await getOpenPosition(symbol);
    if (!positionCheck.checked) {
      await sendTelegram(`⚠️ <b>BingX execution skipped</b>\nSymbol: ${symbol}\nCould not verify current position (failing closed to avoid the opposing-position bug) — trade not placed.`);
      return;
    }

    if (positionCheck.existing) {
      console.log(`Skipping ${symbol} ${direction} — position already open (${positionCheck.existing.direction}), one-position-per-symbol rule`);
      await sendTelegram(`🔕 <b>BingX execution skipped</b>\nSymbol: ${symbol}\nSignal: ${direction}, but a ${positionCheck.existing.direction} position is already open on this symbol. One-position-per-symbol rule — not adding to it regardless of direction or zone.`);
      return;
    }

    if (positionCheck.existing && positionCheck.existing.direction !== direction) {
      console.log(`Skipping ${symbol} ${direction} — existing opposing ${positionCheck.existing.direction} position open`);
      await sendTelegram(`🔕 <b>BingX execution skipped</b>\nSymbol: ${symbol}\nSignal: ${direction}, but an existing ${positionCheck.existing.direction} position is already open on this symbol — opening now would net against it and break TP placement (the exact bug from earlier tonight). Skipped intentionally.`);
      return;
    }

    const isRepeatZone = gated.flags.some(f => f.includes("Repeat signal on the same zone"));
    if (isRepeatZone && positionCheck.existing) {
      console.log(`Skipping ${symbol} ${direction} — repeat-zone signal, position already open (${positionCheck.existing.direction}, avoiding uncontrolled stacking)`);
      await sendTelegram(`🔕 <b>BingX execution skipped</b>\nSymbol: ${symbol}\nSignal: ${direction} (repeat-zone, lower conviction) — a ${positionCheck.existing.direction} position is already open on this symbol. Not adding more capital to it; the repeat-zone flag exists precisely to avoid treating this as a fresh, independently-sized trade.`);
      return;
    }

    const positionSide = direction === "Short" ? "SHORT" : "LONG";
    const entrySide = direction === "Short" ? "SELL" : "BUY";
    const exitSide = direction === "Short" ? "BUY" : "SELL";

    const { marginUSDT, leverage } = computeBingXSizing(gated.confidence);
    const entryPrice = levels.entryMidRaw;
    if (!entryPrice || entryPrice <= 0) {
      console.error("BingX execution skipped — invalid entry price", entryPrice);
      return;
    }
    const notional = marginUSDT * leverage;

    // FIXED (2026-08-28): quantity precision now looked up per-symbol
    // from BingX's real contract specs instead of hardcoded to 3
    // decimals for every coin — see getQuantityPrecision comment above.
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
        reduceOnly: true,
      });
      tpResults.push(`${tp.label}: ${res.code === 0 ? "placed" : JSON.stringify(res).slice(0, 100)}`);
      const tpOrderId = res.data?.order?.orderId ?? res.orderId ?? null;
      if (tpOrderId) tpOrderIds[tp.label] = tpOrderId;
    }

    await sendTelegram(`${confidenceEmoji(gated.confidence, scoreResult.rawScore)} <b>BingX demo execution</b>\n${symbol} ${direction} │ ${marginUSDT} VST margin │ ${leverage}x\nQty: ${quantity}\n${tpResults.join("\n")}`);
    console.log("BingX execution complete", symbol, direction, "| TP results:", tpResults);
    return { bingxOrderId: entryRes.data?.order?.orderId ?? entryRes.orderId ?? null, bingxSymbol: symbol, tpOrderIds };
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

function computeOBLevels(payload, direction) {
  if (direction === "Short") {
    const obTop = num(payload.obTop), obBottom = num(payload.obBottom);
    const pobTop = num(payload.pobTop), pobBottom = num(payload.pobBottom);
    const swingLow = num(payload.swingLow);
    const entryMid = (obTop + obBottom) / 2;
    const sl = entryMid * (1 + FIXED_SL_PCT);
    const risk = sl - entryMid;
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

  if (type.startsWith("OB_")) {
    const zoneCheck = checkZoneCooldown(payload, direction);
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
          const text = (parsed.content?.[0]?.text || "").trim();
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
          const text = (parsed.content?.[0]?.text || "").trim();
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
  const titleTag = isSwing ? " 🌙" : "";

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
    res.writeHead(200); res.end("Trade alert server v10 — deterministic scoring, Claude explains only, signal-only (no execution) ✅"); return;
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
  if (req.method === "GET" && pathname === "/lessons") {
    const lessons = readLessonsLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: lessons.length, lessons }, null, 2));
    return;
  }
  if (req.method === "GET" && pathname === "/missed-signals") {
    const missed = readMissedSignalLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: missed.length, missed }, null, 2));
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
          await sendTelegram(`👀 <b>WATCH — HTF ${zoneType} nearby</b>
Symbol: ${payload.symbol || "—"}
Price: $${payload.price} approaching HTF ${zoneType} at $${htfLevel}
HTF Trend: ${payload.htfTrend || "Unknown"}
This is a heads-up only, not a trade plan — watch for an actual 15M rejection/confirmation before acting.`);
          console.log("HTF watch alert sent 👀", new Date().toISOString(), "| condition:", condition);
          return;
        }

        const decision = buildDecision(payload);

        if (decision.verdict === "UNRECOGNIZED") {
          const legacyConditions = ["cross_manual_level1", "cross_manual_level2", "cross_manual_level3"];
          if (!legacyConditions.some(s => condition.includes(s))) {
            console.log("Low priority / unrecognized signal — skipping ⏭️", new Date().toISOString(), "| condition:", condition);
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
          console.log("No trade (deterministic) — complete silence ⏭️", new Date().toISOString(), "| condition:", condition, "| reason:", decision.reason);
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

setInterval(() => {
  checkOpenPositions().catch(err => console.error("checkOpenPositions failed (non-fatal):", err.message));
  resolvePaperTrades().catch(err => console.error("resolvePaperTrades failed (non-fatal):", err.message));
  resolveMissedSignals().catch(err => console.error("resolveMissedSignals failed (non-fatal):", err.message));
}, 15 * 60 * 1000);

setInterval(() => {
  sendSignalBackupToTelegram().catch(err => console.error("Backup interval failed (non-fatal):", err.message));
}, 24 * 60 * 60 * 1000);

setTimeout(() => {
  sendSignalBackupToTelegram().catch(err => console.error("Startup backup failed (non-fatal):", err.message));
}, 60 * 1000);
