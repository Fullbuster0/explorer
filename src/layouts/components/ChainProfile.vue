<script setup lang="ts">
import { useBlockchain, useBaseStore } from '@/stores';
import type { Endpoint } from '@/types/chaindata';
import { useRouter } from 'vue-router';
const chainStore = useBlockchain();
const baseStore = useBaseStore();
chainStore.initial();
const router = useRouter();
function changeEndpoint(item: Endpoint) {
  chainStore.setRestEndpoint(item);
  if (chainStore.current) router.push(`/${chainStore.current.chainName}`);
}
</script>

<template>
  <div class="dropdown">
    <label tabindex="0" class="flex items-center gap-3 cursor-pointer">
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
    </label>
    <div tabindex="0" class="dropdown-content -left-2 w-80 menu shadow-lg bg-base-100 border border-base-300/60 rounded-xl overflow-auto z-50 mt-2">
      <div class="px-4 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-secondary" v-if="chainStore.current?.endpoints?.rest">
        Rest Endpoint
      </div>
      <div
        v-for="(item, index) in chainStore.current?.endpoints?.rest"
        class="px-4 py-2.5 w-full hover:bg-base-200 cursor-pointer"
        :key="index"
        @click="changeEndpoint(item)"
      >
        <div class="flex flex-col gap-0.5">
          <div class="flex items-center justify-between w-full">
            <div class="text-sm capitalize font-medium">
              {{ item.provider }}
            </div>
            <span
              v-if="item.address === chainStore.endpoint?.address"
              class="bg-yes inline-block h-2 w-2 rounded-full"
            />
          </div>
          <div class="text-secondary text-[11px] whitespace-nowrap font-mono">
            {{ item.address }}
          </div>
        </div>
      </div>

      <div class="px-4 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">Information</div>
      <div class="w-full">
        <div class="py-2 px-4 text-sm">
          Chain Id:
          <span class="font-mono text-secondary">
            {{
              baseStore.latest.block?.header.chain_id && baseStore.connected
                ? baseStore.latest.block.header.chain_id
                : 'N/A'
            }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
