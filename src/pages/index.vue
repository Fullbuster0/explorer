<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { useDashboard, LoadingStatus } from '@/stores';
import type { ChainConfig } from '@/types/chaindata';
import ChainSummary from '@/components/ChainSummary.vue';
import { computed, onMounted, onUnmounted, ref } from 'vue';

const dashboard = useDashboard();
// Home uses blank layout (no DefaultLayout) — bootstrap chains here.
dashboard.initial();

type NetworkTab = 'mainnet' | 'testnet';
const networkTab = ref<NetworkTab>('mainnet');
const keywords = ref('');

// Pause aurora while scrolling (same pattern as DefaultLayout)
const auroraPaused = ref(false);
let auroraResumeTimer: ReturnType<typeof setTimeout> | null = null;
function onWindowScroll() {
  if (!auroraPaused.value) auroraPaused.value = true;
  if (auroraResumeTimer) clearTimeout(auroraResumeTimer);
  auroraResumeTimer = setTimeout(() => {
    auroraPaused.value = false;
    auroraResumeTimer = null;
  }, 180);
}
onMounted(() => {
  window.addEventListener('scroll', onWindowScroll, { passive: true });
});
onUnmounted(() => {
  window.removeEventListener('scroll', onWindowScroll);
  if (auroraResumeTimer) clearTimeout(auroraResumeTimer);
});

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
  <!-- Clean landing (indonode-style): no sidebar, no header, no chain auto-load -->
  <div class="sz-page-shell min-h-screen text-base-content">
    <div class="sz-aurora" :class="{ 'sz-aurora--paused': auroraPaused }" aria-hidden="true">
      <span class="sz-orb sz-orb-a"></span>
      <span class="sz-orb sz-orb-b"></span>
      <span class="sz-orb sz-orb-c"></span>
      <span class="sz-orb sz-orb-d"></span>
      <span class="sz-orb sz-orb-e"></span>
      <span class="sz-orb sz-orb-f"></span>
      <span class="sz-orb sz-orb-g"></span>
      <span class="sz-orb sz-orb-h"></span>
      <span class="sz-spark sz-spark-1"></span>
      <span class="sz-spark sz-spark-2"></span>
      <span class="sz-spark sz-spark-3"></span>
      <span class="sz-spark sz-spark-4"></span>
      <span class="sz-spark sz-spark-5"></span>
      <span class="sz-spark sz-spark-6"></span>
      <span class="sz-ring sz-ring-1"></span>
      <span class="sz-ring sz-ring-2"></span>
      <span class="sz-ring sz-ring-3"></span>
      <span class="sz-ring sz-ring-4"></span>
      <span class="sz-beam sz-beam-1"></span>
      <span class="sz-beam sz-beam-2"></span>
    </div>

    <div class="relative z-10 mx-auto flex min-h-screen max-w-7xl flex-col px-4 pb-10 sm:px-6 lg:px-8">
      <!-- ===== HERO ===== -->
      <header class="sz-hero relative mb-10 pt-14 sm:pt-20">
        <div class="flex flex-col items-center text-center gap-4">
          <div class="mb-1 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary backdrop-blur-md">
            <span class="sz-live-dot"></span>
            Multi-chain · Cosmos
          </div>

          <img
            src="@/assets/logo.svg"
            alt="Shazoes"
            class="h-14 w-14 rounded-2xl bg-white/95 p-1.5 shadow-lg object-contain"
          />

          <div class="min-w-0 max-w-2xl">
            <h1 class="sz-hero-title text-[2.35rem] sm:text-5xl md:text-[3.4rem] font-extrabold tracking-tight leading-[1.05]">
              {{ $t('pages.title') }}
            </h1>
            <p class="mx-auto mt-3 max-w-xl text-[15px] sm:text-base leading-relaxed text-secondary">
              Select a network to explore.
            </p>
          </div>
        </div>
      </header>

      <div v-if="dashboard.status !== LoadingStatus.Loaded" class="mb-8 flex justify-center">
        <progress class="progress progress-info h-1 w-80"></progress>
      </div>

      <!-- ===== CHAINS ===== -->
      <section class="relative flex-1">
        <div class="relative z-10">
          <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

            <div class="sz-search flex min-w-0 flex-1 items-center rounded-xl border border-base-content/10 bg-base-100/60 px-3 backdrop-blur-md sm:max-w-md sm:flex-none sm:min-w-[280px]">
              <Icon icon="mdi:magnify" class="text-xl text-secondary" />
              <input
                :placeholder="$t('pages.search_placeholder')"
                class="h-11 flex-1 bg-transparent px-3 text-sm text-base-content outline-none placeholder:text-secondary/70"
                v-model="keywords"
              />
              <div class="px-2 text-xs tabular-nums text-secondary">
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

      <!-- minimal footer (no chrome) -->
      <footer class="mt-12 flex flex-col items-center gap-3 border-t border-base-content/10 pt-6 text-center text-[12px] text-secondary sm:flex-row sm:justify-between sm:text-left">
        <span>Maintained by Shazoes</span>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <a href="https://x.com/shazoes" target="_blank" rel="noopener noreferrer" class="hover:text-primary transition">@shazoes</a>
          <a href="https://t.me/shazoes" target="_blank" rel="noopener noreferrer" class="hover:text-primary transition">t.me/shazoes</a>
          <a href="https://services.shazoes.xyz" target="_blank" rel="noopener noreferrer" class="hover:text-primary transition">services.shazoes.xyz</a>
          <a href="mailto:hello@shazoes.xyz" class="hover:text-primary transition">hello@shazoes.xyz</a>
        </div>
      </footer>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: blank
</route>

<style scoped>
.sz-hero-title {
  letter-spacing: -0.04em;
  color: hsl(var(--bc));
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
  background: color-mix(in srgb, hsl(var(--b1)) 94%, transparent);
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
