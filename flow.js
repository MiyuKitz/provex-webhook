// ============================================================================
// flow.js — Two-Speed Flow engine (server-side port of tradingview/TwoSpeedFlow.pine)
// Pure function: give it candles, it returns per-bar market state, every signal
// (TAKE / WAIT / AVOID / RETEST TAKE with reasons, SL, TP1-3) and the trades its own
// plan would have made. Used by: the bot (any coin, no TradingView needed),
// the /flow page, and the offline backtest — all the exact same code.
// ============================================================================
"use strict";

const DEF = {
  swingLen: 7, breakMode: "close",
  obSearch: 10, obMinDisp: 0.3, obMax: 5, mitMax: 4,
  fvgMinAtr: 0.1, fvgMode: "full", fvgMax: 4,
  majorLen: 20, minorLen: 7, eqTol: 0.15, wickRatio: 0.4, maxPools: 40,
  sqSens: 1.0, sqMinBars: 4, driftBuf: 0.75,
  htfFast: 10, htfSlow: 30, useHtf: false,
  adrLen: 14, adrLimit: 85,
  chopLen: 14, chopThr: 55, useChop: true, adxLen: 14, adxMin: 20, useAdx: true,
  vpReset: "week", vaPct: 70, vpRows: 50,
  engine: "hybrid", allowCont: false, minBetween: 10, dispBody: 0.35,
  blockIntoLiq: true, reqDelta: true, reqPOC: true,
  waitRecovery: true, maxWait: 8, useWeighted: false, minTake: 2, minWait: 0,
  setupRules: true, softHard: true,
  slMode: "structure", atrMult: 1.5, tp1: 1, tp2: 2, tp3: 3, trailAtr: 2,
};

const DAY = 86400000, WEEK0 = 4 * DAY; // 1970-01-05 was a Monday

function rmaSeries(src, n) {
  const out = new Array(src.length).fill(NaN); let s = 0, c = 0, prev = NaN;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]; if (!isFinite(v)) continue;
    if (c < n) { s += v; c++; if (c === n) { prev = s / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + v) / n; out[i] = prev; }
  }
  return out;
}
function emaSeries(src, n) {
  const out = new Array(src.length).fill(NaN), a = 2 / (n + 1); let prev = NaN, s = 0, c = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (c < n) { s += v; c++; if (c === n) prev = s / n; out[i] = c === n ? prev : NaN; continue; }
    prev = a * v + (1 - a) * prev; out[i] = prev;
  }
  return out;
}
function trSeries(b) { return b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c))); }
function pivotAt(b, i, L, hi) {   // pivot confirmed on bar i -> centre i-L
  const c = i - L; if (c - L < 0) return NaN;
  const v = hi ? b[c].h : b[c].l;
  for (let k = c - L; k <= i; k++) { if (k === c) continue; const w = hi ? b[k].h : b[k].l;
    if (hi ? (k < c ? w >= v : w > v) : (k < c ? w <= v : w < v)) return NaN; }
  return v;
}

