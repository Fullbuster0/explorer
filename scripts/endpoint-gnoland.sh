#!/bin/bash
# Full drop-in nginx for Gnoland TM2 RPC + gRPC + static valopers JSON.
# Run as root from ~/endpoint/testnet (or anywhere).
#
# SAFETY (P1):
#   Default = config-only (NO stop nginx, NO certbot). Safe to re-run.
#   ISSUE_CERTS=1  → stop nginx + certbot standalone + write conf (first install / renew).
#   Example first install:  ISSUE_CERTS=1 bash endpoint-gnoland.sh
#   Example re-apply conf:  bash endpoint-gnoland.sh
#
# === KONFIGURASI ===
BASE_DOMAIN="shazoes.xyz"
RPC_SUB="gnoland-testnet-rpc"
GRPC_SUB="gnoland-testnet-grpc"
RPC_PORT=42657
GRPC_PORT=42090
CONF_FILE="/etc/nginx/sites-enabled/gnoland-testnet"

# Registry JSON dari cron explorer (scrape r/gnops/valopers → file ini).
# Path absolut di disk server yang sama — tidak perlu domain baru.
VALOPERS_JSON="/home/hermes/explorer/public/data/gno-valopers.json"

ISSUE_CERTS="${ISSUE_CERTS:-0}"

if [ "$ISSUE_CERTS" = "1" ]; then
  # === HENTIKAN NGINX SEMENTARA (hanya untuk Certbot standalone) ===
  echo "⏳  ISSUE_CERTS=1 → menghentikan Nginx sementara untuk Certbot standalone..."
  sudo systemctl stop nginx

  echo "🔐 Membuat sertifikat SSL untuk $RPC_SUB.$BASE_DOMAIN"
  sudo certbot certonly --standalone -d $RPC_SUB.$BASE_DOMAIN --register-unsafely-without-email --agree-tos

  echo "🔐 Membuat sertifikat SSL untuk $GRPC_SUB.$BASE_DOMAIN"
  sudo certbot certonly --standalone -d $GRPC_SUB.$BASE_DOMAIN --register-unsafely-without-email --agree-tos
else
  echo "ℹ️  ISSUE_CERTS=0 (default) → skip certbot, nginx tetap jalan. Set ISSUE_CERTS=1 hanya untuk first install/renew."
  if [ ! -f "/etc/letsencrypt/live/$RPC_SUB.$BASE_DOMAIN/fullchain.pem" ]; then
    echo "⚠️  Sertifikat RPC belum ada. Jalankan sekali: ISSUE_CERTS=1 $0"
  fi
fi

# Pastikan file registry kebaca nginx (kalau belum ada, location tetap ada — 404 sampai cron jalan)
if [ -f "$VALOPERS_JSON" ]; then
  chmod a+r "$VALOPERS_JSON" 2>/dev/null || true
fi
chmod a+x /home/hermes /home/hermes/explorer /home/hermes/explorer/public /home/hermes/explorer/public/data 2>/dev/null || true

# === BUAT KONFIGURASI NGINX ===
echo "📄 Menulis konfigurasi Nginx..."
sudo tee $CONF_FILE > /dev/null <<EOF
# RPC — Tendermint2 + static valoper registry (explorer SPA)
server {
    listen 443 ssl http2;
    server_name $RPC_SUB.$BASE_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$RPC_SUB.$BASE_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$RPC_SUB.$BASE_DOMAIN/privkey.pem;

    # Live valopers JSON (cron → file). HARUS sebelum location / agar tidak ke TM2.
    # URL: https://$RPC_SUB.$BASE_DOMAIN/static/gno-valopers.json
    location = /static/gno-valopers.json {
        alias $VALOPERS_JSON;
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
        proxy_pass http://127.0.0.1:$RPC_PORT/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_http_version 1.1;
        proxy_set_header Connection "upgrade";
    }
}

# gRPC
server {
    listen 443 ssl http2;
    server_name $GRPC_SUB.$BASE_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$GRPC_SUB.$BASE_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$GRPC_SUB.$BASE_DOMAIN/privkey.pem;

    location / {
        grpc_pass grpc://127.0.0.1:$GRPC_PORT;
        grpc_set_header Host \$host;
        grpc_set_header X-Real-IP \$remote_addr;
        grpc_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}

# REDIRECT HTTP → HTTPS
server {
    listen 80;
    server_name $RPC_SUB.$BASE_DOMAIN $GRPC_SUB.$BASE_DOMAIN;

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

# === AKTIFKAN DAN MUAT ULANG NGINX ===
echo "🚀 Menguji dan menyalakan ulang Nginx..."
if sudo systemctl is-active --quiet nginx; then
  sudo nginx -t && sudo systemctl reload nginx
else
  sudo nginx -t && sudo systemctl start nginx
fi

echo "✅  Siap diakses melalui:"
echo "   RPC      → https://$RPC_SUB.$BASE_DOMAIN"
echo "   gRPC     → https://$GRPC_SUB.$BASE_DOMAIN"
echo "   Valopers → https://$RPC_SUB.$BASE_DOMAIN/static/gno-valopers.json"
echo ""
echo "Cek cepat:"
echo "  curl -sI https://$RPC_SUB.$BASE_DOMAIN/static/gno-valopers.json | head"
echo "  curl -s  https://$RPC_SUB.$BASE_DOMAIN/status | head -c 120"
echo ""
echo "Catatan: re-run aman (default ISSUE_CERTS=0). First cert: ISSUE_CERTS=1 $0"
