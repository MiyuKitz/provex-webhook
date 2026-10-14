"""Aggro v26 test (Oct 15 2026). 13 coins, 4H, Jul 2023 - Oct 2026, BingX candles (see research/README).
Step 1 gen.py: run the 10-strategy engine (confluence_detectors.py, CRT fixed for 4H bars) and log every setup with its
direction filters (BTC 28d, coin 28d, 4H trend, daily structure, EMA50). Step 2 sim.py: replay every combo of
min score x direction filter x exit x stop floor, one trade per coin at a time, 0.15% costs.
Winner (positive on 13/13 coins, both halves): score 4+, coin 28d filter, stop >= 1.5%, exit trail2 (+2R -> lock +1R -> trail 4H swings).
Live settings before v26 (score 3, no filter, TP1 exit): -0.02R/trade."""

# ---- gen.py ----
import json,bisect,pickle,sys
from detectors import Engine,pivots,P
NAMES=['sr','zone','structure','retest','reversal','trendline','fib','consolidation','volume','crt']
def load(c,iv): return [dict(t=int(x['time']),o=float(x['open']),h=float(x['high']),l=float(x['low']),c=float(x['close']),v=float(x.get('volume',0))) for x in json.load(open(f"/home/claude/hist/{c}-USDT_{iv}.json"))]
def ema(v,n):
    a=2/(n+1);o=[v[0]]
    for x in v[1:]: o.append(o[-1]+a*(x-o[-1]))
    return o
BTCD=load("BTC","1d"); bdt=[x['t'] for x in BTCD]
def dret(D,dt,t,n=28):
    j=bisect.bisect_right(dt,t-86400000)-1
    return None if j<n else D[j]['c']/D[j-n]['c']-1
out={}
for coin in sys.argv[1:]:
    b=load(coin,"4h"); D=load(coin,"1d"); dt=[x['t'] for x in D]
    H,L=pivots(b); c=[x['c'] for x in b]; e20,e50=ema(c,20),ema(c,50)
    DH,DL=pivots(D); dstate=[None]*len(D); st=None; lh=ll=None
    for j in range(len(D)):
        k=j-P
        if k>=P and DH[k]: lh=D[k]['h']
        if k>=P and DL[k]: ll=D[k]['l']
        if lh and D[j]['c']>lh: st='L'
        if ll and D[j]['c']<ll: st='S'
        dstate[j]=st
    E=Engine(b); rows=[]; lh4=ph4=ll4=pl4=None
    for i in range(30,len(b)-1):
        E.update(i); k=i-P
        if k>=P and H[k]: ph4,lh4=lh4,b[k]['h']
        if k>=P and L[k]: pl4,ll4=ll4,b[k]['l']
        ok=None not in(lh4,ph4,ll4,pl4)
        tr4='L' if ok and e20[i]>e50[i] and lh4>ph4 and ll4>pl4 else 'S' if ok and e20[i]<e50[i] and lh4<ph4 and ll4<pl4 else None
        sig,trig=E.signals(i,None)
        if not trig: continue
        tc=b[i]['t']+14400000; jd=bisect.bisect_right(dt,tc-86400000)-1
        f=dict(btc28=dret(BTCD,bdt,tc),coin28=dret(D,dt,tc),tr4=tr4,dstruct=dstate[jd] if jd>=0 else None,ema50='L' if c[i]>e50[i] else 'S')
        for d in ('L','S'):
            tg=[t for t in trig if t[1]==d]
            if not tg: continue
            rows.append(dict(i=i,d=d,score=sum(1 for n in NAMES if sig[n]==d),stops=[t[2] for t in tg],trig=[t[0] for t in tg],agree=[n for n in NAMES if sig[n]==d],f=f))
    out[coin]=dict(b=b,H=H,L=L,rows=rows); print(coin,len(rows),flush=True)
pickle.dump(out,open(f"setups_{sys.argv[1]}.pkl","wb"))

