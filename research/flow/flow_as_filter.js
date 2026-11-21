const { evaluate, DEF } = require("/home/claude/provex-webhook/flow.js");
const S = require("./states.json"), B = require("./base_trades.json"), SPLIT = Date.UTC(2025, 6, 1);
const idx = {}; for (const c in S) { idx[c] = new Map(); for (const r of S[c]) if (r) idx[c].set(r[0], r); }
const rows = [];
for (const t of B) {
  const r = idx[t.coin] && idx[t.coin].get(t.t); if (!r) continue;
  const [ts, trend, htf, poc, buyPct, ch, wk, adrE, ext, nB, nS, nBH, nSH, atr, close] = r;
  const st = { close, trend, htfBias: htf, poc, buyPct, isChoppy: !!ch, isWeak: !!wk, adrExh: !!adrE, adrPct: 0, ext, nearBSL: nB ?? NaN, nearSSL: nS ?? NaN, nearBSLHard: !!nBH, nearSSLHard: !!nSH };
  const risk = Math.max(0.015 * close, 1.5 * atr);   // proxy for the bot's stop distance
  const ev = { retest: evaluate(st, DEF, t.d, "retest", risk), breakout: evaluate(st, DEF, t.d, "breakout", risk) };
  rows.push({ ...t, st, ev, f: {
    htfWith: htf === t.d, structWith: trend === t.d, pocRight: t.d === 1 ? close > poc : close < poc, deltaWith: t.d === 1 ? buyPct >= 50 : buyPct <= 50,
    regimeOk: !ch && !wk, adrOk: !adrE, notExtended: ext <= 1.5,
    roomToTP1: !(isFinite(t.d === 1 ? (nB ?? NaN) - close : close - (nS ?? NaN)) && (t.d === 1 ? nB - close : close - nS) < risk) } });
}
const st = T => { const n = T.length; if (!n) return "n=0"; const m = T.reduce((a, t) => a + t.R, 0) / n;
  const day = {}; for (const t of T) { const k = Math.floor(t.t / 864e5); (day[k] ||= []).push(t.R); }
  const se = Math.sqrt(Object.values(day).reduce((a, v) => a + v.reduce((s, x) => s + x - m, 0) ** 2, 0)) / n;
  const h1 = T.filter(t => t.t < SPLIT), h2 = T.filter(t => t.t >= SPLIT), av = v => v.length ? (v.reduce((a, t) => a + t.R, 0) / v.length) : 0;
  return `n=${String(n).padStart(4)} exp ${m >= 0 ? "+" : ""}${m.toFixed(3)}R (t=${(m / se).toFixed(1)}) | older ${av(h1).toFixed(3)} recent ${av(h2).toFixed(3)} | total ${T.reduce((a, t) => a + t.R, 0).toFixed(0)}R`; };
console.log("ALL bot trades           ", st(rows));
for (const m of ["retest", "breakout"]) for (const q of ["TAKE", "WAIT", "AVOID"]) console.log(`flow says ${q.padEnd(5)} (${m.padEnd(8)})`, st(rows.filter(r => r.ev[m].q === q)));
console.log("flow says NOT AVOID (breakout rules)", st(rows.filter(r => r.ev.breakout.q !== "AVOID")));
for (const k of Object.keys(rows[0].f)) { console.log(`${k.padEnd(13)} yes`, st(rows.filter(r => r.f[k]))); console.log(`${k.padEnd(13)} no `, st(rows.filter(r => !r.f[k]))); }
