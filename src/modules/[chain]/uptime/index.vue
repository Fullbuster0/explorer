<script lang="ts" setup>
import { ref, onMounted, computed, onUnmounted, watch } from 'vue';
import { fromBech32, fromHex, toBase64, toHex } from '@cosmjs/encoding';
import { useStakingStore, useBaseStore, useBlockchain, useFormatter } from '@/stores';
import UptimeBar from '@/components/UptimeBar.vue';
import type { SlashingParam, SigningInfo, Block, Validator } from '@/types';
import { consensusPubkeyToHexAddress, valconsToBase64 } from '@/libs';
import { gnoMoniker } from '@/libs/gno/valopers';

const props = defineProps(['chain']);

const stakingStore = useStakingStore();
const format = useFormatter();
const baseStore = useBaseStore();
const chainStore = useBlockchain();
const isGnoUptime = computed(
  () => chainStore.current?.engine === 'gno' || chainStore.current?.engine === 'tm2'
);
const latest = ref(0);
const keyword = ref('');
const tombstonedOnly = ref(false);
const live = ref(true);
const loadingAll = ref(false);
const slashingParam = ref({} as SlashingParam);
const signingInfo = ref({} as Record<string, SigningInfo>);
const inactiveValidators = ref([] as Validator[]);
const consumerValidators = ref([] as { moniker: string; base64: string }[]);

interface GnoUptimeValidator {
  operatorAddress: string;
  signingAddress?: string;
  moniker: string;
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING' | string;
  sampledBlocks: number;
  signed: number;
  missed: number;
  uptime?: number | null;
  consecutiveMissed?: number;
  votingPower?: string;
}

interface GnoUptimeSnapshot {
  observedHeight?: number;
  windowBlocks?: number;
  updatedAt?: string;
  recentBlocks?: { height: number; signed: string[] }[];
  validators: GnoUptimeValidator[];
}

const gnoSnapshot = ref<GnoUptimeSnapshot | null>(null);
const gnoSnapshotLoading = ref(false);
const gnoSnapshotError = ref('');
let gnoSnapshotTimer: ReturnType<typeof setInterval> | undefined;
const gnoUptimeUrl = computed(() => (chainStore.current as any)?.uptime_live_url || '');

