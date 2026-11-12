import json,urllib.request,time,sys
C="BTC ETH SOL SUI DOGE NEAR INJ 1000PEPE FLOKI ZRO XRP LINK AVAX ADA LTC BNB AAVE UNI ARB OP APT DOT SEI TIA WIF HBAR TRX BCH".split()
START=int(time.mktime((2023,7,1,0,0,0,0,0,0)))*1000
def get(sym,iv,st,en):
    u=f"https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol={sym}-USDT&interval={iv}&startTime={st}&endTime={en}&limit=1000"
    for k in range(4):
        try: return json.load(urllib.request.urlopen(u,timeout=20))['data']
        except Exception as e: time.sleep(2)
    return []
for c in C:
    for iv,ms in (("4h",14400000),("1d",86400000)):
        out={}; st=START; now=int(time.time()*1000)
        while st<now:
            en=min(now,st+990*ms); d=get(c,iv,st,en)
            for x in d: out[int(x['time'])]=x
            st=en
        rows=[out[k] for k in sorted(out)]
        json.dump(rows,open(f"/home/claude/hist/{c}-USDT_{iv}.json","w")); print(c,iv,len(rows),flush=True)