# ---- sim.py (run separately: python3 sim.py) ----
SIM = r'''
import pickle,glob,math,itertools,json
from datetime import datetime,timezone
S={}
for f in glob.glob("setups_*.pkl"): S.update(pickle.load(open(f,"rb")))
SPLIT=datetime(2025,7,1,tzinfo=timezone.utc).timestamp()*1000
COST=0.0015; MAXH=120
def dirok(flt,d,f):
    if flt=="none": return True
    if flt=="btc28": return not (d=='S' and (f['btc28'] or 0)>0)
    if flt=="btc28both": return f['btc28'] is not None and ((f['btc28']>0)==(d=='L'))
    if flt=="coin28": return f['coin28'] is not None and ((f['coin28']>0)==(d=='L'))
    if flt=="tr4": return f['tr4']==d
    if flt=="tr4soft": return f['tr4'] in (d,None)
    if flt=="dstruct": return f['dstruct']==d
    if flt=="ema50": return f['ema50']==d
    if flt=="dstruct+ema50": return f['dstruct']==d and f['ema50']==d
def sim(b,H,L,i,d,stop,ex):
    e=b[i]['c']; R=abs(e-stop); sg=1 if d=='L' else -1; s=stop; done=0.0; got=0.0; trail=False; tp1=e+sg*R
    for j in range(i+1,min(i+1+MAXH,len(b))):
        y=b[j]; hi,lo=y['h'],y['l']
        fav=sg*((hi if sg>0 else lo)-e)/R
        hit= lo<=s if sg>0 else hi>=s
        if hit: return got+(1-done)*sg*(s-e)/R-COST*e/R, j
        if ex=="live":
            if not done and fav>=1: got+=0.4; done=0.4; s=e; trail=True
        elif ex in ("fix2","fix3"):
            t=2 if ex=="fix2" else 3
            if fav>=t: return t-COST*e/R, j
        elif ex=="half2":
            if not done and fav>=2: got+=1.0; done=0.5; s=e; trail=True
        elif ex=="trail2":
            if not trail and fav>=2: s=e+sg*R; trail=True
        if trail:
            k=j-3
            if k>i:
                if sg>0 and L[k] and b[k]['l']*0.999>s: s=b[k]['l']*0.999
                if sg<0 and H[k] and b[k]['h']*1.001<s: s=b[k]['h']*1.001
    return got+(1-done)*sg*(b[j]['c']-e)/R-COST*e/R, j
def run(minsc,flt,ex,floor,risk=0.05):
    T=[]
    for coin,X in S.items():
        b,H,L=X['b'],X['H'],X['L']; busy=-1; byi={}
        for r in X['rows']: byi.setdefault(r['i'],[]).append(r)
        for i in sorted(byi):
            if i<=busy: continue
            best=None
            for r in byi[i]:
                if r['score']<minsc or not dirok(flt,r['d'],r['f']): continue
                e=b[i]['c']; d=r['d']
                st=[x*(0.999 if d=='L' else 1.001) for x in r['stops']]
                st=[x for x in st if (x<e if d=='L' else x>e)]
                if not st: continue
                s_=max(st) if d=='L' else min(st)
                if abs(e-s_)/e<floor: s_=e*(1-floor) if d=='L' else e*(1+floor)
                dd=abs(e-s_)/e
                if dd<0.005 or dd>0.10: continue
                if not best or r['score']>best[0]: best=(r['score'],d,s_)
            if not best: continue
            R,j=sim(b,H,L,i,best[1],best[2],ex); busy=j
            T.append(dict(R=R,coin=coin,t=b[i]['t'],tc=b[j]['t'],d=best[1]))
    return T
def stats(T,risk=0.05):
    n=len(T)
    if n<20: return None
    m=sum(t['R'] for t in T)/n; sd=math.sqrt(sum((t['R']-m)**2 for t in T)/(n-1)); se=2*sd/math.sqrt(n)
    bld=[t['R'] for t in T if t['t']<SPLIT]; tst=[t['R'] for t in T if t['t']>=SPLIT]
    coins={}
    for t in T: coins.setdefault(t['coin'],[]).append(t['R'])
    pos=sum(1 for v in coins.values() if sum(v)>0)
    eq=1;pk=1;mdd=0
    for t in sorted(T,key=lambda t:t['tc']):
        eq*=1+risk*t['R']; pk=max(pk,eq); mdd=min(mdd,eq/pk-1)
    yrs=(max(t['tc'] for t in T)-min(t['t'] for t in T))/3.156e10
    return dict(n=n,m=m,se=se,win=sum(t['R']>0 for t in T)/n,bld=sum(bld)/max(1,len(bld)),tst=sum(tst)/max(1,len(tst)),nt=len(tst),pos=pos,nc=len(coins),cagr=eq**(1/yrs)-1 if eq>0 else -1,mdd=mdd,L=sum(1 for t in T if t['d']=='L'))
if __name__=="__main__":
  res=[]
  for minsc,flt,ex,floor in itertools.product((3,4),("none","btc28","btc28both","coin28","tr4","tr4soft","dstruct","ema50","dstruct+ema50"),("live","fix2","fix3","half2","trail2"),(0,0.01,0.015)):
      s=stats(run(minsc,flt,ex,floor))
      if s: res.append(dict(minsc=minsc,flt=flt,ex=ex,floor=floor,**s))
  json.dump(res,open("grid.json","w"))
  res.sort(key=lambda r:-r['m'])
  fmt=lambda r:f"sc{r['minsc']} {r['flt']:14} {r['ex']:6} floor{r['floor']*100:3.1f}% | n={r['n']:4} {r['m']:+.3f}R ±{r['se']:.3f} win {r['win']*100:3.0f}% | build {r['bld']:+.3f} test {r['tst']:+.3f} (n{r['nt']}) | coins+ {r['pos']}/{r['nc']} | 5%risk CAGR {r['cagr']*100:+6.0f}% maxDD {r['mdd']*100:4.0f}% | longs {r['L']}"
  print("TOP 25"); [print(fmt(r)) for r in res[:25]]
  print("\nCURRENT LIVE (sc3 none live floor0):"); [print(fmt(r)) for r in res if r['minsc']==3 and r['flt']=='none' and r['ex']=='live' and r['floor']==0]
  print("\nBY FILTER (best exit/floor each, sc4):")
  for flt in ("none","btc28","btc28both","coin28","tr4","tr4soft","dstruct","ema50","dstruct+ema50"):
      g=[r for r in res if r['flt']==flt and r['minsc']==4]; print(fmt(max(g,key=lambda r:r['m'])))
  print("\nBY EXIT (avg over all filters/floors):")
  for ex in ("live","fix2","fix3","half2","trail2"):
      g=[r['m'] for r in res if r['ex']==ex]; print(ex, f"{sum(g)/len(g):+.3f}")
  print("\nBY FLOOR:")
  for fl in (0,0.01,0.015):
      g=[r['m'] for r in res if r['floor']==fl]; print(fl, f"{sum(g)/len(g):+.3f}")
'''

