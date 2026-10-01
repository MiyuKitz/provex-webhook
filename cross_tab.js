// ============================================================================
// IS THE HTF FINDING REAL, OR A SHADOW OF SOMETHING ELSE?
// ============================================================================
//
// The entry test produced three "significant" results:
//   HTF opposes   +0.315R vs HTF aligned -0.063R
//   MEDIUM conf   +0.149R vs HIGH         -0.121R
//   kill zone     +0.233R vs outside      +0.046R
//
// Confidence is not independent: applyRiskGates FORCES confidence down to
// MEDIUM whenever HTF opposes. So "MEDIUM" is largely "HTF opposes" relabelled
// — one finding counted twice, not two findings.
//
// That leaves two candidates, HTF and session, plus direction as a third
// suspect. Any of them could be producing the others' apparent effect:
//   - if HTF-opposing trades happen to cluster in kill zones, one effect is
//     just the other seen sideways
//   - if HTF was mostly bullish in this period, "opposes" largely means
//     "short", and we would be measuring direction
//
// The test for that is stratification: if HTF still separates winners from
// losers INSIDE the kill zone AND INSIDE the outside bucket, and inside longs
// AND inside shorts, the effect is its own thing. If it disappears within
// strata, it was never HTF.
//
// Walked results are cached so later analyses do not refetch 360 signals.
// ============================================================================

const fs = require("fs");

const SIGNAL_FILE = "/data/signals.jsonl";
const CACHE_FILE = "/data/walk_cache.json";
const TP_R = [0.5, 2, 3];
const WEIGHTS = [0.4, 0.3, 0.3];
const SL_PCT = 0.05;
const WINDOW_H = 48;
const REQ_DELAY_MS = 150;
const MIN_N = 25;   // relaxed from 30: stratified cells are necessarily smaller

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
  let filled = false, realized = 0, last = null;
  for (const b of bars) {
    if (!filled) { if (b.l <= zHi && b.h >= zLo) filled = true; else continue; }
    last = b.c;
    const hitSL = isShort ? b.h >= sl : b.l <= sl;
    const now = slices.filter(s => !s.done && hit(s.price, b));
    if (hitSL && now.length) return null;
    for (const s of now) { s.done = true; realized += s.weight * rAt(s.price); }
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
  if (!n) return { n: 0, mean: 0, se: 0, w: 0, l: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, se: Math.sqrt(v / n), w: rs.filter(r => r > 0).length, l: rs.filter(r => r < 0).length };
}

function verdict(a, b, label) {
  if (a.n < MIN_N || b.n < MIN_N)
    return `    ${label.padEnd(44)} cells too small (n=${a.n}/${b.n})`;
  const diff = a.mean - b.mean;
  const band = 2 * Math.sqrt(a.se ** 2 + b.se ** 2);
  const sig = Math.abs(diff) > band;
  return `    ${label.padEnd(44)} gap ${(diff >= 0 ? "+" : "") + diff.toFixed(3)}R  ` +
    `band +/-${band.toFixed(3)}R  ${sig ? "** HOLDS **" : "vanishes (noise)"}`;
}

const cellStr = (s) => s.n
  ? `n=${String(s.n).padStart(3)} ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(3)}R (W/L ${s.w}/${s.l})`
  : "(empty)";

function crossTab(rows, title, rowFn, colFn) {
  const rowKeys = [...new Set(rows.map(r => rowFn(r.sig)).filter(Boolean))].sort();
  const colKeys = [...new Set(rows.map(r => colFn(r.sig)).filter(Boolean))].sort();
  const cell = {};
  for (const rk of rowKeys) for (const ck of colKeys)
    cell[rk + "|" + ck] = stats(rows.filter(r => rowFn(r.sig) === rk && colFn(r.sig) === ck).map(r => r.r));

  console.log(`\n${"=".repeat(94)}`);
  console.log(title);
  console.log("=".repeat(94));
  console.log("  " + "".padEnd(16) + colKeys.map(c => c.padEnd(32)).join(""));
  for (const rk of rowKeys)
    console.log("  " + rk.padEnd(16) + colKeys.map(ck => cellStr(cell[rk + "|" + ck]).padEnd(32)).join(""));

  console.log("\n  Does the ROW effect survive inside each column?");
  if (rowKeys.length === 2) for (const ck of colKeys)
    console.log(verdict(cell[rowKeys[0] + "|" + ck], cell[rowKeys[1] + "|" + ck], `within "${ck}"`));

  console.log("\n  Does the COLUMN effect survive inside each row?");
  if (colKeys.length === 2) for (const rk of rowKeys)
    console.log(verdict(cell[rk + "|" + colKeys[0]], cell[rk + "|" + colKeys[1]], `within "${rk}"`));
}

