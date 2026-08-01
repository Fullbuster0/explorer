<script lang="ts" setup>
/**
 * Gno GRC20 token detail — from onbloc indexer.
 * Route param = encodeURIComponent(tokenId or path).
 * NO meta.i18n — detail must not enter sidebar.
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useBlockchain } from '@/stores';
import { getGnoIndexer, type GnoToken, type GnoRealm } from '@/libs/gno/indexer';

const props = defineProps<{ chain: string; tokenId: string }>();
const chainStore = useBlockchain();

const token = ref<GnoToken | null>(null);
const realm = ref<GnoRealm | null>(null);
const loading = ref(false);
const errored = ref(false);
const notFound = ref(false);
const loadToken = ref(0);

const indexerUrl = computed(() => (chainStore.current as any)?.indexer_api || '');
const hasIndexer = computed(() => !!indexerUrl.value);

const key = computed(() => {
  let raw = String(props.tokenId || '').trim();
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

function gnowebUrl(path: string): string {
  const base = (chainStore.current as any)?.gnoweb || 'https://topaz.testnets.gno.land';
  // Always join with exactly one '/'. Without the separator a crafted realm
  // path like `gno.land@evil.com` would yield `https://<gnoweb>@evil.com`,
  // which browsers parse as host=evil.com (userinfo open-redirect).
  const p = path.replace(/^gno\.land/, '').replace(/^\//, '');
  return `${base.replace(/\/$/, '')}/${p}`;
}

function formatSupply(t: GnoToken | null): string {
  if (!t) return '—';
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
  if (human >= 1) return human.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return human.toFixed(Math.min(dec, 8));
}

function shortPath(path: string): string {
  return (path || '').replace(/^gno\.land\//, '');
}

async function load() {
  const tokenN = ++loadToken.value;
  token.value = null;
  realm.value = null;
  notFound.value = false;
  errored.value = false;
  if (!hasIndexer.value || !key.value) {
    if (!key.value) notFound.value = true;
    return;
  }
  loading.value = true;
  try {
    const client = getGnoIndexer(indexerUrl.value);
    let hit: GnoToken | undefined;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        hit = await client.getTokenByKey(key.value);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    if (tokenN !== loadToken.value) return;
    if (lastErr) {
      errored.value = true;
      return;
    }
    if (!hit) {
      notFound.value = true;
      return;
    }
    token.value = hit;
    if (hit.path) {
      try {
        const r = await client.getRealmByPath(hit.path);
        if (tokenN !== loadToken.value) return;
        realm.value = r || null;
      } catch {
        /* optional */
      }
    }
  } finally {
    if (tokenN === loadToken.value) loading.value = false;
  }
}

onMounted(load);
watch(
  () => [props.tokenId, props.chain, indexerUrl.value] as const,
  () => load()
);
if (typeof document !== 'undefined') {
  const onVis = () => {
    if (document.visibilityState === 'visible' && hasIndexer.value && !token.value && !loading.value) load();
  };
  document.addEventListener('visibilitychange', onVis);
  onUnmounted(() => document.removeEventListener('visibilitychange', onVis));
}

const funcs = computed(() => token.value?.funcTypesList || []);
</script>