# ---- stress.py ----
STRESS = r'''
from sim import run,S
import math
from datetime import datetime,timezone
def eqcurve(T,risk):
    eq=1;pk=1;mdd=0;yr={}
    for t in sorted(T,key=lambda t:t['tc']):
        y=datetime.fromtimestamp(t['tc']/1000,timezone.utc).year
        yr.setdefault(y,[eq,eq]); eq*=1+risk*t['R']; yr[y][1]=eq; pk=max(pk,eq); mdd=min(mdd,eq/pk-1)
    return eq,mdd,{y:v[1]/v[0]-1 for y,v in yr.items()}
for name,args in [("A sc4 coin28 trail2 1.5%",(4,"coin28","trail2",0.015)),("B sc4 btc28 trail2 1.5%",(4,"btc28","trail2",0.015)),("C sc4 none trail2 1.0%",(4,"none","trail2",0.01)),("LIVE now sc3 none live 0",(3,"none","live",0))]:
    T=run(*args); R=sorted(t['R'] for t in T); n=len(R)
    trim=R[:int(n*0.98)]; mx=0;cur=0
    for t in sorted(T,key=lambda t:t['t']):
        cur=cur+1 if t['R']<0 else 0; mx=max(mx,cur)
    print(f"\n== {name}: n={n} mean {sum(R)/n:+.3f}R median {R[n//2]:+.2f}R | without top 2% trades {sum(trim)/len(trim):+.3f}R | worst losing streak {mx} | trades/month {n/39:.0f}")
    for risk in (0.005,0.01,0.02):
        eq,mdd,yr=eqcurve(T,risk)
        print(f"   risk {risk*100:.1f}%/trade: total x{eq:.2f}  maxDD {mdd*100:.0f}%  by year "+" ".join(f"{y}:{v*100:+.0f}%" for y,v in sorted(yr.items())))
'''
