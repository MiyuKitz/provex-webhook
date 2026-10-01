// ============================================================================
// IS THE HTF EFFECT DURABLE, OR AN ARTIFACT OF ONE MARKET REGIME?
// ============================================================================
//
// The cross-tab showed HTF-opposing trades beating HTF-aligned ones in all
// four strata. But every signal in that sample comes from roughly a two-month
// window on one symbol.
//
// Counter-trend fading is exactly the kind of thing that looks brilliant in a
// range and gets destroyed in a trend. If SUI happened to range for most of
// the sample, the finding would look strong and still fail live the moment
// conditions change.
//
// So: cut the sample into halves by time (and into thirds, to see whether the
// effect drifts), and check whether the effect appears in every period.
//
//   - same sign + similar size in every period   -> durable, worth testing live
//   - huge in one period, absent in others       -> regime artifact, discard
//   - decaying across periods                    -> was real, may be gone now
//
// Reads walk results straight from the cache written by cross_tab.js, so this
// costs nothing and fetches nothing. Run cross_tab.js first if the cache is
// missing.
// ============================================================================

const fs = require("fs");

const SIGNAL_FILE = "/data/signals.jsonl";
const CACHE_FILE = "/data/walk_cache.json";
const MIN_N = 20;   // period cells are small; below this nothing is claimable

const parseLevels = (s) => s == null ? [] :
  String(s).replace(/[$,\s]/g, "").split(/[-–—]/).map(Number).filter(n => !isNaN(n));

function stats(rs) {
  const n = rs.length;
  if (!n) return { n: 0, mean: 0, se: 0, w: 0, l: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, se: Math.sqrt(v / n), w: rs.filter(r => r > 0).length, l: rs.filter(r => r < 0).length };
}

const htfOf = (s) => {
  if (!s.htfTrend || s.htfTrend === "Unknown") return null;
  const opposes = (s.direction === "Short" && s.htfTrend === "Bullish")
               || (s.direction === "Long" && s.htfTrend === "Bearish");
  return opposes ? "HTF opposes" : "HTF aligned";
};

const fmtCell = (s) => s.n
  ? `n=${String(s.n).padStart(3)} ${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)}R (${s.w}W/${s.l}L)`
  : "(none)";

function gap(a, b) {
  if (a.n < MIN_N || b.n < MIN_N) return `too few trades (${a.n}/${b.n})`;
  const d = a.mean - b.mean;
  const band = 2 * Math.sqrt(a.se ** 2 + b.se ** 2);
  return `${(d >= 0 ? "+" : "") + d.toFixed(3)}R  band +/-${band.toFixed(3)}R  ` +
    (Math.abs(d) > band ? "** HOLDS **" : "not distinguishable from noise");
}

function periodReport(title, buckets) {
  console.log(`\n${"=".repeat(94)}`);
  console.log(title);
  console.log("=".repeat(94));
  console.log("  " + "period".padEnd(26) + "HTF opposes".padEnd(30) + "HTF aligned".padEnd(30) + "gap");
  for (const b of buckets) {
    const opp = stats(b.rows.filter(r => htfOf(r.sig) === "HTF opposes").map(r => r.r));
    const ali = stats(b.rows.filter(r => htfOf(r.sig) === "HTF aligned").map(r => r.r));
    console.log("  " + b.label.padEnd(26) + fmtCell(opp).padEnd(30) + fmtCell(ali).padEnd(30) + gap(opp, ali));
  }
}

(() => {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch { console.log("No walk cache found. Run cross_tab.js first."); return; }

  const all = fs.readFileSync(SIGNAL_FILE, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const rows = [];
  for (const sig of all) {
    const z = parseLevels(sig.entryZone);
    if (!(sig.symbol && sig.direction && z.length === 2 && z[1] > z[0])) continue;
    if (!String(sig.type || "").startsWith("OB_") || String(sig.type).startsWith("OB_SWING")) continue;
    const key = `${sig.symbol}|${sig.loggedAt}|${sig.entryZone}|${sig.direction}`;
    const r = cache[key];
    if (r == null) continue;
    const t = Date.parse(sig.loggedAt);
    if (!t) continue;
    rows.push({ sig, r, t });
  }
  rows.sort((a, b) => a.t - b.t);

  if (rows.length < 60) { console.log(`Only ${rows.length} scorable signals — too few to split.`); return; }

  const d = (t) => new Date(t).toISOString().slice(0, 10);
  console.log(`scorable signals: ${rows.length}`);
  console.log(`date range: ${d(rows[0].t)} to ${d(rows[rows.length - 1].t)}`);
  const base = stats(rows.map(r => r.r));
  console.log(`whole-sample baseline: ${fmtCell(base)}`);

  // Equal-count splits, not equal-time: signal density varies week to week,
  // and equal-time halves could put 80% of the trades in one of them.
  const half = Math.floor(rows.length / 2);
  periodReport("SPLIT IN HALVES (equal trade counts)", [
    { label: `1st half ${d(rows[0].t)}+`, rows: rows.slice(0, half) },
    { label: `2nd half ${d(rows[half].t)}+`, rows: rows.slice(half) },
  ]);

  const third = Math.floor(rows.length / 3);
  periodReport("SPLIT IN THIRDS (checks for drift)", [
    { label: `1st ${d(rows[0].t)}+`, rows: rows.slice(0, third) },
    { label: `2nd ${d(rows[third].t)}+`, rows: rows.slice(third, 2 * third) },
    { label: `3rd ${d(rows[2 * third].t)}+`, rows: rows.slice(2 * third) },
  ]);

  // Which way was the 4H trend pointing? If it barely changed, "opposing"
  // means roughly one direction throughout and the test cannot separate the
  // two — the finding would be untested rather than confirmed.
  const trends = {};
  rows.forEach(r => { const t = r.sig.htfTrend || "Unknown"; trends[t] = (trends[t] || 0) + 1; });
  console.log(`\n${"=".repeat(94)}`);
  console.log("REGIME CHECK — how varied was the 4H trend across the sample?");
  console.log("  " + Object.entries(trends)
    .map(([k, v]) => `${k}: ${v} (${(v / rows.length * 100).toFixed(0)}%)`).join("   "));

  const firstHalfTrends = {}, secondHalfTrends = {};
  rows.slice(0, half).forEach(r => { const t = r.sig.htfTrend || "Unknown"; firstHalfTrends[t] = (firstHalfTrends[t] || 0) + 1; });
  rows.slice(half).forEach(r => { const t = r.sig.htfTrend || "Unknown"; secondHalfTrends[t] = (secondHalfTrends[t] || 0) + 1; });
  console.log("  1st half: " + Object.entries(firstHalfTrends).map(([k, v]) => `${k} ${v}`).join(", "));
  console.log("  2nd half: " + Object.entries(secondHalfTrends).map(([k, v]) => `${k} ${v}`).join(", "));

  console.log(`\n${"=".repeat(94)}`);
  console.log(`
How to read this:
  - Same sign and similar size in every period = durable. Worth a forward test.
  - Large in one period and absent elsewhere = regime artifact. Discard it.
  - Shrinking across the thirds = it was real and may already be gone.
  - Period cells are small, so expect wider noise bands than the headline
    numbers. Consistency of SIGN matters more than stars here.
  - If the 4H trend barely changed across the sample, this test has not really
    challenged the finding: "opposing" would mean roughly one direction
    throughout, and a genuine regime change has never been observed.
  - Still retroactive. Nothing here is a live result.`);
})();
