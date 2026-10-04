"""Full v19 replica: v14 Pine signals + server scoring/gates + live 40/30/30 ladder."""
import json,math,sys
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
from pine_port import v14_signals
MEL=ZoneInfo("Australia/Melbourne"); CT={"SUI":1,"SOL":1,"ETH":0.1,"BTC":0.01}
def load(sym):
    k=json.load(open(f"okx_{sym}_15m.json"))
    return [dict(t=int(c['time']),o=float(c['open']),h=float(c['high']),l=float(c['low']),c=float(c['close']),v=float(c['volume'])*CT[sym]) for c in k]
def ema(v,n):
    a=2/(n+1);o=[v[0]]
    for x in v[1:]: o.append(o[-1]+a*(x-o[-1]))
    return o
def trend_series(bars,L=5):
    """Pine-style trend: HH+HL / LH+LL structure + EMA20/50, per bar (no lookahead)."""
    c=[b['c'] for b in bars]; ef,es=ema(c,20),ema(c,50); out=[]
    lh=ph=ll=pl=None
    for i in range(len(bars)):
        k=i-L
        if k>=L:
            if all(bars[k]['h']>bars[k+d]['h'] for d in range(-L,L+1) if d): ph,lh=lh,bars[k]['h']
            if all(bars[k]['l']<bars[k+d]['l'] for d in range(-L,L+1) if d): pl,ll=ll,bars[k]['l']
        sb = None not in (lh,ph,ll,pl) and lh>ph and ll>pl
        sd = None not in (lh,ph,ll,pl) and lh<ph and ll<pl
        mb,md = ef[i]>es[i], ef[i]<es[i]
        out.append("Bullish" if (sb and mb) else "Bearish" if (sd and md) else "Bullish" if (sb or mb) else "Bearish" if (sd or md) else "Neutral")
    return out
def agg4h(b):
    out=[];cur=None
    for x in b:
        t=x['t']//14400000*14400000
        if not cur or cur['t']!=t:
            if cur: out.append(cur)
            cur=dict(t=t,o=x['o'],h=x['h'],l=x['l'],c=x['c'],v=x['v'])
        else: cur['h']=max(cur['h'],x['h']);cur['l']=min(cur['l'],x['l']);cur['c']=x['c'];cur['v']+=x['v']
    out.append(cur); return out
def killzone(t):
    d=datetime.fromtimestamp((t+900000)/1000,timezone.utc).astimezone(MEL); m=d.hour*60+d.minute  # bar close time
    return 16*60+33<=m<=18*60+30 or m>=23*60 or m<=60
def adx_regime(b4):
    c=[x['c'] for x in b4];e50,e200=ema(c,50),ema(c,200);n=14;L=len(b4)
    tr=[0]*L;pd=[0]*L;nd=[0]*L
    for i in range(1,L):
        h,l,pc=b4[i]['h'],b4[i]['l'],b4[i-1]['c'];tr[i]=max(h-l,abs(h-pc),abs(l-pc))
        up=h-b4[i-1]['h'];dn=b4[i-1]['l']-l;pd[i]=up if up>dn and up>0 else 0;nd[i]=dn if dn>up and dn>0 else 0
    A=[None]*L;T=P=N=0;dx=[]
    for i in range(1,L):
        T=T-T/n+tr[i] if i>n else T+tr[i];P=P-P/n+pd[i] if i>n else P+pd[i];N=N-N/n+nd[i] if i>n else N+nd[i]
        if i>=n and T:
            pi,ni=P/T,N/T;dx.append(100*abs(pi-ni)/(pi+ni) if pi+ni else 0)
            A[i]=sum(dx[-n:])/min(len(dx),n)
    return ["up" if A[i] and A[i]>=25 and c[i]>e50[i]>e200[i] else "down" if A[i] and A[i]>=25 and c[i]<e50[i]<e200[i] else "range" for i in range(L)]
