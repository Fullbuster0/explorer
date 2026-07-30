<script lang="ts" setup>
import { useBlockchain, useFormatter } from '@/stores';
import DynamicComponent from '@/components/dynamic/DynamicComponent.vue';
import { computed, ref, watch } from 'vue';
import type { Tx, TxResponse } from '@/types';
import { Icon } from '@iconify/vue';
import { getGnoIndexer } from '@/libs/gno/indexer';

const props = defineProps(['hash', 'chain']);

const blockchain = useBlockchain();
const format = useFormatter();

type Tab = 'overview' | 'messages' | 'events' | 'json';
const tab = ref<Tab>('overview');
const openRaw = ref(false);
const openFull = ref(false);

const tx = ref(
  {} as {
    tx: Tx;
    tx_response: TxResponse;
  }
);
const loading = ref(false);
const error = ref('');
/** Gno extras from onbloc detail (storage deposit, signer, network). */
const gnoMeta = ref<Record<string, any> | null>(null);

/** Vue route params are usually decoded once; harden against leftover %2F/%3D
 *  (and rare double-encoding) so Gno base64 hashes still hit TM2 /tx. */
function normalizeRouteHash(raw?: string): string {
  let h = (raw || '').trim();
  if (!h) return '';
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(h)) break;
    try {
      const d = decodeURIComponent(h);
      if (!d || d === h) break;
      h = d;
    } catch {
      break;
    }
  }
  return h.trim();
}

function isGnoEngine(): boolean {
  const e = blockchain.current?.engine;
  return e === 'gno' || e === 'tm2';
}

function indexerBase(): string {
  return String((blockchain.current as any)?.indexer?.api || 'https://topaz.api.onbloc.xyz/v1');
}

/** Merge onbloc detail + events onto RPC-adapted tx (time/fee/events enrichment). */
async function enrichGnoTx(res: any, routeHash: string) {
  if (!res?.tx_response) return res;
  const b64 =
    res.tx_response._gno_hash_b64 ||
    (String(res.tx_response.txhash || '').includes('/') || String(res.tx_response.txhash || '').includes('=')
      ? res.tx_response.txhash
      : '') ||
    routeHash;
  try {
    const idx = getGnoIndexer(indexerBase());
    const [detail, idxEvents] = await Promise.all([
      idx.getTransactionDetail(b64).catch(() => null),
      idx.getTransactionEvents(b64).catch(() => []),
    ]);
    if (detail) {
      gnoMeta.value = detail;
      if (detail.timestamp && !res.tx_response.timestamp) {
        res.tx_response.timestamp = detail.timestamp;
      } else if (detail.timestamp) {
        // Prefer indexer wall-clock if RPC block time already set — keep earlier non-empty
        res.tx_response.timestamp = res.tx_response.timestamp || detail.timestamp;
      }
      const fee = detail.transactionFee;
      if (fee?.value != null && !(res.tx?.auth_info?.fee?.amount?.length)) {
        if (!res.tx) res.tx = { body: { messages: [] }, auth_info: { fee: { amount: [] } } };
        if (!res.tx.auth_info) res.tx.auth_info = { fee: { amount: [] } };
        if (!res.tx.auth_info.fee) res.tx.auth_info.fee = { amount: [] };
        res.tx.auth_info.fee.amount = [{ amount: String(fee.value), denom: fee.denom || 'ugnot' }];
        res.tx.auth_info.fee.gas_limit = String(detail.gas?.wanted ?? res.tx_response.gas_wanted || '0');
      }
      if (detail.gas?.used != null) res.tx_response.gas_used = String(detail.gas.used);
      if (detail.gas?.wanted != null) res.tx_response.gas_wanted = String(detail.gas.wanted);
      if (detail.memo && res.tx?.body) res.tx.body.memo = detail.memo;
      if (detail.success === false) res.tx_response.code = 1;
      if (detail.errorLog) res.tx_response.raw_log = detail.errorLog;
    }
    // Prefer indexer events when present (caller + realmPath + emit params)
    if (Array.isArray(idxEvents) && idxEvents.length) {
      res.tx_response.events = idxEvents.map((ev: any) => {
        const attrs: { key: string; value: string }[] = [];
        if (ev.caller) attrs.push({ key: 'caller', value: String(ev.caller) });
        if (ev.originCaller && ev.originCaller !== ev.caller) {
          attrs.push({ key: 'origin_caller', value: String(ev.originCaller) });
        }
        if (ev.realmPath) attrs.push({ key: 'pkg_path', value: String(ev.realmPath) });
        if (ev.function) attrs.push({ key: 'function', value: String(ev.function) });
        const params = ev.emit?.params || ev.params || [];
        if (Array.isArray(params)) {
          for (const p of params) {
            attrs.push({ key: String(p.key || p.name || ''), value: String(p.value ?? '') });
          }
        }
        // fallback: flatten remaining scalar fields
        if (!attrs.length) {
          for (const [k, v] of Object.entries(ev)) {
            if (['identifier', 'txHash', 'emit', 'timestamp', 'blockHeight'].includes(k)) continue;
            if (v == null || typeof v === 'object') continue;
            attrs.push({ key: k, value: String(v) });
          }
        }
        return {
          type: String(ev.eventName || ev.emit?.name || ev['@type'] || 'event'),
          attributes: attrs,
        };
      });
      if (!res.tx_response.timestamp && idxEvents[0]?.timestamp) {
        res.tx_response.timestamp = idxEvents[0].timestamp;
      }
    }
  } catch {
    /* indexer optional */
  }
  return res;
}

