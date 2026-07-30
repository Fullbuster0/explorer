<script lang="ts" setup>
import { useParamStore, useBlockchain } from '@/stores';
import { computed, ref, onMounted, watch } from 'vue';
import ParamCard from '@/components/ParamCard.vue';
import Loading from '@/components/Loading.vue';

const store = useParamStore();
const blockchain = useBlockchain();

const chainLoading = ref(true);
const stakingLoading = ref(true);
const govLoading = ref(true);
const distributionLoading = ref(true);
const slashingLoading = ref(true);
const abciLoading = ref(true);
const mintLoading = ref(true);
let loadGen = 0;

async function loadAllParams() {
  const gen = ++loadGen;
  chainLoading.value = true;
  stakingLoading.value = true;
  govLoading.value = true;
  distributionLoading.value = true;
  slashingLoading.value = true;
  abciLoading.value = true;
  mintLoading.value = true;

  // Wait briefly for rpc client (cold SPA race — no hard refresh)
  const isGno =
    blockchain.current?.engine === 'gno' || blockchain.current?.engine === 'tm2';
  if (!blockchain.rpc) {
    for (let i = 0; i < 20 && !blockchain.rpc; i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (gen !== loadGen) return;

  const mark = (flag: typeof chainLoading) => {
    if (gen === loadGen) flag.value = false;
  };

  // Gno/TM2: only chain tip + staking/VP + abci. Skip Cosms gov/dist/slash/mint RPCs.
  store.handleBaseBlockLatest().finally(() => mark(chainLoading));
  store.handleStakingParams().finally(() => mark(stakingLoading));
  store.handleAbciInfo().finally(() => mark(abciLoading));
  if (isGno) {
    store.modulesHidden.gov = true;
    store.modulesHidden.distribution = true;
    store.modulesHidden.slashing = true;
    store.modulesHidden.mint = true;
    mark(govLoading);
    mark(distributionLoading);
    mark(slashingLoading);
    mark(mintLoading);
    return;
  }
  store.handleGovernanceParams().finally(() => mark(govLoading));
  store.handleDistributionParams().finally(() => mark(distributionLoading));
  store.handleSlashingParams().finally(() => mark(slashingLoading));
  store.handleMintParam().finally(() => mark(mintLoading));
}

onMounted(() => {
  loadAllParams();
});

// Re-fetch when endpoint / rpc lands or swaps (Gno cold race + fallback)
watch(
  () => [blockchain.endpoint?.address, !!(blockchain as any).rpc, blockchain.current?.chainName] as const,
  ([addr, hasRpc], prev) => {
    if (!addr && !hasRpc) return;
    const prevAddr = prev?.[0];
    const prevRpc = prev?.[1];
    // First land of rpc, or endpoint change
    if ((hasRpc && !prevRpc) || (addr && addr !== prevAddr)) {
      loadAllParams();
    }
  }
);

/** Pretty title used in the hero — pulled from the live chain config. */
const chainName = computed(
  () => blockchain.current?.prettyName || blockchain.current?.chainName || ''
);

/** Chain-id header strip uses the existing 4-item `chain.items` array
 *  (height / bonded-supply / bonded-ratio / inflation) so we don't have
 *  to re-fetch anything. Just translate the subtitles + pretty-print
 *  the value per item. */
/** Overview cells — bonded supply / ratio / inflation. Height is
 *  excluded: it's already visible in the global header ticker and
 *  duplicated here just added noise. */
const heroItems = computed(() => {
  return (store.chain?.items || [])
    .filter((it) => it.subtitle !== 'height')
    .map((it) => ({
      key: it.subtitle,
      value: it.value,
      label: prettyKey(it.subtitle),
    }));
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


/** Some keys (go_version, cosmos_sdk_version, etc) deserve a more
 *  prominent treatment — separate "Build info" sub-group. */
const appVersionInfo = computed(() => {
  const rows = appVersionRows.value;
  // Same heuristic as nodeVersionInfo: short strings into narrow cells,
  // long strings (go_version, git_commit hash, build_tags) get a wide
  // row so they wrap inside the card instead of breaking out.
  const SHORT_MAX = 16;
  const block: any[] = [];
  const rest: any[] = [];
  rows.forEach((r: any) => {
    const isLong = String(r.value ?? '').length > SHORT_MAX;
    if (!isLong) block.push(r);
    else rest.push(r);
  });
  return { block, rest };
});


</script>

<template>
  <div>
    <!-- ============== CHAIN OVERVIEW (chain-id + bonded-supply / ratio / inflation) ============== -->
    <section class="sz-section sz-glass overflow-hidden mb-4">
      <div class="sz-section-head">
        <div class="flex items-center gap-3">
          <span class="sz-params-tone" data-tone="default"></span>
          <div>
            <div class="sz-section-kicker">Overview</div>
            <div class="sz-section-title">
              {{ chainName || 'Chain' }}
              <span v-if="networkLabel" class="sz-params-net-pill" :style="{ '--net-color': themeColor }">
                {{ networkLabel }}
              </span>
            </div>
            <div class="sz-params-chainid sz-hero-mono">
              {{ store.chain.title || '—' }}
            </div>
          </div>
        </div>
      </div>
      <div v-if="chainLoading" class="p-3">
        <Loading :bordered="false" />
      </div>
      <div v-else class="sz-params-grid">
        <div
          v-for="(it, i) in heroItems"
          :key="i"
          class="sz-params-cell"
        >
          <div class="sz-params-key">{{ it.label }}</div>
          <div class="sz-params-val" data-tone="denom">
            {{ it.value }}
          </div>
        </div>
      </div>
    </section>

    <!-- ============== STAKING ============== -->
    <ParamCard :card="store.staking" :loading="stakingLoading" />

    <!-- ============== DISTRIBUTION ============== -->
    <ParamCard
      v-if="!store.modulesHidden.distribution"
      :card="store.distribution"
      :loading="distributionLoading"
    />

    <!-- ============== SLASHING ============== -->
    <ParamCard
      v-if="!store.modulesHidden.slashing"
      :card="store.slashing"
      :loading="slashingLoading"
    />

    <!-- ============== GOVERNANCE ============== -->
    <ParamCard
      v-if="!store.modulesHidden.gov"
      :card="store.gov"
      :loading="govLoading"
    />

    <!-- ============== MINT (hidden when chain disables the module) ============== -->
    <ParamCard
      v-if="!store.modulesHidden.mint"
      :card="store.mint"
      :loading="mintLoading"
    />

    <!-- ============== APP VERSION ============== -->
    <section
      v-if="abciLoading || (appVersionInfo.block.length || appVersionInfo.rest.length)"
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
      <div v-else class="sz-params-grid">
        <div
          v-for="(it, i) in appVersionInfo.block"
          :key="'app-block-' + i"
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

  </div>
</template>

<style scoped>
.sz-hero-mono {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: -0.01em;
}

/* Chain-id line under the Overview title — dim mono, smaller. */
.sz-params-chainid {
  font-size: 11.5px;
  margin-top: 0.15rem;
  color: color-mix(in srgb, hsl(var(--bc)) 55%, transparent);
  letter-spacing: 0.02em;
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

/* sz-params-tone / sz-params-cell base styles are global (style.css).
   Only page-specific hero/pill overrides stay scoped here. */
</style>

<route>
{
  meta: {
    i18n: 'parameters',
    order: 50
  }
}
</route>