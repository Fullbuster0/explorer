<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useBlockchain, useStakingStore } from '@/stores';

type SearchKind = 'account' | 'validator' | 'tx' | 'block' | 'unknown';

interface SearchHit {
  kind: SearchKind;
  query: string;
  path: string;
  title: string;
  subtitle: string;
  icon: string;
}

interface RecentItem extends SearchHit {
  ts: number;
}

const RECENT_KEY = 'sz-search-recent';
const RECENT_MAX = 12;

const router = useRouter();
const blockStore = useBlockchain();
const staking = useStakingStore();

const open = ref(false);
const query = ref('');
const errorMessage = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const activeTab = ref<'result' | 'recent'>('result');
const recent = ref<RecentItem[]>([]);
const highlight = ref(0);

const chainName = computed(() => blockStore.current?.chainName || '');
const chainPretty = computed(
  () => blockStore.current?.prettyName || blockStore.current?.chainName || '—'
);

function loadRecent() {
  try {
    recent.value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    recent.value = [];
  }
}

function saveRecent(item: RecentItem) {
  const next = [
    item,
    ...recent.value.filter((r) => !(r.query === item.query && r.kind === item.kind)),
  ].slice(0, RECENT_MAX);
  recent.value = next;
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function clearRecent() {
  recent.value = [];
  localStorage.removeItem(RECENT_KEY);
}

function normalizeQuery(raw: string) {
  // collapse whitespace + common paste noise (0x prefix, surrounding quotes)
  return String(raw || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\s+/g, '');
}

function classify(raw: string): SearchHit | null {
  let key = normalizeQuery(raw);
  if (!key) return null;
  const current = chainName.value;
  if (!current) return null;

  // height: pure digits
  if (/^\d+$/.test(key)) {
    return {
      kind: 'block',
      query: key,
      path: `/${current}/block/${key}`,
      title: `Block #${Number(key).toLocaleString()}`,
      subtitle: chainPretty.value,
      icon: 'mdi:cube-outline',
    };
  }

  // tx hash: 64 hex, optional 0x prefix (EVM-style paste)
  const hexKey = key.replace(/^0x/i, '');
  if (/^[A-Fa-f0-9]{64}$/.test(hexKey)) {
    const hash = hexKey.toUpperCase();
    return {
      kind: 'tx',
      query: hash,
      path: `/${current}/tx/${hash}`,
      title: `${hash.slice(0, 10)}…${hash.slice(-8)}`,
      subtitle: 'Transaction · ' + chainPretty.value,
      icon: 'mdi:swap-horizontal',
    };
  }

  // bech32-ish
  if (/^[a-z0-9]{2,32}1[a-z0-9]{38,90}$/i.test(key)) {
    const lower = key.toLowerCase();
    if (lower.includes('valoper')) {
      // Try resolve moniker from loaded validators
      const moniker =
        staking.validators?.find((v) => v.operator_address?.toLowerCase() === lower)
          ?.description?.moniker || 'Validator';
      return {
        kind: 'validator',
        query: lower,
        path: `/${current}/validator/${lower}`,
        title: moniker,
        subtitle: 'Validator · ' + chainPretty.value,
        icon: 'mdi:shield-account-outline',
      };
    }
    if (lower.includes('valcons')) {
      return {
        kind: 'account',
        query: lower,
        path: `/${current}/account/${lower}`,
        title: `${lower.slice(0, 12)}…${lower.slice(-6)}`,
        subtitle: 'Consensus address · ' + chainPretty.value,
        icon: 'mdi:identifier',
      };
    }
    return {
      kind: 'account',
      query: lower,
      path: `/${current}/account/${lower}`,
      title: `${lower.slice(0, 12)}…${lower.slice(-6)}`,
      subtitle: 'Account · ' + chainPretty.value,
      icon: 'mdi:wallet-outline',
    };
  }

  return null;
}

const primaryHit = computed(() => classify(query.value));

const monikerHits = computed<SearchHit[]>(() => {
  const key = normalizeQuery(query.value);
  if (!key || key.length < 2) return [];
  // skip if already classified as address/tx/height
  if (primaryHit.value) return [];
  const current = chainName.value;
  if (!current || !staking.validators?.length) return [];
  const q = key.toLowerCase();
  return staking.validators
    .filter((v) => (v.description?.moniker || '').toLowerCase().includes(q))
    .slice(0, 8)
    .map((v) => ({
      kind: 'validator' as const,
      query: v.operator_address,
      path: `/${current}/validator/${v.operator_address}`,
      title: v.description?.moniker || v.operator_address,
      subtitle: 'Validator · ' + chainPretty.value,
      icon: 'mdi:shield-account-outline',
    }));
});

const hits = computed<SearchHit[]>(() => {
  if (primaryHit.value) return [primaryHit.value];
  return monikerHits.value;
});

const kindBadge: Record<SearchKind, { label: string; cls: string }> = {
  account: { label: 'Account', cls: 'sz-badge-account' },
  validator: { label: 'Validator', cls: 'sz-badge-validator' },
  tx: { label: 'Tx', cls: 'sz-badge-tx' },
  block: { label: 'Block', cls: 'sz-badge-block' },
  unknown: { label: '?', cls: '' },
};

watch(query, () => {
  errorMessage.value = '';
  highlight.value = 0;
  if (normalizeQuery(query.value)) activeTab.value = 'result';
});

function openModal() {
  open.value = true;
  errorMessage.value = '';
  loadRecent();
  activeTab.value = normalizeQuery(query.value) ? 'result' : 'recent';
  nextTick(() => inputRef.value?.focus());
}

function closeModal() {
  open.value = false;
  errorMessage.value = '';
}

function go(hit: SearchHit) {
  if (!hit?.path) return;
  saveRecent({ ...hit, ts: Date.now() });
  router.push({ path: hit.path });
  query.value = '';
  closeModal();
}

function confirm() {
  errorMessage.value = '';
  const key = normalizeQuery(query.value);
  if (!key) {
    errorMessage.value = 'Please enter a value';
    return;
  }
  if (!chainName.value) {
    errorMessage.value = 'Select a chain first';
    return;
  }
  const list = hits.value;
  if (!list.length) {
    errorMessage.value = 'No results. Enter an address, tx hash, block height, or validator name.';
    return;
  }
  const pick = list[Math.min(highlight.value, list.length - 1)];
  go(pick);
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (open.value) closeModal();
    else openModal();
    return;
  }
  if (!open.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const n = (activeTab.value === 'recent' ? recent.value : hits.value).length;
    if (n) highlight.value = (highlight.value + 1) % n;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const n = (activeTab.value === 'recent' ? recent.value : hits.value).length;
    if (n) highlight.value = (highlight.value - 1 + n) % n;
  }
}

