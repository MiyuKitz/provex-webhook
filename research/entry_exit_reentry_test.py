# Three separate experiments vs one baseline. Same signals (score>=4, coin 28d trend, stop>=1.5%), same v26.7 exit
# after entry, same $ risk per trade. Costs: fee 0.05%/side, slippage SLIP/side on entry+exit, funding 0.01%/8h.
import stoptest as st, math, sys, json, collections
from stoptest import atr
SLIP=float(sys.argv[1]) if len(sys.argv)>1 else 0.0005
FEE=0.0005; FUND=0.0001; SPLIT=st.SPLIT
def walk(b,H,L,i,e,d,stop,exitmode,hardx):
    R=abs(e-stop); sg=1 if d=='L' else -1; s=stop; be=trail=False; hard=e-sg*hardx*R
    for j in range(i+1,min(i+1+st.MAXH,len(b))):
        y=b[j]; hi,lo=y['h'],y['l']; init=not be and not trail
        if exitmode=='close' and init:
            if (lo<=hard if sg>0 else hi>=hard): return sg*(hard-e)/R,j,'hard'
            if (y['c']<=s if sg>0 else y['c']>=s): return sg*(y['c']-e)/R,j,'stop'
        elif (lo<=s if sg>0 else hi>=s): return sg*(s-e)/R,j,'stop' if init else 'trail'
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
def fixstop(e,d,s_):
    if abs(e-s_)/e<0.015: s_=e*(1-0.015) if d=='L' else e*(1+0.015)
    dd=abs(e-s_)/e
    return (s_,dd) if 0.005<=dd<=0.10 and (s_<e if d=='L' else s_>e) else (None,None)
def run(entry='now',exitmode='intrabar',hardx=2.0,reentry=False):
    T=[]
    for coin,X in st.S.items():
        b,H,L=X['b'],X['H'],X['L']; busy=-1; byi={}
        for r in X['rows']: byi.setdefault(r['i'],[]).append(r)
        for i in sorted(byi):
            if i<=busy: continue
            best=None
            for r in byi[i]:
                if r['score']<4 or not st.dirok('coin28',r['d'],r['f']): continue
                e=b[i]['c']; d=r['d']
                s=[x*(0.999 if d=='L' else 1.001) for x in r['stops']]; s=[x for x in s if (x<e if d=='L' else x>e)]
                if not s: continue
                s_=max(s) if d=='L' else min(s)
                if not best or r['score']>best[0]: best=(r['score'],d,s_,r['f'])
            if not best: continue
            _,d,s_,f=best; sg=1 if d=='L' else -1; ie=i
            if entry=='momentum':   # skip if the last 3 candles ran >1 ATR AGAINST the trade (entering into a countertrend rally)
                if -sg*(b[i]['c']-b[i-3]['c'])>atr(b,i): continue
            if entry in('confirm','break'):
                ie=None; lvl=b[i]['c'] if entry=='confirm' else (b[i]['l'] if d=='S' else b[i]['h'])
                for k in range(i+1,min(i+4,len(b)-1)):
                    if (b[k]['h']>=s_ if d=='S' else b[k]['l']<=s_): break      # invalidated before confirming
                    if (b[k]['c']<lvl if d=='S' else b[k]['c']>lvl): ie=k; break
                if ie is None: busy=i; continue
            e=b[ie]['c']; s1,dd=fixstop(e,d,s_)
            if s1 is None: continue
            R,j,why=walk(b,H,L,ie,e,d,s1,exitmode,hardx)
            T.append(dict(R=R-(2*FEE+2*SLIP+FUND*(j-ie)/2)/dd,coin=coin,t=b[ie]['t'],tc=b[j]['t'],d=d,btc=f['btc28'],why=why,re=0)); busy=j
            if reentry and why in('stop','hard'):
                ext=min(b[k]['l'] for k in range(ie,j+1)) if d=='S' else max(b[k]['h'] for k in range(ie,j+1))
                for k in range(j+1,min(j+13,len(b)-1)):   # fresh structure: close breaks back through the trade's best price
                    if (b[k]['c']<ext if d=='S' else b[k]['c']>ext):
                        sw=max(b[m]['h'] for m in range(j,k+1))*1.001 if d=='S' else min(b[m]['l'] for m in range(j,k+1))*0.999
                        e2=b[k]['c']; s2,dd2=fixstop(e2,d,sw)
                        if s2 is None: break
                        R2,j2,w2=walk(b,H,L,k,e2,d,s2,exitmode,hardx)
                        T.append(dict(R=R2-(2*FEE+2*SLIP+FUND*(j2-k)/2)/dd2,coin=coin,t=b[k]['t'],tc=b[j2]['t'],d=d,btc=f['btc28'],why=w2,re=1)); busy=j2
                        break
    return T
def rep(name,T,risk=0.005):
    n=len(T); m=sum(t['R'] for t in T)/n
    day=collections.defaultdict(list)
    for t in T: day[t['t']//86400000].append(t['R'])
    cl=math.sqrt(sum(sum(x-m for x in v)**2 for v in day.values()))/n   # SE clustered by entry day (correlated coins)
    w=sum(t['R'] for t in T if t['R']>0); l=-sum(t['R'] for t in T if t['R']<0)
    eq=pk=1; dd=0; ex=collections.defaultdict(float)
    for t in sorted(T,key=lambda t:t['tc']): eq*=1+risk*t['R']; pk=max(pk,eq); dd=min(dd,eq/pk-1); ex[t['tc']//86400000]+=t['R']
    h1=[t['R'] for t in T if t['t']<SPLIT]; h2=[t['R'] for t in T if t['t']>=SPLIT]
    up=[t['R'] for t in T if (t['btc'] or 0)>0]; dn=[t['R'] for t in T if (t['btc'] or 0)<=0]
    cs=collections.defaultdict(float)
    for t in T: cs[t['coin']]+=t['R']
    yrs=(max(t['tc'] for t in T)-min(t['t'] for t in T))/3.156e10
    avg=lambda v:sum(v)/len(v) if v else 0
    print(f"{name:40} n={n:4} exp {m:+.3f}R (t={m/cl:.1f}) PF {w/l:.2f} win {sum(t['R']>0 for t in T)/n*100:3.0f}% | 0.5%risk {(eq**(1/yrs)-1)*100:+4.0f}%/yr DD {dd*100:4.0f}% | worst trade {min(t['R'] for t in T):+.2f}R worst day {min(ex.values()):+.1f}R | H1 {avg(h1):+.3f} H2 {avg(h2):+.3f} | BTC up {avg(up):+.3f} down {avg(dn):+.3f} | coins+ {sum(v>0 for v in cs.values())}/{len(cs)}",flush=True)
print(f"=== slippage {SLIP*100:.2f}%/side ===")
rep("BASELINE (current live rules)",run())
rep("E1a entry: next candle confirms",run(entry='confirm'))
rep("E1b entry: close breaks signal candle",run(entry='break'))
rep("E1c entry: skip if into a >1ATR rally",run(entry='momentum'))
rep("E2a exit: 4H-close stop, hard 1.5x",run(exitmode='close',hardx=1.5))
rep("E2b exit: 4H-close stop, hard 2x",run(exitmode='close',hardx=2.0))
rep("E3  re-entry on fresh structure",run(reentry=True))
