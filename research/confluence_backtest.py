import json,math,sys
from datetime import datetime,timezone
from detectors import Engine,pivots,P
sys.path.insert(0,'/home/claude/hist')
def load(c,iv): return [dict(t=int(x['time']),o=float(x['open']),h=float(x['high']),l=float(x['low']),c=float(x['close']),v=float(x.get('volume',0))) for x in json.load(open(f"/home/claude/hist/{c}-USDT_{iv}.json"))]
def ema(v,n):
    a=2/(n+1);o=[v[0]]
    for x in v[1:]: o.append(o[-1]+a*(x-o[-1]))
    return o
def trend4h(b4):
    c=[x['c'] for x in b4];e20,e50=ema(c,20),ema(c,50);H,L=pivots(b4);out={};lh=ph=ll=pl=None
    for i in range(len(b4)):
        k=i-P
        if k>=P and H[k]: ph,lh=lh,b4[k]['h']
        if k>=P and L[k]: pl,ll=ll,b4[k]['l']
        ok=None not in(lh,ph,ll,pl)
        out[b4[i]['t']+4*3600000]="up" if ok and e20[i]>e50[i] and lh>ph and ll>pl else "down" if ok and e20[i]<e50[i] and lh<ph and ll<pl else "none"
    return out
BTC={int(k):v for k,v in json.load(open("/home/claude/hist/daily_BTC-USDT.json")).items()}; bd=sorted(BTC)
def bull(t):
    import bisect
    j=bisect.bisect_right(bd,t)-1
    return j>=28 and BTC[bd[j]]/BTC[bd[j-28]]-1>0
NAMES=['sr','zone','structure','retest','reversal','trendline','fib','consolidation','volume','crt']
trades=[]
for coin in ["SUI","ETH","BTC"]:
    b=load(coin,"1h"); b4=load(coin,"4h"); tr=trend4h(b4); H,L=pivots(b); E=Engine(b); t4=None; busy=-1
    for i in range(30,len(b)-1):
        E.update(i)
        key=(b[i]['t']+3600000)//14400000*14400000
        if key in tr: t4=tr[key]
        if t4 is None: continue
        sig,trig=E.signals(i,t4)
        if i<=busy or not trig: continue
        isbull=bull(b[i]['t'])
        best=None
        for d in ('L','S'):
            if d=='S' and isbull: continue          # Krysie's rule: no shorts in a bull market
            tg=[t for t in trig if t[1]==d]
            if not tg: continue
            score=sum(1 for n in NAMES if sig[n]==d)
            entry=b[i]['c']
            stops=[(t[2]*(0.999 if d=='L' else 1.001)) for t in tg]
            stops=[s_ for s_ in stops if 0.003<=abs(entry-s_)/entry<=0.05 and ((s_<entry) if d=='L' else (s_>entry))]
            if not stops: continue
            stop=max(stops) if d=='L' else min(stops)   # tightest valid stop
            if not best or score>best[1]: best=(d,score,stop,[t[0] for t in tg],[n for n in NAMES if sig[n]==d],sig['trend4h']==d)
        if not best: continue
        d,score,stop,tnames,agree,withtrend=best
        entry=b[i]['c']; R=abs(entry-stop); sg=1 if d=='L' else -1; s=stop; part=0; got=0; tp1=entry+sg*R
        for j in range(i+1,min(i+241,len(b))):
            y=b[j]; hit= y['l']<=s if d=='L' else y['h']>=s
            if not part and not hit and (y['h']>=tp1 if d=='L' else y['l']<=tp1): part=1; got+=0.4; s=entry
            if hit: got+=(1-0.4*part)*sg*(s-entry)/R; break
            kk=j-P
            if part and kk>i:
                if d=='L' and L[kk] and b[kk]['l']>s: s=b[kk]['l']*0.999
                if d=='S' and H[kk] and b[kk]['h']<s: s=b[kk]['h']*1.001
        else: got+=(1-0.4*part)*sg*(b[j]['c']-entry)/R
        got-=0.001*entry/R
        trades.append(dict(R=got,d=d,score=score,agree=agree,trig=tnames,withtrend=withtrend,coin=coin,yr=datetime.fromtimestamp(b[i]['t']/1000,timezone.utc).year))
        busy=j
json.dump(trades,open("conf_trades.json","w"))
def st(rs):
    n=len(rs)
    if n<10: return f"n={n}"
    m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1)); se=2*sd/math.sqrt(n)
    return f"n={n:4} win={sum(r>0 for r in rs)/n*100:3.0f}% {m:+.3f}R ±{se:.3f} {'✅' if m-se>0 else '❌' if m+se<0 else '~'}"
print("ALL:",st([t['R'] for t in trades]))
for k in range(1,7):
    sel=[t['R'] for t in trades if (t['score']==k if k<6 else t['score']>=6)]
    print(f" confluence {k}{'+' if k==6 else ' '}:",st(sel))
print(" score>=3 & with 4H trend:",st([t['R'] for t in trades if t['score']>=3 and t['withtrend']]))
print(" score>=4 & with 4H trend:",st([t['R'] for t in trades if t['score']>=4 and t['withtrend']]))
for d in ('L','S'): print(f" {d}:",st([t['R'] for t in trades if t['d']==d]))
print("by detector present (agreeing):")
for n in NAMES: print(f"   {n:13}",st([t['R'] for t in trades if n in t['agree']]))
