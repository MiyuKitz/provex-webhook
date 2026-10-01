// ============================================================================
// STRUCTURAL STOP vs FIXED 5% STOP — retroactive A/B on real logged signals
// ============================================================================
//
// Same signals, same entries, same 40/30/30 ladder, same 48h window.
// The ONLY thing that changes is where the stop sits:
//
//   fixed 5%   (current live) : SL = entry x 1.05 / 0.95
//   structural (candidate)    : SL = OB boundary +/- buffer x zone height
//
// Because risk is the denominator of R, moving the stop also moves every TP
// (they are R multiples), so this is a test of the whole level structure,
// not just the stop.
//
// ---------------------------------------------------------------------------
// WHAT THIS CANNOT TELL YOU — read before acting on the output
// ---------------------------------------------------------------------------
// 1. RETROACTIVE. It replays history. The TP1=0.5R change also looked good
//    retroactively and came back -0.028R live. Treat a good number here as a
//    reason to forward-test, never as a result.
// 2. NO TP SNAPPING. Live computeOBLevels snaps TPs to opposing structure
//    (pobTop, swingLow) when that structure sits further out. Those values
//    were never logged, so this uses pure R multiples. Live TPs are
//    sometimes further away than modelled here.
// 3. NO FEES, NO SLIPPAGE. Commission ran ~3% of gross in the backtests.
// 4. SWEEPING BUFFERS IS NOT CHOOSING ONE. Several buffer sizes are printed
//    to show the shape of the response. Picking whichever scores best is
//    curve fitting — the same mistake that produced a "PF 16" strategy that
//    traded 3 times in 5 months.
// ============================================================================

const fs = require("fs");

const SIGNAL_FILE = "/data/signals.jsonl";
const TP_R = [0.5, 2, 3];                 // must match live computeOBLevels
const WEIGHTS = [0.4, 0.3, 0.3];
const BUFFERS = [0.25, 0.5, 1.0];         // x zone height, swept for shape
const MIN_STOP_PCT = 0.005;               // 0.5% floor — below this is noise
const MAX_STOP_PCT = 0.05;                // 5% cap — never risk more than today
const WINDOW_H = 48;
const REQ_DELAY_MS = 150;                 // be kind to the BingX rate limiter

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseLevels(str) {
  if (str == null) return [];
  return String(str).replace(/[$,\s]/g, "").split(/[-–—]/).map(Number).filter(n => !isNaN(n));
}

function toBingXSymbol(s) {
  return s && s.endsWith("USDT") && !s.includes("-") ? s.slice(0, -4) + "-USDT" : s;
}

