"""Pre-registered 'fast trend' test: 4H bars, BTC+ETH. Each 4h: direction = sign of return
over the last N bars (N = 3/5/7 days). Variants: long-only (cash when negative) / long+short.
Vol target 40%/yr, max 1x per coin. Fees 0.1% per unit traded, funding ~10%/yr paid by longs
(received by shorts). Build Aug 2022-2025, holdout 2026."""
import json,math
from datetime import datetime,timezone
H4=6*365
def load(c): return [(int(x['time']),float(x['close'])) for x in json.load(open(f"bx4h_{c}.json"))]
B,E=load("BTC"),load("ETH"); t2={t:c for t,c in E}
bars=[(t,b,t2[t]) for t,b in B if t in t2]
FUND=0.10/H4
def run(N,shorts):
    w=[0,0];out=[];trades=0
    for i in range(N+20,len(bars)-1):
        nw=[]
        for k in (1,2):
            px=[bars[j][k] for j in range(i-20,i+1)]
            vol=math.sqrt(sum(math.log(px[a]/px[a-1])**2 for a in range(1,21))/20*H4)
            size=min(1,0.4/vol) if vol>0 else 1
            mom=bars[i][k]/bars[i-N][k]-1
            d=1 if mom>0 else (-1 if shorts else 0)
            nw.append(d*size/2)
        cost=sum(abs(a-b) for a,b in zip(nw,w))*0.001
        trades+=sum(1 for a,b in zip(nw,w) if (a>0)!=(b>0) or (a<0)!=(b<0))
        w=nw
        r=sum(w[k-1]*(bars[i+1][k]/bars[i][k]-1) for k in (1,2)) - sum(x*FUND for x in w) - cost
        out.append((bars[i][0],r))
    return out,trades
def met(s,lo,hi):
    rs=[r for t,r in s if lo<=datetime.fromtimestamp(t/1000,timezone.utc).year<=hi]
    n=len(rs);m=sum(rs)/n;sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1))
    eq=1;pk=1;dd=0
    for r in rs: eq*=1+r;pk=max(pk,eq);dd=min(dd,eq/pk-1)
    return f"CAGR {(eq**(H4/n)-1)*100:+5.0f}% Sharpe {m/sd*math.sqrt(H4):+.2f} maxDD {dd*100:4.0f}%"
for shorts in (False,True):
    for days in (3,5,7):
        s,tr=run(days*6,shorts)
        yrs=len(s)/H4
        print(f"{'long+short' if shorts else 'long-only '} {days}d | BUILD {met(s,2022,2025)} | 2026 {met(s,2026,2026)} | ~{tr/yrs:.0f} flips/yr")
# benchmark: daily Core-style 28d on same data
s,tr=run(28*6,False); print(f"benchmark 28d long-only | BUILD {met(s,2022,2025)} | 2026 {met(s,2026,2026)} | ~{tr/(len(s)/H4):.0f} flips/yr")
