<script lang="ts" setup>
import { useBlockchain, useFormatter, useStakingStore } from '@/stores';
import DonutChart from '@/components/charts/DonutChart.vue';
import { computed, ref } from '@vue/reactivity';
import { onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { PageRequest } from '@/types';
import { fromBech32 } from '@cosmjs/encoding';
import type { AuthAccount, Delegation, TxResponse, DelegatorRewards, UnbondingResponses } from '@/types';
import type { Coin } from '@cosmjs/amino';
import Countdown from '@/components/Countdown.vue';
import { getGnoIndexer, type GnoTx } from '@/libs/gno/indexer';
import { lookupGnoValoper, gnoMoniker, initGnoValopers } from '@/libs/gno/valopers';

const props = defineProps(['address', 'chain']);

const blockchain = useBlockchain();
const stakingStore = useStakingStore();
const format = useFormatter();
const isGno = computed(
  () => blockchain.current?.engine === 'gno' || blockchain.current?.engine === 'tm2'
);
const account = ref({} as AuthAccount);
const accountLoaded = ref(false);
const accountLoadError = ref('');
const accountLoadToken = ref(0);
const delegations = ref([] as Delegation[]);
const rewards = ref({} as DelegatorRewards);
const balances = ref([] as Coin[]);
const unbonding = ref([] as UnbondingResponses[]);
const unbondingTotal = ref(0);

// archive-backed pagination state for tx history tables
// Note: chain LCD endpoints (cosmos.directory, AllinBits, ITRocket) all
// IGNORE pagination.limit and pagination.offset — they always return up to
// the indexer's full set. So we fetch once, then slice client-side.
const HISTORY_PAGE_SIZE = 10;
const txHistoryPage = ref(1);
const txHistoryLimit = ref(HISTORY_PAGE_SIZE);
const txsLoading = ref(false);
const gnoTxs = ref<GnoTx[]>([]);
const gnoTxsHasNext = ref(false);
const gnoTxsCursor = ref<string | undefined>();
const gnoTxsError = ref('');
const gnoTxsLoadingMore = ref(false);

// The full fetched list (server may return more than `txHistoryLimit`).
const allTxs = ref([] as TxResponse[]);
// True chain-wide tx count from the archive (count_total / total_count). Can
// exceed allTxs.length when the wallet has more history than the client buffer
// cap (Option A: ≤500 loaded, total can be e.g. 2,948) — header shows the real
// number, "showing N of M" clarifies only N are loaded.
const txChainTotal = ref(0);

// Server-side pagination (RPC tx_search): full-depth history, one page per click.
// When serverMode is on, `txs` renders serverTxs (the current page) and the pager
// fetches pages on demand — no 500 cap. allTxs/LCD-union stays as the no-index
// fallback (chains whose RPCs expose no tx index for the address).
const serverMode = ref(false);
const serverTxs = ref([] as TxResponse[]);
const serverTotal = ref(0);
const serverPageLoading = ref(false);

// Client-side slice — the rows actually rendered (Cosmos + Gno). In serverMode
// the current page comes straight from the RPC (serverTxs), no client slice.
const txs = computed(() => {
  if (serverMode.value) return serverTxs.value;
  const start = (txHistoryPage.value - 1) * txHistoryLimit.value;
  return allTxs.value.slice(start, start + txHistoryLimit.value);
});

/** Gno history: same page-size + pager UX as AtomOne/Cosmos (client slice of loaded pages). */
const gnoTxsPage = computed(() => {
  const start = (txHistoryPage.value - 1) * txHistoryLimit.value;
  return gnoTxs.value.slice(start, start + txHistoryLimit.value);
});

// Display total: true chain-wide count when the archive exposed it (Cosmos),
// else the loaded buffer size. Gno indexer is cursor-paginated; `gnoTxsHasNext`
// means more exist server-side — UI shows "N loaded" + optional "+".
const txsTotal = computed(() =>
  isGno.value
    ? gnoTxs.value.length
    : serverMode.value
      ? serverTotal.value
      : txChainTotal.value > 0
        ? txChainTotal.value
        : allTxs.value.length
);

const indexerUrl = computed(() => (blockchain.current as any)?.indexer_api || '');

/** Gno related-entity chips: is this g1 a validator signing or operator address? */
const gnoRelated = computed(() => {
  if (!isGno.value) return null;
  const addr = String(props.address || '').trim();
  if (!addr) return null;
  const hit = lookupGnoValoper(addr);
  if (!hit) return null;
  const moniker = hit.moniker || gnoMoniker(hit.signingAddress || hit.operatorAddress) || 'Validator';
  const isSigning = !!(hit.signingAddress && hit.signingAddress === addr);
  const isOperator = !!(hit.operatorAddress && hit.operatorAddress === addr);
  return {
    moniker,
    isSigning,
    isOperator,
    // Product lock: signing stays plain on validator page, but FROM account we
    // may deep-link to the validator detail (signing is the route key).
    validatorTo: hit.signingAddress
      ? `/${props.chain}/validator/${hit.signingAddress}`
      : '',
    operatorTo:
      hit.operatorAddress && hit.operatorAddress !== addr
        ? `/${props.chain}/account/${hit.operatorAddress}`
        : '',
    // Counterpart signing shown plain (no auto account-link of signing from chips
    // that would confuse product lock — only as mono text if different).
    signingPlain:
      hit.signingAddress && hit.signingAddress !== addr ? hit.signingAddress : '',
    operatorPlain:
      hit.operatorAddress && hit.operatorAddress !== addr ? hit.operatorAddress : '',
  };
});

// Warm valopers on Gno so chips resolve on cold account deep-links
if (isGno.value) {
  initGnoValopers(String(props.chain || 'gnoland-testnet')).catch((e: any) => console.warn('[gno-valopers] init:', e?.message || e));
}

function shortGnoHash(h: string): string {
  if (!h) return '—';
  return h.length > 18 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function gnoFuncLabel(tx: GnoTx): string {
  const f = tx.func?.[0];
  if (!f) return 'Tx';
  return f.funcType || f.messageType?.split('.').pop() || 'Tx';
}

function gnoAmountLabel(tx: GnoTx): string {
  const a = tx.amount || tx.amountOut || tx.amountIn;
  if (!a || !a.value || a.value === '0') return '—';
  const n = Number(a.value);
  if (!Number.isFinite(n)) return `${a.value} ${a.denom || ''}`;
  if (a.denom === 'ugnot') {
    const g = n / 1e6;
    return `${g.toLocaleString(undefined, { maximumFractionDigits: 6 })} GNOT`;
  }
  return `${n.toLocaleString()} ${a.denom || ''}`;
}

function gnoDirection(tx: GnoTx, addr: string): 'in' | 'out' | 'self' | 'none' {
  const from = (tx.fromAddress || '').toLowerCase();
  const to = (tx.toAddress || '').toLowerCase();
  const me = (addr || '').toLowerCase();
  if (!me) return 'none';
  const isFrom = from === me;
  const isTo = to === me;
  if (isFrom && isTo) return 'self';
  if (isFrom) return 'out';
  if (isTo) return 'in';
  // valoper activity often has empty toAddress — treat as outbound from this account
  if (isFrom && !to) return 'out';
  return 'none';
}

async function loadTxHistory() {
  txsLoading.value = true;
  gnoTxsError.value = '';
  txHistoryPage.value = 1;
  txChainTotal.value = 0;
  serverMode.value = false;
  serverTxs.value = [];
  serverTotal.value = 0;
  try {
    if (isGno.value) {
      // Gno: onbloc account transactions (RPC tx_index=off; no Cosmos LCD archives).
      // Wait for indexer_api if chain config still settling.
      const idx = indexerUrl.value;
      if (!idx) {
        allTxs.value = [];
        gnoTxs.value = [];
        return;
      }
      const maxAttempts = 3;
      let lastErr: any = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const page = await getGnoIndexer(idx).getAccountTransactions(props.address);
          gnoTxs.value = page.items || [];
          gnoTxsCursor.value = page.cursor;
          gnoTxsHasNext.value = !!page.hasNext;
          allTxs.value = []; // Cosmos table unused on Gno
          lastErr = null;
          break;
        } catch (e: any) {
          lastErr = e;
          console.warn(`[account] gno tx history failed (attempt ${attempt + 1}/${maxAttempts}):`, e?.message || e);
          if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }
      if (lastErr) {
        gnoTxsError.value = lastErr?.message || String(lastErr);
        gnoTxs.value = [];
        allTxs.value = [];
      }
      return;
    }
    // Prefer server-side pagination: RPC tx_search honours page/per_page, so the
    // full chain-wide history is reachable one page per click (no 500 cap). Only
    // the current page is downloaded — critical for relayer accounts whose txs
    // carry multi-MB light-client headers.
    const sp = await blockchain.fetchAccountTxsPage(props.address, 1, txHistoryLimit.value);
    if (sp && sp.total > 0) {
      serverMode.value = true;
      serverTxs.value = sp.rows;
      serverTotal.value = sp.total;
      allTxs.value = [];
      gnoTxs.value = [];
      return;
    }
    // No RPC tx index for this address → LCD union buffer (≤500, progressive).
    serverMode.value = false;
    const page = new PageRequest();
    page.setPageSize(500); // ask generously — LCD caps internally, RPC fallback honours its own cap
    page.offset = 0;
    // Progressive first paint: the store calls this as EACH archive source lands,
    // so the table renders the moment the fastest mirror responds (~1s for relayer
    // accounts) instead of after the full multi-source union (~10s). The union
    // keeps filling allTxs in the background; total updates as count_total arrives.
    const res = await blockchain.fetchAccountTxs(props.address, page, 500, (rows, total) => {
      allTxs.value = rows;
      if (total > txChainTotal.value) txChainTotal.value = total;
      txsLoading.value = false; // drop the "Fetching history…" spinner on first data
    });
    if (res) {
      allTxs.value = res.tx_responses || [];
      txChainTotal.value = Number((res as any)?.pagination?.total || 0);
    }
    gnoTxs.value = [];
  } catch (e: any) {
    console.warn('[account] loadTxHistory failed:', e?.message || e);
    if (isGno.value) gnoTxsError.value = e?.message || String(e);
    allTxs.value = [];
    gnoTxs.value = [];
  } finally {
    txsLoading.value = false;
  }
}

async function loadMoreGnoTxs() {
  if (!isGno.value || !indexerUrl.value || !gnoTxsHasNext.value || !gnoTxsCursor.value || gnoTxsLoadingMore.value) return;
  gnoTxsLoadingMore.value = true;
  try {
    const page = await getGnoIndexer(indexerUrl.value).getAccountTransactionsAfter(
      props.address,
      gnoTxsCursor.value
    );
    const seen = new Set(gnoTxs.value.map((t) => t.txHash));
    for (const t of page.items || []) if (t.txHash && !seen.has(t.txHash)) gnoTxs.value.push(t);
    gnoTxsCursor.value = page.cursor;
    gnoTxsHasNext.value = !!page.hasNext;
  } catch (e: any) {
    console.warn('[account] gno loadMore failed:', e?.message || e);
  } finally {
    gnoTxsLoadingMore.value = false;
  }
}

function setTxHistoryPage(page: number) {
  if (serverMode.value) {
    const max = Math.max(1, Math.ceil(serverTotal.value / txHistoryLimit.value));
    txHistoryPage.value = Math.min(Math.max(1, page), max);
    loadServerPage(txHistoryPage.value);
    return;
  }
  const total = isGno.value ? gnoTxs.value.length : allTxs.value.length;
  const max = Math.max(1, Math.ceil(total / txHistoryLimit.value));
  txHistoryPage.value = Math.min(Math.max(1, page), max);
  // If user pages near the end on Gno and more indexer pages exist, prefetch.
  if (isGno.value && gnoTxsHasNext.value) {
    const nearEnd = page * txHistoryLimit.value >= gnoTxs.value.length - txHistoryLimit.value;
    if (nearEnd) loadMoreGnoTxs();
  }
}

/** Fetch one page of server-paginated history (RPC tx_search) on demand. */
async function loadServerPage(page: number) {
  if (serverPageLoading.value) return;
  serverPageLoading.value = true;
  try {
    const sp = await blockchain.fetchAccountTxsPage(props.address, page, txHistoryLimit.value);
    if (sp) {
      serverTxs.value = sp.rows;
      if (sp.total > 0) serverTotal.value = sp.total;
    }
  } catch (e: any) {
    console.warn('[account] server page failed:', e?.message || e);
  } finally {
    serverPageLoading.value = false;
  }
}

function setTxHistorySize(size: number) {
  txHistoryLimit.value = size;
  // Reset to first page so user sees the new slice from the top.
  txHistoryPage.value = 1;
  if (serverMode.value) loadServerPage(1);
}

const gnoHistoryPageCount = computed(() =>
  Math.max(1, Math.ceil(gnoTxs.value.length / txHistoryLimit.value) || 1)
);

onMounted(() => {
  loadAccount(props.address);
  loadTxHistory();
});

// SPA navigation: reload when address changes (e.g., search → account A → account B)
watch(
  () => props.address,
  (newAddr: string, oldAddr: string) => {
    if (newAddr && newAddr !== oldAddr) {
      loadAccount(newAddr);
      loadTxHistory();
    }
  }
);

// Retry once the chain RPC client becomes available (Gno endpoint pick).
// Also re-fire when rpc instance changes (endpoint fallback) even if a prior
// load left accountLoaded=true with empty shell — that was the "need refresh" path.
const lastAccountRpc = ref<any>(null);
watch(
  () => blockchain.rpc,
  (rpc) => {
    if (!rpc || !props.address) return;
    const rpcChanged = rpc !== lastAccountRpc.value;
    lastAccountRpc.value = rpc;
    const hasType = !!(account.value as any)?.['@type'];
    if (rpcChanged || !accountLoaded.value || !hasType) {
      loadAccount(props.address);
    }
  }
);

// Indexer_api often arrives a tick after mount — re-fetch Gno history.
watch(
  () => indexerUrl.value,
  (url, prev) => {
    if (isGno.value && url && url !== prev && props.address) {
      loadTxHistory();
    }
  }
);

// Display-friendly bond-denom symbol (e.g. 'ATONE' instead of 'uatone').
// Single source of truth — every place in the template that prints the
// staking denom goes through this so chains with dual-token economics
// (atomone: ATONE + PHOTON) stay consistent.
const bondSymbol = computed(() => {
  if (isGno.value) {
    // Account balances are ugnot → display as GNOT
    return 'GNOT';
  }
  return format.tokenDisplayDenom(stakingStore.params.bond_denom)?.toUpperCase() ||
    stakingStore.params.bond_denom ||
    '';
});

// Non-bond-denom balances shown as a secondary strip (e.g. PHOTON on
// atomone). Most chains have a single native denom — this list stays empty.
const otherBalances = computed(() => {
  if (isGno.value) {
    // Everything that isn't ugnot (GRC20 path denoms etc.)
    return (balances.value || []).filter((c) => c.denom !== 'ugnot');
  }
  const bond = stakingStore.params.bond_denom;
  return (balances.value || []).filter((c) => c.denom !== bond);
});

// Sum only the bond-denom slice of `balances` for the portfolio donut.
// On dual-token chains (atomone) this means ATONE-only; PHOTON shows up
// separately in `otherBalances` so it doesn't pollute the staking pie.
const bondBalances = computed(() => {
  if (isGno.value) {
    return (balances.value || []).filter((c) => c.denom === 'ugnot');
  }
  const bond = stakingStore.params.bond_denom;
  return (balances.value || []).filter((c) => c.denom === bond);
});

// total raw token amounts per category (used for donut + share bars)
const totalsRaw = computed(() => {
  const fin = (n: number) => (Number.isFinite(n) ? n : 0);
  let sumBal = 0;
  bondBalances.value?.forEach((x) => (sumBal += fin(format.tokenAmountNumber(x))));
  if (isGno.value) {
    // No staking/rewards/unbonding on Gno — portfolio is available balance only
    return { available: fin(sumBal), delegated: 0, rewards: 0, unbonding: 0 };
  }
  let sumDel = 0;
  delegations.value?.forEach((x) => (sumDel += fin(format.tokenAmountNumber(x.balance))));
  // Rewards portfolio slice is BOND-DENOM only. Other reward denoms (IBC
  // stTokens etc.) show up in the Secondary balances / rewards cell —
  // summing them here mixed raw micro-units into the ATOM donut and
  // produced absurd totals like 71 trillion "ATOM".
  const bond = stakingStore.params.bond_denom;
  let sumRew = 0;
  rewards.value?.total?.forEach((x) => {
    if (!bond || x.denom === bond) sumRew += fin(format.tokenAmountNumber(x));
  });
  let sumUn = 0;
  unbonding.value?.forEach((x) =>
    x.entries?.forEach(
      (y) =>
        (sumUn += fin(
          format.tokenAmountNumber({
            amount: y.balance,
            denom: stakingStore.params.bond_denom,
          })
        ))
    )
  );
  return {
    available: fin(sumBal),
    delegated: fin(sumDel),
    rewards: fin(sumRew),
    unbonding: fin(sumUn),
  };
});
const totalAmount = computed(() => {
  const t = totalsRaw.value;
  const s = t.available + t.delegated + t.rewards + t.unbonding;
  return Number.isFinite(s) ? s : 0;
});
const totalAmountByCategory = computed(() =>
  isGno.value
    ? [totalsRaw.value.available]
    : [
        totalsRaw.value.available,
        totalsRaw.value.delegated,
        totalsRaw.value.rewards,
        totalsRaw.value.unbonding,
      ]
);
const labels = computed(() =>
  isGno.value ? ['Available'] : ['Available', 'Delegated', 'Rewards', 'Unbonding']
);
// Slice colors MUST match `labels` order — they are applied positionally by
// ApexCharts. Kept in lockstep with the breakdown rows (--acc-tone-*).
const donutColors = computed(() =>
  isGno.value ? ['#16d97e'] : ['#16d97e', '#3fb6ff', '#b892ff', '#ff9d5c']
);

const totalValue = computed(() => {
  let value = 0;
  delegations.value?.forEach((x) => (value += format.tokenValueNumber(x.balance)));
  // USD value: bond-denom rewards only (same reason as totalsRaw).
  const bond = stakingStore.params.bond_denom;
  rewards.value?.total?.forEach((x) => {
    if (!bond || x.denom === bond) value += format.tokenValueNumber(x);
  });
  bondBalances.value?.forEach((x) => (value += format.tokenValueNumber(x)));
  unbonding.value?.forEach((x) =>
    x.entries?.forEach(
      (y) =>
        (value += format.tokenValueNumber({
          amount: y.balance,
          denom: stakingStore.params.bond_denom,
        }))
    )
  );
  // Always show a number (incl. 0.00). Price may lag — still render 0.00, not bare "$".
  return format.formatNumber(value, '0,0.00') || '0.00';
});

function loadAccount(address: string) {
  // Reset so SPA nav doesn't keep previous totals
  unbondingTotal.value = 0;
  account.value = {} as any;
  accountLoaded.value = false;
  accountLoadError.value = '';
  balances.value = [];
  delegations.value = [];
  rewards.value = {} as any;
  unbonding.value = [];

  const token = ++accountLoadToken.value;
  try {
    const decoded = fromBech32(address);
    const expected = (blockchain.current as any)?.bech32Prefix;
    if (expected && decoded.prefix !== expected) throw new Error('address prefix mismatch');
  } catch {
    accountLoadError.value = 'invalid account address';
    accountLoaded.value = true;
    txsLoading.value = false;
    return;
  }
  const rpc = blockchain.rpc;
  if (!rpc) {
    // Wait for endpoint — watch below will retry
    return;
  }

  // Atomic assign: do NOT paint account shell before balances land.
  // Prior race: getAuthAccount resolved first → hero showed "0 GNOT" for
  // ~500ms until getBankBalances finished (felt like need-refresh / wrong bal).
  const shellAccount = () =>
    ({
      '@type': isGno.value ? '/gno.BaseAccount' : '/cosmos.auth.v1beta1.BaseAccount',
      address,
      account_number: '0',
      sequence: '0',
    }) as any;

  Promise.all([
    rpc.getAuthAccount(address).catch((e: any) => {
      console.warn('[account] getAuthAccount:', e?.message || e);
      return null;
    }),
    rpc.getBankBalances(address).catch((e: any) => {
      console.warn('[account] getBankBalances:', e?.message || e);
      return { balances: [] as any[] };
    }),
  ])
    .then(([auth, bank]) => {
      if (token !== accountLoadToken.value) return;
      account.value = (auth as any)?.account || shellAccount();
      balances.value = (bank as any)?.balances || [];
      if (!(auth as any)?.account) {
        accountLoadError.value = accountLoadError.value || 'account metadata empty';
      }
    })
    .catch((e: any) => {
      if (token !== accountLoadToken.value) return;
      accountLoadError.value = e?.message || String(e);
      account.value = shellAccount();
      balances.value = [];
    })
    .finally(() => {
      if (token !== accountLoadToken.value) return;
      accountLoaded.value = true;
    });

  // Gno/TM2: no staking / distribution modules — skip empty Cosmos calls
  if (isGno.value) return;

  rpc.getDistributionDelegatorRewards?.(address).then((x) => {
    if (token !== accountLoadToken.value) return;
    rewards.value = x;
  }).catch((e: any) => console.warn('[account] rewards:', e?.message || e));
  rpc.getStakingDelegations?.(address).then((x) => {
    if (token !== accountLoadToken.value) return;
    delegations.value = x.delegation_responses;
  }).catch((e: any) => console.warn('[account] delegations:', e?.message || e));
  rpc.getStakingDelegatorUnbonding?.(address).then((x) => {
    if (token !== accountLoadToken.value) return;
    unbonding.value = x.unbonding_responses;
    x.unbonding_responses?.forEach((y) =>
      y.entries.forEach((z) => (unbondingTotal.value += Number(z.balance)))
    );
  }).catch((e: any) => console.warn('[account] unbonding:', e?.message || e));
}

/** Classify a tx as inbound (this address receives funds) or outbound
 *  (this address is the signer/sender), based on the events emitted by the
 *  tx.  Inspired by Nodes Guru's two-color pill in the tx list: a single
 *  glance tells you whether the account moved money in or out.
 *
 *  - 'in'   : this address appears as coin_received.receiver and not as
 *             message signer / transfer.sender
 *  - 'out'  : this address is the signer (auth_info.signer_infos) OR
 *             appears as coin_spent.spender / transfer.sender
 *  - 'self' : appears on both sides (self-transfer, redelegation, etc.)
 *  - '—'    : neither — e.g. governance vote where no coins move
 */
type TxDirection = 'in' | 'out' | 'self' | 'none';

function eventHasAddress(
  events: { type: string; attributes: { key: string; value: string }[] }[] | undefined,
  type: string,
  key: string,
  addr: string
): boolean {
  if (!events) return false;
  for (const ev of events) {
    if (ev.type !== type) continue;
    for (const a of ev.attributes) {
      if (a.key !== key) continue;
      if (a.value === addr) return true;
    }
  }
  return false;
}

function txDirection(txResp: any): TxDirection {
  const events = txResp?.events;
  if (!events) return 'none';
  // bank.MsgSend: events.transfer.{sender,recipient}
  const isSender = eventHasAddress(events, 'transfer', 'sender', props.address);
  const isRecipient = eventHasAddress(events, 'transfer', 'recipient', props.address);
  // Fee / generic spend: events.coin_spent.spender / events.coin_received.receiver
  const isSpender = eventHasAddress(events, 'coin_spent', 'spender', props.address);
  const isCoinReceiver = eventHasAddress(events, 'coin_received', 'receiver', props.address);
  // Some chains (and older cosmos-sdk) emit message.sender per msg
  const isMsgSender = eventHasAddress(events, 'message', 'sender', props.address);

  const sendsOut = isSender || isSpender || isMsgSender;
  const receivesIn = isRecipient || isCoinReceiver;

  if (sendsOut && receivesIn) return 'self';
  if (receivesIn) return 'in';
  if (sendsOut) return 'out';
  return 'none';
}

/** UI-friendly metadata for the direction pill (Nodes-Guru style). */
function directionMeta(dir: TxDirection) {
  switch (dir) {
    case 'in':
      return { label: 'IN', glyph: '↓', tone: 'in' as const };
    case 'out':
      return { label: 'OUT', glyph: '↑', tone: 'out' as const };
    case 'self':
      return { label: 'SELF', glyph: '↻', tone: 'self' as const };
    default:
      return { label: '—', glyph: '·', tone: 'none' as const };
  }
}

// --- presentation helpers ---
const showCopyToast = ref(0);
const tipMsg = computed(() =>
  showCopyToast.value === 2
    ? { class: 'error', msg: 'Copy failed' }
    : { class: 'success', msg: 'Address copied' }
);
async function copyAddress() {
  try {
    await navigator.clipboard.writeText(props.address);
    showCopyToast.value = 1;
  } catch {
    showCopyToast.value = 2;
  }
  setTimeout(() => (showCopyToast.value = 0), 1000);
}

/** Cheap deterministic identicon: 6×6 grid whose cells are filled from a
 *  hash of the address.  Symmetric along the vertical axis so the result
 *  is always visually balanced — looks like an SVG fingerprint. */
const identiconCells = computed(() => {
  const cells: number[] = [];
  let h = 0;
  for (let i = 0; i < props.address.length; i++) {
    h = (h * 31 + props.address.charCodeAt(i)) >>> 0;
  }
  // 6x3 unique cells, mirrored
  for (let i = 0; i < 18; i++) {
    cells.push((h >>> i) & 1);
  }
  return cells;
});
function identiconFill(bit: number, idx: number) {
  if (!bit) return 'transparent';
  // cycle through 5 hue families so avatars vary
  const palette = ['#3fb6ff', '#b892ff', '#ff8bd0', '#7fe0c4', '#f5c451'];
  return palette[idx % palette.length];
}
function shortAddr(a: string): string {
  if (!a) return '';
  return a.length > 24 ? `${a.slice(0, 14)}…${a.slice(-8)}` : a;
}
function moduleSlug(msgTypeUrl: string): string {
  if (!msgTypeUrl) return 'default';
  const t = msgTypeUrl.toLowerCase();
  if (t.includes('cosmos.bank')) return 'bank';
  if (t.includes('cosmos.staking')) return 'staking';
  if (t.includes('cosmos.distribution')) return 'distribution';
  if (t.includes('cosmos.gov')) return 'gov';
  if (t.includes('cosmos.authz')) return 'authz';
  if (t.includes('cosmos.slashing')) return 'slashing';
  if (t.includes('ibc.core')) return 'ibc';
  if (t.includes('cosmos.vesting')) return 'vesting';
  return 'default';
}
function messagePill(msgType: string) {
  const label = msgType.substring(msgType.lastIndexOf('.') + 1).replace('Msg', '');
  return { label, slug: moduleSlug(msgType) };
}

/** Sum the bond-denom amount from an arbitrary bag of coin entries. */
function findTokenAmount(
  entries: { denom: string; amount: string }[] | undefined,
  denom: string
): string {
  if (!entries) return '0';
  const x = entries.find((c) => c.denom === denom);
  return x?.amount || '0';
}
</script>
<template>
  <div v-if="accountLoadError === 'invalid account address'" class="sz-account-page p-6">
    <section class="sz-section sz-glass">
      <div class="sz-section-kicker">Account</div>
      <div class="sz-section-title">Invalid account address</div>
      <p class="mt-2 opacity-70">The address format or network prefix is not valid for this chain.</p>
    </section>
  </div>
  <div v-else-if="account && (account['@type'] || Object.keys(account).length)" class="sz-account-page">
    <!-- ====== HERO ====== -->
    <section class="sz-section sz-acc-hero mb-4 overflow-hidden">
      <!-- blueprint grid background (signature Shazoes motif) -->
      <div class="sz-acc-hero-bg" aria-hidden="true"></div>
      <div class="sz-acc-hero-inner">
        <!-- identicon avatar (12 cells, symmetric) -->
        <div class="sz-acc-avatar">
          <svg viewBox="0 0 60 60" class="sz-acc-avatar-svg">
            <g v-for="(bit, i) in identiconCells" :key="i">
              <rect
                v-if="bit"
                :x="i % 3 * 18 + 6"
                :y="Math.floor(i / 3) * 18 + 6"
                width="12"
                height="12"
                rx="2.5"
                :fill="identiconFill(bit, i)"
              />
              <rect
                v-if="bit"
                :x="48 - (i % 3 * 18)"
                :y="Math.floor(i / 3) * 18 + 6"
                width="12"
                height="12"
                rx="2.5"
                :fill="identiconFill(bit, i)"
              />
            </g>
          </svg>
        </div>

        <!-- identity + address -->
        <div class="sz-acc-id">
          <div class="sz-section-kicker mb-1">Account</div>
          <div class="sz-acc-addr-row">
            <code class="sz-acc-addr" :title="address">{{ shortAddr(address) }}</code>
            <button class="sz-acc-copy" @click="copyAddress" title="Copy address">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
          <!-- Gno related-entity chips: reduce sign vs operator confusion -->
          <div v-if="gnoRelated" class="flex flex-wrap items-center gap-1.5 mt-2">
            <RouterLink
              v-if="gnoRelated.validatorTo"
              class="sz-chip sz-chip--info !text-[10px] hover:opacity-90"
              :to="gnoRelated.validatorTo"
              :title="`Validator ${gnoRelated.moniker}`"
            >
              Validator · {{ gnoRelated.moniker }}
            </RouterLink>
            <span
              v-if="gnoRelated.isSigning"
              class="sz-chip !text-[10px]"
              title="This is the Tendermint2 signing address (consensus). It is not the balance entity."
            >Signing address</span>
            <span
              v-if="gnoRelated.isOperator"
              class="sz-chip sz-chip--ok !text-[10px]"
              title="Operator holds balance and signs valoper realm txs."
            >Operator · balance entity</span>
            <RouterLink
              v-if="gnoRelated.operatorTo"
              class="sz-chip !text-[10px] hover:underline"
              :to="gnoRelated.operatorTo"
              title="Open operator account (balance + history)"
            >Operator account →</RouterLink>
            <span
              v-if="gnoRelated.signingPlain"
              class="font-mono text-[10px] opacity-60"
              :title="gnoRelated.signingPlain"
            >sign {{ shortAddr(gnoRelated.signingPlain) }}</span>
          </div>
        </div>

        <!-- total value -->
        <div class="sz-acc-value">
          <div class="sz-section-kicker mb-1">{{ isGno ? 'Balance' : 'Total Value' }}</div>
          <div v-if="isGno" class="sz-acc-value-num">
            {{ totalAmount.toLocaleString(undefined, { maximumFractionDigits: 6 }) }}
            <span class="text-base font-semibold opacity-80">{{ bondSymbol }}</span>
          </div>
          <div v-else class="sz-acc-value-num">${{ totalValue }}</div>
          <div class="sz-acc-value-sub" v-if="!isGno && totalAmount > 0">
            {{ totalAmount.toLocaleString(undefined, { maximumFractionDigits: 2 }) }} {{ bondSymbol }} · total portfolio
          </div>
          <div class="sz-acc-value-sub" v-else-if="isGno">
            Liquid ugnot via TM2 auth/accounts · no staking modules
          </div>
        </div>
      </div>
    </section>

    <!-- ====== PORTFOLIO COMPOSITION ====== -->
    <section class="sz-section sz-glass overflow-hidden mb-4">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Portfolio</div>
          <div class="sz-section-title">{{ isGno ? 'Balances' : 'Composition' }}</div>
        </div>
      </div>
      <div class="sz-acc-comp">
        <div class="sz-acc-comp-donut">
          <DonutChart
            :series="totalAmountByCategory"
            :labels="labels"
            :colors="donutColors"
          />
        </div>
        <div class="sz-acc-comp-list">
          <div class="sz-acc-comp-row" v-for="(amt, i) in totalAmountByCategory" :key="i" :data-tone="(isGno ? ['available'] : ['available','delegated','rewards','unbonding'])[i]">
            <span class="sz-acc-comp-swatch"></span>
            <div class="flex-1 min-w-0">
              <div class="sz-acc-comp-name">{{ labels[i] }}</div>
              <div class="sz-acc-comp-bar">
                <span class="sz-acc-comp-bar-fill" :style="{ width: totalAmount > 0 ? ((amt / totalAmount) * 100).toFixed(1) + '%' : '0%' }"></span>
              </div>
            </div>
            <div class="sz-acc-comp-figures">
              <div class="sz-acc-comp-pct">{{ totalAmount > 0 && Number.isFinite(amt) ? ((amt / totalAmount) * 100).toFixed(1) : '0.0' }}%</div>
              <div class="sz-acc-comp-amount">
                {{ format.formatNumber(Number.isFinite(amt) ? amt : 0, '0,0.[000000]') }} {{ bondSymbol }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ====== SECONDARY TOKENS (dual-token chains only, e.g. PHOTON on atomone) ======
         Sits between Portfolio Composition and Staking so the donut stays a
         clean 4-category ATONE-only visualization. Hides itself when the
         account only holds the bond denom. -->
    <section
      v-if="otherBalances.length > 0"
      class="sz-section sz-glass overflow-hidden mb-4"
    >
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Other tokens</div>
          <div class="sz-section-title">Secondary balances</div>
        </div>
      </div>
      <div class="sz-acc-tokens">
        <div
          v-for="(c, i) in otherBalances"
          :key="i"
          class="sz-acc-token-row"
        >
          <span class="sz-acc-token-swatch"></span>
          <div class="flex-1 min-w-0">
            <div class="sz-acc-token-name">
              {{ format.tokenDisplayDenom(c.denom)?.toUpperCase() || c.denom }}
            </div>
            <div class="sz-acc-token-denom">{{ c.denom }}</div>
          </div>
          <div class="sz-acc-token-amount">
            {{ format.formatToken(c, true, '0,0.[000000]') }}
          </div>
        </div>
      </div>
    </section>

    <!-- ====== DELEGATIONS (Cosmos only) ====== -->
    <section v-if="!isGno" class="sz-section sz-glass overflow-hidden mb-4">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Staking</div>
          <div class="sz-section-title">{{ $t('account.delegations') }} ({{ delegations.length }})</div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="sz-table sz-acc-table">
          <thead>
            <tr>
              <th>{{ $t('account.validator') }}</th>
              <th class="text-right">{{ $t('account.delegation') }}</th>
              <th class="text-right">{{ $t('account.rewards') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!delegations.length">
              <td colspan="3" class="sz-acc-empty">{{ $t('account.no_delegations') }}</td>
            </tr>
            <tr v-for="(v, index) in delegations" :key="index">
              <td>
                <RouterLink class="sz-acc-validator" :to="`/${chain}/validator/${v.delegation.validator_address}`">
                  <span class="sz-acc-validator-icon">{{ (format.validatorFromBech32(v.delegation.validator_address) || v.delegation.validator_address).slice(0, 2).toUpperCase() }}</span>
                  <span class="sz-acc-validator-name">{{ format.validatorFromBech32(v.delegation.validator_address) || v.delegation.validator_address }}</span>
                </RouterLink>
              </td>
              <td class="text-right sz-acc-num">
                {{ format.formatToken(v.balance, true, '0,0.[000000]') }}
              </td>
              <td class="text-right sz-acc-num">
                {{
                  format.formatTokens(
                    rewards?.rewards?.find((x) => x.validator_address === v.delegation.validator_address)?.reward
                  ) || '—'
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ====== UNBONDING ====== -->
    <section class="sz-section sz-glass overflow-hidden mb-4" v-if="unbonding && unbonding.length > 0">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Staking</div>
          <div class="sz-section-title">{{ $t('account.unbonding_delegations') }} ({{ unbonding.length }})</div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="sz-table sz-acc-table">
          <thead>
            <tr>
              <th>{{ $t('account.validator') }}</th>
              <th class="text-right">{{ $t('account.creation_height') }}</th>
              <th class="text-right">{{ $t('account.initial_balance') }}</th>
              <th class="text-right">{{ $t('account.balance') }}</th>
              <th class="text-right">{{ $t('account.completion_time') }}</th>
            </tr>
          </thead>
          <tbody v-for="(v, index) in unbonding" :key="index">
            <tr class="sz-acc-tr-group">
              <td colspan="5">
                <RouterLink class="sz-acc-tr-validator" :to="`/${chain}/validator/${v.validator_address}`">
                  <span class="sz-acc-validator-icon">{{ (format.validatorFromBech32(v.validator_address) || v.validator_address).slice(0, 2).toUpperCase() }}</span>
                  <span class="sz-acc-validator-name">{{ format.validatorFromBech32(v.validator_address) || v.validator_address }}</span>
                </RouterLink>
              </td>
            </tr>
            <tr v-for="entry in v.entries" :key="entry.creation_height + entry.completion_time">
              <td></td>
              <td class="text-right sz-acc-num">{{ entry.creation_height }}</td>
              <td class="text-right sz-acc-num">
                {{ format.formatToken({ amount: entry.initial_balance, denom: stakingStore.params.bond_denom }, true, '0,0.[00]') }}
              </td>
              <td class="text-right sz-acc-num">
                {{ format.formatToken({ amount: entry.balance, denom: stakingStore.params.bond_denom }, true, '0,0.[00]') }}
              </td>
              <td class="text-right">
                <Countdown :time="new Date(entry.completion_time).getTime() - new Date().getTime()" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- TRANSACTIONS -->
    <section class="sz-section overflow-hidden">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">
            Activity
          </div>
          <div class="sz-section-title">
            {{ $t('account.transactions') }} ({{ txsTotal ? format.formatNumber(txsTotal, '0,0') : (isGno ? gnoTxs.length : txs.length) }})
            <span v-if="!isGno && serverMode" class="sz-acc-section-meta">showing {{ serverTxs.length }} of {{ format.formatNumber(serverTotal, '0,0') }} · paginated</span>
            <span v-else-if="!isGno && txsTotal > allTxs.length" class="sz-acc-section-meta">showing {{ format.formatNumber(allTxs.length, '0,0') }} of {{ format.formatNumber(txsTotal, '0,0') }}</span>
            <span v-if="isGno && gnoTxs.length" class="sz-acc-section-meta">
              showing {{ gnoTxsPage.length }} of {{ format.formatNumber(gnoTxs.length, '0,0') }}{{ gnoTxsHasNext ? '+' : '' }} · via indexer
            </span>
            <span v-else-if="isGno" class="sz-acc-section-meta">via indexer</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <div class="sz-acc-page-size">
            <button
              v-for="size in [5, 10, 20, 50]"
              :key="size"
              class="sz-acc-page-btn"
              :class="{ 'sz-acc-page-btn--active': txHistoryLimit === size }"
              @click="setTxHistorySize(size)"
            >
              {{ size }}
            </button>
          </div>
        </div>
      </div>

      <!-- Gno: indexer-backed history (amountIn/Out shape) — same pager UX as Cosmos -->
      <div v-if="isGno" class="overflow-x-auto">
        <table class="sz-table sz-acc-table">
          <thead>
            <tr>
              <th style="width: 12%">Height</th>
              <th style="width: 22%">Hash</th>
              <th>Function</th>
              <th style="width: 14%">Amount</th>
              <th style="width: 10%">Dir</th>
              <th style="width: 16%" class="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="txsLoading && !gnoTxs.length">
              <td colspan="6" class="sz-acc-empty">
                <div class="flex items-center justify-center gap-3">
                  <div class="sz-acc-loading-spinner" />
                  <span class="sz-acc-loading-text">Fetching history from indexer…</span>
                </div>
              </td>
            </tr>
            <tr v-else-if="gnoTxsError && !gnoTxs.length">
              <td colspan="6" class="sz-acc-empty">Failed to load history: {{ gnoTxsError }}</td>
            </tr>
            <tr v-else-if="!gnoTxs.length">
              <td colspan="6" class="sz-acc-empty">{{ $t('account.no_transactions') }}</td>
            </tr>
            <tr v-for="(tx, index) in gnoTxsPage" :key="tx.txHash || index">
              <td class="sz-acc-num">
                <RouterLink v-if="tx.blockHeight" :to="`/${chain}/block/${tx.blockHeight}`" class="sz-acc-link">#{{ tx.blockHeight }}</RouterLink>
                <span v-else>—</span>
              </td>
              <td class="truncate" style="max-width: 220px">
                <RouterLink
                  v-if="tx.txHash"
                  :to="`/${chain}/tx/${encodeURIComponent(tx.txHash)}`"
                  class="sz-acc-link sz-acc-hash"
                >{{ shortGnoHash(tx.txHash) }}</RouterLink>
                <span v-else>—</span>
              </td>
              <td>
                <span class="sz-msg-pill">{{ gnoFuncLabel(tx) }}</span>
                <span v-if="tx.successYn" class="sz-status sz-status--ok ml-1" title="Success"><span class="sz-status-glyph">✓</span>OK</span>
                <span v-else class="sz-status sz-status--fail ml-1" title="Failed"><span class="sz-status-glyph">✕</span></span>
              </td>
              <td class="font-mono text-xs">{{ gnoAmountLabel(tx) }}</td>
              <td>
                <span
                  class="sz-acc-direction"
                  :data-tone="gnoDirection(tx, address)"
                  :title="`Direction: ${gnoDirection(tx, address)}`"
                >
                  <span class="sz-acc-direction-glyph">{{ gnoDirection(tx, address) === 'in' ? '↓' : gnoDirection(tx, address) === 'out' ? '↑' : '·' }}</span>
                  {{ gnoDirection(tx, address) === 'in' ? 'IN' : gnoDirection(tx, address) === 'out' ? 'OUT' : '—' }}
                </span>
              </td>
              <td class="text-right sz-acc-time">
                <div class="sz-acc-time-rel">{{ tx.timestamp ? format.toDay(tx.timestamp, 'from') : '—' }}</div>
                <div class="sz-acc-time-abs">{{ tx.timestamp ? format.toLocaleDate(tx.timestamp) : '' }}</div>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="sz-acc-pager" v-if="gnoTxs.length > txHistoryLimit || gnoTxsHasNext">
          <button class="sz-acc-pager-btn" :disabled="txHistoryPage === 1" @click="setTxHistoryPage(txHistoryPage - 1)">← Prev</button>
          <span class="sz-acc-pager-info">
            Page {{ txHistoryPage }} / {{ gnoHistoryPageCount }}{{ gnoTxsHasNext ? '+' : '' }}
            <span class="sz-acc-pager-loaded text-[10px] opacity-60 ml-1">({{ gnoTxs.length }} loaded{{ gnoTxsHasNext ? ', more available' : '' }})</span>
          </span>
          <button
            class="sz-acc-pager-btn"
            :disabled="txHistoryPage * txHistoryLimit >= gnoTxs.length && !gnoTxsHasNext"
            @click="setTxHistoryPage(txHistoryPage + 1)"
          >Next →</button>
          <button
            v-if="gnoTxsHasNext"
            class="sz-acc-pager-btn ml-2"
            :disabled="gnoTxsLoadingMore"
            @click="loadMoreGnoTxs"
          >{{ gnoTxsLoadingMore ? 'Loading…' : 'Fetch more' }}</button>
        </div>
      </div>

      <!-- Cosmos LCD archive history -->
      <div v-else class="overflow-x-auto">
        <table class="sz-table sz-acc-table">
          <thead>
            <tr>
              <th style="width: 14%">{{ $t('account.height') }}</th>
              <th style="width: 22%">{{ $t('account.hash') }}</th>
              <th>{{ $t('account.messages') }}</th>
              <th style="width: 10%">Direction</th>
              <th style="width: 18%" class="text-right">{{ $t('account.time') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="(txsLoading || serverPageLoading) && !txs.length">
              <td colspan="5" class="sz-acc-empty">
                <div class="flex items-center justify-center gap-3">
                  <div class="sz-acc-loading-spinner" />
                  <span class="sz-acc-loading-text">Fetching history from archive…</span>
                </div>
              </td>
            </tr>
            <tr v-else-if="!txs.length">
              <td colspan="5" class="sz-acc-empty">{{ $t('account.no_transactions') }}</td>
            </tr>
            <tr v-for="(v, index) in txs" :key="v.txhash || index">
              <td class="sz-acc-num">
                <RouterLink :to="`/${chain}/block/${v.height}`" class="sz-acc-link">#{{ v.height }}</RouterLink>
              </td>
              <td class="truncate" style="max-width: 220px">
                <RouterLink :to="`/${chain}/tx/${v.txhash}`" class="sz-acc-link sz-acc-hash">{{ v.txhash.slice(0, 10) }}…{{ v.txhash.slice(-8) }}</RouterLink>
              </td>
              <td>
                <div class="sz-acc-msg-row">
                  <span v-for="(m, mi) in v.tx?.body?.messages?.slice(0, 2) || []" :key="mi" class="sz-msg-pill" :data-module="messagePill(m['@type'] || '').slug">
                    {{ messagePill(m['@type'] || '').label }}
                  </span>
                  <span v-if="(v.tx?.body?.messages?.length || 0) > 2" class="sz-msg-pill sz-msg-pill--more">
                    +{{ v.tx.body.messages.length - 2 }}
                  </span>
                  <span v-if="v.code === 0" class="sz-status sz-status--ok" title="Success"><span class="sz-status-glyph">✓</span>OK</span>
                  <span v-else class="sz-status sz-status--fail" :title="`Failed ${v.code}`"><span class="sz-status-glyph">✕</span>{{ v.code }}</span>
                </div>
              </td>
              <td>
                <span
                  v-if="directionMeta(txDirection(v)).tone !== 'none'"
                  class="sz-acc-direction"
                  :data-tone="directionMeta(txDirection(v)).tone"
                  :title="`Direction: ${directionMeta(txDirection(v)).label}`"
                >
                  <span class="sz-acc-direction-glyph">{{ directionMeta(txDirection(v)).glyph }}</span>
                  {{ directionMeta(txDirection(v)).label }}
                </span>
                <span v-else class="sz-acc-direction sz-acc-direction--none" title="No fund movement for this address">
                  <span class="sz-acc-direction-glyph">·</span>
                  —
                </span>
              </td>
              <td class="text-right sz-acc-time">
                <div class="sz-acc-time-rel">{{ format.toDay(v.timestamp, 'from') }}</div>
                <div class="sz-acc-time-abs">{{ format.toLocaleDate(v.timestamp) }}</div>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="sz-acc-pager" v-if="serverMode ? serverTotal > txHistoryLimit : allTxs.length > txHistoryLimit">
          <button class="sz-acc-pager-btn" :disabled="txHistoryPage === 1 || serverPageLoading" @click="setTxHistoryPage(txHistoryPage - 1)">← Prev</button>
          <span class="sz-acc-pager-info">Page {{ txHistoryPage }} / {{ Math.max(1, Math.ceil((serverMode ? serverTotal : allTxs.length) / txHistoryLimit)) }}{{ serverPageLoading ? ' · loading…' : '' }}</span>
          <button
            class="sz-acc-pager-btn"
            :disabled="(serverMode ? txHistoryPage >= Math.ceil(serverTotal / txHistoryLimit) : txHistoryPage * txHistoryLimit >= allTxs.length) || serverPageLoading"
            @click="setTxHistoryPage(txHistoryPage + 1)"
          >Next →</button>
        </div>
      </div>
    </section>

    <!-- (On-chain card removed — not needed on a details page) -->

  </div>
  <div v-else>
    <div class="sz-section sz-glass p-6 text-center">
      <div v-if="!accountLoaded" class="sz-acc-loading-spinner mx-auto mb-3"></div>
      <div class="sz-acc-loading-text">
        <template v-if="!accountLoaded">{{ $t('account.error') || 'Loading account…' }}</template>
        <template v-else-if="accountLoadError">Failed to load account: {{ accountLoadError }}</template>
        <template v-else>Account not found on this chain.</template>
      </div>
      <div v-if="accountLoaded" class="mt-3 font-mono text-xs break-all text-secondary">{{ address }}</div>
    </div>
  </div>

  <!-- toast -->
  <div class="toast" v-show="showCopyToast === 1">
    <div class="alert alert-success">
      <div class="text-xs md:!text-sm"><span>{{ tipMsg.msg }}</span></div>
    </div>
  </div>
  <div class="toast" v-show="showCopyToast === 2">
    <div class="alert alert-error">
      <div class="text-xs md:!text-sm"><span>{{ tipMsg.msg }}</span></div>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
   SHAZOES ACCOUNT PAGE — distinctive visual language.

   Three signature motifs:
   1. blueprint grid + gradient line in the hero (engineered card)
   2. 12-cell symmetric SVG identicon (deterministic fingerprint)
   3. tone-coded metric strip with share-of-portfolio bars
   ============================================================ */

/* ============ HERO ============ */
.sz-account-page {
  --acc-tone-available:   #16d97e;
  --acc-tone-delegated:   #3fb6ff;
  --acc-tone-rewards:     #b892ff;
  --acc-tone-unbonding:   #ff9d5c;

  --acc-tx-row-hover: color-mix(in srgb, hsl(var(--p)) 6%, transparent);
}

.sz-acc-hero {
  position: relative;
  background:
    radial-gradient(ellipse 80% 60% at 18% 8%, color-mix(in srgb, hsl(var(--p)) 18%, transparent) 0%, transparent 55%),
    radial-gradient(ellipse 50% 50% at 95% 100%, color-mix(in srgb, var(--acc-tone-rewards) 16%, transparent) 0%, transparent 60%),
    linear-gradient(180deg, color-mix(in srgb, hsl(var(--b1)) 96%, transparent), hsl(var(--b1)));
}
.sz-acc-hero-bg {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(to right, color-mix(in srgb, hsl(var(--bc)) 5%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in srgb, hsl(var(--bc)) 5%, transparent) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: linear-gradient(180deg, black, black 60%, transparent 100%);
  pointer-events: none;
}
.sz-acc-hero-inner {
  position: relative;
  padding: 1.4rem 1.4rem 1.4rem;
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 1.4rem;
  align-items: center;
}
@media (max-width: 900px) {
  .sz-acc-hero-inner {
    grid-template-columns: auto 1fr;
    gap: 1rem;
  }
  .sz-acc-value { grid-column: 1 / -1; }
  .sz-acc-actions { grid-column: 1 / -1; }
}

/* identicon avatar */
.sz-acc-avatar {
  width: 5.25rem;
  height: 5.25rem;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--sz-border);
  padding: 8px;
  box-shadow:
    0 8px 24px color-mix(in srgb, hsl(var(--p)) 12%, transparent),
    inset 0 0 0 1px rgba(255, 255, 255, 0.4);
}
.sz-acc-avatar-svg { display: block; width: 100%; height: 100%; }

/* identity + address */
.sz-acc-id { min-width: 0; }
.sz-acc-addr-row { display: flex; align-items: center; gap: 0.4rem; }
.sz-acc-addr {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-main);
  letter-spacing: -0.01em;
  word-break: break-all;
}
/* shrink address on narrow screens so the shortened form stays tidy */
@media (max-width: 540px) {
  .sz-acc-addr { font-size: 0.88rem; }
}
.sz-acc-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--sz-border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.sz-acc-copy:hover {
  color: hsl(var(--p));
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, var(--sz-border));
  background: var(--sz-accent-soft);
}

/* total value */
.sz-acc-value { text-align: right; min-width: 220px; }
.sz-acc-value-num {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 1.7rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--text-main);
  background: linear-gradient(180deg, var(--text-main), color-mix(in srgb, hsl(var(--p)) 70%, var(--text-main)));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  line-height: 1.05;
}
.sz-acc-value-sub {
  margin-top: 0.18rem;
  font-size: 11px;
  color: var(--text-secondary);
}

/* actions */
.sz-acc-actions { display: inline-flex; gap: 0.45rem; flex-wrap: wrap; }
.sz-acc-action {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 0.85rem;
  border-radius: 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-main);
  background: color-mix(in srgb, hsl(var(--b1)) 88%, transparent);
  border: 1px solid var(--sz-border);
  cursor: pointer;
  transition: all 0.16s ease;
}
.sz-acc-action svg, .sz-acc-action :deep(svg) { font-size: 15px; }
.sz-acc-action:hover {
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, var(--sz-border));
  background: var(--sz-accent-soft);
  transform: translateY(-1px);
}
.sz-acc-action--primary {
  color: white;
  background: hsl(var(--p));
  border-color: hsl(var(--p));
  box-shadow: 0 4px 14px color-mix(in srgb, hsl(var(--p)) 35%, transparent);
}
.sz-acc-action--primary:hover {
  background: color-mix(in srgb, hsl(var(--p)) 92%, white);
  border-color: color-mix(in srgb, hsl(var(--p)) 92%, white);
  color: white;
}

/* ============ METRIC STRIP ============ */
.sz-acc-mb-4 { margin-bottom: 1rem; }
.sz-acc-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.85rem;
}
@media (max-width: 1100px) { .sz-acc-metrics { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 540px)  { .sz-acc-metrics { grid-template-columns: 1fr; } }

.sz-acc-metric { display: flex; align-items: stretch; gap: 0.8rem; padding: 0.9rem 1rem; }
.sz-acc-metric-icon {
  width: 40px; height: 40px;
  border-radius: 11px;
  flex-shrink: 0;
}
.sz-acc-metric-icon[data-tone='available']   { background: color-mix(in srgb, var(--acc-tone-available) 12%, transparent); color: var(--acc-tone-available); }
.sz-acc-metric-icon[data-tone='delegated']   { background: color-mix(in srgb, var(--acc-tone-delegated) 12%, transparent); color: var(--acc-tone-delegated); }
.sz-acc-metric-icon[data-tone='rewards']     { background: color-mix(in srgb, var(--acc-tone-rewards) 14%, transparent); color: var(--acc-tone-rewards); }
.sz-acc-metric-icon[data-tone='unbonding']   { background: color-mix(in srgb, var(--acc-tone-unbonding) 12%, transparent); color: var(--acc-tone-unbonding); }

/* share-of-portfolio bar */
.sz-acc-share {
  position: relative;
  margin-top: 0.42rem;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, hsl(var(--bc)) 7%, transparent);
  overflow: hidden;
}
.sz-acc-share-fill {
  position: absolute;
  inset: 0 auto 0 0;
  display: block;
  border-radius: inherit;
  animation: sz-acc-share-grow 0.7s cubic-bezier(0.22, 1, 0.36, 1);
}
.sz-acc-share-fill[data-tone='available'] { background: var(--acc-tone-available); }
.sz-acc-share-fill[data-tone='delegated'] { background: var(--acc-tone-delegated); }
.sz-acc-share-fill[data-tone='rewards']   { background: var(--acc-tone-rewards); }
.sz-acc-share-fill[data-tone='unbonding'] { background: var(--acc-tone-unbonding); }
@keyframes sz-acc-share-grow {
  from { width: 0 !important; }
}
.sz-acc-share-text {
  position: absolute;
  right: 0;
  top: -16px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

/* ============ PORTFOLIO COMPOSITION ============ */
.sz-acc-comp {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 1.2rem;
  padding: 1.1rem 1.2rem;
  align-items: center;
}
@media (max-width: 700px) {
  .sz-acc-comp { grid-template-columns: 1fr; }
}
.sz-acc-comp-donut { display: flex; align-items: center; justify-content: center; }
.sz-acc-comp-list { display: flex; flex-direction: column; gap: 0.7rem; }
.sz-acc-comp-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem 0.6rem;
  border-radius: 10px;
  transition: background 0.15s ease;
}
.sz-acc-comp-row:hover { background: color-mix(in srgb, hsl(var(--bc)) 5%, transparent); }
.sz-acc-comp-swatch {
  width: 10px; height: 10px; border-radius: 999px; flex-shrink: 0;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 24%, transparent);
}
.sz-acc-comp-row[data-tone='available'] { --comp-color: var(--acc-tone-available); }
.sz-acc-comp-row[data-tone='delegated'] { --comp-color: var(--acc-tone-delegated); }
.sz-acc-comp-row[data-tone='rewards']   { --comp-color: var(--acc-tone-rewards); }
.sz-acc-comp-row[data-tone='unbonding'] { --comp-color: var(--acc-tone-unbonding); }
.sz-acc-comp-row { color: var(--comp-color); }
.sz-acc-comp-name {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.sz-acc-comp-bar {
  margin-top: 0.32rem;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, hsl(var(--bc)) 7%, transparent);
  overflow: hidden;
}
.sz-acc-comp-bar-fill {
  display: block;
  height: 100%;
  background: var(--comp-color);
  border-radius: inherit;
  animation: sz-acc-share-grow 0.7s cubic-bezier(0.22, 1, 0.36, 1);
}
.sz-acc-comp-figures { text-align: right; min-width: 100px; }
.sz-acc-comp-pct {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-main);
}
.sz-acc-comp-amount {
  font-size: 10.5px;
  color: var(--text-secondary);
  margin-top: 1px;
}

