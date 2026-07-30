#!/bin/bash
# Run as ROOT. Adds /static/gno-valopers.json to gnoland-testnet-rpc vhost.
#   sudo bash scripts/patch-gnoland-rpc-valopers-nginx.sh
#
# Production-portable:
#   VALOPERS_JSON / JSON_PATH   absolute JSON path (cron output)
#   GNO_EXPLORER_ROOT           explorer root → public/data/gno-valopers.json
#   CONF_FILE                   nginx vhost (default sites-enabled/gnoland-testnet)
set -euo pipefail

# Deploy home: sudo-safe ($HOME under sudo is /root — use SUDO_USER)
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  APP_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
else
  APP_HOME="${HOME}"
fi
APP_HOME="${APP_HOME:-/root}"

EXPLORER_ROOT="${GNO_EXPLORER_ROOT:-$APP_HOME/explorer}"
CONF="${CONF_FILE:-/etc/nginx/sites-enabled/gnoland-testnet}"
# Default: $HOME/explorer/public/data/gno-valopers.json (per-user)
JSON_PATH="${VALOPERS_JSON:-${JSON_PATH:-$EXPLORER_ROOT/public/data/gno-valopers.json}}"
MARKER="gno-valopers-static"
RPC_SERVER_NAME="${RPC_SERVER_NAME:-gnoland-testnet-rpc.shazoes.xyz}"

if [ ! -f "$CONF" ]; then
  echo "FATAL: $CONF missing"; exit 1
fi

echo "📁 APP_HOME=$APP_HOME"
echo "📁 JSON_PATH=$JSON_PATH"
echo "📁 CONF=$CONF"

if [ -f "$JSON_PATH" ]; then
  chmod a+r "$JSON_PATH" 2>/dev/null || true
fi
chmod a+x "$APP_HOME" \
  "$APP_HOME/explorer" \
  "$APP_HOME/explorer/public" \
  "$APP_HOME/explorer/public/data" 2>/dev/null || true
_path="$JSON_PATH"
while [ -n "$_path" ] && [ "$_path" != "/" ]; do
  _path="$(dirname "$_path")"
  [ -d "$_path" ] || continue
  chmod a+x "$_path" 2>/dev/null || true
  case "$_path" in
    "$APP_HOME"|"$APP_HOME"/*|/home|/home/*|/opt|/opt/*|/var|/var/*|/srv|/srv/*) ;;
    *) break ;;
  esac
done

if grep -q "$MARKER" "$CONF"; then
  echo "Already patched. nginx -t + reload."
  nginx -t && systemctl reload nginx
  exit 0
fi

export CONF JSON_PATH MARKER RPC_SERVER_NAME
python3 <<'PY'
from pathlib import Path
import os, shutil
conf = Path(os.environ["CONF"])
json_path = os.environ["JSON_PATH"]
marker = os.environ["MARKER"]
server_name = os.environ["RPC_SERVER_NAME"]
orig = conf.read_text()
shutil.copy2(conf, str(conf) + ".bak-valopers")
static_block = f"""
    # --- {marker} ---
    # Live valoper registry for explorer SPA (cron → JSON). Do NOT proxy to TM2.
    location = /static/gno-valopers.json {{
        alias {json_path};
        default_type application/json;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Accept, Content-Type" always;
        add_header Cache-Control "public, max-age=60" always;
        if ($request_method = OPTIONS) {{
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods "GET, OPTIONS";
            add_header Access-Control-Allow-Headers "Accept, Content-Type";
            add_header Content-Length 0;
            return 204;
        }}
    }}
"""
needle = f"server_name {server_name};"
idx = orig.find(needle)
if idx < 0:
    # fallback: any gnoland rpc server_name line
    import re
    m = re.search(r"server_name\s+([^\s;]*gnoland[^\s;]*rpc[^\s;]*);", orig)
    if not m:
        raise SystemExit(f"RPC server_name not found (tried {server_name!r})")
    idx = m.start()
    needle = m.group(0)
loc = orig.find("location / {", idx)
if loc < 0:
    raise SystemExit("location / not found in RPC server")
new = orig[:loc] + static_block + "\n    " + orig[loc:]
conf.write_text(new)
print(f"Patched {conf} (backup → {conf}.bak-valopers)")
PY

nginx -t
systemctl reload nginx

echo ""
echo "Verify JSON:"
curl -sI "https://${RPC_SERVER_NAME}/static/gno-valopers.json" | head -n 15
echo "---"
curl -s "https://${RPC_SERVER_NAME}/static/gno-valopers.json" | head -c 180; echo
echo "Verify RPC still OK:"
curl -s "https://${RPC_SERVER_NAME}/status" | head -c 120; echo
