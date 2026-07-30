#!/bin/bash
# install-nginx-gnoland.sh — Gnoland RPC + gRPC + static gno-valopers (Opsi A)
# First install / re-apply conf. Bukan systemd unit — jalankan MANUAL (sudo).
#
# Default ISSUE_CERTS=0 → tidak stop nginx (aman multi-vhost).
# First cert only:  ISSUE_CERTS=1 sudo -E bash install-nginx-gnoland.sh
#
# Opsi A data plane (default):
#   VALOPERS_JSON=$APP_HOME/gno-valopers/data/gno-valopers.json
# Legacy explorer path masih didukung lewat override.
set -euo pipefail

# === KONFIGURASI ===
BASE_DOMAIN="${BASE_DOMAIN:-shazoes.xyz}"
RPC_SUB="${RPC_SUB:-gnoland-testnet-rpc}"
GRPC_SUB="${GRPC_SUB:-gnoland-testnet-grpc}"
RPC_PORT="${RPC_PORT:-42657}"
GRPC_PORT="${GRPC_PORT:-42090}"
CONF_FILE="${CONF_FILE:-/etc/nginx/sites-enabled/gnoland-testnet}"
WEBROOT_ACME="${WEBROOT_ACME:-/var/www/html}"
ISSUE_CERTS="${ISSUE_CERTS:-0}"

# Real deploy user home (sudo → bukan /root)
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  APP_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
else
  APP_HOME="${HOME}"
fi
APP_HOME="${APP_HOME:-/root}"

# Opsi A default (di luar explorer). Override: VALOPERS_JSON=...
VALOPERS_JSON="${VALOPERS_JSON:-$APP_HOME/gno-valopers/data/gno-valopers.json}"
EXPLORER_ROOT="${GNO_EXPLORER_ROOT:-$APP_HOME/explorer}"

FQDN_RPC="${RPC_SUB}.${BASE_DOMAIN}"
FQDN_GRPC="${GRPC_SUB}.${BASE_DOMAIN}"
CERT_RPC="/etc/letsencrypt/live/${FQDN_RPC}"
CERT_GRPC="/etc/letsencrypt/live/${FQDN_GRPC}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: jalankan dengan sudo (atau sudo -E …)"
  echo "  sudo -E bash $0"
  echo "  sudo ISSUE_CERTS=1 bash $0    # first SSL only"
  exit 1
fi

echo "==> APP_HOME=$APP_HOME"
echo "==> VALOPERS_JSON=$VALOPERS_JSON"
echo "==> CONF_FILE=$CONF_FILE"
echo "==> ISSUE_CERTS=$ISSUE_CERTS"

command -v nginx >/dev/null
command -v certbot >/dev/null || echo "WARN: certbot tidak di PATH (OK jika cert sudah ada)"

# DNS soft-check (jangan print IP publik)
if getent ahostsv4 "$FQDN_RPC" >/dev/null 2>&1; then
  echo "    DNS $FQDN_RPC OK"
else
  echo "WARN: DNS $FQDN_RPC belum resolve — lanjut tetap (cert bisa gagal)"
fi

mkdir -p "$(dirname "$VALOPERS_JSON")" "$WEBROOT_ACME"
# pastikan file/parent kebaca nginx
if [ -f "$VALOPERS_JSON" ]; then
  chmod a+r "$VALOPERS_JSON" 2>/dev/null || true
fi
chmod a+x "$APP_HOME" \
  "$APP_HOME/gno-valopers" \
  "$APP_HOME/gno-valopers/data" \
  "$APP_HOME/explorer" \
  "$APP_HOME/explorer/public" \
  "$APP_HOME/explorer/public/data" 2>/dev/null || true

