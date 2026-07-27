<script lang="ts" setup>
import ApexCharts from 'vue3-apexcharts';
import { computed } from 'vue';
import { useBaseStore } from '@/stores';
import { getDonutChartConfig } from './apexChartConfig';

const props = withDefaults(
  defineProps<{
    series: number[];
    /** ApexCharts' labels array. Apex itself tolerates undefined entries
     *  (they're skipped in tooltips), so we accept the loose shape to keep
     *  other consumers (wallet portfolio) compiling without churn. */
    labels: (string | undefined)[];
    /** Optional override for the slice colors. Must align positionally
     *  with `labels`. When omitted, the shared default palette is used. */
    colors?: string[];
  }>(),
  { colors: undefined }
);

const baseStore = useBaseStore();

const expenseRationChartConfig = computed(() => {
  const theme = baseStore.theme;
  return getDonutChartConfig(theme, props?.labels, props?.colors);
});
</script>

<template>
  <ApexCharts type="donut" height="410" :options="expenseRationChartConfig" :series="series" />
</template>
