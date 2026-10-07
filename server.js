// ============================================================
// TWO-SPEED BOT (v23.0) — clean build
//
// Only the new strategies live here:
//   🛡️ Core  — trend-following holds (daily, long; shorts optional, never in a bull market)
//   🎰 Aggro — with-trend 1H break & retest, tight stop, up to 40x (never short in a bull market)
// Plus the stop watchdog. The old v19 order-block system, its TradingView
// signal pipeline, Claude explanations, paper resolvers, weekly challenge
// report, signal backups and the funding watch were removed in v23.
// Their research and code history stay in research/ and in git history.
//
// MARKET REGIME: bull market = BTC's 28-day return > 0 (checked daily).
// In a bull market, NOTHING in this bot opens a short.
// ============================================================
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;
const BINGX_API_KEY    = process.env.BINGX_API_KEY;
const BINGX_API_SECRET = process.env.BINGX_API_SECRET;
const BINGX_BASE_URL   = process.env.BINGX_BASE_URL || "https://open-api-vst.bingx.com";   // VST demo by default
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SERVER_VERSION = "v25.1";

// v25.1 — one codebase, two deployments. The demo service keeps the defaults.
// A second Railway service runs the REAL-money "Aggro only" copy with:
//   BINGX_BASE_URL=https://open-api.bingx.com  (live)   BOT_LABEL=💰 LIVE
//   CORE=off  SHADOW=off  AGGRO_USE_EQUITY=on  AGGRO_COINS=SUI
const BOT_LABEL = process.env.BOT_LABEL || "";
const CORE_ON = (process.env.CORE || "on") === "on";
const SHADOW_ON = (process.env.SHADOW || "on") === "on";
const AGGRO_USE_EQUITY = (process.env.AGGRO_USE_EQUITY || "off") === "on";   // size from the account's real equity

// v24: Aggro can run on its OWN BingX account (sub-account or second account).
// Set AGGRO_BINGX_API_KEY + AGGRO_BINGX_API_SECRET and Aggro trades there, so
// its positions never merge with Core's: both can hold the same coin at their
// own leverage (hold + hunt on the same coin). Without them, Aggro shares the
// main account and skips any coin+side Core already holds.
const AGGRO_KEY = process.env.AGGRO_BINGX_API_KEY, AGGRO_SECRET = process.env.AGGRO_BINGX_API_SECRET;
const AGGRO_SEPARATE = !!(AGGRO_KEY && AGGRO_SECRET);
const AG_ACCT = AGGRO_SEPARATE ? "aggro" : "main";
const acctKeys = acct => acct === "aggro" && AGGRO_SEPARATE ? { key: AGGRO_KEY, secret: AGGRO_SECRET } : { key: BINGX_API_KEY, secret: BINGX_API_SECRET };

// ---------------- exchange + telegram helpers ----------------
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

function bingxSign(queryString, secret = BINGX_API_SECRET) {
  return require("crypto").createHmac("sha256", secret).update(queryString).digest("hex");
}

