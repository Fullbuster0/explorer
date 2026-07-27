<script lang="ts" setup>
import { useBaseStore, useBlockchain, useFormatter } from '@/stores';
import DynamicComponent from '@/components/dynamic/DynamicComponent.vue';
import { computed, ref, watch } from 'vue';
import type { Tx, TxResponse } from '@/types';
import { Icon } from '@iconify/vue';

import { JsonViewer } from 'vue3-json-viewer';
import 'vue3-json-viewer/dist/index.css';

const props = defineProps(['hash', 'chain']);

const blockchain = useBlockchain();
const baseStore = useBaseStore();
const format = useFormatter();

type Tab = 'overview' | 'messages' | 'events' | 'json';
const tab = ref<Tab>('overview');

const tx = ref(
  {} as {
    tx: Tx;
    tx_response: TxResponse;
  }
);
const loading = ref(false);
const error = ref('');

async function loadTx(hash?: string) {
  const h = (hash || '').trim();
  if (!h) return;
  loading.value = true;
  error.value = '';
  try {
    if (!blockchain.endpoint?.address) {
      for (let i = 0; i < 20 && !blockchain.endpoint?.address; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    const res = await blockchain.fetchTx(h);
    if (res && res.tx_response) {
      tx.value = res as any;
    } else {
      tx.value = {} as any;
      error.value = 'Transaction not found on active or archive REST endpoints.';
    }
  } catch (e: any) {
    tx.value = {} as any;
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.hash, blockchain.endpoint?.address] as const,
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
  const t = String(m['@type'] || '').split('.').pop() || '';
  return t.replace(/^Msg/, '');
};

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

const shortHash = (h?: string) => {
  if (!h) return '—';
  if (h.length <= 16) return h;
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
};

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
</script>
<template>
  <div class="sz-tx-detail">
    <!-- header / tabs -->
    <div class="sz-tabs mb-4">
      <RouterLink class="sz-tab" :to="`/${chain}/tx/?tab=recent`">{{ $t('block.recent') }}</RouterLink>
      <RouterLink class="sz-tab" :to="`/${chain}/tx/?tab=search`">Search</RouterLink>
      <span class="sz-tab sz-tab--active cursor-default">Transaction</span>
    </div>

    <!-- loading -->
    <div v-if="loading" class="sz-section mb-4 px-4 py-6 text-sm opacity-70">
      <span class="sz-live-dot mr-2"></span>
      Loading transaction… <span class="text-secondary">(active REST → archive fallback)</span>
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
              <div class="sz-metric-label mb-1">{{ $t('tx.gas') }}</div>
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
        <div class="sz-metric">
          <div class="flex items-start justify-between gap-2">
            <div class="sz-metric-label">{{ $t('account.height') }}</div>
            <div class="sz-metric-icon"><Icon icon="mdi-cube-outline" /></div>
          </div>
          <RouterLink
            class="sz-metric-value !text-[1.15rem] text-primary link link-hover no-underline"
            :to="`/${props.chain}/block/${tx.tx_response.height}`"
          >{{ tx.tx_response.height }}</RouterLink>
          <div class="sz-metric-sub">block</div>
        </div>

        <div class="sz-metric">
          <div class="flex items-start justify-between gap-2">
            <div class="sz-metric-label">{{ $t('account.time') }}</div>
            <div class="sz-metric-icon"><Icon icon="mdi-clock-outline" /></div>
          </div>
          <div class="sz-metric-value !text-[1.05rem] !leading-snug">{{ format.toDay(txTime, 'from') }}</div>
          <div class="sz-metric-sub font-mono">{{ format.toLocaleDate(txTime) }}</div>
        </div>

        <div class="sz-metric">
          <div class="flex items-start justify-between gap-2">
            <div class="sz-metric-label">{{ $t('tx.fee') }}</div>
            <div class="sz-metric-icon"><Icon icon="mdi-cash-multiple" /></div>
          </div>
          <div class="sz-metric-value !text-[1.05rem] !leading-snug">{{ feeText || '—' }}</div>
          <div class="sz-metric-sub">paid by signer</div>
        </div>

        <div class="sz-metric">
          <div class="flex items-start justify-between gap-2">
            <div class="sz-metric-label">{{ $t('tx.gas') }}</div>
            <div class="sz-metric-icon"><Icon icon="mdi-fire" /></div>
          </div>
          <div class="sz-metric-value !text-[1.15rem]">{{ gasUsedRatio }}%</div>
          <div class="sz-metric-sub font-mono">{{ Number(tx.tx_response.gas_used || 0).toLocaleString() }} used</div>
        </div>

        <div class="sz-metric">
          <div class="flex items-start justify-between gap-2">
            <div class="sz-metric-label">{{ $t('account.messages') }}</div>
            <div class="sz-metric-icon"><Icon icon="mdi-swap-horizontal" /></div>
          </div>
          <div class="sz-metric-value !text-[1.15rem]">{{ messages.length }}</div>
          <div class="sz-metric-sub">{{ events.length }} events</div>
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
                  {{ format.toLocaleDate(txTime) }}
                  <span class="text-secondary">({{ format.toDay(txTime, 'from') }})</span>
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
              <tr>
                <td class="text-secondary whitespace-nowrap">{{ $t('tx.memo') }}</td>
                <td class="text-[12.5px]">{{ tx.tx.body.memo || '—' }}</td>
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

      <!-- JSON -->
      <section v-else class="sz-section mb-4 overflow-hidden">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Raw</div>
            <div class="sz-section-title">JSON</div>
          </div>
        </div>
        <div class="px-4 py-3">
          <JsonViewer
            :value="tx"
            :theme="baseStore.theme"
            style="background: transparent"
            copyable
            boxed
            sort
            expand-depth="5"
          />
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
</style>
