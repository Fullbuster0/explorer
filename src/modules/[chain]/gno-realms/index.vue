<script lang="ts" setup>
/**
 * Gno Realms — on-chain packages published via MsgAddPackage.
 * Data from onbloc indexer API.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useBaseStore, useBlockchain } from '@/stores';
import { getGnoIndexer, type GnoRealm } from '@/libs/gno/indexer';

const props = defineProps(['chain']);
const chainStore = useBlockchain();
const baseStore = useBaseStore();

const realms = ref<GnoRealm[]>([]);
const cursor = ref<string | undefined>();
const hasNext = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const errored = ref(false);
const search = ref('');
/** Supersede in-flight fetches — never block SPA re-entry with `if (loading) return`. */
let fetchGen = 0;

const indexerUrl = computed(() => (chainStore.current as any)?.indexer_api || '');
const hasIndexer = computed(() => !!indexerUrl.value);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return realms.value;
  return realms.value.filter(
    (r) =>
      r.name?.toLowerCase().includes(q) ||
      r.path?.toLowerCase().includes(q) ||
      r.publisher?.toLowerCase().includes(q) ||
      r.publisherName?.toLowerCase().includes(q)
  );
});

function shortAddr(a: string): string {
  if (!a) return '—';
  return a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

function formatBytes(n: number | string): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB`;
}

function formatGas(v: { value?: string; denom?: string } | null): string {
  if (!v || !v.value || v.value === '0') return '—';
  const n = Number(v.value);
  if (!Number.isFinite(n)) return v.value;
  if (v.denom === 'ugnot') {
    const g = n / 1e6;
    if (g >= 1) return `${g.toFixed(2)} GNOT`;
    return `${(n / 1e3).toFixed(1)}k ugnot`;
  }
  return n.toLocaleString();
}

function gnowebUrl(path: string): string {
  // Prefer chain gnoweb if present, else topaz default
  const base = (chainStore.current as any)?.gnoweb || 'https://topaz.testnets.gno.land';
  // path is like gno.land/r/demo/boards → /r/demo/boards
  const p = path.replace(/^gno\.land/, '');
  return `${base.replace(/\/$/, '')}${p}`;
}

async function fetchFirst() {
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
      const page = await client.getRealms();
      if (gen !== fetchGen) return;
      realms.value = page.items;
      cursor.value = page.cursor;
      hasNext.value = page.hasNext;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[gno-realms] fetch failed (attempt ${attempt + 1}/${maxAttempts}):`, e);
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  if (gen !== fetchGen) return;
  if (lastErr) errored.value = true;
  loading.value = false;
}

async function loadMore() {
  if (!hasIndexer.value || !hasNext.value || !cursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const client = getGnoIndexer(indexerUrl.value);
    const page = await client.getRealmsAfter(cursor.value);
    const seen = new Set(realms.value.map((r) => r.path));
    for (const r of page.items) {
      if (!seen.has(r.path)) realms.value.push(r);
    }
    cursor.value = page.cursor;
    hasNext.value = page.hasNext;
  } catch (e) {
    console.warn('[gno-realms] loadMore failed:', e);
  } finally {
    loadingMore.value = false;
  }
}

