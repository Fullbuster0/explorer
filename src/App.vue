<script setup lang="ts">
import { themeChange } from 'theme-change';
import { onMounted, onUnmounted, ref } from 'vue';
import TxDialog from './components/TxDialog.vue';
import { useBaseStore } from '@/stores';

// Default 2s so navbar height tracks ~blocktime better (was 6s → looks frozen)
const REFRESH_INTERVAL = Number(import.meta.env.VITE_REFRESH_INTERVAL || 2000);

const blockStore = useBaseStore();
const requestCounter = ref(0);
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let inflight = false;

async function tick() {
  if (inflight || requestCounter.value >= 2) return;
  inflight = true;
  requestCounter.value += 1;
  try {
    await blockStore.fetchLatest();
  } finally {
    requestCounter.value -= 1;
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
