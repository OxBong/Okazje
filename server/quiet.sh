#!/usr/bin/env bash
# Makes the home server as quiet as possible:
#  1. Sleeps at night (fans off) and wakes itself in the morning. The cloud backup checks while it sleeps.
#  2. Keeps the CPU cool during the day (no turbo, power-saving), so the fan has less reason to spin up.
# Run: sudo bash server/quiet.sh [sleep time] [wake time]     default 23:30 and 06:55
set -euo pipefail
SLEEP_AT="${1:-23:30}"; WAKE_AT="${2:-06:55}"
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }

cat > /usr/local/bin/okazje-sleep <<SH
#!/bin/bash
# Sleep until $WAKE_AT. Uses suspend (fans fully off, wakes in seconds); falls back to power-off + timed power-on.
H=\$(date +%H%M); W=\$(echo $WAKE_AT | tr -d :)
if [ "\$H" -lt "\$W" ]; then T=\$(date -d "today $WAKE_AT" +%s); else T=\$(date -d "tomorrow $WAKE_AT" +%s); fi
MODE=off; grep -q deep /sys/power/mem_sleep 2>/dev/null && MODE=mem
logger -t okazje "night sleep (\$MODE) until $WAKE_AT"
/usr/sbin/rtcwake -m \$MODE -t \$T
SH
chmod 755 /usr/local/bin/okazje-sleep

cat > /etc/systemd/system/okazje-sleep.service <<UNIT
[Unit]
Description=Okazje server: sleep for the night
[Service]
Type=oneshot
ExecStart=/usr/local/bin/okazje-sleep
UNIT
cat > /etc/systemd/system/okazje-sleep.timer <<UNIT
[Unit]
Description=Okazje server: go to sleep at $SLEEP_AT
[Timer]
OnCalendar=*-*-* $SLEEP_AT:00
[Install]
WantedBy=timers.target
UNIT

cat > /usr/local/bin/okazje-cool <<'SH'
#!/bin/bash
# Cool and quiet CPU: no turbo, power-saving governor, max 70% speed (plenty for the checker)
[ -w /sys/devices/system/cpu/intel_pstate/no_turbo ] && echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
[ -w /sys/devices/system/cpu/intel_pstate/max_perf_pct ] && echo 70 > /sys/devices/system/cpu/intel_pstate/max_perf_pct
for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo powersave > "$g" 2>/dev/null || true; done
[ -w /sys/devices/system/cpu/cpufreq/boost ] && echo 0 > /sys/devices/system/cpu/cpufreq/boost
exit 0
SH
chmod 755 /usr/local/bin/okazje-cool
cat > /etc/systemd/system/okazje-cool.service <<UNIT
[Unit]
Description=Okazje server: cool and quiet CPU
[Service]
Type=oneshot
ExecStart=/usr/local/bin/okazje-cool
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target sleep.target
UNIT

systemctl daemon-reload
systemctl enable --now okazje-sleep.timer okazje-cool.service >/dev/null 2>&1
systemctl restart okazje-cool.service
echo "Night sleep: $SLEEP_AT -> wakes $WAKE_AT ($(grep -q deep /sys/power/mem_sleep 2>/dev/null && echo suspend || echo 'power-off + timed power-on'))"
echo "CPU now: governor $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor), max $(cat /sys/devices/system/cpu/intel_pstate/max_perf_pct 2>/dev/null || echo '?')%, temp $(( $(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -n | tail -1) / 1000 ))°C"
systemctl list-timers okazje-sleep.timer --no-pager | head -2
echo "Undo: sudo systemctl disable --now okazje-sleep.timer okazje-cool.service"
