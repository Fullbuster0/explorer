<script lang="ts" setup>
import { useParamStore } from '@/stores';
import { ref, onMounted } from 'vue';
import CardParameter from '@/components/CardParameter.vue';
import ArrayObjectElement from '@/components/dynamic/ArrayObjectElement.vue';
import Loading from '@/components/Loading.vue';
const store = useParamStore();
const chain = ref(store.chain);

const chainLoading = ref(true);
const stakingLoading = ref(true);
const govLoading = ref(true);
const distributionLoading = ref(true);
const slashingLoading = ref(true);
const abciLoading = ref(true);

onMounted(() => {
  store.handleBaseBlockLatest().finally(() => (chainLoading.value = false));
  store.handleStakingParams().finally(() => (stakingLoading.value = false));
  store.handleGovernanceParams().finally(() => (govLoading.value = false));
  store.handleDistributionParams().finally(() => (distributionLoading.value = false));
  store.handleSlashingParams().finally(() => (slashingLoading.value = false));
  store.handleAbciInfo().finally(() => (abciLoading.value = false));
});
</script>
<template>
  <div class="overflow-hidden">
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Chain</div>
        <h1 class="sz-page-title">{{ $t('module.parameters') }}</h1>
        <div class="sz-page-sub">On-chain module parameters</div>
      </div>
    </div>

    <!-- Chain ID -->
    <div class="sz-section px-4 pt-3 pb-4">
      <div class="sz-section-title mb-3">{{ chain.title || 'Chain ID' }}</div>
      <Loading v-if="chainLoading" :bordered="false" />
      <div v-else class="grid grid-cols-2 gap-3 md:!grid-cols-4 lg:!grid-cols-5 2xl:!grid-cols-6">
        <div v-for="(item, index) of chain.items" :key="index" class="rounded-lg bg-base-200/60 border border-base-content/5 px-4 py-2.5">
          <div class="sz-metric-label mb-1.5">{{ item.subtitle }}</div>
          <div class="text-sm font-semibold text-main font-mono break-all">{{ item.value }}</div>
        </div>
      </div>
    </div>
    <!-- minting Parameters  -->
    <CardParameter :cardItem="store.mint" />
    <!-- Staking Parameters  -->
    <CardParameter :cardItem="store.staking" :loading="stakingLoading" />
    <!-- Governance Parameters -->
    <CardParameter :cardItem="store.gov" :loading="govLoading" />
    <!-- Distribution Parameters -->
    <CardParameter :cardItem="store.distribution" :loading="distributionLoading" />
    <!-- Slashing Parameters -->
    <CardParameter :cardItem="store.slashing" :loading="slashingLoading" />
    <!-- Application Version -->
    <div class="sz-section px-4 pt-3 pb-4 mt-4">
      <div class="sz-section-title mb-3">{{ store.appVersion?.title }}</div>
      <Loading v-if="abciLoading" :bordered="false" />
      <ArrayObjectElement v-else :value="store.appVersion?.items" :thead="false" />
    </div>

    <!-- Node Information -->
    <div class="sz-section px-4 pt-3 pb-4 mt-4">
      <div class="sz-section-title mb-3">{{ store.nodeVersion?.title }}</div>
      <Loading v-if="abciLoading" :bordered="false" />
      <ArrayObjectElement v-else :value="store.nodeVersion?.items" :thead="false" />
    </div>
  </div>
</template>

<route>
{
  meta: {
    i18n: 'parameters',
    order: 50
  }
}
</route>
