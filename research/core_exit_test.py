"""Pre-registered: Core exit variants on BTC+ETH daily (vol target 40%, fees 0.1%, funding 10%/yr on longs).
 A  current : in while 28d return > 0
 B1 swing   : also exit on a close below the last confirmed daily swing low (pivot 3); after such an exit,
              re-enter only on a close above the highest close of the prior 10 days (fresh breakout) with 28d > 0
 B2 20-day  : same, but the trail is the lowest low of the last 20 days
Reported for 2018-26, 2022-26 and the recent 2024-26 separately."""
import json,math
from datetime import datetime,timezone
P={a:{int(k):v for k,v in json.load(open(f"daily_{a}-USDT.json")).items()} for a in ("BTC","ETH")}
days=sorted(set(P["BTC"])&set(P["ETH"]))
def run(mode):
    st={a:{"in":False,"locked":False} for a in P}; w={a:0 for a in P}; out=[]
    for n in range(40,len(days)-1):
        d,nx=days[n],days[n+1]; nw={}
        for a in P:
            c=P[a]; px=c[d]; mom=px/c[days[n-28]]-1>0
            s=st[a]
            if not mom: s["in"]=False; s["locked"]=False
            else:
                if mode=="A": s["in"]=True
                else:
                    if mode=="B1":
                        lows=[c[days[k]] for k in range(n-30,n-2)]
                        piv=[c[days[k]] for k in range(n-30,n-3) if all(c[days[k]]<c[days[k+j]] for j in (-3,-2,-1,1,2,3))]
                        trail=piv[-1] if piv else None
                    else:
                        trail=min(c[days[k]] for k in range(n-20,n))
                    if s["in"] and trail and px<trail: s["in"]=False; s["locked"]=True
                    elif not s["in"]:
                        if not s["locked"]: s["in"]=True
                        elif px>max(c[days[k]] for k in range(n-10,n)): s["in"]=True; s["locked"]=False
            lr=[math.log(c[days[k]]/c[days[k-1]]) for k in range(n-19,n+1)]
            vol=math.sqrt(sum(x*x for x in lr)/20*365)
            nw[a]=(min(1,0.4/vol)/2) if s["in"] else 0
        cost=sum(abs(nw[a]-w[a]) for a in P)*0.001; w=nw
        out.append((nx,sum(w[a]*(P[a][nx]/P[a][d]-1) for a in P)-sum(x*0.10/365 for x in w.values())-cost))
    return out
def met(s,y0):
    rs=[r for t,r in s if datetime.fromtimestamp(t/1000,timezone.utc).year>=y0]
    n=len(rs);m=sum(rs)/n;sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1))
    eq=1;pk=1;dd=0
    for r in rs: eq*=1+r;pk=max(pk,eq);dd=min(dd,eq/pk-1)
    return f"{(eq**(365/n)-1)*100:+4.0f}%/yr Sh {m/sd*math.sqrt(365):.2f} DD {dd*100:4.0f}%"
for mode,lab in (("A","A  current 28d exit"),("B1","B1 swing-low trail"),("B2","B2 20-day-low trail")):
    s=run(mode); print(f"{lab:22} | 2018-26 {met(s,2018)} | 2022-26 {met(s,2022)} | 2024-26 {met(s,2024)}")
