"""Krysie's 10-strategy confluence engine (research). All detectors use only data up to bar i (no lookahead).
1 S/R key level  2 Demand/Supply zone  3 Swing structure (BOS/CHoCH)  4 Break & retest  5 Reversal pattern
(double top/bottom + failed high/low)  6 Trendline bounce/break  7 Fibonacci 50-61.8%  8 Consolidation breakout
9 Price+volume (Tim Ord low-volume test + volume climax)  10 CRT (NY 4H purge)"""
import math
from datetime import datetime,timezone,timedelta
from zoneinfo import ZoneInfo
NY=ZoneInfo("America/New_York"); P=3
def atr(b,i,n=14):
    return sum(max(b[k]['h']-b[k]['l'],abs(b[k]['h']-b[k-1]['c']),abs(b[k]['l']-b[k-1]['c'])) for k in range(i-n+1,i+1))/n
def pivots(b):
    H=[False]*len(b);L=[False]*len(b)
    for k in range(P,len(b)-P):
        H[k]=all(b[k]['h']>b[k+d]['h'] for d in range(-P,P+1) if d); L[k]=all(b[k]['l']<b[k+d]['l'] for d in range(-P,P+1) if d)
    return H,L
class Engine:
    def __init__(s,b):
        s.b=b; s.H,s.L=pivots(b); s.ph=[]; s.pl=[]   # confirmed pivots (index) known so far
        s.zonesD=[]; s.zonesS=[]; s.armed=None; s.avgv=None
    def update(s,i):   # call once per bar, in order
        b=s.b;k=i-P
        if k>=P and s.H[k]: s.ph.append(k)
        if k>=P and s.L[k]: s.pl.append(k)
        # demand/supply zones: base candle before a strong 1-3 bar impulse (move > 2.5 ATR)
        if i>20:
            a=atr(b,i)
            if b[i]['c']-b[i-3]['o']>2.5*a: s.zonesD.append([min(x['l'] for x in b[i-4:i-2]),max(x['o'] for x in b[i-4:i-2]),i,0])
            if b[i-3]['o']-b[i]['c']>2.5*a: s.zonesS.append([min(x['o'] for x in b[i-4:i-2]),max(x['h'] for x in b[i-4:i-2]),i,0])
            s.zonesD=[z for z in s.zonesD if i-z[2]<300 and b[i]['c']>z[0]*0.995][-8:]
            s.zonesS=[z for z in s.zonesS if i-z[2]<300 and b[i]['c']<z[1]*1.005][-8:]
    def signals(s,i,trend4h):
        """returns dict detector -> 'L'/'S'/None for bar i, plus trigger info"""
        b=s.b;x=b[i];a=atr(b,i);out={};trig=[]
        ph=s.ph;pl=s.pl
        # 3 structure
        st=None
        if len(ph)>=2 and len(pl)>=2:
            if b[ph[-1]]['h']>b[ph[-2]]['h'] and b[pl[-1]]['l']>b[pl[-2]]['l']: st='L'
            if b[ph[-1]]['h']<b[ph[-2]]['h'] and b[pl[-1]]['l']<b[pl[-2]]['l']: st='S'
            if x['c']>b[ph[-1]]['h'] and st=='S': st='L'   # CHoCH up
            if x['c']<b[pl[-1]]['l'] and st=='L': st='S'   # CHoCH down
        out['structure']=st
        # 1 S/R key level: >=2 pivots within 0.4% form a level
        lv=[b[k]['h'] for k in ph[-12:]]+[b[k]['l'] for k in pl[-12:]]
        sr=None
        for L_ in lv:
            if sum(1 for v in lv if abs(v-L_)/L_<0.004)>=2:
                if x['l']<=L_*1.002 and x['c']>L_ and x['c']>x['o']: sr='L'; trig.append(('sr','L',x['l']))
                if x['h']>=L_*0.998 and x['c']<L_ and x['c']<x['o']: sr='S'; trig.append(('sr','S',x['h']))
                if sr: break
        out['sr']=sr
        # 2 demand / supply
        dz=None
        for z in s.zonesD:
            if z[2]<i-3 and x['l']<=z[1] and x['c']>z[1] and x['c']>x['o']: dz='L'; trig.append(('zone','L',min(x['l'],z[0]))); break
        if not dz:
            for z in s.zonesS:
                if z[2]<i-3 and x['h']>=z[0] and x['c']<z[0] and x['c']<x['o']: dz='S'; trig.append(('zone','S',max(x['h'],z[1]))); break
        out['zone']=dz
        # 4 break & retest
        br=None
        if s.armed and i-s.armed[2]>24: s.armed=None
        if ph and x['c']>b[ph[-1]]['h'] and b[i-1]['c']<=b[ph[-1]]['h']: s.armed=('L',b[ph[-1]]['h'],i)
        elif pl and x['c']<b[pl[-1]]['l'] and b[i-1]['c']>=b[pl[-1]]['l']: s.armed=('S',b[pl[-1]]['l'],i)
        elif s.armed:
            sd,lv_,_=s.armed
            if sd=='L' and x['l']<=lv_*1.003 and x['c']>lv_: br='L'; trig.append(('retest','L',x['l'])); s.armed=None
            elif sd=='S' and x['h']>=lv_*0.997 and x['c']<lv_: br='S'; trig.append(('retest','S',x['h'])); s.armed=None
        out['retest']=br
        # 5 reversal: failed low/high (sweep + close back) or double bottom/top
        rv=None
        if pl and i-pl[-1]<=60 and x['l']<b[pl[-1]]['l'] and x['c']>b[pl[-1]]['l']: rv='L'; trig.append(('reversal','L',x['l']))
        elif ph and i-ph[-1]<=60 and x['h']>b[ph[-1]]['h'] and x['c']<b[ph[-1]]['h']: rv='S'; trig.append(('reversal','S',x['h']))
        elif len(pl)>=2 and abs(b[pl[-1]]['l']-b[pl[-2]]['l'])/b[pl[-1]]['l']<0.004 and ph and ph[-1]>pl[-2] and x['c']>b[ph[-1]]['h'] and b[i-1]['c']<=b[ph[-1]]['h']: rv='L'
        elif len(ph)>=2 and abs(b[ph[-1]]['h']-b[ph[-2]]['h'])/b[ph[-1]]['h']<0.004 and pl and pl[-1]>ph[-2] and x['c']<b[pl[-1]]['l'] and b[i-1]['c']>=b[pl[-1]]['l']: rv='S'
        out['reversal']=rv
        # 6 trendline: rising line through last 2 pivot lows (bounce=L, break=S); falling through 2 highs (bounce=S, break=L)
        tl=None
        if len(pl)>=2 and b[pl[-1]]['l']>b[pl[-2]]['l']:
            k1,k2=pl[-2],pl[-1]; y=b[k2]['l']+(b[k2]['l']-b[k1]['l'])/(k2-k1)*(i-k2)
            if x['l']<=y*1.002 and x['c']>y: tl='L'; trig.append(('trendline','L',x['l']))
            elif x['c']<y*0.997 and b[i-1]['c']>=y: tl='S'
        if not tl and len(ph)>=2 and b[ph[-1]]['h']<b[ph[-2]]['h']:
            k1,k2=ph[-2],ph[-1]; y=b[k2]['h']+(b[k2]['h']-b[k1]['h'])/(k2-k1)*(i-k2)
            if x['h']>=y*0.998 and x['c']<y: tl='S'; trig.append(('trendline','S',x['h']))
            elif x['c']>y*1.003 and b[i-1]['c']<=y: tl='L'
        out['trendline']=tl
        # 7 fibonacci 50-61.8% of last impulse
        fb=None
        if ph and pl:
            if ph[-1]>pl[-1]:
                lo,hi=b[pl[-1]]['l'],b[ph[-1]]['h']; f5,f6=hi-0.5*(hi-lo),hi-0.618*(hi-lo)
                if x['l']<=f5 and x['c']>=f6 and x['c']>x['o']: fb='L'; trig.append(('fib','L',min(x['l'],f6)))
            else:
                lo,hi=b[pl[-1]]['l'],b[ph[-1]]['h']; f5,f6=lo+0.5*(hi-lo),lo+0.618*(hi-lo)
                if x['h']>=f5 and x['c']<=f6 and x['c']<x['o']: fb='S'; trig.append(('fib','S',max(x['h'],f6)))
        out['fib']=fb
        # 8 consolidation breakout: prior 12 bars range < 3 ATR, close breaks out
        cb=None
        hi12=max(z['h'] for z in b[i-12:i]); lo12=min(z['l'] for z in b[i-12:i])
        if hi12-lo12<3*a:
            if x['c']>hi12: cb='L'; trig.append(('consolidation','L',lo12))
            elif x['c']<lo12: cb='S'; trig.append(('consolidation','S',hi12))
        out['consolidation']=cb
        # 9 volume: low-volume test of prior swing low/high (Ord), or climax (vol > 3x avg) with rejection wick
        vv=None; av=sum(z['v'] for z in b[i-20:i])/20
        if pl and abs(x['l']-b[pl[-1]]['l'])/x['l']<0.004 and x['v']<0.92*b[pl[-1]]['v'] and x['c']>x['o']: vv='L'
        elif ph and abs(x['h']-b[ph[-1]]['h'])/x['h']<0.004 and x['v']<0.92*b[ph[-1]]['v'] and x['c']<x['o']: vv='S'
        elif x['v']>3*av and (min(x['o'],x['c'])-x['l'])>0.6*(x['h']-x['l']): vv='L'
        elif x['v']>3*av and (x['h']-max(x['o'],x['c']))>0.6*(x['h']-x['l']): vv='S'
        out['volume']=vv
        # 10 CRT (NY): this bar closes the 09:00 4H candle that swept the 05:00 candle's low & closed inside (L); 01:00 vs 21:00 (S)
        cr=None
        d=datetime.fromtimestamp((x['t']+3600000)/1000,timezone.utc).astimezone(NY)
        if d.hour in (13,5) and i>=8:
            c2=b[i-3:i+1]; c1=b[i-7:i-3]
            h1,l1=max(z['h'] for z in c1),min(z['l'] for z in c1); h2,l2=max(z['h'] for z in c2),min(z['l'] for z in c2); cl=c2[-1]['c']
            if d.hour==13 and l2<l1 and l1<cl<h1: cr='L'; trig.append(('crt','L',l2))
            if d.hour==5 and h2>h1 and l1<cl<h1: cr='S'; trig.append(('crt','S',h2))
        out['crt']=cr
        out['trend4h']='L' if trend4h=='up' else 'S' if trend4h=='down' else None
        return out,trig
