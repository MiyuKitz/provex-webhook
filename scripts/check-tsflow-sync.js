// Fails if the TradingView indicator and the bot engine carry different TS Flow versions.
// Run: node scripts/check-tsflow-sync.js   (also runs on server start)
const fs = require("fs"), path = require("path");
function tsflowSync() {
  const root = path.join(__dirname, "..");
  const pine = fs.readFileSync(path.join(root, "tradingview/TwoSpeedFlow.pine"), "utf8").match(/TWO-SPEED FLOW\s+v([\d.]+)/);
  const js = fs.readFileSync(path.join(root, "tsflow.js"), "utf8").match(/TwoSpeedFlow\.pine v([\d.]+)/);
  return { pine: pine && pine[1], engine: js && js[1], inSync: !!(pine && js && pine[1] === js[1]) };
}
if (require.main === module) { const r = tsflowSync(); console.log(r); process.exit(r.inSync ? 0 : 1); }
module.exports = { tsflowSync };
