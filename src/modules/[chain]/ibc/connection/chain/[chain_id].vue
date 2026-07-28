<script lang="ts" setup>
/**
 * IBC chain hub — all connections + channels to one remote chain.
 * Fixes the dangerous UX where list showed "3 open channels" but click
 * landed on connection-0 with only the non-trade channel-0.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import { useBlockchain } from '@/stores';
import { useIBCModule, type IbcChainRow } from '../../connStore';
import type { Channel, Connection } from '@/types';


// Match connection_id style: array props so vite-plugin-pages props:!0
// always injects route params. Also read useRoute() as hard fallback —
// never leave remoteId stuck as the literal ":chain_id".
const props = defineProps(['chain', 'chain_id']);
const route = useRoute();

const chainStore = useBlockchain();
const ibcStore = useIBCModule();
const { loading, loaded, error, rows } = storeToRefs(ibcStore);

const remoteId = computed(() => {
  const raw =
    props.chain_id ||
    (route.params as any).chain_id ||
    // last segment of path e.g. /atomone-mainnet/ibc/connection/chain/osmosis-1
    String(route.path || '')
      .split('/')
      .filter(Boolean)
      .pop() ||
    '';
  const s = decodeURIComponent(String(raw));
  // Guard against unresolved route template leaking into the UI.
  if (!s || s === ':chain_id' || s.startsWith(':')) return '';
  return s;
});

function tryLoad() {
  if (!chainStore.rpc || !chainStore.endpoint?.address) return;
  ibcStore.load();
}

onMounted(tryLoad);
watch(
  () => chainStore.endpoint?.address,
  () => {
    if (chainStore.rpc) ibcStore.load(true);
  }
);

const row = computed<IbcChainRow | undefined>(() =>
  (rows.value || []).find((r) => r.chainId === remoteId.value)
);

const primary = computed(() => (row.value ? ibcStore.primaryConnection(row.value) : undefined));

function isOpenConn(c: Connection) {
  const s = c.state || '';
  return s === 'STATE_OPEN' || s === 'OPEN';
}
function channelOpen(c: Channel) {
  const s = c.state || '';
  return s === 'STATE_OPEN' || s === 'OPEN';
}
function shortState(state?: string) {
  return (state || '').replace('STATE_', '').replace(/_/g, ' ');
}
function chip(state?: string) {
  const s = state || '';
  if (s === 'STATE_OPEN' || s === 'OPEN') return 'sz-chip--ok';
  if (s.includes('TRY') || s.includes('INIT')) return 'sz-chip--warn';
  return 'sz-chip--bad';
}
function isPreferredConn(c: Connection) {
  return !!row.value?.primaryConnectionId && c.id === row.value.primaryConnectionId;
}
function isPreferredCh(c: Channel) {
  return !!row.value?.preferredChannelId && c.channel_id === row.value.preferredChannelId;
}

const openConns = computed(() => (row.value?.connections || []).filter(isOpenConn));
const openChans = computed(() => (row.value?.channels || []).filter(channelOpen));
</script>

<template>
  <div>
    <RouterLink
      :to="`/${chainStore.chainName}/ibc/connection`"
      class="inline-flex items-center gap-1 text-[12.5px] text-secondary hover:text-primary no-underline mb-3"
    >
      <Icon icon="mdi:arrow-left" class="text-base" />
      {{ $t('ibc.title') }}
    </RouterLink>

    <div v-if="loading && !loaded" class="flex items-center justify-center gap-2 py-20 text-secondary text-sm">
      <span class="loading loading-spinner loading-sm"></span>
      {{ $t('ibc.loading') }}
    </div>

    <div v-else-if="error" class="sz-section px-4 py-3 text-sm text-error">
      {{ error }}
      <button class="btn btn-xs btn-primary ml-2" @click="ibcStore.load(true)">Retry</button>
    </div>

    <div v-else-if="!remoteId" class="sz-section py-14 text-center text-secondary text-sm">
      Missing remote chain id.
      <RouterLink
        :to="`/${chainStore.chainName}/ibc/connection`"
        class="link link-primary ml-1"
        >Back to IBC list</RouterLink
      >
    </div>

    <div v-else-if="!row" class="sz-section py-14 text-center text-secondary text-sm">
      No IBC data for <span class="font-mono">{{ remoteId }}</span>
      <div class="mt-2">
        <RouterLink
          :to="`/${chainStore.chainName}/ibc/connection`"
          class="link link-primary"
          >Back to IBC list</RouterLink
        >
      </div>
    </div>

    <template v-else>
      <!-- HERO -->
      <div class="sz-section overflow-hidden mb-4">
        <div class="grid grid-cols-1 items-center gap-4 p-5 md:!grid-cols-[1fr_auto_1fr]">
          <div class="min-w-0 text-center md:!text-left">
            <div class="sz-section-kicker">{{ $t('ibc.this_chain') }}</div>
            <div class="mt-1 truncate text-xl font-extrabold tracking-tight text-main">
              {{ chainStore.current?.prettyName || chainStore.chainName }}
            </div>
            <div class="mt-1 font-mono text-[11.5px] text-secondary">
              {{ chainStore.current?.chainId || '—' }}
            </div>
          </div>
          <div class="flex flex-col items-center gap-1.5">
            <span class="sz-chip" :class="openChans.length ? 'sz-chip--ok' : 'sz-chip--warn'">
              <Icon icon="mdi:transit-connection-variant" />
              {{ openChans.length }} open channel{{ openChans.length === 1 ? '' : 's' }}
            </span>
            <Icon icon="mdi:swap-horizontal" class="text-2xl text-secondary" />
          </div>
          <div class="min-w-0 text-center md:!text-right">
            <div class="sz-section-kicker">{{ $t('ibc.counterparty') }}</div>
            <div class="mt-1 truncate text-xl font-extrabold tracking-tight text-main">
              {{ row.name }}
            </div>
            <div class="mt-1 font-mono text-[11.5px] text-secondary">{{ row.chainId }}</div>
          </div>
        </div>
      </div>

      <!-- preferred callout -->
      <div
        class="mb-4 rounded-xl border px-4 py-3 flex flex-wrap items-start gap-3"
        :class="
          row.registryPreferred
            ? 'border-success/40 bg-success/5'
            : 'border-warning/40 bg-warning/5'
        "
      >
        <Icon
          :icon="row.registryPreferred ? 'mdi:check-decagram' : 'mdi:alert-outline'"
          class="text-xl shrink-0 mt-0.5"
          :class="row.registryPreferred ? 'text-success' : 'text-warning'"
        />
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-semibold text-main">
            {{ row.registryPreferred ? 'Registry preferred trade path' : 'Best-effort primary path' }}
          </div>
          <div class="mt-1 font-mono text-[12.5px]">
            <span class="font-semibold">{{ row.primaryConnectionId || '—' }}</span>
            <span class="text-secondary"> · </span>
            <span class="font-semibold">{{ row.preferredChannelId || '—' }}</span>
            <span v-if="row.preferredCounterpartyChannelId" class="text-secondary">
              → {{ row.preferredCounterpartyChannelId }}
            </span>
          </div>
          <div class="mt-1 text-[11.5px] text-secondary">
            Other OPEN connections below may be stale, half-open, or non-trade. Use the
            <span class="font-semibold text-main">preferred</span> path for Osmosis / DEX bridges.
          </div>
        </div>
        <RouterLink
          v-if="primary?.id"
          :to="`/${chainStore.chainName}/ibc/connection/${primary.id}`"
          class="btn btn-sm btn-primary shrink-0"
        >
          Open preferred
        </RouterLink>
      </div>

      <!-- stats -->
      <div class="grid grid-cols-2 gap-3 mb-4 sm:!grid-cols-4">
        <div class="sz-stat" style="--stat-hue: var(--sz-success)">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">Open conns</span></div>
          <div class="sz-stat-value">{{ openConns.length }}<span class="sz-stat-unit">/{{ row.connections.length }}</span></div>
        </div>
        <div class="sz-stat" style="--stat-hue: #0ea5e9">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">Open channels</span></div>
          <div class="sz-stat-value">{{ openChans.length }}<span class="sz-stat-unit">/{{ row.channels.length }}</span></div>
        </div>
        <div class="sz-stat" style="--stat-hue: var(--sz-accent)">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">Preferred ch</span></div>
          <div class="sz-stat-value text-[16px] !font-mono">{{ row.preferredChannelId || '—' }}</div>
        </div>
        <div class="sz-stat" style="--stat-hue: var(--sz-warn)">
          <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">Source</span></div>
          <div class="sz-stat-value text-[15px]">{{ row.registryPreferred ? 'Registry' : 'Heuristic' }}</div>
        </div>
      </div>

      <!-- ALL CHANNELS first (what users actually care about for trade) -->
      <div class="sz-section overflow-hidden mb-4">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">ICS-20 / ports</div>
            <div class="sz-section-title">All channels ({{ row.channels.length }})</div>
          </div>
          <span class="sz-chip sz-chip--info font-mono !text-[10px]">{{ openChans.length }} open</span>
        </div>
        <div v-if="!row.channels.length" class="py-10 text-center text-secondary text-sm">No channels</div>
        <div v-else class="overflow-x-auto">
          <table class="sz-table min-w-[720px]">
            <thead>
              <tr>
                <th></th>
                <th>{{ $t('ibc.channel_id') }}</th>
                <th>{{ $t('ibc.port_id') }}</th>
                <th>{{ $t('ibc.state') }}</th>
                <th>via connection</th>
                <th>{{ $t('ibc.counterparty') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="ch in row.channels"
                :key="ch.channel_id + ch.port_id"
                :class="{ 'bg-success/5': isPreferredCh(ch) }"
              >
                <td class="w-8">
                  <span
                    v-if="isPreferredCh(ch)"
                    class="sz-chip sz-chip--ok !px-1.5 !py-0 !text-[9px]"
                    title="Preferred trade path"
                    >★</span
                  >
                </td>
                <td class="font-mono text-[12.5px] font-semibold">{{ ch.channel_id }}</td>
                <td class="font-mono text-[12px] text-secondary">{{ ch.port_id }}</td>
                <td>
                  <span class="sz-chip" :class="chip(ch.state)">{{ shortState(ch.state) }}</span>
                </td>
                <td>
                  <RouterLink
                    v-if="ch.connection_hops?.[0]"
                    :to="`/${chainStore.chainName}/ibc/connection/${ch.connection_hops[0]}`"
                    class="font-mono text-[12px] text-primary no-underline hover:underline"
                  >
                    {{ ch.connection_hops[0] }}
                  </RouterLink>
                  <span v-else class="text-secondary">—</span>
                </td>
                <td class="font-mono text-[11.5px] text-secondary">
                  {{ ch.counterparty?.channel_id
                  }}<span class="opacity-50">/{{ ch.counterparty?.port_id }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ALL CONNECTIONS -->
      <div class="sz-section overflow-hidden mb-4">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">IBC core</div>
            <div class="sz-section-title">All connections ({{ row.connections.length }})</div>
          </div>
          <span class="sz-chip sz-chip--info font-mono !text-[10px]">{{ openConns.length }} open</span>
        </div>
        <div class="overflow-x-auto">
          <table class="sz-table min-w-[720px]">
            <thead>
              <tr>
                <th></th>
                <th>Connection</th>
                <th>{{ $t('ibc.state') }}</th>
                <th>Client</th>
                <th>Counterparty conn</th>
                <th class="text-right">Channels</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in row.connections"
                :key="c.id"
                :class="{ 'bg-success/5': isPreferredConn(c) }"
              >
                <td class="w-8">
                  <span v-if="isPreferredConn(c)" class="sz-chip sz-chip--ok !px-1.5 !py-0 !text-[9px]">★</span>
                </td>
                <td>
                  <RouterLink
                    :to="`/${chainStore.chainName}/ibc/connection/${c.id}`"
                    class="font-mono text-[12.5px] font-semibold text-primary no-underline hover:underline"
                  >
                    {{ c.id }}
                  </RouterLink>
                </td>
                <td>
                  <span class="sz-chip" :class="chip(c.state)">{{ shortState(c.state) }}</span>
                </td>
                <td class="font-mono text-[11.5px] text-secondary">{{ c.client_id }}</td>
                <td class="font-mono text-[11.5px] text-secondary">
                  {{ c.counterparty?.connection_id || '—' }}
                </td>
                <td class="text-right font-mono text-[12px]">
                  {{
                    row.channels.filter((ch) => ch.connection_hops?.[0] === c.id && channelOpen(ch))
                      .length
                  }}/{{ row.channels.filter((ch) => ch.connection_hops?.[0] === c.id).length }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<!--
  Intentionally NO meta.i18n here.
  computedChainMenu builds sidebar from routes with meta.i18n — if this
  detail route is tagged, the nav can pick path ".../chain/:chain_id" and
  show "No IBC data for :chain_id". List page (connection/index.vue) owns
  the sidebar entry via meta.i18n + order.
-->
<route>
  {
    meta: {}
  }
</route>
