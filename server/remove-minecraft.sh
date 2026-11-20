#!/usr/bin/env bash
# Removes the old Minecraft server + Pterodactyl panel (wings, docker, database, web server, PHP, redis, webmin)
# and its game data. The Okazje checker is not touched. Run: sudo bash server/remove-minecraft.sh
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
echo "Before: $(df -h / | awk 'NR==2{print $3" used"}')"
systemctl disable --now wings pteroq 2>/dev/null
rm -f /usr/local/bin/wings /etc/systemd/system/wings.service /etc/systemd/system/pteroq.service
crontab -l 2>/dev/null | grep -v pterodactyl | crontab - 2>/dev/null
rm -rf /etc/pterodactyl /var/lib/pterodactyl /var/www/pterodactyl /var/log/pterodactyl /srv/daemon-data
PKGS=$(dpkg-query -W -f='${Package}\n' 2>/dev/null | grep -E '^(docker|containerd|mariadb|mysql|nginx|php|redis|webmin|libapache2-mod-php)' | tr '\n' ' ')
[ -n "$PKGS" ] && DEBIAN_FRONTEND=noninteractive apt-get purge -y $PKGS >/dev/null
rm -rf /var/lib/docker /var/lib/containerd /var/lib/mysql /etc/mysql /etc/nginx /etc/php /etc/webmin /var/lib/redis
rm -f /etc/apt/sources.list.d/*ondrej* /etc/apt/sources.list.d/*docker* /etc/apt/sources.list.d/*webmin* /etc/apt/sources.list.d/*mariadb* /etc/apt/sources.list.d/*redis*
DEBIAN_FRONTEND=noninteractive apt-get autoremove -y >/dev/null
systemctl daemon-reload
echo "Removed: ${PKGS:-nothing}"
echo "After: $(df -h / | awk 'NR==2{print $3" used"}')"
echo "Okazje checker: $(systemctl is-active okazje)"
