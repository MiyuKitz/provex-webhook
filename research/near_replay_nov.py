import json,urllib.request,datetime as D
U=D.timezone.utc; M=D.timezone(D.timedelta(hours=11))
def k(st,en):
    u=f"https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=NEAR-USDT&interval=5m&startTime={st}&endTime={en}&limit=1000"
    return json.load(urllib.request.urlopen(u,timeout=20))['data']
st=int(D.datetime(2026,11,9,19,0,tzinfo=U).timestamp()*1000); now=int(D.datetime.now(U).timestamp()*1000)
bars={}
while st<now:
    for x in k(st,min(now,st+990*300000)): bars[int(x['time'])]=x
    st+=990*300000
B=[dict(t=t,h=float(x['high']),l=float(x['low']),c=float(x['close'])) for t,x in sorted(bars.items())]
last=B[-1]; print("data to",D.datetime.fromtimestamp(last['t']/1000,M).strftime('%m-%d %H:%M Melb'),"last",last['c'])
T=[("NEAR #1",D.datetime(2026,11,10,7,4,tzinfo=M),D.datetime(2026,11,11,1,36,tzinfo=M),3.609,9978.88,-220.22),
   ("NEAR #2",D.datetime(2026,11,11,3,4,tzinfo=M),D.datetime(2026,11,11,22,59,tzinfo=M),3.562,3693.79,-217.37)]
for name,o,c,e,notional,real in T:
    q=notional/e; seg=[b for b in B if b['t']>=o.timestamp()*1000-300000]
    hi=max(seg,key=lambda b:b['h']); lo=min(seg,key=lambda b:b['l'])
    pre=[b for b in seg if b['t']<=c.timestamp()*1000]; post=[b for b in seg if b['t']>c.timestamp()*1000]
    hipre=max(pre,key=lambda b:b['h']); lopre=min(pre,key=lambda b:b['l'])
    f=lambda b:D.datetime.fromtimestamp(b['t']/1000,M).strftime('%m-%d %H:%M')
    print(f"\n{name}: short {q:,.0f} NEAR @ {e} (notional {notional:,.0f}), real result {real}")
    print(f"  while open: best {lopre['l']} at {f(lopre)} = {q*(e-lopre['l']):+.0f} | worst {hipre['h']} at {f(hipre)} = {q*(e-hipre['h']):+.0f}")
    print(f"  if held to now: worst {hi['h']} at {f(hi)} = {q*(e-hi['h']):+.0f} ({(hi['h']/e-1)*100:+.1f}% against) | best {lo['l']} at {f(lo)} = {q*(e-lo['l']):+.0f} | now {last['c']} = {q*(e-last['c']):+.0f}")
# combined worst moment if both held
both=[b for b in B if b['t']>=T[1][1].timestamp()*1000]
w=max(both,key=lambda b:b['h']); q1=T[0][4]/T[0][3]; q2=T[1][4]/T[1][3]
print(f"\nboth held, worst moment {D.datetime.fromtimestamp(w['t']/1000,M).strftime('%m-%d %H:%M')} @ {w['h']}: {q1*(T[0][3]-w['h'])+q2*(T[1][3]-w['h']):+.0f}")
