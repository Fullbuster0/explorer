<script setup lang="ts">
import { computed } from 'vue';
import { useBlockchain, useBaseStore } from '@/stores';
const chainStore = useBlockchain();
const baseStore = useBaseStore();
chainStore.initial();

const chainLabel = computed(() => {
  const pretty =
    (chainStore.current as any)?.prettyName ||
    (chainStore.current as any)?.registryName ||
    chainStore.current?.chainName ||
    chainStore.chainName ||
    '';
  return String(pretty)
    .replace(/-mainnet$/i, '')
    .replace(/-testnet$/i, '')
    .replace(/-/g, ' ')
    .trim();
});

const heightLabel = computed(() => {
  const h = baseStore.latest?.block?.header?.height;
  return h ? `#${Number(h).toLocaleString()}` : '—';
});
</script>

<template>
  <div class="flex items-center gap-3 min-w-0">
    <div class="relative shrink-0">
      <img v-lazy="chainStore.logo" class="w-9 h-9 rounded-full ring-1 ring-black/5 dark:ring-white/10" />
      <span
        class="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-base-100"
        :class="baseStore.connected ? 'bg-success' : 'bg-error'"
      ></span>
    </div>
    <div class="min-w-0 hidden md:!block">
      <div class="capitalize whitespace-nowrap text-[13.5px] font-semibold tracking-tight leading-tight truncate">
        {{ chainLabel || '—' }}
        <span v-if="!baseStore.connected" class="text-error font-medium ml-1">disconnected</span>
      </div>
      <div class="text-[11px] text-secondary whitespace-nowrap truncate font-mono leading-tight mt-0.5">
        {{ heightLabel }}
      </div>
    </div>
  </div>
</template>
