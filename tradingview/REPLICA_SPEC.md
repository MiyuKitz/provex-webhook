# Exact-replica spec: collected from Krysie's screenshots of the reference indicator (V2.1)

## Confirmed
- Breakout Detection Mode: Candle Close | Wick Break
- Purge Inactive / Mitigated SMC Boxes (default ON): "any Order Block, Mitigation Block, or FVG that gets tapped/mitigated is deleted immediately" -> zone is removed on first TAP, not only on full mitigation
- Purge Swept / Inactive Liquidity Pools (ON): "any BSL or SSL pool that gets swept/mitigated is deleted immediately"
- Box Background Transparency % (94): "Controls background opacity so current candles remain sharp and unobstructed"
- AVOID Label Color: "Deep distinct tone so it never conflicts with active SELL executions"
- Idea 1 Weighted Scoring (OFF): "Replaces strict filters with a confidence score. High volume and trend alignment can override minor roadblocks." Min Score TAKE 2, WAIT 0
- Idea 2 Setup-Specific Rulesets (ON): "Evaluates Breakouts differently than Retests. (Ignored if Weighted Scoring is ON)"
- Idea 4 Split Soft/Hard Barriers (ON): "Trading into MAJOR liquidity = AVOID. Trading into MINOR liquidity = WAIT (instead of blocking the trade)"
- Alert: Classic Arrow Signals (ON): "Fires explicit BUY or SELL alerts whenever a Classic Arrow prints on the chart"
- Alerts default: Classic arrows ON, Bull CHoCH ON, Bear CHoCH ON, all others OFF
- Historical Targets Transparency (75): "past target lines fade to this transparency once a trade resolves or a new signal prints"
- TP & SL Label Font Size (Small): "Controls the font size of the Stop Loss and Take Profit tags at the right edge of target lines"
- Risk defaults: ATR SL x3, TP1 0.5, TP2 2, TP3 3, extension 15 bars, labels ON
- Structure: separate Line colors (bull #00FFD0-ish teal, bear red) and CHoCH/BOS Label colors (bull cyan, bear red)
- Box section: Session Box Tracking Duration 3h, Max Historical 30, AI Squeeze Sensitivity Balanced, Min Compression Bars 4, Drift Buffer 0.75,
  Manual Range 1 18:00-02:00, Range 2 02:00-06:00, Range 3 07:00-08:30, Enable Adaptive Threshold Calibration ON, Box Tint (light yellow),
  Box Background Transparency 94, Box Border Color (khaki), Offset Box Right Edge Away From Active Candle ON
- Signal colors: BUY TAKE cyan, SELL TAKE red, BUY/SELL Retest teal-green, WAIT amber, AVOID dark maroon bg + pink text, standard text white, wait text dark grey
- Session: TZ America/Chicago, Morning 06:00-11:00, Evening 18:00-23:00, Restrict OFF

## Still needed
- HUD screenshots for every HUD Mode and trade state
- Remaining dropdown option lists (Void Mitigation, Box Engine Mode, Signal Trigger Engine, Preset Mode + preset values, Profile Span, Histogram Layout, Node Display Content, Label Text Position, Signal Visual Style, HUD Mode/Size/Position)
- Tooltips: WAIT Retest Recovery, AI Squeeze Sensitivity, AI Drift Buffer
- Settings gap between Mitigation Block Fill Color and Mitigation Text Transparency
- Chart in Labels mode, chart with Volume Histogram ON, alert message texts
