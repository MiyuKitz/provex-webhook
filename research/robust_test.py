import json,math
from datetime import datetime,timezone
D=86400000
P={a:{int(k):v for k,v in json.load(open(f"daily_{a}-USDT.json")).items()} for a in ("BTC","ETH")}
days=sorted(set(P["BTC"])&set(P["ETH"]))
def series(asset,lb,wd,filt=True):
    reb=[d for d in days if datetime.fromtimestamp(d/1000,timezone.utc).weekday()==wd]
    out=[];prev=None
    for a,b in zip(reb,reb[1:]):
        p=a-lb*D
        if p not in P["BTC"]: continue
        rs=[]
        for s in (["BTC","ETH"] if asset=="BOTH" else [asset]):
            on = (P[s][a]/P[s][p]-1>0) if filt else True
            r=(P[s][b]/P[s][a]-1) if on else 0.0
            rs.append((r,on,s))
        r=sum(x[0] for x in rs)/len(rs)
        state=tuple(x[1] for x in rs)
        if prev is not None: r-=0.001*sum(1 for x,y in zip(state,prev) if x!=y)/len(rs)
        prev=state; out.append((a,r))
    return out
def met(s):
    rs=[r for _,r in s]; n=len(rs); m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1))
    eq=1;pk=1;dd=0
    for r in rs: eq*=1+r; pk=max(pk,eq); dd=min(dd,eq/pk-1)
    yrs=n/52.18
    return dict(cagr=eq**(1/yrs)-1, sharpe=m/sd*math.sqrt(52.18), dd=dd, total=eq-1)
for asset in ("BTC","ETH","BOTH"):
    bh=met(series(asset,28,0,False))
    print(f"\n=== {asset}  buy&hold 2018-26: CAGR {bh['cagr']*100:+.0f}%  Sharpe {bh['sharpe']:.2f}  maxDD {bh['dd']*100:.0f}%")
    grid={}
    for lb in (14,21,28,35,42,56,84):
        row=[met(series(asset,lb,wd)) for wd in range(7)]
        grid[lb]=row
        sh=[x['sharpe'] for x in row]; dd=[x['dd'] for x in row]; cg=[x['cagr'] for x in row]
        print(f"  lookback {lb:2}d | Sharpe {min(sh):.2f}-{max(sh):.2f} | CAGR {min(cg)*100:+.0f}% to {max(cg)*100:+.0f}% | maxDD {min(dd)*100:.0f}% to {max(dd)*100:.0f}%")
    allc=[x for r in grid.values() for x in r]
    print(f"  -> {sum(x['sharpe']>bh['sharpe'] for x in allc)}/49 combos beat buy&hold Sharpe | {sum(x['dd']>bh['dd'] for x in allc)}/49 have smaller maxDD")
# year by year for BTC 28d Monday vs buy&hold
print("\nBTC year by year (28d filter, Monday) vs buy&hold:")
f=series("BTC",28,0); h=series("BTC",28,0,False)
for y in range(2018,2027):
    fy=[r for t,r in f if datetime.fromtimestamp(t/1000,timezone.utc).year==y]; hy=[r for t,r in h if datetime.fromtimestamp(t/1000,timezone.utc).year==y]
    pf=math.prod(1+r for r in fy)-1; ph=math.prod(1+r for r in hy)-1
    print(f"  {y}: filter {pf*100:+6.0f}%   hold {ph*100:+6.0f}%")
