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
    <section class="sz-home-panel relative overflow-hidden">
      <div class="sz-home-panel-grid" aria-hidden="true"></div>
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

          <div class="sz-search flex items-center rounded-xl border border-white/10 bg-white/[0.04] px-3 min-w-0 sm:min-w-[280px] sm:max-w-md flex-1 sm:flex-none">
            <Icon icon="mdi:magnify" class="text-xl text-slate-400" />
            <input
              :placeholder="$t('pages.search_placeholder')"
              class="px-3 h-11 bg-transparent flex-1 outline-none text-sm text-slate-100 placeholder:text-slate-500"
              v-model="keywords"
            />
            <div class="px-2 text-xs text-slate-400 tabular-nums">
              {{ chains.length }}
            </div>
          </div>
        </div>

        <div
          v-if="chains.length === 0"
          class="rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-6 py-14 text-center text-sm text-slate-400"
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
/* Same deep-navy surface as the hero card */
.sz-home-panel {
  border-radius: 20px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  background:
    radial-gradient(900px 320px at 12% -20%, rgba(0, 95, 204, 0.38), transparent 55%),
    radial-gradient(700px 280px at 92% 110%, rgba(118, 75, 200, 0.28), transparent 52%),
    linear-gradient(155deg, #070b14 0%, #0a1020 48%, #0d1324 100%);
  padding: 1.25rem 1.15rem 1.35rem;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 28px 60px -32px rgba(0, 0, 0, 0.55);
}
.sz-home-panel-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.06) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 20%, transparent 75%);
  opacity: 0.45;
  pointer-events: none;
}
.sz-panel-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(125, 211, 252, 0.85);
  margin-bottom: 0.25rem;
}
@media (min-width: 640px) {
  .sz-home-panel {
    padding: 1.5rem 1.5rem 1.65rem;
  }
}
.sz-search:focus-within {
  border-color: rgba(56, 189, 248, 0.45);
  box-shadow: 0 0 0 3px rgba(0, 95, 204, 0.18);
}

.sz-net-tabs {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 0.9rem;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(255, 255, 255, 0.04);
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
  color: #94a3b8;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.sz-net-tab:hover {
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.05);
}
.sz-net-tab.is-active {
  color: #0a0e27;
  background: #99ccff;
  box-shadow: 0 8px 18px -10px rgba(0, 95, 204, 0.75);
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
  background: rgba(10, 14, 39, 0.12);
}
</style>
