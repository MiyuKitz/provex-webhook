const { runPhoenix } = require("./phoenix.js"); const fs = require("fs");
const load = f => JSON.parse(fs.readFileSync(f)).map(r => ({ t: +r.time, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume }));
const [tf, coinsArg, optsArg, sinceArg] = process.argv.slice(2);
const C = coinsArg.split(","), opts = optsArg ? JSON.parse(optsArg) : {}, since = sinceArg ? Date.parse(sinceArg) : 0;
const FEE = 0.0005, SLIP = 0.0005, FUND = 0.0001;
let all = [];
for (const c of C) {
  const b = load(tf === "15m" ? `/home/claude/hist15/${c}-USDT_15m.json` : `/home/claude/hist1h/${c}-USDT_1h.json`);
  const h = load(`/home/claude/hist1h/${c}-USDT_1h.json`), d = load(`/home/claude/hist/${c}-USDT_1d.json`);
  for (const t of runPhoenix(b, h, d, opts)) if (t.t >= since) all.push({ ...t, coin: c, Rn: t.R - (2 * FEE + 2 * SLIP + FUND * (t.exitT - t.t) / 288e5) / t.d });
}
const st = (T, lab) => { const n = T.length; if (!n) return console.log(lab, "n=0");
  const pct = f => Math.round(T.filter(f).length / n * 100) + "%", avg = k => (T.reduce((a, t) => a + t[k], 0) / n);
  const w = T.filter(t => t.Rn > 0).reduce((a, t) => a + t.Rn, 0), l = -T.filter(t => t.Rn < 0).reduce((a, t) => a + t.Rn, 0);
  let eq = 1, pk = 1, dd = 0; for (const t of [...T].sort((a, b) => a.exitT - b.exitT)) { eq *= 1 + 0.01 * t.Rn; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
  console.log(`${lab.padEnd(26)} n=${String(n).padStart(5)} | TP1 ${pct(t => t.hit1)} TP2 ${pct(t => t.hit2)} TP3 ${pct(t => t.hit3)} | full stop ${pct(t => !t.hit1 && t.R < 0 && !t.opp)} | avg R before costs ${avg("R").toFixed(3)} after ${avg("Rn").toFixed(3)} | PF ${(w / l).toFixed(2)} | 1% risk: ${((eq - 1) * 100).toFixed(0)}% total, DD ${(dd * 100).toFixed(0)}% | avg stop ${(avg("d") * 100).toFixed(2)}%`); };
st(all, `${tf} ALL`);
if (!sinceArg) { const mid = Date.parse("2026-05-15"); st(all.filter(t => t.t < mid), `${tf} older half`); st(all.filter(t => t.t >= mid), `${tf} recent half`); }
for (const c of C) st(all.filter(t => t.coin === c), `  ${c}`);
