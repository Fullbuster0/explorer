#!/bin/bash
# Cron wrapper for gno-valopers refresh
# Runs every 30 min via crontab
cd /home/hermes/explorer || exit 1
/usr/bin/node scripts/refresh-gno-valopers.mjs --chain gnoland-testnet >> /tmp/gno-valopers-refresh.log 2>&1
