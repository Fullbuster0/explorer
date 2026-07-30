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
# Bundle commit (valopers-data.ts) is OPTIONAL cold-start seed ONLY.
# Production SSOT = public/data/gno-valopers.json (gitignored) → nginx /static/.
# NEVER auto-commit to the public repo (supply-chain / random data risk).
# Default: AUTO_COMMIT=0 and --skip-bundle (do not rewrite tracked TS).
# Manual seed only if you intentionally want a bundle fallback:
#   node scripts/refresh-gno-valopers.mjs   # writes bundle
#   git add -p src/libs/gno/valopers-data.ts && git commit   # human review
set -euo pipefail
# Portable root: env override → script-relative → legacy hermes path
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${GNO_EXPLORER_ROOT:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
if [ ! -d "$ROOT" ] || [ ! -f "$ROOT/scripts/refresh-gno-valopers.mjs" ]; then
  ROOT="/home/hermes/explorer"
fi
cd "$ROOT" || exit 1

LOG=/tmp/gno-valopers-refresh.log
AUTO_COMMIT="${GNO_VALOPERS_AUTO_COMMIT:-0}"

NODE_BIN=""
# Prefer pinned nvm builds, then any nvm v20/v18, then PATH/node
shopt -s nullglob 2>/dev/null || true
NVM_CANDS=(
  /home/hermes/.nvm/versions/node/v20.20.2/bin/node
  /home/hermes/.nvm/versions/node/v18.20.8/bin/node
  /home/hermes/.nvm/versions/node/v20.*/bin/node
  /home/hermes/.nvm/versions/node/v18.*/bin/node
)
for cand in "${NVM_CANDS[@]}" "$(command -v node 2>/dev/null || true)" /usr/bin/node; do
  [ -n "$cand" ] || continue
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done

if [ -z "$NODE_BIN" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] FATAL: no node binary found" >> "$LOG"
  exit 1
fi

{
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) node=$NODE_BIN auto_commit=$AUTO_COMMIT ===="
  # --skip-bundle: never rewrite tracked valopers-data.ts from cron (public repo safety).
  # Live SPA reads RPC /static/gno-valopers.json (gitignored JSON only).
  "$NODE_BIN" scripts/refresh-gno-valopers.mjs --chain gnoland-testnet --skip-bundle
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
