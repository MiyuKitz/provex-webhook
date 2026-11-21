import json,urllib.request,time
C="BTC ETH SOL SUI DOGE NEAR INJ 1000PEPE FLOKI ZRO XRP LINK AVAX ADA LTC BNB AAVE UNI ARB OP APT DOT SEI TIA WIF HBAR TRX BCH".split()
START=int(time.mktime((2024,1,1,0,0,0,0,0,0)))*1000; ms=3600000
for c in C:
    out={}; st=START; now=int(time.time()*1000)
    while st<now:
        en=min(now,st+990*ms)
        for k in range(4):
            try:
                d=json.load(urllib.request.urlopen(f"https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol={c}-USDT&interval=1h&startTime={st}&endTime={en}&limit=1000",timeout=20))['data']; break
            except Exception: time.sleep(2); d=[]
        for x in d: out[int(x['time'])]=x
        st=en
    json.dump([out[k] for k in sorted(out)],open(f"/home/claude/hist1h/{c}-USDT_1h.json","w")); print(c,len(out),flush=True)
