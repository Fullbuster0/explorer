#!/bin/bash
# === KONFIGURASI (same as ~/endpoint/testnet/gnoland + valopers static) ===
# Use this instead of the bare generator when (re)building the Gno endpoint vhost.
BASE_DOMAIN="shazoes.xyz"
RPC_SUB="gnoland-testnet-rpc"
GRPC_SUB="gnoland-testnet-grpc"
RPC_PORT=42657
GRPC_PORT=42090
CONF_FILE="/etc/nginx/sites-enabled/gnoland-testnet"
# Absolute path to cron-produced registry (gitignored JSON)
VALOPERS_JSON="/home/hermes/explorer/public/data/gno-valopers.json"

# === Optional: only if you need NEW certs (stops nginx). Skip if certs exist. ===
if [ "${ISSUE_CERTS:-0}" = "1" ]; then
  echo "⏳  Stopping Nginx for Certbot standalone..."
  sudo systemctl stop nginx
  echo "🔐 SSL $RPC_SUB.$BASE_DOMAIN"
  sudo certbot certonly --standalone -d $RPC_SUB.$BASE_DOMAIN --register-unsafely-without-email --agree-tos
  echo "🔐 SSL $GRPC_SUB.$BASE_DOMAIN"
  sudo certbot certonly --standalone -d $GRPC_SUB.$BASE_DOMAIN --register-unsafely-without-email --agree-tos
fi

echo "📄 Writing Nginx config (RPC + gRPC + valopers static)..."
sudo tee $CONF_FILE > /dev/null <<EOF
# RPC — Tendermint2 + static valoper registry for explorer
server {
    listen 443 ssl http2;
    server_name $RPC_SUB.$BASE_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$RPC_SUB.$BASE_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$RPC_SUB.$BASE_DOMAIN/privkey.pem;

    # Live valoper registry (cron → JSON). Must be BEFORE location /.
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

# HTTP → HTTPS
server {
    listen 80;
    server_name $RPC_SUB.$BASE_DOMAIN $GRPC_SUB.$BASE_DOMAIN;
    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

# Permissions so nginx can read hermes home path
sudo chmod a+r "$VALOPERS_JSON" 2>/dev/null || true
sudo chmod a+x /home/hermes /home/hermes/explorer /home/hermes/explorer/public /home/hermes/explorer/public/data 2>/dev/null || true

echo "🚀 nginx -t && reload..."
sudo nginx -t && sudo systemctl start nginx && sudo systemctl reload nginx

echo "✅ Ready:"
echo "   RPC      → https://$RPC_SUB.$BASE_DOMAIN"
echo "   gRPC     → https://$GRPC_SUB.$BASE_DOMAIN"
echo "   Valopers → https://$RPC_SUB.$BASE_DOMAIN/static/gno-valopers.json"
