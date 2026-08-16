<script lang="ts" setup>
import fetch from 'cross-fetch';
import { getLocalJson } from '@/libs/utils';
import { onMounted, ref, computed, onUnmounted, watch } from 'vue';
import { useBlockchain, useStakingStore, useBaseStore } from '@/stores';
import { consensusPubkeyToHexAddress } from '@/libs';
import { gnoMoniker, lookupGnoValoper } from '@/libs/gno/valopers';
import {
  rankRpcs,
  pickTipPeers,
  mergeEndpointLists,
  type RpcQuality,
} from '@/libs/rpc-quality';
import { fetchGnoUptimeSnapshot, type GnoUptimeValidator } from '@/libs/gno/uptime';

const chainStore = useBlockchain();
const stakingStore = useStakingStore();
const baseStore = useBaseStore();

/** Gno/TM2: uptime.json is the source-of-truth for ACTIVE/INACTIVE status. */
const isGno = computed(() => chainStore.current?.engine === 'gno' || chainStore.current?.engine === 'tm2');
/** Map: signingAddress → GnoUptimeValidator (from uptime.json cron snapshot). */
const gnoUptimeMap = ref<Map<string, GnoUptimeValidator>>(new Map());
const uptimeUrl = computed(() => (chainStore.current as any)?.uptime_live_url || 'https://data.shazoes.xyz/gno/testnet/sapphire-1/uptime.json');

const rpcList = ref<{ address: string; provider?: string }[]>([]);
const rpc = ref('');
const validators = ref(stakingStore.validators);

const httpstatus = ref(200);
const httpStatusText = ref('');
const roundState = ref({} as any);
const height = ref('');
const round = ref('');
const step = ref('');
const tm2Synthetic = ref(false);
/** Validators that signed the last committed block (from /block last_commit).
 *  Used to cross-reference online/offline status — dump_consensus_state may
 *  show nil votes for validators that ARE actually signing (e.g. POSTHUMAN on
 *  AtomOne). This set is populated by fetchLastCommitSigners() and checked
 *  in the `online` field of rows. */
const lastCommitSigners = ref(new Set<string>());
let timer: any = null;
let loading = false;
let started = false;
/** Supersede concurrent startMonitor runs (endpoint swap / SPA remount). */
let monitorGen = 0;
/** Persist last known vote hash + signed status per validator so it doesn't vanish during step 1 (NewHeight). */
const lastValidatorHashes: Record<string, { prevoteHash?: string; precommitHash?: string; prevoteSigned?: boolean; precommitSigned?: boolean }> = {};
/** Active validator set — derived from roundState.value.validators.validators
 *  to guarantee index alignment with votes[].prevotes/precommits arrays.
 *  Falls back to /validators endpoint (committed set) if dump_consensus_state unavailable. */
const validatorsFallback = ref([] as any[]);
const positions = computed(() => {
  const rsVals = roundState.value?.validators?.validators;
  if (Array.isArray(rsVals) && rsVals.length > 0) return rsVals;
  return validatorsFallback.value;
});
const validatorsData = ref([] as any);

// ---- UI state (NodesHub-style) ----
const searchText = ref('');
const showFilter = ref<'all' | 'online' | 'offline'>('all');

// ---- avatars (keybase, cached in localStorage) ----
const avatars = ref<Record<string, string>>(getLocalJson('avatars', {}));
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
  // Config order only — quality ranking is shared via rankRpcs / pickTipPeers.
  return (chainStore.current?.endpoints?.rpc || []).filter((x) => x?.address);
}

/** rpc[] + rest/api[] + active client — same pool philosophy as store rank. */
function consensusCandidateList() {
  return mergeEndpointLists(
    chainStore.current?.endpoints?.rpc,
    chainStore.current?.endpoints?.rest,
    chainStore.endpoint?.address
      ? [{ address: chainStore.endpoint.address, provider: 'active' }]
      : []
  );
}

