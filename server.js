// ✅ New — reads each JSON field directly by name
const condition = payload.condition  // "cross_above_level1", "killzone_level_break_HIGH_PRIORITY" etc
const rsi       = payload.rsi        // 41.58
const cumDelta  = payload.cumDelta   // -7092891
// emoji/bias logic now based on condition string, not alertMsg
