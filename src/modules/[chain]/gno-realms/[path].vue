<script lang="ts" setup>
/**
 * Gno realm detail — package path stats from onbloc indexer.
 * Route param is encodeURIComponent(pkg path) so slashes survive as one segment.
 * NO meta.i18n — detail pages must not appear in sidebar.
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useBlockchain } from '@/stores';
import { getGnoIndexer, type GnoRealm, type GnoTx } from '@/libs/gno/indexer';

const props = defineProps<{ chain: string; path: string }>();
const chainStore = useBlockchain();

const realm = ref<GnoRealm | null>(null);
const publisherTxs = ref<GnoTx[]>([]);
const loading = ref(false);
const errored = ref(false);
const notFound = ref(false);
const loadToken = ref(0);

const indexerUrl = computed(() => (chainStore.current as any)?.indexer_api || '');
const hasIndexer = computed(() => !!indexerUrl.value);

/** Decoded package path (gno.land/r/…). */
const pkgPath = computed(() => {
  let raw = String(props.path || '').trim();
  // Peel up to 2 URI layers (route + copy/paste double-encode)
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(raw);
      if (d === raw) break;
      raw = d;
    } catch {
      break;
    }
  }
  return raw;
});

const shortPath = computed(() => (pkgPath.value || '').replace(/^gno\.land\//, ''));

function gnowebUrl(path: string): string {
  const base = (chainStore.current as any)?.gnoweb || 'https://topaz.testnets.gno.land';
  const p = path.replace(/^gno\.land/, '');
  return `${base.replace(/\/$/, '')}${p}`;
}

function shortAddr(a?: string): string {
  if (!a) return '—';
  return a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a;
}

function formatBytes(n: number | string | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB`;
}

function formatGas(r: GnoRealm | null): string {
  if (!r?.totalGasUsed?.value) return '—';
  const n = Number(r.totalGasUsed.value);
  if (!Number.isFinite(n)) return r.totalGasUsed.value;
  return n.toLocaleString();
}

function formatDeposit(r: GnoRealm | null): string {
  const raw = r?.totalStorageDeposit?.value;
  if (!raw || raw === '0') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if ((r?.totalStorageDeposit?.denom || '') === 'ugnot') {
    return `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} GNOT`;
  }
  return `${n.toLocaleString()} ${r?.totalStorageDeposit?.denom || ''}`;
}

function shortHash(h: string): string {
  if (!h) return '—';
  return h.length > 18 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function gnoFuncLabel(tx: GnoTx): string {
  const f = tx.func?.[0];
  if (!f) return 'Tx';
  return f.funcType || f.messageType?.split('.').pop() || 'Tx';
}

async function loadRealm() {
  const token = ++loadToken.value;
  realm.value = null;
  publisherTxs.value = [];
  notFound.value = false;
  errored.value = false;
  if (!hasIndexer.value || !pkgPath.value) {
    if (!pkgPath.value) notFound.value = true;
    return;
  }
  loading.value = true;
  try {
    const client = getGnoIndexer(indexerUrl.value);
    let hit: GnoRealm | undefined;
    const maxAttempts = 3;
    let lastErr: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        hit = await client.getRealmByPath(pkgPath.value);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    if (token !== loadToken.value) return;
    if (lastErr) {
      errored.value = true;
      return;
    }
    if (!hit) {
      notFound.value = true;
      return;
    }
    realm.value = hit;
    // Publisher recent activity (best-effort; not realm-filtered — indexer has no realm tx feed)
    if (hit.publisher) {
      try {
        const page = await client.getAccountTransactions(hit.publisher);
        if (token !== loadToken.value) return;
        publisherTxs.value = (page.items || []).slice(0, 8);
      } catch {
        /* optional */
      }
    }
  } finally {
    if (token === loadToken.value) loading.value = false;
  }
}

onMounted(loadRealm);
watch(
  () => [props.path, props.chain, indexerUrl.value] as const,
  () => loadRealm()
);
watch(
  () => chainStore.endpoint?.address,
  () => {
    // Indexer-only page; still re-fire if empty after endpoint churn
    if (!realm.value && !loading.value) loadRealm();
  }
);
if (typeof document !== 'undefined') {
  const onVis = () => {
    if (document.visibilityState === 'visible' && hasIndexer.value && !realm.value && !loading.value) {
      loadRealm();
    }
  };
  document.addEventListener('visibilitychange', onVis);
  onUnmounted(() => document.removeEventListener('visibilitychange', onVis));
}
</script>

<template>
  <div>
    <div class="sz-page-head">
      <div class="min-w-0">
        <div class="sz-section-kicker">
          <RouterLink class="hover:underline opacity-80" :to="`/${chain}/gno-realms`">Realms</RouterLink>
          <span class="opacity-40 mx-1">/</span>
          Detail
        </div>
        <h1 class="sz-page-title truncate" :title="pkgPath">
          {{ realm?.name || shortPath || 'Realm' }}
        </h1>
        <div class="sz-page-sub font-mono text-xs break-all opacity-80">
          {{ pkgPath || '—' }}
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 shrink-0">
        <a
          v-if="pkgPath"
          class="btn btn-sm btn-ghost"
          :href="gnowebUrl(pkgPath)"
          target="_blank"
          rel="noopener"
        >Open gnoweb</a>
        <button class="btn btn-sm btn-ghost" :disabled="loading" @click="loadRealm">Refresh</button>
      </div>
    </div>

    <div v-if="!hasIndexer" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-icon">◇</div>
        <div class="sz-empty-title">Indexer not configured</div>
        <div class="sz-empty-sub">Realm detail needs the Onbloc indexer.</div>
      </div>
    </div>

    <div v-else-if="loading && !realm" class="sz-section sz-glass p-8 text-center">
      <div class="sz-empty-icon sz-empty-icon--loading mx-auto mb-2">◇</div>
      <div class="text-sm opacity-70">Loading realm…</div>
    </div>

    <div v-else-if="errored" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-icon">◇</div>
        <div class="sz-empty-title">Failed to load realm</div>
        <div class="sz-empty-sub">We'll retry when the connection recovers.</div>
        <button class="btn btn-sm btn-primary mt-3" @click="loadRealm">Try again</button>
      </div>
    </div>

    <div v-else-if="notFound" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-icon">◇</div>
        <div class="sz-empty-title">Realm not found</div>
        <div class="sz-empty-sub font-mono text-xs break-all">{{ pkgPath }}</div>
        <RouterLink class="btn btn-sm btn-ghost mt-3" :to="`/${chain}/gno-realms`">Back to realms</RouterLink>
      </div>
    </div>

    <template v-else-if="realm">
      <!-- Stats -->
      <div class="grid grid-cols-2 md:!grid-cols-4 gap-3 mb-4">
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Functions</div>
          <div class="text-xl font-semibold font-mono">{{ realm.funcCount ?? '—' }}</div>
        </div>
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Calls</div>
          <div class="text-xl font-semibold font-mono">
            <span class="text-green-600">{{ realm.totalCallCountSuccess ?? 0 }}</span>
            <span v-if="realm.totalCallCountFailed" class="text-red-500 text-sm ml-1">/ {{ realm.totalCallCountFailed }}✗</span>
          </div>
        </div>
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Storage</div>
          <div class="text-xl font-semibold font-mono">{{ formatBytes(realm.totalStorageUsage || realm.storageUsage?.value) }}</div>
        </div>
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Published</div>
          <div class="text-xl font-semibold font-mono">
            <RouterLink
              v-if="realm.blockHeight"
              class="sz-height-link"
              :to="`/${chain}/block/${realm.blockHeight}`"
            >#{{ realm.blockHeight }}</RouterLink>
            <span v-else>—</span>
          </div>
        </div>
      </div>

      <div class="sz-section sz-glass overflow-hidden mb-4">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Package</div>
            <div class="sz-section-title">Identity</div>
          </div>
        </div>
        <div class="p-4 grid gap-3 text-sm">
          <div class="flex flex-wrap gap-x-6 gap-y-2">
            <div>
              <div class="text-[11px] uppercase tracking-wide opacity-50">Name</div>
              <div class="font-semibold">{{ realm.name || '—' }}</div>
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-[11px] uppercase tracking-wide opacity-50">Path</div>
              <div class="font-mono text-xs break-all">{{ realm.path }}</div>
            </div>
          </div>
          <div class="flex flex-wrap gap-x-6 gap-y-2">
            <div>
              <div class="text-[11px] uppercase tracking-wide opacity-50">Publisher</div>
              <RouterLink
                v-if="realm.publisher"
                class="font-mono text-xs hover:underline text-primary"
                :to="`/${chain}/account/${realm.publisher}`"
              >{{ shortAddr(realm.publisher) }}</RouterLink>
              <span v-else>—</span>
              <div v-if="realm.publisherName" class="text-[10px] opacity-60">{{ realm.publisherName }}</div>
            </div>
            <div>
              <div class="text-[11px] uppercase tracking-wide opacity-50">Gas used (total)</div>
              <div class="font-mono text-xs">{{ formatGas(realm) }}</div>
            </div>
            <div>
              <div class="text-[11px] uppercase tracking-wide opacity-50">Storage deposit</div>
              <div class="font-mono text-xs">{{ formatDeposit(realm) }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="publisherTxs.length" class="sz-section sz-glass overflow-hidden mb-4">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Publisher</div>
            <div class="sz-section-title">Recent activity</div>
            <div class="text-xs opacity-60 mt-0.5">
              Latest txs from the publisher account (indexer has no per-realm call feed).
            </div>
          </div>
          <RouterLink
            v-if="realm.publisher"
            class="btn btn-sm btn-ghost"
            :to="`/${chain}/account/${realm.publisher}`"
          >Full account</RouterLink>
        </div>
        <div class="overflow-x-auto">
          <table class="sz-table sz-ledger-table">
            <thead>
              <tr>
                <th>Hash</th>
                <th>Func</th>
                <th>Height</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(tx, i) in publisherTxs" :key="tx.txHash || i" class="sz-ledger-row">
                <td>
                  <RouterLink class="font-mono text-xs hover:underline" :to="`/${chain}/tx/${encodeURIComponent(tx.txHash)}`">
                    {{ shortHash(tx.txHash) }}
                  </RouterLink>
                </td>
                <td class="text-xs">{{ gnoFuncLabel(tx) }}</td>
                <td>
                  <RouterLink class="sz-height-link" :to="`/${chain}/block/${tx.blockHeight}`">
                    #{{ tx.blockHeight }}
                  </RouterLink>
                </td>
                <td>
                  <span class="sz-chip" :class="tx.successYn ? 'sz-chip--ok' : 'sz-chip--bad'">
                    {{ tx.successYn ? 'OK' : 'Fail' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<!-- no meta.i18n — keep out of sidebar -->
