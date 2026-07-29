<script lang="ts" setup>
import fetch from 'cross-fetch';
import { onMounted, ref, computed, onUnmounted, watch } from 'vue';
import { useBlockchain, useStakingStore, useBaseStore } from '@/stores';
import { consensusPubkeyToHexAddress } from '@/libs';
import { gnoMoniker } from '@/libs/gno/valopers';

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

function baseOf(addr?: string) {
  return String(addr || '').replace(/\/+$/, '');
}

const activeRpcLabel = computed(() => {
  if (!rpc.value) return '';
  const hit = rpcList.value.find((x) => baseOf(x.address) === rpc.value);
  return hit?.provider || rpc.value.replace(/^https?:\/\//, '');
});

function pickRpcList() {
  const list = (chainStore.current?.endpoints?.rpc || []).filter((x) => x?.address);
  // Prefer Shazoes RPC first (CORS + consensus endpoints allowed)
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
    const hit = rpcList.value.find(
      (x) => baseOf(x.address) === baseOf(preferAddress) || baseOf(preferAddress).startsWith(baseOf(x.address))
    );
    if (hit) {
      rpc.value = baseOf(hit.address);
      return true;
    }
  }
  rpc.value = baseOf(rpcList.value[0].address);
  return true;
}

async function startMonitor() {
  if (started || loading) return;
  started = true;
  loading = true;
  try {
    try {
      validatorsData.value = await stakingStore.fetchAcitveValdiators();
      loadAvatars();
    } catch (e) {
      console.warn('validators load failed', e);
    }

    rpcList.value = pickRpcList();
    if (rpcList.value.length === 0) {
      httpstatus.value = 0;
      httpStatusText.value = 'No RPC endpoint configured for this chain';
      return;
    }
    // Try each RPC until one supports both /validators and /consensus_state
    let ok = false;
    for (const ep of rpcList.value) {
      rpc.value = baseOf(ep.address);
      await fetchPosition();
      if (httpstatus.value === 200 && positions.value.length > 0) {
        await update();
        if (httpstatus.value === 200) {
          ok = true;
          break;
        }
      }
    }
    if (ok) {
      clearTime();
      timer = setInterval(() => update(), Math.max(1000, Math.round(baseStore.blocktime / 2) || 3000));
    } else {
      if (httpstatus.value === 200) httpstatus.value = 503;
      if (!httpStatusText.value) {
        httpStatusText.value = 'No configured RPC supports consensus endpoints (/validators, /consensus_state)';
      }
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

const vals = computed(() =>
  validatorsData.value.map((x: any) => {
    const x2 = { ...x };
    // Cosmos: hex from ed25519 pubkey. Gno/TM2: operator IS the cons bech32 —
    // consensus `/validators` returns that same bech32, so keep it as `hex` key
    // for matching (row address comparison is case-insensitive).
    const op = String(x.operator_address || '');
    if (op.startsWith('g') && op.length > 10) {
      x2.hex = op;
    } else {
      // @ts-ignore
      x2.hex = consensusPubkeyToHexAddress(x.consensus_pubkey);
    }
    return x2;
  })
);

// ---- helpers ----
function parseBitArrayRate(s?: string): number {
  if (!s) return 0;
  const raw = String(s).trim();
  // TM2 synthetic: "87/89" → ratio. Cosmos trailing float: "... 0.97".
  const frac = raw.match(/^(\d+)\s*\/\s*(\d+)\s*$/);
  if (frac) {
    const den = Number(frac[2]);
    return den > 0 ? Number(frac[1]) / den : 0;
  }
  const m = raw.match(/([0-9]*\.?[0-9]+)\s*$/);
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
  // Gno TM2: proposer.address is bech32; Cosmos: often hex. Compare case-insensitively raw.
  const proposerAddr = String(roundState.value?.proposer?.address || '');
  const built = positions.value.map((p: any, i: number) => {
    const addr = String(p.address || '');
    const addrU = addr.toUpperCase();
    const val = vals.value.find((x: any) => {
      const h = String(x.hex || '');
      return h === addr || h.toUpperCase() === addrU || String(x.operator_address || '') === addr;
    });
    const prevote = vs?.prevotes?.[i];
    const precommit = vs?.precommits?.[i];
    return {
      consensusIndex: i,
      rank: 0,
      address: addr,
      moniker: val?.description?.moniker || gnoMoniker(addr) || addr.slice(0, 14),
      identity: val?.description?.identity || '',
      votingPower: Number(p.voting_power || 0),
      vpPercent: totalVP > 0 ? (Number(p.voting_power || 0) / totalVP) * 100 : 0,
      prevote,
      precommit,
      online: isSigned(prevote),
      isProposer:
        proposerAddr !== '' &&
        (proposerAddr === addr || proposerAddr.toUpperCase() === addrU),
    };
  });
  const sorted = [...built].sort((a, b) => b.votingPower - a.votingPower);
  sorted.forEach((r, idx) => {
    r.rank = idx + 1;
  });
  return sorted;
});

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

// ---- actions ----
async function refetch() {
  if (loading) return;
  loading = true;
  httpstatus.value = 200;
  httpStatusText.value = '';
  roundState.value = {};
  positions.value = [];
  clearTime();
  try {
    await fetchPosition();
    if (httpstatus.value === 200 && positions.value.length > 0) {
      await update();
      if (httpstatus.value === 200) {
        timer = setInterval(() => update(), Math.max(1000, Math.round(baseStore.blocktime / 2) || 3000));
      }
    }
  } finally {
    loading = false;
  }
}
async function fetchPosition() {
  if (!rpc.value) {
    httpstatus.value = 0;
    httpStatusText.value = 'No RPC selected';
    positions.value = [];
    return;
  }
  const base = rpc.value;
  try {
    const all: any[] = [];
    let page = 1;
    let total = 0;
    do {
      const res = await fetch(`${base}/validators?per_page=100&page=${page}`);
      if (!res.ok) {
        httpstatus.value = res.status;
        httpStatusText.value = res.statusText || `HTTP ${res.status}`;
        positions.value = [];
        return;
      }
      const data = await res.json();
      const vals = data?.result?.validators || [];
      total = Number(data?.result?.total ?? vals.length);
      all.push(...vals);
      page++;
    } while (all.length < total && page <= 10);
    positions.value = all;
    if (all.length === 0) {
      httpstatus.value = 204;
      httpStatusText.value = '/validators returned empty set';
    } else {
      httpstatus.value = 200;
      httpStatusText.value = 'OK';
    }
  } catch (error: any) {
    httpstatus.value = error?.status || 500;
    httpStatusText.value = error?.message || String(error) || 'Error fetching /validators';
    positions.value = [];
  }
}
/**
 * Build a Cosmos-shaped height_vote_set entry from TM2 data.
 * Gnoland's `/consensus_state` returns `height_vote_set: {}` (empty object)
 * and `/dump_consensus_state` has empty `votes` — live vote bits aren't
 * exposed. We synthesize online/offline from the latest committed block's
 * precommits so the monitor still shows real signer coverage.
 */
async function synthesizeTm2RoundState(base: string) {
  let hrs = '';
  let proposer: any = null;
  // Prefer dump for height/round/step + proposer
  try {
    const dumpRes = await fetch(`${base}/dump_consensus_state`);
    if (dumpRes.ok) {
      const dump = await dumpRes.json();
      const drs = dump?.result?.round_state || {};
      if (drs.height != null) {
        hrs = `${drs.height}/${drs.round ?? 0}/${drs.step ?? 0}`;
      }
      proposer = drs?.validators?.proposer || drs?.proposer || null;
    }
  } catch {
    /* fall through */
  }
  // Fallback hrs from /status
  if (!hrs) {
    try {
      const st = await fetch(`${base}/status`);
      if (st.ok) {
        const s = await st.json();
        const h = s?.result?.sync_info?.latest_block_height;
        if (h) hrs = `${h}/0/0`;
      }
    } catch {
      /* ignore */
    }
  }
  // Latest block precommits → synthetic prevotes/precommits arrays aligned to positions[]
  const prevotes: string[] = [];
  const precommits: string[] = [];
  const signed = new Set<string>();
  try {
    const br = await fetch(`${base}/block`);
    if (br.ok) {
      const bj = await br.json();
      const block = bj?.result?.block || {};
      const pcs = block?.last_commit?.precommits || block?.last_commit?.signatures || [];
      for (const pc of pcs) {
        if (!pc) continue;
        const addr = String(pc.validator_address || '');
        const hasSig = !!(pc.signature || pc.block_id?.hash);
        if (addr && hasSig) signed.add(addr);
      }
      // If hrs still empty, take from block header
      if (!hrs && block?.header?.height) {
        hrs = `${block.header.height}/0/2`;
      }
      if (!proposer && block?.header?.proposer_address) {
        proposer = { address: block.header.proposer_address };
      }
    }
  } catch {
    /* ignore */
  }
  for (const p of positions.value) {
    const addr = String(p.address || '');
    const ok = signed.has(addr);
    // Non-nil string → isSigned() true; 'nil-Vote' → false
    prevotes.push(ok ? 'TM2-COMMIT' : 'nil-Vote');
    precommits.push(ok ? 'TM2-COMMIT' : 'nil-Vote');
  }
  const bit = `${signed.size}/${Math.max(positions.value.length, 1)}`;
  return {
    'height/round/step': hrs,
    proposer,
    height_vote_set: [
      {
        round: 0,
        prevotes,
        precommits,
        prevotes_bit_array: bit,
        precommits_bit_array: bit,
      },
    ],
  };
}

async function update() {
  if (!rpc.value) return;
  try {
    const data = await fetch(`${rpc.value}/consensus_state`);
    httpstatus.value = data.status;
    httpStatusText.value = data.statusText;
    if (!data.ok) {
      await fallbackRpc();
      return;
    }
    const res = await data.json();
    let rs = res?.result?.round_state || {};
    // TM2: height_vote_set is {} (object) not an array — synthesize from dump+block.
    const hvs = rs.height_vote_set;
    const hvsEmpty =
      !hvs ||
      (Array.isArray(hvs) && hvs.length === 0) ||
      (!Array.isArray(hvs) && typeof hvs === 'object' && Object.keys(hvs).length === 0);
    if (hvsEmpty) {
      rs = await synthesizeTm2RoundState(rpc.value);
    }
    roundState.value = rs;
    const raw = String(roundState.value?.['height/round/step'] || '').split('/');
    height.value = raw[0] || '';
    round.value = raw[1] || '0';
    step.value = raw[2] || '';
  } catch (err: any) {
    httpstatus.value = 500;
    httpStatusText.value = err?.message || String(err);
    await fallbackRpc();
  }
}

// Auto-fallback: if the active RPC dies mid-session, walk the list to a healthy one.
let fallbackCooldown = 0;
async function fallbackRpc() {
  const now = Date.now();
  if (now - fallbackCooldown < 10000) return;
  fallbackCooldown = now;
  if (!rpcList.value || rpcList.value.length <= 1) return;
  const current = rpc.value;
  const candidates = rpcList.value.filter((x) => baseOf(x.address) !== current);
  for (const ep of candidates) {
    const candidate = baseOf(ep.address);
    try {
      const probe = await fetch(`${candidate}/consensus_state`);
      if (probe.ok) {
        rpc.value = candidate;
        httpstatus.value = 200;
        httpStatusText.value = 'Switched to fallback RPC';
        await update();
        return;
      }
    } catch {
      // try next
    }
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
    <!-- ===== CONSENSUS ENGINE — live hero panel ===== -->
    <section class="consensus-hero relative overflow-hidden rounded-xl">
      <div class="relative z-10 px-5 py-5 sm:px-7 sm:py-6">
        <!-- top row: label + live status -->
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5">
            <span class="hero-dot" :class="httpstatus === 200 ? 'hero-dot--live' : 'hero-dot--off'"></span>
            <span class="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">
              Consensus Monitor
            </span>
            <span v-if="round !== ''" class="hidden sm:inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
              Round {{ round }}
            </span>
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-[11px] font-semibold" :class="httpstatus === 200 ? 'text-emerald-400' : 'text-rose-400'">
              {{ httpstatus === 200 ? 'LIVE' : 'OFFLINE' }}
            </span>
            <span
              v-if="activeRpcLabel"
              class="hidden sm:inline-flex max-w-[220px] truncate rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-mono text-slate-400"
              :title="rpc"
            >
              {{ activeRpcLabel }}
            </span>
          </div>
        </div>

        <!-- height + vote progress -->
        <div class="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,auto)_1fr] lg:items-center">
          <!-- block height -->
          <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Block Height</div>
            <div class="hero-height mt-1">
              {{ height ? Number(height).toLocaleString() : '—' }}
            </div>
            <div class="mt-1.5 flex items-center gap-3 text-[11px] text-slate-400">
              <span>Step <b class="font-mono text-slate-200">{{ step || '—' }}</b>/4</span>
              <span class="hidden sm:inline text-slate-600">·</span>
              <span class="hidden sm:inline">Proposing now</span>
            </div>
          </div>

          <!-- vote progress bars -->
          <div class="space-y-4">
            <div>
              <div class="mb-1.5 flex items-baseline justify-between">
                <span class="text-[11px] font-bold uppercase tracking-[0.16em] text-sky-300">Prevotes</span>
                <span class="font-mono text-xs text-slate-300">
                  <b class="text-sky-300">{{ prevoteSigned }}</b>/{{ rows.length || '—' }}
                  <span class="ml-2 text-slate-400">{{ prevoteRate }}%</span>
                </span>
              </div>
              <div class="vote-track">
                <div class="vote-fill vote-fill--prevote" :style="{ width: prevoteRate + '%' }"></div>
              </div>
            </div>
            <div>
              <div class="mb-1.5 flex items-baseline justify-between">
                <span class="text-[11px] font-bold uppercase tracking-[0.16em] text-violet-300">Precommits</span>
                <span class="font-mono text-xs text-slate-300">
                  <b class="text-violet-300">{{ precommitSigned }}</b>/{{ rows.length || '—' }}
                  <span class="ml-2 text-slate-400">{{ precommitRate }}%</span>
                </span>
              </div>
              <div class="vote-track">
                <div class="vote-fill vote-fill--precommit" :style="{ width: precommitRate + '%' }"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- stats strip -->
        <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-slate-800 pt-4 text-xs">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span class="text-slate-400">Online VP</span>
            <b class="font-mono text-emerald-300">{{ onlineVP.toFixed(1) }}%</b>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-rose-400"></span>
            <span class="text-slate-400">Offline VP</span>
            <b class="font-mono text-rose-300">{{ offlineVP.toFixed(1) }}%</b>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-slate-400">Validators</span>
            <b class="font-mono text-slate-200">{{ rows.length }}</b>
          </div>
          <div class="ml-auto flex items-center gap-2.5">
            <span class="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-300">Proposer</span>
            <div class="flex items-center gap-2">
              <div class="h-6 w-6 overflow-hidden rounded-full bg-slate-700 ring-1 ring-amber-400/50 flex items-center justify-center">
                <img v-if="proposerRow && logo(proposerRow.identity)" v-lazy="logo(proposerRow.identity)" class="h-full w-full object-cover" alt="" />
                <span v-else class="text-[10px] font-bold text-slate-200">{{ proposerRow ? proposerRow.moniker.slice(0, 1) : '?' }}</span>
              </div>
              <b class="max-w-[160px] truncate text-slate-100" :title="proposerRow?.moniker">
                {{ proposerRow ? proposerRow.moniker : 'Unknown' }}
              </b>
            </div>
          </div>
        </div>
      </div>
      <!-- ambient layers -->
      <div class="hero-glow" aria-hidden="true"></div>
      <div class="hero-grid" aria-hidden="true"></div>
    </section>

    <!-- ===== VALIDATOR SET ===== -->
    <section class="overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <!-- toolbar -->
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 bg-base-200/60 px-4 py-3">
        <h3 class="flex items-center gap-2 text-sm font-bold">
          Validator Set
          <span class="rounded-full bg-base-300/70 px-2 py-0.5 font-mono text-[11px] font-semibold">{{ filteredRows.length }}</span>
        </h3>
        <div class="flex flex-wrap items-center gap-2.5">
          <div class="flex rounded-lg border border-base-300 bg-base-100 p-0.5">
            <button
              v-for="opt in (['all', 'online', 'offline'] as const)"
              :key="opt"
              class="seg-btn"
              :class="{ 'seg-btn--active': showFilter === opt }"
              @click="showFilter = opt"
            >
              {{ opt === 'all' ? 'All' : opt === 'online' ? 'Online' : 'Offline' }}
            </button>
          </div>
          <input
            v-model="searchText"
            type="text"
            placeholder="Search validator..."
            class="input input-bordered input-xs h-7 w-44 min-h-0 text-xs"
          />
          <button
            class="btn btn-ghost btn-xs h-7 min-h-0 gap-1 px-2 text-xs"
            title="Export CSV"
            :disabled="rows.length === 0"
            @click="exportCsv"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            CSV
          </button>
        </div>
      </div>

      <!-- empty state -->
      <div v-if="rows.length === 0" class="px-4 py-12 text-center text-sm">
        <span v-if="httpstatus === 200" class="opacity-60">Waiting for consensus data...</span>
        <span v-else-if="httpstatus === 0" class="opacity-70">{{ httpStatusText || 'Loading...' }}</span>
        <span v-else class="text-error">RPC error {{ httpstatus }}: {{ httpStatusText }}</span>
      </div>

      <!-- table -->
      <div v-else class="overflow-x-auto">
        <table class="consensus-table w-full text-sm">
          <thead>
            <tr>
              <th class="w-12">#</th>
              <th>Validator</th>
              <th class="text-right">Voting Power</th>
              <th class="text-center">Prevote</th>
              <th class="text-center">Precommit</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in filteredRows"
              :key="r.address"
              :class="{ 'row-proposer': r.isProposer, 'row-offline': !r.online }"
            >
              <td class="font-mono text-xs opacity-60">{{ r.rank }}</td>
              <td>
                <div class="flex items-center gap-2.5">
                  <span class="status-dot" :class="r.online ? 'status-dot--on' : 'status-dot--off'"></span>
                  <div class="h-6 w-6 shrink-0 overflow-hidden rounded-full bg-base-300 flex items-center justify-center">
                    <img v-if="logo(r.identity)" v-lazy="logo(r.identity)" class="h-full w-full object-cover" alt="" />
                    <span v-else class="text-[10px] font-bold">{{ r.moniker.slice(0, 1) }}</span>
                  </div>
                  <span class="truncate font-medium" :title="r.moniker">{{ r.moniker }}</span>
                  <span v-if="r.isProposer" class="badge badge-warning badge-xs shrink-0 font-bold">P</span>
                </div>
              </td>
              <td class="text-right">
                <div class="flex items-center justify-end gap-2">
                  <div class="vp-track hidden sm:block">
                    <div class="vp-fill" :style="{ width: Math.min(100, r.vpPercent) + '%' }"></div>
                  </div>
                  <span class="font-mono text-xs">{{ r.vpPercent.toFixed(1) }}%</span>
                </div>
              </td>
              <td class="text-center">
                <span v-if="isSigned(r.prevote)" class="vote-chip vote-chip--yes">✓</span>
                <span v-else class="vote-chip vote-chip--no">nil</span>
              </td>
              <td class="text-center">
                <span v-if="isSigned(r.precommit)" class="vote-chip vote-chip--yes">✓</span>
                <span v-else class="vote-chip vote-chip--no">nil</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- tips -->
    <details class="rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <summary class="cursor-pointer select-none px-4 py-3 text-sm font-semibold opacity-80 hover:opacity-100">
        {{ $t('consensus.tips') }}
      </summary>
      <div class="border-t border-base-300 px-5 py-4 text-sm opacity-80">
        <ul class="list-disc space-y-1 pl-5">
          <li>{{ $t('consensus.tips_description_1') }}</li>
          <li>{{ $t('consensus.tips_description_2') }}</li>
        </ul>
      </div>
    </details>
  </div>
</template>

<style scoped>
/* ---- consensus hero (dark engine panel, works in both themes) ---- */
.consensus-hero {
  background: linear-gradient(160deg, #0b1120 0%, #0e1730 55%, #131a3a 100%);
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: 0 8px 30px -12px rgba(2, 6, 23, 0.55);
}
.hero-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(520px 200px at 12% 0%, rgba(56, 132, 255, 0.16), transparent 70%),
    radial-gradient(460px 200px at 88% 100%, rgba(139, 92, 246, 0.14), transparent 70%);
}
.hero-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.05;
  background-image: linear-gradient(rgba(148, 163, 184, 0.5) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.5) 1px, transparent 1px);
  background-size: 34px 34px;
  mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.9), transparent 85%);
}
.hero-height {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: clamp(2rem, 4.5vw, 3rem);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.05;
  color: #f1f5f9;
  font-variant-numeric: tabular-nums;
}
.hero-dot {
  width: 9px;
  height: 9px;
  border-radius: 9999px;
  flex-shrink: 0;
}
.hero-dot--live {
  background: #34d399;
  box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.6);
  animation: pulse-ring 1.8s ease-out infinite;
}
.hero-dot--off {
  background: #fb7185;
}
@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55); }
  70% { box-shadow: 0 0 0 8px rgba(52, 211, 153, 0); }
  100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
}

