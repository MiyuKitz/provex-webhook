"""Exact port of 'Claude Alerts v14 — Krysie 15M' OB + trigger logic."""
import json
def load(f):
    return [dict(t=int(c['time']),o=float(c['open']),h=float(c['high']),l=float(c['low']),c=float(c['close']),v=float(c['volume'])) for c in json.load(open(f))]
def v14_signals(b, obLen=5, swingLen=5, lookback=20):
    n=len(b); os_=0; prev_os=0
    obT=obB=pobT=pobB=None; mss="None"; lastSH=lastSL=None
    sig=[]
    for i in range(max(obLen,2*swingLen),n):
        x=b[i]
        # pivots (confirmed swingLen bars later), like ta.pivothigh/low
        k=i-swingLen
        if all(b[k]['h']>b[k+d]['h'] for d in range(-swingLen,swingLen+1) if d): lastSH=b[k]['h']
        if all(b[k]['l']<b[k+d]['l'] for d in range(-swingLen,swingLen+1) if d): lastSL=b[k]['l']
        upper=max(b[j]['h'] for j in range(i-obLen+1,i+1)); lower=min(b[j]['l'] for j in range(i-obLen+1,i+1))
        prev_os=os_
        os_ = 0 if b[i-obLen]['h']>upper else 1 if b[i-obLen]['l']<lower else os_
        if os_==1 and prev_os!=1:
            for j in range(1,lookback+1):
                y=b[i-j]
                if y['c']>y['o']: obT,obB=y['h'],y['l']; break
            else:
                m=b[i-1]
                for j in range(1,obLen):
                    if b[i-j]['h']>m['h']: m=b[i-j]
                obT,obB=m['h'],m['l']
            mss="Down"
        if os_==0 and prev_os!=0:
            for j in range(1,lookback+1):
                y=b[i-j]
                if y['c']<y['o']: pobT,pobB=y['h'],y['l']; break
            else:
                m=b[i-1]
                for j in range(1,obLen):
                    if b[i-j]['l']<m['l']: m=b[i-j]
                pobT,pobB=m['h'],m['l']
            mss="Up"
        if obT is not None and x['c']>obT: obT=obB=None
        if pobB is not None and x['c']<pobB: pobT=pobB=None
        if obT is not None and obB<=x['c']<=obT and x['c']<x['o']:
            sig.append(dict(i=i,t=x['t'],side="Short",top=obT,bot=obB,mss=mss,sh=lastSH,sl=lastSL))
        if pobT is not None and pobB<=x['c']<=pobT and x['c']>x['o']:
            sig.append(dict(i=i,t=x['t'],side="Long",top=pobT,bot=pobB,mss=mss,sh=lastSH,sl=lastSL))
    return sig
