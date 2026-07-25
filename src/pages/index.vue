<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { useDashboard, LoadingStatus } from '@/stores';
import type { ChainConfig } from '@/types/chaindata';
import ChainSummary from '@/components/ChainSummary.vue';

import { computed, ref } from 'vue';

const dashboard = useDashboard();

type NetworkTab = 'mainnet' | 'testnet';
const networkTab = ref<NetworkTab>('mainnet');
const keywords = ref('');

function isTestnet(chain: ChainConfig) {
  const nt = (chain.networkType || '').toLowerCase();
  return nt.includes('test');
}

const mainnetCount = computed(
  () => Object.values(dashboard.chains).filter((c) => !isTestnet(c)).length
);
const testnetCount = computed(
  () => Object.values(dashboard.chains).filter((c) => isTestnet(c)).length
);

const chains = computed(() => {
  const all = Object.values(dashboard.chains)
    .filter((x: ChainConfig) => (networkTab.value === 'testnet' ? isTestnet(x) : !isTestnet(x)))
    .sort((a, b) => (a.prettyName || a.chainName).localeCompare(b.prettyName || b.chainName));
  if (!keywords.value) return all;
  const q = keywords.value.toLowerCase();
  return all.filter(
    (x: ChainConfig) =>
      x.chainName.toLowerCase().includes(q) ||
      (x.prettyName || '').toLowerCase().includes(q) ||
      (x.chainId || '').toLowerCase().includes(q)
  );
});
</script>

<template>
  <div class="mx-auto max-w-7xl pb-12">
    <!-- ===== HERO — centered brand lockup ===== -->
    <section class="sz-hero relative mb-10">
      <div class="relative z-10 flex flex-col items-center text-center gap-5 px-2 pt-10 pb-6 sm:px-4 sm:pt-14">
        <div class="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary backdrop-blur-md">
          <span class="sz-live-dot"></span>
          Multi-chain · Cosmos
        </div>

        <span class="sz-hero-logo">
          <img src="@/assets/logo.png" alt="Shazoes" class="h-14 w-14 object-contain" />
        </span>

        <div class="min-w-0 max-w-2xl">
          <h1 class="sz-hero-title text-[2.35rem] sm:text-5xl md:text-[3.4rem] font-extrabold tracking-tight leading-[1.05]">
            {{ $t('pages.title') }}
          </h1>
          <p class="mx-auto mt-3 max-w-xl text-[15px] sm:text-base leading-relaxed text-secondary">
            {{ $t('pages.slogan') }}
          </p>
        </div>

        <div class="flex flex-wrap items-center justify-center gap-2.5">
          <div class="sz-stat">
            <span class="sz-stat-value">{{ mainnetCount }}</span>
            <span class="sz-stat-label">Mainnets</span>
          </div>
          <div class="sz-stat">
            <span class="sz-stat-value">{{ testnetCount }}</span>
            <span class="sz-stat-label">Testnets</span>
          </div>
          <div class="sz-stat">
            <span class="sz-live-dot"></span>
            <span class="sz-stat-label">Live</span>
          </div>
        </div>
      </div>
    </section>

    <div v-if="dashboard.status !== LoadingStatus.Loaded" class="flex justify-center mb-8">
      <progress class="progress progress-info w-80 h-1"></progress>
    </div>

    <!-- ===== CHAINS — transparent, no navy panel ===== -->
    <section class="relative">
      <div class="relative z-10">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
          <div class="sz-net-tabs" role="tablist" aria-label="Network type">
            <button
              type="button"
              role="tab"
              class="sz-net-tab"
              :class="{ 'is-active': networkTab === 'mainnet' }"
              :aria-selected="networkTab === 'mainnet'"
              @click="networkTab = 'mainnet'"
            >
              Mainnets
              <span class="sz-net-count">{{ mainnetCount }}</span>
            </button>
            <button
              type="button"
              role="tab"
              class="sz-net-tab"
              :class="{ 'is-active': networkTab === 'testnet' }"
              :aria-selected="networkTab === 'testnet'"
              @click="networkTab = 'testnet'"
            >
              Testnets
              <span class="sz-net-count">{{ testnetCount }}</span>
            </button>
          </div>

          <div class="sz-search flex items-center rounded-xl border border-base-content/10 bg-base-100/60 px-3 backdrop-blur-md min-w-0 sm:min-w-[280px] sm:max-w-md flex-1 sm:flex-none">
            <Icon icon="mdi:magnify" class="text-xl text-secondary" />
            <input
              :placeholder="$t('pages.search_placeholder')"
              class="px-3 h-11 bg-transparent flex-1 outline-none text-sm text-base-content placeholder:text-secondary/70"
              v-model="keywords"
            />
            <div class="px-2 text-xs text-secondary tabular-nums">
              {{ chains.length }}
            </div>
          </div>
        </div>

        <div
          v-if="chains.length === 0"
          class="rounded-xl border border-dashed border-base-content/15 bg-base-100/40 px-6 py-14 text-center text-sm text-secondary backdrop-blur-md"
        >
          No {{ networkTab === 'mainnet' ? 'mainnets' : 'testnets' }} match your search.
        </div>

        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:!grid-cols-3 lg:!grid-cols-4 2xl:!grid-cols-5">
          <ChainSummary v-for="(chain, index) in chains" :key="chain.chainName + '-' + index" :name="chain.chainName" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Hero is fully transparent — the animated block field floats behind the type */
.sz-hero-title {
  letter-spacing: -0.04em;
  color: hsl(var(--bc));
}
.sz-hero-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  border-radius: 18px;
  background: hsl(var(--b1));
  border: 1px solid var(--sz-border);
  box-shadow: 0 12px 28px -12px var(--sz-glow);
  flex-shrink: 0;
  overflow: hidden;
  padding: 8px;
  backdrop-filter: blur(10px);
}
.sz-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.48rem 0.85rem;
  border-radius: 999px;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b1)) 55%, transparent);
  backdrop-filter: blur(10px);
}
.sz-stat-value {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.95rem;
  font-weight: 700;
  color: hsl(var(--bc));
  letter-spacing: -0.02em;
}
.sz-stat-label {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-secondary);
}

.sz-search:focus-within {
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, transparent);
  box-shadow: 0 0 0 3px var(--sz-glow);
}

.sz-net-tabs {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 0.9rem;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b1)) 55%, transparent);
  backdrop-filter: blur(10px);
}
.sz-net-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.48rem 0.95rem;
  border-radius: 0.7rem;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.sz-net-tab:hover {
  color: hsl(var(--bc));
  background: color-mix(in srgb, hsl(var(--bc)) 6%, transparent);
}
.sz-net-tab.is-active {
  color: hsl(var(--pc));
  background: hsl(var(--p));
  box-shadow: 0 8px 18px -10px var(--sz-glow);
}
.sz-net-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.35rem;
  height: 1.2rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
}
.sz-net-tab.is-active .sz-net-count {
  background: color-mix(in srgb, hsl(var(--pc)) 18%, transparent);
}
</style>
