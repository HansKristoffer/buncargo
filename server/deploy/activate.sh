#!/usr/bin/env bash
# Root-only activation of a reviewed, immutable release. No production credentials in the artifact.
set -euo pipefail
release=${1:?absolute release directory required}
[[ "$release" =~ ^/opt/buncargo-connect/releases/[a-f0-9]{40}$ ]] || { echo 'Invalid release directory' >&2; exit 1; }
cd "$release"
sha256sum -c SHA256SUMS
if [[ "$(cat /var/lib/buncargo-connect/deployed-commit 2>/dev/null || true)" == "$(cat commit)" ]]; then
 bash "$release/smoke.sh"
 exit 0
fi
id buncargo-connect >/dev/null 2>&1 || useradd --system --home-dir /var/lib/buncargo-connect --shell /usr/sbin/nologin buncargo-connect
install -d -m 750 -o buncargo-connect -g buncargo-connect /var/lib/buncargo-connect
install -d -m 700 /etc/buncargo-connect
[[ -s /etc/buncargo-connect/cloudflare.token ]] || { echo 'Save the zone DNS token in /etc/buncargo-connect/cloudflare.token first' >&2; exit 1; }
if [[ ! -f /etc/buncargo-connect/server.env ]]; then
 (umask 077; printf 'CONNECT_STORAGE_KEY=%s\n' "$(openssl rand -hex 32)" > /etc/buncargo-connect/server.env)
fi
# Never echo the DNS credential. systemd reads the private environment file as root.
(umask 077; printf 'CLOUDFLARE_API_TOKEN=%s\n' "$(tr -d '\r\n' </etc/buncargo-connect/cloudflare.token)" > /etc/buncargo-connect/caddy.env)
set -a
source /etc/buncargo-connect/caddy.env
set +a
"$release/caddy" validate --config "$release/Caddyfile" --adapter caddyfile 2>&1 | python3 -c 'import os,sys; print(sys.stdin.read().replace(os.environ["CLOUDFLARE_API_TOKEN"], "[redacted]"), end="")' 
previous=$(readlink -f /opt/buncargo-connect/current || true)
ln -sfn "$release" /opt/buncargo-connect/next
mv -Tf /opt/buncargo-connect/next /opt/buncargo-connect/current
for component in directory caddy frps; do
 case "$component" in
 directory) executable='directory'; environment='/etc/buncargo-connect/server.env'; extra='' ;;
 caddy) executable='caddy run --config /opt/buncargo-connect/current/Caddyfile --adapter caddyfile'; environment='/etc/buncargo-connect/caddy.env'; extra='AmbientCapabilities=CAP_NET_BIND_SERVICE' ;;
 frps) executable='frps -c /opt/buncargo-connect/current/frps.json'; environment='/etc/buncargo-connect/server.env'; extra='' ;;
 esac
 cat >"/etc/systemd/system/buncargo-$component.service" <<UNIT
[Unit]
Description=Buncargo $component
After=network-online.target
Wants=network-online.target
[Service]
User=buncargo-connect
Group=buncargo-connect
EnvironmentFile=$environment
Environment=HOME=/var/lib/buncargo-connect XDG_DATA_HOME=/var/lib/buncargo-connect XDG_CONFIG_HOME=/var/lib/buncargo-connect
ExecStart=/opt/buncargo-connect/current/$executable
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/buncargo-connect
LimitNOFILE=65536
$extra
[Install]
WantedBy=multi-user.target
UNIT
 done
cat >/etc/systemd/system/buncargo-cert-sync.service <<'UNIT'
[Unit]
Description=Synchronize renewed Buncargo relay certificate
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/buncargo-connect/current/cert-sync.sh
UNIT
cat >/etc/systemd/system/buncargo-cert-sync.timer <<'UNIT'
[Unit]
Description=Check Buncargo relay certificate renewal
[Timer]
OnBootSec=60
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
rollback() {
 if [[ -n "$previous" && "$previous" != "$release" ]]; then
  ln -sfn "$previous" /opt/buncargo-connect/current
  systemctl restart buncargo-directory buncargo-caddy buncargo-frps
 else
  systemctl stop buncargo-directory buncargo-caddy buncargo-frps || true
 fi
}
trap rollback ERR
systemctl restart buncargo-directory buncargo-caddy
for attempt in $(seq 1 60); do
 if bash "$release/cert-sync.sh"; then break; fi
 sleep 2
done
[[ -s /var/lib/buncargo-connect/frps-tls/cert.pem ]]
systemctl restart buncargo-frps
bash "$release/smoke.sh"
systemctl enable buncargo-directory buncargo-caddy buncargo-frps buncargo-cert-sync.timer
systemctl start buncargo-cert-sync.timer
cp "$release/commit" /var/lib/buncargo-connect/deployed-commit
trap - ERR
