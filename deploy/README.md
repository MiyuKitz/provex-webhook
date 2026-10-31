# Running the bot on your own server (VPS)

Moved off Railway after its Oct 21 2026 security incident (leaked environment variables).

1. Create an Ubuntu 24.04 server (DigitalOcean droplet, Singapore, cheapest Basic plan).
2. Open its web console (logged in as root) and paste:
   ```
   curl -fsSL https://raw.githubusercontent.com/MiyuKitz/provex-webhook/main/deploy/install.sh | bash
   ```
3. Paste the new BingX key/secret and Telegram token when asked (hidden), message your bot once.
4. Lock the BingX API key to the server's IP (the installer prints it).

The installer sets up a systemd service (24/7, restarts on crash and reboot), pulls updates from GitHub
every 2 minutes (restarts only if the code changed and passes `node --check`), copies the old bot's
saved state once, keeps secrets in /etc/provex-bot.env (root-only), and opens only SSH + port 8080.

Logs: `journalctl -u provex-bot -f` · Restart: `systemctl restart provex-bot` · New keys: rerun with `bash -s -- --keys`

Strategy settings (non-secret) live in `settings.json` at the repo root and override the env file; change them by commit, the server applies them within ~2 min.