# traverse parents of VALOPERS_JSON
_path="$VALOPERS_JSON"
while [ -n "$_path" ] && [ "$_path" != "/" ]; do
  _path="$(dirname "$_path")"
  [ -d "$_path" ] || continue
  chmod a+x "$_path" 2>/dev/null || true
  case "$_path" in
    "$APP_HOME"|"$APP_HOME"/*|/home|/home/*|/opt|/opt/*|/var|/var/*|/srv|/srv/*) ;;
    *) break ;;
  esac
done

issue_one_cert() {
  local fqdn="$1"
  local certdir="/etc/letsencrypt/live/${fqdn}"
  if [ -f "${certdir}/fullchain.pem" ] && [ -f "${certdir}/privkey.pem" ]; then
    echo "    cert reuse $fqdn"
    return 0
  fi
  if [ "$ISSUE_CERTS" != "1" ]; then
    echo "ERROR: cert belum ada untuk $fqdn — jalankan sekali: ISSUE_CERTS=1 $0"
    return 1
  fi
  echo "    issuing cert $fqdn"
  # prefer webroot (nginx tetap hidup); fallback standalone
  mkdir -p "$WEBROOT_ACME"
  if certbot certonly --webroot -w "$WEBROOT_ACME" -d "$fqdn" \
      --register-unsafely-without-email --agree-tos --non-interactive 2>/dev/null; then
    echo "    webroot OK $fqdn"
  else
    echo "    FALLBACK standalone (stop nginx sebentar) $fqdn"
    systemctl stop nginx || true
    certbot certonly --standalone -d "$fqdn" \
      --register-unsafely-without-email --agree-tos --non-interactive
    systemctl start nginx || true
  fi
}

if [ "$ISSUE_CERTS" = "1" ]; then
  echo "==> [certs] ISSUE_CERTS=1"
  # HTTP bootstrap for ACME if needed (minimal, only if no cert yet)
  if [ ! -f "${CERT_RPC}/fullchain.pem" ] || [ ! -f "${CERT_GRPC}/fullchain.pem" ]; then
    echo "    writing temporary HTTP vhost for ACME…"
    tee "$CONF_FILE" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN_RPC} ${FQDN_GRPC};
    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT_ACME};
        default_type "text/plain";
        allow all;
    }
    location / { return 404; }
}
EOF
    nginx -t && systemctl reload nginx || systemctl start nginx
  fi
  issue_one_cert "$FQDN_RPC"
  issue_one_cert "$FQDN_GRPC"
else
  echo "==> [certs] ISSUE_CERTS=0 — skip certbot (no nginx stop)"
  if [ ! -f "${CERT_RPC}/fullchain.pem" ]; then
    echo "ERROR: missing ${CERT_RPC}/fullchain.pem — first run: ISSUE_CERTS=1 $0"
    exit 1
  fi
  if [ ! -f "${CERT_GRPC}/fullchain.pem" ]; then
    echo "WARN: missing gRPC cert ${CERT_GRPC} — gRPC block may fail nginx -t"
  fi
fi

SSL_OPTIONS=""
SSL_DH=""
[ -f /etc/letsencrypt/options-ssl-nginx.conf ] && SSL_OPTIONS="    include /etc/letsencrypt/options-ssl-nginx.conf;"
[ -f /etc/letsencrypt/ssl-dhparams.pem ] && SSL_DH="    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"

echo "==> writing full vhost → $CONF_FILE"
tee "$CONF_FILE" >/dev/null <<EOF
# Gnoland TM2 RPC + gRPC + static valopers (Opsi A)
# Generated by install-nginx-gnoland.sh — VALOPERS_JSON=${VALOPERS_JSON}
# Re-run safe with ISSUE_CERTS=0

server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN_RPC} ${FQDN_GRPC};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT_ACME};
        default_type "text/plain";
        allow all;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${FQDN_RPC};

    ssl_certificate     ${CERT_RPC}/fullchain.pem;
    ssl_certificate_key ${CERT_RPC}/privkey.pem;
${SSL_OPTIONS}
${SSL_DH}

    # HARUS sebelum location / — jangan proxy ke TM2
    # URL: https://${FQDN_RPC}/static/gno-valopers.json
    location = /static/gno-valopers.json {
        alias ${VALOPERS_JSON};
        default_type application/json;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Accept, Content-Type" always;
        add_header Cache-Control "public, max-age=60" always;
        if (\$request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods "GET, OPTIONS";
            add_header Access-Control-Allow-Headers "Accept, Content-Type";
            add_header Content-Length 0;
            return 204;
        }
    }

    location / {
        proxy_pass http://127.0.0.1:${RPC_PORT}/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_http_version 1.1;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${FQDN_GRPC};

    ssl_certificate     ${CERT_GRPC}/fullchain.pem;
    ssl_certificate_key ${CERT_GRPC}/privkey.pem;
${SSL_OPTIONS}
${SSL_DH}

    location / {
        grpc_pass grpc://127.0.0.1:${GRPC_PORT};
        grpc_set_header Host \$host;
        grpc_set_header X-Real-IP \$remote_addr;
        grpc_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

nginx -t
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl start nginx
fi

echo ""
echo "✅ Gnoland nginx ready"
echo "   RPC      → https://${FQDN_RPC}"
echo "   gRPC     → https://${FQDN_GRPC}"
echo "   Valopers → https://${FQDN_RPC}/static/gno-valopers.json"
echo "   (file)   → ${VALOPERS_JSON}"
echo ""
echo "Cron Opsi A (user crontab, BUKAN systemd nginx):"
echo "  */10 * * * * GNO_VALOPERS_ROOT=\$HOME/gno-valopers GNO_EXPLORER_ROOT=\$HOME/explorer GNO_VALOPERS_AUTO_COMMIT=0 \$HOME/gno-valopers/scripts/cron-gno-valopers.sh"
echo ""
echo "Cek:"
echo "  curl -sI https://${FQDN_RPC}/static/gno-valopers.json | head"
echo "  curl -s  https://${FQDN_RPC}/status | head -c 120"
