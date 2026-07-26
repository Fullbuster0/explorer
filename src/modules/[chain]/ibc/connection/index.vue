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
      r.connections.some((c) => (c.id || '').toLowerCase().includes(q))
    );
  });
});

function primaryConn(row: IbcChainRow) {
  // Prefer an OPEN connection, else first
  return row.connections.find((c) => (c.state || '').includes('OPEN')) || row.connections[0];
}

function statusChip(row: IbcChainRow) {
  if (row.connections.length === 0) return { cls: 'sz-chip--bad', label: 'None' };
  if (row.openConnections === row.connections.length) {
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
  const conn = primaryConn(row);
  if (conn?.id) ibcStore.showConnection(conn.id);
}
</script>

<template>
  <div>
    <!-- page head -->
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Interchain</div>
        <h1 class="sz-page-title">{{ $t('ibc.title') }}</h1>
        <div class="sz-page-sub">
          <template v-if="loaded">
            <span class="font-mono">{{ summary.chains }}</span> chains ·
            <span class="font-mono">{{ summary.openConnections }}</span
            >/{{ summary.connections }} open connections ·
            <span class="font-mono">{{ summary.openChannels }}</span
            >/{{ summary.channels }} channels
          </template>
          <template v-else-if="loading">Loading IBC graph…</template>
          <template v-else>IBC connections grouped by remote chain</template>
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': filter === 'all' }" @click="filter = 'all'">All</a>
        <a class="sz-tab" :class="{ 'sz-tab--active': filter === 'open' }" @click="filter = 'open'">Open</a>
        <a
          class="sz-tab"
          :class="{ 'sz-tab--active': filter === 'wellknown' }"
          @click="filter = 'wellknown'"
          >Well-known</a
        >
      </div>
    </div>

    <!-- summary metrics -->
    <div class="grid grid-cols-2 gap-3 xl:!grid-cols-4">
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">Chains</div>
            <div class="sz-metric-value truncate">{{ summary.chains || '—' }}</div>
            <div class="sz-metric-sub">
              <span class="font-mono">{{ summary.wellKnownChains || 0 }}</span> well-known
            </div>
          </div>
          <span class="sz-metric-icon"><Icon icon="mdi:link-variant" /></span>
        </div>
      </div>
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">Open connections</div>
            <div class="sz-metric-value truncate">
              <span class="font-mono">{{ summary.openConnections || 0 }}</span
              ><span class="text-secondary text-base font-medium">/{{ summary.connections || 0 }}</span>
            </div>
          </div>
          <span class="sz-metric-icon sz-metric-icon--success"><Icon icon="mdi:transit-connection-variant" /></span>
        </div>
      </div>
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">Channels</div>
            <div class="sz-metric-value truncate">
              <span class="font-mono">{{ summary.openChannels || 0 }}</span
              ><span class="text-secondary text-base font-medium">/{{ summary.channels || 0 }}</span>
            </div>
            <div class="sz-metric-sub">open / total</div>
          </div>
          <span class="sz-metric-icon"><Icon icon="mdi:swap-horizontal" /></span>
        </div>
      </div>
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">Well-known</div>
            <div class="sz-metric-value truncate">{{ summary.wellKnownChains || 0 }}</div>
            <div class="sz-metric-sub">registry / hosted</div>
          </div>
          <span class="sz-metric-icon sz-metric-icon--warning"><Icon icon="mdi:star-outline" /></span>
        </div>
      </div>
    </div>

    <!-- error -->
    <div
      v-if="error"
      class="sz-section mt-4 px-4 py-3 text-sm text-error flex items-start gap-2"
    >
      <Icon icon="mdi:alert-circle-outline" class="text-lg shrink-0 mt-0.5" />
      <div>
        <div class="font-semibold">Failed to load IBC data</div>
        <div class="text-secondary font-mono text-xs mt-0.5 break-all">{{ error }}</div>
        <button class="btn btn-xs btn-primary mt-2" @click="ibcStore.load(true)">Retry</button>
      </div>
    </div>

    <!-- table -->
    <div class="sz-section mt-4 overflow-hidden">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3">
        <div class="sz-section-title text-sm !mb-0">Relayers</div>
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
        Loading connections, channels &amp; clients…
      </div>

      <div v-else-if="!filteredRows.length" class="py-14 text-center text-secondary text-sm">
        {{ loaded ? 'No matching chains' : 'No IBC data yet' }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="sz-table min-w-[720px]">
          <thead>
            <tr>
              <th>Chain</th>
              <th>Status</th>
              <th class="text-right">Connections</th>
              <th class="text-right">Channels</th>
              <th>Primary connection</th>
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
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="loaded"
        class="flex flex-wrap items-center gap-2 border-t border-base-content/10 px-4 py-3 text-[11.5px] text-secondary"
      >
        <span class="sz-chip sz-chip--ok">Opened all</span>
        <span class="sz-chip sz-chip--warn">Partial</span>
        <span class="sz-chip sz-chip--bad">Closed</span>
        <span class="hidden md:!inline">Volume $ not indexed — connections &amp; channels only.</span>
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