const htfOf = (s) => {
  if (!s.htfTrend || s.htfTrend === "Unknown") return null;
  const opposes = (s.direction === "Short" && s.htfTrend === "Bullish")
               || (s.direction === "Long" && s.htfTrend === "Bearish");
  return opposes ? "HTF opposes" : "HTF aligned";
};

(async () => {
  const all = fs.readFileSync(SIGNAL_FILE, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const cands = all.filter(s => {
    const z = parseLevels(s.entryZone);
    return s.symbol && s.direction && z.length === 2 && z[1] > z[0]
      && String(s.type || "").startsWith("OB_") && !String(s.type).startsWith("OB_SWING");
  });

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch {}
  const before = Object.keys(cache).length;
  console.log(`OB signals: ${cands.length} | cached walks: ${before}`);

  const rows = [];
  let fetched = 0;
  for (const sig of cands) {
    const key = `${sig.symbol}|${sig.loggedAt}|${sig.entryZone}|${sig.direction}`;
    if (!(key in cache)) {
      const start = Date.parse(sig.loggedAt);
      if (!start) continue;
      const bars = await fetchKlines(toBingX(sig.symbol), start, start + WINDOW_H * 3600e3);
      await sleep(REQ_DELAY_MS);
      if (!bars || bars.length < 5) continue;
      const [zLo, zHi] = parseLevels(sig.entryZone);
      cache[key] = walk(bars, zLo, zHi, sig.direction === "Short");
      if (++fetched % 50 === 0) console.log(`  ...fetched ${fetched}`);
    }
    if (cache[key] != null) rows.push({ sig, r: cache[key] });
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`walked ${rows.length} scorable signals (${fetched} newly fetched, cache now ${Object.keys(cache).length})`);

  const base = stats(rows.map(r => r.r));
  console.log(`\nBASELINE: ${cellStr(base)}`);

  // How much do the three candidate effects overlap? If HTF-opposing trades
  // are mostly shorts, or mostly in kill zones, the effects are not separable.
  const opp = rows.filter(r => htfOf(r.sig) === "HTF opposes");
  const ali = rows.filter(r => htfOf(r.sig) === "HTF aligned");
  const pct = (arr, f) => arr.length ? (arr.filter(f).length / arr.length * 100).toFixed(0) + "%" : "–";
  console.log(`\nOVERLAP CHECK`);
  console.log(`  of HTF-opposing trades: ${pct(opp, r => r.sig.direction === "Short")} are shorts, ${pct(opp, r => r.sig.killzone)} in kill zone`);
  console.log(`  of HTF-aligned  trades: ${pct(ali, r => r.sig.direction === "Short")} are shorts, ${pct(ali, r => r.sig.killzone)} in kill zone`);
  console.log(`  (similar percentages = the effects are separable; very different = they are entangled)`);

  crossTab(rows, "HTF  x  SESSION", htfOf, (s) => s.killzone ? "in kill zone" : "outside");
  crossTab(rows, "HTF  x  DIRECTION", htfOf, (s) => s.direction);

  console.log(`\n${"=".repeat(94)}`);
  console.log(`
How to read this:
  - "** HOLDS **" in every column means the row effect is its own thing, not
    a shadow of the column variable.
  - "vanishes" in any cell with a decent n means the effect was partly or
    wholly the other variable.
  - Stratified cells are smaller than the headline buckets, so noise bands are
    wider. An effect can be real and still fail to clear the band here — that
    is weak evidence, not disproof. What you want is consistency: same sign,
    similar size, in every cell.
  - Everything here remains retroactive. The TP1=0.5R change looked good
    retroactively and returned -0.028R live over 36 trades.`);
})();
