<script lang="ts" setup>
import { useParamStore, useFormatter, useBlockchain } from '@/stores';
import { computed, ref, onMounted } from 'vue';
import ParamCard from '@/components/ParamCard.vue';
import Loading from '@/components/Loading.vue';

const store = useParamStore();
const format = useFormatter();
const blockchain = useBlockchain();

const chainLoading = ref(true);
const stakingLoading = ref(true);
const govLoading = ref(true);
const distributionLoading = ref(true);
const slashingLoading = ref(true);
const abciLoading = ref(true);
const mintLoading = ref(true);

onMounted(() => {
  store.handleBaseBlockLatest().finally(() => (chainLoading.value = false));
  store.handleStakingParams().finally(() => (stakingLoading.value = false));
  store.handleGovernanceParams().finally(() => (govLoading.value = false));
  store.handleDistributionParams().finally(() => (distributionLoading.value = false));
  store.handleSlashingParams().finally(() => (slashingLoading.value = false));
  store.handleAbciInfo().finally(() => (abciLoading.value = false));
  store.handleMintParam().finally(() => (mintLoading.value = false));
});

/** Pretty title used in the hero — pulled from the live chain config. */
const chainName = computed(
  () => blockchain.current?.prettyName || blockchain.current?.chainName || ''
);

/** Chain-id header strip uses the existing 4-item `chain.items` array
 *  (height / bonded-supply / bonded-ratio / inflation) so we don't have
 *  to re-fetch anything. Just translate the subtitles + pretty-print
 *  the value per item. */
const heroItems = computed(() => {
  return (store.chain?.items || []).map((it) => {
    let display = it.value;
    if (it.subtitle === 'height' && display !== '-') {
      // Big, monospace, accent.
      display = String(display);
    } else if (it.subtitle === 'bonded_ratio' && display !== '-') {
      // already "xx.x%" — leave as-is.
    }
    return {
      key: it.subtitle,
      value: display,
      label: prettyKey(it.subtitle),
    };
  });
});

function prettyKey(k: string) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Network label from chain config (e.g. "Mainnet"). */
const networkLabel = computed(() => {
  const t = blockchain.current?.networkType;
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
});

/** Theme color drives the hero accent dot — distinct per chain without
 *  needing a custom palette. */
const themeColor = computed(
  () => blockchain.current?.themeColor || 'hsl(var(--p))'
);

/** App-version block — flatten the application_version sub-object so it
 *  reads as a 2-column list. Cosmos SDK version, Go version, build deps,
 *  etc. The original code dumped this as ArrayObjectElement which treated
 *  a nested object as a single row. We render it as ParamCard instead. */
const appVersionRows = computed(() => {
  // Guard: items can be an object on chains where handleAbciInfo fails.
  // Wrap into Array.from to keep .map working in the page even if the
  // store hasn't been hit yet.
  const v = store.appVersion?.items;
  if (!Array.isArray(v)) return [];
  return v.map((row: any) => ({
    subtitle: row.subtitle,
    value: row.value,
  }));
});

/** Node Information — same flattening. */
const nodeVersionRows = computed(() => {
  const v = store.nodeVersion?.items;
  if (!Array.isArray(v)) return [];
  return v.map((row: any) => ({
    subtitle: row.subtitle,
    value: row.value,
  }));
});

/** Some keys (go_version, cosmos_sdk_version, etc) deserve a more
 *  prominent treatment — separate "Build info" sub-group. */
const appVersionInfo = computed(() => {
  const rows = appVersionRows.value;
  const known = new Set([
    'cosmos_sdk_version',
    'go_version',
    'node',
    'name',
    'version',
    'commit',
    'build_tags',
    'build_deps',
    'client_name',
    'client_version',
    'client_git_commit',
    'client_features',
    'go_crypto_version',
  ]);
  const build: any[] = [];
  const rest: any[] = [];
  rows.forEach((r: any) => {
    if (known.has(r.subtitle)) build.push(r);
    else rest.push(r);
  });
  return { build, rest };
});

