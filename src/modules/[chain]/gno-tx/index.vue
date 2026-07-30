<script lang="ts" setup>
/**
 * Gno Transactions — powered by onbloc indexer API.
 * Public Gno RPC has tx_index=off, so we use the indexer.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useBaseStore, useBlockchain } from '@/stores';
import { getGnoIndexer, type GnoTx } from '@/libs/gno/indexer';
import { RouterLink } from 'vue-router';

const props = defineProps(['chain']);
const chainStore = useBlockchain();
const baseStore = useBaseStore();

const txs = ref<GnoTx[]>([]);
const cursor = ref<string | undefined>();
const hasNext = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const errored = ref(false);
const lastFetchedAt = ref(0);
const nowTick = ref(Date.now());
let tickTimer: number | undefined;
/** Supersede in-flight fetches — never block SPA re-entry with `if (loading) return`. */
let fetchGen = 0;

const indexerUrl = computed(() => (chainStore.current as any)?.indexer_api || '');
const hasIndexer = computed(() => !!indexerUrl.value);

function shortHash(h: string): string {
  if (!h) return '';
  // base64 hashes are longer — show head/tail
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function shortAddr(a: string): string {
  if (!a) return '—';
  return a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

function formatAmount(v: { value?: string; denom?: string } | null): string {
  if (!v || !v.value || v.value === '0') return '—';
  const n = Number(v.value);
  if (!Number.isFinite(n)) return `${v.value} ${v.denom || ''}`;
  // ugnot → GNOT (6 decimals)
  if (v.denom === 'ugnot') {
    const gnot = n / 1e6;
    if (gnot >= 1000) return `${gnot.toLocaleString(undefined, { maximumFractionDigits: 2 })} GNOT`;
    if (gnot >= 1) return `${gnot.toFixed(2)} GNOT`;
    if (gnot >= 0.001) return `${gnot.toFixed(4)} GNOT`;
    return `${gnot.toFixed(6)} GNOT`;
  }
  // GRC20 / realm path denoms: show short token path + raw amount
  const denom = v.denom || '';
  if (denom.includes('/')) {
    const short = denom.split('/').pop() || denom;
    return `${n.toLocaleString()} ${short}`;
  }
  return `${n.toLocaleString()} ${denom}`;
}

function funcLabel(tx: GnoTx): { label: string; slug: string } {
  const f = tx.func?.[0];
  if (!f) return { label: '—', slug: 'default' };
  const t = (f.messageType || '').toLowerCase();
  // Prefer funcType for display (Transfer/Approve/Swap…) but color by messageType
  if (t.includes('bank')) return { label: f.funcType || 'Transfer', slug: 'bank' };
  if (t.includes('m_call') || t.includes('vm.m_call')) return { label: f.funcType || 'Call', slug: 'wasm' };
  if (t.includes('m_addpkg') || t.includes('addpkg')) return { label: 'AddPkg', slug: 'wasm' };
  if (t.includes('m_run') || t.includes('vm.m_run')) return { label: 'Run', slug: 'wasm' };
  if (f.funcType === 'Transfer') return { label: 'Transfer', slug: 'bank' };
  return { label: f.funcType || f.messageType?.split('.').pop() || 'Tx', slug: 'default' };
}

function relativeAge(iso: string): string {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  const diff = Math.max(0, nowTick.value - ts) / 1000;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ageBucket(iso: string): 'fresh' | 'recent' | 'aged' {
  if (!iso) return 'aged';
  const diff = (nowTick.value - new Date(iso).getTime()) / 1000;
  if (diff < 30) return 'fresh';
  if (diff < 300) return 'recent';
  return 'aged';
}

async function fetchFirst() {
  if (!hasIndexer.value) return;
  const gen = ++fetchGen;
  loading.value = true;
  errored.value = false;
  const maxAttempts = 3;
  let lastErr: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (gen !== fetchGen) return; // superseded by newer nav/fetch
    try {
      const client = getGnoIndexer(indexerUrl.value);
      const page = await client.getTransactions();
      if (gen !== fetchGen) return;
      txs.value = page.items;
      cursor.value = page.cursor;
      hasNext.value = page.hasNext;
      lastFetchedAt.value = Date.now();
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[gno-tx] fetch failed (attempt ${attempt + 1}/${maxAttempts}):`, e);
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
    const page = await client.getTransactionsAfter(cursor.value);
    // Dedup by hash
    const seen = new Set(txs.value.map((t) => t.txHash));
    for (const t of page.items) {
      if (!seen.has(t.txHash)) txs.value.push(t);
    }
    cursor.value = page.cursor;
    hasNext.value = page.hasNext;
  } catch (e) {
    console.warn('[gno-tx] loadMore failed:', e);
  } finally {
    loadingMore.value = false;
  }
}

onMounted(() => {
  fetchFirst();
  tickTimer = window.setInterval(() => (nowTick.value = Date.now()), 1000);
});
onUnmounted(() => {
  if (tickTimer) window.clearInterval(tickTimer);
});
watch(
  () => chainStore.chainName,
  () => {
    txs.value = [];
    cursor.value = undefined;
    hasNext.value = false;
    fetchFirst();
  }
);
// indexer_api often missing on first paint — re-fetch when it lands (no hard refresh)
watch(
  () => indexerUrl.value,
  (url, prev) => {
    if (url && url !== prev && (!txs.value.length || errored.value)) fetchFirst();
  }
);
// After silent RPC auto-fallback restores Connected, re-pull empty/errored lists
// without requiring the user to hard-refresh or re-click sidebar.
watch(
  () => baseStore.connected,
  (ok, was) => {
    if (ok && !was && hasIndexer.value && (!txs.value.length || errored.value)) {
      fetchFirst();
    }
  }
);
// Visibility resume: if user tabbed away and came back to an empty/errored list, retry
if (typeof document !== 'undefined') {
  const onVis = () => {
    if (document.visibilityState === 'visible' && hasIndexer.value && (!txs.value.length || errored.value)) {
      fetchFirst();
    }
  };
  document.addEventListener('visibilitychange', onVis);
  onUnmounted(() => document.removeEventListener('visibilitychange', onVis));
}
// Tip poll: new block → soft refresh first page (dedupe by hash, keep cursor)
let tipPollBusy = false;
watch(
  () => baseStore.latest?.block?.header?.height,
  async (h, prev) => {
    if (!h || h === prev || !hasIndexer.value) return;
    if (document.visibilityState === 'hidden') return;
    if (tipPollBusy || loading.value || loadingMore.value) return;
    tipPollBusy = true;
    try {
      const client = getGnoIndexer(indexerUrl.value);
      const page = await client.getTransactions();
      const seen = new Set(txs.value.map((x) => x.txHash));
      const fresh = (page.items || []).filter((x) => !seen.has(x.txHash));
      if (fresh.length) {
        txs.value = [...fresh, ...txs.value];
        lastFetchedAt.value = Date.now();
      } else if (!txs.value.length) {
        txs.value = page.items || [];
        cursor.value = page.cursor;
        hasNext.value = page.hasNext;
        lastFetchedAt.value = Date.now();
      }
    } catch (e) {
      console.warn('[gno-tx] tip poll failed:', e);
    } finally {
      tipPollBusy = false;
    }
  }
);

const secondsSinceLastFetch = computed(() => {
  if (!lastFetchedAt.value) return null;
  return Math.max(0, Math.floor((nowTick.value - lastFetchedAt.value) / 1000));
});
</script>

<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Chain</div>
        <h1 class="sz-page-title">Transactions</h1>
        <div class="sz-page-sub flex items-center gap-2">
          <span class="sz-live-dot" :class="{ 'sz-live-dot--errored': errored, 'sz-live-dot--loading': loading }"></span>
          <span v-if="hasIndexer">
            {{ txs.length }} txs · via indexer
            <span v-if="secondsSinceLastFetch !== null" class="opacity-60">· updated {{ secondsSinceLastFetch }}s ago</span>
          </span>
          <span v-else class="text-amber-500">No indexer configured for this chain</span>
        </div>
      </div>
      <button
        class="btn btn-sm btn-ghost gap-1"
        :disabled="loading"
        @click="fetchFirst"
        title="Refresh"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4" :class="{ 'animate-spin': loading }">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
        Refresh
      </button>
    </div>

    <div v-if="!hasIndexer" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-icon">◇</div>
        <div class="sz-empty-title">Indexer not configured</div>
        <div class="sz-empty-sub">
          Gno public RPC has <code>tx_index=off</code>. Set <code>indexer_api</code> in chain config
          to a Gno indexer REST base URL.
        </div>
      </div>
    </div>

    <div v-else class="sz-section sz-glass overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table sz-ledger-table">
          <thead>
            <tr>
              <th style="width: 10%">Block</th>
              <th style="width: 18%">Tx Hash</th>
              <th style="width: 14%">Function</th>
              <th style="width: 16%">From</th>
              <th style="width: 14%">Amount</th>
              <th style="width: 10%">Fee</th>
              <th style="width: 8%">Status</th>
              <th style="width: 10%" class="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(tx, i) in txs" :key="tx.txHash || i" class="sz-ledger-row">
              <td>
                <RouterLink class="sz-height-link" :to="`/${props.chain}/block/${tx.blockHeight}`">
                  <span class="sz-height-hash">#</span>{{ tx.blockHeight }}
                </RouterLink>
              </td>
              <td>
                <RouterLink
                  class="sz-hash sz-hash-mono text-primary hover:underline"
                  :to="`/${props.chain}/tx/${encodeURIComponent(tx.txHash)}`"
                  :title="tx.txHash"
                >{{ shortHash(tx.txHash) }}</RouterLink>
              </td>
              <td>
                <div class="sz-msg-pills">
                  <span class="sz-msg-pill" :data-module="funcLabel(tx).slug">{{ funcLabel(tx).label }}</span>
                  <span v-if="tx.messageCount > 1" class="sz-msg-pill sz-msg-pill--more">+{{ tx.messageCount - 1 }}</span>
                </div>
                <div v-if="tx.func?.[0]?.pkgPath && tx.func[0].pkgPath !== 'GNOT Transfer'" class="text-[10px] text-slate-400 mt-0.5 font-mono truncate max-w-[140px]" :title="tx.func[0].pkgPath">
                  {{ tx.func[0].pkgPath.replace(/^gno\.land\//, '') }}
                </div>
              </td>
              <td>
                <RouterLink
                  v-if="tx.fromAddress"
                  class="font-mono text-xs text-primary hover:underline"
                  :to="`/${props.chain}/account/${tx.fromAddress}`"
                  :title="tx.fromAddress"
                >{{ shortAddr(tx.fromAddress) }}</RouterLink>
                <span v-else class="font-mono text-xs">—</span>
                <div v-if="tx.fromName" class="text-[10px] text-slate-400">{{ tx.fromName }}</div>
              </td>
              <td>
                <span class="font-mono text-xs">{{ formatAmount(tx.amount) }}</span>
              </td>
              <td>
                <span class="sz-fee">{{ formatAmount(tx.fee) }}</span>
              </td>
              <td>
                <span v-if="tx.successYn" class="sz-status sz-status--ok"><span class="sz-status-glyph">✓</span>OK</span>
                <span v-else class="sz-status sz-status--fail"><span class="sz-status-glyph">✕</span>FAIL</span>
              </td>
              <td class="text-right">
                <span class="sz-time" :data-age="ageBucket(tx.timestamp)" :title="tx.timestamp">
                  <span class="sz-time-pulse" :data-age="ageBucket(tx.timestamp)"></span>
                  {{ relativeAge(tx.timestamp) }}
                </span>
              </td>
            </tr>
            <tr v-if="!txs.length && loading">
              <td colspan="8" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon sz-empty-icon--loading">◇</div>
                  <div class="sz-empty-title">Loading transactions…</div>
                </div>
              </td>
            </tr>
            <tr v-if="!txs.length && !loading && errored">
              <td colspan="8" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon">◇</div>
                  <div class="sz-empty-title">Failed to load transactions</div>
                  <div class="sz-empty-sub">Indexer may be temporarily unavailable.</div>
                </div>
              </td>
            </tr>
            <tr v-if="!txs.length && !loading && !errored">
              <td colspan="8" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon">◇</div>
                  <div class="sz-empty-title">No transactions yet</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="hasNext" class="p-4 flex justify-center">
        <button class="btn btn-primary btn-sm min-w-[200px]" :disabled="loadingMore" @click="loadMore">
          <span v-if="loadingMore">Loading…</span>
          <span v-else>View More Transactions</span>
        </button>
      </div>
    </div>
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'tx',
      order: 6
    }
  }
</route>
