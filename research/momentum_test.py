"""Pre-registered: weekly coin rotation. Rank 18 coins by past return, hold top 3 for a week.
Variants: lookback 7d / 28d; with/without 'only hold if own return > 0' (cash otherwise).
Benchmarks: equal-weight all coins, BTC. Fees 0.1% per unit turnover."""
import json,math
from datetime import datetime,timezone
coins=["SUI","ETH","SOL","BTC","BNB","XRP","DOGE","ADA","AVAX","LINK","DOT","LTC","NEAR","APT","ARB","OP","INJ","TIA"]
D=86400000
px={}
for s in coins:
    for c in json.load(open(f"bx4h_{s}.json")):
        t=int(c['time'])
        if t%D==D-4*3600000:            # last 4h bar of the UTC day -> daily close
            px.setdefault(t+4*3600000,{})[s]=float(c['close'])
days=sorted(px)
# weekly rebalance dates: Mondays 00:00 UTC
mons=[d for d in days if datetime.fromtimestamp(d/1000,timezone.utc).weekday()==0]
def run(lb,absf,top=3):
    W=[];prev=set()
    for a,b in zip(mons,mons[1:]):
        past=a-lb*D
        if past not in px: continue
        cand=[s for s in coins if s in px[a] and s in px[past] and s in px.get(b,{})]
        if len(cand)<6: continue
        mom={s:px[a][s]/px[past][s]-1 for s in cand}
        pick=sorted(cand,key=lambda s:-mom[s])[:top]
        if absf: pick=[s for s in pick if mom[s]>0]
        ret=sum(px[b][s]/px[a][s]-1 for s in pick)/top if pick else 0.0   # unpicked slots = cash
        turn=len(set(pick)^prev)/top; prev=set(pick)
        ew=sum(px[b][s]/px[a][s]-1 for s in cand)/len(cand)
        btc=px[b]["BTC"]/px[a]["BTC"]-1
        W.append(dict(t=a,yr=datetime.fromtimestamp(a/1000,timezone.utc).year,r=ret-0.001*turn,ew=ew,btc=btc))
    return W
def stats(rs):
    n=len(rs); m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1))
    eq=1;pk=1;dd=0
    for r in rs: eq*=1+r; pk=max(pk,eq); dd=min(dd,eq/pk-1)
    return f"{n:3}w  total {eq*100-100:+7.0f}%  Sharpe {m/sd*math.sqrt(52) if sd else 0:+.2f}  maxDD {dd*100:5.0f}%"
def alpha(W):
    d=[w['r']-w['ew'] for w in W]; n=len(d); m=sum(d)/n; sd=math.sqrt(sum((x-m)**2 for x in d)/(n-1))
    return f"vs equal-weight: {m*100:+.2f}%/wk ±{2*sd/math.sqrt(n)*100:.2f} {'✅' if m-2*sd/math.sqrt(n)>0 else '❌' if m+2*sd/math.sqrt(n)<0 else '~'}"
for lb in (7,28):
    for absf in (False,True):
        W=run(lb,absf); B=[w for w in W if w['yr']<=2025]; H=[w for w in W if w['yr']==2026]
        lab=f"top3 by {lb:2}d return{' + cash filter' if absf else ''}"
        print(f"{lab:34} BUILD {stats([w['r'] for w in B])} | {alpha(B)}")
        print(f"{'':34} 2026  {stats([w['r'] for w in H])} | {alpha(H)}")
W=run(28,False)
print(f"\n{'Equal-weight all coins':34} BUILD {stats([w['ew'] for w in W if w['yr']<=2025])}\n{'':34} 2026  {stats([w['ew'] for w in W if w['yr']==2026])}")
print(f"{'BTC buy & hold':34} BUILD {stats([w['btc'] for w in W if w['yr']<=2025])}\n{'':34} 2026  {stats([w['btc'] for w in W if w['yr']==2026])}")
