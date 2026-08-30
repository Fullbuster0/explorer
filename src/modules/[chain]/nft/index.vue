<!-- No mint msg is indexed on any of the configured chains yet, so there is no
     NFT data source to render. This route is not linked from the sidebar (no
     `meta.i18n`) and is only reachable by typing the URL — it used to render the
     bare string "NFT", which reads as a broken page. Show an honest
     not-available state instead. -->
<script lang="ts" setup>
import { useBlockchain } from '@/stores';

const chainStore = useBlockchain();
</script>

<template>
  <div class="sz-section overflow-hidden">
    <div class="sz-section-head">
      <div>
        <div class="sz-section-kicker">ASSETS</div>
        <div class="sz-section-title">NFT</div>
      </div>
    </div>
    <div class="px-6 py-10 text-center">
      <div class="text-3xl mb-3 opacity-40">◇</div>
      <div class="font-semibold text-main mb-1">NFT indexing is not available on this chain</div>
      <p class="text-secondary text-[13px] max-w-md mx-auto">
        This explorer does not index NFT mints or collections for
        <span class="font-mono">{{ chainStore.chainName }}</span>. Browse
        transactions or CosmWasm contracts instead.
      </p>
      <div class="mt-6 flex justify-center gap-2">
        <RouterLink class="btn btn-primary btn-sm" :to="`/${chainStore.chainName}/tx`">
          Transactions
        </RouterLink>
        <RouterLink class="btn btn-sm" :to="`/${chainStore.chainName}`">Dashboard</RouterLink>
      </div>
    </div>
  </div>
</template>