// bars: [{t,o,h,l,c,v}] ascending, t = open time ms. daily: same for 1D (for HTF trend, ADR, HTF pools).
function runFlow(bars, daily, opts = {}) {
  const P = { ...DEF, ...opts }, n = bars.length, ms = n > 1 ? bars[1].t - bars[0].t : 4 * 3600000;
  const tr = trSeries(bars), atr = rmaSeries(tr, 14), atr5 = rmaSeries(tr, 5);
  const cl = bars.map(x => x.c), ema10 = emaSeries(cl, 10), ema30 = emaSeries(cl, 30);
  // DMI / ADX (Wilder)
  const pdm = bars.map((x, i) => { if (!i) return 0; const u = x.h - bars[i - 1].h, d = bars[i - 1].l - x.l; return u > d && u > 0 ? u : 0; });
  const mdm = bars.map((x, i) => { if (!i) return 0; const u = x.h - bars[i - 1].h, d = bars[i - 1].l - x.l; return d > u && d > 0 ? d : 0; });
  const trR = rmaSeries(tr, P.adxLen), pR = rmaSeries(pdm, P.adxLen), mR = rmaSeries(mdm, P.adxLen);
  const dx = bars.map((_, i) => { const p = 100 * pR[i] / trR[i], m = 100 * mR[i] / trR[i]; return p + m > 0 ? 100 * Math.abs(p - m) / (p + m) : 0; });
  const adx = rmaSeries(dx.map(v => isFinite(v) ? v : NaN), P.adxLen);
  // daily context
  const D = daily || [], dTr = trSeries(D), dAtr = rmaSeries(dTr, P.adrLen), dCl = D.map(x => x.c);
  const dF = emaSeries(dCl, P.htfFast), dS = emaSeries(dCl, P.htfSlow);
  const dPH = D.map((_, i) => pivotAt(D, i, 3, true)), dPL = D.map((_, i) => pivotAt(D, i, 3, false));
  let di = -1;   // last daily bar fully closed before the current bar opens

  const st = {
    obs: [], mits: [], fvgs: [], pools: [], recHi: [], recLo: [],
    swHi: NaN, swHiDone: true, swLo: NaN, swLoDone: true, trend: 0,
    dLive: false, dHi: NaN, dLo: NaN,
    vp: new Map(), vpStep: NaN, pocB: NaN, pocV: 0, vpKey: null,
    dayKey: null, dayHi: NaN, dayLo: NaN,
    lastSigDir: 0, lastSigBar: -1e9, wait: null, trade: null,
  };
  const out = { state: new Array(n), signals: [], trades: [] };
  let curA = 0;

  for (let i = 0; i < n; i++) {
    const x = bars[i], a = atr[i];
    if (!isFinite(a) || i < 40) { out.state[i] = null; continue; }
    curA = a;
    const body = Math.abs(x.c - x.o), rng = x.h - x.l, sr = Math.max(rng, 1e-12);
    const buyPct = rng > 0 ? (x.c - x.l) / rng * 100 : 50;
    const lowerWick = (Math.min(x.o, x.c) - x.l) / sr, upperWick = (x.h - Math.max(x.o, x.c)) / sr;
    while (di + 1 < D.length && D[di + 1].t + DAY <= x.t) {
      di++;
      // daily pivot confirmed by this closed day -> HTF liquidity pool
      if (isFinite(dPH[di])) addPool(dPH[di], 1, true, true, NaN, NaN);
      if (isFinite(dPL[di])) addPool(dPL[di], -1, true, true, NaN, NaN);
    }
    const htfBias = di >= 0 && isFinite(dF[di]) && isFinite(dS[di]) ? (dF[di] > dS[di] ? 1 : -1) : 0;
    const adrVal = di >= 0 ? dAtr[di] : NaN;
    const dk = Math.floor(x.t / DAY);
    if (st.dayKey !== dk) { st.dayKey = dk; st.dayHi = x.h; st.dayLo = x.l; } else { st.dayHi = Math.max(st.dayHi, x.h); st.dayLo = Math.min(st.dayLo, x.l); }
    const adrPct = adrVal > 0 ? (st.dayHi - st.dayLo) / adrVal * 100 : 0, adrExh = adrPct >= P.adrLimit;
    // regime
    let hh = -Infinity, ll = Infinity, trs = 0;
    for (let k = i - P.chopLen + 1; k <= i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); trs += tr[k]; }
    const chop = hh > ll ? 100 * Math.log10(trs / (hh - ll)) / Math.log10(P.chopLen) : 50;
    const isChoppy = P.useChop && chop > P.chopThr, isWeak = P.useAdx && adx[i] < P.adxMin;

    // ---- structure
    const ph = pivotAt(bars, i, P.swingLen, true), pl = pivotAt(bars, i, P.swingLen, false);
    if (isFinite(ph)) { st.swHi = ph; st.swHiDone = false; }
    if (isFinite(pl)) { st.swLo = pl; st.swLoDone = false; }
    let bullBreak = false, bearBreak = false, bullChoch = false, bearChoch = false;
    if (!st.swHiDone && isFinite(st.swHi) && (P.breakMode === "close" ? x.c > st.swHi : x.h > st.swHi)) {
      st.swHiDone = true; bullBreak = true; bullChoch = st.trend === -1; st.trend = 1; }
    if (!st.swLoDone && isFinite(st.swLo) && (P.breakMode === "close" ? x.c < st.swLo : x.l < st.swLo)) {
      st.swLoDone = true; bearBreak = true; bearChoch = st.trend === 1; st.trend = -1; }

    // ---- order blocks
    if (bullBreak) { for (let k = 1; k <= P.obSearch && i - k >= 0; k++) { const y = bars[i - k];
      if (y.c < y.o) { if (x.c - y.h >= P.obMinDisp * a) st.obs.push({ top: y.h, bot: y.l, dir: 1, born: i, kind: "Order Block" }); break; } } }
    if (bearBreak) { for (let k = 1; k <= P.obSearch && i - k >= 0; k++) { const y = bars[i - k];
      if (y.c > y.o) { if (y.l - x.c >= P.obMinDisp * a) st.obs.push({ top: y.h, bot: y.l, dir: -1, born: i, kind: "Order Block" }); break; } } }
    while (st.obs.length > P.obMax * 2) st.obs.shift();
    // ---- fair value gaps
    const b2 = bars[i - 2];
    if (x.l > b2.h && x.l - b2.h >= P.fvgMinAtr * a) st.fvgs.push({ top: x.l, bot: b2.h, dir: 1, born: i, kind: "Liquidity Void (FVG)" });
    if (x.h < b2.l && b2.l - x.h >= P.fvgMinAtr * a) st.fvgs.push({ top: b2.l, bot: x.h, dir: -1, born: i, kind: "Liquidity Void (FVG)" });
    while (st.fvgs.length > P.fvgMax * 2) st.fvgs.shift();
    const ob = upd(st.obs, false, true), fv = upd(st.fvgs, true, false), mt = upd(st.mits, false, false);
    while (st.mits.length > P.mitMax) st.mits.shift();
    const zB = ob.b || fv.b || mt.b, zS = ob.s || fv.s || mt.s;

    // ---- liquidity pools
    const phMin = pivotAt(bars, i, P.minorLen, true), plMin = pivotAt(bars, i, P.minorLen, false);
    const phMaj = pivotAt(bars, i, P.majorLen, true), plMaj = pivotAt(bars, i, P.majorLen, false);
    if (isFinite(phMin)) addPool(phMin, 1, false, false);
    if (isFinite(plMin)) addPool(plMin, -1, false, false);
    if (isFinite(phMaj)) addPool(phMaj, 1, true, false);
    if (isFinite(plMaj)) addPool(plMaj, -1, true, false);
    let sweepBull = false, sweepBear = false, nearBSL = NaN, nearSSL = NaN, nearBSLHard = false, nearSSLHard = false;
    for (let k = st.pools.length - 1; k >= 0; k--) {
      const p = st.pools[k]; let gone = false;
      if (p.dir === 1 && x.h > p.lvl) { gone = true; if (x.c < p.lvl) sweepBear = true; }
      else if (p.dir === -1 && x.l < p.lvl) { gone = true; if (x.c > p.lvl) sweepBull = true; }
      if (gone) { st.pools.splice(k, 1); continue; }
      if (p.dir === 1 && p.lvl > x.c && (!isFinite(nearBSL) || p.lvl < nearBSL)) { nearBSL = p.lvl; nearBSLHard = p.major || p.htf; }
      if (p.dir === -1 && p.lvl < x.c && (!isFinite(nearSSL) || p.lvl > nearSSL)) { nearSSL = p.lvl; nearSSLHard = p.major || p.htf; }
    }

    // ---- squeeze boxes
    let boxUp = false, boxDn = false;
    { let hN = -Infinity, lN = Infinity, bs = 0, rs = 0, ov = 0; const m = P.sqMinBars;
      for (let k = i - m + 1; k <= i; k++) { const y = bars[k], yp = bars[k - 1]; hN = Math.max(hN, y.h); lN = Math.min(lN, y.l); bs += Math.abs(y.c - y.o); rs += y.h - y.l; ov += Math.max(Math.min(y.h, yp.h) - Math.max(y.l, yp.l), 0); }
      const s = P.sqSens, score = (hN - lN < 1.5 * a * s) + (atr5[i] < a * 0.85 * s) + (ov / Math.max(rs, 1e-12) > 0.5 / s) + (bs / m < 0.5 * a * s);
      if (!st.dLive && score >= 3) { st.dLive = true; st.dHi = hN; st.dLo = lN; }
      else if (st.dLive) {
        if (x.c > st.dHi && x.c > x.o && body >= P.dispBody * a) { boxUp = true; st.dLive = false; }
        else if (x.c < st.dLo && x.c < x.o && body >= P.dispBody * a) { boxDn = true; st.dLive = false; }
        else if (x.c > st.dHi + P.driftBuf * a || x.c < st.dLo - P.driftBuf * a) st.dLive = false;
        else { st.dHi = Math.max(st.dHi, Math.max(x.o, x.c)); st.dLo = Math.min(st.dLo, Math.min(x.o, x.c)); }
      } }

    // ---- volume profile (weekly by default on 4H)
    const vk = P.vpReset === "day" ? dk : Math.floor((x.t - WEEK0) / (7 * DAY));
    if (st.vpKey !== vk) { st.vpKey = vk; st.vp.clear(); st.vpStep = Math.max(a * 0.1, 1e-12); st.pocB = NaN; st.pocV = 0; }
    if (x.v > 0) { const lb = Math.floor(x.l / st.vpStep), hb = Math.floor(x.h / st.vpStep), nb = hb - lb + 1, ch = Math.min(nb, 40);
      for (let c = 0; c < ch; c++) { const bk = lb + Math.floor(c * nb / ch), nv = (st.vp.get(bk) || 0) + x.v / ch; st.vp.set(bk, nv); if (nv > st.pocV) { st.pocV = nv; st.pocB = bk; } } }
    const poc = isFinite(st.pocB) ? (st.pocB + 0.5) * st.vpStep : NaN;

    const ext = Math.abs(x.c - ema10[i]) / a;
    const S = { t: x.t, close: x.c, atr: a, trend: st.trend, htfBias, poc, buyPct, chop, adx: adx[i], isChoppy, isWeak, adrPct, adrExh,
      nearBSL, nearSSL, nearBSLHard, nearSSLHard, ext, ema10: ema10[i], swHi: st.swHi, swLo: st.swLo };
    out.state[i] = S;

    // ---- setups
    const useR = P.engine === "hybrid" || P.engine === "retest", useB = P.engine === "hybrid" || P.engine === "breakout", useS = P.engine === "hybrid" || P.engine === "sweep";
    const swL = useS && sweepBull && lowerWick >= 0.35, rtL = useR && !!zB && x.c > x.o, boL = useB && x.c > x.o && body >= P.dispBody * a && (bullBreak || boxUp);
    const swS = useS && sweepBear && upperWick >= 0.35, rtS = useR && !!zS && x.c < x.o, boS = useB && x.c < x.o && body >= P.dispBody * a && (bearBreak || boxDn);
    const lType = swL ? "sweep" : rtL ? "retest" : boL ? "breakout" : "", sType = swS ? "sweep" : rtS ? "retest" : boS ? "breakout" : "";
    const lName = swL ? "Liquidity Sweep Reversal" : rtL ? zB.kind + " Retest" : boL ? (boxUp && !bullBreak ? "Squeeze Breakout" : bullChoch ? "CHoCH Breakout" : "Swing Structure Breakout") : "";
    const sName = swS ? "Liquidity Sweep Reversal" : rtS ? zS.kind + " Retest" : boS ? (boxDn && !bearBreak ? "Squeeze Breakout" : bearChoch ? "CHoCH Breakout" : "Swing Structure Breakout") : "";
    const slL = slFor(1, lType, zB), slS = slFor(-1, sType, zS);
    const eL = evaluate(S, P, 1, lType, Math.abs(x.c - slL)), eS = evaluate(S, P, -1, sType, Math.abs(x.c - slS));
    const tDir = st.trade ? st.trade.dir : 0;
    const gateL = lType && !sType && tDir !== 1 && (st.lastSigDir !== 1 || (P.allowCont && i - st.lastSigBar >= P.minBetween));
    const gateS = sType && !lType && tDir !== -1 && (st.lastSigDir !== -1 || (P.allowCont && i - st.lastSigBar >= P.minBetween));

    let recL = false, recS = false, recSL = NaN;
    const w = st.wait;
    if (P.waitRecovery && w && i > w.bar) {
      if (i - w.bar > P.maxWait || tDir === w.dir) st.wait = null;
      else if (w.dir === 1 && (x.l <= ema10[i] || x.l <= w.top) && x.c > x.o && buyPct >= 50 && x.c > ema10[i]) { recL = true; recSL = slFor(1, "retest", { top: w.top, bot: Math.min(w.bot, x.l) }); st.wait = null; }
      else if (w.dir === -1 && (x.h >= ema10[i] || x.h >= w.bot) && x.c < x.o && buyPct <= 50 && x.c < ema10[i]) { recS = true; recSL = slFor(-1, "retest", { top: Math.max(w.top, x.h), bot: w.bot }); st.wait = null; }
    }
    const takeL = (gateL && eL.q === "TAKE") || recL, takeS = (gateS && eS.q === "TAKE") || recS;
    const waitL = gateL && eL.q === "WAIT", waitS = gateS && eS.q === "WAIT";
    const avoidL = gateL && eL.q === "AVOID", avoidS = gateS && eS.q === "AVOID";
    if (waitL || waitS) st.wait = { dir: waitL ? 1 : -1, bar: i, top: Math.max(x.o, x.c), bot: Math.min(x.o, x.c), name: waitL ? lName : sName };
    const pushSig = (dir, q, name, why, sl, score) => out.signals.push({ i, t: x.t, dir, q, name, why, price: x.c, sl, score, ...tps(dir, sl) });
    if (recL) pushSig(1, "RETEST TAKE", (w && w.name) || "Retest", "pullback held with buy pressure", recSL, null);
    else if (gateL) pushSig(1, eL.q, lName, eL.why, slL, eL.score);
    if (recS) pushSig(-1, "RETEST TAKE", (w && w.name) || "Retest", "pullback rejected with sell pressure", recSL, null);
    else if (gateS) pushSig(-1, eS.q, sName, eS.why, slS, eS.score);

    // ---- trade plan (the indicator's own trades, full R)
    const T = st.trade;
    if (T && i > T.bar) {
      let ex = NaN, why = "";
      if (T.dir === 1) {
        if (x.l <= T.sl) { ex = T.sl; why = T.stage ? "trail" : "stop"; }
        else { if (T.stage < 1 && x.h >= T.tp1) { T.stage = 1; T.tp1Hit = true; T.sl = Math.max(T.sl, T.entry); }
          if (T.stage < 2 && x.h >= T.tp2) { T.stage = 2; T.sl = Math.max(T.sl, T.tp1); }
          if (x.h >= T.tp3) { ex = T.tp3; why = "tp3"; } else if (T.stage >= 1) T.sl = Math.max(T.sl, x.c - P.trailAtr * a); }
      } else {
        if (x.h >= T.sl) { ex = T.sl; why = T.stage ? "trail" : "stop"; }
        else { if (T.stage < 1 && x.l <= T.tp1) { T.stage = 1; T.tp1Hit = true; T.sl = Math.min(T.sl, T.entry); }
          if (T.stage < 2 && x.l <= T.tp2) { T.stage = 2; T.sl = Math.min(T.sl, T.tp1); }
          if (x.l <= T.tp3) { ex = T.tp3; why = "tp3"; } else if (T.stage >= 1) T.sl = Math.min(T.sl, x.c + P.trailAtr * a); }
      }
      if (!isFinite(ex) && ((T.dir === 1 && takeS) || (T.dir === -1 && takeL))) { ex = x.c; why = "opposite"; }
      if (isFinite(ex)) { out.trades.push({ ...T, exit: ex, exitI: i, exitT: x.t, why, R: (ex - T.entry) / T.risk * T.dir }); st.trade = null; }
    }
    if (takeL || takeS) {
      const d = takeL ? 1 : -1, sl = takeL ? (recL ? recSL : slL) : (recS ? recSL : slS), risk = Math.max(Math.abs(x.c - sl), 1e-12);
      st.trade = { dir: d, bar: i, t: x.t, entry: x.c, sl, risk, d: risk / x.c, tp1: x.c + d * P.tp1 * risk, tp2: x.c + d * P.tp2 * risk, tp3: x.c + d * P.tp3 * risk, stage: 0, tp1Hit: false,
        name: d === 1 ? (recL ? "Retest" : lName) : (recS ? "Retest" : sName), q: (d === 1 ? recL : recS) ? "RETEST TAKE" : "TAKE" };
      st.lastSigDir = d; st.lastSigBar = i;
    }

    // ---- helpers bound to this bar
    function upd(zs, isFvg, makeMit) {
      let b = null, s = null;
      for (let k = zs.length - 1; k >= 0; k--) {
        const z = zs[k]; let dead;
        if (z.dir === 1) { if (i > z.born && x.l <= z.top && x.c >= z.bot && !b) b = z;
          dead = isFvg ? (P.fvgMode === "ce" ? x.l <= (z.top + z.bot) / 2 : x.l <= z.bot) : x.c < z.bot; }
        else { if (i > z.born && x.h >= z.bot && x.c <= z.top && !s) s = z;
          dead = isFvg ? (P.fvgMode === "ce" ? x.h >= (z.top + z.bot) / 2 : x.h >= z.top) : x.c > z.top; }
        if (dead && i > z.born) { if (makeMit) st.mits.push({ top: z.top, bot: z.bot, dir: -z.dir, born: i, kind: "Mitigation Block" }); zs.splice(k, 1); }
      }
      return { b, s };
    }
    function slFor(dir, type, z) {
      const atrSL = x.c - dir * P.atrMult * a; let s = NaN;
      if (P.slMode === "structure") {
        if (type === "retest" && z) s = dir === 1 ? z.bot - 0.25 * a : z.top + 0.25 * a;
        else if (type === "sweep") s = dir === 1 ? x.l - 0.25 * a : x.h + 0.25 * a;
        else if (type === "breakout") s = dir === 1 ? (st.swLo < x.c ? st.swLo - 0.25 * a : atrSL) : (st.swHi > x.c ? st.swHi + 0.25 * a : atrSL);
      }
      if (!isFinite(s)) s = atrSL;
      const r = Math.abs(x.c - s);
      if (r < 0.5 * a) s = x.c - dir * 0.5 * a;
      if (r > 4 * a) s = atrSL;
      return s;
    }
    function tps(dir, sl) { const r = Math.abs(x.c - sl); return { tp1: x.c + dir * P.tp1 * r, tp2: x.c + dir * P.tp2 * r, tp3: x.c + dir * P.tp3 * r }; }
  }

  function addPool(lvl, dir, major, htf) {
    const same = st.pools.find(p => p.dir === dir && Math.abs(p.lvl - lvl) <= lvl * 1e-6);
    if (same) { same.major = same.major || major; same.htf = same.htf || htf; return; }
    const arr = dir === 1 ? st.recHi : st.recLo; let t = 1;
    for (const v of arr) if (Math.abs(v - lvl) <= P.eqTol * curA) t++;
    arr.push(lvl); if (arr.length > 60) arr.shift();
    st.pools.push({ lvl, dir, touches: t, major, htf }); if (st.pools.length > P.maxPools) st.pools.shift();
  }

  return out;
}