/* ============ TABLES ============ */
.sz-acc-table { width: 100%; }
.sz-acc-table thead th {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-secondary);
  padding: 0.85rem 1rem;
  background: transparent;
  border-bottom: 1px solid var(--sz-border);
}
.sz-acc-table tbody td {
  padding: 0.78rem 1rem;
  border-bottom: 1px solid color-mix(in srgb, var(--sz-border) 50%, transparent);
  vertical-align: middle;
}
.sz-acc-table tbody tr:last-child td { border-bottom: none; }
.sz-acc-table tbody tr:hover { background: var(--acc-tx-row-hover); }
.sz-acc-num { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; color: var(--text-main); }
.sz-acc-link {
  color: hsl(var(--p));
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  text-decoration: none;
  transition: opacity 0.14s ease;
}
.sz-acc-link:hover { opacity: 0.7; }
.sz-acc-hash { font-weight: 600; }
.sz-acc-validator {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  text-decoration: none;
  color: var(--text-main);
  font-weight: 600;
  font-size: 12.5px;
}
.sz-acc-validator:hover .sz-acc-validator-name { color: hsl(var(--p)); }
.sz-acc-validator-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--sz-accent-soft);
  color: hsl(var(--p));
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.04em;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  flex-shrink: 0;
}
.sz-acc-validator-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.14s ease;
}

