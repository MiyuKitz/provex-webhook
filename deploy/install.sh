#!/usr/bin/env bash
# ProveX bot installer for a fresh Ubuntu 24.04 server (DigitalOcean droplet etc).
# Run as root:  curl -fsSL https://raw.githubusercontent.com/MiyuKitz/provex-webhook/main/deploy/install.sh | bash
# Re-enter keys later:  curl -fsSL https://raw.githubusercontent.com/MiyuKitz/provex-webhook/main/deploy/install.sh | bash -s -- --keys
set -euo pipefail
REPO=https://github.com/MiyuKitz/provex-webhook.git
APP=/opt/provex-bot
DATA=/var/lib/provex-bot
ENVF=/etc/provex-bot.env
OLD=https://provex-webhook-production.up.railway.app   # old Railway bot, used once to copy its saved state
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }
asks() { local v; read -r -s -p "$1" v </dev/tty; echo >&2; printf '%s' "$v"; }

[ "$(id -u)" = 0 ] || { echo "Please run as root (the DigitalOcean console logs you in as root)."; exit 1; }

# Small droplets ($4 = 512 MB RAM): add 1 GB swap so installs and the bot never run out of memory
if ! swapon --show | grep -q . ; then
  say "Adding 1 GB swap (small server safety)"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Installing system packages (1-2 min)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq git curl ca-certificates jq ufw nodejs >/dev/null
node -v

say "Getting the bot code"
id provex >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin provex
mkdir -p "$DATA"
if [ -d "$APP/.git" ]; then git -C "$APP" fetch -q origin main && git -C "$APP" reset -q --hard origin/main; else git clone -q "$REPO" "$APP"; fi
chown -R provex:provex "$DATA"

if [ ! -f "$ENVF" ] || [ "${1:-}" = "--keys" ]; then
  say "Your keys (typing is hidden for secrets; paste and press Enter)"
  KEY=$(asks "BingX API key: ")
  SECRET=$(asks "BingX API secret: ")
  TG=$(asks "Telegram bot token (from @BotFather): ")
  echo "Now open Telegram and send any message (e.g. hi) to your bot."
  ask "Press Enter after you've sent it... " >/dev/null
  CHAT=$(curl -fsS "https://api.telegram.org/bot${TG}/getUpdates" | jq -r '[.result[] | (.message // .channel_post // .my_chat_member).chat.id] | last // empty' || true)
  if [ -z "$CHAT" ]; then CHAT=$(ask "Couldn't detect it. Type your Telegram chat ID: "); else echo "Telegram chat detected: $CHAT"; fi
  umask 077
  cat > "$ENVF" <<ENV
# ProveX bot settings. Secrets live only here (readable by root only).
PORT=8080
DATA_DIR=$DATA
BINGX_API_KEY=$KEY
BINGX_API_SECRET=$SECRET
TELEGRAM_TOKEN=$TG
TELEGRAM_CHAT_ID=$CHAT
CORE_COINS=BTC,SOL,DOGE,1000PEPE,FLOKI,INJ,NEAR
AGGRO_COINS=BTC,ETH,SOL,SUI,DOGE,NEAR,INJ,1000PEPE,FLOKI,ZRO,XRP,LINK,AVAX
AGGRO_MIN_CONF=4
AGGRO_RISK=0.01
AGGRO_RESET=v26
ENV
  chmod 600 "$ENVF"
fi

if [ ! -f "$DATA/shadow.json" ]; then
  say "Copying the setup history (shadow log) from the old Railway bot"
  curl -fsS -m 60 "$OLD/shadow/all" > "$DATA/shadow.json" 2>/dev/null && echo "Shadow log copied." || { rm -f "$DATA/shadow.json"; echo "Old bot not reachable, shadow log starts fresh."; }
fi
if [ ! -f "$DATA/core_state.json" ] && [ ! -f "$DATA/aggro_state.json" ]; then
  echo
  echo "Is this bot trading the SAME BingX account as the old Railway bot?"
  echo "  y = same account: copy Core holdings + Aggro scoreboard/open trades"
  echo "  n = NEW account or sub-account: start Core + Aggro fresh (recommended for a new sub-account)"
  SAME=$(ask "Same account? (y/N): ")
  if [ "$SAME" = "y" ] || [ "$SAME" = "Y" ]; then
    if curl -fsS -m 30 "$OLD/core" -o /tmp/core.json; then
      jq '.state' /tmp/core.json > "$DATA/core_state.json"
      jq -c '.log[]' /tmp/core.json > "$DATA/core_log.jsonl"
      curl -fsS -m 30 "$OLD/aggro" | jq 'del(.on,.account,.accountEquity,.coins,.riskPerTrade,.maxLeverage,.returnPct)' > "$DATA/aggro_state.json" || true
      echo "Core + Aggro state copied."
    else echo "Old bot not reachable, starting fresh."; fi
  else echo "Starting Core + Aggro fresh."; fi
fi
chown -R provex:provex "$DATA"

say "Setting up the 24/7 service + auto-updates from GitHub"
cat > /etc/systemd/system/provex-bot.service <<UNIT
[Unit]
Description=ProveX trading bot
After=network-online.target
Wants=network-online.target
[Service]
User=provex
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
[Install]
WantedBy=multi-user.target
UNIT
cat > /usr/local/bin/provex-update <<'UPD'
#!/usr/bin/env bash
# Pull new code from GitHub; restart the bot only if it changed and passes a syntax check.
set -e
cd /opt/provex-bot
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  if node --check server.js; then systemctl restart provex-bot; echo "updated to $(git log -1 --format=%s)"; fi
fi
UPD
chmod 755 /usr/local/bin/provex-update
cat > /etc/systemd/system/provex-update.service <<'U'
[Unit]
Description=Update ProveX bot from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/provex-update
U
cat > /etc/systemd/system/provex-update.timer <<'U'
[Unit]
Description=Check GitHub for bot updates every 2 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
U
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/provex.conf
systemctl restart systemd-journald || true
systemctl daemon-reload
systemctl enable --now provex-bot provex-update.timer >/dev/null
systemctl restart provex-bot

say "Firewall: allow SSH + the bot's status page (8080)"
ufw allow OpenSSH >/dev/null; ufw allow 8080/tcp >/dev/null; ufw --force enable >/dev/null

sleep 6
IP=$(curl -fsS -m 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || curl -fsS -m 5 https://api.ipify.org || echo "?")
if curl -fsS -m 10 http://127.0.0.1:8080/ >/dev/null; then
  say "DONE ✅ The bot is running 24/7."
else
  say "Installed, but the bot didn't answer yet. Check with: journalctl -u provex-bot -n 50"
fi
cat <<MSG

  Server IP (lock your BingX key to this):  $IP
  Status page:  http://$IP:8080/   (also /core  /aggro  /shadow)

  Useful commands:
    journalctl -u provex-bot -f        live log (Ctrl+C to exit)
    systemctl restart provex-bot       restart the bot
    re-enter keys:  curl -fsSL https://raw.githubusercontent.com/MiyuKitz/provex-webhook/main/deploy/install.sh | bash -s -- --keys
MSG
