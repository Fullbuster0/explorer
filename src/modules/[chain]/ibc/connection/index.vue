<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Icon } from '@iconify/vue';
import { useBlockchain } from '@/stores';
import { useIBCModule, type IbcChainRow } from '../connStore';

const chainStore = useBlockchain();
const ibcStore = useIBCModule();
const { loading, loaded, error, rows, summary } = storeToRefs(ibcStore);

const search = ref('');
const filter = ref<'all' | 'open' | 'wellknown'>('all');
const logoBroken = ref<Record<string, boolean>>({});

function tryLoad() {
  // Wait until LCD client exists (gov detail race pattern)
  if (!chainStore.rpc || !chainStore.endpoint?.address) return;
  ibcStore.load();
}

onMounted(() => {
  tryLoad();
});

watch(
  () => chainStore.endpoint?.address,
  () => {
    // Chain/endpoint switch: force reload
    if (chainStore.rpc) ibcStore.load(true);
  }
);

const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (rows.value || []).filter((r: IbcChainRow) => {
    if (filter.value === 'open' && r.openConnections === 0) return false;
    if (filter.value === 'wellknown' && !r.wellKnown) return false;
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      r.chainId.toLowerCase().includes(q) ||
      r.connections.some((c) => (c.id || '').toLowerCase().includes(q)) ||
      (r.preferredChannelId || '').toLowerCase().includes(q) ||
      (r.primaryConnectionId || '').toLowerCase().includes(q)
    );
  });
});

function primaryConn(row: IbcChainRow) {
  // Registry-aware primary — NEVER raw first OPEN (that was connection-0 for Osmosis).
  return ibcStore.primaryConnection(row);
}

function statusChip(row: IbcChainRow) {
  if (row.connections.length === 0) return { cls: 'sz-chip--bad', label: 'None' };
  // Channels matter more than bare connections for trade safety.
  if (row.openChannels === 0 && row.openConnections > 0) {
    return {
      cls: 'sz-chip--warn',
      label: `Open conn ${row.openConnections}, 0 channels`,
    };
  }
  if (row.openConnections === row.connections.length && row.openChannels > 0) {
    return {
      cls: 'sz-chip--ok',
      label: `Opened ${row.openConnections}/${row.connections.length}`,
    };
  }
  if (row.openConnections > 0) {
    return {
      cls: 'sz-chip--warn',
      label: `Opened ${row.openConnections}/${row.connections.length}`,
    };
  }
  return {
    cls: 'sz-chip--bad',
    label: `Opened 0/${row.connections.length}`,
  };
}

function markLogoBroken(chainId: string) {
  logoBroken.value = { ...logoBroken.value, [chainId]: true };
}

function openRow(row: IbcChainRow) {
  // Land on chain hub (all conns/channels) — not a single random connection.
  if (row.chainId && row.chainId !== 'unknown') {
    ibcStore.showChain(row.chainId);
    return;
  }
  const conn = primaryConn(row);
  if (conn?.id) ibcStore.showConnection(conn.id);
}
</script>

