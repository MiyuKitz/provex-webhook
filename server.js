const http = require("http");

// ============================================================
// CONFIG — set these as environment variables in Railway
// ============================================================
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

// ============================================================
// Send Telegram message
// ============================================================
async function sendTelegram(message) {
  const url  = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id:    TELEGRAM_CHAT_ID,
    text:       message,
    parse_mode: "HTML",
  });

  return new Promise((resolve, reject) => {
    const req = require("https").request(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end",  () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// Format alert into clean Telegram message
// ============================================================
function formatAlert(payload) {
  const now      = new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "short", timeStyle: "short" });
  const alertMsg = payload.message || payload || "Unknown alert";
  const ticker   = payload.ticker  || "—";
  const price    = payload.price   || "—";

  const isPriority = alertMsg.includes("HIGH PRIORITY") || alertMsg.includes("PRIORITY");
  const isBull     = alertMsg.includes("BULL")  || alertMsg.includes("long");
  const isBear     = alertMsg.includes("BEAR")  || alertMsg.includes("short");

  const emoji = isPriority ? "🚨" : isBull ? "🟢" : isBear ? "🔴" : "🔔";
  const bias  = isBull ? "LONG BIAS" : isBear ? "SHORT BIAS" : "WATCH";

  return `${emoji} <b>PROVEX ALERT</b>
─────────────────
<b>Signal:</b> ${alertMsg}
<b>Ticker:</b> ${ticker}
<b>Price:</b> $${price}
<b>Bias:</b> ${bias}
<b>Time (AEDT):</b> ${now}
─────────────────
📋 Paste this to Claude for trade plan`;
}

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200); res.end("Provex alert server running ✅"); return;
  }

  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        let payload;
        try { payload = JSON.parse(body); } catch { payload = { message: body }; }
        const msg = formatAlert(payload);
        await sendTelegram(msg);
        console.log("Alert sent ✅", new Date().toISOString());
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("Error:", err.message);
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
