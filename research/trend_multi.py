import json,math
from datetime import datetime,timezone
import trend_test as TT
from tf_test import st
def load4(sym):
    return [dict(t=int(c['time']),o=float(c['open']),h=float(c['high']),l=float(c['low']),c=float(c['close']),v=float(c['volume'])) for c in json.load(open(f"bx4h_{sym}.json"))]
TT.agg=lambda b,ms: b
coins=["SUI","ETH","SOL","BTC","BNB","XRP","DOGE","ADA","AVAX","LINK","DOT","LTC","NEAR","APT","ARB","OP","INJ","TIA"]
for v in ("pullback","breakout"):
    T=[]
    for s in coins:
        TT.load=lambda sym,s=s: load4(s)
        T+=TT.run(s,v)
    for side in ("Long","Short"):
        tr=[t['R'] for t in T if t['side']==side and t['yr']<=2025]; ho=[t['R'] for t in T if t['side']==side and t['yr']==2026]
        print(f"{v:9} {side:5} BUILD 2022-25 {st(tr)} | HOLDOUT 2026 {st(ho)}")
    L=[t for t in T if t['side']=="Long"]
    by={}
    for t in L: by.setdefault(t['yr'],[]).append(t['R'])
    print("   longs by year:", {y:round(sum(r)/len(r),2) for y,r in sorted(by.items())}, "| coins positive:", sum(1 for s in coins if (lambda r: r and sum(r)/len(r)>0)([t['R'] for t in L if t['sym']==s])),"/",len(coins))
