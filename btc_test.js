// ============================================================================
// DOES THE BTC HARD BLOCK EARN ITS PLACE?
// ============================================================================
//
// The BTC rule was added after two losing trades on 2026-08-13. It has never
// been tested on live data, because every signal it blocks is diverted to
// missed_signals.jsonl and never reaches signals.jsonl — so in the entry test
// it showed PASS 360 / FAIL 0 and was invisible.
//
// This scores the blocked signals with the SAME live config as everything
// else (5% stop, TP 0.5/2/3, 40/30/30 ladder, 48h window) and compares.
//
// THE COMPARISON THAT MATTERS
// Removing the hard block does NOT mean ignoring BTC. BTC still scores 0 on
// the checklist when it opposes, so a BTC-opposed signal would still need to
// clear the normal score threshold on its other four points. So the fair
// question is:
//
//     of the signals the BTC block stopped, the ones that would otherwise
//     have passed every gate — did they make money?
//
// And because v19 now only takes HTF-OPPOSING trades, the decisive cell is
// that one: HTF-opposing signals, BTC-allowed vs BTC-blocked.
//
//   blocked group clearly positive  -> the block is discarding edge; remove it
//   blocked group clearly negative  -> the block is doing real work; keep it
//   blocked group indistinguishable -> the block does nothing measurable
// ============================================================================

const fs = require("fs");

const SIGNAL_FILE = "/data/signals.jsonl";
const MISSED_FILE = "/data/missed_signals.jsonl";
const CACHE_FILE = "/data/walk_cache.json";
const TP_R = [0.5, 2, 3];
const WEIGHTS = [0.4, 0.3, 0.3];
const SL_PCT = 0.05;
const COST_R = 0.02;
const WINDOW_H = 48;
const REQ_DELAY_MS = 150;
const MIN_N = 20;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const parseLevels = (s) => s == null ? [] :
  String(s).replace(/[$,\s]/g, "").split(/[-–—]/).map(Number).filter(n => !isNaN(n));