function preventClick(e: Event) {
  e.preventDefault();
  e.stopPropagation();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  loadRecent();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="sz-navbar-search">
    <!-- Desktop trigger -->
    <button
      type="button"
      class="sz-search-trigger hidden md:!inline-flex"
      @click="openModal"
      aria-label="Search by address, tx hash, or height"
    >
      <Icon icon="mdi:magnify" class="text-lg text-secondary shrink-0" />
      <span class="sz-search-placeholder">Search by address, tx hash…</span>
      <kbd class="sz-search-kbd">⌘K</kbd>
    </button>

    <!-- Mobile trigger -->
    <button
      type="button"
      class="btn btn-ghost btn-circle btn-sm mx-1 md:!hidden"
      @click="openModal"
      aria-label="Search"
    >
      <Icon icon="mdi:magnify" class="text-2xl text-gray-500 dark:text-gray-400" />
    </button>

    <!-- Modal overlay -->
    <Teleport to="body">
      <div
        v-if="open"
        class="sz-search-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        @click="closeModal"
      >
        <div class="sz-search-panel" @click="preventClick">
          <!-- input row -->
          <div class="sz-search-input-row">
            <Icon icon="mdi:magnify" class="sz-search-input-icon" />
            <input
              ref="inputRef"
              v-model="query"
              class="sz-search-input"
              placeholder="Search address, hash, height, or validator…"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="confirm"
            />
            <kbd class="sz-search-esc" @click="closeModal">ESC</kbd>
          </div>

          <p class="sz-search-hint">
            Enter address, hash or height to find accounts, validators, transactions, blocks.
          </p>

          <!-- tabs -->
          <div class="sz-search-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              class="sz-search-tab"
              :class="{ 'is-active': activeTab === 'result' }"
              @click="activeTab = 'result'"
            >
              Results
              <span v-if="hits.length" class="sz-search-tab-count">{{ hits.length }}</span>
            </button>
            <button
              type="button"
              role="tab"
              class="sz-search-tab"
              :class="{ 'is-active': activeTab === 'recent' }"
              @click="activeTab = 'recent'; highlight = 0"
            >
              Recent
              <span v-if="recent.length" class="sz-search-tab-count">{{ recent.length }}</span>
            </button>
            <button
              v-if="activeTab === 'recent' && recent.length"
              type="button"
              class="sz-search-clear"
              @click="clearRecent"
            >
              Clear
            </button>
          </div>

          <!-- results -->
          <div v-if="activeTab === 'result'" class="sz-search-list">
            <div v-if="!chainName" class="sz-search-empty">
              Select a chain first to search.
            </div>
            <div v-else-if="!normalizeQuery(query)" class="sz-search-empty">
              Start typing an address, tx hash, block height, or validator moniker.
            </div>
            <div v-else-if="!hits.length" class="sz-search-empty">
              No results found.
              <div class="mt-1 text-[12px] opacity-70">Please enter a correct address, hash, height, or name.</div>
            </div>
            <button
              v-for="(hit, i) in hits"
              :key="hit.kind + hit.path"
              type="button"
              class="sz-search-row"
              :class="{ 'is-active': highlight === i }"
              @mouseenter="highlight = i"
              @click="go(hit)"
            >
              <span class="sz-search-row-icon">
                <Icon :icon="hit.icon" />
              </span>
              <span class="sz-search-row-body min-w-0">
                <span class="sz-search-row-title truncate">{{ hit.title }}</span>
                <span class="sz-search-row-sub truncate">{{ hit.subtitle }}</span>
              </span>
              <span class="sz-search-badge" :class="kindBadge[hit.kind].cls">
                {{ kindBadge[hit.kind].label }}
              </span>
            </button>
          </div>

          <!-- recent -->
          <div v-else class="sz-search-list">
            <div v-if="!recent.length" class="sz-search-empty">No recent searches</div>
            <button
              v-for="(hit, i) in recent"
              :key="hit.ts + hit.path"
              type="button"
              class="sz-search-row"
              :class="{ 'is-active': highlight === i }"
              @mouseenter="highlight = i"
              @click="go(hit)"
            >
              <span class="sz-search-row-icon">
                <Icon :icon="hit.icon || 'mdi:history'" />
              </span>
              <span class="sz-search-row-body min-w-0">
                <span class="sz-search-row-title truncate">{{ hit.title }}</span>
                <span class="sz-search-row-sub truncate">{{ hit.subtitle }}</span>
              </span>
              <span class="sz-search-badge" :class="kindBadge[hit.kind]?.cls">
                {{ kindBadge[hit.kind]?.label || hit.kind }}
              </span>
            </button>
          </div>

          <div v-if="errorMessage" class="sz-search-error">{{ errorMessage }}</div>

          <div class="sz-search-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sz-search-trigger {
  align-items: center;
  gap: 0.6rem;
  min-width: 17rem;
  max-width: 24rem;
  height: 2.35rem;
  padding: 0 0.85rem;
  border-radius: 999px;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b1)) 94%, transparent);
  color: hsl(var(--bc));
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.sz-search-trigger:hover {
  border-color: color-mix(in srgb, hsl(var(--p)) 40%, transparent);
  box-shadow: 0 0 0 3px var(--sz-glow);
}
.sz-search-placeholder {
  flex: 1;
  text-align: left;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sz-search-kbd {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  line-height: 1;
  padding: 0.2rem 0.4rem;
  border-radius: 0.35rem;
  border: 1px solid var(--sz-border);
  color: var(--text-secondary);
  background: color-mix(in srgb, hsl(var(--b2)) 70%, transparent);
}

/* ---- overlay / panel (nodes.guru-style command palette) ---- */
.sz-search-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 10vh 1rem 2rem;
  background: rgba(6, 10, 20, 0.62);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  cursor: pointer;
}
.sz-search-panel {
  cursor: default;
  width: min(92vw, 36rem);
  max-height: min(78vh, 40rem);
  display: flex;
  flex-direction: column;
  border-radius: 1.1rem;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b1)) 96%, transparent);
  box-shadow:
    0 24px 64px -24px rgba(0, 0, 0, 0.55),
    0 0 0 1px color-mix(in srgb, hsl(var(--p)) 12%, transparent);
  overflow: hidden;
}
.sz-search-input-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.95rem 1rem 0.55rem;
}
.sz-search-input-icon {
  font-size: 1.35rem;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.sz-search-input {
  flex: 1;
  min-width: 0;
  height: 2.5rem;
  background: transparent;
  border: none;
  outline: none;
  font-size: 1rem;
  color: hsl(var(--bc));
}
.sz-search-input::placeholder {
  color: color-mix(in srgb, var(--text-secondary) 80%, transparent);
}
.sz-search-esc {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0.28rem 0.5rem;
  border-radius: 0.4rem;
  border: 1px solid var(--sz-border);
  color: var(--text-secondary);
  background: color-mix(in srgb, hsl(var(--b2)) 70%, transparent);
  cursor: pointer;
  flex-shrink: 0;
}
.sz-search-hint {
  margin: 0 1rem 0.65rem;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--text-secondary);
}
.sz-search-tabs {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--sz-border);
}
.sz-search-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.55rem 0.75rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
}
.sz-search-tab.is-active {
  color: hsl(var(--bc));
  border-bottom-color: hsl(var(--p));
}
.sz-search-tab-count {
  min-width: 1.15rem;
  height: 1.05rem;
  padding: 0 0.3rem;
  border-radius: 999px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.65rem;
  font-weight: 700;
  background: color-mix(in srgb, currentColor 14%, transparent);
}
.sz-search-clear {
  margin-left: auto;
  padding: 0.35rem 0.6rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
}
.sz-search-clear:hover {
  color: hsl(var(--bc));
}
.sz-search-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.4rem;
  min-height: 8rem;
}
.sz-search-empty {
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.sz-search-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.7rem 0.75rem;
  border-radius: 0.75rem;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: hsl(var(--bc));
  transition: background 0.12s ease, border-color 0.12s ease;
}
.sz-search-row:hover,
.sz-search-row.is-active {
  background: color-mix(in srgb, hsl(var(--p)) 10%, transparent);
  border-color: color-mix(in srgb, hsl(var(--p)) 22%, transparent);
}
.sz-search-row-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 0.65rem;
  background: color-mix(in srgb, hsl(var(--b2)) 80%, transparent);
  border: 1px solid var(--sz-border);
  color: var(--text-secondary);
  font-size: 1.1rem;
  flex-shrink: 0;
}
.sz-search-row.is-active .sz-search-row-icon {
  color: hsl(var(--p));
  border-color: color-mix(in srgb, hsl(var(--p)) 35%, transparent);
}
.sz-search-row-body {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  flex: 1;
}
.sz-search-row-title {
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.sz-search-row-sub {
  font-size: 0.72rem;
  color: var(--text-secondary);
}
.sz-search-badge {
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.22rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--sz-border);
  color: var(--text-secondary);
  background: color-mix(in srgb, hsl(var(--b2)) 60%, transparent);
}
.sz-badge-account {
  color: #38bdf8;
  border-color: color-mix(in srgb, #38bdf8 35%, transparent);
  background: color-mix(in srgb, #38bdf8 12%, transparent);
}
.sz-badge-validator {
  color: #a78bfa;
  border-color: color-mix(in srgb, #a78bfa 35%, transparent);
  background: color-mix(in srgb, #a78bfa 12%, transparent);
}
.sz-badge-tx {
  color: #34d399;
  border-color: color-mix(in srgb, #34d399 35%, transparent);
  background: color-mix(in srgb, #34d399 12%, transparent);
}
.sz-badge-block {
  color: #fbbf24;
  border-color: color-mix(in srgb, #fbbf24 35%, transparent);
  background: color-mix(in srgb, #fbbf24 12%, transparent);
}
.sz-search-error {
  padding: 0.4rem 1rem;
  font-size: 0.78rem;
  color: hsl(var(--er));
  text-align: center;
}
.sz-search-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  padding: 0.55rem 1rem 0.7rem;
  border-top: 1px solid var(--sz-border);
  font-size: 0.7rem;
  color: var(--text-secondary);
}
/* Keyboard hints are meaningless on touch — hide on mobile */
@media (max-width: 767px) {
  .sz-search-footer {
    display: none;
  }
}
.sz-search-footer kbd {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.65rem;
  padding: 0.1rem 0.3rem;
  margin: 0 0.1rem;
  border-radius: 0.25rem;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b2)) 70%, transparent);
}
</style>
