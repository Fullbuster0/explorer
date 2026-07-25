<script lang="ts" setup>
import fetch from 'cross-fetch';
import { onMounted, ref, computed, onUnmounted, watch } from 'vue';
import { useBlockchain, useFormatter, useStakingStore, useBaseStore } from '@/stores';
import { consensusPubkeyToHexAddress } from '@/libs';

const format = useFormatter();
const chainStore = useBlockchain();
const stakingStore = useStakingStore();
const baseStore = useBaseStore();

const rpcList = ref<{ address: string; provider?: string }[]>([]);
const rpc = ref('');
const validators = ref(stakingStore.validators);

const httpstatus = ref(200);
const httpStatusText = ref('');
const roundState = ref({} as any);
const height = ref('');
const round = ref('');
const step = ref('');
let timer: any = null;
let loading = false;
let started = false;
const updatetime = ref(new Date());
const positions = ref([] as any[]);
const validatorsData = ref([] as any);

// ---- UI state (NodesHub-style) ----
const searchText = ref('');
const showFilter = ref<'all' | 'online' | 'offline'>('all');

// ---- avatars (keybase, cached in localStorage) ----
const avatars = ref<Record<string, string>>(JSON.parse(localStorage.getItem('avatars') || '{}'));
function logo(identity?: string) {
  if (!identity || !avatars.value[identity]) return '';
  const url = avatars.value[identity] || '';
  return url.startsWith('http') ? url : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
}
function fetchAvatar(identity: string) {
  return new Promise<void>((resolve) => {
    stakingStore
      .keybase(identity)
      .then((d: any) => {
        if (Array.isArray(d.them) && d.them.length > 0) {
          const uri = String(d.them[0]?.pictures?.primary?.url).replace(
            'https://s3.amazonaws.com/keybase_processed_uploads/',
            ''
          );
          avatars.value[identity] = uri;
        }
        resolve();
      })
      .catch(() => resolve());
  });
}
function loadAvatars() {
  const ids = new Set<string>();
  validatorsData.value.forEach((v: any) => {
    const id = v?.description?.identity;
    if (id && !avatars.value[id]) ids.add(id);
  });
  Promise.all([...ids].map((id) => fetchAvatar(id))).then(() =>
    localStorage.setItem('avatars', JSON.stringify(avatars.value))
  );
}

function pickRpcList() {
  const list = (chainStore.current?.endpoints?.rpc || []).filter((x) => x?.address);
  // Prefer Shazoes RPC first (CORS + dump_consensus_state allowed)
  list.sort((a, b) => {
    const as = /shazoes/i.test(a.address || '') || /shazoes/i.test(a.provider || '') ? 0 : 1;
    const bs = /shazoes/i.test(b.address || '') || /shazoes/i.test(b.provider || '') ? 0 : 1;
    return as - bs;
  });
  return list;
}

function setRpcFromList(preferAddress?: string) {
  rpcList.value = pickRpcList();
  if (rpcList.value.length === 0) {
    rpc.value = '';
    return false;
  }
  if (preferAddress) {
    const hit = rpcList.value.find((x) => x.address === preferAddress || preferAddress.startsWith(x.address));
    if (hit) {
      rpc.value = hit.address.replace(/\/$/, '') + '/consensus_state';
      return true;
    }
  }
  rpc.value = rpcList.value[0].address.replace(/\/$/, '') + '/consensus_state';
  return true;
}

async function startMonitor() {
  if (started || loading) return;
  if (!setRpcFromList()) {
    httpstatus.value = 0;
    httpStatusText.value = 'No RPC endpoint configured for this chain';
    return;
  }
  started = true;
  loading = true;
  try {
    try {
      validatorsData.value = await stakingStore.fetchAcitveValdiators();
      loadAvatars();
    } catch (e) {
      console.warn('validators load failed', e);
    }
    await fetchPosition();
    // If dump_consensus_state blocked (403/etc), try next RPC that supports it
    if (httpstatus.value !== 200 && rpcList.value.length > 1) {
      for (const ep of rpcList.value.slice(1)) {
        rpc.value = ep.address.replace(/\/$/, '') + '/consensus_state';
        await fetchPosition();
        if (httpstatus.value === 200) break;
      }
    }
    if (httpstatus.value === 200) {
      await update();
      clearTime();
      timer = setInterval(() => update(), Math.max(1000, Math.round(baseStore.blocktime / 2) || 3000));
    }
  } finally {
    loading = false;
  }
}

