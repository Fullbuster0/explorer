<script lang="ts" setup>
/**
 * Global search (⌘K).
 *
 * Style rule: NO generic category icons (wallet/shield/cube). Rows are
 * text + kind badge only. The only image allowed is a moniker Keybase
 * avatar when already cached in localStorage (`avatars`) — same source
 * as validators / blocks pages.
 *
 * Matching (A+B):
 *  - exact: full bech32, 64-hex tx, block height
 *  - prefix: partial bech32 (≥8), valoper/account, identity hex
 *  - moniker: startsWith > includes > fuzzy (Levenshtein ≤2), rank boost
 *  - gov: pure digits dual-hit Block + Proposal; `#1050` / `prop 1050`
 *  - short hash: match Recent full hash; otherwise soft hint (no LCD)
 */
import { Icon } from '@iconify/vue';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useBlockchain, useStakingStore } from '@/stores';

type SearchKind = 'account' | 'validator' | 'tx' | 'block' | 'proposal' | 'unknown';

interface SearchHit {
  kind: SearchKind;
  query: string;
  path: string;
  title: string;
  subtitle: string;
  /** Keybase moniker avatar only — never a generic glyph. */
  logo?: string;
  /** Sort key (higher first). */
  score?: number;
}

interface RecentItem extends SearchHit {
  ts: number;
}

const RECENT_KEY = 'sz-search-recent';
const RECENT_MAX = 12;
const PREFIX_MIN = 8;
const MONIKER_MIN = 2;

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
const bech32Prefix = computed(() => blockStore.current?.bech32Prefix || '');

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
  return String(raw || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\s+/g, ' ');
}

/** Collapse inner spaces for address/hash classifiers (keep one space for "prop 1050"). */
function compactKey(raw: string) {
  return normalizeQuery(raw).replace(/\s+/g, '');
}

function shortAddr(a: string): string {
  if (!a) return '';
  return a.length > 22 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a;
}

/** Cached Keybase avatar only — empty string if unknown (no placeholder icon). */
function avatarForIdentity(identity?: string): string {
  const id = (identity || '').trim();
  if (!id) return '';
  try {
    const cache = JSON.parse(localStorage.getItem('avatars') || '{}') as Record<string, string>;
    const url = cache[id] || '';
    if (!url) return '';
    return url.startsWith('http')
      ? url
      : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
  } catch {
    return '';
  }
}

function valoperToAccount(valoper: string): string {
  try {
    const { prefix, data } = fromBech32(valoper);
    if (!prefix.includes('valoper')) return '';
    return toBech32(prefix.replace('valoper', ''), data);
  } catch {
    return '';
  }
}

function findValidatorByOper(oper: string) {
  const lower = oper.toLowerCase();
  return staking.validators?.find((v) => v.operator_address?.toLowerCase() === lower);
}

function findValidatorByAccount(acc: string) {
  const lower = acc.toLowerCase();
  return staking.validators?.find((v) => {
    const a = valoperToAccount(v.operator_address || '');
    return a && a.toLowerCase() === lower;
  });
}

