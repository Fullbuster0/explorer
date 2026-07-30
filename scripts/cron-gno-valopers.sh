#!/bin/bash
# Cron wrapper for gno-valopers refresh — every 30 min (crontab).
# Node 16 has no global fetch — prefer nvm Node 20.
#
# Pipeline (no domain extra):
#   1) scrape r/gnops/valopers (server-side, no CORS)
#   2) write public/data/gno-valopers.json  (gitignored)
#   3) nginx serves it at:
#        https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json
#      → SPA fetches live (CORS *). NO git/deploy required for data.
#
# Bundle commit (valopers-data.ts) is OPTIONAL fallback for cold start.
# Set GNO_VALOPERS_AUTO_COMMIT=1 to re-enable commit+push (legacy Vercel path).
set -euo pipefail
cd /home/hermes/explorer || exit 1

LOG=/tmp/gno-valopers-refresh.log
AUTO_COMMIT="${GNO_VALOPERS_AUTO_COMMIT:-0}"

NODE_BIN=""
for cand in \
  /home/hermes/.nvm/versions/node/v20.20.2/bin/node \
  /home/hermes/.nvm/versions/node/v18.20.8/bin/node \
  /usr/bin/node; do
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done

if [ -z "$NODE_BIN" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] FATAL: no node binary found" >> "$LOG"
  exit 1
fi

{
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) node=$NODE_BIN auto_commit=$AUTO_COMMIT ===="
  "$NODE_BIN" scripts/refresh-gno-valopers.mjs --chain gnoland-testnet
  # Ensure world-readable for nginx (static location)
  if [ -f public/data/gno-valopers.json ]; then
    chmod a+r public/data/gno-valopers.json 2>/dev/null || true
    COUNT=$(grep -c '"signingAddress"' public/data/gno-valopers.json 2>/dev/null || echo 0)
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] json ready ($COUNT signing) → serve via RPC /static/"
  fi
} >> "$LOG" 2>&1

# Optional legacy path: commit bundled TS so Vercel has a seed without live URL.
if [ "$AUTO_COMMIT" = "1" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BUNDLE="src/libs/gno/valopers-data.ts"
  if ! git diff --quiet -- "$BUNDLE" 2>/dev/null; then
    COUNT=$(grep -c '"signingAddress"' "$BUNDLE" 2>/dev/null || echo 0)
    {
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] AUTO_COMMIT=1 bundle changed — committing ($COUNT)"
      git add -- "$BUNDLE"
      if git commit -m "chore(gno): refresh valopers registry ($COUNT)"; then
        git push origin HEAD 2>&1 || echo "WARN: push failed (will retry next cron)"
      else
        echo "WARN: commit failed or empty"
        git restore --staged -- "$BUNDLE" 2>/dev/null || true
      fi
    } >> "$LOG" 2>&1
  else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] bundle unchanged — no commit" >> "$LOG"
  fi
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] skip bundle commit (live JSON on RPC host)" >> "$LOG"
fi
