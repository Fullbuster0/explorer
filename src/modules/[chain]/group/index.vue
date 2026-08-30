<!-- This route was a leftover developer scratchpad: it ran hardcoded
     fromBech32/toBech32 conversions at module scope and console.log'd the
     results, rendering the bare string "address:". Module-scope bech32 calls
     are also a latent crash (an encoding throw there takes the route down).
     x/group browsing is not implemented, so render an honest not-available
     state. The route is unlinked from the sidebar (no `meta.i18n`). -->
<script lang="ts" setup>
import { useBlockchain } from '@/stores';

const chainStore = useBlockchain();
</script>

<template>
  <div class="sz-section overflow-hidden">
    <div class="sz-section-head">
      <div>
        <div class="sz-section-kicker">ON-CHAIN</div>
        <div class="sz-section-title">Groups</div>
      </div>
    </div>
    <div class="px-6 py-10 text-center">
      <div class="text-3xl mb-3 opacity-40">◇</div>
      <div class="font-semibold text-main mb-1">Group browsing is not available</div>
      <p class="text-secondary text-[13px] max-w-md mx-auto">
        The <span class="font-mono">x/group</span> module explorer is not implemented for
        <span class="font-mono">{{ chainStore.chainName }}</span>. Use governance or
        transactions to inspect on-chain activity.
      </p>
      <div class="mt-6 flex justify-center gap-2">
        <RouterLink class="btn btn-primary btn-sm" :to="`/${chainStore.chainName}/gov`">
          Governance
        </RouterLink>
        <RouterLink class="btn btn-sm" :to="`/${chainStore.chainName}`">Dashboard</RouterLink>
      </div>
    </div>
  </div>
</template>