const toBingX = (s) => s && s.endsWith("USDT") && !s.includes("-") ? s.slice(0, -4) + "-USDT" : s;
const readJsonl = (f) => { try {
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch { return []; } };

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

const fmt = (s) => s.n
  ? `n=${String(s.n).padStart(3)}  gross ${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)}R  ` +
    `net ${(s.mean - COST_R >= 0 ? "+" : "") + (s.mean - COST_R).toFixed(3)}R  ` +
    `(${s.w}W/${s.l}L)  +/-${(2 * s.se).toFixed(3)}`
  : "n=  0  (no trades)";

function compare(a, b) {
  if (a.n < MIN_N || b.n < MIN_N) return `    -> too few to compare (${a.n} vs ${b.n})`;
  const d = a.mean - b.mean;
  const band = 2 * Math.sqrt(a.se ** 2 + b.se ** 2);
  return `    -> gap ${(d >= 0 ? "+" : "") + d.toFixed(3)}R, noise band +/-${band.toFixed(3)}R  ` +
    (Math.abs(d) > band ? "** SIGNIFICANT **" : "not distinguishable from noise");
}

const htfOf = (s) => {
  if (!s.htfTrend || s.htfTrend === "Unknown") return null;
  const opp = (s.direction === "Short" && s.htfTrend === "Bullish")
           || (s.direction === "Long" && s.htfTrend === "Bearish");
  return opp ? "opposes" : "aligned";
};

// Would this blocked signal have passed every OTHER gate? BTC scores 0 when it
// opposes, so rawScore already reflects that; the threshold is the live one.
const wouldPassScore = (s) => typeof s.rawScore === "number"
  && s.rawScore >= (s.killzone ? 3.5 : 4);

const isOB = (s) => String(s.type || "").startsWith("OB_") && !String(s.type).startsWith("OB_SWING");

async function score(list, zoneField, cache, label) {
  const out = [];
  let fetched = 0, skipped = 0;
  for (const sig of list) {
    const z = parseLevels(sig[zoneField]);
    if (!(sig.symbol && sig.direction && z.length === 2 && z[1] > z[0])) { skipped++; continue; }
    const key = `${sig.symbol}|${sig.loggedAt}|${sig[zoneField]}|${sig.direction}`;
    if (!(key in cache)) {
      const start = Date.parse(sig.loggedAt);
      if (!start) { skipped++; continue; }
      const bars = await fetchKlines(toBingX(sig.symbol), start, start + WINDOW_H * 3600e3);
      await sleep(REQ_DELAY_MS);
      if (!bars || bars.length < 5) { skipped++; continue; }
      cache[key] = walk(bars, z[0], z[1], sig.direction === "Short");
      if (++fetched % 50 === 0) console.log(`  ...${label}: fetched ${fetched}`);
    }
    if (cache[key] != null) out.push({ sig, r: cache[key] });
  }
  console.log(`  ${label}: ${out.length} scored (${fetched} newly fetched, ${skipped} unusable)`);
  return out;
}

(async () => {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch {}

  const allowedRaw = readJsonl(SIGNAL_FILE).filter(isOB);
  const missed = readJsonl(MISSED_FILE);
  const blockedRaw = missed.filter(s => isOB(s) && String(s.rejectionReason || "").includes("BTC trend opposes"));

  console.log(`signals that passed BTC (signals.jsonl): ${allowedRaw.length}`);
  console.log(`signals blocked by BTC (missed_signals.jsonl): ${blockedRaw.length}`);
  if (!blockedRaw.length) { console.log("\nNo BTC-blocked signals logged — nothing to test."); return; }
  const dates = blockedRaw.map(s => s.loggedAt).filter(Boolean).sort();
  console.log(`blocked signals span ${dates[0]?.slice(0, 10)} to ${dates[dates.length - 1]?.slice(0, 10)}\n`);

  const allowed = await score(allowedRaw, "entryZone", cache, "allowed");
  const blocked = await score(blockedRaw, "hypotheticalEntryZone", cache, "blocked");
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

  const blockedPassing = blocked.filter(x => wouldPassScore(x.sig));
  const S = (arr) => stats(arr.map(x => x.r));

  console.log(`\n${"=".repeat(96)}`);
  console.log("1. EVERYTHING THE BTC RULE BLOCKED vs EVERYTHING IT ALLOWED");
  console.log("=".repeat(96));
  console.log("  allowed            " + fmt(S(allowed)));
  console.log("  blocked (all)      " + fmt(S(blocked)));
  console.log(compare(S(allowed), S(blocked)));

  console.log(`\n${"=".repeat(96)}`);
  console.log("2. ONLY BLOCKED SIGNALS THAT WOULD HAVE PASSED EVERY OTHER GATE");
  console.log("   (BTC scores 0 when opposed, so these still clear the 4.0 / 3.5 threshold without it)");
  console.log("=".repeat(96));
  console.log("  allowed            " + fmt(S(allowed)));
  console.log("  blocked, would pass" + fmt(S(blockedPassing)));
  console.log(compare(S(allowed), S(blockedPassing)));

  console.log(`\n${"=".repeat(96)}`);
  console.log("3. THE DECISIVE CELL — v19 only takes HTF-OPPOSING trades, so this is what changes live");
  console.log("=".repeat(96));
  const aOpp = allowed.filter(x => htfOf(x.sig) === "opposes");
  const bOpp = blockedPassing.filter(x => htfOf(x.sig) === "opposes");
  console.log("  HTF-opposing, BTC allowed   " + fmt(S(aOpp)));
  console.log("  HTF-opposing, BTC blocked   " + fmt(S(bOpp)));
  console.log(compare(S(aOpp), S(bOpp)));

  console.log("\n  for completeness, HTF-aligned (already blocked by v19 either way):");
  const aAli = allowed.filter(x => htfOf(x.sig) === "aligned");
  const bAli = blockedPassing.filter(x => htfOf(x.sig) === "aligned");
  console.log("  HTF-aligned,  BTC allowed   " + fmt(S(aAli)));
  console.log("  HTF-aligned,  BTC blocked   " + fmt(S(bAli)));

  console.log(`\n${"=".repeat(96)}`);
  console.log(`
How to read section 3 — it is the only one that decides anything:
  - BTC-blocked group POSITIVE and its band clear of zero
        -> the rule is throwing away profitable counter-trend trades.
           Removing it would add trades with edge.
  - BTC-blocked group NEGATIVE, gap SIGNIFICANT
        -> the rule is doing real work. Keep it.
  - Small n or "not distinguishable"
        -> no evidence either way. Keep the current rule: changing a gate
           without evidence is exactly how the TP1 mistake happened.

Caveats:
  - missed_signals.jsonl only covers the period logging has existed. Check the
    date span above against the allowed sample.
  - Still retroactive, same as every test so far.`);
})();
