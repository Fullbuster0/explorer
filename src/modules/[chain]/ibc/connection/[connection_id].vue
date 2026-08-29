<script lang="ts" setup>
import { formatSeconds } from '@/libs/utils';
import { useBaseStore, useBlockchain, useFormatter } from '@/stores';
import {
  type Connection,
  type ClientState,
  type Channel,
  PageRequest,
  type PaginatedTxs,
} from '@/types';
import { computed, onMounted, ref, watch } from 'vue';
import PaginationBar from '@/components/PaginationBar.vue';
import Loading from '@/components/Loading.vue';
import PendingPackets from './PendingPackets.vue';
import { Icon } from '@iconify/vue';
import { useIBCModule } from '../connStore';

const props = defineProps(['chain', 'connection_id']);
const chainStore = useBlockchain();
const baseStore = useBaseStore();
const format = useFormatter();
const ibcStore = useIBCModule();

const conn = ref({} as Connection);
const clientState = ref({} as { client_id: string; client_state: ClientState });
const channels = ref([] as Channel[]);
const clientStateLoaded = ref(false);
const channelsLoaded = ref(false);
const connLoaded = ref(false);

const connId = computed(() => props.connection_id || 0);

const loading = ref(false);
const txs = ref({} as PaginatedTxs);
const direction = ref('');
const channel_id = ref('');
const port_id = ref('');
const page = ref(new PageRequest());
page.value.limit = 5;
// Chain-wide total for this channel query. The Cosmos LCD tx-search endpoint
// IGNORES pagination.limit/offset (page.toQueryString) but honours top-level
// page/limit, and reports the count in the top-level `total` field with
// `pagination` = null. So we drive server paging via page/limit appended to the
// query string and read the count from `total ?? pagination.total`.
const txsTotal = ref('0');

const localChainId = computed(
  () => baseStore.latest?.block?.header?.chain_id || chainStore.current?.chainName || props.chain
);
const remoteChainId = computed(() => clientState.value.client_state?.chain_id || '—');
const isOpen = computed(() => (conn.value.state || '').indexOf('_OPEN') > -1);
const openChannels = computed(() => channels.value.filter((c) => (c.state || '').indexOf('_OPEN') > -1).length);
const localChannelIds = computed(() => channels.value.map((c) => c.channel_id).filter(Boolean) as string[]);
const counterpartyClientId = computed(
  () => (conn.value as any)?.counterparty?.client_id || ''
);

function loadDetail() {
  if (!connId.value || !chainStore.rpc || !chainStore.endpoint?.address) return;
  // Mark each slice loaded ONLY on success. If the active endpoint is dead
  // mid-fallback these reject; leaving *Loaded=false lets the endpoint.address
  // watch below retry once fallback lands on a healthy node. Setting loaded in
  // .finally (old behaviour) flipped the flag on failure too, so the watch's
  // `!connLoaded` guard never re-fired and the page hung on "Loading" forever.
  // .catch swallows the rejection so it doesn't surface as an unhandled error.
  chainStore.rpc
    .getIBCConnectionsById(connId.value)
    .then((x) => {
      conn.value = x.connection as Connection;
      connLoaded.value = true;
    })
    .catch(() => {});
  chainStore.rpc
    .getIBCConnectionsClientState(connId.value)
    .then((x) => {
      clientState.value = x.identified_client_state as any;
      clientStateLoaded.value = true;
    })
    .catch(() => {});
  chainStore.rpc
    .getIBCConnectionsChannels(connId.value)
    .then((x) => {
      channels.value = x.channels;
      channelsLoaded.value = true;
    })
    .catch(() => {});
}

onMounted(() => {
  loadDetail();
  // Need list+registry so we can mark preferred trade path on this connection.
  if (chainStore.rpc) ibcStore.load();
});
// endpoint may resolve after mount (chain switch / cold load) or change on
// fallback. Retry until ALL three slices have loaded — checking only connLoaded
// would leave the page half-stuck if clientState/channels failed but conn didn't.
watch(
  () => [props.connection_id, chainStore.endpoint?.address, chainStore.chainName] as const,
  ([, addr]) => {
    if (addr && !(connLoaded.value && clientStateLoaded.value && channelsLoaded.value)) loadDetail();
  }
);

