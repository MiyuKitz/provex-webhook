// ============================================================================
// WHICH ENTRY CONDITIONS ACTUALLY PREDICT THE OUTCOME?
// ============================================================================
//
// Three exit configurations have now been refuted. This looks at the other
// side of the trade: whether anything known AT SIGNAL TIME separates the
// winners from the losers.
//
// Every signal is re-scored from candles using the CURRENT LIVE config
// (fixed 5% stop, TP 0.5R/2R/3R, 40/30/30 ladder, 48h window) so every
// bucket is measured the same way. Then outcomes are grouped by each
// checklist point, by raw score, by session, by direction, and by trend
// context.
//
// ---------------------------------------------------------------------------
// THE TRAP THIS SCRIPT IS BUILT TO AVOID
// ---------------------------------------------------------------------------
// Around 15 comparisons are run below. With that many, ONE will look
// impressive by pure chance even if nothing predicts anything. So each row
// reports:
//
//   n       - bucket size. Under 30 means believe nothing.
//   mean R  - expectancy for that bucket.
//   SE      - standard error of that mean. The true value is roughly
//             mean +/- 2*SE.
//   verdict - whether the gap between PASS and FAIL is larger than the
//             noise in the measurement (2 standard errors of the gap).
//
// A gap flagged "noise" is not a weak signal. It is no signal.
// Only a gap flagged SIGNIFICANT is worth a forward test, and even then it
// is one hypothesis to test, never a conclusion.
// ============================================================================

const fs = require("fs");

const SIGNAL_FILE = "/data/signals.jsonl";
const TP_R = [0.5, 2, 3];
const WEIGHTS = [0.4, 0.3, 0.3];
const SL_PCT = 0.05;              // live FIXED_SL_PCT
const COST_R = 0.02;              // ~0.10% round trip / 5% stop
const WINDOW_H = 48;
const REQ_DELAY_MS = 150;
const MIN_N = 30;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const parseLevels = (s) => s == null ? [] :
  String(s).replace(/[$,\s]/g, "").split(/[-–—]/).map(Number).filter(n => !isNaN(n));
const toBingX = (s) => s && s.endsWith("USDT") && !s.includes("-") ? s.slice(0, -4) + "-USDT" : s;

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

// Same ladder rules as server.js v17.
function walk(bars, zLo, zHi, isShort) {
  const entry = (zLo + zHi) / 2;
  const sl = isShort ? entry * (1 + SL_PCT) : entry * (1 - SL_PCT);
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const rAt = (px) => (isShort ? entry - px : px - entry) / risk;
  const hit = (px, b) => isShort ? b.l <= px : b.h >= px;

  const slices = TP_R.map((m, i) => ({
    price: isShort ? entry - risk * m : entry + risk * m, weight: WEIGHTS[i], done: false,
  }));
  let filled = false, realized = 0, last = null, anyTP = false;

  for (const b of bars) {
    if (!filled) { if (b.l <= zHi && b.h >= zLo) filled = true; else continue; }
    last = b.c;
    const hitSL = isShort ? b.h >= sl : b.l <= sl;
    const open = slices.filter(s => !s.done);
    const now = open.filter(s => hit(s.price, b));
    if (hitSL && now.length) return null;            // order unknowable, drop
    for (const s of now) { s.done = true; realized += s.weight * rAt(s.price); anyTP = true; }
    if (hitSL) {
      const w = slices.filter(s => !s.done).reduce((a, s) => a + s.weight, 0);
      return realized + w * -1;
    }
    if (slices.every(s => s.done)) return realized;
  }
  if (!filled) return null;
  const w = slices.filter(s => !s.done).reduce((a, s) => a + s.weight, 0);
  return realized + w * (last != null ? rAt(last) : 0);
}

function stats(rs) {
  const n = rs.length;
  if (!n) return { n: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n, mean, sd: Math.sqrt(variance), se: Math.sqrt(variance / n),
    w: rs.filter(r => r > 0).length, l: rs.filter(r => r < 0).length,
  };
}

function row(label, s) {
  if (!s.n) return `  ${label.padEnd(26)} (no trades)`;
  const net = s.mean - COST_R;
  return `  ${label.padEnd(26)} n=${String(s.n).padStart(3)}  ` +
    `W/L ${String(s.w).padStart(3)}/${String(s.l).padStart(3)}  ` +
    `gross ${s.mean.toFixed(3).padStart(7)}R  net ${net.toFixed(3).padStart(7)}R  ` +
    `+/-${(2 * s.se).toFixed(3)}` + (s.n < MIN_N ? "   [n<30, ignore]" : "");
}

