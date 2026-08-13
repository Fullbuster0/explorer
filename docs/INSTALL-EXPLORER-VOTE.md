# Install Explorer + Vote Tendermint (end-to-end)

Panduan **dari nol**: clone explorer → build → testing (Vercel) → production (domain pribadi) → wire **vote-tendermint**.

Asumsi arsitektur (disarankan, support **beda server**):

```text
Browser
  ├─ https://explorer.<domain>/              → SPA (nginx static / Vercel test)
  └─ https://vote-tendermint.<domain>/v1/…   → vote API (nginx → :8878)
```

| Repo | Isi |
|------|-----|
| [`Fullbuster0/explorer`](https://github.com/Fullbuster0/explorer) | SPA Vue (Cosmos explorer) |
| [`Fullbuster0/vote-tendermint`](https://github.com/Fullbuster0/vote-tendermint) | API + worker + SQLite (**terpisah**) |

**Jangan** monorepo-kan. FE hanya HTTP client ke vote.

---

## 0) Prasyarat

### Mesin build / SPA

```bash
# Node 20 (wajib untuk build Shazoes explorer)
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# reload shell, lalu:
nvm install 20
nvm use 20
node -v   # v20.x
npm i -g yarn
```

Opsional: `git`, `rsync`, `nginx`, `certbot` (untuk prod static).

### Mesin vote (boleh = mesin SPA, atau beda VPS)

```bash
sudo apt update
sudo apt install -y git python3 sqlite3 nginx certbot python3-certbot-nginx curl openssl
```

### DNS (siapkan dulu)

| Record | Target |
|--------|--------|
| `vote-tendermint.<BASE_DOMAIN>` | IP VPS **vote** |
| `explorer.<BASE_DOMAIN>` (prod) | IP VPS **SPA** |

Contoh Shazoes: `vote-tendermint.shazoes.xyz`, domain explorer pribadi lo.

---

## 1) Clone & install **Explorer**

```bash
# === KONFIGURASI ===
EXPLORER_DIR="${HOME}/explorer"
EXPLORER_GIT="https://github.com/Fullbuster0/explorer.git"   # private → token/SSH

git clone "$EXPLORER_GIT" "$EXPLORER_DIR"
cd "$EXPLORER_DIR"
git checkout master   # atau branch lo

nvm use 20
yarn install --frozen-lockfile
# fallback lama: yarn --ignore-engines
```

### Env dasar

```bash
cp .env.example .env.local
# edit sesuai kebutuhan (refresh interval, coingecko, dll.)
```

Isi penting terkait vote (lihat bagian 4–5):

```bash
# .env.example (referensi)
# Default (unset): FE fetch ke same-origin path /vote-api
# Production (beda server): set absolute:
# VITE_VOTE_INDEXER_URL=https://vote-tendermint.shazoes.xyz
```

### Dev lokal (tanpa vote dulu)

```bash
cd "$EXPLORER_DIR"
nvm use 20
yarn serve
# http://localhost:5173 (atau port Vite)
```

Tanpa vote indexer, halaman gov/validator tetap jalan lewat LCD; per-voter index bisa kosong.

### Build artifak

```bash
cd "$EXPLORER_DIR"
nvm use 20
yarn build-only          # vite → dist/
# full (lebih lambat): yarn build   # type-check + build-only
```

---

## 2) Install **vote-tendermint** (API)

Detail unit/nginx: lihat juga `vote-tendermint/INSTALL.md`. Ringkas:

```bash
# === KONFIGURASI ===
VOTE_DIR="${HOME}/vote-tendermint"
VOTE_GIT="https://github.com/Fullbuster0/vote-tendermint.git"
VOTE_FQDN="vote-tendermint.shazoes.xyz"   # samakan dengan DNS

git clone "$VOTE_GIT" "$VOTE_DIR"
cd "$VOTE_DIR"
mkdir -p data backups logs

# (opsional) restore snapshot
# gunzip -c backups/votes-latest.db.gz > data/votes.db
# rm -f data/votes.db-wal data/votes.db-shm

# Pastikan path di systemd/run-*.sh = VOTE_DIR (default /home/hermes/vote-tendermint)
```

### Systemd (pilih **satu**)

**User unit:**

```bash
mkdir -p ~/.config/systemd/user
cp "$VOTE_DIR"/systemd/shazoes-vote-api.service    ~/.config/systemd/user/
cp "$VOTE_DIR"/systemd/shazoes-vote-worker.service ~/.config/systemd/user/
# Edit: WorkingDirectory, VOTE_INDEXER_*, ExecStart
# Disarankan API: VOTE_INDEXER_HOST=127.0.0.1 (di belakang nginx)

systemctl --user daemon-reload
systemctl --user enable --now shazoes-vote-api shazoes-vote-worker
sudo loginctl enable-linger "$(whoami)"

curl -fsS http://127.0.0.1:8878/health
```

**Atau system unit** (`/etc/systemd/system/`, `User=…`, `WantedBy=multi-user.target`).  
Jangan dual-run.

### Nginx publik vote

```bash
cd "$VOTE_DIR"
# Edit blok KONFIGURASI di install-nginx.sh:
#   BASE_DOMAIN / VOTE_SUB / UPSTREAM_* / CONF_FILE
sudo nano install-nginx.sh
sudo bash install-nginx.sh

curl -fsS "https://${VOTE_FQDN}/health"
curl -fsS -o /dev/null -w "%{http_code}\n" \
  "https://${VOTE_FQDN}/v1/atomone-mainnet/proposals"
```

Chain list: `vote-tendermint/app/config.py` → `CHAINS`.  
Tambah chain di sini kalau explorer menampilkan chain baru.

---

## 3) Wire FE ↔ vote (kontrak URL)

Code SPA (`gov` + `validator` pages):

```ts
// VITE_VOTE_INDEXER_URL jika set → pakai itu
// jika unset → default '/vote-api'
// jika ""   → disable indexer
```

| Environment | Setting | Arti |
|-------------|---------|------|
| **Vercel test** | `VITE_VOTE_INDEXER_URL` **unset** + `vercel.json` rewrite | Browser hit `/vote-api` → Vercel proxy ke `https://vote-tendermint…` |
| **Prod domain pribadi** (beda server OK) | `VITE_VOTE_INDEXER_URL=https://vote-tendermint.<domain>` di **build** | Browser hit host vote langsung |
| Disable | `VITE_VOTE_INDEXER_URL=` (empty) | LCD only |

**Production recommended** = absolute URL (bagian 5).

---

## 4) Testing — **Vercel only**

### 4.1 `vercel.json` rewrite

```json
{
  "rewrites": [
    {
      "source": "/vote-api/:path*",
      "destination": "https://vote-tendermint.shazoes.xyz/:path*"
    },
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

Ganti destination ke FQDN vote lo. **Jangan** pakai tunnel trycloudflare permanen.

### 4.2 Env di Vercel

- **Jangan** set `VITE_VOTE_INDEXER_URL` (biar default `/vote-api` + rewrite).
- Atau set absolute ke vote FQDN (sama seperti prod) — juga valid.

### 4.3 Deploy test

```bash
cd "$EXPLORER_DIR"
# token di ~/.vercel_token atau VERCEL_TOKEN
python3 /home/hermes/deploy_explorer.py
# atau: npx vercel deploy --prod --yes
```

Cek:

```text
https://shazoes-explorer.vercel.app/   (alias test lo)
Network tab: /vote-api/health → 200 via rewrite
```

---

## 5) Production — **domain pribadi + nginx**

### 5.1 Build dengan vote absolute

```bash
cd "$EXPLORER_DIR"
nvm use 20

# file env production (Vite: .env.production di-load saat build)
cat > .env.production <<'EOF'
VITE_REFRESH_INTERVAL=6000
VITE_FETCH_ALL_BLOCKS=false
VITE_RECENT_BLOCK_LIMIT=50
VITE_COINGECKO_URL=https://api.shazoes.xyz
VITE_GITHUB_API_URL=https://api.github.com/repos/cosmos/chain-registry/contents
VITE_PINGPUB_API_URL=https://registry.ping.pub
VITE_IBC_USE_GITHUB_API=false

# VOTE — absolute (support beda server)
VITE_VOTE_INDEXER_URL=https://vote-tendermint.shazoes.xyz
EOF

yarn build-only
# output: dist/
```

**Penting:** `VITE_*` di-bake saat build. Ganti URL vote = **rebuild** + redeploy dist.

### 5.2 Nginx SPA (static only)

Template gaya explorer lo:

```bash
#!/bin/bash
# install-nginx-explorer.sh — sesuaikan CONFIG

set -euo pipefail

# === KONFIGURASI ===
BASE_DOMAIN="shazoes.xyz"
EXPLORER_SUB="explorer"                 # → explorer.shazoes.xyz (GANTI)
WEB_ROOT="/usr/share/nginx/explorer"
CONF_FILE="/etc/nginx/sites-enabled/explorer"
# Vote TIDAK di-proxy di sini jika VITE_VOTE_INDEXER_URL absolute.
# (Opsional same-origin: lihat lampiran.)

FQDN="${EXPLORER_SUB}.${BASE_DOMAIN}"

sudo systemctl stop nginx
sudo certbot certonly --standalone -d "$FQDN" \
  --register-unsafely-without-email --agree-tos

sudo mkdir -p "$WEB_ROOT"
sudo chown -R www-data:www-data "$WEB_ROOT"

sudo tee "$CONF_FILE" > /dev/null <<EOF
server {
    listen 443 ssl http2;
    server_name ${FQDN};

    ssl_certificate     /etc/letsencrypt/live/${FQDN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${FQDN}/privkey.pem;

    root ${WEB_ROOT};
    index index.html index.htm;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root ${WEB_ROOT};
    }

    gzip on;
    gzip_proxied any;
    gzip_static on;
    gzip_min_length 1024;
    gzip_types text/plain application/javascript application/x-javascript text/css application/xml text/javascript image/svg+xml;
}
server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN};
    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

sudo nginx -t
sudo systemctl start nginx
sudo systemctl reload nginx
echo "OK https://${FQDN}"
```

> Catatan multi-vhost: stop nginx global = downtime semua site.  
> Prefer pola vote (`install-nginx.sh`: HTTP dulu + webroot) kalau host ramai vhost.

### 5.3 Deploy dist ke WEB_ROOT

```bash
cd "$EXPLORER_DIR"
sudo rsync -a --delete dist/ /usr/share/nginx/explorer/
# atau: sudo cp -a dist/. "$WEB_ROOT"/
sudo chown -R www-data:www-data /usr/share/nginx/explorer
```

### 5.4 Verifikasi production

```bash
curl -fsS -o /dev/null -w "%{http_code}\n" "https://explorer.<domain>/"
curl -fsS "https://vote-tendermint.shazoes.xyz/health"

# Di browser: buka gov proposal / validator
# Network: request ke https://vote-tendermint…/v1/<chain>/…  → 200
```

---

## 6) Urutan install yang disarankan (checklist)

```text
[ ] 1. DNS vote-tendermint + (opsional) explorer
[ ] 2. Clone + systemd vote → :8878 healthy
[ ] 3. install-nginx.sh vote → https://vote-tendermint…/health
[ ] 4. Clone explorer + yarn install (Node 20)
[ ] 5. Vercel test: vercel.json rewrite → vote FQDN + deploy
[ ] 6. Prod: .env.production VITE_VOTE_INDEXER_URL=https://vote…
[ ] 7. yarn build-only → rsync dist ke nginx SPA
[ ] 8. Cek UI gov/validator + Network tab
[ ] 9. (opsional) cron backup DB vote / gno-valopers
```

---

## 7) Ringkas mapping file

| File | Peran |
|------|--------|
| `explorer/.env.production` | `VITE_VOTE_INDEXER_URL` **prod** |
| `explorer/.env.local` | dev |
| `explorer/vercel.json` | rewrite `/vote-api` **test only** |
| `explorer/src/.../gov/[proposal_id].vue` | consumer vote API |
| `explorer/src/.../validator/[validator].vue` | consumer vote API |
| `explorer/chains/**/*.json` | chain meta (hero, endpoints, …) |
| `vote-tendermint/app/config.py` | daftar chain indexer |
| `vote-tendermint/systemd/*` | api + worker |
| `vote-tendermint/install-nginx.sh` | HTTPS vote front |
| `vote-tendermint/data/votes.db` | live DB (gitignore) |
| `vote-tendermint/backups/*.db.gz` | DR snapshot |

---

## 8) Troubleshooting explorer↔vote

| Gejala | Penyebab umum | Fix |
|--------|----------------|-----|
| Vercel `/vote-api` 502 | rewrite ke tunnel mati / FQDN salah | `vercel.json` → `vote-tendermint…` + redeploy |
| Prod SPA hit `/vote-api` 404 | lupa set `VITE_VOTE_INDEXER_URL` saat build | set absolute + **rebuild** |
| CORS error ke vote | header CORS di vote vhost | cek `install-nginx.sh` Allow-Origin |
| Chain ada di explorer, votes kosong | chain belum di `config.CHAINS` | tambah + restart worker |
| Mixed content | SPA https, vote http | vote harus https FQDN |
| Stale vote URL | Vite bake-in | rebuild setelah ganti env |

```bash
# API lokal
curl -fsS http://127.0.0.1:8878/health
# Publik
curl -fsS https://vote-tendermint.shazoes.xyz/health
# Pastikan dist memuat URL (cari di bundle)
grep -R "vote-tendermint" dist/assets/*.js | head
```

---

## 9) Yang **tidak** dilakukan di production

- ❌ Andalkan Vercel sebagai prod  
- ❌ Hardcode IP VPS di git / FE  
- ❌ `proxy_pass` ke `127.0.0.1:8878` di **mesin SPA** kalau vote di server lain  
- ❌ Tunnel cloudflared permanen sebagai URL vote  

---

## 10) Lampiran — same-origin `/vote-api` (hanya jika SPA **&** vote **satu** VPS)

Kalau sengaja co-locate dan ingin default path tanpa rebuild env:

```nginx
# di vhost explorer, selain static:
location /vote-api/ {
    proxy_pass http://127.0.0.1:8878/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Build: **jangan** set `VITE_VOTE_INDEXER_URL` (default `/vote-api`).  
**Tidak** recommended jika nanti beda server — pakai absolute (bagian 5).

---

**END** — Explorer install + konfigurasi vote-tendermint.
