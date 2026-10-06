"""Pre-registered 'Aggro v2' test — Krysie's style, WITH the trend:
 4H trend (EMA20 vs EMA50 + HH/HL or LH/LL structure) decides direction, longs only in uptrend, shorts only in downtrend.
 1H: close breaks the last confirmed swing high (long) -> armed for 24 bars; retest = a bar touches the level (+-0.3%)
 and closes back on the breakout side -> enter at close. Stop just beyond the retest wick (0.3%-5% else skip).
 Exit: 40% at 1R, stop -> breakeven, remaining 60% trails under each new confirmed 1H swing low (max 10 days). Fees 0.1%."""
import json,math
from datetime import datetime,timezone
def load(c,iv): return [dict(t=int(x['time']),o=float(x['open']),h=float(x['high']),l=float(x['low']),c=float(x['close'])) for x in json.load(open(f"{c}-USDT_{iv}.json"))]
def ema(v,n):
    a=2/(n+1);o=[v[0]]
    for x in v[1:]: o.append(o[-1]+a*(x-o[-1]))
    return o
P=3
def piv(b):
    H=[False]*len(b);L=[False]*len(b)
    for k in range(P,len(b)-P):
        H[k]=all(b[k]['h']>b[k+d]['h'] for d in range(-P,P+1) if d); L[k]=all(b[k]['l']<b[k+d]['l'] for d in range(-P,P+1) if d)
    return H,L
def trend4h(b4):
    c=[x['c'] for x in b4];e20,e50=ema(c,20),ema(c,50);H,L=piv(b4);out={};lh=ph=ll=pl=None
    for i in range(len(b4)):
        k=i-P
        if k>=P and H[k]: ph,lh=lh,b4[k]['h']
        if k>=P and L[k]: pl,ll=ll,b4[k]['l']
        up= e20[i]>e50[i] and None not in(lh,ph,ll,pl) and lh>ph and ll>pl
        dn= e20[i]<e50[i] and None not in(lh,ph,ll,pl) and lh<ph and ll<pl
        out[b4[i]['t']+4*3600000]="up" if up else "down" if dn else "none"   # known at 4h bar close
    return out
res=[]
for coin in ["SUI","ETH","BTC"]:
    b=load(coin,"1h"); b4=load(coin,"4h"); tr=trend4h(b4); H,L=piv(b)
    sh=sl=None; armed=None; busy=-1; t4=None
    for i in range(10,len(b)-1):
        k=i-P
        if H[k]: sh=b[k]['h']
        if L[k]: sl=b[k]['l']
        t=b[i]['t']+3600000; key=t//14400000*14400000
        if key in tr: t4=tr[key]
        if i<=busy or t4 is None: continue
        x=b[i]
        if t4=="up" and sh and x['c']>sh and b[i-1]['c']<=sh: armed=("Long",sh,i); sh=None; continue
        if t4=="down" and sl and x['c']<sl and b[i-1]['c']>=sl: armed=("Short",sl,i); sl=None; continue
        if not armed: continue
        side,lv,st=armed
        if i-st>24 or (side=="Long" and t4!="up") or (side=="Short" and t4!="down"): armed=None; continue
        if side=="Long":
            if x['c']<lv*0.99: armed=None; continue
            if not(x['l']<=lv*1.003 and x['c']>lv): continue
            stop=x['l']*0.999
        else:
            if x['c']>lv*1.01: armed=None; continue
            if not(x['h']>=lv*0.997 and x['c']<lv): continue
            stop=x['h']*1.001
        armed=None; entry=x['c']; d=abs(entry-stop)/entry
        if d<0.003 or d>0.05: continue
        sg=1 if side=="Long" else -1; R=abs(entry-stop); s=stop; tp1=entry+sg*R; part=0; got=0
        for j in range(i+1,min(i+241,len(b))):
            y=b[j]
            hit= y['l']<=s if side=="Long" else y['h']>=s
            if not part and not hit and (y['h']>=tp1 if side=="Long" else y['l']<=tp1): part=1; got+=0.4*1; s=entry
            if hit: got+=(1-0.4*part)*sg*(s-entry)/R; break
            kk=j-P
            if part and kk>i:
                if side=="Long" and L[kk] and b[kk]['l']>s: s=b[kk]['l']*0.999
                if side=="Short" and H[kk] and b[kk]['h']<s: s=b[kk]['h']*1.001
        else: got+=(1-0.4*part)*sg*(b[j]['c']-entry)/R
        got-=0.001/d
        res.append(dict(R=got,side=side,coin=coin,yr=datetime.fromtimestamp(x['t']/1000,timezone.utc).year,d=d))
        busy=j
def st(rs):
    n=len(rs)
    if n<10: return f"n={n}"
    m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1)); se=2*sd/math.sqrt(n)
    return f"n={n:3} win={sum(r>0 for r in rs)/n*100:3.0f}% avg {m:+.3f}R ±{se:.3f} {'✅' if m-se>0 else '❌' if m+se<0 else '~'}"
print("ALL (Apr 2024-now):", st([r['R'] for r in res]), f"| median stop {sorted(r['d'] for r in res)[len(res)//2]*100:.2f}%")
for s in ("Long","Short"): print(f"  {s:5}", st([r['R'] for r in res if r['side']==s]))
for c in ("SUI","ETH","BTC"): print(f"  {c}  ", st([r['R'] for r in res if r['coin']==c]))
for y in (2024,2025,2026): print(f"  {y} ", st([r['R'] for r in res if r['yr']==y]))
rs=sorted([r['R'] for r in res],reverse=True); print("  biggest wins:",[round(x,1) for x in rs[:6]])
