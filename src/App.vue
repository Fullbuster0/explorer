<script setup lang="ts">
import { themeChange } from 'theme-change';
import { onMounted, onUnmounted } from 'vue';
import TxDialog from './components/TxDialog.vue';
import { useBaseStore } from '@/stores';

// Default 2s so navbar height tracks ~blocktime better (was 6s → looks frozen)
const REFRESH_INTERVAL = Number(import.meta.env.VITE_REFRESH_INTERVAL || 2000);

const blockStore = useBaseStore();
let pollingTimer: ReturnType<typeof setInterval> | null = null;
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

function startPolling() {
  if (pollingTimer !== null) return;
  // immediate pull so header isn't stuck on "—" / stale height
  tick();
  pollingTimer = setInterval(() => {
    tick();
  }, Math.max(1000, REFRESH_INTERVAL));
}

function stopPolling() {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer);
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
