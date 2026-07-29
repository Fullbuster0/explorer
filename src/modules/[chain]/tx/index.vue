<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useBaseStore, useBlockchain, useFormatter } from '@/stores';
import type { TxResponse } from '@/types';
import { useRouter } from 'vue-router';

const props = defineProps(['chain']);
const vueRouters = useRouter();
const tab = ref('recent');

const base = useBaseStore();
const chainStore = useBlockchain();
const format = useFormatter();

/** Gno/TM2: public RPC has tx_index=off — Cosmos LCD feed always stalls. Prefer indexer page. */
const isGnoEngine = computed(
  () => chainStore.current?.engine === 'gno' || chainStore.current?.engine === 'tm2'
);

function redirectGnoTxListIfNeeded(): boolean {
  if (!isGnoEngine.value) return false;
  const chain = String(props.chain || chainStore.chainName || '').trim();
  if (!chain) return false;
  // Only the list route (`/tx` or `/tx/`) — keep `/tx/:hash` for detail.
  const path = String(vueRouters.currentRoute.value.path || '');
  if (!/\/tx\/?$/.test(path)) return false;
  vueRouters.replace({ path: `/${chain}/gno-tx` });
  return true;
}

const hashReg = /^[A-Z\d]{64}$/;
const hash = ref('');
const current = chainStore?.current?.chainName || '';

// --- live tx feed state ---
const RECENT_LIMIT = 5;
const recentTxs = ref<TxResponse[]>([]);
const loading = ref(false);
const errored = ref(false);
const lastFetchedAt = ref<number>(0);
const knownHashes = ref<Set<string>>(new Set());
const freshHashes = ref<Set<string>>(new Set()); // txs that arrived on this refresh cycle
const nowTick = ref(Date.now()); // for relative-time re-renders
let pollTimer: number | undefined;
let tickTimer: number | undefined;