/* row icon buttons (validator actions) */
.sz-acc-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.sz-acc-row-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--sz-border);
  background: transparent;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.sz-acc-row-btn:hover {
  color: hsl(var(--p));
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, var(--sz-border));
  background: var(--sz-accent-soft);
}
.sz-acc-row-btn--danger:hover { color: #ef4444; border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.08); }

/* header button row (Delegations) */
.sz-acc-btn {
  display: inline-flex;
  align-items: center;
  padding: 0.36rem 0.72rem;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-main);
  background: transparent;
  border: 1px solid var(--sz-border);
  cursor: pointer;
  transition: all 0.15s ease;
}
.sz-acc-btn:hover {
  color: hsl(var(--p));
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, var(--sz-border));
  background: var(--sz-accent-soft);
}
.sz-acc-btn--primary {
  color: white;
  background: hsl(var(--p));
  border-color: hsl(var(--p));
}
.sz-acc-btn--primary:hover {
  background: color-mix(in srgb, hsl(var(--p)) 88%, white);
  color: white;
}

/* message-row inside transactions */
.sz-acc-msg-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

/* time column (relative + absolute stacked) */
.sz-acc-time-rel { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; font-weight: 600; color: var(--text-main); }
.sz-acc-time-abs { font-size: 10.5px; color: var(--text-secondary); margin-top: 1px; }

