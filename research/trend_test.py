import json,math
from datetime import datetime,timezone
from v19_backtest import load,ema
from tf_test import agg,st
H=3600000; P=5
def run(sym,variant):
    b=agg(load(sym),4*H); c=[x['c'] for x in b]; e20,e50=ema(c,20),ema(c,50)
    lh=ph=ll=pl=None; lhi=lli=None; T=[]; busy=-1
    for i in range(60,len(b)-1):
        k=i-P
        if all(b[k]['h']>b[k+d]['h'] for d in range(-P,P+1) if d): ph,lh=lh,b[k]['h']; lhi=k
        if all(b[k]['l']<b[k+d]['l'] for d in range(-P,P+1) if d): pl,ll=ll,b[k]['l']; lli=k
        if None in (lh,ph,ll,pl) or i<=busy: continue
        up = lh>ph and ll>pl and e20[i]>e50[i]
        dn = lh<ph and ll<pl and e20[i]<e50[i]
        x=b[i]; side=None
        if variant=="pullback":
            if up and x['l']<=e20[i] and x['c']>e20[i] and x['c']>x['o']: side="Long"; stop=ll*0.998
            if dn and x['h']>=e20[i] and x['c']<e20[i] and x['c']<x['o']: side="Short"; stop=lh*1.002
        else:  # breakout of last swing extreme in trend direction
            if up and x['c']>lh and b[i-1]['c']<=lh: side="Long"; stop=ll*0.998
            if dn and x['c']<ll and b[i-1]['c']>=ll: side="Short"; stop=lh*1.002
        if not side: continue
        entry=x['c']; risk=abs(entry-stop)
        if risk/entry<0.02 or risk/entry>0.15: continue
        s=stop; R=None; end=i
        for j in range(i+1,min(i+181,len(b))):
            y=b[j]; end=j
            if (side=="Long" and y['l']<=s) or (side=="Short" and y['h']>=s):
                R=((s-entry) if side=="Long" else (entry-s))/risk; break
            kk=j-P
            if kk>i:
                if side=="Long" and all(b[kk]['l']<b[kk+d]['l'] for d in range(-P,P+1) if d) and b[kk]['l']>s: s=b[kk]['l']*0.998
                if side=="Short" and all(b[kk]['h']>b[kk+d]['h'] for d in range(-P,P+1) if d) and b[kk]['h']<s: s=b[kk]['h']*1.002
        if R is None: R=((b[end]['c']-entry) if side=="Long" else (entry-b[end]['c']))/risk
        R-=0.001*entry/risk
        T.append(dict(R=R,side=side,yr=datetime.fromtimestamp(x['t']/1000,timezone.utc).year,sym=sym,bars=end-i))
        busy=end
    return T
for v in ("pullback","breakout"):
    T=[]
    for s in ["SUI","ETH","SOL","BTC"]: T+=run(s,v)
    tr=[t for t in T if t['yr']<=2025]
    print(f"\n{v.upper()}  BUILD 2023-25: {st([t['R'] for t in tr])}  avg hold {sum(t['bars'] for t in tr)/max(1,len(tr))*4/24:.1f} days")
    for side in ("Long","Short"): print(f"   {side:5}", st([t['R'] for t in tr if t['side']==side]))
    for s in ["SUI","ETH","SOL","BTC"]: print(f"   {s}  ", st([t['R'] for t in tr if t['sym']==s]))
    rs=sorted([t['R'] for t in tr],reverse=True); print("   top 5 trades:",[round(r,1) for r in rs[:5]], "| share of profit from top 10%:", round(sum(rs[:max(1,len(rs)//10)])/max(1e-9,sum(r for r in rs if r>0)),2))
