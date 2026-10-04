import json,re
from datetime import datetime
from pine_port import load, v14_signals
S=json.load(open('/home/claude/data/s6.json'))['signals']
real=[x for x in S if x.get('type') in ('OB_LONG','OB_SHORT')]
zone=lambda z:(lambda a:(min(a),max(a)))([float(v) for v in re.findall(r'[\d.]+',z)])
tot=hit=zh=0;det=dm=0
for sym in ["SUI","ETH","SOL"]:
    b=load(f"recent_{sym}.json"); sig=v14_signals(b)
    rs=[x for x in real if x['symbol']==sym+"USDT"]
    t0=min(datetime.fromisoformat(x['loggedAt'].replace('Z','+00:00')).timestamp() for x in rs)*1000
    bt={}
    for s in sig: bt.setdefault((s['t'],s['side']),[]).append(s)
    ds=[s for s in sig if s['t']>=t0]; det+=len(ds); m=set()
    for x in rs:
        tb=int(datetime.fromisoformat(x['loggedAt'].replace('Z','+00:00')).timestamp()*1000)//900000*900000-900000
        zl,zhh=zone(x['entryZone']);tot+=1;g=gz=False
        for s in bt.get((tb,x['direction']),[]):
            g=True;m.add(id(s))
            if abs(s['bot']-zl)/zl<0.003 and abs(s['top']-zhh)/zhh<0.003: gz=True
        hit+=g;zh+=gz
    dm+=len(m)
    print(sym, "real",len(rs))
print(f"exact-bar reproduced: {hit}/{tot} ({hit/tot*100:.0f}%) | same zone (±0.3%): {zh/tot*100:.0f}% | port fired {det}, matched {dm} ({dm/max(1,det)*100:.0f}%)")
