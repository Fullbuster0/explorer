<script setup lang="ts">
import { themeChange } from 'theme-change';
import { onMounted, onUnmounted } from 'vue';
import TxDialog from './components/TxDialog.vue';
import { useBaseStore } from '@/stores';

// Default 2s (was 6s → looked frozen). Kept as a safety fallback; the live poll
// now follows the active chain's real blocktime instead of this fixed value.
const REFRESH_INTERVAL = Number(import.meta.env.VITE_REFRESH_INTERVAL || 2000);

// Adaptive poll bounds (ms): don't hammer fast (~1s) chains, keep slow chains alive.
const POLL_MIN = 2000;
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

// Next delay follows the active chain's measured blocktime (Ping.pub feel): fast
// chains poll more often, slow chains less — clamped to [POLL_MIN, POLL_MAX].
// Re-read every cycle so switching chains re-tunes automatically. The blocktime
// getter returns 1000 before two blocks are seen → clamps up to POLL_MIN (2s).
function nextDelay(): number {
  const bt = blockStore.blocktime; // ms per block
  if (!Number.isFinite(bt) || bt <= 0) return Math.max(1000, REFRESH_INTERVAL);
  return Math.min(POLL_MAX, Math.max(POLL_MIN, Math.round(bt)));
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
