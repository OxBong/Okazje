#!/usr/bin/env bash
# Okazje home server setup. Run from the Mac:
#   ssh -t oxbing@192.168.1.70 'curl -fsSL https://raw.githubusercontent.com/OxBong/Okazje/main/server/setup.sh -o /tmp/okazje-setup.sh && bash /tmp/okazje-setup.sh'
# Safe to run again (it updates). Asks for the PC's password (sudo) and, the first time, your Okazje login.
set -euo pipefail
ME="$(id -un)"; HOME_DIR="$HOME"; REPO="$HOME_DIR/okazje"; DATA="$HOME_DIR/.okazje"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1/6 Asking for the PC password (for installing)"
sudo -v

say "2/6 Installing Node 22 and git"
# The old PHP source (only needed by the Minecraft panel) is outdated and breaks installs: park it (renamed, not deleted)
for f in /etc/apt/sources.list.d/*ondrej*; do [ -e "$f" ] && case "$f" in *.disabled) ;; *) sudo mv "$f" "$f.disabled";; esac; done
sudo apt-get update --allow-releaseinfo-change -qq >/dev/null || sudo apt-get update -qq
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1 || true
  sudo apt-get update --allow-releaseinfo-change -qq >/dev/null 2>&1 || true
  sudo apt-get install -y nodejs >/dev/null
fi
sudo apt-get install -y git ca-certificates >/dev/null
node -v; command -v npm >/dev/null || { echo "npm missing: Node install failed"; exit 1; }

say "3/6 Getting the checker"
if [ -d "$REPO/.git" ]; then git -C "$REPO" pull --ff-only -q; else git clone -q https://github.com/OxBong/Okazje.git "$REPO"; fi
cd "$REPO/server"
npm install --omit=dev --no-audit --no-fund >/dev/null
sudo npx playwright install-deps chromium >/dev/null
npx playwright install chromium >/dev/null
echo "ok"

say "4/6 Your Okazje login (stays only on this PC)"
mkdir -p "$DATA"; chmod 700 "$DATA"
if [ ! -s "$DATA/env" ]; then
  read -rp "Okazje email: " EM </dev/tty
  read -rsp "Okazje password (hidden): " PW </dev/tty; echo
  umask 077; printf 'OKAZJE_EMAIL=%s\nOKAZJE_PASSWORD=%s\n' "$EM" "$PW" > "$DATA/env"; unset PW
else echo "already saved (delete $DATA/env to change it)"; fi
chmod 600 "$DATA/env"

say "5/6 Starting it as a service (starts by itself after power-on)"
sudo tee /etc/systemd/system/okazje.service >/dev/null <<UNIT
[Unit]
Description=Okazje price checker
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$REPO/server
EnvironmentFile=$DATA/env
ExecStart=$(command -v node) $REPO/server/server.mjs
Restart=always
RestartSec=30
Nice=10
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable okazje >/dev/null 2>&1
sudo systemctl restart okazje

say "6/6 Power saving (old Minecraft panel switched OFF, not deleted)"
for s in wings docker.socket docker containerd mariadb mysql nginx php8.1-fpm php8.2-fpm redis-server redis webmin ModemManager pteroq; do
  if systemctl list-unit-files "$s.service" "$s" 2>/dev/null | grep -q "^$s"; then sudo systemctl disable --now "$s" >/dev/null 2>&1 && echo "off: $s" || true; fi
done
sudo systemctl set-default multi-user.target >/dev/null 2>&1 || true
# Undo later with: sudo systemctl enable --now docker wings nginx mariadb

sleep 20
say "Done. Last log lines:"
journalctl -u okazje -n 8 --no-pager -o cat || true
echo
echo "Check it any time from the Mac:  ssh oxbing@$(hostname -I | awk '{print $1}') 'journalctl -u okazje -n 20 -o cat'"
