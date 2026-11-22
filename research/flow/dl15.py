import json,urllib.request,time,sys
C="SUI BTC ETH SOL DOGE XRP LINK AVAX BNB ADA".split()
START=int(time.mktime((2025,11,1,0,0,0,0,0,0)))*1000; ms=900000
for c in C:
    out={}; st=START; now=int(time.time()*1000)
    while st<now:
        en=min(now,st+990*ms); d=[]
        for k in range(4):
            try: d=json.load(urllib.request.urlopen(f"https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol={c}-USDT&interval=15m&startTime={st}&endTime={en}&limit=1000",timeout=20))['data']; break
            except Exception: time.sleep(2)
        for x in d: out[int(x['time'])]=x
        st=en
    json.dump([out[k] for k in sorted(out)],open(f"/home/claude/hist15/{c}-USDT_15m.json","w")); print(c,len(out),flush=True)
