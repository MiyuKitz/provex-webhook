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
const BINGX_BASE_URL   = "https://open-api-vst.bingx.com";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SERVER_VERSION = "v23.0";

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
  for (const s of valid) {
    const tw = coreTargetWeight(data[s].filter(k => k.t <= day));
    if (!tw) continue;
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
  const growing = isShort ? side === "SELL" : side === "BUY";
  const action = closing ? "CLOSE" : curQty === 0 ? "OPEN" : growing ? "ADD" : "TRIM";
  const trend = info.momPct == null ? "?" : `${info.momPct > 0 ? "Bullish" : "Bearish"} (${info.momPct > 0 ? "+" : ""}${info.momPct}%)`;
  const sizePct = info.vol ? Math.min(100, Math.round(4000 / info.vol)) : null;
  const ref = `$${fmt(info.refPrice)}`;
  const levels = closing
    ? `<b>Exit:</b> $${fmt(px)}\n<b>Reason:</b> the 28-day trend flipped (reference ${ref})`
    : `<b>Entry:</b> $${fmt(px)}
<b>Exit trigger:</b> daily close ${isShort ? "above" : "below"} ${ref} (28-day reference, moves daily)
<b>Disaster stop:</b> $${fmt(px * (isShort ? 1 + CORE_DISASTER_STOP : 1 - CORE_DISASTER_STOP))} (${isShort ? "+" : "−"}15%)
<b>Take profit:</b> none, rides the trend until the exit trigger`;
  const checklist = closing
    ? `🔁 28-day trend flipped\n✅ ${isShort ? "Short" : "Long"} closed, its disaster stop cancelled`
    : `✅ 28-day trend ${isShort ? "negative" : "positive"}
${sizePct === 100 ? "✅" : "➖"} Volatility ${info.vol ?? "?"}% → size ${sizePct ?? "?"}% of full (target 40%)
${stopOk ? "✅ Disaster stop placed" : "❌ Disaster stop NOT confirmed, check BingX"}`;
  const reasoning = closing
    ? `${coin}'s 28-day trend flipped, so Core closes this ${isShort ? "short" : "long"}.`
    : action === "OPEN"
      ? (isShort ? `${coin} is below where it traded 28 days ago and shorts are switched on, so Core shorts it. Size is scaled by volatility.`
                 : `${coin} is above where it traded 28 days ago, so Core holds it. Size is scaled by volatility so a wild market means a smaller position.`)
      : `Rebalance only: volatility moved, so the position was resized to stay near the 40% volatility target. Trend unchanged.`;
  return `🛡️ <b>Core Mode Trade</b> (demo)

<b>${coin}USDT</b> - 28d Trend: ${trend}
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
const AGGRO_COINS = (process.env.AGGRO_COINS || "ZRO,XRP,LINK,AVAX,ADA,OP").split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
const AG_PIV = 3;

async function agKlines(symbol, interval, limit) {
  const r = await fetch(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error(`no ${interval} klines for ${symbol}`);
  const ms = interval === "4h" ? 4 * 3600000 : 3600000, now = Date.now();
  return j.data.map(k => ({ t: +k.time, o: +k.open, h: +k.high, l: +k.low, c: +k.close }))
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
// Replays the state machine over recent bars; returns a signal only if the LAST closed 1H bar triggers.
function agScan(b, b4) {
  const tr = agTrend4h(b4), { H, L } = agPivots(b);
  let sh = null, sl = null, armed = null, t4 = null, sig = null;
  for (let i = 10; i < b.length; i++) {
    const k = i - AG_PIV; if (H[k]) sh = b[k].h; if (L[k]) sl = b[k].l;
    const key = Math.floor((b[i].t + 3600000) / 14400000) * 14400000; if (tr.has(key)) t4 = tr.get(key);
    sig = null; if (!t4) continue;
    const x = b[i];
    if (t4 === "up" && sh && x.c > sh && b[i - 1].c <= sh) { armed = { side: "Long", lv: sh, st: i }; sh = null; continue; }
    if (t4 === "down" && sl && x.c < sl && b[i - 1].c >= sl) { armed = { side: "Short", lv: sl, st: i }; sl = null; continue; }
    if (!armed) continue;
    const { side, lv, st } = armed;
    if (i - st > 24 || (side === "Long" && t4 !== "up") || (side === "Short" && t4 !== "down")) { armed = null; continue; }
    if (side === "Long") { if (x.c < lv * 0.99) { armed = null; continue; } if (!(x.l <= lv * 1.003 && x.c > lv)) continue; sig = { side, lv, entry: x.c, stop: x.l * 0.999, t: x.t }; }
    else { if (x.c > lv * 1.01) { armed = null; continue; } if (!(x.h >= lv * 0.997 && x.c < lv)) continue; sig = { side, lv, entry: x.c, stop: x.h * 1.001, t: x.t }; }
    armed = null;
  }
  return { sig, pivots: { H, L }, bars: b };
}

function agFmt(v) { return (v == null || isNaN(v)) ? "?" : Number(v).toLocaleString("en-US", { maximumSignificantDigits: 6 }); }

async function agOrder(params) {
  const r = await bingxRequest("POST", "/openApi/swap/v2/trade/order", params);
  if (r.error || r.code !== 0) return { ok: false, r };
  return { ok: true, id: String(r.data?.order?.orderId ?? ""), filled: parseFloat(r.data?.order?.executedQty ?? params.quantity) || 0 };
}
async function agCancel(symbol, id) { if (id) await bingxRequest("DELETE", "/openApi/swap/v2/trade/order", { symbol, orderId: id }); }

async function agEnter(a, symbol, sig, pos) {
  const coin = symbol.replace("-USDT", ""), side = sig.side, leg = side === "Long" ? "LONG" : "SHORT";
  if (side === "Short" && (await marketRegime()) === "bull") { console.log(`Aggro: ${symbol} short skipped, bull market (BTC 28d trend up)`); return; }
  const px = await lastPrice(coin); if (!px) return;
  const d = Math.abs(px - sig.stop) / px;
  if (d < 0.003 || d > 0.05 || (side === "Long" ? sig.stop >= px : sig.stop <= px)) { console.log(`Aggro v2: ${symbol} ${side} skipped, stop distance ${(d * 100).toFixed(2)}%`); return; }
  if (pos.positions.some(p => p.symbol === symbol && p.direction === side)) { console.log(`Aggro v2: ${symbol} ${side} skipped, that side is already held (Core or another trade)`); return; }
  const { available } = await getAccountEquity();
  const prec = await getQuantityPrecision(symbol);
  const lev = Math.max(1, Math.min(AGGRO_LEVERAGE, Math.floor(1 / (1.5 * d))));
  let notional = (a.balance * AGGRO_RISK) / d;
  const cap = (available || 0) * MAX_MARGIN_FRACTION * lev;
  if (notional > cap) notional = cap;
  const qty = Number((notional / px).toFixed(prec));
  if (!(qty > 0)) return;
  await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol, side: leg, leverage: lev });
  const e = await agOrder({ symbol, side: side === "Long" ? "BUY" : "SELL", positionSide: leg, type: "MARKET", quantity: qty });
  if (!e.ok) { await sendTelegram(`⚠️ <b>Aggro order failed</b>\n${symbol} ${side} ${qty} @${lev}x\n${JSON.stringify(e.r).slice(0, 200)}`); return; }
  const filled = Number(e.filled.toFixed(prec)), R = Math.abs(px - sig.stop), sgn = side === "Long" ? 1 : -1;
  const exitSide = side === "Long" ? "SELL" : "BUY";
  const stop = await agOrder({ symbol, side: exitSide, positionSide: leg, type: "STOP_MARKET", quantity: filled, stopPrice: +sig.stop.toPrecision(6), workingType: "MARK_PRICE" });
  const tp1Qty = Number((filled * 0.4).toFixed(prec)), tp1 = px + sgn * R;
  const tp = tp1Qty > 0 ? await agOrder({ symbol, side: exitSide, positionSide: leg, type: "TAKE_PROFIT_MARKET", quantity: tp1Qty, stopPrice: +tp1.toPrecision(6), workingType: "MARK_PRICE" }) : { ok: false };
  const t = { symbol, side, leg, entry: px, stop: sig.stop, R, qty: filled, tp1, tp1Qty, stopId: stop.ok ? stop.id : null, tp1Id: tp.ok ? tp.id : null,
              part: false, riskVST: +(filled * R).toFixed(2), lev, d, openedAt: Date.now(), signalT: sig.t, level: sig.lv };
  a.open = a.open || []; a.open.push(t); writeAggro(a);
  await sendTelegram(`📊 <b>Trade Setup 🎰 AGGRO v2</b> (demo)

<b>${coin}USDT</b> - 4H Trend: ${side === "Long" ? "Bullish" : "Bearish"} (trading WITH it)
${side}  │  Break & Retest  │  ${lev}x

<b>Entry:</b> $${agFmt(px)}
<b>Stop loss:</b> $${agFmt(sig.stop)} (${(d * 100).toFixed(2)}% away, just beyond the retest wick)
<b>TP1:</b> $${agFmt(tp1)} (1R, closes 40%, then stop → breakeven)
<b>Runner:</b> 60% trails under each new 1H swing ${side === "Long" ? "low" : "high"}, no fixed TP

<b>Setup:</b> 1H close broke the swing ${side === "Long" ? "high" : "low"} at $${agFmt(sig.lv)}, price came back, tested it and held.
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
        const b = await agKlines(t.symbol, "1h", 60), { H, L } = agPivots(b);
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
    let pos = await getOpenPositions(); if (!pos.checked) return;
    await agManage(a, pos); writeAggro(a);
    if (a.busted || a.balance < a.start * 0.1) return;
    pos = await getOpenPositions(); if (!pos.checked) return;
    for (const coin of AGGRO_COINS) {
      const symbol = `${coin}-USDT`;
      if ((a.open || []).some(t => t.symbol === symbol)) continue;
      try {
        const b = await agKlines(symbol, "1h", 200), b4 = await agKlines(symbol, "4h", 120);
        const { sig } = agScan(b, b4);
        if (!sig || a.lastEntryT[symbol] === sig.t) continue;
        a.lastEntryT[symbol] = sig.t; writeAggro(a);
        await agEnter(a, symbol, sig, pos);
      } catch (err) { console.error(`Aggro scan ${symbol} failed (non-fatal):`, err.message); }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (err) { console.error("aggroTick failed (non-fatal):", err.message); }
}


// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const json = (obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj, null, 2)); };
  if (req.method === "GET" && pathname === "/") {
    return json({ bot: "Two-Speed", version: SERVER_VERSION, regime: regimeCache.value, core: { execute: CORE_EXECUTE, coins: CORE_ASSETS, shorts: CORE_SHORTS },
      aggro: { on: AGGRO, coins: AGGRO_COINS, maxLeverage: AGGRO_LEVERAGE } });
  }
  if (req.method === "GET" && pathname === "/core") {
    const log = readCoreLog();
    return json({ strategy: "28d trend filter, 40% vol target, daily", state: readCoreState(), days: log.length, log: log.slice(-60) });
  }
  if (req.method === "GET" && pathname === "/aggro") {
    const a = readAggro();
    return json({ on: AGGRO, coins: AGGRO_COINS, riskPerTrade: AGGRO_RISK, maxLeverage: AGGRO_LEVERAGE, ...a, returnPct: +((a.balance / a.start - 1) * 100).toFixed(1) });
  }
  if (req.method === "POST" && pathname === "/webhook") {
    req.resume();   // old TradingView alerts: accepted and ignored (v19 retired in v23)
    return json({ ignored: true, reason: "v19 TradingView signals were retired in v23 — delete the alerts in TradingView" });
  }
  json({ error: "not found" }, 404);
});

server.listen(PORT, () => console.log(`Server ${SERVER_VERSION} running on port ${PORT}`));

setInterval(() => coreModeTick().then(coreExecute).catch(e => console.error("core loop:", e.message)), 60 * 60 * 1000);
setTimeout(() => coreModeTick().then(coreExecute).catch(e => console.error("core loop:", e.message)), 2 * 60 * 1000);
setInterval(aggroTick, 5 * 60 * 1000);
setTimeout(aggroTick, 4 * 60 * 1000);
setInterval(() => stopWatchdog().catch(e => console.error("stopWatchdog failed (non-fatal):", e.message)), 15 * 60 * 1000);
setTimeout(() => stopWatchdog().catch(() => {}), 90 * 1000);
