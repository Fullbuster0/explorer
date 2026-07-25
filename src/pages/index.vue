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
    <!-- ===== HERO ===== -->
    <section class="sz-hero relative overflow-hidden mb-10">
      <div class="sz-hero-grid" aria-hidden="true"></div>
      <div class="sz-hero-glow sz-hero-glow--a" aria-hidden="true"></div>
      <div class="sz-hero-glow sz-hero-glow--b" aria-hidden="true"></div>

      <div class="relative z-10 flex flex-col gap-7 px-6 py-11 sm:px-10 sm:py-14">
        <div class="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/90">
          <span class="sz-live-dot"></span>
          Multi-chain · Cosmos
        </div>

        <div class="flex flex-col gap-5 sm:flex-row sm:items-center">
          <span class="sz-hero-logo">
            <img src="@/assets/logo.png" alt="Shazoes" class="h-12 w-12 object-contain" />
          </span>
          <div class="min-w-0">
            <h1 class="sz-hero-title text-[2.35rem] sm:text-5xl md:text-[3.4rem] font-extrabold tracking-tight text-white leading-[1.05]">
              {{ $t('pages.title') }}
            </h1>
            <p class="mt-3 max-w-xl text-[15px] sm:text-base leading-relaxed text-slate-300/90">
              {{ $t('pages.slogan') }}
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
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

    <!-- ===== SUPPORTED CHAINS ===== -->
    <section class="sz-home-panel">
      <div class="mb-5 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div class="sz-section-kicker">Network directory</div>
          <h2 class="text-xl sm:text-2xl font-bold tracking-tight text-base-content">Supported Chains</h2>
        </div>
        <div class="text-xs text-secondary tabular-nums hidden sm:block">
          {{ chains.length }} shown · {{ networkTab === 'mainnet' ? mainnetCount : testnetCount }} total
        </div>
      </div>

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

        <div class="sz-search flex items-center rounded-xl border border-base-content/10 bg-base-100/80 px-3 min-w-0 sm:min-w-[280px] sm:max-w-md flex-1 sm:flex-none">
          <Icon icon="mdi:magnify" class="text-xl text-secondary" />
          <input
            :placeholder="$t('pages.search_placeholder')"
            class="px-3 h-11 bg-transparent flex-1 outline-none text-sm"
            v-model="keywords"
          />
          <div class="px-2 text-xs text-secondary tabular-nums sm:!hidden">
            {{ chains.length }}
          </div>
        </div>
      </div>

      <div
        v-if="chains.length === 0"
        class="rounded-xl border border-dashed border-base-content/15 bg-base-100/40 px-6 py-14 text-center text-sm text-secondary"
      >
        No {{ networkTab === 'mainnet' ? 'mainnets' : 'testnets' }} match your search.
      </div>

      <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:!grid-cols-3 lg:!grid-cols-4 2xl:!grid-cols-5">
        <ChainSummary v-for="(chain, index) in chains" :key="chain.chainName + '-' + index" :name="chain.chainName" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.sz-hero {
  border-radius: 22px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  background:
    radial-gradient(900px 320px at 12% -20%, rgba(0, 95, 204, 0.38), transparent 55%),
    radial-gradient(700px 280px at 92% 110%, rgba(118, 75, 200, 0.28), transparent 52%),
    linear-gradient(155deg, #070b14 0%, #0a1020 48%, #0d1324 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 28px 60px -32px rgba(0, 0, 0, 0.65);
}
.sz-hero-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.06) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 20%, transparent 75%);
  opacity: 0.55;
  pointer-events: none;
}
.sz-hero-glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(48px);
  pointer-events: none;
}
.sz-hero-glow--a {
  right: -4rem;
  top: -3rem;
  width: 18rem;
  height: 18rem;
  background: rgba(56, 189, 248, 0.18);
}
.sz-hero-glow--b {
  left: 20%;
  bottom: -6rem;
  width: 16rem;
  height: 16rem;
  background: rgba(167, 139, 250, 0.14);
}
.sz-hero-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.97);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08),
    0 12px 28px -10px rgba(0, 95, 204, 0.55);
  flex-shrink: 0;
  overflow: hidden;
  padding: 8px;
}
.sz-hero-title {
  letter-spacing: -0.04em;
  color: #f8fafc;
}
.sz-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.48rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(8px);
}
.sz-stat-value {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.95rem;
  font-weight: 700;
  color: #e2e8f0;
  letter-spacing: -0.02em;
}
.sz-stat-label {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #94a3b8;
}
.sz-home-panel {
  border-radius: 20px;
  border: 1px solid var(--sz-border, rgba(148, 163, 184, 0.12));
  background: color-mix(in srgb, hsl(var(--b1)) 88%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  padding: 1.25rem 1.15rem 1.35rem;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset;
}
@media (min-width: 640px) {
  .sz-home-panel {
    padding: 1.5rem 1.5rem 1.65rem;
  }
}
.sz-search:focus-within {
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, hsl(var(--p)) 16%, transparent);
}

.sz-net-tabs {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 0.9rem;
  border: 1px solid var(--sz-border, rgba(148, 163, 184, 0.14));
  background: color-mix(in srgb, hsl(var(--b2)) 70%, transparent);
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
  color: var(--text-secondary, #94a3b8);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.sz-net-tab:hover {
  color: var(--text-primary, #e2e8f0);
  background: color-mix(in srgb, hsl(var(--p)) 8%, transparent);
}
.sz-net-tab.is-active {
  color: hsl(var(--pc, 0 0% 100%));
  background: hsl(var(--p));
  box-shadow: 0 8px 18px -10px color-mix(in srgb, hsl(var(--p)) 75%, transparent);
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
  background: color-mix(in srgb, #fff 22%, transparent);
}
</style>
