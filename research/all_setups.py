import json,math
from collections import defaultdict
P=3; FEE=0.001; MAXH=120
def load(f): return [dict(t=int(c['time']),o=float(c['open']),h=float(c['high']),l=float(c['low']),c=float(c['close']),v=float(c['volume'])) for c in json.load(open(f))]
def ema(v,n):
    a=2/(n+1);o=[v[0]]
    for x in v[1:]: o.append(o[-1]+a*(x-o[-1]))
    return o
def adx(b,n=14):
    L=len(b);tr=[0]*L;pd=[0]*L;nd=[0]*L
    for i in range(1,L):
        h,l,pc=b[i]['h'],b[i]['l'],b[i-1]['c']; tr[i]=max(h-l,abs(h-pc),abs(l-pc))
        up=h-b[i-1]['h'];dn=b[i-1]['l']-l
        pd[i]=up if up>dn and up>0 else 0; nd[i]=dn if dn>up and dn>0 else 0
    A=[None]*L;T=sum(tr[1:n+1]);Pp=sum(pd[1:n+1]);Nn=sum(nd[1:n+1]);dxs=[]
    for i in range(n+1,L):
        T=T-T/n+tr[i];Pp=Pp-Pp/n+pd[i];Nn=Nn-Nn/n+nd[i]
        pi,ni=100*Pp/T,100*Nn/T; dx=100*abs(pi-ni)/(pi+ni) if pi+ni else 0; dxs.append(dx)
        if len(dxs)==n: a=sum(dxs)/n; A[i]=a
        elif len(dxs)>n: a=(a*(n-1)+dx)/n; A[i]=a
    return A
def regime(b):
    c=[x['c'] for x in b];e50,e200=ema(c,50),ema(c,200);A=adx(b)
    return ["up" if A[i] and A[i]>=25 and c[i]>e50[i]>e200[i] else "down" if A[i] and A[i]>=25 and c[i]<e50[i]<e200[i] else "range" for i in range(len(b))]
def pivots(b):
    H=[False]*len(b);Lw=[False]*len(b)
    for k in range(P,len(b)-P):
        H[k]=all(b[k]['h']>b[k+d]['h'] for d in range(-P,P+1) if d)
        Lw[k]=all(b[k]['l']<b[k+d]['l'] for d in range(-P,P+1) if d)
    return H,Lw
def simulate(b,i,side,stop,H,Lw,mode):
    entry=b[i]['c'];risk=abs(entry-stop)
    if risk/entry<0.004 or risk/entry>0.08: return None
    tp=entry+2*risk if side=="long" else entry-2*risk; s=stop
    for j in range(i+1,min(i+1+MAXH,len(b))):
        y=b[j]
        if side=="long":
            if y['l']<=s: return (s-entry)/risk-FEE*entry/risk
            if mode=="fixed2R" and y['h']>=tp: return 2-FEE*entry/risk
            k=j-P  # trail to newly confirmed swing low
            if mode=="trail" and k>i and Lw[k] and b[k]['l']>s: s=b[k]['l']*0.999
        else:
            if y['h']>=s: return (entry-s)/risk-FEE*entry/risk
            if mode=="fixed2R" and y['l']<=tp: return 2-FEE*entry/risk
            k=j-P
            if mode=="trail" and k>i and H[k] and b[k]['h']<s: s=b[k]['h']*1.001
    y=b[min(i+MAXH,len(b)-1)]['c']
    return ((y-entry) if side=="long" else (entry-y))/risk-FEE*entry/risk