// The trade opinion for ANY direction at a bar — used to judge the bot's own signals.
function evaluate(S, P, dir, stype, risk) {
  if (!stype) return { q: "", score: 0, why: "" };
  const reasons = []; let score = 0, hard = false, soft = false;
  if (S.htfBias === dir) score++; else if (S.htfBias === -dir) { score--; if (P.useHtf) { hard = true; reasons.push("fighting HTF trend"); } }
  if (stype !== "sweep") { if (S.trend === dir) score++; else { score--; if (stype === "retest") { soft = true; reasons.push("against structure"); } } }
  const deltaOk = dir === 1 ? S.buyPct >= 50 : S.buyPct <= 50; score += deltaOk ? 1 : -1;
  if (P.reqDelta && !deltaOk) { soft = true; reasons.push("delta not confirming"); }
  if (isFinite(S.poc)) { const ok = dir === 1 ? S.close > S.poc : S.close < S.poc; score += ok ? 1 : -1; if (P.reqPOC && !ok) { soft = true; reasons.push(dir === 1 ? "below POC" : "above POC"); } }
  if (S.isChoppy || S.isWeak) { score--; if (stype === "breakout" && S.isChoppy) { hard = true; reasons.push("choppy regime"); } }
  const dist = dir === 1 ? S.nearBSL - S.close : S.close - S.nearSSL, bh = dir === 1 ? S.nearBSLHard : S.nearSSLHard;
  if (isFinite(dist) && dist < Math.max(P.tp1, 1) * risk) {
    if (P.softHard) { score -= bh ? 2 : 1; if (bh) hard = true; else soft = true; reasons.push(bh ? "major liquidity before TP1" : "minor liquidity before TP1"); }
    else { score--; if (stype === "breakout" && P.blockIntoLiq) hard = true; else soft = true; reasons.push("liquidity before TP1"); }
  }
  if (S.adrExh) { score--; if (stype === "breakout") hard = true; else soft = true; reasons.push(`ADR ${Math.round(S.adrPct)}% used`); }
  if (S.ext > 1.5 && !(P.setupRules && stype === "breakout")) { score--; soft = true; reasons.push("extended from 10 EMA"); }
  const q = P.useWeighted ? (hard && P.softHard ? "AVOID" : score >= P.minTake ? "TAKE" : score >= P.minWait ? "WAIT" : "AVOID") : hard ? "AVOID" : soft ? "WAIT" : "TAKE";
  return { q, score, why: reasons.length ? reasons.join(", ") : "clean confluence" };
}

module.exports = { runFlow, evaluate, DEF };
