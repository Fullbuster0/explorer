<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useBaseStore, useFormatter } from '@/stores';
import TxsInBlocksChart from '@/components/charts/TxsInBlocksChart.vue';

const props = defineProps(['chain']);

const tab = ref('blocks');

const base = useBaseStore();

const format = useFormatter();

const list = computed(() => {
  return base.recents;
});
</script>
<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Chain</div>
        <h1 class="sz-page-title">{{ $t('module.blocks') }}</h1>
        <div class="sz-page-sub flex items-center gap-2">
          <span class="sz-live-dot"></span>
          <span>{{ $t('block.recent') }} · #{{ Number(base.latest?.block?.header?.height || 0).toLocaleString() }}</span>
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'blocks' }" @click="tab = 'blocks'">
          {{ $t('block.recent') }}
        </a>
        <RouterLink class="sz-tab" :to="`/${chain}/block/${Number(base.latest?.block?.header.height || 0) + 10000}`">
          {{ $t('block.future') }}
        </RouterLink>
      </div>
    </div>

    <div v-show="tab === 'blocks'">
      <TxsInBlocksChart />

      <div class="grid grid-cols-1 gap-3 md:!grid-cols-4 xl:!grid-cols-6 mt-4">
        <RouterLink
          v-for="item in list"
          :key="item.block.header.height"
          class="sz-block-card"
          :to="`/${chain}/block/${item.block.header.height}`"
        >
          <div class="flex items-start justify-between gap-2">
            <span class="sz-block-height">#{{ item.block.header.height }}</span>
            <span class="sz-chip sz-chip--ok font-mono !text-[10px]">
              {{ item.block?.data?.txs.length }} tx
            </span>
          </div>
          <div class="min-w-0">
            <div class="truncate text-[11.5px] text-secondary" :title="format.validator(item.block?.header?.proposer_address)">
              {{ format.validator(item.block?.header?.proposer_address) }}
            </div>
            <div class="mt-0.5 text-[11px] font-medium text-green-600">
              {{ format.toDay(item.block?.header?.time, 'from') }}
            </div>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<route>
    {
      meta: {
        i18n: 'blocks',
        order: 5
      }
    }
  </route>