/* ---- vote progress bars ---- */
.vote-track {
  height: 8px;
  border-radius: 9999px;
  background: rgba(148, 163, 184, 0.16);
  overflow: hidden;
}
.vote-fill {
  height: 100%;
  border-radius: 9999px;
  transition: width 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}
.vote-fill--prevote {
  background: linear-gradient(90deg, #0ea5e9, #38bdf8);
}
.vote-fill--precommit {
  background: linear-gradient(90deg, #7c3aed, #a78bfa);
}

/* ---- segmented filter ---- */
.seg-btn {
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  color: inherit;
  opacity: 0.65;
  transition: all 0.15s ease;
}
.seg-btn:hover { opacity: 1; }
.seg-btn--active {
  background: hsl(var(--p));
  color: hsl(var(--pc));
  opacity: 1;
}

/* ---- table ---- */
.consensus-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: hsl(var(--b2));
  padding: 10px 14px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  opacity: 0.7;
  border-bottom: 1px solid hsl(var(--b3));
}
.consensus-table tbody td {
  padding: 8px 14px;
  border-bottom: 1px solid hsl(var(--b2));
}
.consensus-table tbody tr {
  transition: background-color 0.15s ease;
}
.consensus-table tbody tr:hover {
  background: hsl(var(--b2));
}
.row-offline { opacity: 0.45; }
.row-proposer {
  box-shadow: inset 3px 0 0 0 hsl(var(--wa));
}

/* ---- status dot ---- */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  flex-shrink: 0;
}
.status-dot--on { background: hsl(var(--su)); }
.status-dot--off { background: hsl(var(--er)); }

/* ---- voting power mini bar ---- */
.vp-track {
  width: 56px;
  height: 4px;
  border-radius: 9999px;
  background: hsl(var(--b3));
  overflow: hidden;
}
.vp-fill {
  height: 100%;
  border-radius: 9999px;
  background: hsl(var(--p));
}

/* ---- vote chips ---- */
.vote-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 700;
}
.vote-chip--yes {
  background: color-mix(in srgb, hsl(var(--su)) 16%, transparent);
  color: hsl(var(--su));
}
.vote-chip--no {
  background: hsl(var(--b2));
  color: hsl(var(--bc));
  opacity: 0.45;
  font-weight: 500;
}
</style>

<route>
  {
    meta: {
      i18n: 'consensus',
    }
  }
</route>
