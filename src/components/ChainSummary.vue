<script lang="ts" setup>
import { useDashboard } from '@/stores';
import { computed } from 'vue';
import { Icon } from '@iconify/vue';

const props = defineProps({
  name: {
    type: String,
    required: true,
  },
  featured: {
    type: Boolean,
    default: false,
  },
});

const dashboardStore = useDashboard();
const conf = computed(() => dashboardStore.chains[props.name] || {});

const addFavor = (e: Event) => {
  e.stopPropagation();
  e.preventDefault();
  dashboardStore.favoriteMap[props.name] = !dashboardStore?.favoriteMap?.[props.name];
  window.localStorage.setItem('favoriteMap', JSON.stringify(dashboardStore.favoriteMap));
};
</script>

<template>
  <RouterLink
    :to="`/${name}`"
    class="sz-chain-card group relative flex items-center gap-3.5 rounded-xl border px-3.5 py-3.5 transition"
    :class="featured ? 'sz-chain-card--featured' : ''"
  >
    <div class="sz-chain-logo relative flex-shrink-0">
      <img :src="conf.logo" class="h-10 w-10 rounded-full object-cover" alt="" />
    </div>

    <div class="min-w-0 flex-1">
      <div class="truncate text-[14.5px] font-semibold capitalize tracking-tight text-base-content">
        {{ conf?.prettyName || props.name }}
      </div>
      <div class="mt-0.5 truncate text-[11px] font-medium uppercase tracking-[0.14em] text-secondary">
        {{ conf?.chainName || props.name }}
      </div>
    </div>

    <button
      type="button"
      @click="addFavor"
      class="rounded-lg p-1.5 text-lg transition"
      :class="{
        'text-amber-400': dashboardStore?.favoriteMap?.[props.name],
        'text-base-content/25 hover:text-amber-400/80': !dashboardStore?.favoriteMap?.[props.name],
      }"
      :aria-label="dashboardStore?.favoriteMap?.[props.name] ? 'Unfavorite' : 'Favorite'"
    >
      <Icon icon="mdi-star" />
    </button>
  </RouterLink>
</template>

<style scoped>
.sz-chain-card {
  background: hsl(var(--b1));
  border-color: var(--sz-border, rgba(148, 163, 184, 0.14));
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset;
}
.sz-chain-card:hover {
  border-color: color-mix(in srgb, hsl(var(--p)) 40%, transparent);
  background: color-mix(in srgb, hsl(var(--b1)) 92%, hsl(var(--p)));
  transform: translateY(-1px);
  box-shadow: 0 10px 24px -16px rgba(0, 95, 204, 0.45);
}
.sz-chain-card--featured {
  background:
    linear-gradient(135deg, color-mix(in srgb, hsl(var(--p)) 8%, hsl(var(--b1))) 0%, hsl(var(--b1)) 100%);
  border-color: color-mix(in srgb, hsl(var(--p)) 22%, transparent);
}
.sz-chain-logo::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, hsl(var(--p)) 25%, transparent);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.sz-chain-card:hover .sz-chain-logo::after {
  opacity: 1;
}
</style>