onMounted(async () => {
  // Wait for chain config to load (rpc endpoints arrive async via dashboard.initial)
  if (chainStore.current?.endpoints?.rpc?.length) {
    await startMonitor();
  } else {
    httpstatus.value = 0;
    httpStatusText.value = 'Loading chain endpoints...';
    const stop = watch(
      () => chainStore.current?.endpoints?.rpc,
      async (v) => {
        if (v && v.length > 0) {
          stop();
          await startMonitor();
        }
      },
      { immediate: true }
    );
    // Safety timeout — surface clearer error
    setTimeout(() => {
      if (!started && (!rpcList.value || rpcList.value.length === 0)) {
        httpstatus.value = 0;
        httpStatusText.value =
          'Chain not found or no RPC endpoints. Add chains/mainnet/<name>.json and redeploy.';
      }
    }, 8000);
  }
});
onUnmounted(() => {
  clearTime();
  loading = false;
  started = false;
});
function clearTime() {
  clearInterval(timer);
  timer = null;
}

const newTime = computed(() => format.toDay(updatetime.value, 'time'));
const chainId = computed(() => baseStore.currentChainId || chainStore.current?.chainId || '');

const vals = computed(() =>
  validatorsData.value.map((x: any) => {
    const x2 = x;
    // @ts-ignore
    x2.hex = consensusPubkeyToHexAddress(x.consensus_pubkey);
    return x2;
  })
);

// ---- helpers ----
function parseBitArrayRate(s?: string): number {
  if (!s) return 0;
  const m = String(s).trim().match(/([0-9]*\.?[0-9]+)\s*$/);
  return m ? parseFloat(m[1]) : 0;
}
function isSigned(vote?: string): boolean {
  return vote !== undefined && vote !== null && !String(vote).toLowerCase().includes('nil');
}

// ---- current vote set (match round, else best prevote rate) ----
const currentVoteSet = computed(() => {
  const set = roundState.value?.height_vote_set;
  if (!Array.isArray(set) || set.length === 0) return null;
  const r = Number(round.value);
  const match = set.find((x: any) => Number(x.round) === r);
  if (match) return match;
  return set.reduce(
    (best: any, x: any) =>
      parseBitArrayRate(x.prevotes_bit_array) > parseBitArrayRate(best.prevotes_bit_array) ? x : best,
    set[0]
  );
});

const prevoteRate = computed(() => (parseBitArrayRate(currentVoteSet.value?.prevotes_bit_array) * 100).toFixed(1));
const precommitRate = computed(() => (parseBitArrayRate(currentVoteSet.value?.precommits_bit_array) * 100).toFixed(1));

// ---- rows ----
interface Row {
  consensusIndex: number;
  rank: number;
  address: string;
  moniker: string;
  identity: string;
  votingPower: number;
  vpPercent: number;
  prevote?: string;
  precommit?: string;
  online: boolean;
  isProposer: boolean;
}
const rows = computed<Row[]>(() => {
  const vs = currentVoteSet.value;
  const totalVP = positions.value.reduce((s: number, p: any) => s + Number(p.voting_power || 0), 0);
  const proposerAddr = String(roundState.value?.proposer?.address || '').toUpperCase();
  const built = positions.value.map((p: any, i: number) => {
    const addr = String(p.address || '').toUpperCase();
    const val = vals.value.find((x: any) => String(x.hex || '').toUpperCase() === addr);
    const prevote = vs?.prevotes?.[i];
    const precommit = vs?.precommits?.[i];
    return {
      consensusIndex: i,
      rank: 0,
      address: addr,
      moniker: val?.description?.moniker || addr.slice(0, 14),
      identity: val?.description?.identity || '',
      votingPower: Number(p.voting_power || 0),
      vpPercent: totalVP > 0 ? (Number(p.voting_power || 0) / totalVP) * 100 : 0,
      prevote,
      precommit,
      online: isSigned(prevote),
      isProposer: proposerAddr !== '' && proposerAddr === addr,
    };
  });
  const sorted = [...built].sort((a, b) => b.votingPower - a.votingPower);
  sorted.forEach((r, idx) => {
    r.rank = idx + 1;
  });
  return sorted;
});