function setRpcFromList(preferAddress?: string) {
  rpcList.value = consensusCandidateList();
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
  // Allow re-entry if a previous attempt is still loading (endpoint swap / SPA remount).
  // Generation token supersedes the older run so we never permanently lock `loading`.
  const gen = ++monitorGen;
  started = true;
  loading = true;
  try {
    try {
      validatorsData.value = await stakingStore.fetchAcitveValdiators();
      if (gen !== monitorGen) return;
      loadAvatars();
    } catch (e) {
      console.warn('validators load failed', e);
    }

    const candidates = consensusCandidateList();
    rpcList.value = candidates;
    if (candidates.length === 0) {
      httpstatus.value = 0;
      httpStatusText.value = 'No RPC endpoint configured for this chain';
      started = false; // allow retry when endpoints land
      return;
    }

    // Consensus is a live monitor: try the configured active RPC immediately.
    // Do not make the first paint wait for archive/public RPC quality probes.
    const active = chainStore.endpoint?.address
      ? candidates.find((x) => baseOf(x.address) === baseOf(chainStore.endpoint.address))
      : undefined;
    if (active) {
      rpc.value = baseOf(active.address);
      await fetchPosition();
      if (gen !== monitorGen) return;
      if (httpstatus.value === 200 && positions.value.length > 0) {
        await update();
        if (gen !== monitorGen) return;
        if (httpstatus.value === 200) {
          console.info(`[consensus] active RPC ${rpc.value} h=${height.value} vals=${positions.value.length}`);
          loading = false;
          timer = setInterval(() => update(), 500);
          return;
        }
      }
    }

    // Fallback only after active RPC failed: quality-rank the remaining peers.
    const engine = chainStore.current?.engine;
    const ranked: RpcQuality[] = await rankRpcs(candidates, { engine, timeoutMs: 4500 });
    if (gen !== monitorGen) return;
    rpcList.value = ranked.map((r) => ({ address: r.address, provider: r.provider }));

    const tryOrder = pickTipPeers(ranked);
    const healthy = ranked.filter((r) => r.ok);
    const order = tryOrder.length ? tryOrder : healthy;

    let ok = false;
    for (const ep of order) {
      if (gen !== monitorGen) return;
      rpc.value = ep.address;
      await fetchPosition();
      if (gen !== monitorGen) return;
      // Require a non-trivial set when peers advertise many vals (avoid 2-of-89)
      const minVals = order[0]?.valCount >= 10 ? Math.max(3, Math.floor(order[0].valCount * 0.5)) : 1;
      if (httpstatus.value === 200 && positions.value.length >= minVals) {
        await update();
        if (gen !== monitorGen) return;
        if (httpstatus.value === 200) {
          ok = true;
          console.info(
            `[consensus] RPC ${ep.address} h=${ep.height} vals=${positions.value.length}` +
              (ep.provider ? ` (${ep.provider})` : '')
          );
          break;
        }
      }
    }
    // Last resort: any ranked peer that at least returns validators (better than blank)
    if (!ok) {
      for (const ep of ranked) {
        if (gen !== monitorGen) return;
        rpc.value = ep.address;
        await fetchPosition();
        if (gen !== monitorGen) return;
        if (httpstatus.value === 200 && positions.value.length > 0) {
          await update();
          if (gen !== monitorGen) return;
          if (httpstatus.value === 200) {
            ok = true;
            console.warn(
              `[consensus] degraded RPC ${ep.address} h=${ep.height} vals=${positions.value.length} catching=${ep.catchingUp}`
            );
            break;
          }
        }
      }
    }
    if (ok) {
      clearTime();
      // Poll fast (500ms) — consensus voting phase (step 4-6) is only ~1s in a 1s block.
      // Slower polling catches only step 1 (NewHeight) where all votes are nil.
      timer = setInterval(() => update(), 500);
    } else {
      if (httpstatus.value === 200) httpstatus.value = 503;
      if (!httpStatusText.value) {
        httpStatusText.value = 'No configured RPC supports consensus endpoints (/validators, /consensus_state)';
      }
      started = false; // allow re-try after endpoint swap / later readiness
    }
  } finally {
    if (gen === monitorGen) loading = false;
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

// Re-start monitor when active endpoint changes (RPC fallback) without hard refresh
watch(
  () => chainStore.endpoint?.address,
  async (addr, prev) => {
    if (!addr || addr === prev) return;
    clearTime();
    started = false;
    loading = false; // unlock any stuck in-flight startMonitor
    validatorsFallback.value = [];
    roundState.value = {};
    await startMonitor();
  }
);
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
function isSigned(vote?: any): boolean {
  if (vote === undefined || vote === null) return false;
  return !String(vote).toLowerCase().includes('nil');
}
/** Extract block hash prefix from a vote.
 *  dump_consensus_state votes are strings like:
 *    "Vote{0:8A948A32DC69 9810161/00/SIGNED_MSG_TYPE_PREVOTE(Prevote) 574ABC123DEF ... @ ...}"
 *  nil votes are the string "nil-Vote".
 *  We extract the hash prefix (first 6 hex chars after "Prevote) " or "Precommit) "). */
function voteBlockHash(vote?: any): string {
  if (!vote) return '';
  const s = String(vote);
  if (s.toLowerCase().includes('nil')) return '';
  // dump_consensus_state vote strings:
  //   "Vote{0:8A948A32DC69 9810161/00/SIGNED_MSG_TYPE_PREVOTE(Prevote) 5384C09C597D 000000000000 @ ...}"
  // Northa/consensus extracts: prevote.split("Prevote) ")[1].split(" ")[0][:3]
  const m = s.match(/(?:Prevote\)|Precommit\))\s+([0-9A-Fa-f]{6,})/);
  if (m) return m[1].slice(0, 3).toUpperCase();
  // Object form (consensus_state — rare in modern TM)
  if (typeof vote === 'object') {
    return String(vote?.block_id?.hash || '').slice(0, 3).toUpperCase();
  }
  return '';
}
function shortHash(h: string, len = 8): string {
  if (!h) return '—';
  if (h.length <= len) return h;
  return `${h.slice(0, len)}…`;
}

