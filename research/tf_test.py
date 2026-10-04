import json,math
from datetime import datetime,timezone
from pine_port import v14_signals
from v19_backtest import load,trend_series
def agg(b,ms):
    out=[];cur=None
    for x in b:
        t=x['t']//ms*ms
        if not cur or cur['t']!=t:
            if cur: out.append(cur)
            cur=dict(t=t,o=x['o'],h=x['h'],l=x['l'],c=x['c'],v=x['v'])
        else: cur['h']=max(cur['h'],x['h']);cur['l']=min(cur['l'],x['l']);cur['c']=x['c'];cur['v']+=x['v']
    out.append(cur); return out
H=3600000
def walk(b,i,side,entry,mult,stop_pct=0.05,maxb=192):
    sgn=-1 if side=="Short" else 1; sl=entry*(1-sgn*stop_pct); risk=abs(entry-sl)
    tps=[entry+sgn*risk*m for m in mult]; w=[0.4,0.3,0.3]; done=[0]*3; R=0; end=i
    for j in range(i+1,min(i+1+maxb,len(b))):
        y=b[j]; end=j
        hitS= y['h']>=sl if side=="Short" else y['l']<=sl
        for k in range(3):
            if not done[k] and not hitS and (y['l']<=tps[k] if side=="Short" else y['h']>=tps[k]): done[k]=1;R+=w[k]*mult[k]
        if hitS: return R-sum(w[k] for k in range(3) if not done[k])-0.02, j
        if all(done): return R-0.02, j
    lc=b[end]['c']; return R+sum(w[k] for k in range(3) if not done[k])*sgn*(lc-entry)/risk-0.02, end
def st(rs):
    n=len(rs)
    if n<10: return f"n={n}"
    m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1)); se=2*sd/math.sqrt(n)
    return f"n={n:4} win={sum(r>0 for r in rs)/n*100:3.0f}% {m:+.3f}R ±{se:.3f} {'✅' if m-se>0 else '❌' if m+se<0 else '~'}"
res={}
for tf,htf_ms in [(H,4*H),(4*H,24*H)]:
    for sym in ["SUI","ETH","SOL"]:
        b15=load(sym); b=agg(b15,tf); bh=agg(b15,htf_ms); ht=trend_series(bh); hidx={x['t']:k for k,x in enumerate(bh)}
        busy={"Long":-1,"Short":-1}
        for sg in v14_signals(b):
            i=sg['i']; side=sg['side']
            if i<=busy[side]: continue
            th=b[i]['t']//htf_ms*htf_ms-htf_ms
            if th not in hidx: continue
            h=ht[hidx[th]]; opp=(side=="Short" and h=="Bullish") or (side=="Long" and h=="Bearish")
            entry=(sg['top']+sg['bot'])/2
            yr=datetime.fromtimestamp(b[i]['t']/1000,timezone.utc).year
            for V,mult in (("0.5/2/3R",[0.5,2,3]),("1/2/3R",[1,2,3])):
                R,end=walk(b,i,side,entry,mult)
                res.setdefault((tf,V),[]).append(dict(R=R,yr=yr,opp=opp,sym=sym))
            busy[side]=end
for (tf,V),T in res.items():
    lab="1H" if tf==H else "4H"
    tr=[t for t in T if t['yr']<=2025]
    print(f"{lab} {V:9} BUILD all {st([t['R'] for t in tr])} | HTF-opp {st([t['R'] for t in tr if t['opp']])}")
