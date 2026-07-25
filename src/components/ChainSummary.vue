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

const displayName = computed(() => {
  const pretty = conf.value?.prettyName || props.name;
  return String(pretty).replace(/[-_](mainnet|testnet)$/i, '');
});

const chainId = computed(() => conf.value?.chainId || '');

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
    class="sz-chain-card group relative flex items-center gap-3.5 rounded-2xl border px-3.5 py-3.5 transition"
    :class="featured ? 'sz-chain-card--featured' : ''"
  >
    <div class="sz-chain-logo relative flex-shrink-0">
      <img
        :src="conf.logo"
        class="h-11 w-11 rounded-full object-cover bg-[#101a2e] ring-1 ring-white/10"
        alt=""
        loading="lazy"
      />
    </div>

    <div class="min-w-0 flex-1">
      <div class="truncate text-[14.5px] font-semibold tracking-tight text-slate-100 capitalize">
        {{ displayName }}
      </div>
      <div
        v-if="chainId"
        class="mt-0.5 truncate font-mono text-[11px] font-medium tracking-tight text-slate-400"
        :title="chainId"
      >
        {{ chainId }}
      </div>
      <div
        v-else
        class="mt-0.5 truncate text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400"
      >
        {{ conf?.chainName || props.name }}
      </div>
    </div>

    <button
      type="button"
      @click="addFavor"
      class="rounded-lg p-1.5 text-lg transition"
      :class="{
        'text-amber-400': dashboardStore?.favoriteMap?.[props.name],
        'text-white/25 hover:text-amber-300/90': !dashboardStore?.favoriteMap?.[props.name],
      }"
      :aria-label="dashboardStore?.favoriteMap?.[props.name] ? 'Unfavorite' : 'Favorite'"
    >
      <Icon icon="mdi-star" />
    </button>
  </RouterLink>
</template>

<style scoped>
/* Chain cards share the hero's deep-navy surface so the directory reads as one product */
.sz-chain-card {
  background:
    radial-gradient(220px 120px at 0% 0%, rgba(0, 95, 204, 0.22), transparent 60%),
    linear-gradient(150deg, #0a1020 0%, #0c1426 55%, #0e1729 100%);
  border-color: rgba(148, 163, 184, 0.14);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.05) inset,
    0 10px 24px -18px rgba(2, 6, 17, 0.8);
  overflow: hidden;
}
.sz-chain-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.05) 1px, transparent 1px);
  background-size: 34px 34px;
  mask-image: radial-gradient(ellipse 90% 80% at 20% 10%, #000 10%, transparent 70%);
  opacity: 0.5;
  pointer-events: none;
}
.sz-chain-card:hover {
  border-color: rgba(56, 189, 248, 0.45);
  background:
    radial-gradient(240px 130px at 0% 0%, rgba(0, 95, 204, 0.34), transparent 60%),
    linear-gradient(150deg, #0b1224 0%, #0d1628 55%, #101b30 100%);
  transform: translateY(-2px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.06) inset,
    0 16px 32px -18px rgba(0, 95, 204, 0.55);
}
.sz-chain-card--featured {
  border-color: rgba(56, 189, 248, 0.35);
  background:
    radial-gradient(240px 130px at 0% 0%, rgba(0, 95, 204, 0.3), transparent 60%),
    linear-gradient(150deg, #0b1224 0%, #0e1830 55%, #111d36 100%);
}
.sz-chain-logo::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 999px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.sz-chain-card:hover .sz-chain-logo::after {
  opacity: 1;
}
</style>