// ---- current vote set (match round, else best prevote rate) ----
// dump_consensus_state puts live votes in round_state.votes[];
// consensus_state puts them in height_vote_set[] (modern TM: all "nil-Vote").
const currentVoteSet = computed(() => {
  // Prefer dump_consensus_state's `votes` array (has real hash strings)
  const dumpVotes = roundState.value?.votes;
  if (Array.isArray(dumpVotes) && dumpVotes.length > 0) {
    const r = Number(round.value);
    const match = dumpVotes.find((x: any) => Number(x.round) === r);
    if (match) return match;
    return dumpVotes.reduce(
      (best: any, x: any) =>
        parseBitArrayRate(x.prevotes_bit_array) > parseBitArrayRate(best.prevotes_bit_array) ? x : best,
      dumpVotes[0]
    );
  }
  // Fallback: consensus_state height_vote_set (TM2 synthetic, etc.)
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

const prevoteRate = computed(() => rows.value.length > 0 ? ((prevoteSigned.value / rows.value.length) * 100).toFixed(1) : '0.0');
const precommitRate = computed(() => rows.value.length > 0 ? ((precommitSigned.value / rows.value.length) * 100).toFixed(1) : '0.0');

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
  prevoteHash: string;
  precommitHash: string;
  online: boolean;
  isProposer: boolean;
  /** Gno/TM2: status from uptime.json — 'ACTIVE' | 'INACTIVE' | 'PENDING' | undefined */
  gnoStatus?: string;
  /** Gno/TM2: session uptime % since last reactivation (primary metric) */
  gnoSessionUptime?: number | null;
  /** Gno/TM2: window uptime % (sliding 10000, secondary/reference) */
  gnoWindowUptime?: number | null;
  /** Gno/TM2: consecutive missed blocks (for INACTIVE validators) */
  gnoConsecutiveMissed?: number;
  /** Gno/TM2: consecutive signed blocks (for ACTIVE validators) */
  gnoConsecutiveSigned?: number;
  /** Gno/TM2: reason from uptime.json */
  gnoReason?: string;
}
const rows = computed<Row[]>(() => {
  const vs = currentVoteSet.value;
  const totalVP = positions.value.reduce((s: number, p: any) => s + Number(p.voting_power || 0), 0);
  // Gno TM2: proposer.address is bech32; Cosmos: often hex. Compare case-insensitively raw.
  // dump_consensus_state stores proposer at validators.proposer (NOT top-level proposer)
  const proposerAddr = String(
    roundState.value?.validators?.proposer?.address ||
    roundState.value?.proposer?.address || ''
  );
  const built = positions.value.map((p: any, i: number) => {
    const addr = String(p.address || '');
    const addrU = addr.toUpperCase();
    const val = vals.value.find((x: any) => {
      const h = String(x.hex || '');
      return h === addr || h.toUpperCase() === addrU || String(x.operator_address || '') === addr;
    });
    const prevote = vs?.prevotes?.[i];
    const precommit = vs?.precommits?.[i];
    const pvHash = voteBlockHash(prevote);
    const pcHash = voteBlockHash(precommit);
    const pvSigned = isSigned(prevote);
    const pcSigned = isSigned(precommit);
    // Persist last known hash + signed status per validator so it doesn't vanish during step 1 (NewHeight)
    const lastPv = pvHash || lastValidatorHashes[addr]?.prevoteHash || '';
    const lastPc = pcHash || lastValidatorHashes[addr]?.precommitHash || '';
    // Only retain the previous vote while the current endpoint has no vote set.
    // Once a live vote set exists, rows must agree with the aggregate counters.
    const hasLiveVoteSet = !!vs;
    const lastPvSigned = hasLiveVoteSet ? pvSigned : (pvSigned || lastValidatorHashes[addr]?.prevoteSigned || false);
    const lastPcSigned = hasLiveVoteSet ? pcSigned : (pcSigned || lastValidatorHashes[addr]?.precommitSigned || false);
    if (pvHash || pvSigned) lastValidatorHashes[addr] = { ...lastValidatorHashes[addr], prevoteHash: pvHash || lastValidatorHashes[addr]?.prevoteHash, prevoteSigned: pvSigned || lastValidatorHashes[addr]?.prevoteSigned };
    if (pcHash || pcSigned) lastValidatorHashes[addr] = { ...lastValidatorHashes[addr], precommitHash: pcHash || lastValidatorHashes[addr]?.precommitHash, precommitSigned: pcSigned || lastValidatorHashes[addr]?.precommitSigned };
    const gnoUp = gnoUptimeMap.value.get(addr);
    return {
      consensusIndex: i,
      rank: 0,
      address: addr,
      moniker: gnoMoniker(addr, val?.description?.moniker) || addr.slice(0, 14),
      identity: val?.description?.identity || lookupGnoValoper(addr)?.identity || '',
      votingPower: Number(p.voting_power || 0),
      vpPercent: totalVP > 0 ? (Number(p.voting_power || 0) / totalVP) * 100 : 0,
      // Use persisted signed status so ✓ doesn't reset to nil every new height
      prevote: lastPvSigned ? 'TM2-COMMIT' : 'nil-Vote',
      precommit: lastPcSigned ? 'TM2-COMMIT' : 'nil-Vote',
      prevoteHash: lastPv,
      precommitHash: lastPc,
      online: lastPvSigned || (!!lastPv) || lastCommitSigners.value.has(addrU),
      isProposer:
        proposerAddr !== '' &&
        (proposerAddr === addr || proposerAddr.toUpperCase() === addrU),
      gnoStatus: gnoUp?.status,
      gnoSessionUptime: gnoUp?.sessionUptime,
      gnoWindowUptime: gnoUp?.windowUptime ?? gnoUp?.uptime,
      gnoConsecutiveMissed: gnoUp?.consecutiveMissed,
      gnoConsecutiveSigned: gnoUp?.consecutiveSigned,
      gnoReason: gnoUp?.reason,
    };
  });
  // Gno/TM2: filter out PENDING and unregistered validators — only show ACTIVE + INACTIVE
  // (matches validator list page: 78 active + 4 inactive = 82, not 85 from raw RPC)
  const filtered = isGno.value && gnoUptimeMap.value.size > 0
    ? built.filter((r) => r.gnoStatus === 'ACTIVE' || r.gnoStatus === 'INACTIVE')
    : built;
  const sorted = [...filtered].sort((a, b) => {
    const d = b.votingPower - a.votingPower;
    if (d !== 0) return d;
    // Tie-break: moniker alpha (case-insensitive) → address —
    // identical to compareGnoValidators on validator list & uptime page.
    const an = String(a.moniker || a.address || '').trim();
    const bn = String(b.moniker || b.address || '').trim();
    return an.localeCompare(bn, undefined, { sensitivity: 'base' })
      || String(a.address || '').localeCompare(String(b.address || ''));
  });
  sorted.forEach((r, idx) => {
    r.rank = idx + 1;
  });
  return sorted;
});

const onlineVP = computed(() => rows.value.filter((r) => r.online).reduce((s, r) => s + r.vpPercent, 0));
const offlineVP = computed(() => Math.max(0, 100 - onlineVP.value));
const proposerRow = computed(() => rows.value.find((r) => r.isProposer));

const prevoteSigned = computed(() => rows.value.filter((r) => r.prevote && r.prevote !== 'nil-Vote').length);
const precommitSigned = computed(() => rows.value.filter((r) => r.precommit && r.precommit !== 'nil-Vote').length);

/** Color helper for session uptime display */
function sessionUptimeColor(uptime?: number | null): string {
  if (uptime == null) return 'text-slate-400';
  if (uptime >= 99) return 'text-emerald-400';
  if (uptime >= 90) return 'text-sky-400';
  if (uptime >= 50) return 'text-amber-400';
  return 'text-rose-400';
}

/** Detect apphash divergence — different block hashes in the same round */
const voteHashes = computed(() => {
  const vs = currentVoteSet.value;
  if (!vs) return { prevote: new Map<string, number>(), precommit: new Map<string, number>() };
  const pv = new Map<string, number>();
  const pc = new Map<string, number>();
  (vs.prevotes || []).forEach((v: any) => {
    const h = voteBlockHash(v);
    if (h) pv.set(h, (pv.get(h) || 0) + 1);
  });
  (vs.precommits || []).forEach((v: any) => {
    const h = voteBlockHash(v);
    if (h) pc.set(h, (pc.get(h) || 0) + 1);
  });
  return { prevote: pv, precommit: pc };
});
const majorityPrevoteHash = computed(() => {
  const m = [...voteHashes.value.prevote.entries()].sort((a, b) => b[1] - a[1])[0];
  return m ? m[0] : '';
});
const majorityPrecommitHash = computed(() => {
  const m = [...voteHashes.value.precommit.entries()].sort((a, b) => b[1] - a[1])[0];
  return m ? m[0] : '';
});
const hasHashDivergence = computed(() => voteHashes.value.prevote.size > 1 || voteHashes.value.precommit.size > 1);

/** Hash distribution weighted by voting power (like Northa/consensus).
 *  Groups validators by their precommit hash (fallback prevote), sums VP%.
 *  nil-Vote validators are included as "nil-Vote" bucket.
 *  Persists last non-nil distribution so UI doesn't go blank during step 1 (NewHeight). */
let lastHashDistribution: any[] = [];
const hashDistribution = computed(() => {
  const map = new Map<string, number>();
  for (const r of rows.value) {
    const h = r.precommitHash || r.prevoteHash || 'nil-Vote';
    map.set(h, (map.get(h) || 0) + r.vpPercent);
  }
  const result = [...map.entries()]
    .map(([hash, percent]) => ({ hash, count: 0, percent }))
    .sort((a, b) => b.percent - a.percent);
  // If current round has no real votes (all nil), keep showing last non-nil distribution
  const hasRealVotes = result.some(r => r.hash !== 'nil-Vote' && r.percent > 0);
  if (hasRealVotes) {
    lastHashDistribution = result;
    return result;
  }
  return lastHashDistribution.length > 0 ? lastHashDistribution : result;
});

const filteredRows = computed(() => {
  let list = rows.value;
  if (isGno.value) {
    // Gno/TM2: Online tab = ACTIVE validators, Offline tab = INACTIVE validators
    if (showFilter.value === 'online') list = list.filter((r) => r.gnoStatus === 'ACTIVE');
    else if (showFilter.value === 'offline') list = list.filter((r) => r.gnoStatus === 'INACTIVE');
  } else {
    // Cosmos SDK: use online/offline from last commit signatures
    if (showFilter.value === 'online') list = list.filter((r) => r.online);
    else if (showFilter.value === 'offline') list = list.filter((r) => !r.online);
  }
  const q = searchText.value.trim().toLowerCase();
  if (q) list = list.filter((r) => r.moniker.toLowerCase().includes(q) || r.address.toLowerCase().includes(q));
  return list;
});

// ---- actions ----
async function refetch() {
  // Don't hard-lock on loading forever — supersede via startMonitor gen path
  if (loading) {
    // Force a clean restart rather than no-op (user-visible "stuck until refresh")
    clearTime();
    started = false;
    loading = false;
  }
  loading = true;
  httpstatus.value = 200;
  httpStatusText.value = '';
  roundState.value = {};
  validatorsFallback.value = [];
  clearTime();
  try {
    // Gno: fetch uptime.json snapshot for ACTIVE/INACTIVE status filtering (await so rows filter works on first render)
    if (isGno.value) {
      try {
        const snap = await fetchGnoUptimeSnapshot(uptimeUrl.value);
        const m = new Map<string, GnoUptimeValidator>();
        for (const v of snap.validators) {
          if (v.signingAddress) m.set(v.signingAddress, v);
          if (v.operatorAddress) m.set(v.operatorAddress, v);
        }
        gnoUptimeMap.value = m;
      } catch (e: any) {
        console.warn('[consensus] gno uptime fetch:', e?.message || e);
      }
    }
    // Call update() first to populate roundState.value (has active validator set)
    await update();
    await fetchPosition();
    if (httpstatus.value === 200 && positions.value.length > 0) {
      // Start polling — 500ms to catch voting phase (step 4-6, ~1s window)
      timer = setInterval(() => update(), 500);
    }
  } finally {
    loading = false;
  }
}
async function fetchPosition() {
  if (!rpc.value) {
    httpstatus.value = 0;
    httpStatusText.value = 'No RPC selected';
    validatorsFallback.value = [];
    return;
  }
  const base = rpc.value;
  try {
    // positions computed derives from roundState.value.validators.validators automatically.
    // Only need to fetch /validators as fallback when roundState has no validators.
    const rs = roundState.value;
    const rsValidators = rs?.validators?.validators;
    if (Array.isArray(rsValidators) && rsValidators.length > 0) {
      httpstatus.value = 200;
      httpStatusText.value = 'OK (from dump_consensus_state)';
      return;
    }
    // Fallback: /validators endpoint (committed set)
    const all: any[] = [];
    let page = 1;
    let total = 0;
    do {
      const res = await fetch(`${base}/validators?per_page=100&page=${page}`);
      if (!res.ok) {
        httpstatus.value = res.status;
        httpStatusText.value = res.statusText || `HTTP ${res.status}`;
        validatorsFallback.value = [];
        return;
      }
      const data = await res.json();
      const vals = data?.result?.validators || [];
      total = Number(data?.result?.total ?? vals.length);
      all.push(...vals);
      page++;
    } while (all.length < total && page <= 10);
    validatorsFallback.value = all;
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
    validatorsFallback.value = [];
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
        const addr = String(pc.validator_address || '').trim();
        const hasSig = !!(pc.signature || pc.block_id?.hash || (pc.block_id && pc.block_id !== 'nil'));
        if (addr && hasSig) {
          signed.add(addr);
          // g1 bech32 is case-insensitive for matching
          if (/^g1/i.test(addr)) signed.add(addr.toLowerCase());
        }
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
    const addr = String(p.address || '').trim();
    const ok = signed.has(addr) || (/^g1/i.test(addr) && signed.has(addr.toLowerCase()));
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

/** Fetch /block and extract last_commit signers — validators that actually
 *  signed (precommitted) the previous block. This is the ground truth for
 *  online/offline status, more reliable than dump_consensus_state which may
 *  show nil for validators that ARE signing. */
async function fetchLastCommitSigners(base: string) {
  try {
    const res = await fetch(`${base}/block`);
    if (!res.ok) return;
    const data = await res.json();
    const sigs = data?.result?.block?.last_commit?.precommits || data?.result?.block?.last_commit?.signatures || [];
    const signers = new Set<string>();
    for (const sig of sigs) {
      if (!sig) continue;
      // TM2 (Gno): type === 2 (COMMIT). Cosmos: block_id_flag === 2.
      // Adapted bundle: block_id_flag === "BLOCK_ID_FLAG_COMMIT".
      // Last resort: signature field present = signed.
      const flag = sig.type ?? sig.block_id_flag;
      const addr = String(sig.validator_address || '').trim().toUpperCase();
      const signed =
        flag === 2 ||
        flag === 'BLOCK_ID_FLAG_COMMIT' ||
        !!sig.signature;
      if (signed && addr) {
        signers.add(addr);
      }
    }
    lastCommitSigners.value = signers;
  } catch {
    /* ignore — keep previous set */
  }
}

async function update() {
  if (!rpc.value) return;
  try {
    // Primary: dump_consensus_state (exposes vote hash strings via votes[])
    let data = await fetch(`${rpc.value}/dump_consensus_state`);
    httpstatus.value = data.status;
    httpStatusText.value = data.statusText;
    if (data.ok) {
      const res = await data.json();
      let rs = res?.result?.round_state || {};
      // Gno TM2: votes is an empty dict {} and height_vote_set is absent.
      // Cosmos: votes is a populated array. Detect empty votes → synthesize
      // from /block last_commit precommits so prevote/precommit counters work.
      const rawVotes = rs?.votes;
      const votesEmpty =
        !rawVotes ||
        (Array.isArray(rawVotes) && rawVotes.length === 0) ||
        (!Array.isArray(rawVotes) && typeof rawVotes === 'object' && Object.keys(rawVotes).length === 0);
      if (votesEmpty) {
        rs = await synthesizeTm2RoundState(rpc.value);
        tm2Synthetic.value = true;
      } else {
        tm2Synthetic.value = false;
      }
      roundState.value = rs;
      // dump_consensus_state returns height/round/step as separate fields
      // (NOT the combined "height/round/step" string which is empty in TM 0.38+)
      const rs2 = roundState.value;
      const newH = String(rs2?.height ?? (rs2?.['height/round/step'] || '').split('/')[0] ?? '');
      height.value = newH;
      round.value = String(rs2?.round ?? (rs2?.['height/round/step'] || '').split('/')[1] ?? '0');
      step.value = String(rs2?.step ?? (rs2?.['height/round/step'] || '').split('/')[2] ?? '');
      // Cross-reference last_commit signers for accurate online/offline status
      fetchLastCommitSigners(rpc.value);
      return;
    }
    // Fallback: consensus_state (modern TM, votes are all nil-Vote)
    data = await fetch(`${rpc.value}/consensus_state`);
    httpstatus.value = data.status;
    httpStatusText.value = data.statusText;
    if (!data.ok) {
      await fallbackRpc();
      return;
    }
    const res = await data.json();
    let rs = res?.result?.round_state || {};
    const hvs = rs.height_vote_set;
    const hvsEmpty =
      !hvs ||
      (Array.isArray(hvs) && hvs.length === 0) ||
      (!Array.isArray(hvs) && typeof hvs === 'object' && Object.keys(hvs).length === 0);
    if (hvsEmpty) {
      rs = await synthesizeTm2RoundState(rpc.value);
      tm2Synthetic.value = true;
    } else {
      tm2Synthetic.value = false;
    }
    roundState.value = rs;
    const raw = String(roundState.value?.['height/round/step'] || '').split('/');
    // dump_consensus_state: height/round/step as separate fields OR combined string
    height.value = String(rs?.height ?? raw[0] ?? '');
    round.value = String(rs?.round ?? raw[1] ?? '0');
    step.value = String(rs?.step ?? raw[2] ?? '');
  } catch (err: any) {
    httpstatus.value = 500;
    httpStatusText.value = err?.message || String(err);
    await fallbackRpc();
  }
}

// Auto-fallback: if the active RPC dies mid-session, walk tip-quality peers.
let fallbackCooldown = 0;
async function fallbackRpc() {
  const now = Date.now();
  if (now - fallbackCooldown < 10000) return;
  fallbackCooldown = now;
  if (!rpcList.value || rpcList.value.length <= 1) return;
  const current = rpc.value;
  const engine = chainStore.current?.engine;
  const ranked = await rankRpcs(
    rpcList.value.map((x) => ({ address: x.address, provider: x.provider })),
    { engine, timeoutMs: 4000 }
  );
  const tip = pickTipPeers(ranked).filter((r) => r.address !== current);
  const order = tip.length ? tip : ranked.filter((r) => r.ok && r.address !== current);
  for (const ep of order) {
    try {
      const probe = await fetch(`${ep.address}/dump_consensus_state`);
      if (probe.ok) {
        rpc.value = ep.address;
        httpstatus.value = 200;
        httpStatusText.value = 'Switched to fallback RPC';
        await fetchPosition();
        await update();
        return;
      }
    } catch {
      // try next
    }
  }
}
function exportCsv() {
  const header = ['Rank', 'Moniker', 'Address', 'VotingPower', 'VP%', 'Online', 'Prevote', 'PrevoteHash', 'Precommit', 'PrecommitHash'];
  // Moniker is validator-controlled on-chain free text. A leading = + - @ (or
  // tab/CR) makes Excel/LibreOffice evaluate the cell as a formula even when
  // CSV-quoted (CSV formula injection → e.g. =cmd|'/C calc'!A0). Prefix a single
  // quote to force a text literal, then escape embedded quotes for CSV.
  const csvCell = (s: unknown) => {
    const t = String(s ?? '');
    const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = rows.value.map((r) =>
    [
      r.rank,
      csvCell(r.moniker),
      r.address,
      r.votingPower,
      r.vpPercent.toFixed(2),
      r.online ? 'yes' : 'no',
      isSigned(r.prevote) ? 'signed' : 'nil',
      r.prevoteHash || '',
      isSigned(r.precommit) ? 'signed' : 'nil',
      r.precommitHash || '',
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
            <span
              v-if="tm2Synthetic"
              class="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-900/30 px-2 py-0.5 text-[10px] font-semibold text-amber-300"
              title="Gnoland /consensus_state has empty height_vote_set. This view synthesizes online/offline from last block precommits — NOT live round votes."
            >TM2 · last commit (synthetic)</span>
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
              <!-- Cosmos tendermint: steps 0–3 (NewHeight…Commit). TM2 dump uses 1-based ints — don't hardcode /4. -->
              <span>
                Step
                <b class="font-mono text-slate-200">{{ step || '—' }}</b>
                <span v-if="!tm2Synthetic">/4</span>
              </span>
              <span class="hidden sm:inline text-slate-600">·</span>
              <span class="hidden sm:inline">{{ tm2Synthetic ? 'Last commit coverage' : 'Proposing now' }}</span>
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
          <!-- Gno/TM2: session-based status counts -->
          <div v-if="isGno && gnoUptimeMap.size > 0" class="flex items-center gap-2">
            <span class="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Session</span>
            <span class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <b class="font-mono text-emerald-300">{{ rows.filter(r => r.gnoStatus === 'ACTIVE').length }}</b>
              <span class="text-slate-500">active</span>
            </span>
            <span class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-rose-400"></span>
              <b class="font-mono text-rose-300">{{ rows.filter(r => r.gnoStatus === 'INACTIVE').length }}</b>
              <span class="text-slate-500">jailed</span>
            </span>
          </div>
          <!-- hash distribution (Northa/consensus style) -->
          <div v-if="hashDistribution.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Consensus</span>
            <span
              v-for="(h, i) in hashDistribution.slice(0, 5)"
              :key="h.hash"
              class="inline-flex items-center gap-1.5"
            >
              <span
                class="w-2 h-2 rounded-full"
                :class="h.hash === 'nil-Vote' ? 'bg-rose-400' : (i === 0 ? 'bg-sky-400' : 'bg-emerald-400')"
              ></span>
              <span class="font-mono text-[10px] text-slate-300">{{ h.hash === 'nil-Vote' ? 'nil-Vote' : 'hash ' + h.hash }}</span>
              <b class="font-mono text-[10px]" :class="h.hash === 'nil-Vote' ? 'text-rose-300' : 'text-sky-300'">{{ h.percent.toFixed(1) }}%</b>
            </span>
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
              <th class="text-center">Hash</th>
              <th class="text-right">Voting Power</th>
              <th v-if="isGno" class="text-center">Session</th>
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
                  <!-- Gno/TM2: status badge -->
                  <span
                    v-if="isGno && r.gnoStatus"
                    class="badge badge-xs shrink-0 font-bold"
                    :class="r.gnoStatus === 'ACTIVE' ? 'badge-success' : 'badge-error'"
                    :title="r.gnoReason"
                  >{{ r.gnoStatus === 'ACTIVE' ? '✓' : '✕' }}</span>
                </div>
              </td>
              <td class="text-center">
                <span
                  v-if="r.precommitHash || r.prevoteHash"
                  class="font-mono text-[10px] tracking-tight"
                  :class="r.precommitHash ? 'text-slate-300' : 'text-sky-400/60'"
                  :title="r.precommitHash || r.prevoteHash"
                >{{ r.precommitHash || r.prevoteHash }}</span>
                <span v-else class="text-slate-600 text-xs">—</span>
              </td>
              <td class="text-right">
                <div class="flex items-center justify-end gap-2">
                  <div class="vp-track hidden sm:block">
                    <div class="vp-fill" :style="{ width: Math.min(100, r.vpPercent) + '%' }"></div>
                  </div>
                  <span class="font-mono text-xs">{{ r.vpPercent.toFixed(1) }}%</span>
                </div>
              </td>
              <!-- Gno/TM2: Session uptime column -->
              <td v-if="isGno" class="text-center">
                <div v-if="r.gnoStatus === 'ACTIVE'" class="flex flex-col items-center gap-0.5">
                  <span class="font-mono text-xs font-semibold" :class="sessionUptimeColor(r.gnoSessionUptime)">
                    {{ r.gnoSessionUptime != null ? r.gnoSessionUptime.toFixed(1) + '%' : '—' }}
                  </span>
                  <span class="text-[9px] text-slate-500" :title="`Window: ${r.gnoWindowUptime != null ? r.gnoWindowUptime.toFixed(1) + '%' : '—'}%`">
                    {{ r.gnoConsecutiveSigned ? `↻${r.gnoConsecutiveSigned}` : '' }}
                  </span>
                </div>
                <div v-else-if="r.gnoStatus === 'INACTIVE'" class="flex flex-col items-center gap-0.5">
                  <span class="font-mono text-xs text-rose-400">offline</span>
                  <span class="text-[9px] text-slate-500" :title="r.gnoReason">
                    {{ r.gnoConsecutiveMissed ? `✕${r.gnoConsecutiveMissed}` : '' }}
                  </span>
                </div>
                <span v-else class="text-slate-600 text-xs">—</span>
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