function pageload(pageNum: number) {
  if (direction.value === 'In') fetchReceivingTxs(channel_id.value, port_id.value, pageNum - 1);
  else fetchSendingTxs(channel_id.value, port_id.value, pageNum - 1);
}

/** Top-level `page`/`limit` — the only paging params the LCD tx-search honours. */
function serverPaging(pageNum: number) {
  return `&page=${pageNum + 1}&limit=${page.value.limit}`;
}
/** LCD returns the count in top-level `total`; `pagination` is null here. */
function readTotal(res: any): string {
  const t = res?.total ?? res?.pagination?.total;
  return t !== undefined && t !== null ? String(t) : '0';
}

function fetchSendingTxs(channel: string, port: string, pageNum = 0) {
  page.value.setPage(pageNum);
  loading.value = true;
  direction.value = 'Out';
  channel_id.value = channel;
  port_id.value = port;
  txs.value = {} as PaginatedTxs;
  chainStore.rpc
    .getTxs(
      "?order_by=2&events=send_packet.packet_src_channel='{channel}'&events=send_packet.packet_src_port='{port}'" +
        serverPaging(pageNum),
      { channel, port },
      page.value
    )
    .then((res) => {
      txs.value = res;
      txsTotal.value = readTotal(res);
    })
    .finally(() => (loading.value = false));
}

function fetchReceivingTxs(channel: string, port: string, pageNum = 0) {
  page.value.setPage(pageNum);
  loading.value = true;
  direction.value = 'In';
  channel_id.value = channel;
  port_id.value = port;
  txs.value = {} as PaginatedTxs;
  chainStore.rpc
    .getTxs(
      "?order_by=2&events=recv_packet.packet_dst_channel='{channel}'&events=recv_packet.packet_dst_port='{port}'" +
        serverPaging(pageNum),
      { channel, port },
      page.value
    )
    .then((res) => {
      txs.value = res;
      txsTotal.value = readTotal(res);
    })
    .finally(() => (loading.value = false));
}

function channelChip(state: string) {
  return (state || '').indexOf('_OPEN') > -1 ? 'sz-chip--ok' : 'sz-chip--warn';
}
function shortState(state?: string) {
  return (state || '').replace('STATE_', '').replace(/_/g, ' ');
}
const isPreferredConnection = computed(() => {
  const id = String(props.connection_id || '');
  return (ibcStore.rows || []).some((r) => r.primaryConnectionId === id && r.registryPreferred);
});
const preferredChannelOnThis = computed(() => {
  const id = String(props.connection_id || '');
  const row = (ibcStore.rows || []).find((r) => r.primaryConnectionId === id);
  return row?.preferredChannelId || '';
});
function isPreferredChannel(ch: Channel) {
  return !!preferredChannelOnThis.value && ch.channel_id === preferredChannelOnThis.value;
}
</script>

