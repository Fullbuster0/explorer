#!/bin/bash
# install-cloudflare-lockdown.sh
# Origin lockdown untuk vhost yang di-PROXY Cloudflare (orange cloud):
# blok 443 hanya terima koneksi dari IP range resmi Cloudflare, lainnya 403.
# Melindungi H1: bypass CF → direct ke origin (indexer kubu.id, WAF origin, dll).
#
# Reusable: install-nginx-explorer.sh memanggil mode 'snippet' otomatis
# (CF_LOCKDOWN=1) sehingga reinstall tidak pernah men-drops proteksi ini.
#
# JANGAN apply ke vhost DNS-only (files/services/monitor/snapshot) — user-nya
# memang datang langsung ke origin. Cek dulu: dig +short <domain> → IP CF = proxied.
#
# Usage:
#   sudo bash install-cloudflare-lockdown.sh apply [conf ...]
#       bash install-cloudflare-lockdown.sh check [conf ...]
#   sudo bash install-cloudflare-lockdown.sh rollback [conf ...]
#   sudo bash install-cloudflare-lockdown.sh snippet
set -euo pipefail

# === KONFIGURASI ===
SNIPPET="${SNIPPET:-/etc/nginx/snippets/cloudflare-only.conf}"
BACKUP_DIR="${BACKUP_DIR:-/root/nginx-backup-lockdown-$(date +%Y%m%d-%H%M%S)}"
INCLUDE_LINE="    include ${SNIPPET};"
DEFAULT_CONFS=("/etc/nginx/sites-enabled/explorer")