const onlineCount = computed(() => rows.value.filter((r) => r.online).length);
const offlineCount = computed(() => rows.value.length - onlineCount.value);
const onlineVP = computed(() => rows.value.filter((r) => r.online).reduce((s, r) => s + r.vpPercent, 0));
const offlineVP = computed(() => Math.max(0, 100 - onlineVP.value));
const proposerRow = computed(() => rows.value.find((r) => r.isProposer));

const prevoteSigned = computed(() => currentVoteSet.value?.prevotes?.filter((v: any) => isSigned(v)).length || 0);
const precommitSigned = computed(() => currentVoteSet.value?.precommits?.filter((v: any) => isSigned(v)).length || 0);

const filteredRows = computed(() => {
  let list = rows.value;
  if (showFilter.value === 'online') list = list.filter((r) => r.online);
  else if (showFilter.value === 'offline') list = list.filter((r) => !r.online);
  const q = searchText.value.trim().toLowerCase();
  if (q) list = list.filter((r) => r.moniker.toLowerCase().includes(q) || r.address.toLowerCase().includes(q));
  return list;
});
const colA = computed(() => filteredRows.value.filter((_, i) => i % 2 === 0));
const colB = computed(() => filteredRows.value.filter((_, i) => i % 2 === 1));

// ---- actions ----
async function onChange() {
  if (loading) return;
  loading = true;
  httpstatus.value = 200;
  httpStatusText.value = '';
  roundState.value = {};
  positions.value = [];
  clearTime();
  try {
    await fetchPosition();
    if (httpstatus.value === 200) {
      await update();
      timer = setInterval(() => update(), Math.max(1000, Math.round(baseStore.blocktime / 2) || 3000));
    }
  } finally {
    loading = false;
  }
}
async function fetchPosition() {
  if (!rpc.value) {
    httpstatus.value = 0;
    httpStatusText.value = 'No RPC selected';
    return;
  }
  const dumpurl = rpc.value.replace('consensus_state', 'dump_consensus_state');
  try {
    const response = await fetch(dumpurl);
    httpstatus.value = response.status;
    httpStatusText.value = response.statusText || (response.ok ? 'OK' : `HTTP ${response.status}`);
    if (!response.ok) {
      positions.value = [];
      return;
    }
    const data = await response.json();
    positions.value = data?.result?.round_state?.validators?.validators || [];
    if (!positions.value.length) {
      httpstatus.value = 204;
      httpStatusText.value = 'dump_consensus_state returned empty validators';
    }
  } catch (error: any) {
    httpstatus.value = error?.status || 500;
    httpStatusText.value = error?.message || String(error) || 'Error fetching dump_consensus_state';
    positions.value = [];
  }
}
async function update() {
  updatetime.value = new Date();
  if (!rpc.value) return;
  try {
    const data = await fetch(rpc.value);
    httpstatus.value = data.status;
    httpStatusText.value = data.statusText;
    if (!data.ok) return;
    const res = await data.json();
    roundState.value = res?.result?.round_state || {};
    const raw = String(roundState.value?.['height/round/step'] || '').split('/');
    height.value = raw[0] || '';
    round.value = raw[1] || '';
    step.value = raw[2] || '';
  } catch (err: any) {
    httpstatus.value = 500;
    httpStatusText.value = err?.message || String(err);
  }
}
function exportCsv() {
  const header = ['Rank', 'Moniker', 'Address', 'VotingPower', 'VP%', 'Online', 'Prevote', 'Precommit'];
  const lines = rows.value.map((r) =>
    [
      r.rank,
      `"${r.moniker.replace(/"/g, '""')}"`,
      r.address,
      r.votingPower,
      r.vpPercent.toFixed(2),
      r.online ? 'yes' : 'no',
      isSigned(r.prevote) ? 'signed' : 'nil',
      isSigned(r.precommit) ? 'signed' : 'nil',
    ].join(',')
  );
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${chainStore.chainName || 'chain'}-consensus.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="space-y-4">
    <!-- status bar -->
    <div
      class="bg-base-100 border border-base-300 rounded-lg shadow px-5 py-3 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm"
    >
      <div class="flex items-center gap-1.5">
        <span class="opacity-70">Chain ID:</span>
        <span class="font-mono font-semibold">{{ chainId || '--' }}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="opacity-70">Block Height:</span>
        <span class="font-mono font-semibold">{{ height ? Number(height).toLocaleString() : '--' }}</span>
        <span
          class="w-2 h-2 rounded-full animate-pulse"
          :class="httpstatus === 200 ? 'bg-success' : 'bg-error'"
          :title="httpstatus === 200 ? 'Live updating' : 'Disconnected'"
        ></span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="opacity-70">{{ $t('consensus.updated_at') }}:</span>
        <span class="font-mono">{{ newTime }}</span>
      </div>
      <div v-if="httpstatus !== 200" class="text-error font-mono text-xs">{{ httpstatus }}: {{ httpStatusText }}</div>
    </div>

    <!-- metric cards -->
    <div v-if="roundState['height/round/step']" class="flex flex-wrap gap-3">
      <!-- Height H/R/S -->
      <div class="bg-base-100 border border-base-300 rounded-lg shadow overflow-hidden inline-block min-w-[170px]">
        <div class="px-3 py-2 bg-base-200 border-b border-base-300">
          <h3 class="text-xs font-bold text-center uppercase tracking-wide">{{ $t('account.height') }}</h3>
        </div>
        <div class="px-3 py-2.5 flex items-center gap-4 text-xs font-mono">
          <span><code class="opacity-60">H:</code> {{ height ? Number(height).toLocaleString() : '--' }}</span>
          <span><code class="opacity-60">R:</code> {{ round || '--' }}</span>
          <span><code class="opacity-60">S:</code> {{ step || '--' }}</span>
        </div>
      </div>

      <!-- Prevotes -->
      <div class="bg-base-100 border border-base-300 rounded-lg shadow overflow-hidden inline-block min-w-[250px]">
        <div class="px-3 py-2 bg-base-200 border-b border-base-300">
          <h3 class="text-xs font-bold text-center uppercase tracking-wide">Prevotes</h3>
        </div>
        <div class="px-3 py-2.5 flex items-center gap-3 text-xs">
          <span v-if="!currentVoteSet" class="opacity-60">Waiting...</span>
          <span v-else class="font-mono">{{ prevoteSigned }}/{{ rows.length }} signed</span>
          <span class="flex items-center gap-1 border-l border-base-300 pl-3 ml-auto">
            <code class="text-info font-mono">Total:</code>
            <span class="font-mono font-semibold">{{ prevoteRate }}%</span>
          </span>
        </div>
      </div>

      <!-- Precommits -->
      <div class="bg-base-100 border border-base-300 rounded-lg shadow overflow-hidden inline-block min-w-[250px]">
        <div class="px-3 py-2 bg-base-200 border-b border-base-300">
          <h3 class="text-xs font-bold text-center uppercase tracking-wide">Precommits</h3>
        </div>
        <div class="px-3 py-2.5 flex items-center gap-3 text-xs">
          <span v-if="!currentVoteSet" class="opacity-60">Waiting...</span>
          <span v-else class="font-mono">{{ precommitSigned }}/{{ rows.length }} signed</span>
          <span class="flex items-center gap-1 border-l border-base-300 pl-3 ml-auto">
            <code class="text-success font-mono">Total:</code>
            <span class="font-mono font-semibold">{{ precommitRate }}%</span>
          </span>
        </div>
      </div>

      <!-- VP Status -->
      <div class="bg-base-100 border border-base-300 rounded-lg shadow overflow-hidden inline-block min-w-[210px]">
        <div class="px-3 py-2 bg-base-200 border-b border-base-300">
          <h3 class="text-xs font-bold text-center uppercase tracking-wide">VP Status</h3>
        </div>
        <div class="px-3 py-2.5 flex items-center gap-3 text-xs">
          <span class="flex items-center gap-1">
            <code class="text-success font-mono">Online:</code>
            <span class="font-mono font-semibold">{{ onlineVP.toFixed(2) }}%</span>
          </span>
          <span class="flex items-center gap-1">
            <code class="text-error font-mono">Offline:</code>
            <span class="font-mono font-semibold">{{ offlineVP.toFixed(2) }}%</span>
          </span>
        </div>
      </div>

      <!-- Proposer -->
      <div class="bg-base-100 border border-base-300 rounded-lg shadow overflow-hidden inline-block ml-auto w-60">
        <div class="px-3 py-2 bg-base-200 border-b border-base-300">
          <h3 class="text-xs font-bold text-center uppercase tracking-wide">Proposer</h3>
        </div>
        <div class="px-3 py-2.5">
          <div v-if="proposerRow" class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full overflow-hidden bg-base-300 flex-shrink-0 flex items-center justify-center">
              <img v-if="logo(proposerRow.identity)" v-lazy="logo(proposerRow.identity)" class="w-full h-full object-cover" alt="" />
              <span v-else class="text-[10px] font-bold">{{ proposerRow.moniker.slice(0, 1) }}</span>
            </div>
            <span class="text-warning text-sm font-bold truncate" :title="proposerRow.moniker">{{ proposerRow.moniker }}</span>
          </div>
          <span v-else class="opacity-60 text-sm">Unknown</span>
        </div>
      </div>
    </div>

    <!-- validators panel -->
    <div class="bg-base-100 border border-base-300 rounded-lg shadow overflow-hidden">
      <div class="px-4 py-3 bg-base-200 border-b border-base-300">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-sm font-bold flex flex-wrap items-center gap-4">
            <span>Validators</span>
            <span class="flex items-center gap-1.5 text-xs font-medium">
              <span class="w-2 h-2 rounded-full bg-success"></span>
              <span class="text-success">Online: {{ onlineCount }}</span>
            </span>
            <span class="flex items-center gap-1.5 text-xs font-medium">
              <span class="w-2 h-2 rounded-full bg-error"></span>
              <span class="text-error">Offline: {{ offlineCount }}</span>
            </span>
            <span class="text-xs font-medium opacity-80">Total: {{ rows.length }}</span>
          </h3>

          <div class="flex flex-wrap items-center gap-3">
            <div class="flex items-center gap-1.5">
              <span class="text-xs opacity-70">Show:</span>
              <select v-model="showFilter" class="select select-bordered select-xs w-auto min-h-0 h-7 text-xs">
                <option value="all">All</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
              </select>
            </div>

            <input
              v-model="searchText"
              type="text"
              placeholder="Filter validators..."
              class="input input-bordered input-xs w-56 h-7 min-h-0 text-xs"
            />

            <button
              class="btn btn-ghost btn-xs h-7 min-h-0 px-2 text-success hover:bg-success/10"
              title="Export to CSV"
              :disabled="rows.length === 0"
              @click="exportCsv"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path
                  d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm1.8 18H14l-2-3.4-2 3.4H8.2l2.9-4.5L8.2 11H10l2 3.4 2-3.4h1.8l-2.9 4.5 2.9 4.5zM13 9V3.5L18.5 9H13z"
                />
              </svg>
            </button>

            <span class="text-xs flex items-center gap-1.5" :class="httpstatus === 200 ? 'text-success' : 'text-error'">
              <span class="w-2 h-2 rounded-full animate-pulse" :class="httpstatus === 200 ? 'bg-success' : 'bg-error'"></span>
              {{ httpstatus === 200 ? 'Live' : 'Offline' }}
            </span>

            <div class="flex items-center gap-1.5">
              <span class="text-xs opacity-70">RPC:</span>
              <select v-model="rpc" class="select select-bordered select-xs w-auto max-w-[220px] min-h-0 h-7 text-xs" @change="onChange">
                <option v-for="(item, index) in rpcList" :key="index" :value="(item?.address || '').replace(/\/$/, '') + '/consensus_state'">
                  {{ item?.provider || item?.address }}
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="p-3">
        <div v-if="rows.length === 0" class="text-center text-sm py-8">
          <span v-if="httpstatus === 200" class="opacity-60">Waiting for consensus data...</span>
          <span v-else-if="httpstatus === 0" class="opacity-70">{{ httpStatusText || 'Loading...' }}</span>
          <span v-else class="text-error">RPC error {{ httpstatus }}: {{ httpStatusText }}</span>
        </div>

        <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-x-2 gap-y-0">
          <!-- column A -->
          <div>
            <div class="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold opacity-70">
              <span class="w-5 text-right">#</span><span class="w-2"></span><span class="w-5"></span>
              <span class="flex-1">Validator</span>
              <span class="w-14 text-right">VP%</span>
              <span class="w-14 text-center">Prevote</span>
              <span class="w-14 text-center">Precommit</span>
            </div>
            <div
              v-for="r in colA"
              :key="r.address"
              class="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs transition-colors hover:bg-base-200"
              :class="{ 'opacity-45': !r.online, 'ring-1 ring-warning/60': r.isProposer }"
            >
              <span class="w-5 text-right shrink-0 opacity-60">{{ r.rank }}</span>
              <span class="w-2 h-2 rounded-full shrink-0" :class="r.online ? 'bg-success' : 'bg-error'"></span>
              <div class="w-5 h-5 shrink-0 rounded-full overflow-hidden bg-base-300 flex items-center justify-center">
                <img v-if="logo(r.identity)" v-lazy="logo(r.identity)" class="w-full h-full object-cover" alt="" />
                <span v-else class="text-[9px] font-bold">{{ r.moniker.slice(0, 1) }}</span>
              </div>
              <span class="truncate flex-1 min-w-0 font-medium" :title="r.moniker">{{ r.moniker }}</span>
              <span v-if="r.isProposer" class="badge badge-warning badge-xs shrink-0">P</span>
              <span class="w-14 text-right shrink-0 font-mono">{{ r.vpPercent.toFixed(1) }}%</span>
              <span class="w-14 text-center shrink-0">
                <span v-if="isSigned(r.prevote)" class="text-success font-bold">✓</span>
                <span v-else class="opacity-40">nil</span>
              </span>
              <span class="w-14 text-center shrink-0">
                <span v-if="isSigned(r.precommit)" class="text-success font-bold">✓</span>
                <span v-else class="opacity-40">nil</span>
              </span>
            </div>
          </div>

          <!-- column B -->
          <div>
            <div class="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold opacity-70">
              <span class="w-5 text-right">#</span><span class="w-2"></span><span class="w-5"></span>
              <span class="flex-1">Validator</span>
              <span class="w-14 text-right">VP%</span>
              <span class="w-14 text-center">Prevote</span>
              <span class="w-14 text-center">Precommit</span>
            </div>
            <div
              v-for="r in colB"
              :key="r.address"
              class="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs transition-colors hover:bg-base-200"
              :class="{ 'opacity-45': !r.online, 'ring-1 ring-warning/60': r.isProposer }"
            >
              <span class="w-5 text-right shrink-0 opacity-60">{{ r.rank }}</span>
              <span class="w-2 h-2 rounded-full shrink-0" :class="r.online ? 'bg-success' : 'bg-error'"></span>
              <div class="w-5 h-5 shrink-0 rounded-full overflow-hidden bg-base-300 flex items-center justify-center">
                <img v-if="logo(r.identity)" v-lazy="logo(r.identity)" class="w-full h-full object-cover" alt="" />
                <span v-else class="text-[9px] font-bold">{{ r.moniker.slice(0, 1) }}</span>
              </div>
              <span class="truncate flex-1 min-w-0 font-medium" :title="r.moniker">{{ r.moniker }}</span>
              <span v-if="r.isProposer" class="badge badge-warning badge-xs shrink-0">P</span>
              <span class="w-14 text-right shrink-0 font-mono">{{ r.vpPercent.toFixed(1) }}%</span>
              <span class="w-14 text-center shrink-0">
                <span v-if="isSigned(r.prevote)" class="text-success font-bold">✓</span>
                <span v-else class="opacity-40">nil</span>
              </span>
              <span class="w-14 text-center shrink-0">
                <span v-if="isSigned(r.precommit)" class="text-success font-bold">✓</span>
                <span v-else class="opacity-40">nil</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- tips -->
    <div class="text-[#00cfe8] bg-[rgba(0,207,232,0.12)] rounded-lg shadow alert-info">
      <div class="drop-shadow-md px-4 pt-2 pb-2" style="box-shadow: rgba(0, 207, 232, 0.4) 0px 6px 15px -7px">
        <h2 class="text-base font-semibold">{{ $t('consensus.tips') }}</h2>
      </div>
      <div class="px-4 py-4">
        <ul style="list-style-type: disc" class="pl-8">
          <li>{{ $t('consensus.tips_description_1') }}</li>
          <li>{{ $t('consensus.tips_description_2') }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'consensus',
    }
  }
</route>
