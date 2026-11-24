// tsflow.js — server-side Two-Speed Flow engine (same rules as tradingview/TwoSpeedFlow.pine v2, his defaults). Analysis only: never places orders.
// Port of tradingview/TwoSpeedFlow.pine v2.1.4 signal logic (his defaults). Same order of operations as the Pine script.
// HTF trend = Auto HTF (Pine v2.1): pass opts.trendBars = next-higher timeframe bars (4H chart -> 1D, 1H chart -> 4H).
// `htf` bars are only used for HTF liquidity pools (Pine "HTF Liquidity Resolution", default 1H).
// Pine v2.1+ display-only features (Next-Trade Scout, normal-case labels) do not affect signals and are not ported.
"use strict";
const H1 = 3600000, DAY = 86400000;
const DEF = {
  swingLen: 7, obSearch: 10, obMinDisp: 0.3, obMax: 5, mitMax: 4, fvgMinAtr: 0.1, fvgMax: 4,
  majorLen: 20, minorLen: 7, eqTol: 0.15, htfOn: true,
  boxHours: 3, purgeTap: true, adaptive: true, useHtf: false, adrLen: 14, adrLimit: 85,
  chopLen: 14, chopThr: 55, adxLen: 14, adxMin: 20,
  style: "classic", allowCont: false, minBetween: 23, dispBody: 0.35,
  blockLiq: true, reqDelta: true, reqVP: true, useWeighted: false, minTake: 2, minWait: 0, setupRules: true, softHard: true,
  atrMult: 3, tp1: 0.5, tp2: 2, tp3: 3, trail1: 1.5, trail2: 1.0,
};
const rma = (src, n) => { const o = Array(src.length).fill(NaN); let s = 0, c = 0, p = NaN; for (let i = 0; i < src.length; i++) { const v = src[i]; if (!isFinite(v)) continue; if (c < n) { s += v; c++; if (c === n) { p = s / n; o[i] = p; } } else { p = (p * (n - 1) + v) / n; o[i] = p; } } return o; };
const ema = (src, n) => { const o = Array(src.length).fill(NaN), a = 2 / (n + 1); let p = NaN, s = 0, c = 0; for (let i = 0; i < src.length; i++) { if (c < n) { s += src[i]; c++; if (c === n) { p = s / n; o[i] = p; } continue; } p = a * src[i] + (1 - a) * p; o[i] = p; } return o; };
const sma = (src, n) => { const o = Array(src.length).fill(NaN); let s = 0; for (let i = 0; i < src.length; i++) { s += src[i]; if (i >= n) s -= src[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const trs = b => b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l);
function pivot(b, i, L, hi) { const c = i - L; if (c - L < 0) return NaN; const v = hi ? b[c].h : b[c].l;
  for (let k = c - L; k <= i; k++) { if (k === c) continue; const w = hi ? b[k].h : b[k].l; if (hi ? (k < c ? w >= v : w > v) : (k < c ? w <= v : w < v)) return NaN; } return v; }
// New York offset (US DST: 2nd Sun Mar 07:00 UTC -> 1st Sun Nov 06:00 UTC)
const dstCache = {};
function nyOffset(t) { const y = new Date(t).getUTCFullYear();
  if (!dstCache[y]) { const m = new Date(Date.UTC(y, 2, 1)), s1 = (7 - m.getUTCDay()) % 7; const start = Date.UTC(y, 2, 1 + s1 + 7, 7);
    const n = new Date(Date.UTC(y, 10, 1)), s2 = (7 - n.getUTCDay()) % 7; const end = Date.UTC(y, 10, 1 + s2, 6); dstCache[y] = [start, end]; }
  const [s, e] = dstCache[y]; return t >= s && t < e ? -4 : -5; }
function sessOf(t) { const m = (((Math.floor(t / 60000) + nyOffset(t) * 60) % 1440) + 1440) % 1440; return m >= 1080 || m < 180 ? 0 : m < 480 ? 1 : 2; }

function runPhoenix(b, htf, daily, opts = {}) {
  const P = { ...DEF, ...opts }, n = b.length, tf = b[1].t - b[0].t, htfMs = htf.length > 1 ? htf[1].t - htf[0].t : H1;
  const tr = trs(b), atr = rma(tr, 14), atr5 = rma(tr, 5), cl = b.map(x => x.c), ema10 = ema(cl, 10), volAvg = sma(b.map(x => x.v), 20);
  const pdm = b.map((x, i) => { if (!i) return 0; const u = x.h - b[i - 1].h, d = b[i - 1].l - x.l; return u > d && u > 0 ? u : 0; });
  const mdm = b.map((x, i) => { if (!i) return 0; const u = x.h - b[i - 1].h, d = b[i - 1].l - x.l; return d > u && d > 0 ? d : 0; });
  const trR = rma(tr, P.adxLen), pR = rma(pdm, P.adxLen), mR = rma(mdm, P.adxLen);
  const adx = rma(b.map((_, i) => { const p = pR[i] / trR[i], m = mR[i] / trR[i]; return isFinite(p + m) && p + m > 0 ? 100 * Math.abs(p - m) / (p + m) : NaN; }), P.adxLen);
  const tb = P.trendBars || htf, tbMs = tb.length > 1 ? tb[1].t - tb[0].t : htfMs;
  const tCl = tb.map(x => x.c), hF = ema(tCl, 10), hS = ema(tCl, 30), hPH = htf.map((_, i) => pivot(htf, i, 3, true)), hPL = htf.map((_, i) => pivot(htf, i, 3, false));
  const dAtr = rma(trs(daily), P.adrLen);
  const htfPools = htfMs > tf && P.htfOn;
  let hi = -1, di = -1, ti = -1;
  const st = { obs: [], mits: [], fvgs: [], exitI: -1e9, pools: [], recHi: [], recLo: [], swHi: NaN, swHiDone: true, swLo: NaN, swLoDone: true, trend: 0,
    bHi: NaN, bLo: NaN, bStart: 0, bLive: false, bUp: false, bDn: false, prevSess: -1, vp: new Map(), step: NaN, pocB: NaN, pocV: 0, dayKey: null, dHi: 0, dLo: 0,
    lastSigDir: 0, lastSigBar: -1e9, T: null };
  const trades = [];
  let curA = 0;
  const addPool = (lvl, dir, major, htfP) => {
    if (st.pools.some(p => p.dir === dir && p.htf === htfP && p.major === major && Math.abs(p.lvl - lvl) <= lvl * 1e-7)) return;
    const arr = dir === 1 ? st.recHi : st.recLo; let t = 1; for (const v of arr) if (Math.abs(v - lvl) <= P.eqTol * curA) t++;
    arr.push(lvl); if (arr.length > 60) arr.shift();
    st.pools.push({ lvl, dir, major, htf: htfP }); if (st.pools.length > 60) st.pools.shift();
  };
  for (let i = 0; i < n; i++) {
    const x = b[i], a = atr[i];
    const sess = sessOf(x.t), sessStart = sess !== st.prevSess; st.prevSess = sess;
    if (!isFinite(a) || i < 60) continue;
    curA = a;
    while (hi + 1 < htf.length && htf[hi + 1].t + htfMs <= x.t) { hi++; if (htfPools) { if (isFinite(hPH[hi])) addPool(hPH[hi], 1, true, true); if (isFinite(hPL[hi])) addPool(hPL[hi], -1, true, true); } }
    while (di + 1 < daily.length && daily[di + 1].t + DAY <= x.t) di++;
    while (ti + 1 < tb.length && tb[ti + 1].t + tbMs <= x.t) ti++;
    const htfBias = ti >= 0 && isFinite(hF[ti]) && isFinite(hS[ti]) ? (hF[ti] > hS[ti] ? 1 : -1) : 0;
    const dk = Math.floor(x.t / DAY); if (st.dayKey !== dk) { st.dayKey = dk; st.dHi = x.h; st.dLo = x.l; } else { st.dHi = Math.max(st.dHi, x.h); st.dLo = Math.min(st.dLo, x.l); }
    const adrPct = di >= 0 && dAtr[di] > 0 ? (st.dHi - st.dLo) / dAtr[di] * 100 : 0, adrExh = adrPct >= P.adrLimit;
    let hh = -Infinity, ll = Infinity, s1 = 0; for (let k = i - P.chopLen + 1; k <= i; k++) { hh = Math.max(hh, b[k].h); ll = Math.min(ll, b[k].l); s1 += tr[k]; }
    const chop = hh > ll ? 100 * Math.log10(s1 / (hh - ll)) / Math.log10(P.chopLen) : 50, isChoppy = chop > P.chopThr, isWeak = adx[i] < P.adxMin;
    const body = Math.abs(x.c - x.o), rng = x.h - x.l, buyPct = rng > 0 ? (x.c - x.l) / rng * 100 : 50;
    const dispReq = P.dispBody * a * (P.adaptive ? Math.max(0.75, Math.min(1.5, atr5[i] / a || 1)) : 1);
    // structure
    const ph = pivot(b, i, P.swingLen, true), pl = pivot(b, i, P.swingLen, false);
    if (isFinite(ph)) { st.swHi = ph; st.swHiDone = false; } if (isFinite(pl)) { st.swLo = pl; st.swLoDone = false; }
    let bullBreak = false, bearBreak = false;
    if (!st.swHiDone && isFinite(st.swHi) && x.c > st.swHi) { st.swHiDone = true; bullBreak = true; st.trend = 1; }
    if (!st.swLoDone && isFinite(st.swLo) && x.c < st.swLo) { st.swLoDone = true; bearBreak = true; st.trend = -1; }
    if (bullBreak) for (let k = 1; k <= P.obSearch; k++) { const y = b[i - k]; if (y.c < y.o) { if (x.c - y.h >= P.obMinDisp * a) st.obs.push({ top: y.h, bot: y.l, dir: 1, born: i }); break; } }
    if (bearBreak) for (let k = 1; k <= P.obSearch; k++) { const y = b[i - k]; if (y.c > y.o) { if (y.l - x.c >= P.obMinDisp * a) st.obs.push({ top: y.h, bot: y.l, dir: -1, born: i }); break; } }
    while (st.obs.length > P.obMax * 2) st.obs.shift();
    const upd = (zs, mk) => { let B = false, S = false; for (let k = zs.length - 1; k >= 0; k--) { const z = zs[k]; let dead;
      if (z.dir === 1) { if (i > z.born && x.l <= z.top && x.c >= z.bot) B = true; dead = x.c < z.bot; } else { if (i > z.born && x.h >= z.bot && x.c <= z.top) S = true; dead = x.c > z.top; }
      const tapped = i > z.born && (z.dir === 1 ? (x.l <= z.top && x.c >= z.bot) : (x.h >= z.bot && x.c <= z.top));
      if (dead && i > z.born && mk) st.mits.push({ top: z.top, bot: z.bot, dir: -z.dir, born: i });
      if ((dead && i > z.born) || (P.purgeTap && tapped)) zs.splice(k, 1); } return [B, S]; };
    const b2 = b[i - 2];
    if (x.l > b2.h && x.l - b2.h >= P.fvgMinAtr * a) st.fvgs.push({ top: x.l, bot: b2.h, dir: 1, born: i, fvg: true });
    if (x.h < b2.l && b2.l - x.h >= P.fvgMinAtr * a) st.fvgs.push({ top: b2.l, bot: x.h, dir: -1, born: i, fvg: true });
    while (st.fvgs.length > P.fvgMax * 2) st.fvgs.shift();
    const updF = zs => { let B = false, S = false; for (let k = zs.length - 1; k >= 0; k--) { const z = zs[k]; let dead;
      if (z.dir === 1) { if (i > z.born && x.l <= z.top && x.c >= z.bot) B = true; dead = x.l <= z.bot; } else { if (i > z.born && x.h >= z.bot && x.c <= z.top) S = true; dead = x.h >= z.top; }
      const tapped = i > z.born && (z.dir === 1 ? (x.l <= z.top && x.c >= z.bot) : (x.h >= z.bot && x.c <= z.top));
      if ((dead && i > z.born) || (P.purgeTap && tapped)) zs.splice(k, 1); } return [B, S]; };
    const [obB, obS] = upd(st.obs, true), [mtB, mtS] = upd(st.mits, false);
    const [fvB, fvS] = updF(st.fvgs); while (st.mits.length > P.mitMax) st.mits.shift();
    // pools
    for (const [L, maj] of [[P.minorLen, false], [P.majorLen, true]]) { const a1 = pivot(b, i, L, true), a2 = pivot(b, i, L, false); if (isFinite(a1)) addPool(a1, 1, maj, false); if (isFinite(a2)) addPool(a2, -1, maj, false); }
    let nB = NaN, nS = NaN, nBH = false, nSH = false;
    for (let k = st.pools.length - 1; k >= 0; k--) { const p = st.pools[k];
      if ((p.dir === 1 && x.h > p.lvl) || (p.dir === -1 && x.l < p.lvl)) { st.pools.splice(k, 1); continue; }
      if (p.dir === 1 && p.lvl > x.c && (!isFinite(nB) || p.lvl < nB)) { nB = p.lvl; nBH = p.major || p.htf; }
      if (p.dir === -1 && p.lvl < x.c && (!isFinite(nS) || p.lvl > nS)) { nS = p.lvl; nSH = p.major || p.htf; } }
    // session box
    let boxUp = false, boxDn = false;
    if (sessStart) { st.bHi = x.h; st.bLo = x.l; st.bStart = x.t; st.bLive = true; st.bUp = false; st.bDn = false; }
    else { if (st.bLive) { if (x.t - st.bStart < P.boxHours * H1) { st.bHi = Math.max(st.bHi, x.h); st.bLo = Math.min(st.bLo, x.l); } else st.bLive = false; }
    if (!st.bLive && isFinite(st.bHi)) {
      if (!st.bUp && x.c > st.bHi && x.c > x.o && body >= dispReq) { boxUp = true; st.bUp = true; }
      if (!st.bDn && x.c < st.bLo && x.c < x.o && body >= dispReq) { boxDn = true; st.bDn = true; } } }
    // volume profile (session reset)
    if (sessStart || !isFinite(st.step)) { st.vp.clear(); st.step = Math.max(a * 0.05, 1e-12); st.pocB = NaN; st.pocV = 0; }
    if (x.v > 0) { const lb = Math.floor(x.l / st.step), hb = Math.floor(x.h / st.step), nb = hb - lb + 1, ch = Math.min(nb, 40);
      for (let c = 0; c < ch; c++) { const k = lb + Math.floor(c * nb / ch), v = (st.vp.get(k) || 0) + x.v / ch; st.vp.set(k, v); if (v > st.pocV) { st.pocV = v; st.pocB = k; } } }
    const poc = isFinite(st.pocB) ? (st.pocB + 0.5) * st.step : NaN;
    // setups (engine: Hybrid = breakout + OB/mitigation retest)
    const rtL = (obB || mtB || fvB) && x.c > x.o, rtS = (obS || mtS || fvS) && x.c < x.o;
    const boL = x.c > x.o && body >= dispReq && (bullBreak || boxUp), boS = x.c < x.o && body >= dispReq && (bearBreak || boxDn);
    const lT = rtL ? "retest" : boL ? "breakout" : "", sT = rtS ? "retest" : boS ? "breakout" : "";
    const ev = (dir, stype) => { if (!stype) return ""; let score = 0, hard = false, soft = false; const rulesOn = P.setupRules && !P.useWeighted, risk = P.atrMult * a;
      if (htfBias === dir) score++; else if (htfBias === -dir) { score--; if (P.useHtf) hard = true; }
      score += st.trend === dir ? 1 : -1; if (st.trend !== dir && rulesOn && stype === "retest") soft = true;
      const dOk = dir === 1 ? buyPct >= 50 : buyPct <= 50; score += dOk ? 1 : -1; if (x.v > volAvg[i] * 1.5 && dOk) score++; if (P.reqDelta && !dOk) soft = true;
      if (isFinite(poc)) { const ok = dir === 1 ? x.c > poc : x.c < poc; score += ok ? 1 : -1; if (P.reqVP && !ok) soft = true; }
      if (isChoppy || isWeak) { score--; if (stype === "breakout" && isChoppy) hard = true; }
      const dist = dir === 1 ? nB - x.c : x.c - nS, bh = dir === 1 ? nBH : nSH;
      if (isFinite(dist) && dist < Math.max(P.tp1, 1) * risk) { if (P.softHard) { score -= bh ? 2 : 1; if (bh) hard = true; else soft = true; } else { score--; if (stype === "breakout" && P.blockLiq) hard = true; else soft = true; } }
      if (adrExh) { score--; if (stype === "breakout" || !rulesOn) hard = true; else soft = true; }
      if (Math.abs(x.c - ema10[i]) / a > 1.5 && !(rulesOn && stype === "breakout")) { score--; soft = true; }
      return P.useWeighted ? (hard && P.softHard ? "AVOID" : score >= P.minTake ? "TAKE" : score >= P.minWait ? "WAIT" : "AVOID") : hard ? "AVOID" : soft ? "WAIT" : "TAKE"; };
    const tDir = st.T ? st.T.dir : 0;
    const cool = i - st.exitI >= 3;
    const gL = cool && lT && !sT && (tDir !== 1 || (P.allowCont && i - st.lastSigBar >= P.minBetween));
    const gS = cool && sT && !lT && (tDir !== -1 || (P.allowCont && i - st.lastSigBar >= P.minBetween));
    const qL = gL ? ev(1, lT) : "", qS = gS ? ev(-1, sT) : "";
    const classic = P.style === "classic";
    let takeL = gL && (classic || qL === "TAKE"), takeS = gS && (classic || qS === "TAKE");
    if (P.hold && st.T) { takeL = false; takeS = false; }   // variant: ignore new arrows until SL/TP3 closes the trade
    // trade management
    const T = st.T;
    if (T && i > T.bar) { let ex = NaN;
      if (T.dir === 1) { if (x.l <= T.sl) ex = T.sl; else { if (T.stage < 1 && x.h >= T.tp1) { T.stage = 1; T.hit1 = true; T.sl = Math.max(T.sl, T.e); }
        if (T.stage < 2 && x.h >= T.tp2) { T.stage = 2; T.hit2 = true; T.sl = Math.max(T.sl, T.tp1); }
        if (x.h >= T.tp3) { ex = T.tp3; T.hit3 = true; } else if (T.stage >= 1) T.sl = Math.max(T.sl, x.c - (T.stage >= 2 ? P.trail2 : P.trail1) * a); } }
      else { if (x.h >= T.sl) ex = T.sl; else { if (T.stage < 1 && x.l <= T.tp1) { T.stage = 1; T.hit1 = true; T.sl = Math.min(T.sl, T.e); }
        if (T.stage < 2 && x.l <= T.tp2) { T.stage = 2; T.hit2 = true; T.sl = Math.min(T.sl, T.tp1); }
        if (x.l <= T.tp3) { ex = T.tp3; T.hit3 = true; } else if (T.stage >= 1) T.sl = Math.min(T.sl, x.c + (T.stage >= 2 ? P.trail2 : P.trail1) * a); } }
      if (!isFinite(ex) && ((T.dir === 1 && takeS) || (T.dir === -1 && takeL))) { ex = x.c; T.opp = true; }
      if (isFinite(ex)) { trades.push({ ...T, exit: ex, exitT: x.t, R: (ex - T.e) / T.risk * T.dir }); st.T = null; st.exitI = i; } }
    if (P.trace) P.trace.push({ t: x.t, act: st.T && !(takeL || takeS) ? st.T.dir : (takeL ? 1 : takeS ? -1 : 0), last: takeL ? 1 : takeS ? -1 : st.lastSigDir, trend: st.trend, htf: htfBias, poc: isFinite(poc) ? (x.c > poc ? 1 : -1) : 0,
      opL: lT ? ev(1, lT) : (gL ? qL : ""), opS: sT ? ev(-1, sT) : "", evL: ev(1, "retest"), evS: ev(-1, "retest"), evLb: ev(1, "breakout"), evSb: ev(-1, "breakout"),
      nB, nS, nBH, nSH, c: x.c, atr: a });
    if (takeL || takeS) { const d = takeL ? 1 : -1, sl = x.c - d * P.atrMult * a, r = Math.abs(x.c - sl);
      st.T = { dir: d, bar: i, t: x.t, e: x.c, sl, risk: r, d: r / x.c, tp1: x.c + d * P.tp1 * r, tp2: x.c + d * P.tp2 * r, tp3: x.c + d * P.tp3 * r, stage: 0, hit1: false, hit2: false, hit3: false,
        setup: (takeL ? lT : sT), q: takeL ? qL : qS };
      st.lastSigDir = d; st.lastSigBar = i; }
  }
  return trades;
}
module.exports = { runPhoenix, DEF };