async function loadTx(hash?: string) {
  const h = normalizeRouteHash(hash);
  if (!h) return;
  loading.value = true;
  error.value = '';
  tx.value = {} as any;
  gnoMeta.value = null;
  try {
    if (!blockchain.endpoint?.address) {
      for (let i = 0; i < 20 && !blockchain.endpoint?.address; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    const isGno = isGnoEngine();
    if (isGno && !blockchain.rpc) {
      for (let i = 0; i < 20 && !blockchain.rpc; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    let res: any = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await blockchain.fetchTx(h);
        if (res && res.tx_response) break;
        res = null;
      } catch (e: any) {
        lastErr = e;
        res = null;
      }
      if (res && res.tx_response) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    if (res && res.tx_response) {
      if (isGno) res = await enrichGnoTx(res, h);
      tx.value = res as any;
      error.value = '';
    } else {
      tx.value = {} as any;
      error.value =
        lastErr?.message ||
        (isGno
          ? 'Transaction not found on Gno RPC (tried base64 / 0x-hex forms).'
          : 'Transaction not found on active or archive REST endpoints.');
    }
  } catch (e: any) {
    tx.value = {} as any;
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.hash, blockchain.endpoint?.address, !!(blockchain as any).rpc] as const,
  ([h]) => {
    if (h) loadTx(h);
  },
  { immediate: true }
);

const messages = computed(() => {
  return (
    tx.value.tx?.body?.messages.map((x: any) => {
      if (x.packet?.data) x.message = format.base64ToString(x.packet.data);
      return x;
    }) || []
  );
});

const events = computed(() => (tx.value.tx_response?.events || []) as any[]);

const msgSummary = (m: any) => {
  if (m?.func) return String(m.func);
  const t = String(m['@type'] || m.message_type || '').split('.').pop() || '';
  return t.replace(/^Msg/, '').replace(/^m_/, '');
};

const storageDepositText = computed(() => {
  const sd = gnoMeta.value?.storageDeposit;
  if (!sd?.value) return '';
  return format.formatTokens([{ amount: String(sd.value), denom: sd.denom || 'ugnot' }], true, '0,0.[00]');
});

const gnoSigner = computed(() => {
  const sigs = gnoMeta.value?.signatures;
  if (Array.isArray(sigs) && sigs[0]?.pubKey) return String(sigs[0].pubKey);
  const m = messages.value[0];
  return m?.caller || m?.from_address || '';
});

const gasUsedRatio = computed(() => {
  const u = Number(tx.value.tx_response?.gas_used || 0);
  const w = Number(tx.value.tx_response?.gas_wanted || 0);
  if (!w) return 0;
  return Math.min(100, Math.round((u / w) * 100));
});

const isSuccess = computed(() => (tx.value.tx_response?.code ?? -1) === 0);

const feeText = computed(() =>
  format.formatTokens(tx.value.tx?.auth_info?.fee?.amount, true, '0,0.[00]')
);

const txTime = computed(() => tx.value.tx_response?.timestamp || '');

const eventGroups = computed(() => {
  const out: { type: string; entries: { key: string; value: string }[] }[] = [];
  for (const e of events.value) {
    const t = String(e.type || 'event');
    const arr = (e.attributes || []).map((a: any) => ({
      key: String(a.key || ''),
      value: String(a.value || ''),
    }));
    out.push({ type: t, entries: arr });
  }
  return out;
});

const copyText = ref(0);
const copyMsg = computed(() =>
  copyText.value === 2
    ? { class: 'error', msg: 'Copy Error!' }
    : { class: 'success', msg: 'Copied!' }
);

async function doCopy(text?: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyText.value = 1;
    setTimeout(() => (copyText.value = 0), 1100);
  } catch {
    copyText.value = 2;
    setTimeout(() => (copyText.value = 0), 1100);
  }
}

/** Pretty-print helper — Indonode style raw <pre> JSON */
function pretty(obj: unknown): string {
  try {
    return JSON.stringify(obj ?? {}, null, 2);
  } catch {
    return String(obj ?? '');
  }
}

const rawTxJson = computed(() => pretty(tx.value.tx));
const fullTxJson = computed(() => pretty(tx.value.tx_response));
const rawType = computed(() => String((tx.value.tx as any)?.['@type'] || '/cosmos.tx.v1beta1.Tx'));
</script>
<template>
  <div class="sz-tx-detail">
    <!-- header / tabs -->
    <div class="sz-tabs mb-4">
      <RouterLink
        class="sz-tab"
        :to="
          blockchain.current?.engine === 'gno' || blockchain.current?.engine === 'tm2'
            ? `/${chain}/gno-tx`
            : `/${chain}/tx/?tab=recent`
        "
      >{{ $t('block.recent') }}</RouterLink>
      <RouterLink
        v-if="!(blockchain.current?.engine === 'gno' || blockchain.current?.engine === 'tm2')"
        class="sz-tab"
        :to="`/${chain}/tx/?tab=search`"
      >Search</RouterLink>
      <span class="sz-tab sz-tab--active cursor-default">Transaction</span>
    </div>

    <!-- loading -->
    <div v-if="loading" class="sz-section mb-4 px-4 py-6 text-sm opacity-70">
      <span class="sz-live-dot mr-2"></span>
      Loading transaction… <span class="text-secondary">{{
        blockchain.current?.engine === 'gno' || blockchain.current?.engine === 'tm2'
          ? 'Gno RPC + indexer'
          : 'active REST → archive fallback'
      }}</span>
    </div>

    <!-- not found -->
    <div v-else-if="error && !tx.tx_response" class="sz-section mb-4 px-4 py-5">
      <div class="flex items-center gap-2 mb-1.5">
        <Icon icon="mdi-alert-circle-outline" class="text-no text-xl" />
        <span class="font-bold text-no">Not found</span>
      </div>
      <div class="text-[13px] opacity-80">{{ error }}</div>
      <div class="mt-2 text-[11.5px] text-secondary">
        Hash: <span class="font-mono break-all">{{ hash }}</span>
      </div>
    </div>

    <template v-if="tx.tx_response">
      <!-- HERO -->
      <section class="sz-section sz-tx-hero mb-4 overflow-hidden">
        <div class="sz-tx-hero-inner">
          <div class="flex flex-col sm:!flex-row sm:!items-center gap-3">
            <div class="min-w-0 flex-1">
              <div class="sz-section-kicker mb-1">Transaction</div>
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="sz-page-title !mb-0 !text-[1.35rem] sm:!text-[1.5rem] font-mono break-all leading-snug">
                  {{ tx.tx_response.txhash }}
                </h1>
                <Icon
                  icon="mdi:content-copy"
                  class="cursor-pointer text-lg opacity-60 hover:opacity-100 shrink-0"
                  @click="doCopy(tx.tx_response.txhash)"
                />
              </div>

              <div class="flex flex-wrap items-center gap-2 mt-2.5">
                <span class="sz-chip" :class="isSuccess ? 'sz-chip--ok' : 'sz-chip--bad'">
                  <Icon :icon="isSuccess ? 'mdi-check-circle-outline' : 'mdi-close-circle-outline'" class="mr-1" />
                  {{ isSuccess ? 'Success' : `Failed · code ${tx.tx_response.code}` }}
                </span>
                <span class="sz-chip sz-chip--info font-mono">
                  {{ messages.length }} msg{{ messages.length === 1 ? '' : 's' }}
                </span>
                <span
                  v-for="(m, i) in messages.slice(0, 4)"
                  :key="i"
                  class="sz-chip font-mono !text-[10px]"
                  :title="m['@type']"
                >{{ msgSummary(m) }}</span>
                <span v-if="messages.length > 4" class="sz-chip !text-[10px] text-secondary">
                  +{{ messages.length - 4 }}
                </span>
              </div>

              <div
                v-if="!isSuccess && tx.tx_response.raw_log"
                class="mt-3 text-[12px] leading-relaxed text-no/90 bg-error/10 border border-error/25 rounded-lg px-3 py-2 font-mono break-all"
              >{{ tx.tx_response.raw_log }}</div>
            </div>

            <!-- gas gauge -->
            <div class="sz-tx-gauge shrink-0">
              <div class="sz-stat-label mb-1">{{ $t('tx.gas') }}</div>
              <div class="font-mono text-[1.35rem] font-bold leading-none">
                {{ Number(tx.tx_response.gas_used || 0).toLocaleString() }}
                <span class="text-secondary font-medium text-[0.95rem]">/ {{ Number(tx.tx_response.gas_wanted || 0).toLocaleString() }}</span>
              </div>
              <div class="sz-tx-gasbar mt-2">
                <div class="sz-tx-gasbar-fill" :style="{ width: gasUsedRatio + '%' }"></div>
              </div>
              <div class="text-[11px] text-secondary mt-1 font-mono">{{ gasUsedRatio }}% used</div>
            </div>
          </div>
        </div>
      </section>

      <!-- metric strip -->
      <div class="grid grid-cols-2 md:!grid-cols-3 xl:!grid-cols-5 gap-3 mb-4">
        <div class="sz-stat" style="--stat-hue: var(--sz-accent)">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('account.height') }}</span></div>
          <RouterLink
            class="sz-stat-value text-primary link link-hover no-underline"
            :to="`/${props.chain}/block/${tx.tx_response.height}`"
          >{{ tx.tx_response.height }}</RouterLink>
          <div class="sz-stat-sub">block</div>
        </div>

        <div class="sz-stat" style="--stat-hue: #764bc8">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('account.time') }}</span></div>
          <div class="sz-stat-value">{{ txTime ? format.toDay(txTime, 'from') : '—' }}</div>
          <div class="sz-stat-sub">{{ txTime ? format.toLocaleDate(txTime) : 'no timestamp' }}</div>
        </div>

        <div class="sz-stat" style="--stat-hue: var(--sz-warn)">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('tx.fee') }}</span></div>
          <div class="sz-stat-value">{{ feeText || '—' }}</div>
          <div class="sz-stat-sub">paid by signer</div>
        </div>

        <div class="sz-stat" style="--stat-hue: #f97316">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('tx.gas') }}</span></div>
          <div class="sz-stat-value">{{ gasUsedRatio }}%</div>
          <div class="sz-stat-sub">{{ Number(tx.tx_response.gas_used || 0).toLocaleString() }} used</div>
        </div>

        <div class="sz-stat" style="--stat-hue: #0ea5e9">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('account.messages') }}</span></div>
          <div class="sz-stat-value">{{ messages.length }}</div>
          <div class="sz-stat-sub">{{ events.length }} events</div>
        </div>
      </div>

      <!-- tabs -->
      <div class="sz-tabs mb-4">
        <button class="sz-tab" :class="{ 'sz-tab--active': tab === 'overview' }" @click="tab = 'overview'">Overview</button>
        <button class="sz-tab" :class="{ 'sz-tab--active': tab === 'messages' }" @click="tab = 'messages'">
          {{ $t('account.messages') }}
          <span class="font-mono text-[10px] ml-1 opacity-70">{{ messages.length }}</span>
        </button>
        <button class="sz-tab" :class="{ 'sz-tab--active': tab === 'events' }" @click="tab = 'events'">
          Events
          <span class="font-mono text-[10px] ml-1 opacity-70">{{ events.length }}</span>
        </button>
        <button class="sz-tab" :class="{ 'sz-tab--active': tab === 'json' }" @click="tab = 'json'">JSON</button>
      </div>

      <!-- OVERVIEW -->
      <section v-if="tab === 'overview'" class="sz-section mb-4 overflow-hidden">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Details</div>
            <div class="sz-section-title">{{ $t('tx.title') }}</div>
          </div>
        </div>
        <div class="px-4 py-3">
          <table class="sz-table">
            <tbody>
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('tx.tx_hash') }}</td>
                <td class="font-mono text-[12px] break-all">
                  {{ tx.tx_response.txhash }}
                  <Icon
                    icon="mdi:content-copy"
                    class="cursor-pointer ml-1.5 opacity-60 hover:opacity-100 align-middle"
                    @click="doCopy(tx.tx_response.txhash)"
                  />
                </td>
              </tr>
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('account.height') }}</td>
                <td>
                  <RouterLink class="text-primary link link-hover font-mono" :to="`/${props.chain}/block/${tx.tx_response.height}`">
                    {{ tx.tx_response.height }}
                  </RouterLink>
                </td>
              </tr>
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('staking.status') }}</td>
                <td>
                  <span class="sz-chip" :class="isSuccess ? 'sz-chip--ok' : 'sz-chip--bad'">
                    {{ isSuccess ? 'Success' : 'Failed' }}
                  </span>
                  <span v-if="!isSuccess" class="ml-2 text-[12px] text-no font-mono">{{ tx.tx_response.raw_log }}</span>
                </td>
              </tr>
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('account.time') }}</td>
                <td class="font-mono text-[12.5px]">
                  <template v-if="txTime">
                    {{ format.toLocaleDate(txTime) }}
                    <span class="text-secondary">({{ format.toDay(txTime, 'from') }})</span>
                  </template>
                  <span v-else class="text-secondary">—</span>
                </td>
              </tr>
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('tx.gas') }}</td>
                <td class="font-mono text-[12.5px]">{{ tx.tx_response.gas_used }} / {{ tx.tx_response.gas_wanted }}</td>
              </tr>
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('tx.fee') }}</td>
                <td class="font-mono text-[12.5px]">{{ feeText || '—' }}</td>
              </tr>
              <tr v-if="storageDepositText">
                <td class="text-secondary whitespace-nowrap">Storage deposit</td>
                <td class="font-mono text-[12.5px]">{{ storageDepositText }}</td>
              </tr>
              <tr v-if="gnoSigner">
                <td class="text-secondary whitespace-nowrap">Signer</td>
                <td class="font-mono text-[12px] break-all">
                  <RouterLink
                    class="text-primary link link-hover"
                    :to="`/${props.chain}/account/${gnoSigner}`"
                  >{{ gnoSigner }}</RouterLink>
                </td>
              </tr>
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('tx.memo') }}</td>
                <td class="text-[12.5px]">{{ tx.tx.body?.memo || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- MESSAGES -->
      <section v-else-if="tab === 'messages'" class="sz-section mb-4 overflow-hidden">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Payload</div>
            <div class="sz-section-title">{{ $t('account.messages') }} ({{ messages.length }})</div>
          </div>
        </div>
        <div class="px-4 py-3 space-y-3">
          <div v-if="messages.length === 0" class="text-secondary text-sm py-4">{{ $t('tx.no_messages') }}</div>
          <div v-for="(msg, i) in messages" :key="i" class="sz-tx-msg">
            <div class="sz-tx-msg-head">
              <span class="sz-chip sz-chip--info font-mono !text-[10px]">#{{ i + 1 }}</span>
              <span class="font-mono text-[12px] font-semibold text-main">{{ msgSummary(msg) }}</span>
              <span class="font-mono text-[10.5px] text-secondary truncate" :title="msg['@type']">{{ msg['@type'] }}</span>
            </div>
            <div class="sz-tx-msg-body">
              <DynamicComponent :value="msg" />
            </div>
          </div>
        </div>
      </section>

      <!-- EVENTS -->
      <section v-else-if="tab === 'events'" class="sz-section mb-4 overflow-hidden">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Emission</div>
            <div class="sz-section-title">Events ({{ events.length }})</div>
          </div>
        </div>
        <div class="px-4 py-3 space-y-3">
          <div v-if="!eventGroups.length" class="text-secondary text-sm py-4">No events.</div>
          <div v-for="(g, gi) in eventGroups" :key="gi" class="sz-tx-msg">
            <div class="sz-tx-msg-head">
              <span class="sz-chip sz-chip--info font-mono !text-[10px]">#{{ gi + 1 }}</span>
              <span class="font-mono text-[12px] font-semibold text-main">{{ g.type }}</span>
              <span class="font-mono text-[10.5px] text-secondary">{{ g.entries.length }} attrs</span>
            </div>
            <div class="sz-tx-msg-body overflow-x-auto">
              <table class="sz-table !text-[12px]">
                <tbody>
                  <tr v-for="(a, ai) in g.entries" :key="ai">
                    <td class="text-secondary whitespace-nowrap font-mono !text-[11.5px]">{{ a.key }}</td>
                    <td class="font-mono !text-[11.5px] break-all">{{ a.value || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <!-- JSON (Indonode-style: Raw + Full collapsible) -->
      <section v-else class="space-y-3 mb-4">
        <!-- Raw Transaction Data -->
        <div class="sz-json-card" :class="{ 'is-open': openRaw }">
          <button class="sz-json-head" @click="openRaw = !openRaw">
            <span class="sz-json-head-left">
              <Icon icon="mdi-code-json" class="sz-json-head-icon" />
              <span class="sz-json-head-title">Raw Transaction Data (JSON)</span>
              <span class="sz-chip sz-chip--info font-mono !text-[9.5px] !px-1.5">{{ (rawTxJson.length / 1024).toFixed(1) }} KB</span>
            </span>
            <Icon icon="mdi-chevron-down" class="sz-json-chevron" :class="{ 'rotate-180': openRaw }" />
          </button>
          <div class="sz-json-body" v-show="openRaw">
            <div class="sz-json-body-head">
              <span class="text-[10.5px] text-secondary font-mono">tx · @type {{ rawType }}</span>
              <button class="sz-chip sz-chip--info cursor-pointer !text-[10px]" @click.stop="doCopy(rawTxJson)">
                <Icon icon="mdi:content-copy" class="mr-1" /> copy
              </button>
            </div>
            <pre class="sz-json-pre">{{ rawTxJson }}</pre>
          </div>
        </div>

        <!-- Full Transaction Response -->
        <div class="sz-json-card" :class="{ 'is-open': openFull }">
          <button class="sz-json-head" @click="openFull = !openFull">
            <span class="sz-json-head-left">
              <Icon icon="mdi-file-document-outline" class="sz-json-head-icon" />
              <span class="sz-json-head-title">Full Transaction Response (JSON)</span>
              <span class="sz-chip sz-chip--info font-mono !text-[9.5px] !px-1.5">{{ (fullTxJson.length / 1024).toFixed(1) }} KB</span>
            </span>
            <Icon icon="mdi-chevron-down" class="sz-json-chevron" :class="{ 'rotate-180': openFull }" />
          </button>
          <div class="sz-json-body" v-show="openFull">
            <div class="sz-json-body-head">
              <span class="text-[10.5px] text-secondary font-mono">tx_response · code {{ tx.tx_response.code }} · {{ events.length }} events</span>
              <button class="sz-chip sz-chip--info cursor-pointer !text-[10px]" @click.stop="doCopy(fullTxJson)">
                <Icon icon="mdi:content-copy" class="mr-1" /> copy
              </button>
            </div>
            <pre class="sz-json-pre">{{ fullTxJson }}</pre>
          </div>
        </div>
      </section>
    </template>

    <!-- copy toast -->
    <div class="toast" v-show="copyText">
      <div class="alert" :class="`alert-${copyMsg.class}`">
        <div class="text-xs md:!text-sm"><span>{{ copyMsg.msg }}</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sz-tx-hero-inner {
  padding: 1.05rem 1.25rem 1.25rem;
}
.sz-tx-gauge {
  min-width: 11.5rem;
  border-left: 1px solid var(--sz-border);
  padding-left: 1.25rem;
}
@media (max-width: 640px) {
  .sz-tx-gauge {
    border-left: none;
    border-top: 1px solid var(--sz-border);
    padding-left: 0;
    padding-top: 0.65rem;
    width: 100%;
  }
}
.sz-tx-gasbar {
  height: 6px;
  border-radius: 999px;
  background: var(--sz-border);
  overflow: hidden;
  position: relative;
}
.sz-tx-gasbar-fill {
  height: 100%;
  background: linear-gradient(90deg, hsl(var(--p)), color-mix(in srgb, hsl(var(--p)) 65%, transparent));
  border-radius: inherit;
  transition: width 0.4s ease;
}
.sz-tx-msg {
  border: 1px solid var(--sz-border);
  border-radius: 14px;
  background: var(--sz-accent-soft);
  overflow: hidden;
}
.sz-tx-msg-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.55rem;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--sz-border);
  background: color-mix(in srgb, var(--sz-accent-soft) 60%, transparent);
}
.sz-tx-msg-body {
  padding: 0.85rem 0.95rem;
  font-size: 12.5px;
  line-height: 1.55;
}

/* Indonode-style Raw / Full JSON accordion */
.sz-json-card {
  border: 1px solid var(--sz-border);
  border-radius: 14px;
  background: var(--sz-surface, hsl(var(--b1)));
  overflow: hidden;
}
.sz-json-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.9rem 1.05rem;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  color: inherit;
  transition: background 0.15s ease;
}
.sz-json-head:hover {
  background: color-mix(in srgb, var(--sz-accent-soft) 70%, transparent);
}
.sz-json-head-left {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  flex-wrap: wrap;
}
.sz-json-head-icon {
  font-size: 1.15rem;
  opacity: 0.75;
  flex-shrink: 0;
}
.sz-json-head-title {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.sz-json-chevron {
  font-size: 1.25rem;
  opacity: 0.55;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}
.sz-json-body {
  border-top: 1px solid var(--sz-border);
  padding: 0.75rem 1rem 1rem;
  background: color-mix(in srgb, var(--sz-accent-soft) 55%, transparent);
}
.sz-json-body-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.55rem;
}
.sz-json-pre {
  margin: 0;
  padding: 0.95rem 1.05rem;
  border-radius: 10px;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b1)) 88%, #000 12%);
  color: inherit;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  max-height: 24rem; /* ~ max-h-96 like Indonode */
  overflow-y: auto;
}
</style>