async function bingxRequest(method, path, params, acct = "main") {
  const { key, secret } = acctKeys(acct);
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const sortedKeys = Object.keys(allParams).sort();
  const rawParamString = sortedKeys.map(k => `${k}=${allParams[k]}`).join("&");
  const signature = bingxSign(rawParamString, secret);
  const encodedParamString = sortedKeys.map(k => `${k}=${encodeURIComponent(allParams[k])}`).join("&");
  const signedString = `${encodedParamString}&signature=${signature}`;
  const fullPath = `${path}?${signedString}`;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "open-api-vst.bingx.com",
      path: fullPath,
      method,
      headers: {
        "X-BX-APIKEY": key,
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

const FIXED_SL_PCT = 0.05;          // used only to estimate open risk in getOpenPositions
const MAX_MARGIN_FRACTION = 0.5;    // never commit more than half of free margin to one trade
let equityCache = { equity: null, available: null, at: 0 };
const EQUITY_TTL_MS = 60000;
const equityCaches = {};
async function getAccountEquity(acct = "main") {
  const equityCache = equityCaches[acct] || { equity: null, available: null, at: 0 };
  if (equityCache.equity && Date.now() - equityCache.at < EQUITY_TTL_MS) return equityCache;
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/user/balance", {}, acct);
    const b = res?.data?.balance ?? res?.data;
    const equity = parseFloat(b?.equity ?? b?.balance);
    const available = parseFloat(b?.availableMargin ?? b?.balance ?? equity);
    if (equity > 0) {
      equityCaches[acct] = { equity, available: available > 0 ? available : equity, at: Date.now() };
      return equityCaches[acct];
    }
    console.error("Equity lookup returned no usable figure:", JSON.stringify(res).slice(0, 200));
  } catch (err) {
    console.error("Equity lookup failed (non-fatal):", err.message);
  }
  return { equity: null, available: null, at: 0 };
}

async function getOpenPositions(acct = "main") {
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/user/positions", {}, acct);
    if (Array.isArray(res.data)) {
      const live = res.data.filter(p => Math.abs(parseFloat(p.positionAmt ?? 0)) > 0);
      console.log(`BingX positions${acct === "aggro" ? " (Aggro account)" : ""}: ${live.length ? live.map(p => `${p.symbol} ${p.positionSide} ${p.positionAmt} @${p.avgPrice} uPnL ${p.unrealizedProfit}`).join(" | ") : "none"}`);
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

// Every message ends with the Melbourne date/time (+ UTC) so signals are easy to track.
function stampNow() {
  const d = new Date();
  const mel = d.toLocaleString("en-AU", { timeZone: "Australia/Melbourne", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
  return `🕒 ${mel} (${d.toISOString().slice(0, 16).replace("T", " ")} UTC)`;
}
async function sendTelegram(message) {
  const url  = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id:    TELEGRAM_CHAT_ID,
    text:       `${BOT_LABEL ? BOT_LABEL + " · " : ""}${message}\n\n${stampNow()}`,
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

async function lastPrice(coin) {
  const r = await fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/price?symbol=${coin}-USDT`);
  const j = await r.json();
  return +j?.data?.price;
}

// ---------------- market regime ----------------
// Bull market = BTC's 28-day return is positive. Cached for an hour.
let regimeCache = { value: null, at: 0 };
async function marketRegime() {
  if (regimeCache.value && Date.now() - regimeCache.at < 3600000) return regimeCache.value;
  try {
    const d = await fetchDailyCloses("BTC-USDT");
    const n = d.length;
    const value = d[n - 1].c / d[n - 1 - 28].c - 1 > 0 ? "bull" : "bear";
    regimeCache = { value, at: Date.now() };
    return value;
  } catch { return regimeCache.value || "bull"; }   // unknown -> assume bull (blocks shorts, the safe side)
}

// ---------------- stop watchdog ----------------
const stopAlertAt = {};
async function stopWatchdog() {
  await stopWatchdogFor("main");
  if (AGGRO_SEPARATE) await stopWatchdogFor("aggro");
}
async function stopWatchdogFor(acct) {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) return;
  const pos = await getOpenPositions(acct);
  if (!pos.checked || !pos.positions.length) return;
  let orders;
  try {
    const res = await bingxRequest("GET", "/openApi/swap/v2/trade/openOrders", {}, acct);
    orders = res?.data?.orders;
    if (!Array.isArray(orders)) { console.error("Stop watchdog: openOrders returned no list:", JSON.stringify(res).slice(0, 200)); return; }
  } catch (err) { console.error("Stop watchdog failed (non-fatal):", err.message); return; }
  const unprotected = pos.positions.filter(p => {
    const side = p.direction === "Short" ? "SHORT" : "LONG";
    return !orders.some(o => o.symbol === p.symbol && o.positionSide === side
      && /STOP/.test(o.type || "") && !/TAKE_PROFIT/.test(o.type || ""));
  });
  console.log(`Stop watchdog${acct === "aggro" ? " (Aggro account)" : ""}: ${pos.positions.length} position(s), ${unprotected.length} without a stop`);
  for (const p of unprotected) {
    const key = `${p.symbol}|${p.direction}`;
    if (stopAlertAt[key] && Date.now() - stopAlertAt[key] < 6 * 3600 * 1000) continue;
    stopAlertAt[key] = Date.now();
    await sendTelegram(`🚨 <b>Position with NO stop-loss</b>${acct === "aggro" ? " (Aggro account)" : ""}\n${p.symbol} ${p.direction}, size ${p.amt}\nNothing is protecting this position. Set a stop in the BingX app or close it.`);
  }
}

// ============================================================
// 🛡️ CORE MODE — PAPER TRACKER (virtual 10,000 balance, mirrors the live rules)
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
// from Aggro.
// ============================================================
// Coins Core trades — Railway variable CORE_COINS, e.g. "BTC,ETH,SUI".
// Researched: BTC, ETH (2018-2026), SUI (2023-2026). Others are untested.
const CORE_ASSETS = (process.env.CORE_COINS || "BTC,ETH").split(",").map(c => c.trim().toUpperCase()).filter(Boolean).map(c => `${c}-USDT`);
const CORE_LOOKBACK = 28;        // days
// v21: CORE_SHORTS=on -> a coin whose 28-day trend is negative is SHORTED
// (instead of sitting in cash). Research (BTC+ETH 2018-2026): about the same
// return overall (+23-25%/yr vs +25%), better in bear years (2022: +13% vs
// -21%), worse in bull years (2023-25: +11% vs +29%), maxDD -50% vs -44%.
const CORE_SHORTS = (process.env.CORE_SHORTS || "off") === "on";
const CORE_VOL_TARGET = 0.40;    // annualised
const CORE_FEE = 0.001;          // per unit of weight traded
const CORE_STATE_FILE = path.join(DATA_DIR, "core_state.json");
let coreBadWarned = "";
const coreLevSynced = {};
const coreForeignWarned = {};
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

// v24.3 KEY-LEVEL TRAIL (CORE_TRAIL=on, default): while long, Core also exits on a
// daily close below the last confirmed daily swing low. After such an exit it only
// re-enters on a fresh breakout (close above the highest close of the prior 10 days)
// while the 28-day trend is still up. Research (BTC+ETH): same return, smaller
// drawdowns: 2018-26 maxDD -44% -> -33%; 2024-26 -34% -> -25%; Sharpe 0.58 -> 0.63 recently.
const CORE_TRAIL = (process.env.CORE_TRAIL || "on") === "on";
function coreTrailDecision(c, wasIn, locked) {   // c = array of daily closes up to today
  const n = c.length - 1;
  let trail = null;
  for (let k = n - 30; k <= n - 4; k++) {
    if (k < 3) continue;
    if ([-3, -2, -1, 1, 2, 3].every(j => c[k] < c[k + j])) trail = c[k];
  }
  if (wasIn && trail !== null && c[n] < trail) return { inMarket: false, locked: true, trail };
  if (!wasIn && locked) {
    const brk = c[n] > Math.max(...c.slice(n - 10, n));
    return { inMarket: brk, locked: !brk, trail };
  }
  return { inMarket: true, locked: false, trail };
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
  return { on, mom, vol, size, ref: closes[n - 1 - CORE_LOOKBACK].c,
           weight: on ? size / CORE_ASSETS.length : (CORE_SHORTS ? -size / CORE_ASSETS.length : 0) };
}

function readCoreState() {
  try { return JSON.parse(fs.readFileSync(CORE_STATE_FILE, "utf8")); }
  catch { return { equity: 10000, startedAt: null, lastDay: null, weights: {}, prices: {} }; }
}

async function runCoreMode() {
  const data = {}, bad = [];
  for (const s of CORE_ASSETS) {
    try { const d = await fetchDailyCloses(s); if (d.length >= CORE_LOOKBACK + 21) data[s] = d; else bad.push(`${s} (too new)`); }
    catch { bad.push(s); }
  }
  if (bad.length && coreBadWarned !== bad.join()) {
    coreBadWarned = bad.join();
    await sendTelegram(`⚠️ <b>Core mode: coin(s) skipped</b>\n${bad.join(", ")}\nNot found on BingX futures or not enough history. Check the spelling in CORE_COINS (e.g. PEPE is 1000PEPE, SHIB is 1000SHIB, BONK is 1000BONK).`);
  }
  const valid = Object.keys(data);
  if (!valid.length) return null;
  const day = Math.min(...valid.map(s => data[s][data[s].length - 1].t));
  const st = readCoreState();
  // Already processed this day — unless the coin list changed (CORE_COINS edited),
  // then recompute weights right away instead of waiting for the next daily close.
  const sameCoins = JSON.stringify(Object.keys(st.weights || {}).sort()) === JSON.stringify(valid.slice().sort());
  const sameShorts = (st.shortsOn || false) === CORE_SHORTS;   // CORE_SHORTS toggled -> recompute now
  if (st.lastDay !== null && day <= st.lastDay && sameCoins && sameShorts) return null;

  const px = {};
  for (const s of valid) px[s] = data[s].find(k => k.t === day)?.c ?? data[s][data[s].length - 1].c;

  // 1. mark yesterday's weights to today's close
  let dayRet = 0;
  for (const s of Object.keys(st.weights || {})) {
    const w = st.weights[s] || 0, p0 = st.prices[s];
    if (w && p0 && px[s]) dayRet += w * (px[s] / p0 - 1);
  }
  // 2. new target weights
  const detail = {}, newW = {};
  let turnover = 0;
  st.locked = st.locked || {};
  for (const s of valid) {
    const series = data[s].filter(k => k.t <= day);
    const tw = coreTargetWeight(series);
    if (!tw) continue;
    tw.trail = null;
    if (!tw.on) st.locked[s] = false;
    else if (CORE_TRAIL) {
      const td = coreTrailDecision(series.map(k => k.c), (st.weights[s] || 0) > 0, !!st.locked[s]);
      st.locked[s] = td.locked; tw.trail = td.trail;
      if (!td.inMarket) tw.weight = 0;
    }
    detail[s] = tw; newW[s] = tw.weight;
    turnover += Math.abs(tw.weight - (st.weights[s] || 0));
  }
  if ((await marketRegime()) === "bull") {   // no shorts in a bull market
    for (const s of Object.keys(newW)) if (newW[s] < 0) { newW[s] = 0; detail[s].weight = 0; }
    turnover = Object.keys(newW).reduce((acc, s) => acc + Math.abs(newW[s] - (st.weights[s] || 0)), 0);
  }
  const cost = turnover * CORE_FEE;
  const prevEq = st.equity;
  st.equity = prevEq * (1 + dayRet) - prevEq * cost;
  st.peak = Math.max(st.peak || st.equity, st.equity);
  st.startedAt = st.startedAt || new Date(day).toISOString();
  st.lastDay = day; st.weights = newW; st.prices = px; st.shortsOn = CORE_SHORTS;
  fs.writeFileSync(CORE_STATE_FILE, JSON.stringify(st));

  const entry = {
    day: new Date(day).toISOString().slice(0, 10), serverVersion: SERVER_VERSION,
    equity: +st.equity.toFixed(2), dayRetPct: +(dayRet * 100).toFixed(3), costPct: +(cost * 100).toFixed(3),
    drawdownPct: +((st.equity / st.peak - 1) * 100).toFixed(2),
    positions: Object.fromEntries(Object.keys(detail).map(s => [s, {
      inMarket: detail[s].weight !== 0, side: detail[s].weight > 0 ? "LONG" : detail[s].weight < 0 ? "SHORT" : "CASH",
      weightPct: +(detail[s].weight * 100).toFixed(1),
      vol: +(detail[s].vol * 100).toFixed(0), momPct: +(detail[s].mom * 100).toFixed(1), refPrice: detail[s].ref, trailPrice: detail[s].trail, locked: !!st.locked[s], price: px[s] }])),
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
      .map(([s, p]) => `${s.replace("-USDT", "")}: ${p.side === "SHORT" ? `SHORT ${Math.abs(p.weightPct)}%` : p.inMarket ? `IN ${p.weightPct}%` : "cash"}`).join(" | ");
    console.log(`🛡️ Core mode ${e.day}: equity ${e.equity} (${e.dayRetPct}%), DD ${e.drawdownPct}% | ${pos}`);
    if (res.changed) {
      await sendTelegram(`🛡️ <b>Core mode (paper)</b> — position change\n${pos}\nVirtual equity: ${e.equity} (DD ${e.drawdownPct}%)`);
    }
  } catch (err) {
    console.error("Core mode tick failed (non-fatal):", err.message);
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

// Core keeps its OWN record of what it holds (st.coreQty) and of the stop
// orders it placed (st.coreStopIds), so it never mixes with Aggro
// positions on the same coin and never cancels a stop it didn't create.
async function openOrderIds(symbol) {
  const res = await bingxRequest("GET", "/openApi/swap/v2/trade/openOrders", { symbol });
  const orders = res?.data?.orders;
  return Array.isArray(orders) ? orders : null;
}

// leg = "LONG" | "SHORT". Keys: long leg uses the bare symbol (back-compat),
// short leg uses "SYMBOL|SHORT".
const legKey = (symbol, leg) => leg === "SHORT" ? `${symbol}|SHORT` : symbol;

async function placeCoreStop(st, symbol, qty, price, leg = "LONG") {
  st.coreStopIds = st.coreStopIds || {};
  const key = legKey(symbol, leg);
  const oldId = st.coreStopIds[key];
  if (oldId) await bingxRequest("DELETE", "/openApi/swap/v2/trade/order", { symbol, orderId: oldId });
  delete st.coreStopIds[key];
  if (qty <= 0) return true;
  const stopPrice = +(price * (leg === "SHORT" ? 1 + CORE_DISASTER_STOP : 1 - CORE_DISASTER_STOP)).toPrecision(6);
  const r = await bingxRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol, side: leg === "SHORT" ? "BUY" : "SELL", positionSide: leg, type: "STOP_MARKET", quantity: qty, stopPrice, workingType: "MARK_PRICE",
  });
  if (r.error || r.code !== 0) {
    await sendTelegram(`🚨 <b>Core mode: disaster stop FAILED</b>\n${symbol} ${leg} ${qty}\n${JSON.stringify(r).slice(0, 200)}`);
    return false;
  }
  st.coreStopIds[key] = String(r.data?.order?.orderId ?? r.data?.order?.orderID ?? "");
  return true;
}

function formatCoreTrade({ symbol, side, qty, px, targetQty, curQty, w, equity, stopOk, principal = 0, profit = 0, leg = "LONG" }) {
  const coin = symbol.replace("-USDT", "");
  const info = (readCoreLog().slice(-1)[0]?.positions || {})[symbol] || {};
  const fmt = (v, d = 2) => (v == null || isNaN(v)) ? "?" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
  const isShort = leg === "SHORT";
  const closing = targetQty === 0;
  const removed = !CORE_ASSETS.includes(symbol);   // closed because it was taken out of CORE_COINS
  const growing = isShort ? side === "SELL" : side === "BUY";
  const action = closing ? "CLOSE" : curQty === 0 ? "OPEN" : growing ? "ADD" : "TRIM";
  const trend = info.momPct == null ? "?" : `${info.momPct > 0 ? "Bullish" : "Bearish"} (${info.momPct > 0 ? "+" : ""}${info.momPct}%)`;
  const sizePct = info.vol ? Math.min(100, Math.round(4000 / info.vol)) : null;
  const ref = `$${fmt(info.refPrice)}`;
  const levels = closing
    ? `<b>Exit:</b> $${fmt(px)}\n<b>Reason:</b> ${removed ? "coin removed from CORE_COINS" : info.locked ? `daily close broke the last swing low ($${fmt(info.trailPrice)}), key-level exit` : `the 28-day trend flipped (reference ${ref})`}`
    : `<b>Entry:</b> $${fmt(px)}
<b>Exit trigger:</b> daily close ${isShort ? "above" : "below"} ${ref} (28-day reference, moves daily)${!isShort && info.trailPrice ? `\n<b>Key-level exit:</b> daily close below $${fmt(info.trailPrice)} (last daily swing low, trails up)` : ""}
<b>Disaster stop:</b> $${fmt(px * (isShort ? 1 + CORE_DISASTER_STOP : 1 - CORE_DISASTER_STOP))} (${isShort ? "+" : "−"}15%)
<b>Take profit:</b> none, rides the trend until the exit trigger`;
  const checklist = closing
    ? `${removed ? "🗂️ Removed from Core's coin list" : "🔁 28-day trend flipped"}\n✅ ${isShort ? "Short" : "Long"} closed, its disaster stop cancelled`
    : `✅ 28-day trend ${isShort ? "negative" : "positive"}
${sizePct === 100 ? "✅" : "➖"} Volatility ${info.vol ?? "?"}% → size ${sizePct ?? "?"}% of full (target 40%)
${stopOk ? "✅ Disaster stop placed" : "❌ Disaster stop NOT confirmed, check BingX"}`;
  const reasoning = closing
    ? (removed ? `${coin} was taken out of CORE_COINS, so Core closed its position.` : `${coin}'s 28-day trend flipped, so Core closes this ${isShort ? "short" : "long"}.`)
    : action === "OPEN"
      ? (isShort ? `${coin} is below where it traded 28 days ago and shorts are switched on, so Core shorts it. Size is scaled by volatility.`
                 : `${coin} is above where it traded 28 days ago, so Core holds it. Size is scaled by volatility so a wild market means a smaller position.`)
      : `Rebalance only: the target size changed (volatility moved, the coin list changed, or the account grew/shrank), so the position was resized. Trend unchanged.`;
  return `🛡️ <b>Core Mode Trade</b> (demo)

<b>${coin}USDT</b> - ${removed ? "removed from Core" : `28d Trend: ${trend}`}
${isShort ? "Short" : "Long"}  │  ${action}  │  principal ${CORE_LEVERAGE}x${profit > 0 ? ` + profits ${CORE_PROFIT_LEV}x` : ""}

${levels}

<b>Size:</b> ${side} ${qty} ${coin} → holding ${targetQty} ${coin} (≈ ${fmt(targetQty * px, 0)} VST)
<b>Weight:</b> ${(Math.abs(w) * 100).toFixed(1)}% of Core budget │ Core gets ${CORE_ALLOC * 100}% of ${fmt(equity, 0)} VST
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
  if (!st.coreStart) st.coreStart = Number(process.env.CORE_START_EQUITY) || equity;
  const coreStart = st.coreStart;

  // one-time migration (v20.4): adopt the BTC/ETH positions + stops v20.0-v20.3 opened
  if (!st.coreQty) {
    st.coreQty = {}; st.coreStopIds = {};
    for (const symbol of ["BTC-USDT", "ETH-USDT"]) {
      const p = pos.positions.find(x => x.symbol === symbol && x.direction === "Long");
      if (!p) continue;
      st.coreQty[symbol] = p.amt;
      const oo = await openOrderIds(symbol);
      const stop = (oo || []).find(o => o.positionSide === "LONG" && /STOP/.test(o.type || "") && !/TAKE_PROFIT/.test(o.type || ""));
      if (stop) st.coreStopIds[symbol] = String(stop.orderId);
    }
  }
  const save = () => fs.writeFileSync(CORE_STATE_FILE, JSON.stringify(st));
  const regime = await marketRegime();
  save();

  // coins to manage: the configured list + anything Core still holds (removed coins get closed)
  const held = Object.keys(st.coreQty).filter(k => st.coreQty[k] > 0).map(k => k.split("|")[0]);
  const symbols = [...new Set([...CORE_ASSETS, ...held])];
  for (const symbol of symbols) {
    try {
      const wRaw = CORE_ASSETS.includes(symbol) ? (st.weights[symbol] || 0) : 0;
      const w = (wRaw < 0 && (!CORE_SHORTS || regime === "bull")) ? 0 : wRaw;   // shorts off, or bull market -> no Core shorts
      const px = await lastPrice(symbol.replace("-USDT", ""));
      if (!px) continue;
      const prec = await getQuantityPrecision(symbol);
      const principal = Math.min(equity, coreStart), profit = Math.max(0, equity - coreStart);
      const exposure = principal * CORE_LEVERAGE + profit * CORE_PROFIT_LEV;
      const effLev = Math.max(1, Math.ceil((exposure / equity) - 0.05));   // 1.001 stays 1x
      const qtyAbs = Number(((Math.abs(w) * exposure * CORE_ALLOC) / px).toFixed(prec));
      const targets = { LONG: w > 0 ? qtyAbs : 0, SHORT: w < 0 ? qtyAbs : 0 };
      // close/shrink the leg going to zero first so margin is freed before opening the other
      const legs = ["LONG", "SHORT"].sort((x, y) => (targets[x] === 0 ? -1 : 0) - (targets[y] === 0 ? -1 : 0));
      for (const leg of legs) {
        const key = legKey(symbol, leg);
        const targetQty = targets[leg];
        const exQty = pos.positions.find(p => p.symbol === symbol && p.direction === (leg === "SHORT" ? "Short" : "Long"))?.amt || 0;
        const curQty = Math.min(st.coreQty[key] || 0, exQty);   // never trade more than really exists
        const diff = Number((targetQty - curQty).toFixed(prec));
        const needTrade = targetQty === 0 ? curQty > 0 : Math.abs(diff) * px > 0.10 * targetQty * px;
        // v21.1: never open/grow a leg that another module (Aggro) already holds on the same
        // coin+side — leverage on BingX is per coin+side, so mixing would drag Aggro's 40x
        // margin onto Core's position (or Core's 1x onto Aggro's).
        const foreign = exQty - (st.coreQty[key] || 0) > 1e-9;
        if (needTrade && diff > 0 && foreign) {
          if (!coreForeignWarned[key]) { coreForeignWarned[key] = true; console.log(`Core: skipping ${symbol} ${leg}, another module holds that side`); }
          continue;
        }
        if (!needTrade) {
          if (curQty > 0 && coreLevSynced[key] !== effLev) {
            await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol, side: leg, leverage: effLev });
            coreLevSynced[key] = effLev;
          }
          if (curQty > 0) {   // self-heal: Core's own stop must exist
            const oo = await openOrderIds(symbol);
            if (oo && !oo.some(o => String(o.orderId) === st.coreStopIds?.[key])) { await placeCoreStop(st, symbol, curQty, px, leg); save(); }
          }
          continue;
        }
        await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol, side: leg, leverage: effLev });
        coreLevSynced[key] = effLev;
        const grow = diff > 0;
        const side = leg === "LONG" ? (grow ? "BUY" : "SELL") : (grow ? "SELL" : "BUY");
        const qty = targetQty === 0 ? curQty : Math.abs(diff);
        const r = await bingxRequest("POST", "/openApi/swap/v2/trade/order", { symbol, side, positionSide: leg, type: "MARKET", quantity: qty });
        if (r.error || r.code !== 0) {
          await sendTelegram(`⚠️ <b>Core mode order failed</b>\n${symbol} ${leg} ${side} ${qty}\n${JSON.stringify(r).slice(0, 200)}`);
          continue;
        }
        // use what BingX ACTUALLY filled (e.g. INJ fills whole units)
        const filled = parseFloat(r.data?.order?.executedQty ?? qty) || 0;
        const heldQty = Number(Math.max(0, grow ? curQty + filled : curQty - filled).toFixed(prec));
        st.coreQty[key] = heldQty; save();
        const stopOk = await placeCoreStop(st, symbol, heldQty, px, leg); save();
        const msg = formatCoreTrade({ symbol, side, qty: filled || qty, px, targetQty: heldQty, curQty, w, equity, stopOk, principal, profit, leg });
        console.log(msg.replace(/<[^>]+>/g, ""));
        await sendTelegram(msg);
      }
    } catch (err) {
      console.error(`Core exec ${symbol} failed (non-fatal):`, err.message);
    }
  }
}


// ---------------- Aggro state ----------------
const AGGRO = (process.env.AGGRO || "on") === "on";
const AGGRO_BUDGET = Number(process.env.AGGRO_BUDGET || 20000);
const AGGRO_RISK = Math.min(0.5, Math.max(0.01, Number(process.env.AGGRO_RISK || 0.5)));
const AGGRO_LEVERAGE = Math.min(50, Math.max(1, Number(process.env.AGGRO_LEVERAGE || 40)));
const AGGRO_FILE = path.join(DATA_DIR, "aggro_state.json");
function readAggro() {
  try { return JSON.parse(fs.readFileSync(AGGRO_FILE, "utf8")); }
  catch { return { start: AGGRO_BUDGET, balance: AGGRO_BUDGET, peak: AGGRO_BUDGET, trades: 0, wins: 0, busted: false, startedAt: new Date().toISOString() }; }
}
function writeAggro(a) { fs.writeFileSync(AGGRO_FILE, JSON.stringify(a)); }

// ============================================================
// 🧠 CONFLUENCE ENGINE (v25) — Krysie's 10 strategies, live
//  1 S/R key level  2 Demand/Supply zone  3 Swing structure (BOS/CHoCH)
//  4 Break & retest  5 Reversal (failed high/low, double top/bottom)
//  6 Trendline bounce/break  7 Fibonacci 50-61.8%  8 Consolidation breakout
//  9 Price + volume (Tim Ord low-volume test, volume climax)  10 CRT (NY 4H purge)
// Each detector sees only closed candles up to the current one. A setup's
// CONFLUENCE SCORE = how many of the 10 agree on its direction.
// Line-for-line port of research/confluence_detectors.py.
// ============================================================
const CF_NAMES = ["sr", "zone", "structure", "retest", "reversal", "trendline", "fib", "consolidation", "volume", "crt"];
const CF_LABEL = { sr: "Key level S/R", zone: "Demand/Supply zone", structure: "Swing structure", retest: "Break & retest", reversal: "Reversal pattern",
  trendline: "Trendline", fib: "Fib 50-61.8%", consolidation: "Consolidation breakout", volume: "Price + volume", crt: "CRT timing" };
const CF_P = 3;
function cfPivots(b) {
  const H = new Array(b.length).fill(false), L = new Array(b.length).fill(false);
  for (let k = CF_P; k < b.length - CF_P; k++) {
    let h = true, l = true;
    for (let d = -CF_P; d <= CF_P; d++) { if (!d) continue; if (!(b[k].h > b[k + d].h)) h = false; if (!(b[k].l < b[k + d].l)) l = false; }
    H[k] = h; L[k] = l;
  }
  return { H, L };
}
function cfAtr(b, i, n = 14) {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c));
  return s / n;
}
function nyHour(ms) { return Number(new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })) % 24; }
class ConfEngine {
  constructor(b) { this.b = b; const p = cfPivots(b); this.H = p.H; this.L = p.L; this.ph = []; this.pl = []; this.zD = []; this.zS = []; this.armed = null; }
  update(i) {
    const b = this.b, k = i - CF_P;
    if (k >= CF_P && this.H[k]) this.ph.push(k);
    if (k >= CF_P && this.L[k]) this.pl.push(k);
    if (i > 20) {
      const a = cfAtr(b, i);
      const sl = b.slice(i - 4, i - 2);
      if (b[i].c - b[i - 3].o > 2.5 * a) this.zD.push([Math.min(...sl.map(x => x.l)), Math.max(...sl.map(x => x.o)), i]);
      if (b[i - 3].o - b[i].c > 2.5 * a) this.zS.push([Math.min(...sl.map(x => x.o)), Math.max(...sl.map(x => x.h)), i]);
      this.zD = this.zD.filter(z => i - z[2] < 300 && b[i].c > z[0] * 0.995).slice(-8);
      this.zS = this.zS.filter(z => i - z[2] < 300 && b[i].c < z[1] * 1.005).slice(-8);
    }
  }
  signals(i, trend4h) {
    const b = this.b, x = b[i], a = cfAtr(b, i), out = {}, trig = [], ph = this.ph, pl = this.pl;
    const last = arr => arr[arr.length - 1], prev = arr => arr[arr.length - 2];
    // 3 structure
    let st = null;
    if (ph.length >= 2 && pl.length >= 2) {
      if (b[last(ph)].h > b[prev(ph)].h && b[last(pl)].l > b[prev(pl)].l) st = "L";
      if (b[last(ph)].h < b[prev(ph)].h && b[last(pl)].l < b[prev(pl)].l) st = "S";
      if (x.c > b[last(ph)].h && st === "S") st = "L";
      if (x.c < b[last(pl)].l && st === "L") st = "S";
    }
    out.structure = st;
    // 1 S/R
    const lv = [...ph.slice(-12).map(k => b[k].h), ...pl.slice(-12).map(k => b[k].l)];
    let sr = null;
    for (const L_ of lv) {
      if (lv.filter(v => Math.abs(v - L_) / L_ < 0.004).length >= 2) {
        if (x.l <= L_ * 1.002 && x.c > L_ && x.c > x.o) { sr = "L"; trig.push(["sr", "L", x.l]); }
        if (x.h >= L_ * 0.998 && x.c < L_ && x.c < x.o) { sr = "S"; trig.push(["sr", "S", x.h]); }
        if (sr) break;
      }
    }
    out.sr = sr;
    // 2 zones
    let dz = null;
    for (const z of this.zD) if (z[2] < i - 3 && x.l <= z[1] && x.c > z[1] && x.c > x.o) { dz = "L"; trig.push(["zone", "L", Math.min(x.l, z[0])]); break; }
    if (!dz) for (const z of this.zS) if (z[2] < i - 3 && x.h >= z[0] && x.c < z[0] && x.c < x.o) { dz = "S"; trig.push(["zone", "S", Math.max(x.h, z[1])]); break; }
    out.zone = dz;
    // 4 break & retest
    let br = null;
    if (this.armed && i - this.armed[2] > 24) this.armed = null;
    if (ph.length && x.c > b[last(ph)].h && b[i - 1].c <= b[last(ph)].h) this.armed = ["L", b[last(ph)].h, i];
    else if (pl.length && x.c < b[last(pl)].l && b[i - 1].c >= b[last(pl)].l) this.armed = ["S", b[last(pl)].l, i];
    else if (this.armed) {
      const [sd, l2] = this.armed;
      if (sd === "L" && x.l <= l2 * 1.003 && x.c > l2) { br = "L"; trig.push(["retest", "L", x.l]); this.armed = null; }
      else if (sd === "S" && x.h >= l2 * 0.997 && x.c < l2) { br = "S"; trig.push(["retest", "S", x.h]); this.armed = null; }
    }
    out.retest = br;
    // 5 reversal
    let rv = null;
    if (pl.length && i - last(pl) <= 60 && x.l < b[last(pl)].l && x.c > b[last(pl)].l) { rv = "L"; trig.push(["reversal", "L", x.l]); }
    else if (ph.length && i - last(ph) <= 60 && x.h > b[last(ph)].h && x.c < b[last(ph)].h) { rv = "S"; trig.push(["reversal", "S", x.h]); }
    else if (pl.length >= 2 && Math.abs(b[last(pl)].l - b[prev(pl)].l) / b[last(pl)].l < 0.004 && ph.length && last(ph) > prev(pl) && x.c > b[last(ph)].h && b[i - 1].c <= b[last(ph)].h) rv = "L";
    else if (ph.length >= 2 && Math.abs(b[last(ph)].h - b[prev(ph)].h) / b[last(ph)].h < 0.004 && pl.length && last(pl) > prev(ph) && x.c < b[last(pl)].l && b[i - 1].c >= b[last(pl)].l) rv = "S";
    out.reversal = rv;
    // 6 trendline
    let tl = null;
    if (pl.length >= 2 && b[last(pl)].l > b[prev(pl)].l) {
      const k1 = prev(pl), k2 = last(pl), y = b[k2].l + (b[k2].l - b[k1].l) / (k2 - k1) * (i - k2);
      if (x.l <= y * 1.002 && x.c > y) { tl = "L"; trig.push(["trendline", "L", x.l]); }
      else if (x.c < y * 0.997 && b[i - 1].c >= y) tl = "S";
    }
    if (!tl && ph.length >= 2 && b[last(ph)].h < b[prev(ph)].h) {
      const k1 = prev(ph), k2 = last(ph), y = b[k2].h + (b[k2].h - b[k1].h) / (k2 - k1) * (i - k2);
      if (x.h >= y * 0.998 && x.c < y) { tl = "S"; trig.push(["trendline", "S", x.h]); }
      else if (x.c > y * 1.003 && b[i - 1].c <= y) tl = "L";
    }
    out.trendline = tl;
    // 7 fib
    let fb = null;
    if (ph.length && pl.length) {
      const lo = b[last(pl)].l, hi = b[last(ph)].h;
      if (last(ph) > last(pl)) { const f5 = hi - 0.5 * (hi - lo), f6 = hi - 0.618 * (hi - lo); if (x.l <= f5 && x.c >= f6 && x.c > x.o) { fb = "L"; trig.push(["fib", "L", Math.min(x.l, f6)]); } }
      else { const f5 = lo + 0.5 * (hi - lo), f6 = lo + 0.618 * (hi - lo); if (x.h >= f5 && x.c <= f6 && x.c < x.o) { fb = "S"; trig.push(["fib", "S", Math.max(x.h, f6)]); } }
    }
    out.fib = fb;
    // 8 consolidation
    let cb = null;
    const w12 = b.slice(i - 12, i), hi12 = Math.max(...w12.map(z => z.h)), lo12 = Math.min(...w12.map(z => z.l));
    if (hi12 - lo12 < 3 * a) { if (x.c > hi12) { cb = "L"; trig.push(["consolidation", "L", lo12]); } else if (x.c < lo12) { cb = "S"; trig.push(["consolidation", "S", hi12]); } }
    out.consolidation = cb;
    // 9 volume
    let vv = null; const av = b.slice(i - 20, i).reduce((s, z) => s + z.v, 0) / 20;
    if (pl.length && Math.abs(x.l - b[last(pl)].l) / x.l < 0.004 && x.v < 0.92 * b[last(pl)].v && x.c > x.o) vv = "L";
    else if (ph.length && Math.abs(x.h - b[last(ph)].h) / x.h < 0.004 && x.v < 0.92 * b[last(ph)].v && x.c < x.o) vv = "S";
    else if (x.v > 3 * av && (Math.min(x.o, x.c) - x.l) > 0.6 * (x.h - x.l)) vv = "L";
    else if (x.v > 3 * av && (x.h - Math.max(x.o, x.c)) > 0.6 * (x.h - x.l)) vv = "S";
    out.volume = vv;
    // 10 CRT
    let cr = null; const hr = nyHour(x.t + 3600000);
    if ((hr === 13 || hr === 5) && i >= 8) {
      const c2 = b.slice(i - 3, i + 1), c1 = b.slice(i - 7, i - 3);
      const h1 = Math.max(...c1.map(z => z.h)), l1 = Math.min(...c1.map(z => z.l)), h2 = Math.max(...c2.map(z => z.h)), l2 = Math.min(...c2.map(z => z.l)), cl = c2[3].c;
      if (hr === 13 && l2 < l1 && l1 < cl && cl < h1) { cr = "L"; trig.push(["crt", "L", l2]); }
      if (hr === 5 && h2 > h1 && l1 < cl && cl < h1) { cr = "S"; trig.push(["crt", "S", h2]); }
    }
    out.crt = cr;
    out.trend4h = trend4h === "up" ? "L" : trend4h === "down" ? "S" : null;
    return { out, trig };
  }
}
// Pick the best setup on bar i: direction with triggers, tightest valid stop, highest score.
function cfBest(eng, i, trend, allowShort, dMin, dMax, strats = CF_NAMES) {
  const r = eng.signals(i, trend), out = r.out, trig = r.trig.filter(t => strats.includes(t[0]));
  if (!trig.length) return null;
  const x = eng.b[i]; let best = null;
  for (const d of ["L", "S"]) {
    if (d === "S" && !allowShort) continue;
    const tg = trig.filter(t => t[1] === d); if (!tg.length) continue;
    const score = strats.filter(n => out[n] === d).length;
    const entry = x.c;
    const stops = tg.map(t => t[2] * (d === "L" ? 0.999 : 1.001)).filter(s => { const dd = Math.abs(entry - s) / entry; return dd >= dMin && dd <= dMax && (d === "L" ? s < entry : s > entry); });
    if (!stops.length) continue;
    const stop = d === "L" ? Math.max(...stops) : Math.min(...stops);
    if (!best || score > best.score) best = { side: d === "L" ? "Long" : "Short", d, score, stop, entry, triggers: [...new Set(tg.map(t => t[0]))], agree: strats.filter(n => out[n] === d), withTrend: out.trend4h === d, t: x.t };
  }
  return best;
}

// ============================================================
// 🎰 AGGRO v2 ENGINE (v22) — Krysie's style, WITH the trend
//
// The bot finds its own setups from BingX candles (no TradingView needed):
//  1. 4H trend decides direction: EMA20 vs EMA50 + HH/HL (up) or LH/LL (down).
//     Longs only in an uptrend, shorts only in a downtrend.
//  2. 1H breakout: a close through the last confirmed swing high (long) or
//     swing low (short) arms the setup for 24 hours.
//  3. Retest: price comes back to the broken level (±0.3%) and closes back on
//     the breakout side -> entry.
//  4. Stop just beyond the retest wick (0.3-5% away), leverage up to
//     AGGRO_LEVERAGE (auto-lowered so liquidation sits beyond the stop).
//  5. 40% off at 1R, stop -> breakeven, the rest trails under each new 1H
//     swing low (high for shorts) to ride the move.
// Backtest (SUI/ETH/BTC 1H, Apr 2024-Oct 2026, n=512): -0.12R avg (noise band
// includes 0), shorts -0.25R, longs ~0, biggest wins +44R/+24R. Fat-tailed:
// mostly small losses, a few huge winners. Demo experiment.
// ============================================================
// v25: Aggro trades Krysie's 10-strategy CONFLUENCE setups (was: single break & retest).
const AGGRO_TF = (process.env.AGGRO_TF || "4h") === "1h" ? "1h" : "4h";          // timeframe Aggro trades on
const AGGRO_MIN_CONF = Math.max(1, Math.min(10, Number(process.env.AGGRO_MIN_CONF || 4)));   // min strategies agreeing to trade
const AGGRO_STRATS = (process.env.AGGRO_STRATS || CF_NAMES.join(",")).split(",").map(x => x.trim()).filter(x => CF_NAMES.includes(x));   // strategy menu
const TF_STOP = { "1h": [0.003, 0.05], "4h": [0.005, 0.10] };
const AGGRO_COINS = (process.env.AGGRO_COINS || "ZRO,XRP,LINK,AVAX,ADA,OP").split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
const AG_PIV = 3;

async function agKlines(symbol, interval, limit) {
  const r = await fetch(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error(`no ${interval} klines for ${symbol}`);
  const ms = interval === "4h" ? 4 * 3600000 : 3600000, now = Date.now();
  return j.data.map(k => ({ t: +k.time, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }))
    .filter(k => k.t + ms <= now).sort((a, b) => a.t - b.t);   // closed bars only
}
function agEma(v, n) { const a = 2 / (n + 1); const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(o[i - 1] + a * (v[i] - o[i - 1])); return o; }
function agPivots(b) {
  const H = [], L = [];
  for (let k = 0; k < b.length; k++) {
    let h = k >= AG_PIV && k < b.length - AG_PIV, l = h;
    for (let d = -AG_PIV; d <= AG_PIV && (h || l); d++) { if (!d) continue; if (h && !(b[k].h > b[k + d]?.h)) h = false; if (l && !(b[k].l < b[k + d]?.l)) l = false; }
    H.push(h); L.push(l);
  }
  return { H, L };
}
function agTrend4h(b4) {   // trend known at each 4h bar's close
  const c = b4.map(x => x.c), e20 = agEma(c, 20), e50 = agEma(c, 50), { H, L } = agPivots(b4); const out = new Map();
  let lh = null, ph = null, ll = null, pl = null;
  for (let i = 0; i < b4.length; i++) {
    const k = i - AG_PIV;
    if (k >= AG_PIV && H[k]) { ph = lh; lh = b4[k].h; }
    if (k >= AG_PIV && L[k]) { pl = ll; ll = b4[k].l; }
    const ok = lh !== null && ph !== null && ll !== null && pl !== null;
    out.set(b4[i].t + 4 * 3600000, ok && e20[i] > e50[i] && lh > ph && ll > pl ? "up" : ok && e20[i] < e50[i] && lh < ph && ll < pl ? "down" : "none");
  }
  return out;
}

function agFmt(v) { return (v == null || isNaN(v)) ? "?" : Number(v).toLocaleString("en-US", { maximumSignificantDigits: 6 }); }

async function agOrder(params) {
  const r = await bingxRequest("POST", "/openApi/swap/v2/trade/order", params, AG_ACCT);
  if (r.error || r.code !== 0) return { ok: false, r };
  return { ok: true, id: String(r.data?.order?.orderId ?? ""), filled: parseFloat(r.data?.order?.executedQty ?? params.quantity) || 0 };
}
async function agCancel(symbol, id) { if (id) await bingxRequest("DELETE", "/openApi/swap/v2/trade/order", { symbol, orderId: id }, AG_ACCT); }

// Replays the confluence engine over the last closed bars and returns the setup on the LAST bar (if any).
async function cfScan(symbol, tf, strats = CF_NAMES, shadow = false) {
  const b = await agKlines(symbol, tf, 300);
  let trend = null;
  if (tf === "1h") { const b4 = await agKlines(symbol, "4h", 120); const tr = agTrend4h(b4); const key = Math.floor((b[b.length - 1].t + 3600000) / 14400000) * 14400000; trend = tr.get(key) ?? [...tr.values()].pop(); }
  const eng = new ConfEngine(b);
  for (let i = 30; i < b.length - 1; i++) { eng.update(i); eng.signals(i, trend); }   // warm up state (zones, armed retests)
  const i = b.length - 1; eng.update(i);
  const [dMin, dMax] = TF_STOP[tf];
  const best = cfBest(eng, i, trend, shadow || (await marketRegime()) !== "bull", dMin, dMax, strats);
  return { best, bars: b };
}

async function agEnter(a, symbol, sig, pos) {
  const coin = symbol.replace("-USDT", ""), side = sig.side, leg = side === "Long" ? "LONG" : "SHORT";
  if (side === "Short" && (await marketRegime()) === "bull") { console.log(`Aggro: ${symbol} short skipped, bull market (BTC 28d trend up)`); return; }
  const px = await lastPrice(coin); if (!px) return;
  const d = Math.abs(px - sig.stop) / px;
  const [dMin, dMax] = TF_STOP[sig.tf || "1h"];
  if (d < dMin || d > dMax || (side === "Long" ? sig.stop >= px : sig.stop <= px)) { console.log(`Aggro: ${symbol} ${side} skipped, stop distance ${(d * 100).toFixed(2)}%`); return; }
  if (pos.positions.some(p => p.symbol === symbol && p.direction === side)) { console.log(`Aggro v2: ${symbol} ${side} skipped, that side is already held${AGGRO_SEPARATE ? " on the Aggro account" : " (Core or another trade)"}`); return; }
  const { equity: agEq, available } = await getAccountEquity(AG_ACCT);
  const prec = await getQuantityPrecision(symbol);
  const lev = Math.max(1, Math.min(AGGRO_LEVERAGE, Math.floor(1 / (1.5 * d))));
  const bal = (AGGRO_SEPARATE || AGGRO_USE_EQUITY) && agEq ? agEq : a.balance;   // own/live account -> real equity compounds
  let notional = (bal * AGGRO_RISK) / d;
  const cap = (available || 0) * MAX_MARGIN_FRACTION * lev;
  if (notional > cap) notional = cap;
  const qty = Number((notional / px).toFixed(prec));
  if (!(qty > 0)) return;
  await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol, side: leg, leverage: lev }, AG_ACCT);
  const e = await agOrder({ symbol, side: side === "Long" ? "BUY" : "SELL", positionSide: leg, type: "MARKET", quantity: qty });
  if (!e.ok) { await sendTelegram(`⚠️ <b>Aggro order failed</b>\n${symbol} ${side} ${qty} @${lev}x\n${JSON.stringify(e.r).slice(0, 200)}`); return; }
  const filled = Number(e.filled.toFixed(prec)), R = Math.abs(px - sig.stop), sgn = side === "Long" ? 1 : -1;
  const exitSide = side === "Long" ? "SELL" : "BUY";
  const stop = await agOrder({ symbol, side: exitSide, positionSide: leg, type: "STOP_MARKET", quantity: filled, stopPrice: +sig.stop.toPrecision(6), workingType: "MARK_PRICE" });
  const tp1Qty = Number((filled * 0.4).toFixed(prec)), tp1 = px + sgn * R;
  const tp = tp1Qty > 0 ? await agOrder({ symbol, side: exitSide, positionSide: leg, type: "TAKE_PROFIT_MARKET", quantity: tp1Qty, stopPrice: +tp1.toPrecision(6), workingType: "MARK_PRICE" }) : { ok: false };
  const t = { symbol, side, leg, entry: px, stop: sig.stop, R, qty: filled, tp1, tp1Qty, stopId: stop.ok ? stop.id : null, tp1Id: tp.ok ? tp.id : null,
              part: false, riskVST: +(filled * R).toFixed(2), lev, d, openedAt: Date.now(), signalT: sig.t, tf: sig.tf || "1h", score: sig.score, agree: sig.agree };
  a.open = a.open || []; a.open.push(t); writeAggro(a);
  const tfU = (sig.tf || "1h").toUpperCase();
  await sendTelegram(`📊 <b>Trade Setup 🎰 AGGRO</b> (demo)

<b>${coin}USDT</b> │ ${side} │ ${tfU} │ ${lev}x
<b>Confluence: ${sig.score}/${AGGRO_STRATS.length}</b> strategies agree

<b>Entry:</b> $${agFmt(px)}
<b>Stop loss:</b> $${agFmt(sig.stop)} (${(d * 100).toFixed(2)}% away, beyond the trigger candle / zone)
<b>TP1:</b> $${agFmt(tp1)} (1R, closes 40%, then stop → breakeven)
<b>Runner:</b> 60% trails under each new ${tfU} swing ${side === "Long" ? "low" : "high"}, no fixed TP

<b>Checklist:</b>
${AGGRO_STRATS.map(n => `${sig.agree.includes(n) ? "✅" : "▫️"} ${CF_LABEL[n]}${sig.triggers.includes(n) ? " ← trigger" : ""}`).join("\n")}
${sig.withTrend ? "✅" : "▫️"} With the 4H trend

<b>Size:</b> ${filled} ${coin} (≈ ${agFmt(+(filled * px).toFixed(0))} VST) │ risk ≈ ${agFmt(+(filled * R).toFixed(0))} VST
<b>Aggro balance:</b> ${agFmt(+a.balance.toFixed(0))} VST │ ${(AGGRO_RISK * 100).toFixed(0)}% at risk per trade
${stop.ok ? "✅ Stop placed" : "❌ Stop NOT placed, check BingX"} │ ${tp.ok ? "✅ TP1 placed" : "❌ TP1 not placed"}`);
}


async function agManage(a, pos) {
  const still = [];
  for (const t of a.open || []) {
    try {
      const now = pos.positions.find(p => p.symbol === t.symbol && p.direction === t.side)?.amt || 0;
      const sgn = t.side === "Long" ? 1 : -1;
      if (now <= 0) {   // closed
        await agCancel(t.symbol, t.tp1Id); await agCancel(t.symbol, t.stopId);
        const runnerR = sgn * (t.stop - t.entry) / t.R;
        const R = +((t.part ? 0.4 * 1 + 0.6 * runnerR : runnerR) - 0.001 / t.d).toFixed(3);
        const pnl = t.riskVST * R;
        a.balance = +(a.balance + pnl).toFixed(2); a.trades += 1; if (R > 0) a.wins += 1;
        a.peak = Math.max(a.peak, a.balance); if (a.balance < a.start * 0.1) a.busted = true;
        // ♻️ RECYCLE: each time Aggro doubles, half its profit is banked for Core.
        if (a.balance >= a.start * 2) {
          const bank = +((a.balance - a.start) / 2).toFixed(2);
          if (AGGRO_SEPARATE || AGGRO_USE_EQUITY) {
            const lvl = Math.floor(a.balance / a.start);
            if (lvl > (a.recycleNudged || 1)) {
              a.recycleNudged = lvl;
              await sendTelegram(`♻️ <b>Recycle time</b>\nAggro is at ${lvl}x its start (${a.balance.toFixed(0)} VST). Move about ${bank.toFixed(0)} VST to the main account so Core holds it at low leverage.`);
            }
          } else {
            // Shared account: the money is already in the same wallet Core sizes from,
            // so banking = Aggro stops betting that half. Core's next rebalance uses it.
            a.balance = +(a.balance - bank).toFixed(2); a.banked = +((a.banked || 0) + bank).toFixed(2);
            await sendTelegram(`♻️ <b>Profit banked for Core</b>\nAggro doubled, so ${bank.toFixed(0)} VST of its profit is locked away from 40x and handed to Core (same account, Core sizes from total equity).\nAggro now trades from ${a.balance.toFixed(0)} VST │ banked so far: ${a.banked.toFixed(0)} VST`);
          }
        }
        (a.history = a.history || []).push({ symbol: t.symbol, side: t.side, R, pnl: +pnl.toFixed(2), closedAt: new Date().toISOString() });
        await sendTelegram(`🎰 <b>Aggro v2 trade closed</b> (demo)\n${t.symbol} ${t.side} ${t.lev}x: ≈ ${R > 0 ? "+" : ""}${R}R = ${pnl > 0 ? "+" : ""}${pnl.toFixed(0)} VST${t.part ? " (TP1 hit, runner stopped)" : ""}\nAggro balance: ${a.balance.toFixed(0)} VST (${((a.balance / a.start - 1) * 100).toFixed(0)}% from start) │ ${a.wins}W / ${a.trades - a.wins}L${a.busted ? "\n💀 Below 10% of the starting budget, Aggro has stopped." : ""}`);
        continue;
      }
      if (!t.part && now <= t.qty * 0.65) {   // TP1 filled -> stop to breakeven on the runner
        t.part = true; await agCancel(t.symbol, t.stopId);
        const s = await agOrder({ symbol: t.symbol, side: t.side === "Long" ? "SELL" : "BUY", positionSide: t.leg, type: "STOP_MARKET", quantity: now, stopPrice: +t.entry.toPrecision(6), workingType: "MARK_PRICE" });
        t.stopId = s.ok ? s.id : null; t.stop = t.entry;
        await sendTelegram(`🎯 <b>Aggro TP1 hit</b> ${t.symbol} ${t.side}: 40% closed at +1R, runner stop moved to breakeven ($${agFmt(t.entry)}). Now trailing.`);
      } else if (t.part) {   // trail under new confirmed 1H swing lows / above swing highs
        const b = await agKlines(t.symbol, t.tf || "1h", 60), { H, L } = agPivots(b);
        let best = t.stop;
        for (let k = 0; k < b.length; k++) {
          if (b[k].t <= t.openedAt) continue;
          if (t.side === "Long" && L[k] && b[k].l * 0.999 > best) best = b[k].l * 0.999;
          if (t.side === "Short" && H[k] && b[k].h * 1.001 < best) best = b[k].h * 1.001;
        }
        if (best !== t.stop) {
          await agCancel(t.symbol, t.stopId);
          const s = await agOrder({ symbol: t.symbol, side: t.side === "Long" ? "SELL" : "BUY", positionSide: t.leg, type: "STOP_MARKET", quantity: now, stopPrice: +best.toPrecision(6), workingType: "MARK_PRICE" });
          t.stopId = s.ok ? s.id : null; t.stop = best;
          console.log(`Aggro v2: ${t.symbol} ${t.side} runner stop trailed to ${best}`);
        }
      }
      still.push(t);
    } catch (err) { console.error(`Aggro manage ${t.symbol} failed (non-fatal):`, err.message); still.push(t); }
  }
  a.open = still;
}

async function aggroTick() {
  if (!AGGRO || !BINGX_API_KEY || !BINGX_API_SECRET) return;
  try {
    const a = readAggro(); a.lastEntryT = a.lastEntryT || {};
    if (AGGRO_USE_EQUITY) {   // live: the scoreboard follows the real account
      const { equity } = await getAccountEquity(AG_ACCT);
      if (equity) { if (!a.equityStart) { a.equityStart = true; a.start = equity; a.peak = equity; } a.balance = equity; a.peak = Math.max(a.peak, equity); }
    }
    let pos = await getOpenPositions(AG_ACCT); if (!pos.checked) return;
    await agManage(a, pos); writeAggro(a);
    if (a.busted || a.balance < a.start * 0.1) return;
    pos = await getOpenPositions(AG_ACCT); if (!pos.checked) return;
    for (const coin of AGGRO_COINS) {
      const symbol = `${coin}-USDT`;
      if ((a.open || []).some(t => t.symbol === symbol)) continue;
      try {
        const { best } = await cfScan(symbol, AGGRO_TF, AGGRO_STRATS);
        if (!best || best.score < AGGRO_MIN_CONF || a.lastEntryT[symbol] === best.t) continue;
        a.lastEntryT[symbol] = best.t; writeAggro(a);
        await agEnter(a, symbol, { ...best, tf: AGGRO_TF }, pos);
      } catch (err) { console.error(`Aggro scan ${symbol} failed (non-fatal):`, err.message); }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (err) { console.error("aggroTick failed (non-fatal):", err.message); }
}



// ============================================================
// 👁️ SHADOW LOG (v25) — records EVERY setup the 10 strategies find, on 1H and
// 4H, score 1 and up, traded or not, and tracks how each would have played out
// with Aggro's exits (40% at 1R -> breakeven -> trail the runner under swings).
// Silent: no Telegram. Read it at /shadow. Used at each review to tune the
// minimum score and which strategies stay on.
// ============================================================
const SHADOW_FILE = path.join(DATA_DIR, "shadow.json");
const SHADOW_COINS = (process.env.SHADOW_COINS || [...new Set([...AGGRO_COINS, ...CORE_ASSETS.map(s => s.replace("-USDT", ""))])].join(","))
  .split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
const SHADOW_MAX_BARS = { "1h": 240, "4h": 180 };
function readShadow() { try { return JSON.parse(fs.readFileSync(SHADOW_FILE, "utf8")); } catch { return { open: [], closed: [], since: new Date().toISOString() }; } }
function writeShadow(sh) { fs.writeFileSync(SHADOW_FILE, JSON.stringify(sh)); }

// Walks the bars after the setup with Aggro's exit rules. Returns null while still open.
function shadowWalk(t, b) {
  const i0 = b.findIndex(x => x.t === t.t);
  if (i0 < 0) return { R: null, note: "entry bar no longer in the window" };
  const { H, L } = agPivots(b), long = t.side === "Long", sg = long ? 1 : -1, R = Math.abs(t.entry - t.stop);
  let s = t.stop, part = false, got = 0, j = i0;
  for (j = i0 + 1; j < b.length && j <= i0 + SHADOW_MAX_BARS[t.tf]; j++) {
    const y = b[j], hit = long ? y.l <= s : y.h >= s, tp1 = t.entry + sg * R;
    if (!part && !hit && (long ? y.h >= tp1 : y.l <= tp1)) { part = true; got += 0.4; s = t.entry; }
    if (hit) return { R: +(got + (1 - (part ? 0.4 : 0)) * sg * (s - t.entry) / R - 0.001 / t.d).toFixed(3) };
    const kk = j - AG_PIV;
    if (part && kk > i0) {
      if (long && L[kk] && b[kk].l * 0.999 > s) s = b[kk].l * 0.999;
      if (!long && H[kk] && b[kk].h * 1.001 < s) s = b[kk].h * 1.001;
    }
  }
  if (j > i0 + SHADOW_MAX_BARS[t.tf]) { const lc = b[i0 + SHADOW_MAX_BARS[t.tf]].c; return { R: +(got + (1 - (part ? 0.4 : 0)) * sg * (lc - t.entry) / R - 0.001 / t.d).toFixed(3), note: "time exit" }; }
  return null;   // still running
}

async function shadowTick() {
  try {
    const sh = readShadow(), regime = await marketRegime(), have = new Set(sh.open.map(t => `${t.symbol}|${t.tf}|${t.t}|${t.side}`));
    for (const coin of SHADOW_COINS) {
      const symbol = `${coin}-USDT`;
      for (const tf of ["1h", "4h"]) {
        try {
          const { best, bars } = await cfScan(symbol, tf, CF_NAMES, true);
          if (best && !have.has(`${symbol}|${tf}|${best.t}|${best.side}`)) {
            const d = Math.abs(best.entry - best.stop) / best.entry;
            sh.open.push({ symbol, tf, t: best.t, side: best.side, score: best.score, agree: best.agree, triggers: best.triggers, withTrend: best.withTrend,
              entry: best.entry, stop: best.stop, d: +d.toFixed(5), regime, bullShortBlocked: best.side === "Short" && regime === "bull",
              aggroWouldTrade: tf === AGGRO_TF && best.score >= AGGRO_MIN_CONF && AGGRO_COINS.includes(coin) && !(best.side === "Short" && regime === "bull"),
              logged: new Date().toISOString() });
          }
          // resolve this coin/timeframe's open shadow setups with the bars we already have
          for (const t of sh.open.filter(x => x.symbol === symbol && x.tf === tf && !x.done)) {
            const r = shadowWalk(t, bars);
            if (r) { t.done = true; t.R = r.R; t.note = r.note; t.closedAt = new Date().toISOString(); }
          }
        } catch (err) { console.error(`Shadow ${symbol} ${tf} failed (non-fatal):`, err.message); }
        await new Promise(r => setTimeout(r, 150));
      }
    }
    sh.closed = [...sh.closed, ...sh.open.filter(t => t.done && t.R !== null)].slice(-5000);
    sh.open = sh.open.filter(t => !t.done);
    writeShadow(sh);
  } catch (err) { console.error("shadowTick failed (non-fatal):", err.message); }
}

function shadowSummary() {
  const sh = readShadow(), c = sh.closed;
  const stat = arr => { const n = arr.length; if (!n) return { n: 0 }; const m = arr.reduce((a, t) => a + t.R, 0) / n;
    return { n, winRatePct: +(arr.filter(t => t.R > 0).length / n * 100).toFixed(0), avgR: +m.toFixed(3), totalR: +(m * n).toFixed(1) }; };
  const byScore = {}, byStrategy = {}, byTrigger = {};
  for (const tf of ["1h", "4h"]) {
    for (let k = 1; k <= 6; k++) byScore[`${tf} score ${k}${k === 6 ? "+" : ""}`] = stat(c.filter(t => t.tf === tf && (k < 6 ? t.score === k : t.score >= 6)));
  }
  for (const n of CF_NAMES) { byStrategy[CF_LABEL[n]] = stat(c.filter(t => t.agree.includes(n))); byTrigger[CF_LABEL[n]] = stat(c.filter(t => t.triggers.includes(n))); }
  return { since: sh.since, openNow: sh.open.length, closed: c.length,
    aggroRuleTrades: stat(c.filter(t => t.aggroWouldTrade)), allExceptBullShorts: stat(c.filter(t => !t.bullShortBlocked)),
    byScore, byStrategyAgreeing: byStrategy, byTriggerStrategy: byTrigger, last20: c.slice(-20) };
}

// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const json = (obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj, null, 2)); };
  if (req.method === "GET" && pathname === "/") {
    return json({ bot: "Two-Speed", label: BOT_LABEL || "demo", exchange: BINGX_BASE_URL.includes("vst") ? "BingX DEMO (VST)" : "BingX LIVE", coreOn: CORE_ON, shadowOn: SHADOW_ON, version: SERVER_VERSION, regime: regimeCache.value, core: { execute: CORE_EXECUTE, coins: CORE_ASSETS, shorts: CORE_SHORTS },
      aggro: { on: AGGRO, account: AGGRO_SEPARATE ? "own sub-account" : "shared main account", coins: AGGRO_COINS, timeframe: AGGRO_TF, minConfluence: AGGRO_MIN_CONF, strategies: AGGRO_STRATS, maxLeverage: AGGRO_LEVERAGE },
      shadow: { coins: SHADOW_COINS, timeframes: ["1h", "4h"] } });
  }
  if (req.method === "GET" && pathname === "/shadow") return json(shadowSummary());
  if (req.method === "GET" && pathname === "/core") {
    const log = readCoreLog();
    return json({ strategy: "28d trend filter, 40% vol target, daily", state: readCoreState(), days: log.length, log: log.slice(-60) });
  }
  if (req.method === "GET" && pathname === "/aggro") {
    const a = readAggro();
    const acctEq = AGGRO_SEPARATE ? (await getAccountEquity("aggro")).equity : null;
    return json({ on: AGGRO, account: AGGRO_SEPARATE ? "own sub-account" : "shared main account", accountEquity: acctEq, coins: AGGRO_COINS, riskPerTrade: AGGRO_RISK, maxLeverage: AGGRO_LEVERAGE, ...a, returnPct: +((a.balance / a.start - 1) * 100).toFixed(1) });
  }
  if (req.method === "POST" && pathname === "/webhook") {
    req.resume();   // old TradingView alerts: accepted and ignored (v19 retired in v23)
    return json({ ignored: true, reason: "v19 TradingView signals were retired in v23 — delete the alerts in TradingView" });
  }
  json({ error: "not found" }, 404);
});

server.listen(PORT, () => console.log(`Server ${SERVER_VERSION} running on port ${PORT}`));

if (CORE_ON) {
  setInterval(() => coreModeTick().then(coreExecute).catch(e => console.error("core loop:", e.message)), 60 * 60 * 1000);
  setTimeout(() => coreModeTick().then(coreExecute).catch(e => console.error("core loop:", e.message)), 2 * 60 * 1000);
}
setInterval(aggroTick, 5 * 60 * 1000);
setTimeout(aggroTick, 4 * 60 * 1000);
if (SHADOW_ON) {
  setInterval(shadowTick, 5 * 60 * 1000);
  setTimeout(shadowTick, 6 * 60 * 1000);
}
setInterval(() => stopWatchdog().catch(e => console.error("stopWatchdog failed (non-fatal):", e.message)), 15 * 60 * 1000);
setTimeout(() => stopWatchdog().catch(() => {}), 90 * 1000);