<template>
  <div>
    <!-- page head -->
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">{{ $t('ibc.kicker') || 'Interchain' }}</div>
        <h1 class="sz-page-title">{{ $t('ibc.title') }}</h1>
        <div class="sz-page-sub">
          <template v-if="loaded">
            <span class="font-mono">{{ summary.chains }}</span> chains ·
            <span class="font-mono">{{ summary.openConnections }}</span
            >/{{ summary.connections }} open connections ·
            <span class="font-mono">{{ summary.openChannels }}</span
            >/{{ summary.channels }} channels
          </template>
          <template v-else-if="loading">{{ $t('ibc.loading') }}</template>
          <template v-else>{{ $t('ibc.summary') }}</template>
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': filter === 'all' }" @click="filter = 'all'">{{ $t('ibc.filter_all') }}</a>
        <a class="sz-tab" :class="{ 'sz-tab--active': filter === 'open' }" @click="filter = 'open'">{{ $t('ibc.filter_open') }}</a>
        <a
          class="sz-tab"
          :class="{ 'sz-tab--active': filter === 'wellknown' }"
          @click="filter = 'wellknown'"
          >{{ $t('ibc.filter_known') }}</a
        >
      </div>
    </div>

    <!-- summary metrics -->
    <div class="grid grid-cols-2 gap-3 xl:!grid-cols-4">
      <div class="sz-stat" style="--stat-hue: var(--sz-accent)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('ibc.chains') }}</span></div>
        <div class="sz-stat-value">{{ summary.chains || '—' }}</div>
        <div class="sz-stat-sub">{{ summary.wellKnownChains || 0 }} {{ $t('ibc.well_known').toLowerCase() }}</div>
      </div>
      <div class="sz-stat" style="--stat-hue: var(--sz-success)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('ibc.open_connections') }}</span></div>
        <div class="sz-stat-value">{{ summary.openConnections || 0 }}<span class="sz-stat-unit">/{{ summary.connections || 0 }}</span></div>
      </div>
      <div class="sz-stat" style="--stat-hue: #0ea5e9">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('ibc.channels') }}</span></div>
        <div class="sz-stat-value">{{ summary.openChannels || 0 }}<span class="sz-stat-unit">/{{ summary.channels || 0 }}</span></div>
        <div class="sz-stat-sub">open / total</div>
      </div>
      <div class="sz-stat" style="--stat-hue: var(--sz-warn)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('ibc.well_known') }}</span></div>
        <div class="sz-stat-value">{{ summary.wellKnownChains || 0 }}</div>
        <div class="sz-stat-sub">registry / hosted</div>
      </div>
    </div>

    <!-- error -->
    <div
      v-if="error"
      class="sz-section mt-4 px-4 py-3 text-sm text-error flex items-start gap-2"
    >
      <Icon icon="mdi:alert-circle-outline" class="text-lg shrink-0 mt-0.5" />
      <div>
        <div class="font-semibold">{{ $t('ibc.error_prefix') }}</div>
        <div class="text-secondary font-mono text-xs mt-0.5 break-all">{{ error }}</div>
        <button class="btn btn-xs btn-primary mt-2" @click="ibcStore.load(true)">{{ $t('ibc.retry') }}</button>
      </div>
    </div>

    <!-- safety note -->
    <div
      v-if="loaded"
      class="mt-4 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-[12.5px] text-secondary flex items-start gap-2"
    >
      <Icon icon="mdi:shield-alert-outline" class="text-lg text-warning shrink-0 mt-0.5" />
      <div>
        <span class="font-semibold text-main">Trade path ≠ first open connection.</span>
        Primary uses <span class="font-mono">chain-registry</span> preferred channel when available
        (e.g. AtomOne↔Osmosis <span class="font-mono">connection-2 / channel-2</span>).
        Click a chain to see <em>all</em> open channels before bridging.
      </div>
    </div>

    <!-- table -->
    <div class="sz-section mt-4 overflow-hidden">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3">
        <div class="sz-section-title text-sm !mb-0">{{ $t('ibc.title') }}</div>
        <div class="relative w-full sm:w-72">
          <Icon
            icon="mdi:magnify"
            class="absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-lg pointer-events-none"
          />
          <input
            v-model="search"
            type="search"
            class="input input-sm input-bordered w-full pl-9 font-mono text-xs"
            :placeholder="$t('ibc.search_placeholder') || 'Search chain / chain_id / connection'"
          />
        </div>
      </div>

      <div v-if="loading && !loaded" class="flex items-center justify-center gap-2 py-16 text-secondary text-sm">
        <span class="loading loading-spinner loading-sm"></span>
        {{ $t('ibc.loading') }}
      </div>

      <div v-else-if="!filteredRows.length" class="py-14 text-center text-secondary text-sm">
        {{ loaded ? $t('ibc.no_match') : $t('ibc.empty') }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="sz-table min-w-[860px]">
          <thead>
            <tr>
              <th>{{ $t('ibc.chains') }}</th>
              <th>{{ $t('ibc.state') }}</th>
              <th class="text-right">{{ $t('ibc.connections') }}</th>
              <th class="text-right">{{ $t('ibc.channels') }}</th>
              <th>Preferred path</th>
              <th>{{ $t('ibc.primary_connection') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in filteredRows"
              :key="row.chainId"
              class="cursor-pointer"
              @click="openRow(row)"
            >
              <!-- chain -->
              <td>
                <div class="flex items-center gap-3 overflow-hidden" style="max-width: 320px">
                  <div
                    class="relative h-9 w-9 shrink-0 overflow-hidden rounded-full bg-base-200 ring-1 ring-base-content/10"
                  >
                    <img
                      v-if="row.logo && !logoBroken[row.chainId]"
                      :src="row.logo"
                      class="h-full w-full object-contain p-0.5"
                      alt=""
                      @error="markLogoBroken(row.chainId)"
                    />
                    <div
                      v-else
                      class="flex h-full w-full items-center justify-center text-base-content/40"
                    >
                      <Icon icon="mdi:link-variant" class="text-xl" />
                    </div>
                  </div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="block truncate text-[13.5px] font-semibold">{{ row.name }}</span>
                      <span v-if="row.wellKnown" class="sz-chip sz-chip--info !px-1.5 !py-0 !text-[9px]">WK</span>
                      <span
                        v-if="row.registryPreferred"
                        class="sz-chip sz-chip--ok !px-1.5 !py-0 !text-[9px]"
                        title="chain-registry preferred"
                        >REG</span
                      >
                    </div>
                    <span class="block truncate font-mono text-[11px] text-secondary">{{ row.chainId }}</span>
                  </div>
                </div>
              </td>

              <!-- status -->
              <td>
                <span class="sz-chip" :class="statusChip(row).cls">{{ statusChip(row).label }}</span>
              </td>

              <!-- connections -->
              <td class="text-right">
                <div class="font-mono text-[13px] font-semibold">
                  {{ row.openConnections }}/{{ row.connections.length }}
                </div>
                <div class="text-[10.5px] text-secondary">open / total</div>
              </td>

              <!-- channels -->
              <td class="text-right">
                <div class="font-mono text-[13px] font-semibold">
                  {{ row.openChannels }}/{{ row.channels.length }}
                </div>
                <div class="text-[10.5px] text-secondary">open / total</div>
              </td>

              <!-- preferred channel path -->
              <td @click.stop>
                <div v-if="row.preferredChannelId" class="font-mono text-[12px]">
                  <span class="font-semibold text-main">{{ row.preferredChannelId }}</span>
                  <span v-if="row.preferredCounterpartyChannelId" class="text-secondary">
                    → {{ row.preferredCounterpartyChannelId }}
                  </span>
                </div>
                <span v-else class="text-secondary text-sm">—</span>
                <div v-if="row.registryPreferred" class="text-[10px] text-success mt-0.5">registry preferred</div>
              </td>

              <!-- primary connection -->
              <td @click.stop>
                <RouterLink
                  v-if="primaryConn(row)"
                  :to="`/${chainStore.chainName}/ibc/connection/${primaryConn(row)!.id}`"
                  class="font-mono text-[12.5px] text-primary no-underline hover:underline"
                >
                  {{ primaryConn(row)!.id }}
                </RouterLink>
                <span v-else class="text-secondary text-sm">—</span>
                <div class="mt-0.5">
                  <RouterLink
                    :to="`/${chainStore.chainName}/ibc/connection/chain/${encodeURIComponent(row.chainId)}`"
                    class="text-[10.5px] text-secondary no-underline hover:text-primary hover:underline"
                  >
                    all paths →
                  </RouterLink>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="loaded"
        class="flex flex-wrap items-center gap-2 border-t border-base-content/10 px-4 py-3 text-[11.5px] text-secondary"
      >
        <span class="sz-chip sz-chip--ok">{{ $t('ibc.legend_all') }}</span>
        <span class="sz-chip sz-chip--warn">{{ $t('ibc.legend_partial') }}</span>
        <span class="sz-chip sz-chip--bad">{{ $t('ibc.legend_closed') }}</span>
        <span class="sz-chip sz-chip--ok !text-[9px]">REG</span>
        <span>= chain-registry preferred trade path</span>
        <span class="hidden md:!inline">{{ $t('ibc.legend_note') }}</span>
      </div>
    </div>
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'ibc',
      order: 9
    }
  }
</route>
