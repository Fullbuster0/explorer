<script setup lang="ts">
import ApexCharts from 'vue3-apexcharts';
import { computed, type PropType } from 'vue';
import { useFormatter } from '@/stores';
import type { CommissionRate } from '@/types';

const props = defineProps({
  commission: { type: Object as PropType<CommissionRate> },
  /** When true, drop outer card chrome — used inside merged Commission & Earnings panel. */
  embedded: { type: Boolean, default: false },
});

let rate = computed(() => Number(props.commission?.commission_rates.rate || 0) * 100);
let change = computed(() => Number(props.commission?.commission_rates.max_change_rate || 0) * 100);
let max = computed(() => Number(props.commission?.commission_rates.max_rate || 1) * 100);

const left = rate;
const right = computed(() => max.value - rate.value);

const s1 = computed(() => (left.value > change.value ? left.value - change.value : 0));
const s2 = computed(() => (left.value > change.value ? change.value : left.value));
const s3 = 2;
const s4 = computed(() => (right.value > change.value ? change.value : right.value));
const s5 = computed(() => (right.value > change.value ? right.value - change.value : 0));

const series = computed(() => [s1.value, s2.value, s3, s4.value, s5.value]);

const format = useFormatter();

const chartConfig = computed(() => {
  const secondaryText = `hsl(var(--bc))`;
  const primaryText = `hsl(var(--bc))`;

  return {
    chart: {
      width: props.embedded ? '180px' : '200px',
      sparkline: { enabled: false },
    },
    colors: [
      'rgba(109,120,141,0.2)',
      'rgba(114,225,40,0.2)',
      'rgba(114,225,40,1)',
      'rgba(114,225,40,0.2)',
      'rgba(109,120,141,0.2)',
    ],
    legend: { show: false },
    tooltip: { enabled: false },
    dataLabels: { enabled: false },
    stroke: {
      width: 3,
      lineCap: 'round',
      colors: ['hsl(var(--b1))'],
    },
    labels: ['Available', 'Daily Change', 'Commission Rate', 'Daily Change', 'Available'],
    states: {
      hover: {
        filter: { type: 'none' },
      },
      active: {
        filter: { type: 'none' },
      },
    },
    plotOptions: {
      pie: {
        endAngle: 130,
        startAngle: -130,
        customScale: 0.9,
        donut: {
          size: '83%',
          labels: {
            show: true,
            name: {
              offsetY: 25,
              fontSize: '0.9rem',
              color: secondaryText,
            },
            value: {
              offsetY: -15,
              fontWeight: 500,
              fontSize: props.embedded ? '1.75rem' : '2.125rem',
              formatter: (value: unknown) => `${rate.value.toFixed(1)}%`,
              color: primaryText,
            },
            total: {
              show: true,
              label: 'Commission Rate',
              fontSize: '0.9rem',
              color: secondaryText,
              formatter: () => `${rate.value.toFixed(1)}%`,
            },
          },
        },
      },
    },
    responsive: [
      {
        breakpoint: 1709,
        options: {
          chart: { height: props.embedded ? 210 : 237 },
        },
      },
    ],
  };
});
</script>

<template>
  <div :class="embedded ? 'sz-comm-embedded' : 'bg-base-100 rounded shadow p-4'">
    <template v-if="!embedded">
      <div class="text-lg text-main font-semibold mb-1">Commission Rate</div>
      <div class="text-sm text-gray-500 dark:text-gray-400">
        {{ `Updated at ${format.toDay(props.commission?.update_time, 'short')}` }}
      </div>
    </template>
    <div v-else class="text-[11px] text-secondary text-center mb-1">
      Updated {{ format.toDay(props.commission?.update_time, 'short') }}
    </div>
    <div :class="embedded ? 'w-full max-w-[17rem] m-auto' : 'w-80 m-auto'">
      <ApexCharts type="donut" :options="chartConfig" :series="series" />
    </div>
    <div>
      <div class="flex items-center justify-center flex-wrap gap-x-3">
        <div class="flex items-center gap-x-2">
          <div class="bg-success w-[6px] h-[6px] rounded-full"></div>
          <span class="text-caption">Rate:{{ rate.toFixed(0) }}%</span>
        </div>
        <div class="flex items-center gap-x-2">
          <div class="bg-success w-[6px] h-[6px] rounded-full opacity-60"></div>
          <span class="text-caption">24h: ±{{ change }}%</span>
        </div>
        <div class="flex items-center gap-x-2">
          <div class="bg-secondary w-[6px] h-[6px] rounded-full"></div>
          <span class="text-caption">Max:{{ max }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>