/* unbonding group row */
.sz-acc-tr-group { background: color-mix(in srgb, hsl(var(--bc)) 5%, transparent); }
.sz-acc-tr-group td { padding: 0.55rem 1rem !important; border-bottom: none !important; }
.sz-acc-tr-validator {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  text-decoration: none;
  color: var(--text-main);
  font-weight: 700;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* empty cell */
.sz-acc-empty { text-align: center; color: var(--text-secondary); padding: 2rem 1rem !important; font-size: 13px; }

/* loading */
.sz-acc-loading-spinner {
  width: 32px; height: 32px;
  border-radius: 999px;
  border: 3px solid color-mix(in srgb, hsl(var(--p)) 14%, transparent);
  border-top-color: hsl(var(--p));
  animation: sz-acc-spin 0.8s linear infinite;
}
@keyframes sz-acc-spin { to { transform: rotate(360deg); } }
.sz-acc-loading-text { font-size: 13px; color: var(--text-secondary); }

/* responsive shrink for hero on narrow screens */
@media (max-width: 700px) {
  .sz-acc-hero-inner { grid-template-columns: auto 1fr; }
  .sz-acc-value { text-align: left; grid-column: 1 / -1; }
  .sz-acc-value-num { font-size: 1.35rem; }
}

/* ============================================================
   ARCHIVE HISTORY — distinctive "archive" badge + pagination.
   Shazoes-only: 1px monospaced badge with archive glyph.
   ============================================================ */
.sz-acc-archive-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.18rem 0.55rem 0.2rem;
  border-radius: 6px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: color-mix(in srgb, #16d97e 80%, white);
  background: color-mix(in srgb, #16d97e 12%, transparent);
  border: 1px solid color-mix(in srgb, #16d97e 35%, transparent);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}
.sz-acc-archive-badge svg { opacity: 0.9; }

/* ============ DIRECTION PILL (Nodes-Guru-style IN/OUT) ============ */
/* Single column that folds both sent and received txs into one stream.
   Three tones — in (funds arrived), out (funds left), self (round-trip) —
   plus a neutral dash for messages that don't move coins (votes, etc.). */
.sz-acc-direction {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  padding: 0.18rem 0.55rem 0.18rem 0.45rem;
  border-radius: 999px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  line-height: 1;
  border: 1px solid transparent;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.sz-acc-direction-glyph {
  font-size: 12px;
  line-height: 1;
  font-weight: 700;
  transform: translateY(-0.5px);
}
/* IN — funds arrived */
.sz-acc-direction[data-tone='in'] {
  color: #0fbf6a;
  background: color-mix(in srgb, #16d97e 14%, transparent);
  border-color: color-mix(in srgb, #16d97e 42%, transparent);
}
.sz-acc-direction[data-tone='in'] .sz-acc-direction-glyph { color: #16d97e; }
/* OUT — funds left */
.sz-acc-direction[data-tone='out'] {
  color: #ff7a59;
  background: color-mix(in srgb, #ff7a59 12%, transparent);
  border-color: color-mix(in srgb, #ff7a59 40%, transparent);
}
.sz-acc-direction[data-tone='out'] .sz-acc-direction-glyph { color: #ff7a59; }
/* SELF — both sides (redelegate, self-send, etc.) */
.sz-acc-direction[data-tone='self'] {
  color: #b892ff;
  background: color-mix(in srgb, #b892ff 12%, transparent);
  border-color: color-mix(in srgb, #b892ff 40%, transparent);
}
.sz-acc-direction[data-tone='self'] .sz-acc-direction-glyph { color: #b892ff; }
/* NONE — no fund movement (governance, etc.) */
.sz-acc-direction--none {
  color: var(--text-secondary);
  background: transparent;
  border-color: color-mix(in srgb, hsl(var(--bc)) 10%, transparent);
  font-weight: 600;
  opacity: 0.6;
}

.sz-acc-section-meta {
  margin-left: 0.5rem;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

/* page-size cluster [5 | 10 | 20 | 50] */
.sz-acc-page-size {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 10px;
  background: color-mix(in srgb, hsl(var(--bc)) 5%, transparent);
  border: 1px solid var(--sz-border);
}
.sz-acc-page-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 26px;
  padding: 0 0.5rem;
  border-radius: 7px;
  background: transparent;
  border: none;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.14s ease, background 0.14s ease;
}
.sz-acc-page-btn:hover {
  color: var(--text-main);
  background: color-mix(in srgb, hsl(var(--bc)) 6%, transparent);
}
.sz-acc-page-btn--active {
  color: white;
  background: hsl(var(--p));
  box-shadow: 0 2px 8px color-mix(in srgb, hsl(var(--p)) 28%, transparent);
}
.sz-acc-page-btn--active:hover {
  color: white;
  background: color-mix(in srgb, hsl(var(--p)) 88%, white);
}

/* pager */
.sz-acc-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  padding: 0.85rem 1rem 0.95rem;
  border-top: 1px solid color-mix(in srgb, var(--sz-border) 70%, transparent);
}
.sz-acc-pager-btn {
  display: inline-flex;
  align-items: center;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 700;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  color: var(--text-main);
  background: transparent;
  border: 1px solid var(--sz-border);
  cursor: pointer;
  transition: all 0.14s ease;
}
.sz-acc-pager-btn:hover:not(:disabled) {
  color: hsl(var(--p));
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, var(--sz-border));
  background: var(--sz-accent-soft);
}
.sz-acc-pager-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.sz-acc-pager-info {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.sz-acc-loading { opacity: 1; transition: opacity 0.2s ease; }

/* ============ SECONDARY TOKEN STRIP ============ */
.sz-acc-tokens {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.sz-acc-token-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.65rem 0.85rem;
  border-radius: 10px;
  background: color-mix(in srgb, hsl(var(--bc)) 3.5%, transparent);
  border: 1px solid var(--sz-border);
  transition: background 0.15s ease, border-color 0.15s ease;
}
.sz-acc-token-row:hover {
  background: color-mix(in srgb, hsl(var(--p)) 5%, transparent);
  border-color: color-mix(in srgb, hsl(var(--p)) 25%, var(--sz-border));
}
.sz-acc-token-swatch {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
  /* PHOTON on atomone — distinct cyan tone so it doesn't fight ATONE's green.
     Falls back to primary if the chain has no other-tone preset. */
  background: #5fe6e0;
  box-shadow: 0 0 0 3px color-mix(in srgb, #5fe6e0 26%, transparent);
}
.sz-acc-token-name {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: hsl(var(--bc));
}
.sz-acc-token-denom {
  font-size: 10.5px;
  color: color-mix(in srgb, hsl(var(--bc)) 45%, transparent);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  margin-top: 0.1rem;
}
.sz-acc-token-amount {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 13px;
  font-weight: 600;
  text-align: right;
  color: hsl(var(--bc));
  white-space: nowrap;
}
</style>