def signals(b,H,Lw):
    out=[]; sh=[];sl=[]; armed=[]  # armed breakouts: (level, side, start, invalid)
    for i in range(2*P+2,len(b)-1):
        k=i-P
        if H[k]: sh.append(k)
        if Lw[k]: sl.append(k)
        x=b[i]
        # --- Setup 3: failed high/low (SFP) ---
        if sh and i-sh[-1]<=60 and x['h']>b[sh[-1]]['h'] and x['c']<b[sh[-1]]['h']:
            out.append(("FailedHL",i,"short",x['h']*1.001)); sh.pop()
        if sl and i-sl[-1]<=60 and x['l']<b[sl[-1]]['l'] and x['c']>b[sl[-1]]['l']:
            out.append(("FailedHL",i,"long",x['l']*0.999)); sl.pop()
        # --- Setup 1: break & retest ---
        if sh and x['c']>b[sh[-1]]['h'] and b[i-1]['c']<=b[sh[-1]]['h']: armed.append([b[sh[-1]]['h'],"long",i])
        if sl and x['c']<b[sl[-1]]['l'] and b[i-1]['c']>=b[sl[-1]]['l']: armed.append([b[sl[-1]]['l'],"short",i])
        keep=[]
        for lv,side,st in armed:
            if i-st>30 or i==st: keep.append([lv,side,st]) if i==st else None; continue
            if side=="long":
                if x['c']<lv*0.99: continue
                if x['l']<=lv*1.003 and x['c']>lv: out.append(("BreakRetest",i,"long",x['l']*0.999)); continue
            else:
                if x['c']>lv*1.01: continue
                if x['h']>=lv*0.997 and x['c']<lv: out.append(("BreakRetest",i,"short",x['h']*1.001)); continue
            keep.append([lv,side,st])
        armed=keep
        # --- Setup 2: trend pullback (HH+HL, pullback to 50-61.8%) ---
        if len(sh)>=2 and len(sl)>=2:
            if b[sh[-1]]['h']>b[sh[-2]]['h'] and b[sl[-1]]['l']>b[sl[-2]]['l'] and sh[-1]>sl[-1]:
                lo,hi=b[sl[-1]]['l'],b[sh[-1]]['h']; f50=hi-0.5*(hi-lo); f618=hi-0.618*(hi-lo)
                if x['l']<=f50 and x['c']>=f618 and x['c']>x['o'] and x['c']<hi:
                    out.append(("TrendPullback",i,"long",lo*0.999)); sh.append(sh[-1])  # one per impulse
            if b[sh[-1]]['h']<b[sh[-2]]['h'] and b[sl[-1]]['l']<b[sl[-2]]['l'] and sl[-1]>sh[-1]:
                lo,hi=b[sl[-1]]['l'],b[sh[-1]]['h']; f50=lo+0.5*(hi-lo); f618=lo+0.618*(hi-lo)
                if x['h']>=f50 and x['c']<=f618 and x['c']<x['o'] and x['c']>lo:
                    out.append(("TrendPullback",i,"short",hi*1.001)); sl.append(sl[-1])
    return out
R=defaultdict(list)
for sym in ["SUI-USDT","ETH-USDT","BTC-USDT"]:
    b=load(f"{sym}_4h.json"); H,Lw=pivots(b); rg=regime(b)
    for name,i,side,stop in signals(b,H,Lw):
        if i<200: continue
        mk = rg[i]
        rel = "range" if mk=="range" else ("with" if (mk=="up")==(side=="long") else "against")
        for mode in ("fixed2R","trail"):
            r=simulate(b,i,side,stop,H,Lw,mode)
            if r is None: continue
            R[(name,mode,mk,side)].append(r); R[(name,mode,"ALL","")].append(r); R[(name,mode,rel,"rel")].append(r); R[(name,mode,sym,"sym")].append(r)
def st(rs):
    n=len(rs)
    if n<8: return f"n={n:4}"
    m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1)); se=2*sd/math.sqrt(n)
    tag="✅" if m-se>0 else "❌" if m+se<0 else "~"
    return f"n={n:4} win={sum(r>0 for r in rs)/n*100:3.0f}% {m:+.2f}R ±{se:.2f} {tag}"
for name in ["BreakRetest","TrendPullback","FailedHL"]:
    for mode in ("fixed2R","trail"):
        print(f"\n== {name} | exit={mode}")
        print(f"   ALL                 {st(R[(name,mode,'ALL','')])}")
        for mk,sd in [("up","long"),("up","short"),("down","short"),("down","long"),("range","long"),("range","short")]:
            print(f"   {mk:5} {sd:5}         {st(R[(name,mode,mk,sd)])}")
        print("   coins: "+" | ".join(f"{s[:3]} {(sum(R[(name,mode,s,'sym')])/max(1,len(R[(name,mode,s,'sym')]))):+.2f}R" for s in ["SUI-USDT","ETH-USDT","BTC-USDT"]))
