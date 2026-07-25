<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useBlockchain, useBaseStore } from '@/stores';

const chainStore = useBlockchain();
const baseStore = useBaseStore();
// storeToRefs keeps nested latest.block.header.height reactive in template
const { latest, connected } = storeToRefs(baseStore);
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

const heightNum = computed(() => {
  const h = latest.value?.block?.header?.height;
  const n = Number(h);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const heightLabel = computed(() => {
  return heightNum.value > 0 ? `#${heightNum.value.toLocaleString()}` : '—';
});
</script>

<template>
  <div class="flex items-center gap-3 min-w-0">
    <div class="relative shrink-0">
      <img v-lazy="chainStore.logo" class="w-9 h-9 rounded-full ring-1 ring-black/5 dark:ring-white/10" />
      <span
        class="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-base-100"
        :class="connected ? 'bg-success' : 'bg-error'"
      ></span>
    </div>
    <div class="min-w-0 hidden md:!block">
      <div class="capitalize whitespace-nowrap text-[13.5px] font-semibold tracking-tight leading-tight truncate">
        {{ chainLabel || '—' }}
        <span v-if="!connected" class="text-error font-medium ml-1">disconnected</span>
      </div>
      <div
        :key="heightNum"
        class="text-[11px] text-secondary whitespace-nowrap truncate font-mono leading-tight mt-0.5 tabular-nums"
      >
        {{ heightLabel }}
      </div>
    </div>
  </div>
</template>
