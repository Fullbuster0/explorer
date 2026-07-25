<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { controlledComputed } from '@vueuse/core';

interface Props {
  title: string;
  color?: string;
  icon: string;
  stats: string;
  change?: number;
  subtitle?: string;
}

const props = withDefaults(defineProps<Props>(), {
  color: 'primary',
});

const isPositive = controlledComputed(
  () => props.change,
  () => Math.sign(props.change || 0) === 1
);
</script>

<template>
  <div class="sz-metric group">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="sz-metric-label">{{ props.title }}</div>
        <div class="sz-metric-value truncate">{{ props.stats || '—' }}</div>
        <div v-if="props.subtitle" class="sz-metric-sub truncate">{{ props.subtitle }}</div>
      </div>
      <div class="flex flex-col items-end gap-1.5 shrink-0">
        <span class="sz-metric-icon" :class="`sz-metric-icon--${props.color}`">
          <Icon :icon="props.icon" />
        </span>
        <span
          v-if="props.change"
          class="sz-chip font-mono"
          :class="isPositive ? 'sz-chip--ok' : 'sz-chip--bad'"
        >
          {{ isPositive ? `+${props.change}` : props.change }}%
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sz-metric-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  font-size: 18px;
  background: var(--sz-accent-soft);
  color: var(--sz-accent);
  transition: transform 0.18s ease;
}
.group:hover .sz-metric-icon {
  transform: translateY(-2px) scale(1.05);
}
.sz-metric-icon--error {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.sz-metric-icon--success {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}
.sz-metric-icon--warning {
  background: rgba(245, 158, 11, 0.14);
  color: #f59e0b;
}
</style>
