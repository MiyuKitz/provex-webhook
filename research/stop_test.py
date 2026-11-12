# Does the stop placement shake us out of good trades? v26.7 exit kept identical, only the INITIAL stop rule changes.
import pickle,glob,math,json,sys
from datetime import datetime,timezone
from sim import dirok
S={}
for f in glob.glob("setups_*.pkl"): S.update(pickle.load(open(f,"rb")))
SPLIT=datetime(2025,7,1,tzinfo=timezone.utc).timestamp()*1000
FEE=0.0005; SLIP=0.0005; FUND=0.0001; MAXH=120
def atr(b,j,n=14):
    tr=[max(b[k]['h']-b[k]['l'],abs(b[k]['h']-b[k-1]['c']),abs(b[k]['l']-b[k-1]['c'])) for k in range(max(1,j-n+1),j+1)]
    return sum(tr)/len(tr)
def walk(b,H,L,i,d,stop,mode):
    """mode: intrabar | close1 (initial stop needs a 4H CLOSE beyond it, hard stop at 2x distance) | closeall"""
    e=b[i]['c']; R=abs(e-stop); sg=1 if d=='L' else -1; s=stop; be=False; trail=False
    hard=e-sg*2*R
    for j in range(i+1,min(i+1+MAXH,len(b))):
        y=b[j]; hi,lo=y['h'],y['l']
        initial=not be and not trail
        if mode=='intrabar' or (mode=='close1' and not initial):
            if (lo<=s if sg>0 else hi>=s): return sg*(s-e)/R,j,'stop'
        else:
            if (lo<=hard if sg>0 else hi>=hard): return sg*(hard-e)/R,j,'hard'
            if (y['c']<=s if sg>0 else y['c']>=s): return sg*(y['c']-e)/R,j,'closestop'
        fav=sg*((hi if sg>0 else lo)-e)/R
        if not be and fav>=1.5: be=True; s=e+sg*0.1*R
        if not trail and fav>=2: s=e+sg*R; trail=True
        if trail:
            v=y['c']-sg*2*atr(b,j)
            if (sg>0 and v>s) or (sg<0 and v<s): s=v
            k=j-3
            if k>i:
                if sg>0 and L[k] and b[k]['l']*0.999>s: s=b[k]['l']*0.999
                if sg<0 and H[k] and b[k]['h']*1.001<s: s=b[k]['h']*1.001
    return sg*(b[j]['c']-e)/R,j,'time'
def run(mode='intrabar',buf=0.0,reentry=False):
    T=[]
    for coin,X in S.items():
        b,H,L=X['b'],X['H'],X['L']; busy=-1; byi={}
        for r in X['rows']: byi.setdefault(r['i'],[]).append(r)
        for i in sorted(byi):
            if i<=busy: continue
            best=None
            for r in byi[i]:
                if r['score']<4 or not dirok('coin28',r['d'],r['f']): continue
                e=b[i]['c']; d=r['d']
                st=[x*(0.999 if d=='L' else 1.001) for x in r['stops']]; st=[x for x in st if (x<e if d=='L' else x>e)]
                if not st: continue
                s_=max(st) if d=='L' else min(st)
                if abs(e-s_)/e<0.015: s_=e*(1-0.015) if d=='L' else e*(1+0.015)
                if buf: s_=s_-buf*atr(b,i) if d=='L' else s_+buf*atr(b,i)
                dd=abs(e-s_)/e
                if dd<0.005 or dd>0.12: continue
                if not best or r['score']>best[0]: best=(r['score'],d,s_,dd)
            if not best: continue
            _,d,s_,dd=best; sg=1 if d=='L' else -1
            R,j,why=walk(b,H,L,i,d,s_,mode)
            cost=(2*FEE+2*SLIP+FUND*(j-i)/2)/dd
            T.append(dict(R=R-cost,coin=coin,t=b[i]['t'],tc=b[j]['t'],d=d,why=why,re=0)); busy=j
            if reentry and why in('stop','closestop','hard') and R<0:
                e0=b[i]['c']
                for k in range(j+1,min(j+7,len(b)-1)):   # price closes back on our side of the original entry within 24h
                    if (b[k]['c']<e0 if d=='S' else b[k]['c']>e0):
                        e1=b[k]['c']; s1=e1*(1+dd) if d=='S' else e1*(1-dd)
                        R2,j2,w2=walk(b,H,L,k,d,s1,mode)
                        T.append(dict(R=R2-(2*FEE+2*SLIP+FUND*(j2-k)/2)/dd,coin=coin,t=b[k]['t'],tc=b[j2]['t'],d=d,why=w2,re=1)); busy=j2
                        break
    return T
def stats(T,risk=0.005):
    n=len(T); m=sum(t['R'] for t in T)/n; sd=math.sqrt(sum((t['R']-m)**2 for t in T)/(n-1))
    h1=[t['R'] for t in T if t['t']<SPLIT]; h2=[t['R'] for t in T if t['t']>=SPLIT]
    cs={}
    for t in T: cs[t['coin']]=cs.get(t['coin'],0)+t['R']
    w=sum(t['R'] for t in T if t['R']>0); l=-sum(t['R'] for t in T if t['R']<0)
    big=sum(1 for t in T if t['R']>=4); worst=min(t['R'] for t in T)
    return f"n={n:4} exp {m:+.3f}R (±{2*sd/math.sqrt(n):.3f}) win {sum(t['R']>0 for t in T)/n*100:3.0f}% PF {w/l:.2f} | H1 {sum(h1)/len(h1):+.3f} H2 {sum(h2)/len(h2):+.3f} | coins+ {sum(v>0 for v in cs.values())}/{len(cs)} | +4R wins {big} | worst {worst:+.2f}R | total {sum(t['R'] for t in T):+.0f}R"
if __name__=="__main__":
    V=[("current: intrabar stop",dict()),
       ("stop needs 4H CLOSE beyond it (hard stop 2x)",dict(mode='close1')),
       ("stop + 0.5x ATR buffer",dict(buf=0.5)),
       ("stop + 1.0x ATR buffer",dict(buf=1.0)),
       ("close-stop + 0.5x ATR buffer",dict(mode='close1',buf=0.5)),
       ("re-enter once if price comes back within 24h",dict(reentry=True)),
       ("close-stop + re-enter",dict(mode='close1',reentry=True))]
    out={}
    for name,kw in V:
        T=run(**kw); out[name]=T; print(f"{name:46} | {stats(T)}",flush=True)
    pickle.dump(out,open("stoptest_out.pkl","wb"))