onMounted(fetchFirst);
watch(
  () => chainStore.chainName,
  () => {
    realms.value = [];
    cursor.value = undefined;
    hasNext.value = false;
    fetchFirst();
  }
);
watch(
  () => indexerUrl.value,
  (url, prev) => {
    if (url && url !== prev && (!realms.value.length || errored.value)) fetchFirst();
  }
);
// Reconnect recovery: Connected flip after fallback — refill empty list (no hard refresh)
watch(
  () => baseStore.connected,
  (ok, was) => {
    if (ok && !was && hasIndexer.value && (!realms.value.length || errored.value)) fetchFirst();
  }
);
// Tab-back resume when list empty/errored (no hard refresh)
if (typeof document !== 'undefined') {
  const onVis = () => {
    if (document.visibilityState === 'visible' && hasIndexer.value && (!realms.value.length || errored.value)) {
      fetchFirst();
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
        <h1 class="sz-page-title">Realms</h1>
        <div class="sz-page-sub">
          <span v-if="hasIndexer">
            {{ filtered.length }}{{ search ? ` of ${realms.length}` : '' }} realms
            <span class="opacity-60">· on-chain packages (MsgAddPackage)</span>
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
          placeholder="Filter path / name…"
        />
        <button class="btn btn-sm btn-ghost" :disabled="loading" @click="fetchFirst">Refresh</button>
      </div>
    </div>

    <div v-if="!hasIndexer" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-icon">◇</div>
        <div class="sz-empty-title">Indexer not configured</div>
        <div class="sz-empty-sub">Set <code>indexer_api</code> in chain config to list published realms.</div>
      </div>
    </div>

    <div v-else class="sz-section sz-glass overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table sz-ledger-table">
          <thead>
            <tr>
              <th style="width: 18%">Name</th>
              <th style="width: 28%">Path</th>
              <th style="width: 16%">Publisher</th>
              <th style="width: 8%">Funcs</th>
              <th style="width: 10%">Calls</th>
              <th style="width: 10%">Storage</th>
              <th style="width: 10%">Block</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in filtered" :key="r.path || i" class="sz-ledger-row">
              <td>
                <RouterLink
                  class="font-semibold text-sm hover:underline"
                  :to="`/${props.chain}/gno-realms/${encodeURIComponent(r.path)}`"
                  :title="`Realm detail: ${r.path}`"
                >
                  {{ r.name || '—' }}
                </RouterLink>
                <a
                  class="ml-1 text-[10px] opacity-50 hover:opacity-90"
                  :href="gnowebUrl(r.path)"
                  target="_blank"
                  rel="noopener"
                  title="Open on gnoweb"
                  @click.stop
                >↗</a>
              </td>
              <td>
                <RouterLink
                  class="font-mono text-xs text-slate-500 hover:text-primary truncate block max-w-[280px]"
                  :to="`/${props.chain}/gno-realms/${encodeURIComponent(r.path)}`"
                  :title="r.path"
                >
                  {{ r.path?.replace(/^gno\.land\//, '') }}
                </RouterLink>
              </td>
              <td>
                <RouterLink
                  v-if="r.publisher"
                  class="font-mono text-xs hover:underline"
                  :to="`/${props.chain}/account/${r.publisher}`"
                  :title="r.publisher"
                >{{ shortAddr(r.publisher) }}</RouterLink>
                <span v-else class="font-mono text-xs">—</span>
                <div v-if="r.publisherName" class="text-[10px] text-slate-400">{{ r.publisherName }}</div>
              </td>
              <td>
                <span class="font-mono text-xs">{{ r.funcCount ?? '—' }}</span>
              </td>
              <td>
                <span class="font-mono text-xs text-green-600">{{ r.totalCallCountSuccess ?? 0 }}</span>
                <span v-if="r.totalCallCountFailed" class="font-mono text-xs text-red-500 ml-1">/ {{ r.totalCallCountFailed }}✗</span>
              </td>
              <td>
                <span class="font-mono text-xs">{{ formatBytes(r.totalStorageUsage || r.storageUsage?.value) }}</span>
              </td>
              <td>
                <RouterLink class="sz-height-link" :to="`/${props.chain}/block/${r.blockHeight}`">
                  <span class="sz-height-hash">#</span>{{ r.blockHeight }}
                </RouterLink>
              </td>
            </tr>
            <tr v-if="!filtered.length && loading">
              <td colspan="7" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon sz-empty-icon--loading">◇</div>
                  <div class="sz-empty-title">Loading realms…</div>
                </div>
              </td>
            </tr>
            <tr v-if="!filtered.length && !loading && errored">
              <td colspan="7" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon">◇</div>
                  <div class="sz-empty-title">Failed to load realms</div>
                </div>
              </td>
            </tr>
            <tr v-if="!filtered.length && !loading && !errored">
              <td colspan="7" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon">◇</div>
                  <div class="sz-empty-title">{{ search ? 'No matching realms' : 'No realms yet' }}</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="hasNext && !search" class="p-4 flex justify-center">
        <button class="btn btn-primary btn-sm min-w-[200px]" :disabled="loadingMore" @click="loadMore">
          <span v-if="loadingMore">Loading…</span>
          <span v-else>View More Realms</span>
        </button>
      </div>
    </div>
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'realms',
      order: 7
    }
  }
</route>