onMounted(() => {
  // Gno chains: bounce bare /tx → /gno-tx before spinning the LCD poller.
  if (redirectGnoTxListIfNeeded()) return;
  tab.value = String(vueRouters.currentRoute.value.query.tab || 'recent');
  // initial fetch + short polling loop
  fetchRecent(true);
  pollTimer = window.setInterval(() => fetchRecent(false), 10_000);
  // sub-second tick just to refresh relative-time labels without spamming network
  tickTimer = window.setInterval(() => (nowTick.value = Date.now()), 1000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
  if (tickTimer) window.clearInterval(tickTimer);
});

// Refresh whenever the chain reports a new block — piggyback on the store poll
watch(
  () => base.latest?.block?.header?.height,
  (h, prev) => {
    if (h && h !== prev) fetchRecent(false);
  }
);

// If user switches chain mid-view, blow away stale data & refetch
watch(
  () => chainStore.chainName,
  (name, prev) => {
    if (name !== prev) {
      if (redirectGnoTxListIfNeeded()) return;
      recentTxs.value = [];
      knownHashes.value = new Set();
      freshHashes.value = new Set();
      fetchRecent(true);
    }
  }
);

// Engine may resolve after first paint (async setCurrent) — catch late Gno.
watch(
  () => chainStore.current?.engine,
  () => {
    redirectGnoTxListIfNeeded();
  }
);

async function fetchRecent(isInitial: boolean) {
  if (loading.value) return;
  loading.value = true;
  try {
    const res = await chainStore.fetchRecentTxs(RECENT_LIMIT);
    const rows = (res?.tx_responses || []).slice(0, RECENT_LIMIT);
    if (!rows.length && !isInitial) {
      // don't clobber the previous list on a transient miss
      errored.value = !isInitial;
      return;
    }
    // Diff by hash to compute freshness (skip on the very first mount so we
    // don't flash every row).
    const nextHashes = new Set(rows.map((r) => r.txhash));
    if (!isInitial) {
      const fresh = new Set<string>();
      for (const r of rows) {
        if (!knownHashes.value.has(r.txhash)) fresh.add(r.txhash);
      }
      freshHashes.value = fresh;
      // clear the "fresh" glow after 2.5s
      if (fresh.size) {
        window.setTimeout(() => (freshHashes.value = new Set()), 2500);
      }
    }
    knownHashes.value = nextHashes;
    recentTxs.value = rows;
    errored.value = false;
    lastFetchedAt.value = Date.now();
  } catch (e) {
    errored.value = true;
  } finally {
    loading.value = false;
  }
}

function search() {
  if (hashReg.test(hash.value)) {
    vueRouters.push({ path: `/${current}/tx/${hash.value}` });
  }
}

// --- presentation helpers ---
function shortHash(h: string): string {
  if (!h) return '';
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

// Map cosmos-sdk module → color slug (small, curated palette so pills never
// clash with the rest of the UI). Unknown modules fall through to "default".
function moduleSlug(msgTypeUrl: string): string {
  if (!msgTypeUrl) return 'default';
  const t = msgTypeUrl.toLowerCase();
  if (t.includes('cosmos.bank')) return 'bank';
  if (t.includes('cosmos.staking')) return 'staking';
  if (t.includes('cosmos.distribution')) return 'distribution';
  if (t.includes('cosmos.gov') || t.includes('gov.v1')) return 'gov';
  if (t.includes('cosmos.authz')) return 'authz';
  if (t.includes('cosmos.feegrant')) return 'feegrant';
  if (t.includes('cosmos.slashing')) return 'slashing';
  if (t.includes('cosmos.vesting')) return 'vesting';
  if (t.includes('ibc.core') || t.includes('ibc.applications.interchain_accounts')) return 'ibc';
  if (t.includes('ibc.applications.transfer')) return 'transfer';
  if (t.includes('cosmwasm.wasm') || t.includes('.wasm.')) return 'wasm';
  if (t.includes('ethermint.evm') || t.includes('.evm.') || t.includes('.evmos.')) return 'evm';
  return 'default';
}

// summarise messages into up to 2 pills + "+N more" chip
function messagePills(messages: { '@type'?: string }[]) {
  if (!messages?.length) return { pills: [] as { label: string; slug: string }[], extra: 0 };
  const counts = new Map<string, { label: string; count: number }>();
  for (const m of messages) {
    const url = m['@type'] || '';
    const label = url.substring(url.lastIndexOf('.') + 1).replace('Msg', '');
    const slug = moduleSlug(url);
    const key = `${slug}:${label}`;
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { label, count: 1 });
  }
  const entries = Array.from(counts.entries()).map(([k, v]) => ({
    label: v.count > 1 ? `${v.label}×${v.count}` : v.label,
    slug: k.split(':')[0],
  }));
  const shown = entries.slice(0, 2);
  const extra = entries.length - shown.length;
  return { pills: shown, extra };
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

// AuthInfo may arrive as either snake_case (LCD) or camelCase (proto)
// Guard both shapes so this works across SDK versions / clients.
function feeCoins(tx: any): { denom: string; amount: string }[] {
  return tx?.auth_info?.fee?.amount || tx?.authInfo?.fee?.amount || [];
}
function messages(tx: any): { '@type'?: string }[] {
  return tx?.body?.messages || [];
}

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
        <h1 class="sz-page-title">{{ $t('module.tx') }}</h1>
        <div class="sz-page-sub">
          Latest {{ recentTxs.length }} transactions · auto-updated live
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'recent' }" @click="tab = 'recent'">
          {{ $t('block.recent') }}
        </a>
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'search' }" @click="tab = 'search'">Search</a>
      </div>
    </div>

    <div v-show="tab === 'recent'" class="sz-section sz-glass sz-live-ledger overflow-hidden">
      <div class="sz-live-header">
        <div class="sz-live-badge" :class="{ 'sz-live-badge--errored': errored }">
          <span class="sz-live-dot" :class="{ 'sz-live-dot--errored': errored, 'sz-live-dot--loading': loading }"></span>
          <span class="sz-live-text">{{ errored ? 'STALLED' : 'LIVE' }}</span>
        </div>
        <div class="sz-live-meta">
          <span v-if="secondsSinceLastFetch !== null" class="sz-live-meta-item">
            updated {{ secondsSinceLastFetch }}s ago
          </span>
          <span class="sz-live-meta-item">poll · 10s</span>
          <button class="sz-live-refresh" :disabled="loading" @click="fetchRecent(false)" title="Refresh now">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="sz-live-refresh-icon" :class="{ 'sz-live-refresh-icon--spin': loading }">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="sz-table sz-ledger-table">
          <thead>
            <tr>
              <th style="width: 16%">{{ $t('account.height') }}</th>
              <th style="width: 24%">{{ $t('account.hash') }}</th>
              <th style="width: 24%">{{ $t('account.messages') }}</th>
              <th style="width: 10%">Status</th>
              <th style="width: 14%" class="text-right">{{ $t('block.fees') }}</th>
              <th style="width: 12%" class="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in recentTxs"
              :key="item.txhash || index"
              class="sz-ledger-row"
              :class="{ 'sz-ledger-row--fresh': freshHashes.has(item.txhash) }"
            >
              <td>
                <RouterLink class="sz-height-link" :to="`/${props.chain}/block/${item.height}`">
                  <span class="sz-height-hash">#</span>{{ item.height }}
                </RouterLink>
              </td>
              <td>
                <RouterLink class="sz-hash-link" :to="`/${props.chain}/tx/${item.txhash}`">
                  <span class="sz-hash sz-hash-mono">{{ shortHash(item.txhash) }}</span>
                </RouterLink>
              </td>
              <td>
                <div class="sz-msg-pills">
                  <template v-for="(p, i) in messagePills(messages(item.tx)).pills" :key="i">
                    <span class="sz-msg-pill" :data-module="p.slug">{{ p.label }}</span>
                  </template>
                  <span v-if="messagePills(messages(item.tx)).extra > 0" class="sz-msg-pill sz-msg-pill--more">
                    +{{ messagePills(messages(item.tx)).extra }}
                  </span>
                </div>
              </td>
              <td>
                <span
                  v-if="item.code === 0"
                  class="sz-status sz-status--ok"
                  title="Success"
                >
                  <span class="sz-status-glyph">✓</span>OK
                </span>
                <span
                  v-else
                  class="sz-status sz-status--fail"
                  :title="`Failed · code ${item.code}`"
                >
                  <span class="sz-status-glyph">✕</span>{{ item.code }}
                </span>
              </td>
              <td class="text-right">
                <span class="sz-fee">{{ format.formatTokens(feeCoins(item.tx)) || '—' }}</span>
              </td>
              <td class="text-right">
                <span class="sz-time" :data-age="ageBucket(item.timestamp)" :title="item.timestamp">
                  <span class="sz-time-pulse" :data-age="ageBucket(item.timestamp)"></span>
                  {{ relativeAge(item.timestamp) }}
                </span>
              </td>
            </tr>
            <tr v-if="!recentTxs.length && !loading">
              <td colspan="6" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon">◇</div>
                  <div class="sz-empty-title">{{ errored ? 'Feed temporarily unavailable' : 'Waiting for transactions' }}</div>
                  <div class="sz-empty-sub">{{ errored ? 'Retrying automatically…' : 'The chain has no recent txs to index yet.' }}</div>
                </div>
              </td>
            </tr>
            <tr v-if="!recentTxs.length && loading">
              <td colspan="6" class="sz-empty-cell">
                <div class="sz-empty-state">
                  <div class="sz-empty-icon sz-empty-icon--loading">◇</div>
                  <div class="sz-empty-title">Loading recent transactions…</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-show="tab === 'search'" class="sz-section p-5">
      <div class="form-control max-w-xl">
        <label class="sz-stat-label mb-2">Transaction Hash</label>
        <div class="flex gap-2">
          <input
            v-model="hash"
            type="text"
            class="input input-bordered flex-1 font-mono text-sm"
            placeholder="Search by Tx Hash"
            @keyup.enter="search"
          />
          <button class="btn btn-primary" @click="search">Search</button>
        </div>
      </div>
    </div>
  </div>
</template>

<route>
    {
      meta: {
        i18n: 'tx',
        order: 5
      }
    }
  </route>
