"""Pre-registered funding-extreme test. Daily at 00:00 UTC per coin:
 f3 = mean funding over last 72h; z = (f3 - mean)/std over trailing 90 days (no lookahead).
 z >= +2 (crowded longs)  -> SHORT 3 days; z <= -2 (crowded shorts) -> LONG 3 days.
 Variant B (absolute): f3 >= 0.05%/8h -> short; f3 <= -0.01%/8h -> long.
 PnL = price move over 3 days + funding carry (short receives funding, long pays) - 0.1% fees.
 Build 2022-25, holdout 2026."""
import json,math
from datetime import datetime,timezone
coins=["BTC","ETH","SOL","SUI","BNB","XRP","DOGE","ADA","AVAX","LINK","DOT","LTC","NEAR","APT","ARB","OP","INJ","TIA"]
D=86400000;H=3600000
def st(rs):
    n=len(rs)
    if n<10: return f"n={n}"
    m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1)); se=2*sd/math.sqrt(n)
    return f"n={n:4} win={sum(r>0 for r in rs)/n*100:3.0f}% avg {m*100:+.2f}%/trade ±{se*100:.2f} {'✅' if m-se>0 else '❌' if m+se<0 else '~'}"
res={"Z":[], "ABS":[]}
for c in coins:
    F={int(k):v for k,v in json.load(open(f"fund_{c}.json")).items()}; ft=sorted(F)
    px={int(x['time'])+4*H:float(x['close']) for x in json.load(open(f"bx4h_{c}.json")) if (int(x['time'])+4*H)%D==0}
    days=sorted(px); hist=[]; busy=0
    for d in days:
        win=[F[t] for t in ft if d-72*H<t<=d]
        if not win: continue
        f3=sum(win)/len(win); hist.append((d,f3))
        past=[v for t,v in hist if d-90*D<=t<d]
        if len(past)<60 or d<busy or d+3*D not in px: continue
        m=sum(past)/len(past); sd=math.sqrt(sum((v-m)**2 for v in past)/len(past)) or 1e-9
        z=(f3-m)/sd
        carry=sum(F[t] for t in ft if d<t<=d+3*D)
        move=px[d+3*D]/px[d]-1
        yr=datetime.fromtimestamp(d/1000,timezone.utc).year
        for V,side in (("Z","Short" if z>=2 else "Long" if z<=-2 else None),
                       ("ABS","Short" if f3>=0.0005 else "Long" if f3<=-0.0001 else None)):
            if not side: continue
            r=(-move+carry) if side=="Short" else (move-carry)
            res[V].append(dict(r=r-0.001,side=side,yr=yr,c=c))
        if z>=2 or z<=-2: busy=d+3*D
for V,T in res.items():
    print(f"\n{V}: BUILD 2022-25 {st([t['r'] for t in T if t['yr']<=2025])} | 2026 {st([t['r'] for t in T if t['yr']==2026])}")
    for s in ("Long","Short"): print(f"   {s:5} build {st([t['r'] for t in T if t['side']==s and t['yr']<=2025])} | 2026 {st([t['r'] for t in T if t['side']==s and t['yr']==2026])}")
