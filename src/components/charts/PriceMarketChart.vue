<script lang="ts" setup>
import ApexCharts from 'vue3-apexcharts';
import { getMarketPriceChartConfig } from './apexChartConfig';
import { useIndexModule } from '@/modules/[chain]/indexStore';
import { computed, ref } from 'vue';
import { useBaseStore } from '@/stores';

const store = useIndexModule();
const baseStore = useBaseStore();
const kind = ref<'price' | 'volume'>('price');

const chartConfig = computed(() => {
  const theme = baseStore.theme;
  const labels = store.marketData.prices.map((item: any) => item[0]);
  return getMarketPriceChartConfig(theme, labels);
});

const series = computed(() => [
  {
    name: kind.value === 'price' ? 'Price' : 'Volume',
    data:
      kind.value === 'price'
        ? store.marketData.prices.map((item: any) => item[1])
        : store.marketData.total_volumes.map((item: any) => item[1]),
  },
]);

function changeChart(type: 'price' | 'volume') {
  kind.value = type;
}
</script>

<template>
  <div class="sz-mkt">
    <div class="sz-mkt-tabs" role="tablist" aria-label="Chart series">
      <button
        type="button"
        class="sz-mkt-tab"
        :class="{ 'sz-mkt-tab--active': kind === 'price' }"
        role="tab"
        :aria-selected="kind === 'price'"
        @click="changeChart('price')"
      >
        Price
      </button>
      <button
        type="button"
        class="sz-mkt-tab"
        :class="{ 'sz-mkt-tab--active': kind === 'volume' }"
        role="tab"
        :aria-selected="kind === 'volume'"
        @click="changeChart('volume')"
      >
        Volume
      </button>
    </div>
    <ApexCharts type="area" height="220" :options="chartConfig" :series="series" />
  </div>
</template>

<style scoped>
.sz-mkt {
  width: 100%;
}
.sz-mkt-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  margin: 0 0 0.35rem auto;
  border-radius: 999px;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b2)) 70%, transparent);
  float: right;
}
.sz-mkt-tab {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.28rem 0.7rem;
  border-radius: 999px;
  cursor: pointer;
  line-height: 1.2;
  transition: color 0.15s ease, background 0.15s ease;
}
.sz-mkt-tab:hover {
  color: var(--text-main);
}
.sz-mkt-tab--active {
  color: hsl(var(--pc));
  background: hsl(var(--p));
}
.sz-mkt :deep(.apexcharts-tooltip) {
  border-radius: 10px !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18) !important;
}
.sz-mkt :deep(.apexcharts-canvas) {
  margin-top: 0.15rem;
}
</style>
