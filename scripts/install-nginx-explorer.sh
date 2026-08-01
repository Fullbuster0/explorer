#!/bin/bash
# install-nginx-explorer.sh
# HTTPS static SPA → Cosmos Explorer (explorer.shazoes.xyz)
# Style: sama template vote-tendermint (CONFIG di atas, copy-paste ready)
#
# Pindah server: edit CONFIG → DNS A/AAAA → deploy dist/ → sudo bash script ini
# Tidak hardcode IP publik.
set -euo pipefail

# === KONFIGURASI ===
BASE_DOMAIN="shazoes.xyz"
EXPLORER_SUB="explorer"                    # FQDN = explorer.shazoes.xyz
WEB_ROOT="/usr/share/nginx/explorer"
CONF_FILE="/etc/nginx/sites-enabled/explorer"
WEBROOT_ACME="/var/www/html"               # ACME webroot (bukan SPA root)

FQDN="${EXPLORER_SUB}.${BASE_DOMAIN}"
CERT_DIR="/etc/letsencrypt/live/${FQDN}"
FULLCHAIN="${CERT_DIR}/fullchain.pem"
PRIVKEY="${CERT_DIR}/privkey.pem"

# === ROOT CHECK ===
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: jalankan dengan sudo"
  echo "  sudo bash $0"
  exit 1
fi

echo "==> Config"
echo "    FQDN      = ${FQDN}"
echo "    WEB_ROOT  = ${WEB_ROOT}"
echo "    CONF_FILE = ${CONF_FILE}"

# === PREFLIGHT ===
echo "==> Preflight tools"
command -v nginx   >/dev/null || { echo "ERROR: nginx belum terpasang"; exit 1; }
command -v certbot >/dev/null || { echo "ERROR: certbot belum terpasang"; exit 1; }
command -v curl    >/dev/null || { echo "ERROR: curl belum terpasang"; exit 1; }
command -v openssl >/dev/null || { echo "ERROR: openssl belum terpasang"; exit 1; }

echo "==> Preflight DNS ${FQDN}"
if ! getent ahostsv4 "$FQDN" >/dev/null 2>&1; then
  echo "ERROR: DNS ${FQDN} belum resolve."
  echo "Buat A/AAAA record ${FQDN} → host ini, tunggu propagate, jalankan lagi."
  exit 1
fi
echo "    DNS OK (resolved — IP tidak dicetak)"

# === WEB ROOT ===
if [ ! -d "$WEB_ROOT" ]; then
  echo "==> Buat web root ${WEB_ROOT}"
  mkdir -p "$WEB_ROOT"
  chown -R www-data:www-data "$WEB_ROOT"
fi
mkdir -p "$WEBROOT_ACME"

# SSL extras (kalau ada di host ini)
SSL_OPTIONS=""
SSL_DH=""
if [ -f /etc/letsencrypt/options-ssl-nginx.conf ]; then
  SSL_OPTIONS="    include /etc/letsencrypt/options-ssl-nginx.conf;"
fi
if [ -f /etc/letsencrypt/ssl-dhparams.pem ]; then
  SSL_DH="    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
fi

# Security headers — injected into EACH location (add_header doesn't inherit
# when a location has its own add_header like Cache-Control).
read -r -d '' SEC_HEADERS <<'SEC' || true
        add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: wss: data:; frame-src 'self' https://wallet.keplr.app; worker-src 'self' blob:; child-src 'self' blob:; form-action 'self'; frame-ancestors 'self'; upgrade-insecure-requests" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
        add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
SEC

# Vote-indexer upstream (local backend on :8878)
VOTE_UPSTREAM="http://127.0.0.1:8878"

# === [1] HTTP VHOST DULU (ACME + server_name) ===
# JANGAN stop nginx — multi-vhost: stop global bikin downtime semua site.
echo "==> [1/4] Tulis HTTP bootstrap → ${CONF_FILE}"
tee "$CONF_FILE" > /dev/null <<EOF
# EXPLORER — HTTP bootstrap (ACME)
# FQDN=${FQDN}

server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT_ACME};
        default_type "text/plain";
        allow all;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

nginx -t
systemctl reload nginx
echo "    HTTP vhost aktif"

# === [2] SERTIFIKAT SSL ===
echo "==> [2/4] Sertifikat SSL untuk ${FQDN}"
if [ -f "$FULLCHAIN" ] && [ -f "$PRIVKEY" ]; then
  echo "    cert sudah ada — reuse ${CERT_DIR}"
else
  # Prefer webroot (nginx tetap jalan, multi-vhost aman)
  if certbot certonly --webroot -w "$WEBROOT_ACME" -d "$FQDN" \
      --register-unsafely-without-email --agree-tos --non-interactive; then
    echo "    cert via webroot OK"
  elif certbot certonly --nginx -d "$FQDN" \
      --register-unsafely-without-email --agree-tos --non-interactive; then
    echo "    cert via --nginx OK"
  else
    echo "    FALLBACK standalone (hentikan nginx sebentar — last resort)"
    systemctl stop nginx
    certbot certonly --standalone -d "$FQDN" \
      --register-unsafely-without-email --agree-tos --non-interactive
    systemctl start nginx
    echo "    cert via standalone OK"
  fi
fi

if [ ! -f "$FULLCHAIN" ] || [ ! -f "$PRIVKEY" ]; then
  echo "ERROR: cert tidak ditemukan di ${CERT_DIR}"
  exit 1