MODE="${1:-}"
[ $# -gt 0 ] && shift
if [ $# -gt 0 ]; then CONFS=("$@"); else CONFS=("${DEFAULT_CONFS[@]}"); fi

usage() {
  sed -n '2,19p' "$0"
  exit 1
}

# Root hanya wajib jika target tidak writable (check mode aman non-root)
require_write_access() {
  for p in "$@"; do
    if [ ! -w "$p" ] && [ "$(id -u)" -ne 0 ]; then
      echo "ERROR: ${p} tidak writable — jalankan dengan sudo"
      exit 1
    fi
  done
}

# === SNIPPET: allowlist resmi Cloudflare + deny all ===
gen_snippet() {
  require_write_access "$(dirname "$SNIPPET")"
  command -v curl >/dev/null || { echo "ERROR: curl belum ada"; exit 1; }
  echo "==> Fetch Cloudflare IP ranges"
  local v4 v6
  v4=$(curl -fsS https://www.cloudflare.com/ips-v4)
  v6=$(curl -fsS https://www.cloudflare.com/ips-v6)
  [ -n "$v4" ] && [ -n "$v6" ] || { echo "ERROR: fetch gagal"; exit 1; }

  mkdir -p "$(dirname "$SNIPPET")"
  local tmp="${SNIPPET}.tmp.$$"
  {
    echo "# Cloudflare-only origin lockdown"
    echo "# Generated: $(date -u +%FT%TZ) — regenerate: install-cloudflare-lockdown.sh snippet"
    echo "# Source: https://www.cloudflare.com/ips/"
    echo "$v4" | while read -r ip; do [ -n "$ip" ] && echo "allow $ip;"; done
    echo "$v6" | while read -r ip; do [ -n "$ip" ] && echo "allow $ip;"; done
    echo "deny  all;"
  } > "$tmp"
  mv "$tmp" "$SNIPPET"
  echo "    $(grep -c '^allow' "$SNIPPET") ranges allowlisted → ${SNIPPET}"
}

# === INSERT include ke blok 443 (idempotent) ===
# State machine baris: track 'server {', flag ssl saat 'listen ... 443',
# sisipkan setelah 'server_name' pertama di blok ssl itu.
insert_include() {
  local conf="$1" tmp="$1.lockdown.tmp.$$"
  if grep -qF "$SNIPPET" "$conf"; then
    echo "    $(basename "$conf"): sudah ter-lockdown (skip)"
    return 0
  fi
  awk -v inc="$INCLUDE_LINE" '
    {
      print
      if (/^[ \t]*server[ \t]*\{/)        { in_srv=1; is_ssl=0 }
      else if (in_srv && $0 ~ /listen/ && $0 ~ /443/) { is_ssl=1 }
      else if (in_srv && is_ssl && /^[ \t]*server_name/ && !done) {
        print inc
        done=1
      }
      else if (/^\}/) { in_srv=0; is_ssl=0 }
    }
  ' "$conf" > "$tmp"
  if ! grep -qF "$SNIPPET" "$tmp"; then
    rm -f "$tmp"
    echo "    ERROR: blok 443 tidak ditemukan di ${conf}"
    return 1
  fi
  mv "$tmp" "$conf"
  echo "    $(basename "$conf"): include terpasang di blok 443"
}

# === VERIFY: direct-origin harus 403, via-CF harus 200 ===
verify_conf() {
  local conf="$1" fqdn
  fqdn=$(awk '/^[ \t]*server_name/ {print $2; exit}' "$conf" | tr -d ';')
  [ -n "$fqdn" ] || { echo "    WARN: server_name tidak ditemukan"; return 0; }
  local direct via
  direct=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 8 \
    https://127.0.0.1/ -H "Host: ${fqdn}" 2>/dev/null || echo "000")
  via=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    "https://${fqdn}/" 2>/dev/null || echo "000")
  echo "    ${fqdn}: direct-origin=${direct} (expect 403) | via-CF=${via} (expect 200)"
  [ "$direct" = "403" ] || echo "    ^^ WARN: origin masih bisa diakses langsung"
}

# === MODE ===
# DRYRUN=1: patch file conf saja, skip nginx -t/reload (validasi offline)
if [ "${DRYRUN:-0}" = "1" ]; then
  nginx_test_reload() { echo "    (DRYRUN) nginx -t + reload di-skip"; return 0; }
else
  nginx_test_reload() { nginx -t && systemctl reload nginx; }
fi

case "$MODE" in
  snippet)
    gen_snippet
    ;;
  check)
    for conf in "${CONFS[@]}"; do
      [ -f "$conf" ] || { echo "==> ${conf}: TIDAK ADA"; continue; }
      if grep -qF "$SNIPPET" "$conf"; then st="LOCKED"; else st="OPEN"; fi
      echo "==> ${conf}: ${st}"
      verify_conf "$conf"
    done
    ;;
  apply)
    [ -f "$SNIPPET" ] || gen_snippet
    require_write_access "${CONFS[@]}"
    # backup dulu
    mkdir -p "$BACKUP_DIR"
    for conf in "${CONFS[@]}"; do
      [ -f "$conf" ] || { echo "ERROR: ${conf} tidak ditemukan"; exit 1; }
      cp -a "$conf" "${BACKUP_DIR}/$(basename "$conf")"
    done
    echo "==> Backup → ${BACKUP_DIR}"
    echo "==> Patch blok 443"
    for conf in "${CONFS[@]}"; do insert_include "$conf"; done
    echo "==> nginx -t"
    if ! nginx_test_reload; then
      echo "ERROR: config invalid — rollback"
      for conf in "${CONFS[@]}"; do cp -a "${BACKUP_DIR}/$(basename "$conf")" "$conf"; done
      nginx_test_reload
      exit 1
    fi
    echo "==> Verify"
    for conf in "${CONFS[@]}"; do verify_conf "$conf"; done
    echo
    echo "✅ Origin lockdown aktif. Rollback: bash $0 rollback ${CONFS[*]}"
    ;;
  rollback)
    require_write_access "${CONFS[@]}"
    for conf in "${CONFS[@]}"; do
      [ -f "$conf" ] || continue
      sed -i "\|include ${SNIPPET};|d" "$conf"
      echo "==> ${conf}: include dicabut"
    done
    nginx_test_reload
    echo "✅ Rollback selesai (snippet ${SNIPPET} dibiarkan — bisa dipakai ulang)"
    ;;
  *)
    usage
    ;;
esac
