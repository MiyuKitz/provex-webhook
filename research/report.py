import json,math,sys
def st(rs):
    n=len(rs)
    if n<10: return f"n={n}"
    m=sum(rs)/n; sd=math.sqrt(sum((r-m)**2 for r in rs)/(n-1)); se=2*sd/math.sqrt(n)
    tag="✅" if m-se>0 else "❌" if m+se<0 else "~"
    return f"n={n:4} win={sum(r>0 for r in rs)/n*100:3.0f}% {m:+.3f}R ±{se:.3f} {tag}"
for mode in ["window","pass","fail"]:
    T=json.load(open(f"v19_trades_{mode}.json"))
    tr=[t for t in T if t['year']<=2025]; ho=[t for t in T if t['year']==2026]
    print(f"\n### delta={mode}")
    print(" BUILD 2023-25 all     ", st([t['R'] for t in tr]))
    print(" HOLDOUT 2026 all      ", st([t['R'] for t in ho]))
    if mode!="window": continue
    for rg in ["up","down","range"]:
        print(f" 2023-25 regime {rg:5}  ", st([t['R'] for t in tr if t['reg']==rg]))
    for s in ["Long","Short"]:
        print(f" 2023-25 {s:5}          ", st([t['R'] for t in tr if t['side']==s]))
    for y in [2023,2024,2025,2026]:
        print(f" year {y}             ", st([t['R'] for t in T if t['year']==y]))
    for sym in ["SUI","ETH","SOL"]:
        print(f" 2023-25 {sym}            ", st([t['R'] for t in tr if t['sym']==sym]))
    print(" ambiguous bars:",sum(t['amb'] for t in T))