fi

PEM_BLOCKS=$(grep -c 'BEGIN CERTIFICATE' "$FULLCHAIN" || true)
echo "    cert files OK (PEM blocks=${PEM_BLOCKS})"
if [ "${PEM_BLOCKS}" -lt 2 ]; then
  echo "    WARN: fullchain sebaiknya leaf+intermediate (≥2)"
fi

# === [3] HTTP + HTTPS FULL ===
echo "==> [3/4] Tulis konfigurasi Nginx lengkap → ${CONF_FILE}"
tee "$CONF_FILE" > /dev/null <<EOF
# EXPLORER SERVER
# ${FQDN} → static SPA di ${WEB_ROOT}
# Jangan hardcode IP publik di file ini.

# REDIRECT HTTP → HTTPS (+ ACME)
server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT_ACME};
        default_type "text/plain";
        allow all;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS static SPA
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${FQDN};

    ssl_certificate     ${FULLCHAIN};
    ssl_certificate_key ${PRIVKEY};
${SSL_OPTIONS}
${SSL_DH}

    root ${WEB_ROOT};
    index index.html;

    # ── Hashed assets (/assets/index-a1b2c3.js): cache forever ──
    # Filename = content hash, aman immutable. Repeat visit = 0 byte.
    location /assets/ {
${SEC_HEADERS}
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files \$uri =404;
    }

    # ── Static media (logos, vendor, fonts): cache 7 hari ──
    location ~* ^/(logos|vendor|favicon|manifest)/ {
${SEC_HEADERS}
        add_header Cache-Control "public, max-age=604800";
        try_files \$uri =404;
    }

    # ── Vote API proxy (same-origin fallback for VITE_VOTE_INDEXER_URL) ──
    # SPA uses /vote-api when VITE_VOTE_INDEXER_URL is not set at build time.
    # Proxies to local vote-indexer backend on :8878.
    location /vote-api/ {
${SEC_HEADERS}
        proxy_pass ${VOTE_UPSTREAM}/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }

    # ── SPA fallback: index.html harus revalidate (deploy baru) ──
    location / {
${SEC_HEADERS}
        add_header Cache-Control "no-cache";
        try_files \$uri \$uri/ /index.html;
    }

    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root ${WEB_ROOT};
    }

    # ── Compression ──
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_static on;
    gzip_min_length 256;
    gzip_comp_level 5;
    gzip_buffers 16 8k;
    gzip_http_version 1.1;
    gzip_types
        text/plain
        text/css
        text/javascript
        application/javascript
        application/x-javascript
        application/json
        application/xml
        application/wasm
        image/svg+xml
        font/ttf
        font/opentype
        font/woff
        font/woff2;
}
EOF

echo "==> nginx -t + reload"
nginx -t
systemctl reload nginx
echo "    HTTPS vhost aktif"

# === [4] VERIFIKASI SNI + LIVE ===
echo "==> [4/4] Verifikasi SNI + live"
sleep 1

SNI_OK=0
for i in 1 2 3 4 5; do
  SERVED=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$FQDN" 2>/dev/null \
    | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null || true)
  if echo "$SERVED" | grep -Fq "$FQDN"; then
    SNI_OK=1
    echo "    SNI cert match: ${FQDN}"
    break
  fi
  echo "    SNI belum siap (${i}/5) — reload + tunggu"
  systemctl reload nginx || true
  sleep 2
done

if [ "$SNI_OK" -ne 1 ]; then
  echo "ERROR: sertifikat SNI untuk ${FQDN} belum cocok."
  echo "Cek vhost default_server lain yang mungkin hijack :443"
  exit 1
fi

# Health: index.html harus 200
HTTP_CODE=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 10 "https://${FQDN}/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "    index.html: HTTP ${HTTP_CODE} OK"
else
  echo "    WARN: index.html HTTP ${HTTP_CODE} (SPA belum di-deploy?)"
fi

# Cek asset caching
ASSET=$(curl -fsS --max-time 10 "https://${FQDN}/" 2>/dev/null | grep -oE 'assets/index-[^"]+\.js' | head -1 || true)
if [ -n "$ASSET" ]; then
  CACHE_HDR=$(curl -fsSI --max-time 10 "https://${FQDN}/${ASSET}" 2>/dev/null | grep -i 'cache-control' || echo "(none)")
  echo "    asset: ${ASSET}"
  echo "    cache: ${CACHE_HDR}"
else
  echo "    WARN: belum ada hashed asset (deploy dist/ dulu)"
fi

echo
echo "✅ Explorer siap: https://${FQDN}"
echo "   Conf:  ${CONF_FILE}"
echo "   Root:  ${WEB_ROOT}"
echo "   Cert:  ${CERT_DIR}"
echo
echo "Deploy SPA:"
echo "   cd \$HOME/explorer && yarn build-only"
echo "   rm -rf ${WEB_ROOT}/assets && cp -a dist/. ${WEB_ROOT}/"
echo "   chown -R www-data:www-data ${WEB_ROOT}"
echo
echo "Pindah server nanti:"
echo "  1) Edit BASE_DOMAIN / EXPLORER_SUB di CONFIG"
echo "  2) DNS ${FQDN} → host baru"
echo "  3) Deploy dist/ ke ${WEB_ROOT}"
echo "  4) sudo bash $0"