def run(sym, btc, btc_tr, delta_mode="window"):
    b=load(sym); idx={x['t']:i for i,x in enumerate(b)}
    b4=agg4h(b); htf=trend_series(b4); reg=adx_regime(b4)
    h4={x['t']:i for i,x in enumerate(b4)}
    # running delta
    dlt=[0.0]*len(b); s=0.0; W=5000; q=[]
    for i,x in enumerate(b):
        d=x['v'] if x['c']>x['o'] else -x['v'] if x['c']<x['o'] else 0
        q.append(d); s+=d
        if len(q)>W: s-=q.pop(0)
        dlt[i]=s
    bt_idx={x['t']:i for i,x in enumerate(btc)}
    trades=[]; busy={"Long":-1,"Short":-1}
    for sg in v14_signals(b):
        i=sg['i']; side=sg['side']
        if i<=busy[side]: continue
        t4=b[i]['t']//14400000*14400000-14400000      # last COMPLETED 4h bar
        if t4 not in h4: continue
        j4=h4[t4]; ht=htf[j4]
        bi=bt_idx.get(b[i]['t'])
        if bi is None: continue
        bt=btc_tr[bi]
        btc_opp=(side=="Short" and bt=="Bullish") or (side=="Long" and bt=="Bearish")
        if btc_opp: continue                                   # hard BTC gate
        kz=killzone(b[i]['t'])
        sweep = (sg['sh'] is not None and sg['sh']>sg['top']) if side=="Short" else (sg['sl'] is not None and sg['sl']<sg['bot'])
        if delta_mode=="window": dp = dlt[i]<-50000 if side=="Short" else dlt[i]>50000
        else: dp = delta_mode=="pass"
        mss = (side=="Short" and sg['mss']=="Down") or (side=="Long" and sg['mss']=="Up")
        btcs = 1 if ((side=="Short" and bt=="Bearish") or (side=="Long" and bt=="Bullish")) else 0.5 if bt=="Neutral" else 0
        score=sweep+dp+mss+btcs+1
        if score < (3.5 if kz else 4): continue
        htf_opp=(side=="Short" and ht=="Bullish") or (side=="Long" and ht=="Bearish")
        if ht in("Bullish","Bearish") and not htf_opp: continue  # v19: HTF-aligned blocked
        # levels (computeOBLevels)
        entry=(sg['top']+sg['bot'])/2; sgn=-1 if side=="Short" else 1
        sl=entry*(1-sgn*0.05); risk=abs(entry-sl)
        tps=[entry+sgn*risk*0.5, entry+sgn*risk*2, entry+sgn*risk*3]
        w=[0.4,0.3,0.3]; done=[False]*3; R=0.0; amb=False; end=i
        for j in range(i+1,min(i+193,len(b))):
            y=b[j]; end=j
            hitS = y['h']>=sl if side=="Short" else y['l']<=sl
            for k in range(3):
                if not done[k] and ((y['l']<=tps[k]) if side=="Short" else (y['h']>=tps[k])):
                    if hitS: amb=True
                    else: done[k]=True; R+=w[k]*[0.5,2,3][k]
            if hitS:
                R-=sum(w[k] for k in range(3) if not done[k]); break
            if all(done): break
        else:
            lc=b[end]['c']; R+=sum(w[k] for k in range(3) if not done[k])*sgn*(lc-entry)/risk
        R-=0.02
        busy[side]=end
        trades.append(dict(sym=sym,t=b[i]['t'],side=side,R=R,amb=amb,score=score,kz=kz,htf=ht,reg=reg[j4],
                           year=datetime.fromtimestamp(b[i]['t']/1000,timezone.utc).year))
    return trades
if __name__=="__main__":
    mode=sys.argv[1] if len(sys.argv)>1 else "window"
    btc=load("BTC"); btc_tr=trend_series(btc)
    allt=[]
    for sym in ["SUI","ETH","SOL"]:
        allt+=run(sym,btc,btc_tr,mode)
    json.dump(allt,open(f"v19_trades_{mode}.json","w"))
    print(mode,len(allt))