/** Levenshtein with early exit when distance > max. */
function levenshtein(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function monikerScore(moniker: string, q: string): number {
  const m = (moniker || '').toLowerCase().trim();
  if (!m || !q) return 0;
  if (m === q) return 1000;
  if (m.startsWith(q)) return 900 - Math.min(m.length, 80);
  // word-boundary startsWith
  const words = m.split(/[\s\-_/|]+/);
  if (words.some((w) => w.startsWith(q))) return 750;
  const idx = m.indexOf(q);
  if (idx >= 0) return 500 - Math.min(idx, 40);
  if (q.length >= 3 && m.length <= 48) {
    // compare against moniker head of similar length
    const window = m.slice(0, Math.min(m.length, q.length + 3));
    const d = levenshtein(window, q, 2);
    if (d <= 2) return 280 - d * 60;
    const dFull = m.length <= 24 ? levenshtein(m, q, 2) : 99;
    if (dFull <= 2) return 220 - dFull * 50;
  }
  return 0;
}

function identityScore(identity: string, q: string): number {
  const id = (identity || '').toLowerCase();
  const k = q.toLowerCase().replace(/^0x/, '');
  if (!id || k.length < 4) return 0;
  if (id === k) return 950;
  if (id.startsWith(k) || k.startsWith(id)) return 700;
  if (id.includes(k)) return 400;
  return 0;
}

function websiteScore(website: string, q: string): number {
  if (!website || q.length < 3) return 0;
  try {
    const host = website
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .toLowerCase();
    if (host.includes(q)) return 350;
  } catch {
    /* ignore */
  }
  return 0;
}

function validatorHit(v: {
  operator_address: string;
  description?: { moniker?: string; identity?: string; website?: string };
  delegator_shares?: string;
}, score: number, reason: string): SearchHit {
  const moniker = v.description?.moniker || shortAddr(v.operator_address);
  const rankBoost = 0; // rank applied by caller via score already
  return {
    kind: 'validator',
    query: v.operator_address,
    path: `/${chainName.value}/validator/${v.operator_address}`,
    title: moniker,
    subtitle: reason,
    logo: avatarForIdentity(v.description?.identity),
    score: score + rankBoost,
  };
}

function parseProposalQuery(raw: string): number | null {
  const s = normalizeQuery(raw);
  // #1050 | prop 1050 | proposal #1050 | prop1050
  const m = s.match(/^(?:#|prop(?:osal)?\s*#?)(\d+)$/i);
  if (m) return Number(m[1]);
  return null;
}

function isFullBech32(key: string): boolean {
  return /^[a-z0-9]{2,32}1[a-z0-9]{38,90}$/i.test(key);
}

function isPartialBech32(key: string): boolean {
  // prefix-friendly: hrp1 + at least a few data chars, not necessarily complete
  if (key.length < PREFIX_MIN) return false;
  if (isFullBech32(key)) return false;
  // More lenient: allow shorter data part (≥3 chars after "1")
  return /^[a-z0-9]{2,32}1[a-z0-9]{3,}$/i.test(key);
}

function isHexHash(key: string): string | null {
  const hex = key.replace(/^0x/i, '');
  if (/^[A-Fa-f0-9]{64}$/.test(hex)) return hex.toUpperCase();
  return null;
}

function isHexPrefix(key: string): string | null {
  const hex = key.replace(/^0x/i, '');
  if (/^[A-Fa-f0-9]{8,63}$/.test(hex)) return hex.toUpperCase();
  return null;
}

function buildHits(raw: string): SearchHit[] {
  const display = normalizeQuery(raw);
  if (!display) return [];
  const current = chainName.value;
  if (!current) return [];

  const keyCompact = compactKey(display);
  const keyLower = keyCompact.toLowerCase();
  const results: SearchHit[] = [];
  const seen = new Set<string>();

  const push = (hit: SearchHit) => {
    const k = `${hit.kind}:${hit.path}`;
    if (seen.has(k)) return;
    seen.add(k);
    results.push(hit);
  };

  // --- Proposal explicit: #1050 / prop 1050 ---
  const propExplicit = parseProposalQuery(display);
  if (propExplicit != null && Number.isFinite(propExplicit)) {
    push({
      kind: 'proposal',
      query: String(propExplicit),
      path: `/${current}/gov/${propExplicit}`,
      title: `Proposal #${propExplicit.toLocaleString()}`,
      subtitle: 'Governance · ' + chainPretty.value,
      score: 980,
    });
    // If bare #N only proposal; if also pure digits handled below for dual
    if (/^#/.test(display.trim()) || /^prop/i.test(display.trim())) {
      return results.sort((a, b) => (b.score || 0) - (a.score || 0));
    }
  }

  // --- Pure digits: Block + Proposal dual hit ---
  if (/^\d+$/.test(keyCompact)) {
    const n = Number(keyCompact);
    push({
      kind: 'block',
      query: keyCompact,
      path: `/${current}/block/${keyCompact}`,
      title: `Block #${n.toLocaleString()}`,
      subtitle: chainPretty.value,
      score: 970,
    });
    push({
      kind: 'proposal',
      query: keyCompact,
      path: `/${current}/gov/${keyCompact}`,
      title: `Proposal #${n.toLocaleString()}`,
      subtitle: 'Governance · ' + chainPretty.value,
      score: 960,
    });
    return results.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  // --- Full tx hash ---
  const fullHash = isHexHash(keyCompact);
  if (fullHash) {
    push({
      kind: 'tx',
      query: fullHash,
      path: `/${current}/tx/${fullHash}`,
      title: `${fullHash.slice(0, 10)}…${fullHash.slice(-8)}`,
      subtitle: 'Transaction · ' + chainPretty.value,
      score: 990,
    });
    return results;
  }

  // --- Short / truncated hash: Recent full-hash match only ---
  const hashPrefix = isHexPrefix(keyCompact);
  if (hashPrefix) {
    const fromRecent = recent.value.filter(
      (r) => r.kind === 'tx' && r.query?.toUpperCase().startsWith(hashPrefix)
    );
    fromRecent.forEach((r) =>
      push({
        ...r,
        subtitle: 'From recent · ' + chainPretty.value,
        score: 880,
      })
    );
    if (!fromRecent.length) {
      push({
        kind: 'tx',
        query: hashPrefix,
        path: `/${current}/tx/${hashPrefix}`,
        title: `${hashPrefix.slice(0, 12)}${hashPrefix.length > 12 ? '…' : ''}`,
        subtitle: 'Tx hash prefix — paste full 64-char hash to open',
        score: 200,
      });
    }
    // continue — may also match identity hex on validators
  }

  // --- Full bech32 ---
  if (isFullBech32(keyCompact)) {
    const lower = keyLower;
    if (lower.includes('valoper')) {
      const v = findValidatorByOper(lower);
      const moniker = v?.description?.moniker || 'Validator';
      push({
        kind: 'validator',
        query: lower,
        path: `/${current}/validator/${lower}`,
        title: moniker,
        subtitle: 'Validator · ' + chainPretty.value,
        logo: avatarForIdentity(v?.description?.identity),
        score: 990,
      });
    } else if (lower.includes('valcons')) {
      push({
        kind: 'account',
        query: lower,
        path: `/${current}/account/${lower}`,
        title: shortAddr(lower),
        subtitle: 'Consensus address · ' + chainPretty.value,
        score: 900,
      });
    } else {
      // account — also surface self-validator if this is a val self-bond addr
      const asVal = findValidatorByAccount(lower);
      push({
        kind: 'account',
        query: lower,
        path: `/${current}/account/${lower}`,
        title: shortAddr(lower),
        subtitle: 'Account · ' + chainPretty.value,
        score: 980,
      });
      if (asVal) {
        push(
          validatorHit(
            asVal,
            970,
            `Operator for this account · ${chainPretty.value}`
          )
        );
      }
    }
    return results.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  // --- Partial bech32 prefix ---
  if (isPartialBech32(keyCompact)) {
    const lower = keyLower;
    const pref = bech32Prefix.value?.toLowerCase() || '';

    // Prefer chain-local HRP when known
    const looksLocal =
      !pref ||
      lower.startsWith(pref + '1') ||
      lower.startsWith(pref + 'valoper1') ||
      lower.startsWith(pref + 'valcons1');

    if (lower.includes('valoper')) {
      // Match loaded validators by operator prefix
      const vals = (staking.validators || []).filter((v) =>
        (v.operator_address || '').toLowerCase().startsWith(lower)
      );
      vals.slice(0, 8).forEach((v, i) => {
        push(
          validatorHit(
            v,
            850 - i,
            `Operator prefix · ${shortAddr(v.operator_address)} · ${chainPretty.value}`
          )
        );
      });
      // Still offer direct navigate with typed prefix (user may complete later)
      if (!vals.length && looksLocal) {
        push({
          kind: 'validator',
          query: lower,
          path: `/${current}/validator/${lower}`,
          title: shortAddr(lower),
          subtitle: 'Validator prefix · open when complete · ' + chainPretty.value,
          score: 400,
        });
      }
    } else {
      // Account prefix — match validators whose account form starts with query
      const vals = (staking.validators || []).filter((v) => {
        const acc = valoperToAccount(v.operator_address || '');
        return acc && acc.toLowerCase().startsWith(lower);
      });
      if (looksLocal) {
        push({
          kind: 'account',
          query: lower,
          path: `/${current}/account/${lower}`,
          title: shortAddr(lower),
          subtitle: 'Account prefix · ' + chainPretty.value,
          score: 820,
        });
      }
      vals.slice(0, 6).forEach((v, i) => {
        push(
          validatorHit(
            v,
            800 - i,
            `Account prefix match · ${shortAddr(valoperToAccount(v.operator_address))} · ${chainPretty.value}`
          )
        );
      });
    }
  }

  // --- Moniker / identity / website (text search) ---
  const qText = normalizeQuery(display).toLowerCase();
  // skip pure hex-prefix-only already handled unless also moniker-like
  const skipMoniker = !!fullHash || /^\d+$/.test(keyCompact);
  if (!skipMoniker && qText.length >= MONIKER_MIN && staking.validators?.length) {
    const ranked: SearchHit[] = [];
    staking.validators.forEach((v, rankIdx) => {
      const moniker = v.description?.moniker || '';
      const identity = v.description?.identity || '';
      const website = v.description?.website || '';
      let s = monikerScore(moniker, qText);
      s = Math.max(s, identityScore(identity, keyLower));
      s = Math.max(s, websiteScore(website, qText));
      if (s <= 0) return;
      // slight boost for higher-ranked (lower index) validators
      s += Math.max(0, 40 - Math.min(rankIdx, 40));
      ranked.push(
        validatorHit(
          v,
          s,
          [
            rankIdx < 200 ? `#${rankIdx + 1}` : null,
            identity && identityScore(identity, keyLower) > 0 ? 'identity' : null,
            monikerScore(moniker, qText) > 0 ? 'moniker' : null,
            chainPretty.value,
          ]
            .filter(Boolean)
            .join(' · ')
        )
      );
    });
    ranked
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 10)
      .forEach((h) => push(h));
  }

  return results.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12);
}

const hits = computed<SearchHit[]>(() => buildHits(query.value));

const kindBadge: Record<SearchKind, { label: string; cls: string }> = {
  account: { label: 'Account', cls: 'sz-badge-account' },
  validator: { label: 'Validator', cls: 'sz-badge-validator' },
  tx: { label: 'Tx', cls: 'sz-badge-tx' },
  block: { label: 'Block', cls: 'sz-badge-block' },
  proposal: { label: 'Gov', cls: 'sz-badge-gov' },
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
  
  // Ensure validators are loaded for search (moniker/prefix matching)
  if (chainName.value && (!staking.validators || staking.validators.length === 0)) {
    staking.fetchValidators('BOND_STATUS_BONDED', 500).catch(() => {
      // Silent fail — search still works for exact address/tx/hash
    });
  }
}

function closeModal() {
  open.value = false;
  errorMessage.value = '';
}

function go(hit: SearchHit) {
  if (!hit?.path) return;
  // Don't save soft "prefix tip" tx rows that aren't real full hashes
  const saveable =
    hit.kind !== 'tx' ||
    (hit.query && hit.query.length === 64) ||
    hit.subtitle?.includes('From recent');
  if (saveable) {
    saveRecent({ ...hit, ts: Date.now() });
  }
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
    errorMessage.value =
      'No results. Try address, tx hash, block height, #proposal, or validator name.';
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
    <!-- Desktop trigger — magnify is chrome chrome, not a result-row category icon -->
    <button
      type="button"
      class="sz-search-trigger hidden md:!inline-flex"
      @click="openModal"
      aria-label="Search by address, tx hash, or height"
    >
      <Icon icon="mdi:magnify" class="text-lg text-secondary shrink-0" />
      <span class="sz-search-placeholder">Search address, hash, height, moniker…</span>
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
              placeholder="Address, hash, height, #proposal, or moniker…"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="confirm"
            />
            <kbd class="sz-search-esc" @click="closeModal">ESC</kbd>
          </div>

          <p class="sz-search-hint">
            Address / prefix · tx hash · height · #proposal · validator moniker or identity.
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

          <!-- results: text + badge only; avatar only if moniker Keybase cached -->
          <div v-if="activeTab === 'result'" class="sz-search-list">
            <div v-if="!chainName" class="sz-search-empty">
              Select a chain first to search.
            </div>
            <div v-else-if="!normalizeQuery(query)" class="sz-search-empty">
              Start typing an address, tx hash, block height, #proposal, or validator moniker.
            </div>
            <div v-else-if="!hits.length" class="sz-search-empty">
              No results found.
              <div class="mt-1 text-[12px] opacity-70">
                Try a longer address prefix, full hash, height, or moniker.
              </div>
            </div>
            <button
              v-for="(hit, i) in hits"
              :key="hit.kind + hit.path + (hit.query || '')"
              type="button"
              class="sz-search-row"
              :class="{ 'is-active': highlight === i }"
              @mouseenter="highlight = i"
              @click="go(hit)"
            >
              <img
                v-if="hit.logo"
                :src="hit.logo"
                alt=""
                class="sz-search-row-avatar"
                loading="lazy"
                @error="($event.target as HTMLImageElement).style.display = 'none'"
              />
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
              <img
                v-if="hit.logo"
                :src="hit.logo"
                alt=""
                class="sz-search-row-avatar"
                loading="lazy"
                @error="($event.target as HTMLImageElement).style.display = 'none'"
              />
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

/* ---- overlay / panel ---- */
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
/* Moniker Keybase avatar only — no generic icon box */
.sz-search-row-avatar {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 999px;
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b2)) 60%, transparent);
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
.sz-badge-gov {
  color: #f472b6;
  border-color: color-mix(in srgb, #f472b6 35%, transparent);
  background: color-mix(in srgb, #f472b6 12%, transparent);
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
