<script setup lang="ts">
import { useBlockchain, useBaseStore } from '@/stores';
const chainStore = useBlockchain();
const baseStore = useBaseStore();
chainStore.initial();
</script>

<template>
  <div class="flex items-center gap-3">
    <div class="relative">
      <img v-lazy="chainStore.logo" class="w-9 h-9 rounded-full ring-1 ring-black/5 dark:ring-white/10" />
      <span
        class="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-base-100"
        :class="baseStore.connected ? 'bg-success' : 'bg-error'"
      ></span>
    </div>
    <div class="flex-1 w-0 hidden md:!block">
      <div
        :key="baseStore.latest?.block?.header?.height || chainStore.chainName || ''"
        class="capitalize whitespace-nowrap text-[13.5px] font-semibold tracking-tight"
      >
        {{
          baseStore.latest?.block?.header?.height
            ? `#${baseStore.latest.block.header.height}`
            : chainStore.chainName || ''
        }}
        <span v-if="!baseStore.connected" class="text-error font-medium">disconnected</span>
      </div>
      <div class="text-[11px] text-secondary whitespace-nowrap truncate font-mono">
        {{ chainStore.connErr || chainStore.endpoint.address }}
      </div>
    </div>
  </div>
</template>
