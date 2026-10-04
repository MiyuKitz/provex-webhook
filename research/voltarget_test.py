import json,math
from datetime import datetime,timezone
D=86400000
P={a:{int(k):v for k,v in json.load(open(f"daily_{a}-USDT.json")).items()} for a in ("BTC","ETH")}
days=sorted(set(P["BTC"])&set(P["ETH"]))
def run(assets,lb,target,check_every=1):
    out=[];w={s:0.0 for s in assets}
    for n in range(max(lb,30),len(days)-1):
        d,nx=days[n],days[n+1]
        if (n%check_every)==0:
            neww={}
            for s in assets:
                on=P[s][d]/P[s][days[n-lb]]-1>0
                rets=[math.log(P[s][days[k]]/P[s][days[k-1]]) for k in range(n-19,n+1)]
                vol=math.sqrt(sum(r*r for r in rets)/20)*math.sqrt(365)
                size=1.0 if target is None else min(1.0,target/vol) if vol>0 else 1.0
                neww[s]=(size if on else 0.0)/len(assets)
            cost=sum(abs(neww[s]-w[s]) for s in assets)*0.001; w=neww
        else: cost=0
        r=sum(w[s]*(P[s][nx]/P[s][d]-1) for s in assets)-cost
        out.append((nx,r))
    return out
def met(s,y0=None,y1=None):
    rs=[r for t,r in s if (y0 is None or datetime.fromtimestamp(t/1000,timezone.utc).year>=y0) and (y1 is None or datetime.fromtimestamp(t/1000,timezone.utc).year<=y1)]
    n=len(rs); m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1))
    eq=1;pk=1;dd=0
    for r in rs: eq*=1+r; pk=max(pk,eq); dd=min(dd,eq/pk-1)
    return f"CAGR {(eq**(365/n)-1)*100:+4.0f}%  Sharpe {m/sd*math.sqrt(365):.2f}  maxDD {dd*100:4.0f}%"
for assets,name in ((["BTC"],"BTC"),(["BTC","ETH"],"BTC+ETH")):
    print(f"\n=== {name}")
    print(f"  buy&hold                      2018-26 {met(run(assets,1,None,10**9) if False else [(t, sum((P[s][t]/P[s][days[days.index(t)-1]]-1) for s in assets)/len(assets)) for t in days[31:]])}")
    for lb in (21,28,35):
        print(f"  filter {lb}d, daily, no voltgt   2018-26 {met(run(assets,lb,None))} | 2026 {met(run(assets,lb,None),2026)}")
        for tg in (0.3,0.4,0.6):
            s=run(assets,lb,tg)
            print(f"  filter {lb}d + voltarget {int(tg*100)}%    2018-26 {met(s)} | 2026 {met(s,2026)}")
