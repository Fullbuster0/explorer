<script lang="ts" setup>
import ApexCharts from 'vue3-apexcharts';
import { getMarketPriceChartConfig } from './apexChartConfig';
import { useIndexModule } from '@/modules/[chain]/indexStore';
import { computed, ref } from 'vue';
import { useBaseStore } from '@/stores';

const store = useIndexModule();
const baseStore = useBaseStore();
const kind = ref<'price' | 'volume'>('price');

/** Use matching timestamps for the active series (prices vs volumes). */
const activePairs = computed(() => {
  const md = store.marketData || ({} as any);
  const raw =
    kind.value === 'price'
      ? md.prices
      : md.total_volumes;
  return Array.isArray(raw) ? raw : [];
});

const chartConfig = computed(() => {
  const theme = baseStore.theme;
  const labels = activePairs.value.map((item: any) => item[0]);
  return getMarketPriceChartConfig(theme, labels);
});

const series = computed(() => [
  {
    name: kind.value === 'price' ? 'Price' : 'Volume',
    data: activePairs.value.map((item: any) => Number(item[1]) || 0),
  },
]);

/** Force Apex remount on toggle so y-axis rescales (price ~$1 vs vol ~$M). */
const chartKey = computed(() => `${kind.value}-${activePairs.value.length}`);

function changeChart(type: 'price' | 'volume') {
  if (kind.value === type) return;
  kind.value = type;
}
</script>

<template>
  <div class="sz-mkt">
    <div class="sz-mkt-head">
      <div class="sz-mkt-tabs" role="tablist" aria-label="Chart series">
        <button
          type="button"
          class="sz-mkt-tab"
          :class="{ 'sz-mkt-tab--active': kind === 'price' }"
          role="tab"
          :aria-selected="kind === 'price'"
          @click.stop="changeChart('price')"
        >
          Price
        </button>
        <button
          type="button"
          class="sz-mkt-tab"
          :class="{ 'sz-mkt-tab--active': kind === 'volume' }"
          role="tab"
          :aria-selected="kind === 'volume'"
          @click.stop="changeChart('volume')"
        >
          Volume
        </button>
      </div>
    </div>

    <div class="sz-mkt-chart">
      <ApexCharts
        :key="chartKey"
        type="area"
        height="220"
        :options="chartConfig"
        :series="series"
      />
      <div
        v-if="kind === 'volume' && activePairs.length === 0"
        class="sz-mkt-empty"
      >
        No volume data
      </div>
    </div>
  </div>
</template>

<style scoped>
.sz-mkt {
  width: 100%;
  position: relative;
  z-index: 1;
}
.sz-mkt-head {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-bottom: 0.25rem;
  position: relative;
  z-index: 2;
}
.sz-mkt-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b2)) 70%, transparent);
  pointer-events: auto;
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
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
}
.sz-mkt-tab:hover {
  color: var(--text-main);
}
.sz-mkt-tab--active {
  color: hsl(var(--pc));
  background: hsl(var(--p));
}
.sz-mkt-chart {
  position: relative;
  clear: both;
  width: 100%;
  min-height: 220px;
}
.sz-mkt-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--text-secondary);
  pointer-events: none;
}
.sz-mkt :deep(.apexcharts-tooltip) {
  border-radius: 10px !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18) !important;
}
.sz-mkt :deep(.apexcharts-canvas) {
  margin-top: 0;
}
/* keep chart svg from eating tab clicks if it overflows */
.sz-mkt :deep(.apexcharts-svg),
.sz-mkt :deep(.apexcharts-canvas) {
  max-width: 100%;
}
</style>
