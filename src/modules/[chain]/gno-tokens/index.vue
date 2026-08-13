<script lang="ts" setup>
/**
 * Gno Tokens (GRC20) — from onbloc indexer API.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useBaseStore, useBlockchain } from '@/stores';
import { getGnoIndexer, type GnoToken } from '@/libs/gno/indexer';

const props = defineProps(['chain']);
const chainStore = useBlockchain();
const baseStore = useBaseStore();

const tokens = ref<GnoToken[]>([]);
const loading = ref(false);
const errored = ref(false);
const search = ref('');
/** Supersede in-flight fetches — never block SPA re-entry with `if (loading) return`. */
let fetchGen = 0;

const indexerUrl = computed(() => (chainStore.current as any)?.indexer_api || '');
const hasIndexer = computed(() => !!indexerUrl.value);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return tokens.value;
  return tokens.value.filter(
    (t) =>
      t.name?.toLowerCase().includes(q) ||
      t.symbol?.toLowerCase().includes(q) ||
      t.path?.toLowerCase().includes(q) ||
      t.tokenId?.toLowerCase().includes(q)
  );
});

function formatSupply(t: GnoToken): string {
  const raw = t.totalSupply;
  if (!raw || raw === '0') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const dec = t.decimals ?? 0;
  const human = n / Math.pow(10, dec);
  if (human >= 1e12) return `${(human / 1e12).toFixed(2)}T`;
  if (human >= 1e9) return `${(human / 1e9).toFixed(2)}B`;
  if (human >= 1e6) return `${(human / 1e6).toFixed(2)}M`;
  if (human >= 1e3) return `${(human / 1e3).toFixed(2)}K`;
  if (human >= 1) return human.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return human.toFixed(Math.min(dec, 6));
}