<template>
  <div>
    <div class="sz-page-head">
      <div class="min-w-0 flex items-start gap-3">
        <img
          v-if="token?.logoUrl"
          :src="token.logoUrl"
          :alt="token.symbol"
          class="w-12 h-12 rounded-full bg-slate-100 object-contain shrink-0 mt-1"
          @error="($event.target as HTMLImageElement).style.display = 'none'"
        />
        <div class="min-w-0">
          <div class="sz-section-kicker">
            <RouterLink class="hover:underline opacity-80" :to="`/${chain}/gno-tokens`">Tokens</RouterLink>
            <span class="opacity-40 mx-1">/</span>
            Detail
          </div>
          <h1 class="sz-page-title truncate">
            {{ token?.name || token?.symbol || key || 'Token' }}
          </h1>
          <div class="sz-page-sub">
            <span v-if="token?.symbol" class="font-mono font-semibold mr-2">{{ token.symbol }}</span>
            <span class="font-mono text-xs opacity-70 break-all">{{ token?.tokenId || key }}</span>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 shrink-0">
        <a
          v-if="token?.path"
          class="btn btn-sm btn-ghost"
          :href="gnowebUrl(token.path)"
          target="_blank"
          rel="noopener"
        >Open gnoweb</a>
        <button class="btn btn-sm btn-ghost" :disabled="loading" @click="load">Refresh</button>
      </div>
    </div>

    <div v-if="!hasIndexer" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-icon">◇</div>
        <div class="sz-empty-title">Indexer not configured</div>
      </div>
    </div>

    <div v-else-if="loading && !token" class="sz-section sz-glass p-8 text-center">
      <div class="sz-empty-icon sz-empty-icon--loading mx-auto mb-2">◇</div>
      <div class="text-sm opacity-70">Loading token…</div>
    </div>

    <div v-else-if="errored" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-title">Failed to load token</div>
        <button class="btn btn-sm btn-primary mt-3" @click="load">Try again</button>
      </div>
    </div>

    <div v-else-if="notFound" class="sz-section sz-glass p-6">
      <div class="sz-empty-state">
        <div class="sz-empty-title">Token not found</div>
        <div class="sz-empty-sub font-mono text-xs break-all">{{ key }}</div>
        <RouterLink class="btn btn-sm btn-ghost mt-3" :to="`/${chain}/gno-tokens`">Back to tokens</RouterLink>
      </div>
    </div>

    <template v-else-if="token">
      <div class="grid grid-cols-2 md:!grid-cols-4 gap-3 mb-4">
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Supply</div>
          <div class="text-xl font-semibold font-mono">{{ formatSupply(token) }}</div>
          <div class="text-[10px] opacity-50 mt-0.5">raw {{ token.totalSupply }}</div>
        </div>
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Holders</div>
          <div class="text-xl font-semibold font-mono">{{ token.holders?.toLocaleString() ?? '—' }}</div>
        </div>
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Decimals</div>
          <div class="text-xl font-semibold font-mono">{{ token.decimals ?? '—' }}</div>
        </div>
        <div class="sz-section sz-glass p-4">
          <div class="sz-section-kicker">Functions</div>
          <div class="text-xl font-semibold font-mono">{{ funcs.length }}</div>
        </div>
      </div>

      <div class="sz-section sz-glass overflow-hidden mb-4">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">GRC20</div>
            <div class="sz-section-title">Package</div>
          </div>
        </div>
        <div class="p-4 grid gap-3 text-sm">
          <div>
            <div class="text-[11px] uppercase tracking-wide opacity-50">Realm path</div>
            <RouterLink
              v-if="token.path"
              class="font-mono text-xs hover:underline text-primary break-all"
              :to="`/${chain}/gno-realms/${encodeURIComponent(token.path)}`"
            >{{ shortPath(token.path) }}</RouterLink>
            <span v-else class="font-mono text-xs">—</span>
          </div>
          <div v-if="token.owner">
            <div class="text-[11px] uppercase tracking-wide opacity-50">Owner</div>
            <RouterLink class="font-mono text-xs hover:underline" :to="`/${chain}/account/${token.owner}`">
              {{ token.owner }}
            </RouterLink>
          </div>
          <div v-if="realm" class="flex flex-wrap gap-4 text-xs opacity-80">
            <span>Realm calls ok: <b class="font-mono">{{ realm.totalCallCountSuccess }}</b></span>
            <span>Funcs: <b class="font-mono">{{ realm.funcCount }}</b></span>
            <RouterLink v-if="realm.blockHeight" class="sz-height-link" :to="`/${chain}/block/${realm.blockHeight}`">
              published #{{ realm.blockHeight }}
            </RouterLink>
          </div>
        </div>
      </div>

      <div v-if="funcs.length" class="sz-section sz-glass overflow-hidden mb-4">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">ABI surface</div>
            <div class="sz-section-title">Exported functions</div>
          </div>
        </div>
        <div class="p-4 flex flex-wrap gap-1.5">
          <span
            v-for="f in funcs"
            :key="f"
            class="sz-chip font-mono !text-[10px]"
          >{{ f }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
