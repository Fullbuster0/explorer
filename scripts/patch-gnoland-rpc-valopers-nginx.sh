#!/bin/bash
# Run as ROOT. Adds /static/gno-valopers.json to gnoland-testnet-rpc vhost.
#   sudo bash /home/hermes/explorer/scripts/patch-gnoland-rpc-valopers-nginx.sh
set -euo pipefail

CONF="${CONF_FILE:-/etc/nginx/sites-enabled/gnoland-testnet}"
JSON_PATH="${JSON_PATH:-/home/hermes/explorer/public/data/gno-valopers.json}"
MARKER="gno-valopers-static"

if [ ! -f "$CONF" ]; then
  echo "FATAL: $CONF missing"; exit 1
fi

chmod a+r "$JSON_PATH" 2>/dev/null || true
chmod a+x /home/hermes /home/hermes/explorer /home/hermes/explorer/public /home/hermes/explorer/public/data 2>/dev/null || true

if grep -q "$MARKER" "$CONF"; then
  echo "Already patched. nginx -t + reload."
  nginx -t && systemctl reload nginx
  exit 0
fi

export CONF JSON_PATH MARKER
python3 <<'PY'
from pathlib import Path
import os, shutil
conf = Path(os.environ["CONF"])
json_path = os.environ["JSON_PATH"]
marker = os.environ["MARKER"]
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
needle = "server_name gnoland-testnet-rpc.shazoes.xyz;"
idx = orig.find(needle)
if idx < 0:
    raise SystemExit("RPC server_name not found")
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
curl -sI "https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json" | head -n 15
echo "---"
curl -s "https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json" | head -c 180; echo
echo "Verify RPC still OK:"
curl -s "https://gnoland-testnet-rpc.shazoes.xyz/status" | head -c 120; echo
