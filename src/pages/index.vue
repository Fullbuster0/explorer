<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { useDashboard, LoadingStatus } from '@/stores';
import type { ChainConfig } from '@/types/chaindata';
import ChainSummary from '@/components/ChainSummary.vue';

import { computed, ref } from 'vue';
import { useBlockchain } from '@/stores';

const dashboard = useDashboard();

const keywords = ref('');
const chains = computed(() => {
  if (keywords.value) {
    const lowercaseKeywords = keywords.value.toLowerCase();

    return Object.values(dashboard.chains).filter(
      (x: ChainConfig) =>
        x.chainName.toLowerCase().indexOf(lowercaseKeywords) > -1 ||
        x.prettyName.toLowerCase().indexOf(lowercaseKeywords) > -1
    );
  } else {
    return Object.values(dashboard.chains);
  }
});

const featured = computed(() => {
  // Prefer chains we operate / maintain; fall back to whatever is loaded.
  const names = ['atomone', 'cosmos', 'osmosis', 'axelar', 'neutron', 'xion', 'kiichain', 'nolus'];
  return chains.value
    .filter((x) => names.includes(x.chainName))
    .sort((a, b) => names.indexOf(a.chainName) - names.indexOf(b.chainName));
});

const chainStore = useBlockchain();
</script>

<template>
  <div class="mx-auto max-w-7xl pb-10">
    <!-- ===== HERO ===== -->
    <section class="sz-hero relative overflow-hidden rounded-2xl px-6 py-12 sm:px-10 sm:py-16 mb-10">
      <div class="relative z-10 flex flex-col items-start gap-5 max-w-2xl">
        <div class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-sky-300">
          <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          Multi-chain · Cosmos
        </div>

        <div class="flex items-center gap-4">
          <span class="sz-hero-logo">
            <img src="@/assets/logo.svg" alt="Shazoes" class="h-10 w-10" />
          </span>
          <h1 class="sz-hero-title text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-white">
            {{ $t('pages.title') }}
          </h1>
        </div>

        <p class="text-base sm:text-lg text-slate-300 leading-relaxed max-w-xl">
          {{ $t('pages.slogan') }}
        </p>

        <!-- live network stats -->
        <div class="flex flex-wrap items-center gap-2.5 pt-1">
          <div class="sz-stat">
            <span class="sz-stat-value">{{ dashboard.length }}</span>
            <span class="sz-stat-label">Networks</span>
          </div>
          <div class="sz-stat">
            <span class="sz-stat-value">{{ featured.length }}</span>
            <span class="sz-stat-label">Curated</span>
          </div>
          <div class="sz-stat">
            <span class="sz-live-dot"></span>
            <span class="sz-stat-label">Live</span>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3 pt-1">
          <a
            href="https://services.shazoes.xyz"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-content shadow-lg shadow-primary/25 hover:brightness-110 transition"
          >
            <Icon icon="mdi:server" class="text-lg" />
            Services
          </a>
          <a
            href="https://github.com/Fullbuster0/explorer"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10 transition"
          >
            <Icon icon="mdi:github" class="text-lg" />
            GitHub
          </a>
        </div>
      </div>

      <!-- ambient glow -->
      <div class="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-sky-500/20 blur-3xl"></div>
      <div class="pointer-events-none absolute -bottom-24 right-10 h-64 w-64 rounded-full bg-violet-500/15 blur-3xl"></div>
    </section>

    <div v-if="dashboard.status !== LoadingStatus.Loaded" class="flex justify-center mb-8">
      <progress class="progress progress-info w-80 h-1"></progress>
    </div>

    <!-- ===== FEATURED ===== -->
    <section v-if="featured.length > 0" class="mb-12">
      <div class="mb-5 flex items-end justify-between gap-3">
        <div>
          <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-primary mb-1">Curated</div>
          <h2 class="text-xl sm:text-2xl font-bold tracking-tight">Featured Networks</h2>
        </div>
        <div class="text-xs text-secondary tabular-nums">{{ featured.length }} chains</div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:!grid-cols-3 lg:!grid-cols-4">
        <ChainSummary v-for="(chain, index) in featured" :key="'f-' + index" :name="chain.chainName" featured />
      </div>
    </section>

    <!-- ===== ALL CHAINS ===== -->
    <section>
      <div class="mb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-primary mb-1">Directory</div>
          <h2 class="text-xl sm:text-2xl font-bold tracking-tight">{{ $t('pages.description') }}</h2>
        </div>
      </div>

      <div class="sz-search mb-6 flex items-center rounded-xl border border-base-content/10 bg-base-100 px-3">
        <Icon icon="mdi:magnify" class="text-xl text-secondary" />
        <input
          :placeholder="$t('pages.search_placeholder')"
          class="px-3 h-11 bg-transparent flex-1 outline-none text-sm"
          v-model="keywords"
        />
        <div class="px-2 text-xs text-secondary tabular-nums hidden sm:!block">
          {{ chains.length }}/{{ dashboard.length }}
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:!grid-cols-3 lg:!grid-cols-4 2xl:!grid-cols-5">
        <ChainSummary v-for="(chain, index) in chains" :key="index" :name="chain.chainName" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.sz-hero {
  background:
    radial-gradient(1200px 400px at 10% -10%, rgba(0, 95, 204, 0.35), transparent 55%),
    radial-gradient(800px 300px at 90% 110%, rgba(118, 75, 200, 0.25), transparent 50%),
    linear-gradient(145deg, #0b1120 0%, #0c1226 50%, #111827 100%);
  border: 1px solid rgba(148, 163, 184, 0.12);
  box-shadow: 0 20px 50px -24px rgba(0, 0, 0, 0.55);
}
.sz-hero-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, #005fcc, #3385ff);
  box-shadow: 0 8px 24px -8px rgba(0, 95, 204, 0.65);
  flex-shrink: 0;
}
.sz-hero-title {
  letter-spacing: -0.035em;
  color: #f8fafc;
}
.sz-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.75rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.04);
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
.sz-search:focus-within {
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, hsl(var(--p)) 18%, transparent);
}
</style>