// Is the gap between two buckets bigger than the noise in measuring it?
function compare(a, b) {
  if (!a.n || !b.n || a.n < MIN_N || b.n < MIN_N) return "  -> sample too small to compare";
  const diff = a.mean - b.mean;
  const seDiff = Math.sqrt(a.se ** 2 + b.se ** 2);
  const sig = Math.abs(diff) > 2 * seDiff;
  return `  -> gap ${diff >= 0 ? "+" : ""}${diff.toFixed(3)}R, noise band +/-${(2 * seDiff).toFixed(3)}R  ` +
    (sig ? "** SIGNIFICANT — worth a forward test **" : "NOISE, not a signal");
}

function split(rows, label, fn) {
  const groups = {};
  for (const r of rows) {
    const k = fn(r.sig);
    if (k == null) continue;
    (groups[k] = groups[k] || []).push(r.r);
  }
  const keys = Object.keys(groups).sort();
  if (!keys.length) return;
  console.log(`\n${label}`);
  const st = {};
  for (const k of keys) { st[k] = stats(groups[k]); console.log(row(k, st[k])); }
  if (keys.length === 2) console.log(compare(st[keys[0]], st[keys[1]]));
}

(async () => {
  const all = fs.readFileSync(SIGNAL_FILE, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const cands = all.filter(s => {
    const z = parseLevels(s.entryZone);
    return s.symbol && s.direction && z.length === 2 && z[1] > z[0]
      && Array.isArray(s.checklist) && String(s.type || "").startsWith("OB_")
      && !String(s.type).startsWith("OB_SWING");
  });

  console.log(`signals in log: ${all.length}`);
  console.log(`OB signals with a checklist: ${cands.length}`);
  console.log(`re-scoring from candles with the LIVE config (5% stop, TP 0.5/2/3)...\n`);

  const rows = [];
  let done = 0;
  for (const sig of cands) {
    const start = Date.parse(sig.loggedAt);
    if (!start) continue;
    const bars = await fetchKlines(toBingX(sig.symbol), start, start + WINDOW_H * 3600e3);
    await sleep(REQ_DELAY_MS);
    if (!bars || bars.length < 5) continue;
    const [zLo, zHi] = parseLevels(sig.entryZone);
    const r = walk(bars, zLo, zHi, sig.direction === "Short");
    if (r != null) rows.push({ sig, r });
    if (++done % 50 === 0) console.log(`  ...${done}/${cands.length}`);
  }

  const overall = stats(rows.map(r => r.r));
  console.log(`\n${"=".repeat(92)}`);
  console.log("BASELINE — every signal, same scoring");
  console.log(row("ALL SIGNALS", overall));
  console.log("=".repeat(92));

  const labels = [...new Set(cands.flatMap(s => s.checklist.map(c => c.label)))];
  for (const lab of labels) {
    split(rows, `CHECKLIST POINT: ${lab}`, (s) => {
      const c = (s.checklist || []).find(x => x.label === lab);
      if (!c) return null;
      return c.pass === 1 ? "PASS" : c.pass === 0 ? "FAIL" : "NEUTRAL";
    });
  }

  split(rows, "RAW SCORE", (s) => s.rawScore != null ? `score ${s.rawScore}` : null);
  split(rows, "SESSION", (s) => s.killzone ? "in kill zone" : "outside");
  split(rows, "DIRECTION", (s) => s.direction);
  split(rows, "CONFIDENCE", (s) => s.confidence || null);
  split(rows, "HTF TREND vs DIRECTION", (s) => {
    if (!s.htfTrend || s.htfTrend === "Unknown") return null;
    const opposes = (s.direction === "Short" && s.htfTrend === "Bullish")
                 || (s.direction === "Long" && s.htfTrend === "Bearish");
    return opposes ? "HTF opposes" : "HTF aligned";
  });
  split(rows, "REPEAT ZONE", (s) =>
    (s.flags || []).some(f => f.includes("Repeat signal on the same zone")) ? "repeat" : "fresh");

  console.log(`\n${"=".repeat(92)}`);
  console.log(`
How to read this:
  - Roughly 15 comparisons are run above. With that many, one will look
    impressive by chance alone even if nothing here predicts anything.
    That is why each gap is measured against its own noise band.
  - Only rows marked ** SIGNIFICANT ** are worth anything, and even those
    are a hypothesis to forward-test, not a result. The TP1=0.5R change
    looked good retroactively and returned -0.028R live.
  - net R subtracts ${COST_R}R for round-trip cost at a 5% stop. A filter has to
    beat the baseline by more than the trades it removes are worth.
  - If nothing is significant, that is the real answer: the checklist does
    not separate winners from losers, and the 5-point score is decoration.`);
})();
