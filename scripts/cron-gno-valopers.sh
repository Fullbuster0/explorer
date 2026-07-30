#!/bin/bash
# Cron wrapper for gno-valopers refresh
# Runs every 30 min via crontab
# Node 16 (system /usr/bin/node) has no global fetch — use nvm Node 20.
#
# IMPORTANT for production (Vercel):
#   public/data/gno-valopers.json is gitignored (local/dev only).
#   Live SPA ships src/libs/gno/valopers-data.ts BUNDLED — so when the
#   official valopers realm grows, we must commit+push the bundle or
#   Pending tab on production stays stale forever (poll alone cannot
#   invent operators that aren't in the bundle).
set -euo pipefail
cd /home/hermes/explorer || exit 1

LOG=/tmp/gno-valopers-refresh.log

# Prefer nvm Node 20 (fetch native); fall back to other nvm versions; last resort system node.
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
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) node=$NODE_BIN ===="
  "$NODE_BIN" scripts/refresh-gno-valopers.mjs --chain gnoland-testnet
} >> "$LOG" 2>&1

# Auto-commit bundled registry when operators were added/removed/changed.
# Only touch valopers-data.ts — never stage unrelated dirty worktree files.
BUNDLE="src/libs/gno/valopers-data.ts"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git diff --quiet -- "$BUNDLE" 2>/dev/null; then
    COUNT=$(grep -c '"signingAddress"' "$BUNDLE" 2>/dev/null || echo 0)
    {
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] bundle changed — committing ($COUNT signing rows)"
      git add -- "$BUNDLE"
      if git commit -m "chore(gno): refresh valopers registry ($COUNT)" ; then
        # Push so Vercel rebuilds with new Pending candidates
        git push origin HEAD 2>&1 || echo "WARN: push failed (will retry next cron)"
      else
        echo "WARN: commit failed or empty"
        git restore --staged -- "$BUNDLE" 2>/dev/null || true
      fi
    } >> "$LOG" 2>&1
  else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] bundle unchanged — no commit" >> "$LOG"
  fi
fi
