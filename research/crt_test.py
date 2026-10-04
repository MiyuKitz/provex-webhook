"""Pre-registered CRT test (images: 9AM model bullish / 1AM bearish), NY time.
Bullish: 05:00 NY 4H candle = range; 09:00 candle sweeps its low and closes back inside; PDL raided.
Bearish: 21:00 NY candle = range; 01:00 candle sweeps its high and closes back inside; PDH raided.
Entry at purge close, stop beyond purge wick, TP1 = 50% of range, TP2 = opposite end (50/50).
'Key level' is subjective and skipped."""
import json,math
from datetime import datetime,timezone,timedelta
from zoneinfo import ZoneInfo
NY=ZoneInfo("America/New_York")
def load(sym): return [dict(t=int(c['time']),o=float(c['open']),h=float(c['high']),l=float(c['low']),c=float(c['close'])) for c in json.load(open(f"okx_{sym}_15m.json"))]
def build(b):
    c4={}; day={}
    for i,x in enumerate(b):
        d=datetime.fromtimestamp(x['t']/1000,timezone.utc).astimezone(NY)
        dk=d.date(); D=day.setdefault(dk,[x['h'],x['l']]); D[0]=max(D[0],x['h']); D[1]=min(D[1],x['l'])
        hb=((d.hour-1)//4)*4+1
        start=(d.replace(minute=0,second=0,microsecond=0)-timedelta(hours=(d.hour-hb)%24)) if d.hour>=1 else (d-timedelta(days=1)).replace(hour=21,minute=0,second=0,microsecond=0)
        k=start.isoformat()
        if k not in c4: c4[k]=dict(start=start,o=x['o'],h=x['h'],l=x['l'],c=x['c'],last=i)
        else: C=c4[k]; C['h']=max(C['h'],x['h']); C['l']=min(C['l'],x['l']); C['c']=x['c']; C['last']=i
    return c4,day
def run(sym,need_raid=True):
    b=load(sym); c4,day=build(b); T=[]
    for k,C in c4.items():
        s=C['start']
        if s.hour==5: side="Long"; crt=C; purge=c4.get((s+timedelta(hours=4)).isoformat())
        elif s.hour==21: side="Short"; crt=C; purge=c4.get((s+timedelta(hours=4)).isoformat())
        else: continue
        if not purge or purge['start'].hour!=(9 if side=="Long" else 1): continue
        pd=day.get(purge['start'].date()-timedelta(days=1))
        if not pd: continue
        if side=="Long":
            ok = purge['l']<crt['l'] and crt['l']<purge['c']<crt['h'] and (not need_raid or min(crt['l'],purge['l'])<pd[1])
            entry=purge['c']; stop=purge['l']*0.9995; tp=[(crt['h']+crt['l'])/2, crt['h']]
            if not ok or entry>=tp[0]: continue
        else:
            ok = purge['h']>crt['h'] and crt['l']<purge['c']<crt['h'] and (not need_raid or max(crt['h'],purge['h'])>pd[0])
            entry=purge['c']; stop=purge['h']*1.0005; tp=[(crt['h']+crt['l'])/2, crt['l']]
            if not ok or entry<=tp[0]: continue
        risk=abs(entry-stop)
        if risk/entry<0.001: continue
        R=0; done=[0,0]; i0=purge['last']
        for j in range(i0+1,min(i0+97,len(b))):
            y=b[j]; hitS = y['l']<=stop if side=="Long" else y['h']>=stop
            for n in range(2):
                if not done[n] and not hitS and (y['h']>=tp[n] if side=="Long" else y['l']<=tp[n]): done[n]=1; R+=0.5*abs(tp[n]-entry)/risk
            if hitS: R-=0.5*(2-sum(done)); break
            if all(done): break
        else:
            lc=b[min(i0+96,len(b)-1)]['c']; R+=sum(0.5*((lc-entry) if side=="Long" else (entry-lc))/risk for n in range(2) if not done[n])
        R-=0.001*entry/risk
        T.append(dict(R=R,side=side,yr=s.year,sym=sym,riskpct=risk/entry*100))
    return T
def st(rs):
    n=len(rs)
    if n<10: return f"n={n}"
    m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1)); se=2*sd/math.sqrt(n)
    return f"n={n:4} win={sum(r>0 for r in rs)/n*100:3.0f}% {m:+.3f}R ±{se:.3f} {'✅' if m-se>0 else '❌' if m+se<0 else '~'}"
for raid in (True,False):
    T=[]
    for s in ["SUI","ETH","SOL","BTC"]: T+=run(s,raid)
    print(f"\nCRT {'WITH PDL/PDH raid' if raid else 'no raid requirement'}  (median stop {sorted(t['riskpct'] for t in T)[len(T)//2]:.2f}%)")
    print("  BUILD 2023-25", st([t['R'] for t in T if t['yr']<=2025]), "| 2026", st([t['R'] for t in T if t['yr']==2026]))
    for sd in ("Long","Short"): print(f"  {sd:5} build", st([t['R'] for t in T if t['side']==sd and t['yr']<=2025]))
    for s in ["SUI","ETH","SOL","BTC"]: print(f"  {s}   build", st([t['R'] for t in T if t['sym']==s and t['yr']<=2025]))