<template>
  <div>
    <!-- back link -->
    <RouterLink
      :to="`/${chainStore.chainName}/ibc/connection`"
      class="inline-flex items-center gap-1 text-[12.5px] text-secondary hover:text-primary no-underline mb-3"
    >
      <Icon icon="mdi:arrow-left" class="text-base" />
      {{ $t('ibc.title') }}
    </RouterLink>

    <!-- HERO: local ↔ remote -->
    <div class="sz-section overflow-hidden mb-4">
      <div class="grid grid-cols-1 items-center gap-4 p-5 md:!grid-cols-[1fr_auto_1fr]">
        <!-- local -->
        <div class="min-w-0 text-center md:!text-left">
          <div class="sz-section-kicker">{{ $t('ibc.this_chain') }}</div>
          <div class="mt-1 truncate text-xl font-extrabold tracking-tight text-main">
            {{ localChainId }}
          </div>
          <div class="mt-1 font-mono text-[11.5px] text-secondary">
            {{ conn.client_id || '—' }} · {{ props.connection_id }}
          </div>
        </div>

        <!-- link state -->
        <div class="flex flex-col items-center gap-1.5">
          <span
            class="sz-chip"
            :class="isOpen ? 'sz-chip--ok' : connLoaded ? 'sz-chip--warn' : 'sz-chip--info'"
          >
            <Icon :icon="isOpen ? 'mdi:transit-connection-variant' : 'mdi:link-off'" />
            {{ shortState(conn.state) || $t('ibc.loading') }}
          </span>
          <Icon icon="mdi:swap-horizontal" class="text-2xl text-secondary" />
        </div>

        <!-- remote -->
        <div class="min-w-0 text-center md:!text-right">
          <div class="sz-section-kicker">{{ $t('ibc.counterparty') }}</div>
          <div class="mt-1 truncate text-xl font-extrabold tracking-tight text-main">
            {{ remoteChainId }}
          </div>
          <div class="mt-1 font-mono text-[11.5px] text-secondary">
            <!--
              Counterparty block must show the REMOTE client id
              (`conn.counterparty.client_id`). `clientState.client_id` is the
              identified_client_state returned by
              /connections/{id}/client_state, which is OUR OWN client — printing
              it here mislabelled every connection page (e.g. connection-809
              showed `connection-0 · 07-tendermint-1119` when the remote client
              is actually `07-tendermint-0`).
            -->
            {{ conn.counterparty?.connection_id || '—' }} ·
            {{ conn.counterparty?.client_id || '—' }}
          </div>
        </div>
      </div>

    </div>

    <div
      v-if="isPreferredConnection"
      class="mb-4 rounded-xl border border-success/40 bg-success/5 px-4 py-3 text-[12.5px] flex items-center gap-2"
    >
      <Icon icon="mdi:check-decagram" class="text-lg text-success shrink-0" />
      <div>
        <span class="font-semibold text-main">Registry preferred trade path</span>
        <span class="text-secondary"> — this connection is the community / chain-registry route</span>
        <span v-if="preferredChannelOnThis" class="font-mono"> ({{ preferredChannelOnThis }})</span>.
      </div>
    </div>
    <div
      v-else-if="connLoaded && channelsLoaded && openChannels === 0"
      class="mb-4 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-[12.5px] flex items-center gap-2"
    >
      <Icon icon="mdi:alert-outline" class="text-lg text-warning shrink-0" />
      <div>
        <span class="font-semibold text-main">No open transfer channel on this connection.</span>
        <span class="text-secondary"> It may be a half-open or non-trade link — check the chain hub for the preferred path.</span>
      </div>
    </div>

    <!-- quick stats -->
    <div class="grid grid-cols-1 gap-3 mb-4 sm:!grid-cols-3">
      <div class="sz-stat" style="--stat-hue: #0ea5e9">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('ibc.channels') }}</span></div>
        <div class="sz-stat-value">{{ openChannels }}<span class="sz-stat-unit">/{{ channels.length }}</span></div>
        <div class="sz-stat-sub">open / total</div>
      </div>
      <div class="sz-stat" style="--stat-hue: #764bc8">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('ibc.client_type') }}</span></div>
        <div class="sz-stat-value">{{ (clientState.client_state?.['@type'] || '—').split('.').pop() }}</div>
      </div>
      <div class="sz-stat" style="--stat-hue: var(--sz-success)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('ibc.latest_height') }}</span></div>
        <div class="sz-stat-value">{{ clientState.client_state?.latest_height?.revision_height || '—' }}</div>
      </div>
    </div>

    <!-- CLIENT / TRUST -->
    <div class="sz-section overflow-hidden mb-4">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">{{ $t('ibc.light_client') }}</div>
          <div class="sz-section-title">{{ $t('ibc.title_2') }}</div>
        </div>
        <span v-if="clientState.client_state?.['@type']" class="sz-chip sz-chip--info font-mono !text-[10px]">
          {{ clientState.client_state['@type'].split('.').pop() }}
        </span>
      </div>

      <Loading v-if="!clientStateLoaded" :bordered="false" />
      <div v-else class="grid grid-cols-1 gap-x-8 gap-y-1 p-4 md:!grid-cols-2">
        <!-- trust params -->
        <div class="divide-y divide-base-content/[.06]">
          <div class="flex items-center justify-between py-2">
            <span class="text-[12.5px] text-secondary">{{ $t('ibc.trust_level') }}</span>
            <span class="font-mono text-[12.5px] font-semibold">
              {{ clientState.client_state?.trust_level?.numerator }}/{{ clientState.client_state?.trust_level?.denominator }}
            </span>
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[12.5px] text-secondary">{{ $t('ibc.trusting_period') }}</span>
            <span class="font-mono text-[12.5px] font-semibold">{{ formatSeconds(clientState.client_state?.trusting_period) }}</span>
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[12.5px] text-secondary">{{ $t('ibc.unbonding_period') }}</span>
            <span class="font-mono text-[12.5px] font-semibold">{{ formatSeconds(clientState.client_state?.unbonding_period) }}</span>
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[12.5px] text-secondary">{{ $t('ibc.max_clock_drift') }}</span>
            <span class="font-mono text-[12.5px] font-semibold">{{ formatSeconds(clientState.client_state?.max_clock_drift) }}</span>
          </div>
        </div>
        <!-- state / upgrade -->
        <div class="divide-y divide-base-content/[.06]">
          <div class="flex items-center justify-between py-2">
            <span class="text-[12.5px] text-secondary">{{ $t('ibc.frozen_height') }}</span>
            <span class="font-mono text-[12.5px] font-semibold">
              {{ clientState.client_state?.frozen_height?.revision_height || '0' }}
            </span>
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[12.5px] text-secondary">{{ $t('ibc.allow_update_after_expiry') }}</span>
            <span class="sz-chip !text-[10px]" :class="clientState.client_state?.allow_update_after_expiry ? 'sz-chip--ok' : 'sz-chip--bad'">
              {{ clientState.client_state?.allow_update_after_expiry ? $t('ibc.yes') : $t('ibc.no') }}
            </span>
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[12.5px] text-secondary">{{ $t('ibc.allow_update_after_misbehaviour') }}</span>
            <span class="sz-chip !text-[10px]" :class="clientState.client_state?.allow_update_after_misbehaviour ? 'sz-chip--ok' : 'sz-chip--bad'">
              {{ clientState.client_state?.allow_update_after_misbehaviour ? $t('ibc.yes') : $t('ibc.no') }}
            </span>
          </div>
          <div class="flex items-center justify-between gap-3 py-2">
            <span class="text-[12.5px] text-secondary shrink-0">{{ $t('ibc.upgrade_path') }}</span>
            <span class="font-mono text-[11.5px] font-semibold truncate text-right">
              {{ (clientState.client_state?.upgrade_path || []).join(', ') || '—' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- CHANNELS -->
    <div class="sz-section overflow-hidden mb-4">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">{{ $t('ibc.transfer') }}</div>
          <div class="sz-section-title">{{ $t('ibc.channels') }}</div>
        </div>
        <span class="sz-chip sz-chip--info font-mono !text-[10px]">{{ openChannels }}/{{ channels.length }} open</span>
      </div>

      <Loading v-if="!channelsLoaded" :bordered="false" />
      <div v-else-if="!channels.length" class="py-10 text-center text-secondary text-sm">{{ $t('ibc.no_channels') }}</div>
      <div v-else class="overflow-x-auto">
        <table class="sz-table min-w-[760px]">
          <thead>
            <tr>
              <th>{{ $t('ibc.channel_id') }}</th>
              <th>{{ $t('ibc.port_id') }}</th>
              <th>{{ $t('ibc.state') }}</th>
              <th>{{ $t('ibc.counterparty') }}</th>
              <th>{{ $t('ibc.ordering') }}</th>
              <th class="text-right">{{ $t('ibc.txs') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in channels" :key="v.channel_id + v.port_id" :class="{ 'bg-success/5': isPreferredChannel(v) }">
              <td class="font-mono text-[12.5px] font-semibold">
                {{ v.channel_id }}
                <span v-if="isPreferredChannel(v)" class="sz-chip sz-chip--ok !px-1.5 !py-0 !text-[9px] ml-1">★ preferred</span>
              </td>
              <td class="font-mono text-[12px] text-secondary">{{ v.port_id }}</td>
              <td>
                <span class="sz-chip" :class="channelChip(v.state)">{{ shortState(v.state) }}</span>
              </td>
              <td class="font-mono text-[11.5px] text-secondary">
                {{ v.counterparty?.channel_id }}<span class="opacity-50">/{{ v.counterparty?.port_id }}</span>
              </td>
              <td class="text-[12px] capitalize">{{ (v.ordering || '').replace('ORDER_', '').toLowerCase() }}</td>
              <td class="text-right">
                <div class="inline-flex gap-1.5">
                  <button
                    class="btn btn-xs rounded-md"
                    :disabled="loading"
                    @click="fetchSendingTxs(v.channel_id, v.port_id)"
                  >
                    <span v-if="loading && direction === 'Out' && channel_id === v.channel_id" class="loading loading-spinner loading-xs"></span>
                    <Icon v-else icon="mdi:arrow-top-right" class="text-sm" />
                    {{ $t('ibc.btn_out') }}
                  </button>
                  <button
                    class="btn btn-xs rounded-md"
                    :disabled="loading"
                    @click="fetchReceivingTxs(v.channel_id, v.port_id)"
                  >
                    <span v-if="loading && direction === 'In' && channel_id === v.channel_id" class="loading loading-spinner loading-xs"></span>
                    <Icon v-else icon="mdi:arrow-bottom-left" class="text-sm" />
                    {{ $t('ibc.btn_in') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- PENDING PACKETS (mempool) -->
    <PendingPackets
      :chain="props.chain"
      :connection-id="String(props.connection_id)"
      :client-id="conn.client_id"
      :counterparty-client-id="counterpartyClientId"
      :channels="localChannelIds"
    />

    <!-- CHANNEL TXS -->
    <div v-if="channel_id" class="sz-section overflow-hidden">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">{{ $t('ibc.packets') }}</div>
          <div class="sz-section-title">
            {{ direction === 'In' ? $t('ibc.incoming') : $t('ibc.outgoing') }} · {{ channel_id }} / {{ port_id }}
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="sz-table min-w-[640px]">
          <thead>
            <tr>
              <th>{{ $t('ibc.height') }}</th>
              <th>{{ $t('ibc.txhash') }}</th>
              <th>{{ $t('ibc.messages') }}</th>
              <th class="text-right">{{ $t('ibc.time') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="resp in txs?.tx_responses" :key="resp.txhash">
              <td class="font-mono text-[12.5px]">
                <RouterLink :to="`/${chainStore.chainName}/block/${resp.height}`" class="text-primary no-underline hover:underline">
                  #{{ resp.height }}
                </RouterLink>
              </td>
              <td class="max-w-[220px] truncate">
                <RouterLink :to="`/${chainStore.chainName}/tx/${resp.txhash}`" class="font-mono text-[12px] text-primary no-underline hover:underline">
                  {{ resp.txhash }}
                </RouterLink>
              </td>
              <td>
                <div class="flex items-center gap-1.5">
                  <span class="sz-msg">{{ format.messages(resp.tx.body.messages) }}</span>
                  <Icon v-if="resp.code === 0" icon="mdi:check-circle" class="text-success text-base" />
                  <Icon v-else icon="mdi:close-circle" class="text-error text-base" />
                </div>
              </td>
              <td class="text-right font-mono text-[11.5px] text-secondary">{{ format.toLocaleDate(resp.timestamp) }}</td>
            </tr>
            <tr v-if="!loading && !(txs?.tx_responses?.length)">
              <td colspan="4" class="py-8 text-center text-secondary text-sm">{{ $t('ibc.no_packets') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="border-t border-base-content/10 px-4 py-2">
        <PaginationBar :limit="page.limit" :total="txsTotal" :callback="pageload" />
      </div>
    </div>
  </div>
</template>