function gnowebUrl(path: string): string {
  const base = (chainStore.current as any)?.gnoweb || 'https://sapphire.testnets.gno.land';
  // Always join with exactly one '/'. Without the separator a crafted realm
  // path like `gno.land@evil.com` would yield `https://<gnoweb>@evil.com`,
  // which browsers parse as host=evil.com (userinfo open-redirect).
  const p = path.replace(/^gno\.land/, '').replace(/^\//, '');
  return `${base.replace(/\/$/, '')}/${p}`;
}

function shortPath(path: string): string {
  return (path || '').replace(/^gno\.land\//, '');
}

async function fetchTokens() {
  if (!hasIndexer.value) return;
  const gen = ++fetchGen;
  loading.value = true;
  errored.value = false;
  const maxAttempts = 3;
  let lastErr: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (gen !== fetchGen) return;
    try {
      const client = getGnoIndexer(indexerUrl.value);
      const page = await client.getTokens();
      if (gen !== fetchGen) return;
      tokens.value = page.items;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[gno-tokens] fetch failed (attempt ${attempt + 1}/${maxAttempts}):`, e);
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  if (gen !== fetchGen) return;
  if (lastErr) errored.value = true;
  loading.value = false;
}

onMounted(fetchTokens);
watch(
  () => chainStore.chainName,
  () => {
    tokens.value = [];
    fetchTokens();
  }
);
watch(
  () => indexerUrl.value,
  (url, prev) => {
    if (url && url !== prev && (!tokens.value.length || errored.value)) fetchTokens();
  }
);
// Reconnect recovery after silent RPC fallback (no hard refresh)
watch(
  () => baseStore.connected,
  (ok, was) => {
    if (ok && !was && hasIndexer.value && (!tokens.value.length || errored.value)) fetchTokens();
  }
);
// Tab-back resume when empty/errored
if (typeof document !== 'undefined') {
  const onVis = () => {
    if (document.visibilityState === 'visible' && hasIndexer.value && (!tokens.value.length || errored.value)) {
      fetchTokens();
    }
  };
  document.addEventListener('visibilitychange', onVis);
  onUnmounted(() => document.removeEventListener('visibilitychange', onVis));
}
</script>

<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Gno</div>
        <h1 class="sz-page-title">Tokens</h1>
        <div class="sz-page-sub">
          <span v-if="hasIndexer">
            {{ filtered.length }} GRC20 token{{ filtered.length === 1 ? '' : 's' }}
            <span class="opacity-60">· on-chain fungible tokens</span>
          </span>
          <span v-else class="text-amber-500">No indexer configured</span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-if="hasIndexer"
          v-model="search"
          type="text"
          class="input input-bordered input-sm w-48 font-mono text-xs"
          placeholder="Filter name / symbol…"
        />
        <button class="btn btn-sm btn-ghost" :disabled="loading" @click="fetchTokens">Refresh</button>
      </div>
    </div>

    <div v-if="!hasIndexer" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-icon">◇</div>
        <div class="sz-empty-title">Indexer not configured</div>
        <div class="sz-empty-sub">Set <code>indexer_api</code> in chain config to list GRC20 tokens.</div>
      </div>
    </div>

    <div v-else class="sz-section sz-glass overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table sz-ledger-table">
          <thead>
            <tr>
              <th style="width: 28%">Token</th>
              <th style="width: 10%">Symbol</th>
              <th style="width: 16%">Supply</th>
              <th style="width: 10%">Holders</th>
              <th style="width: 8%">Dec</th>
              <th style="width: 28%">Path</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in filtered" :key="t.tokenId || i" class="sz-ledger-row">
              <td>
                <div class="flex items-center gap-2.5">
                  <img
                    v-if="t.logoUrl"
                    :src="t.logoUrl"
                    :alt="t.symbol"
                    class="w-7 h-7 rounded-full bg-slate-100 object-contain"
                    loading="lazy"
                    @error="($event.target as HTMLImageElement).style.display = 'none'"
                  />
                  <div
                    v-else
                    class="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-500"
                  >
                    {{ (t.symbol || '?').slice(0, 2) }}
                  </div>
                  <div>
                    <RouterLink
                      class="font-semibold text-sm hover:underline"
                      :to="`/${props.chain}/gno-tokens/${encodeURIComponent(t.tokenId || t.path)}`"
                    >
                      {{ t.name || t.symbol || '—' }}
                    </RouterLink>
                    <a
                      class="ml-1 text-[10px] opacity-50 hover:opacity-90"
                      :href="gnowebUrl(t.path)"
                      target="_blank"
                      rel="noopener"
                      title="Open on gnoweb"
                      @click.stop
                    >↗</a>
                  </div>
                </div>
              </td>
              <td>
                <RouterLink
                  class="font-mono text-xs font-semibold hover:underline"
                  :to="`/${props.chain}/gno-tokens/${encodeURIComponent(t.tokenId || t.path)}`"
                >{{ t.symbol || '—' }}</RouterLink>
              </td>
              <td>
                <span class="font-mono text-xs">{{ formatSupply(t) }}</span>
              </td>
              <td>
                <span class="font-mono text-xs">{{ t.holders?.toLocaleString() ?? '—' }}</span>
              </td>
              <td>
                <span class="font-mono text-xs text-slate-400">{{ t.decimals ?? '—' }}</span>
              </td>
              <td>
                <RouterLink
                  class="font-mono text-xs text-slate-500 hover:text-primary truncate block max-w-[260px]"
                  :to="`/${props.chain}/gno-realms/${encodeURIComponent(t.path)}`"
                  :title="t.path"
                >
                  {{ shortPath(t.path) }}
                </RouterLink>
              </td>
            </tr>
            <tr v-if="!filtered.length && loading">
              <td colspan="6" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon sz-empty-icon--loading">◇</div>
                  <div class="sz-empty-title">Loading tokens…</div>
                </div>
              </td>
            </tr>
            <tr v-if="!filtered.length && !loading && errored">
              <td colspan="6" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon">◇</div>
                  <div class="sz-empty-title">Failed to load tokens</div>
                </div>
              </td>
            </tr>
            <tr v-if="!filtered.length && !loading && !errored">
              <td colspan="6" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon">◇</div>
                  <div class="sz-empty-title">{{ search ? 'No matching tokens' : 'No GRC20 tokens yet' }}</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'tokens',
      order: 8
    }
  }
</route>
