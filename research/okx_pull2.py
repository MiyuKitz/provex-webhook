import json,urllib.request,time,sys,os
sym=sys.argv[1]; stop=int(time.mktime(time.strptime("2023-05-01","%Y-%m-%d"))*1000)
part=f"part_{sym}.json"
out={int(k):v for k,v in json.load(open(part)).items()} if os.path.exists(part) else {}
after=min(out) if out else int(time.time()*1000)
t0=time.time()
while time.time()-t0<250:
    url=f"https://www.okx.com/api/v5/market/history-candles?instId={sym}-USDT-SWAP&bar=15m&limit=100&after={after}"
    try: r=json.load(urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"}),timeout=15))
    except Exception: time.sleep(1); continue
    d=r.get('data') or []
    if r.get('code')!='0': time.sleep(1); continue
    if not d: after=None; break
    for c in d: out[int(c[0])]=c
    after=min(int(c[0]) for c in d)
    if after<stop: after=None; break
    time.sleep(0.1)
json.dump({str(k):v for k,v in out.items()},open(part,"w"))
done = after is None
if done:
    rows=[dict(time=k,open=out[k][1],high=out[k][2],low=out[k][3],close=out[k][4],volume=out[k][5]) for k in sorted(out) if out[k][8]=="1"]
    json.dump(rows,open(f"okx_{sym}_15m.json","w"))
print(sym,len(out),"DONE" if done else "partial",time.strftime('%Y-%m-%d',time.gmtime(min(out)/1000)))