async function fetchGnoSnapshot() {
  if (!isGnoUptime.value || !gnoUptimeUrl.value) return;
  gnoSnapshotLoading.value = !gnoSnapshot.value;
  try {
    const separator = gnoUptimeUrl.value.includes('?') ? '&' : '?';
    const response = await fetch(`${gnoUptimeUrl.value}${separator}t=${Date.now()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.validators)) throw new Error('invalid uptime snapshot');
    gnoSnapshot.value = payload as GnoUptimeSnapshot;
    // Keep the shared network header aligned with the snapshot currently
    // rendered by this page, rather than showing a newer RPC tip.
    window.dispatchEvent(
      new CustomEvent('gno-uptime-snapshot', {
        detail: { observedHeight: Number(payload.observedHeight || 0) },
      })
    );
    gnoSnapshotError.value = '';
  } catch (error: any) {
    gnoSnapshotError.value = error?.message || 'Unable to load uptime snapshot';
  } finally {
    gnoSnapshotLoading.value = false;
  }
}

function compareGnoSnapshotRows(a: GnoUptimeValidator, b: GnoUptimeValidator): number {
  const power = Number(b.votingPower || 0) - Number(a.votingPower || 0);
  if (power !== 0) return power;
  const moniker = String(a.moniker || '').localeCompare(String(b.moniker || ''), undefined, { sensitivity: 'base' });
  return moniker || String(a.operatorAddress || a.signingAddress || '').localeCompare(String(b.operatorAddress || b.signingAddress || ''));
}

const gnoSnapshotRows = computed(() => {
  const order: Record<string, number> = { ACTIVE: 0, PENDING: 1, INACTIVE: 2 };
  return (gnoSnapshot.value?.validators || [])
    .filter((v) => matchGnoKeyword(v.moniker))
    .slice()
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || compareGnoSnapshotRows(a, b));
});

const gnoSnapshotStats = computed(() => {
  const rows = gnoSnapshot.value?.validators || [];
  return {
    total: rows.length,
    active: rows.filter((v) => v.status === 'ACTIVE').length,
    pending: rows.filter((v) => v.status === 'PENDING').length,
    inactive: rows.filter((v) => v.status === 'INACTIVE').length,
  };
});

const gnoActiveSnapshotRows = computed(() =>
  gnoSnapshotRows.value.filter((v) => v.status === 'ACTIVE')
);

function gnoRecentBars(v: GnoUptimeValidator) {
  const address = v.signingAddress || v.operatorAddress;
  return (gnoSnapshot.value?.recentBlocks || []).map((block) => ({
    height: String(block.height),
    color: block.signed.includes(address) ? 'bg-green-500' : 'bg-red-500',
  }));
}

function matchGnoKeyword(moniker: string) {
  const q = keyword.value.trim().toLowerCase();
  return !q || moniker.toLowerCase().includes(q);
}

function gnoUptimeLabel(value?: number | null) {
  return value == null ? 'PENDING' : `${Number(value).toFixed(2)}%`;
}

type BondStatus = 'active' | 'unbonding' | 'inactive';

interface BlockColor {
  height: string;
  color: string;
}
interface ValidatorUnit {
  moniker: string;
  blocks: BlockColor[];
  hex: string;
  base64: string;
  missed_blocks_counter: number | string;
  uptime?: number;
  signing?: SigningInfo;
  status: BondStatus;
  jailed: boolean;
  operator_address?: string;
  tokens?: string;
}

function padding(blocks: BlockColor[] = []) {
  const raw = Array(50)
    .fill({ height: '0', color: 'bg-secondary' } as BlockColor)
    .concat(blocks);
  return raw.slice(raw.length - 50);
}

function mapValidator(v: Validator, status: BondStatus): Omit<ValidatorUnit, 'blocks' | 'uptime' | 'missed_blocks_counter' | 'signing'> {
  // Gnoland/TM2: operator_address is already the consensus bech32 (g1…),
  // and block signatures carry base64(bech32-data). Prefer that over the
  // cosmos ed25519→sha256 hex path when the address is bech32 `g…`.
  const op = v.operator_address || '';
  let hex = '';
  let base64 = '';
  if (op.startsWith('g') && op.length > 10) {
    try {
      const { data } = fromBech32(op);
      base64 = toBase64(data);
      hex = toHex(data).toUpperCase();
    } catch {
      hex = consensusPubkeyToHexAddress(v.consensus_pubkey);
      base64 = hex ? toBase64(fromHex(hex)) : '';
    }
  } else {
    hex = consensusPubkeyToHexAddress(v.consensus_pubkey);
    base64 = hex ? toBase64(fromHex(hex)) : '';
  }
  // Prefer valopers registry moniker for Gno (tm2ValidatorToStaking uses shortAddr on purpose for list page)
  const moniker =
    gnoMoniker(op, v.description?.moniker || '') ||
    v.description?.moniker ||
    v.operator_address;
  return {
    moniker,
    hex,
    base64,
    status,
    jailed: !!v.jailed,
    operator_address: v.operator_address,
    tokens: v.tokens,
  };
}

// Blocks tab: active set only (signing set)
const activeSet = computed(() => {
  if (chainStore.isConsumerChain) {
    return consumerValidators.value.map((v) => {
      const b64 = v.base64;
      const moniker =
        stakingStore.validators.find(
          (x) => toBase64(fromHex(consensusPubkeyToHexAddress(x.consensus_pubkey))) === b64
        )?.description.moniker || v.moniker;
      return {
        moniker,
        hex: '',
        base64: b64,
        status: 'active' as BondStatus,
        jailed: false,
      };
    });
  }
  return stakingStore.validators
    .slice()
    .sort((a, b) => Number(b.delegator_shares) - Number(a.delegator_shares))
    .map((v) => mapValidator(v, 'active'));
});

// Overall tab: active → unbonding/inactive, power order within each group
const overallSet = computed(() => {
  if (chainStore.isConsumerChain) return activeSet.value;

  const activeOps = new Set(stakingStore.validators.map((v) => v.operator_address));
  const active = stakingStore.validators
    .slice()
    .sort((a, b) => Number(b.delegator_shares) - Number(a.delegator_shares))
    .map((v) => mapValidator(v, 'active'));

  const inactive = inactiveValidators.value
    .filter((v) => !activeOps.has(v.operator_address))
    .slice()
    .sort((a, b) => {
      // unbonding first, then unbonded; then by tokens desc
      const rank = (s: string) => (s === 'BOND_STATUS_UNBONDING' ? 0 : 1);
      const d = rank(a.status) - rank(b.status);
      if (d !== 0) return d;
      return Number(b.tokens || 0) - Number(a.tokens || 0);
    })
    .map((v) =>
      mapValidator(v, v.status === 'BOND_STATUS_UNBONDING' ? 'unbonding' : 'inactive')
    );

  return [...active, ...inactive];
});

const blockColors = ref({} as Record<string, BlockColor[]>);
// Live missed counter (optimistic). Reconciled from chain signing infos every new block.
const liveMissed = ref({} as Record<string, number>);
// Avoid double-counting the same height (subscribe + preFill race)
const appliedHeights = ref({} as Record<string, Set<string>>);

function readMissed(base64: string, signing?: SigningInfo): number | undefined {
  if (base64 && liveMissed.value[base64] !== undefined) return liveMissed.value[base64];
  if (signing?.missed_blocks_counter !== undefined && signing?.missed_blocks_counter !== null) {
    return Number(signing.missed_blocks_counter);
  }
  return undefined;
}

function attachSigning(v: Omit<ValidatorUnit, 'blocks' | 'uptime' | 'missed_blocks_counter' | 'signing'>): ValidatorUnit {
  const window = Number(slashingParam.value.signed_blocks_window || 0);
  const signing = v.base64 ? signingInfo.value[v.base64] : undefined;
  // Prefer live heatmap-derived missed (works on Gno without signing infos).
  // Fall back to on-chain signing info when available (Cosmos).
  let missed: number | undefined = v.base64 ? readMissed(v.base64, signing) : undefined;
  if (missed === undefined && v.base64 && blockColors.value[v.base64]?.length) {
    // Count red cells in the last `window` blocks of the heatmap
    const cells = blockColors.value[v.base64] || [];
    const slice = window > 0 ? cells.slice(-window) : cells;
    missed = slice.filter((c) => String(c.color || '').includes('red')).length;
  }
  const uptime =
    missed !== undefined && window > 0
      ? Math.max(0, Math.min(1, (window - missed) / window))
      : undefined;
  return {
    ...v,
    blocks: padding(blockColors.value[v.base64] || []),
    uptime,
    missed_blocks_counter: missed !== undefined ? missed : '—',
    signing,
  };
}

function matchKeyword(moniker: string) {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return true;
  return moniker.toLowerCase().includes(q);
}

// Blocks heatmap grid (active only)
const grid = computed(() =>
  activeSet.value.filter((v) => matchKeyword(v.moniker)).map((v) => attachSigning(v))
);

// Overall table rows (active + inactive), optional tombstoned filter
const overallRows = computed(() => {
  let rows = overallSet.value.filter((v) => matchKeyword(v.moniker)).map((v) => attachSigning(v));
  if (tombstonedOnly.value) {
    rows = rows.filter((v) => !!v.signing?.tombstoned);
  }
  return rows;
});

const overallStats = computed(() => {
  const all = overallSet.value.map((v) => attachSigning(v));
  return {
    total: all.length,
    active: all.filter((v) => v.status === 'active').length,
    inactive: all.filter((v) => v.status !== 'active').length,
    tombstoned: all.filter((v) => !!v.signing?.tombstoned).length,
    shown: overallRows.value.length,
  };
});

const preload = ref(false);
baseStore.$subscribe((_, state) => {
  const newHeight = Number(state.latest?.block?.header?.height || 0);
  if (newHeight > latest.value) {
    latest.value = newHeight;
    // initialize if it's the first time
    if (!preload.value) {
      preFill();
      preload.value = true;
    }

    // reset the consumer validators
    if (newHeight > 0 && consumerValidators.value.length === 0) {
      const chain_id = state.latest.block.header.chain_id;
      Promise.resolve().then(async () => {
        await stakingStore.getConsumerValidators(chain_id).then((x) => {
          x.validators
            .sort((a, b) => Number(b.power) - Number(a.power))
            .forEach((v) => {
              const base64 = toBase64(
                fromHex(
                  consensusPubkeyToHexAddress({ '@type': '/cosmos.crypto.ed25519.PubKey', key: v.consumer_key.ed25519 })
                )
              );
              const moniker = v.provider_address;
              consumerValidators.value.push({ moniker, base64 });
            });
        });
      });
    }

    // refresh signing infos every new block so missed counters stay live
    updateTotalSigningInfo();
    fillblock(state.latest, 'end');
  }
});

async function loadAllValidators() {
  if (chainStore.isConsumerChain) return;
  loadingAll.value = true;
  try {
    const [unbonding, unbonded] = await Promise.all([
      stakingStore.fetchUnbondingValdiators().catch(() => [] as Validator[]),
      stakingStore.fetchInacitveValdiators().catch(() => [] as Validator[]),
    ]);
    const byOp = new Map<string, Validator>();
    [...(unbonding || []), ...(unbonded || [])].forEach((v) => {
      if (v?.operator_address) byOp.set(v.operator_address, v);
    });
    inactiveValidators.value = Array.from(byOp.values());
  } finally {
    loadingAll.value = false;
  }
}

onMounted(() => {
  live.value = true;

  if (isGnoUptime.value) {
    fetchGnoSnapshot();
    gnoSnapshotTimer = setInterval(fetchGnoSnapshot, 4_000);
  }

  // fill the recent blocks
  baseStore.recents?.forEach((b) => {
    fillblock(b, 'start');
  });

  updateTotalSigningInfo();
  loadAllValidators();

  // Gno/TM2: no on-chain slashing module — skip Cosmos LCD noise.
  if (!isGnoUptime.value) {
    chainStore.rpc
      ?.getSlashingParams()
      .then((x) => {
        slashingParam.value = x.params;
      })
      .catch((e: any) => console.warn('[uptime] slashing params:', e?.message || e));
  }
});

watch(isGnoUptime, (isGno) => {
  if (isGno && !gnoSnapshotTimer) {
    fetchGnoSnapshot();
    gnoSnapshotTimer = setInterval(fetchGnoSnapshot, 4_000);
  }
});

// Gno/TM2 race: recents often land before staking validators finish loading,
// so fillblock no-ops (activeSet empty / no base64). When the active set
// appears, rebuild the heatmap from recents + clear de-dupe so colors stick.
let uptimeHydrated = false;
watch(
  () => activeSet.value.length,
  (n) => {
    if (!n || uptimeHydrated) return;
    // Only rehydrate if we have almost no colored cells yet
    const colored = Object.values(blockColors.value).reduce((s, arr) => s + (arr?.length || 0), 0);
    if (colored > 20) {
      uptimeHydrated = true;
      return;
    }
    uptimeHydrated = true;
    appliedHeights.value = {};
    blockColors.value = {};
    liveMissed.value = {};
    baseStore.recents?.forEach((b) => fillblock(b, 'start'));
    if (latest.value > 0) preFill();
  }
);

// RPC readiness / endpoint swap: re-pull signing infos + slashing without hard refresh
watch(
  () => [!!chainStore.rpc, chainStore.endpoint?.address] as const,
  ([hasRpc, addr], prev) => {
    if (!hasRpc) return;
    const rpcJustLanded = !prev?.[0];
    const endpointSwapped = !!addr && !!prev?.[1] && addr !== prev[1];
    if (!rpcJustLanded && !endpointSwapped) return;
    updateTotalSigningInfo();
    loadAllValidators();
    chainStore.rpc
      ?.getSlashingParams()
      .then((x) => {
        slashingParam.value = x.params;
      })
      .catch(() => undefined);
    // If active set already present but heatmap empty (missed first recents), rehydrate
    if (activeSet.value.length && Object.keys(blockColors.value).length < 5) {
      uptimeHydrated = false;
      appliedHeights.value = {};
      blockColors.value = {};
      liveMissed.value = {};
      baseStore.recents?.forEach((b) => fillblock(b, 'start'));
      if (latest.value > 0) preFill();
      uptimeHydrated = true;
    }
  }
);

function preFill() {
  if (latest.value > 50 && baseStore.recents.length >= 49) return;
  // preload 50 blocks if recent blocks are not enough
  let promise = Promise.resolve();
  for (let i = latest.value - baseStore.recents.length; i > latest.value - 50 && i > 1; i -= 1) {
    promise = promise.then(
      () =>
        new Promise((resolve) => {
          if (live.value) {
            // continue only if the page is living
            if (i > latest.value - 50)
              baseStore.fetchBlock(i).then((x) => {
                fillblock(x, 'start');
                resolve();
              });
          }
        })
    );
  }
}
function fillblock(b: Block, direction: string = 'end') {
  // heatmap only tracks active signing set
  const height = String(b.block.header.height);
  const nextColors = { ...blockColors.value } as Record<string, BlockColor[]>;
  let missedChanged = false;
  const nextMissed = { ...liveMissed.value } as Record<string, number>;

  activeSet.value.forEach((v) => {
    if (!v.base64) return;

    // de-dupe per validator+height (preFill + subscribe can race)
    const seen = appliedHeights.value[v.base64] || new Set<string>();
    if (seen.has(height)) return;
    seen.add(height);
    // keep set small
    if (seen.size > 80) {
      const arr = Array.from(seen);
      arr.slice(0, arr.length - 60).forEach((h) => seen.delete(h));
    }
    appliedHeights.value[v.base64] = seen;

    const sig = b.block.last_commit?.signatures.find((s) => s.validator_address === v.base64);
    const block = [...(nextColors[v.base64] || [])];
    let color: BlockColor = {
      height: b.block.header.height,
      color: 'bg-red-500',
    };
    let missedThis = true;
    if (sig) {
      const committed = sig.block_id_flag === 'BLOCK_ID_FLAG_COMMIT';
      color = {
        height: b.block.header.height,
        color: committed ? 'bg-green-500' : 'bg-yellow-500',
      };
      // only pure miss (no signature) counts toward missed_blocks_counter
      missedThis = false;
    }

    if (direction === 'end') {
      block.push(color);
      // optimistic live counter: +1 on miss for new tip blocks only
      if (missedThis) {
        const base =
          nextMissed[v.base64] !== undefined
            ? nextMissed[v.base64]
            : Number(signingInfo.value[v.base64]?.missed_blocks_counter || 0);
        nextMissed[v.base64] = base + 1;
        missedChanged = true;
      }
    } else {
      block.unshift(color);
    }
    if (block.length > 50) {
      if (direction === 'end') block.shift();
      else block.pop();
    }
    nextColors[v.base64] = block;
  });

  // replace whole maps so Vue always re-renders chips + bars
  blockColors.value = nextColors;
  if (missedChanged) liveMissed.value = nextMissed;
}

let signingFetchInFlight = false;
let signingFetchQueued = false;

function updateTotalSigningInfo() {
  // coalesce concurrent refreshes (every-block polling)
  if (!chainStore.rpc) return;
  // Gno: no Cosms SigningInfo — heatmap uses last_commit only
  if (chainStore.current?.engine === 'gno' || chainStore.current?.engine === 'tm2') return;
  if (signingFetchInFlight) {
    signingFetchQueued = true;
    return;
  }
  signingFetchInFlight = true;
  chainStore.rpc
    .getSlashingSigningInfos()
    .then((x) => {
      if (!x?.info) return;
      const next = {} as Record<string, SigningInfo>;
      const nextMissed = { ...liveMissed.value } as Record<string, number>;
      x.info.forEach((i) => {
        const key = valconsToBase64(i.address);
        if (!key) return;
        next[key] = i;
        // authoritative reconcile from chain
        nextMissed[key] = Number(i.missed_blocks_counter || 0);
      });
      signingInfo.value = next;
      liveMissed.value = nextMissed;
    })
    .catch((e: any) => console.warn('[uptime] signing infos:', e?.message || e))
    .finally(() => {
      signingFetchInFlight = false;
      if (signingFetchQueued) {
        signingFetchQueued = false;
        updateTotalSigningInfo();
      }
    });
}

function statusChipClass(status: BondStatus, jailed: boolean) {
  if (jailed) return 'sz-chip--bad';
  if (status === 'active') return 'sz-chip--ok';
  if (status === 'unbonding') return 'sz-chip--warn';
  return 'sz-chip--info';
}

function statusLabel(status: BondStatus, jailed: boolean) {
  if (jailed) return 'jailed';
  return status;
}

onUnmounted(() => {
  live.value = false;
  if (gnoSnapshotTimer) {
    clearInterval(gnoSnapshotTimer);
    gnoSnapshotTimer = undefined;
  }
});

//const tab = ref(window.location.hash.search("block")>-1?"2":"3")
const tab = ref('2');
function changeTab(v: string) {
  tab.value = v;
}
</script>

<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Validators</div>
        <h1 class="sz-page-title">{{ $t('module.uptime') }}</h1>
        <div class="sz-page-sub flex items-center gap-2">
          <span class="sz-live-dot"></span>
          <template v-if="isGnoUptime">
            <span>
              Live · rolling window
              <span class="font-mono">{{ (gnoSnapshot?.windowBlocks || 10000).toLocaleString() }}</span>
              blocks · snapshot polling
              <span class="font-mono">4s</span>
            </span>
            <span
              class="sz-chip !text-[10px]"
              title="Gnoland has no on-chain slashing module. Uptime is read from the bounded collector snapshot."
            >collector snapshot · no on-chain slashing</span>
          </template>
          <template v-else>
            <span>
              Live · window
              <span class="font-mono">{{ slashingParam.signed_blocks_window || '—' }}</span>
              · min
              <span class="font-mono">{{ format.percent(slashingParam.min_signed_per_window) }}</span>
            </span>
          </template>
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === '3' }" @click="changeTab('3')">
          {{ $t('uptime.overall') }}
        </a>
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === '2' }" @click="changeTab('2')">
          {{ $t('module.blocks') }}
        </a>
        <RouterLink class="sz-tab" :to="`/${chain}/uptime/customize`">
          {{ $t('uptime.customize') }}
        </RouterLink>
      </div>
    </div>

    <div v-if="isGnoUptime" class="sz-section p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <div class="text-[11px] font-bold uppercase tracking-wider text-secondary">Live collector snapshot</div>
          <div class="text-sm text-secondary mt-1">
            Rolling window:
            <span class="font-mono text-main">{{ (gnoSnapshot?.windowBlocks || 10000).toLocaleString() }} blocks</span>
            · observed height
            <span class="font-mono text-main">#{{ gnoSnapshot?.observedHeight || '—' }}</span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-[11px]">
          <span class="sz-chip sz-chip--ok"><span class="sz-live-dot mr-1"></span>Live · refreshes every 4s</span>
          <span v-if="gnoSnapshot?.updatedAt" class="text-secondary">
            Updated {{ new Date(gnoSnapshot.updatedAt).toLocaleTimeString() }}
          </span>
        </div>
      </div>

      <div v-if="gnoSnapshotError" class="mb-4 rounded-lg border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">
        {{ gnoSnapshotError }} · showing the last successful snapshot when available.
      </div>
      <div v-if="gnoSnapshotLoading && !gnoSnapshot" class="py-10 text-center text-secondary">
        Loading live uptime snapshot…
      </div>
      <template v-else>
        <div class="flex items-center gap-3 mb-4">
          <input
            v-model="keyword"
            type="text"
            placeholder="Filter validators…"
            class="input input-sm w-full border border-base-content/10 bg-base-100 focus:border-primary"
          />
        </div>

        <div v-if="gnoActiveSnapshotRows.length" class="flex flex-row flex-wrap gap-x-4 gap-y-3 justify-center">
          <div v-for="(v, i) in gnoActiveSnapshotRows" :key="v.operatorAddress || v.signingAddress || i" class="sz-uptime-unit">
            <div class="flex justify-between items-center py-0 w-[248px] mb-1">
              <label class="truncate text-[12.5px] font-medium">
                <span class="text-secondary font-mono mr-1">{{ i + 1 }}.</span>
                <span class="text-main">{{ v.moniker || v.operatorAddress }}</span>
              </label>
              <span
                class="sz-chip font-mono !text-[10px]"
                :class="v.missed > 0 ? 'sz-chip--bad' : 'sz-chip--ok'"
                :title="`${v.missed.toLocaleString()} missed blocks in the ${gnoSnapshot?.windowBlocks || 10000} block rolling window`"
              >
                {{ v.missed.toLocaleString() }} missed
              </span>
            </div>
            <UptimeBar :blocks="gnoRecentBars(v)" />
          </div>
        </div>
        <div v-else class="py-8 text-center text-sm text-secondary">No active validators match the filter</div>

        <div class="mt-5 flex flex-wrap items-center justify-center gap-3 text-[11.5px] text-secondary">
          <span class="font-bold uppercase tracking-wider text-[10px]">Recent blocks</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-green-500"></span>Signed</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-red-500"></span>Missed</span>
        </div>
      </template>
    </div>

    <div v-else class="sz-section p-4 sm:p-5">
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          v-model="keyword"
          placeholder="Filter validators…"
          class="input input-sm w-full sm:flex-1 min-w-[12rem] border border-base-content/10 bg-base-100 focus:border-primary"
        />
        <label
          v-if="tab === '3'"
          class="inline-flex items-center gap-2 text-[12px] cursor-pointer select-none shrink-0"
        >
          <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" v-model="tombstonedOnly" />
          <span>{{ $t('uptime.tombstoned') }} only</span>
        </label>
        <span class="sz-chip font-mono shrink-0">
          <template v-if="tab === '3'">
            {{ overallStats.shown }}/{{ overallStats.total }}
            <span class="text-secondary ml-1">· {{ overallStats.active }} act · {{ overallStats.inactive }} inact</span>
            <span v-if="loadingAll" class="ml-1 opacity-60">…</span>
          </template>
          <template v-else>{{ grid.length }}</template>
        </span>
      </div>

      <!-- block heatmap (active set only) -->
      <div :class="tab === '2' ? '' : 'hidden'">
        <div class="flex flex-row flex-wrap gap-x-4 gap-y-3 justify-center">
          <div v-for="(unit, i) in grid" :key="unit.base64 || i" class="sz-uptime-unit">
            <div class="flex justify-between items-center py-0 w-[248px] mb-1">
              <label class="truncate text-[12.5px] font-medium">
                <span class="text-secondary font-mono mr-1">{{ i + 1 }}.</span>
                <span class="text-main">{{ unit.moniker }}</span>
              </label>
              <span
                class="sz-chip font-mono !text-[10px]"
                :class="Number(unit?.missed_blocks_counter || 0) > 10 ? 'sz-chip--bad' : 'sz-chip--ok'"
              >
                {{ unit?.missed_blocks_counter ?? '—' }}
              </span>
            </div>
            <UptimeBar :blocks="unit.blocks" />
          </div>
        </div>
        <div class="mt-5 flex flex-wrap items-center justify-center gap-3 text-[11.5px] text-secondary">
          <span class="font-bold uppercase tracking-wider text-[10px]">{{ $t('uptime.legend') }}</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-green-500"></span>{{ $t('uptime.committed') }}</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-yellow-500"></span>{{ $t('uptime.precommitted') }}</span>
          <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-red-500"></span>{{ $t('uptime.missed') }}</span>
        </div>
      </div>

      <!-- overall table: active set first, then inactive; tombstoned filter works -->
      <div :class="tab === '3' ? '' : 'hidden'">
        <div class="overflow-x-auto -mx-4 sm:-mx-5">
          <table class="sz-table min-w-[720px]">
            <thead>
              <tr>
                <th class="w-10 text-right">#</th>
                <th>{{ $t('account.validator') }}</th>
                <th>Status</th>
                <th class="text-right">{{ $t('module.uptime') }}</th>
                <th class="text-right">Missed</th>
                <th>{{ $t('uptime.last_jailed_time') }}</th>
                <th class="text-right">{{ $t('uptime.start_height') }}</th>
                <th>{{ $t('uptime.tombstoned') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="overallRows.length === 0">
                <td colspan="8" class="text-center text-secondary text-sm py-8">
                  {{ loadingAll ? 'Loading validators…' : 'No validators match filter' }}
                </td>
              </tr>
              <tr v-for="(v, i) in overallRows" :key="v.operator_address || v.base64 || i">
                <td class="text-right font-mono text-[11px] text-secondary">{{ i + 1 }}</td>
                <td>
                  <div class="truncate max-w-[16rem] sm:max-w-sm font-medium">{{ v.moniker }}</div>
                </td>
                <td>
                  <span class="sz-chip capitalize !text-[10px]" :class="statusChipClass(v.status, v.jailed)">
                    {{ statusLabel(v.status, v.jailed) }}
                  </span>
                </td>
                <td class="text-right">
                  <span
                    v-if="v.uptime !== undefined"
                    class="sz-chip font-mono"
                    :class="v.uptime > 0.95 ? 'sz-chip--ok' : v.uptime > 0.9 ? 'sz-chip--warn' : 'sz-chip--bad'"
                    :title="`${v.missed_blocks_counter} missing blocks`"
                  >
                    {{ format.percent(v.uptime) }}
                  </span>
                  <span v-else class="text-secondary text-xs">—</span>
                </td>
                <td class="text-right font-mono text-xs">
                  {{ v.signing ? v.signing.missed_blocks_counter : '—' }}
                </td>
                <td>
                  <span v-if="v.signing && v.signing.jailed_until && !v.signing.jailed_until.startsWith('1970')">
                    <span
                      class="text-xs"
                      :title="format.toDay(v.signing.jailed_until, 'long')"
                    >{{ format.toDay(v.signing.jailed_until, 'from') }}</span>
                  </span>
                  <span v-else class="text-secondary">—</span>
                </td>
                <td class="text-right font-mono text-xs">{{ v.signing?.start_height || '—' }}</td>
                <td>
                  <span
                    v-if="v.signing"
                    class="sz-chip !text-[10px] capitalize"
                    :class="v.signing.tombstoned ? 'sz-chip--bad' : 'sz-chip--ok'"
                  >
                    {{ v.signing.tombstoned ? 'yes' : 'no' }}
                  </span>
                  <span v-else class="text-secondary text-xs">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex flex-wrap items-center gap-2 border-t border-base-content/10 px-1 sm:px-4 py-3">
          <span class="text-[11.5px] text-secondary">{{ $t('uptime.minimum_uptime') }}:</span>
          <span
            class="sz-chip sz-chip--bad font-mono"
            :title="`Window size: ${slashingParam.signed_blocks_window}`"
          >
            {{ format.percent(slashingParam.min_signed_per_window) }}
          </span>
          <span v-if="overallStats.tombstoned" class="text-[11.5px] text-secondary">
            · {{ overallStats.tombstoned }} tombstoned
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
<route>
  {
    meta: {
      i18n: 'uptime',
      order: 8
    }
  }
</route>
