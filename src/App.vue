<script setup lang="ts">
import { themeChange } from 'theme-change';
import { onMounted, onUnmounted } from 'vue';
import TxDialog from './components/TxDialog.vue';
import { useBaseStore } from '@/stores';

// Default 2s (was 6s → looked frozen). Kept as a safety fallback; the live poll
// now follows the active chain's real blocktime instead of this fixed value.
const REFRESH_INTERVAL = Number(import.meta.env.VITE_REFRESH_INTERVAL || 2000);

// Adaptive poll bounds (ms). Polling at one full blocktime is prone to
// sampling just before/after a commit and visibly jumping by two heights. A
// half-block cadence catches each height reliably without a tight loop.
const POLL_MIN = 1000;
const POLL_MAX = 15000;

const blockStore = useBaseStore();
let pollingTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let epoch = 0; // bumped on start/stop so a stale polling chain can't resurrect itself
let inflight = false;

async function tick() {
  // Drop the hard `inflight` permanent lock: a hung fetchLatest used to freeze
  // the global block poller until hard refresh (statusbar + every page felt dead).
  // fetchLatest itself is bounded via http timeout; overlapping ticks are fine to skip
  // only while a call is truly running, and we always clear the flag in finally.
  if (inflight) return;
  inflight = true;
  try {
    await Promise.race([
      blockStore.fetchLatest(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tick-timeout')), 20000)),
    ]);
  } catch (e) {
    // swallow — next interval retries; fallbackEndpoint may already be running
    console.warn('[App] block tick:', (e as any)?.message || e);
  } finally {
    inflight = false;
  }
}

// Poll at roughly half the measured blocktime. Sampling once per full block
// can land on the same side of two commits and make the visible height jump
// from N to N+2. Re-read every cycle so switching chains re-tunes automatically.
function nextDelay(): number {
  const bt = blockStore.blocktime; // ms per block
  if (!Number.isFinite(bt) || bt <= 0) return Math.max(POLL_MIN, REFRESH_INTERVAL);
  return Math.min(POLL_MAX, Math.max(POLL_MIN, Math.round(bt / 2)));
}

function scheduleNext(myEpoch: number) {
  // A chain is stale if start/stop bumped `epoch` after it was born (rapid tab
  // flicker during a slow fetch). Stale chains die here → exactly one live chain.
  if (!running || myEpoch !== epoch) return;
  pollingTimer = setTimeout(() => {
    tick().finally(() => scheduleNext(myEpoch));
  }, nextDelay());
}

function startPolling() {
  if (running) return;
  running = true;
  epoch++;
  const myEpoch = epoch;
  // immediate pull so header isn't stuck on "—" / stale height, then adaptive chain
  tick().finally(() => scheduleNext(myEpoch));
}

function stopPolling() {
  running = false;
  epoch++; // invalidate any in-flight chain so its scheduleNext becomes a no-op
  if (pollingTimer !== null) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
  }
}

onMounted(() => {
  themeChange(false);
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <div>
    <RouterView />
    <TxDialog />
  </div>
</template>