async function fetchKlines(symbol, start, end) {
  const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines`
    + `?symbol=${symbol}&interval=5m&startTime=${start}&endTime=${end}&limit=1000`;
  try {
    const j = await (await fetch(url)).json();
    if (!Array.isArray(j.data)) return null;
    return j.data.map(k => ({ t: +k.time, h: +k.high, l: +k.low, c: +k.close }))
                 .sort((a, b) => a.t - b.t);
  } catch { return null; }
}

// Ladder walk — same rules as walkCandles in server.js v17.
function walk(bars, { zLo, zHi, entry, sl, tps, isShort }) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const rAt = (px) => (isShort ? entry - px : px - entry) / risk;
  const touched = (px, b) => isShort ? b.l <= px : b.h >= px;

  const slices = tps.map((price, i) => ({ price, weight: WEIGHTS[i], done: false }));
  let filled = false, realized = 0, lastClose = null, anyTP = false;

  for (const b of bars) {
    if (!filled) {
      if (b.l <= zHi && b.h >= zLo) filled = true;
      else continue;
    }
    lastClose = b.c;
    const hitSL = isShort ? b.h >= sl : b.l <= sl;
    const open = slices.filter(s => !s.done);
    const hitNow = open.filter(s => touched(s.price, b));

    // Stop and an unfilled target in the same 5m candle: order unknowable.
    if (hitSL && hitNow.length) return { outcome: "AMBIGUOUS", r: null, openW: 0 };

    for (const s of hitNow) { s.done = true; realized += s.weight * rAt(s.price); anyTP = true; }

    if (hitSL) {
      const openW = slices.filter(s => !s.done).reduce((a, s) => a + s.weight, 0);
      return { outcome: anyTP ? "TP_THEN_SL" : "SL", r: realized + openW * -1, openW: 0 };
    }
    if (slices.every(s => s.done)) return { outcome: "TP_ALL", r: realized, openW: 0 };
  }

  if (!filled) return { outcome: "NOT_TAKEN", r: null, openW: 0 };
  const openW = slices.filter(s => !s.done).reduce((a, s) => a + s.weight, 0);
  const mtm = lastClose != null ? rAt(lastClose) : 0;
  // Previously EXPIRED returned no R at all, so these trades were dropped from
  // the fixed-stop column but not the structural one — different samples, not
  // a comparison. Now every filled trade is valued the same way in both:
  // closed slices at their fill, open slices marked at the 48h close.
  return { outcome: anyTP ? "TP_OPEN_AT_EXPIRY" : "OPEN_NO_TP", r: realized + openW * mtm, openW };
}

function levels(zLo, zHi, isShort, mode, buffer) {
  const entry = (zLo + zHi) / 2;
  const height = zHi - zLo;
  let sl;
  if (mode === "fixed") {
    sl = isShort ? entry * 1.05 : entry * 0.95;
  } else {
    sl = isShort ? zHi + height * buffer : zLo - height * buffer;
    const pct = Math.abs(entry - sl) / entry;
    if (pct < MIN_STOP_PCT) sl = isShort ? entry * (1 + MIN_STOP_PCT) : entry * (1 - MIN_STOP_PCT);
    if (pct > MAX_STOP_PCT) sl = isShort ? entry * (1 + MAX_STOP_PCT) : entry * (1 - MAX_STOP_PCT);
  }
  const risk = Math.abs(entry - sl);
  const tps = TP_R.map(m => isShort ? entry - risk * m : entry + risk * m);
  return { entry, sl, tps, risk, stopPct: risk / entry * 100 };
}

function summarise(label, rows) {
  const scored = rows.filter(r => typeof r.r === "number");
  const closed = scored.filter(r => !r.openW);           // nothing left open at 48h
  const stat = (arr) => {
    const t = arr.reduce((a, r) => a + r.r, 0);
    return { n: arr.length, w: arr.filter(r => r.r > 0).length, l: arr.filter(r => r.r < 0).length,
             exp: arr.length ? t / arr.length : 0, total: t };
  };
  const a = stat(scored), c = stat(closed);
  const counts = {};
  rows.forEach(r => counts[r.outcome] = (counts[r.outcome] || 0) + 1);
  const avgStop = rows.reduce((a2, r) => a2 + r.stopPct, 0) / (rows.length || 1);
  console.log(
    label.padEnd(24) +
    `ALL n=${String(a.n).padStart(3)} W/L ${String(a.w).padStart(3)}/${String(a.l).padStart(3)} ` +
    `exp ${a.exp.toFixed(3).padStart(7)}R | ` +
    `FULLY CLOSED n=${String(c.n).padStart(3)} W/L ${String(c.w).padStart(3)}/${String(c.l).padStart(3)} ` +
    `exp ${c.exp.toFixed(3).padStart(7)}R | stop ${avgStop.toFixed(2)}%`
  );
  console.log("".padEnd(24) + "outcomes: " + JSON.stringify(counts));
}

(async () => {
  const all = fs.readFileSync(SIGNAL_FILE, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // OB signals only, with a parseable two-sided zone and a known direction.
  const cands = all.filter(s => {
    const z = parseLevels(s.entryZone);
    return s.symbol && s.direction && z.length === 2 && z[1] > z[0]
      && String(s.type || "").startsWith("OB_") && !String(s.type).startsWith("OB_SWING");
  });

  console.log(`signals in log: ${all.length}`);
  console.log(`OB signals usable for this test: ${cands.length}`);
  console.log(`fetching candles (~${Math.ceil(cands.length * REQ_DELAY_MS / 1000)}s)...\n`);

  const modes = [{ key: "fixed", buffer: null }, ...BUFFERS.map(b => ({ key: "structural", buffer: b }))];
  const results = Object.fromEntries(modes.map(m => [m.key + (m.buffer ?? ""), []]));
  let fetched = 0, skipped = 0;

  for (const s of cands) {
    const start = Date.parse(s.loggedAt);
    if (!start) { skipped++; continue; }
    const bars = await fetchKlines(toBingXSymbol(s.symbol), start, start + WINDOW_H * 3600e3);
    await sleep(REQ_DELAY_MS);
    if (!bars || bars.length < 5) { skipped++; continue; }
    fetched++;

    const [zLo, zHi] = parseLevels(s.entryZone);
    const isShort = s.direction === "Short";
    for (const m of modes) {
      const L = levels(zLo, zHi, isShort, m.key, m.buffer);
      const res = walk(bars, { zLo, zHi, entry: L.entry, sl: L.sl, tps: L.tps, isShort });
      if (res) results[m.key + (m.buffer ?? "")].push({ ...res, stopPct: L.stopPct });
    }
    if (fetched % 25 === 0) console.log(`  ...${fetched}/${cands.length}`);
  }

  console.log(`\nwalked ${fetched} signals, skipped ${skipped} (no candle data)\n`);
  console.log("=".repeat(96));
  summarise("FIXED 5% (live now)", results["fixed"]);
  console.log("-".repeat(96));
  for (const b of BUFFERS) summarise(`STRUCTURAL ${b}x height`, results["structural" + b]);
  console.log("=".repeat(96));
  console.log(`
Read this before drawing a conclusion:
  - Same signals and entries throughout; only stop placement differs.
  - Retroactive. TP1=0.5R also looked good retroactively and came back
    -0.028R live over 36 trades.
  - No fees or slippage; commission ran ~3% of gross in backtests.
  - TPs here are pure R multiples. Live snaps them to opposing structure
    when it sits further out, which was never logged.
  - Three buffers are shown to reveal the SHAPE of the response. If only one
    looks good and its neighbours do not, that is noise, not an edge.
  - ALL  = every filled trade, with any slice still open at 48h marked to
           market. Same trade set for every row, so the rows are comparable.
  - FULLY CLOSED = only trades with nothing left open. No unrealized marks at
           all, but a smaller and differently-selected sample per row. Read
           both; believe the comparison only where they agree.`);
})();