const nodeVersionInfo = computed(() => {
  const rows = nodeVersionRows.value;
  const known = new Set(['network', 'moniker', 'version', 'channels', 'other']);
  const block: any[] = [];
  const rest: any[] = [];
  rows.forEach((r: any) => {
    if (known.has(r.subtitle)) block.push(r);
    else rest.push(r);
  });
  return { block, rest };
});
</script>

<template>
  <div>
    <!-- ============== HERO ============== -->
    <section class="sz-section sz-acc-hero mb-4 overflow-hidden">
      <div class="sz-acc-hero-grid">
        <div class="sz-acc-id">
          <div class="sz-section-kicker mb-1">Chain</div>
          <h1 class="sz-acc-addr-row" style="font-size: 1.55rem; line-height: 1.2;">
            <span class="sz-hero-mono">{{ chainName || 'Parameters' }}</span>
            <span v-if="networkLabel" class="sz-params-net-pill" :style="{ '--net-color': themeColor }">
              {{ networkLabel }}
            </span>
          </h1>
          <div class="sz-page-sub mt-1">
            {{ store.chain.title || 'Loading chain id…' }}
          </div>
        </div>
        <div class="sz-acc-value">
          <div class="sz-section-kicker mb-1">Latest block</div>
          <div v-if="chainLoading" class="sz-acc-value-num">
            <Loading :bordered="false" />
          </div>
          <div v-else class="sz-acc-value-num sz-hero-mono">
            #{{ store.chain.items.find((i) => i.subtitle === 'height')?.value }}
          </div>
          <div class="sz-acc-value-sub">
            {{ format.toDay(store.latestTime, 'from') || '—' }} · live
          </div>
        </div>
      </div>
    </section>

    <!-- ============== CHAIN OVERVIEW (height / bonded-supply / ratio / inflation) ============== -->
    <section class="sz-section sz-glass overflow-hidden mb-4">
      <div class="sz-section-head">
        <div class="flex items-center gap-3">
          <span class="sz-params-tone" data-tone="default"></span>
          <div>
            <div class="sz-section-kicker">Overview</div>
            <div class="sz-section-title">Chain metrics</div>
          </div>
        </div>
      </div>
      <div v-if="chainLoading" class="p-3">
        <Loading :bordered="false" />
      </div>
      <div v-else class="sz-params-grid" style="padding: 0.25rem 0 0.5rem;">
        <div
          v-for="(it, i) in heroItems"
          :key="i"
          class="sz-params-cell"
        >
          <div class="sz-params-key">{{ it.label }}</div>
          <div class="sz-params-val" :data-tone="it.key === 'height' ? undefined : 'denom'">
            {{ it.value }}
          </div>
        </div>
      </div>
    </section>

    <!-- ============== STAKING ============== -->
    <ParamCard :card="store.staking" :loading="stakingLoading" />

    <!-- ============== DISTRIBUTION ============== -->
    <ParamCard :card="store.distribution" :loading="distributionLoading" />

    <!-- ============== SLASHING ============== -->
    <ParamCard :card="store.slashing" :loading="slashingLoading" />

    <!-- ============== GOVERNANCE ============== -->
    <ParamCard :card="store.gov" :loading="govLoading" />

    <!-- ============== MINT (hidden when chain disables the module) ============== -->
    <ParamCard
      v-if="!store.modulesHidden.mint"
      :card="store.mint"
      :loading="mintLoading"
    />

    <!-- ============== APP VERSION ============== -->
    <section
      v-if="abciLoading || (appVersionInfo.build.length || appVersionInfo.rest.length)"
      class="sz-section sz-glass overflow-hidden mb-4"
    >
      <div class="sz-section-head">
        <div class="flex items-center gap-3">
          <span class="sz-params-tone" data-tone="default"></span>
          <div>
            <div class="sz-section-kicker">Build</div>
            <div class="sz-section-title">Application version</div>
          </div>
        </div>
      </div>
      <div v-if="abciLoading" class="p-3">
        <Loading :bordered="false" />
      </div>
      <div v-else class="sz-params-grid" style="padding: 0.25rem 0 0.5rem;">
        <div
          v-for="(it, i) in appVersionInfo.build"
          :key="'app-build-' + i"
          class="sz-params-cell"
        >
          <div class="sz-params-key">{{ prettyKey(it.subtitle) }}</div>
          <div class="sz-params-val sz-hero-mono">{{ String(it.value) }}</div>
        </div>
        <div
          v-for="(it, i) in appVersionInfo.rest"
          :key="'app-rest-' + i"
          class="sz-params-cell sz-params-cell--wide"
        >
          <div class="sz-params-key">{{ prettyKey(it.subtitle) }}</div>
          <div class="sz-params-val sz-hero-mono" style="font-size: 12.5px; word-break: break-all;">
            {{ String(it.value) }}
          </div>
        </div>
      </div>
    </section>

    <!-- ============== NODE INFO ============== -->
    <section
      v-if="abciLoading || (nodeVersionInfo.block.length || nodeVersionInfo.rest.length)"
      class="sz-section sz-glass overflow-hidden mb-4"
    >
      <div class="sz-section-head">
        <div class="flex items-center gap-3">
          <span class="sz-params-tone" data-tone="default"></span>
          <div>
            <div class="sz-section-kicker">Runtime</div>
            <div class="sz-section-title">Node information</div>
          </div>
        </div>
      </div>
      <div v-if="abciLoading" class="p-3">
        <Loading :bordered="false" />
      </div>
      <div v-else class="sz-params-grid" style="padding: 0.25rem 0 0.5rem;">
        <div
          v-for="(it, i) in nodeVersionInfo.block"
          :key="'node-block-' + i"
          class="sz-params-cell"
        >
          <div class="sz-params-key">{{ prettyKey(it.subtitle) }}</div>
          <div class="sz-params-val sz-hero-mono">{{ String(it.value) }}</div>
        </div>
        <div
          v-for="(it, i) in nodeVersionInfo.rest"
          :key="'node-rest-' + i"
          class="sz-params-cell sz-params-cell--wide"
        >
          <div class="sz-params-key">{{ prettyKey(it.subtitle) }}</div>
          <div class="sz-params-val sz-hero-mono" style="font-size: 12.5px; word-break: break-all;">
            {{ String(it.value) }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Inherit the same hero motif used by the account page so the two pages
   feel like part of the same design system. */
.sz-acc-hero {
  position: relative;
  padding: 1.4rem 1.5rem;
  border-radius: 14px;
}
.sz-acc-hero-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 1.2rem;
}
@media (max-width: 700px) {
  .sz-acc-hero-grid {
    grid-template-columns: 1fr;
  }
}
.sz-acc-id .sz-page-sub {
  color: color-mix(in srgb, hsl(var(--bc)) 65%, transparent);
  font-size: 12.5px;
}
.sz-hero-mono {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: -0.01em;
}

/* Network pill — a small rounded badge showing "Mainnet" / "Testnet"
   with the chain's theme color. */
.sz-params-net-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.55rem;
  margin-left: 0.65rem;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  color: var(--net-color, hsl(var(--p)));
  background: color-mix(in srgb, var(--net-color, hsl(var(--p))) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--net-color, hsl(var(--p))) 35%, transparent);
  vertical-align: middle;
  line-height: 1.4;
}

/* Big-number styling for the "Latest block" hero card. */
.sz-acc-value-num {
  font-size: 2.1rem;
  font-weight: 700;
  line-height: 1.1;
}
.sz-acc-value-sub {
  font-size: 11.5px;
  color: color-mix(in srgb, hsl(var(--bc)) 55%, transparent);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  margin-top: 0.2rem;
}

/* Override ParamCard's tone dot for the chain-id strip so it looks
   neutral (the dot's job is per-module color coding, not for the
   overview section). */
.sz-params-tone[data-tone='default'] {
  background: hsl(var(--p));
  color: hsl(var(--p));
}
</style>

<route>
{
  meta: {
    i18n: 'parameters',
    order: 50
  }
}
</route>