#!/bin/bash
# Cron wrapper for gno-valopers refresh
# Runs every 30 min via crontab
# Node 16 (system /usr/bin/node) has no global fetch — use nvm Node 20.
set -euo pipefail
cd /home/hermes/explorer || exit 1

# Prefer nvm Node 20 (fetch native); fall back to other nvm versions; last resort system node.
NODE_BIN=""
for cand in \
  /home/hermes/.nvm/versions/node/v20.20.2/bin/node \
  /home/hermes/.nvm/versions/node/v18.20.8/bin/node \
  /usr/bin/node; do
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done

if [ -z "$NODE_BIN" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] FATAL: no node binary found" >> /tmp/gno-valopers-refresh.log
  exit 1
fi

{
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) node=$NODE_BIN ===="
  "$NODE_BIN" scripts/refresh-gno-valopers.mjs --chain gnoland-testnet
} >> /tmp/gno-valopers-refresh.log 2>&1
