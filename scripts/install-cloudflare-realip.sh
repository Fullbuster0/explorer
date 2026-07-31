#!/bin/bash
# install-cloudflare-realip.sh
# Restore real client IP di nginx ketika di belakang Cloudflare proxy.
# Tanpa ini, access log isinya IP Cloudflare (104.x / 172.67.x), bukan user.
#
# Hanya perlu untuk subdomain yang di-PROXY (orange cloud) = explorer.
# Chain endpoints / vote (DNS-only) TIDAK perlu ini.
set -euo pipefail

CONF="/etc/nginx/conf.d/cloudflare-realip.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: jalankan dengan sudo"; exit 1
fi

echo "==> Fetch Cloudflare IP ranges"
command -v curl >/dev/null || { echo "ERROR: curl belum ada"; exit 1; }

V4=$(curl -fsS https://www.cloudflare.com/ips-v4)
V6=$(curl -fsS https://www.cloudflare.com/ips-v6)

{
  echo "# Cloudflare real IP restoration"
  echo "# Generated: $(date -u +%FT%TZ)"
  echo "# Source: https://www.cloudflare.com/ips/"
  echo ""
  echo "# IPv4 ranges"
  echo "$V4" | while read -r ip; do [ -n "$ip" ] && echo "set_real_ip_from $ip;"; done
  echo ""
  echo "# IPv6 ranges"
  echo "$V6" | while read -r ip; do [ -n "$ip" ] && echo "set_real_ip_from $ip;"; done
  echo ""
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive on;"
} > "$CONF"

echo "    wrote $(grep -c set_real_ip_from "$CONF") ranges → $CONF"

echo "==> nginx -t + reload"
nginx -t
systemctl reload nginx

echo "✅ Done. Access log explorer sekarang pakai IP user asli."
echo "   Test: curl -s https://explorer.shazoes.xyz/ -o /dev/null; tail -1 /var/log/nginx/access.log"
