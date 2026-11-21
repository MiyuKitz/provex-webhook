// Backtest Two-Speed Flow on 3 yrs of BingX 4H data, 28 coins. Costs: fee 0.05%/side + slip 0.05%/side + funding 0.01%/8h.
const { runFlow } = require("/home/claude/provex-webhook/flow.js");
const fs = require("fs");
const C = "BTC ETH SOL SUI DOGE NEAR INJ 1000PEPE FLOKI ZRO XRP LINK AVAX ADA LTC BNB AAVE UNI ARB OP APT DOT SEI TIA WIF HBAR TRX BCH".split(" ");
const load = f => JSON.parse(fs.readFileSync(f)).map(r => ({ t: +r.time, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume }));
const SLIP = +(process.argv[2] || 0.0005), FEE = +(process.env.FEE ?? 0.0005), FUND = +(process.env.FUND ?? 0.0001), SPLIT = Date.UTC(2025, 6, 1);
const opts = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const all = [], sigs = [], states = {};
for (const c of C) {
  const b = load(process.env.TF === "1h" ? `/home/claude/hist1h/${c}-USDT_1h.json` : `/home/claude/hist/${c}-USDT_4h.json`), d = load(`/home/claude/hist/${c}-USDT_1d.json`);
  const r = runFlow(b, d, opts);
  for (const t of r.trades) { const hold8 = (t.exitT - t.t) / 28800000; all.push({ ...t, coin: c, Rn: t.R - (2 * FEE + 2 * SLIP + FUND * hold8) / t.d }); }
  for (const s of r.signals) sigs.push({ coin: c, q: s.q });
  if (process.argv[4]) states[c] = r.state.map(s => s && [s.t, s.trend, s.htfBias, +(s.poc || 0).toPrecision(8), Math.round(s.buyPct), s.isChoppy ? 1 : 0, s.isWeak ? 1 : 0, s.adrExh ? 1 : 0, +s.ext.toFixed(2), isFinite(s.nearBSL) ? +s.nearBSL.toPrecision(8) : null, isFinite(s.nearSSL) ? +s.nearSSL.toPrecision(8) : null, s.nearBSLHard ? 1 : 0, s.nearSSLHard ? 1 : 0, s.atr, s.close]);
}
if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(states));
const st = T => { const n = T.length; if (!n) return "n=0"; const m = T.reduce((a, t) => a + t.Rn, 0) / n, w = T.filter(t => t.Rn > 0).reduce((a, t) => a + t.Rn, 0), l = -T.filter(t => t.Rn < 0).reduce((a, t) => a + t.Rn, 0);
  const day = {}; for (const t of T) { const k = Math.floor(t.t / 864e5); (day[k] ||= []).push(t.Rn); }
  const se = Math.sqrt(Object.values(day).reduce((a, v) => a + v.reduce((s, x) => s + x - m, 0) ** 2, 0)) / n;
  let eq = 1, pk = 1, dd = 0; for (const t of [...T].sort((a, b) => a.exitT - b.exitT)) { eq *= 1 + 0.005 * t.Rn; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
  const yrs = (Math.max(...T.map(t => t.exitT)) - Math.min(...T.map(t => t.t))) / 3.156e10;
  return `n=${n} exp ${m >= 0 ? "+" : ""}${m.toFixed(3)}R (t=${(m / se).toFixed(1)}) win ${Math.round(T.filter(t => t.Rn > 0).length / n * 100)}% PF ${(w / l).toFixed(2)} TP1-touch ${Math.round(T.filter(t => t.tp1Hit).length / n * 100)}% | 0.5% risk ${((eq ** (1 / yrs) - 1) * 100).toFixed(0)}%/yr DD ${(dd * 100).toFixed(0)}%`; };
console.log(`slip ${SLIP * 100}%/side ${JSON.stringify(opts)}`);
console.log("ALL          ", st(all));
console.log("older half   ", st(all.filter(t => t.t < SPLIT)));
console.log("recent half  ", st(all.filter(t => t.t >= SPLIT)));
for (const k of ["Liquidity Sweep Reversal", "Order Block Retest", "Liquidity Void (FVG) Retest", "Mitigation Block Retest", "Swing Structure Breakout", "CHoCH Breakout", "Squeeze Breakout", "Retest"]) console.log(k.padEnd(28), st(all.filter(t => t.name === k)));
console.log("by opinion TAKE", st(all.filter(t => t.q === "TAKE")), "\nRETEST TAKE", st(all.filter(t => t.q === "RETEST TAKE")));
console.log("long ", st(all.filter(t => t.dir === 1)), "\nshort", st(all.filter(t => t.dir === -1)));
const q = {}; for (const s of sigs) q[s.q] = (q[s.q] || 0) + 1; console.log("signals by opinion", JSON.stringify(q));
