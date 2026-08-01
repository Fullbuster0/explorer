<script setup lang="ts">
import { parseCoins } from '@cosmjs/stargate';
import {
  useBankStore,
  useBaseStore,
  useBlockchain,
  useDistributionStore,
  useFormatter,
  useMintStore,
  useStakingStore,
  useTxDialog,
} from '@/stores';
import { onMounted, onUnmounted, computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import CommissionRate from '@/components/ValidatorCommissionRate.vue';
import { consensusPubkeyToHexAddress, operatorAddressToAccount, pubKeyToValcons } from '@/libs';
import {
  PageRequest,
  type Coin,
  type Delegation,
  type PaginatedDelegations,
  type PaginatedTxs,
  type Validator,
} from '@/types';
import PaginationBar from '@/components/PaginationBar.vue';
import { fromBase64, toBase64 } from '@cosmjs/encoding';
import { stringToUint8Array, uint8ArrayToString } from '@/libs/utils';
import { lookupGnoValoper, initGnoValopers, gnoValoperProfileUrl, type GnoValoper } from '@/libs/gno/valopers';
import { getGnoIndexer, type GnoTx } from '@/libs/gno/indexer';
import { tm2Get } from '@/libs/gno/tm2';

const props = defineProps(['validator', 'chain']);

const staking = useStakingStore();
const blockchain = useBlockchain();
const baseStore = useBaseStore();
const format = useFormatter();
const dialog = useTxDialog();

/** Gno/TM2 — no Cosmos staking/delegation. Hide all wallet CTAs. */
const isGno = computed(
  () => blockchain.current?.engine === 'gno' || blockchain.current?.engine === 'tm2'
);

// Reactive validator address — updates on SPA navigation
const validator = computed(() => props.validator || '');

const v = ref({} as Validator);
const cache = JSON.parse(localStorage.getItem('avatars') || '{}');
const avatars = ref(cache || {});
const identity = ref('');
const rewards = ref([] as Coin[] | undefined);
const commission = ref([] as Coin[] | undefined);
const delegations = ref({} as PaginatedDelegations);
const addresses = ref(
  {} as {
    account: string;
    operAddress: string;
    hex: string;
    valCons: string;
  }
);
const selfBonded = ref({} as Delegation);
const txs = ref({} as PaginatedTxs);
const events = ref({} as PaginatedTxs);
const delegatorTotal = ref(0);
const delegationsLoading = ref(false);

/** Gno/TM2 — full valoper profile from the official realm registry (Indonode-style). */
const gnoMeta = ref<GnoValoper | undefined>(undefined);
/** Gno/TM2 — live on-chain status + voting power from the onbloc indexer. */
const gnoChain = ref<{ status?: string; votingPower?: string; proposerPriority?: string } | undefined>(
  undefined
);

/**
 * Sanitize an attacker-controllable URL before it goes into an <a :href>.
 * Validator description fields (website/socials) are ON-CHAIN data — any
 * validator can set them to `javascript:alert(document.cookie)`, which would
 * be stored XSS executed in this explorer's origin for every visitor who
 * clicks the link (rel="noopener" does NOT neutralize javascript: hrefs).
 * Allow only http(s); upgrade bare domains; neuter every other scheme
 * (javascript:, data:, vbscript:, file:, …) to a dead '#' link.
 */
function safeUrl(u?: string): string {
  const s = (u || '').trim();
  if (!s) return '#';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '#'; // any other scheme → block
  return `https://${s}`; // bare domain → https
}

/**
 * security_contact is on-chain (validator-controlled). A raw `'mailto:' + x`
 * lets a validator inject mail headers (`x@y?cc=spam&subject=phish`) or worse.
 * Strict-validate as a plain address; anything else → dead '#' link.
 */
function safeMailto(u?: string): string {
  const s = (u || '').trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? `mailto:${s}` : '#';
}

/** Gno/TM2 — live consensus data from TM2 RPC (UTSA-style status panel). */
const gnoRpc = ref<{
  height?: string;
  votingPower?: string;
  vpShare?: string;
  proposerPriority?: string;
  consensusKeyType?: string;
  consensusPubKey?: string;
} | undefined>(undefined);

/** Gno/TM2 liquid balances for the signing + operator addresses (no staking). */
const gnoBalances = ref<{
  signing?: { amount: string; denom: string }[];
  operator?: { amount: string; denom: string }[];
  loading: boolean;
}>({ loading: false });
const gnoBalancesToken = ref(0);

function formatGnoBal(coins?: { amount: string; denom: string }[]): string {
  if (!coins?.length) return '0 GNOT';
  const ugnot = coins.find((c) => c.denom === 'ugnot') || coins[0];
  if (!ugnot) return '0 GNOT';
  const raw = Number(ugnot.amount);
  if (!Number.isFinite(raw)) return '0 GNOT';
  const gnot = raw / 1e6;
  return `${gnot.toLocaleString(undefined, { maximumFractionDigits: 6 })} GNOT`;
}

async function loadGnoBalances() {
  if (!isGno.value || !blockchain.rpc) return;
  const signing = addresses.value.account || validator.value;
  const operator = addresses.value.operAddress || v.value.operator_address || '';
  if (!signing && !operator) return;
  const token = ++gnoBalancesToken.value;
  gnoBalances.value = { ...gnoBalances.value, loading: true };
  try {
    const [s, o] = await Promise.all([
      signing
        ? blockchain.rpc.getBankBalances(signing).catch(() => ({ balances: [] as any[] }))
        : Promise.resolve({ balances: [] as any[] }),
      operator && operator !== signing
        ? blockchain.rpc.getBankBalances(operator).catch(() => ({ balances: [] as any[] }))
        : Promise.resolve({ balances: [] as any[] }),
    ]);
    if (token !== gnoBalancesToken.value) return; // stale — a newer load started
    gnoBalances.value = {
      signing: s.balances || [],
      operator: o.balances || [],
      loading: false,
    };
  } catch {
    if (token !== gnoBalancesToken.value) return;
    gnoBalances.value = { ...gnoBalances.value, loading: false };
  }
}
const gnoSigning = ref<{
  from?: string;
  to?: string;
  visible?: number;
  uptime?: string;
  health?: string;
  counts: Record<string, number>;
  cells: { height: string; color: string }[];
}>({ counts: {}, cells: [] });

/** Gno/TM2 — account transactions from the indexer.
 *  Valoper activity (Register / UpdateDescription) is on the **operator** address.
 *  Route param is still the signing address — we resolve operator from valopers meta. */
const gnoTxs = ref<GnoTx[]>([]);
const gnoTxsCursor = ref<string | undefined>();
const gnoTxsHasNext = ref(false);
const gnoTxsLoading = ref(false);
const gnoTxsLoadingMore = ref(false);
const gnoTxsError = ref(false);
const gnoTxsTick = ref(Date.now());
/** Address whose cursor we paginate (operator preferred). */
const gnoTxsPrimaryAddr = ref('');
/** Client-side page size + pager (same UX as AtomOne account history). */
const gnoTxHistoryLimit = ref(10);
const gnoTxHistoryPage = ref(1);
const GNO_TX_PAGE_SIZES = [5, 10, 20, 50];
const gnoTxsPage = computed(() => {
  const start = (gnoTxHistoryPage.value - 1) * gnoTxHistoryLimit.value;
  return gnoTxs.value.slice(start, start + gnoTxHistoryLimit.value);
});
const gnoTxHistoryPageCount = computed(() =>
  Math.max(1, Math.ceil(gnoTxs.value.length / gnoTxHistoryLimit.value) || 1)
);
function setGnoTxHistoryPage(page: number) {
  const max = Math.max(1, Math.ceil(gnoTxs.value.length / gnoTxHistoryLimit.value) || 1);
  gnoTxHistoryPage.value = Math.min(Math.max(1, page), max);
  if (gnoTxsHasNext.value) {
    const nearEnd = page * gnoTxHistoryLimit.value >= gnoTxs.value.length - gnoTxHistoryLimit.value;
    if (nearEnd) loadMoreGnoTxs();
  }
}
function setGnoTxHistorySize(size: number) {
  gnoTxHistoryLimit.value = size;
  gnoTxHistoryPage.value = 1;
}

/**
 * Gno realtime — tip height from baseStore (same source as navbar #height).
 * When tip advances: refresh Current Status + Signing History (no manual reload).
 */
const gnoLastTip = ref(0);
const gnoSigningBusy = ref(false);
const gnoProfileExpanded = ref(false);
let gnoHeightUnwatch: (() => void) | null = null;

/** Official valopers realm profile URL for this validator (Gno only). Config-driven. */
const gnoValopersUrl = computed(() => {
  const op = String(gnoMeta.value?.operatorAddress || '').trim();
  if (!op) return '';
  return gnoValoperProfileUrl(op, blockchain.current);
});

function gnoTxFuncLabel(tx: GnoTx): { label: string; slug: string } {
  const f = tx.func?.[0];
  if (!f) return { label: '—', slug: 'default' };
  const t = (f.messageType || '').toLowerCase();
  if (t.includes('bank')) return { label: f.funcType || 'Transfer', slug: 'bank' };
  if (t.includes('m_call') || t.includes('vm.m_call')) return { label: f.funcType || 'Call', slug: 'wasm' };
  if (t.includes('m_addpkg') || t.includes('addpkg')) return { label: 'AddPkg', slug: 'wasm' };
  if (t.includes('m_run') || t.includes('vm.m_run')) return { label: 'Run', slug: 'wasm' };
  if (f.funcType === 'Transfer') return { label: 'Transfer', slug: 'bank' };
  return { label: f.funcType || f.messageType?.split('.').pop() || 'Tx', slug: 'default' };
}

function gnoTxAmount(v: { value?: string; denom?: string } | null): string {
  if (!v || !v.value || v.value === '0') return '—';
  const n = Number(v.value);
  if (!Number.isFinite(n)) return `${v.value} ${v.denom || ''}`;
  if (v.denom === 'ugnot') {
    const gnot = n / 1e6;
    if (gnot >= 1000) return `${gnot.toLocaleString(undefined, { maximumFractionDigits: 2 })} GNOT`;
    if (gnot >= 1) return `${gnot.toFixed(2)} GNOT`;
    if (gnot >= 0.001) return `${gnot.toFixed(4)} GNOT`;
    return `${gnot.toFixed(6)} GNOT`;
  }
  const denom = v.denom || '';
  if (denom.includes('/')) {
    const short = denom.split('/').pop() || denom;
    return `${n.toLocaleString()} ${short}`;
  }
  return `${n.toLocaleString()} ${denom}`;
}

function gnoTxAge(iso: string): string {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  const diff = Math.max(0, gnoTxsTick.value - ts) / 1000;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortTxHash(h: string): string {
  if (!h) return '';
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

// Activities
type ActivityTab = 'power' | 'votes' | 'txs';
const activityTab = ref<ActivityTab>('power');

enum EventType {
  Delegate = 'delegate',
  Unbond = 'unbond',
  /**
   * Redelegate folds two queries into one list:
   *   - destination_validator = this validator (incoming, +)
   *   - source_validator      = this validator (outgoing, −)
   * LCD ignores OR semantics for tx search so we fetch both sides
   * and merge, deriving the sign per-row from which side matched.
   */
  Redelegate = 'redelegate',
}
const selectedEventType = ref<EventType>(EventType.Delegate);

/** query=event template per kind. Operator address is appended at request time. */
const eventTypeQuery: Record<EventType, string[]> = {
  [EventType.Delegate]: ["query=delegate.validator='{validator}'"],
  [EventType.Unbond]: ["query=unbond.validator='{validator}'"],
  [EventType.Redelegate]: [
    "query=redelegate.destination_validator='{validator}'",
    "query=redelegate.source_validator='{validator}'",
  ],
};

/** Sign for the +/- indicator on the amount cell. */
const eventSign: Record<EventType, 1 | -1> = {
  [EventType.Delegate]: 1,
  [EventType.Unbond]: -1,
  [EventType.Redelegate]: 1,
};

/** Event type to read attributes from. Redelegate in/out both share event name 'redelegate'. */
const eventTypeAttrKey: Record<EventType, string> = {
  [EventType.Delegate]: 'delegate',
  [EventType.Unbond]: 'unbond',
  [EventType.Redelegate]: 'redelegate',
};

/** For multi-query kinds (redelegate): which row is from which side. */
const rowSignFromKey: Record<EventType, (key: string) => 1 | -1> = {
  [EventType.Delegate]: () => 1,
  [EventType.Unbond]: () => -1,
  [EventType.Redelegate]: (k) => (k === 'destination_validator' ? 1 : -1),
};

// Votes from indexer
interface ValidatorVoteRow {
  proposal_id: string;
  option: string;
  txhash: string;
  height: number;
  timestamp: string;
  title: string;
  status: string;
}
const votes = ref([] as ValidatorVoteRow[]);
const votesTotal = ref(0);
const votesLoading = ref(false);
const votesPage = ref(1);
const VOTES_LIMIT = 10;

const page = new PageRequest();
const powerPage = new PageRequest();

/** Delegations table pagination — fully client-side once allDelegations is
 *  loaded. Kept as reactive refs (NOT a plain PageRequest object) so the
 *  sortedDelegations computed re-runs on page/size change. A non-reactive
 *  PageRequest here was the old bug: clicking a page mutated delPage.offset
 *  but Vue never tracked it, so the table never changed page. */
const delPageNum = ref(1);
const delPageSize = ref(10);
const DEL_PAGE_SIZES = [10, 25, 50];

/** Max rows shown in Power Events / Transactions tabs (scroll, no pagination). */
const ACTIVITY_LIMIT = 20;
/** Hard cap on the Transactions infinite-scroll list so a busy validator
 *  doesn't pile unlimited txs into memory. Beyond this we point to the full
 *  account page. */
const TXS_MAX = 100;

/** Power Events — some LCDs ignore pagination.limit on tx-search and return
 *  EVERY match (e.g. "158 of 158"). We cap what we hold in memory (latest
 *  POWER_MAX, query is already order_by DESC) and paginate the display
 *  client-side at PE_PAGE_SIZE so the DOM never renders the full set at once. */
const pePageNum = ref(1);
const PE_PAGE_SIZE = 20;
const POWER_MAX = 500;

// Cosms only: valoper→account. Gno uses g1 signing/operator from valopers meta
// (operatorAddressToAccount on bare g1 is a no-op / wrong race before meta loads).
if (!isGno.value) {
  addresses.value.account = operatorAddressToAccount(validator.value);
}

// self bond — refetched via the rpc watch below. Setup runs before the chain's
// REST client exists on slow-connecting chains (e.g. CosmosHub); rpc?. would
// otherwise resolve undefined silently and leave this stuck at "—".
function loadSelfBond(force = false) {
  if (!blockchain.rpc || !validator.value) return;
  if (isGno.value) return; // Gno has no Cosms self-bond LCD path
  // Keep account derivation in sync (valoper → account) every call.
  if (!addresses.value.account) {
    addresses.value.account = operatorAddressToAccount(validator.value);
  }
  if (!addresses.value.account) return;
  if (!force && selfBonded.value.balance?.amount) return; // already loaded
  staking
    .fetchValidatorDelegation(validator.value, addresses.value.account)
    .then((x) => {
      if (x?.delegation_response) selfBonded.value = x.delegation_response;
    })
    .catch((e: any) => {
      // Many public LCDs 500 on the single-delegation path; fall back by
      // scanning the first page of validator delegations for this account.
      console.warn('[val] self-bond direct path failed:', e?.message || e);
      return blockchain.rpc
        .getStakingValidatorsDelegations(validator.value, (() => {
          const pr = new PageRequest();
          pr.limit = 100;
          pr.count_total = true;
          pr.offset = 0;
          return pr;
        })())
        .then((res: any) => {
          const rows = res?.delegation_responses || [];
          const hit = rows.find(
            (r: any) => r?.delegation?.delegator_address === addresses.value.account
          );
          if (hit) selfBonded.value = hit;
        })
        .catch((e2: any) => console.warn('[val] self-bond fallback failed:', e2?.message || e2));
    });
}
loadSelfBond();

// account txs — first 20 only; user can scroll to load more via IntersectionObserver.
// Initial fetch is deferred to onMounted() below (refs declared further down).

const apr = computed(() => {
  const rate = Number(v.value.commission?.commission_rates.rate || 0);
  const inflation = useMintStore().inflation;
  const communityTax = Number(useDistributionStore().params.community_tax);
  const bondedRatio =
    Number(staking.pool.bonded_tokens) / Number(useBankStore().supply.amount);
  if (!bondedRatio || !Number.isFinite(bondedRatio)) return '—';
  return format.percent(((1 - communityTax) * (1 - rate) * Number(inflation)) / bondedRatio);
});

const selfRate = computed(() => {
  if (selfBonded.value.balance?.amount) {
    return format.calculatePercent(selfBonded.value.balance.amount, v.value.tokens);
  }
  return '—';
});

const commissionRate = computed(() =>
  format.percent(v.value.commission?.commission_rates?.rate ?? 0, '0.00%'),
);

const commissionMax = computed(() =>
  format.percent(v.value.commission?.commission_rates?.max_rate ?? 0, '0%'),
);

const commissionChange = computed(() =>
  format.percent(v.value.commission?.commission_rates?.max_change_rate ?? 0, '0%'),
);

const statusLabel = computed(() => {
  const s = String(v.value.status || '');
  return s.replace('BOND_STATUS_', '') || '—';
});

const statusChip = computed(() => {
  const s = String(v.value.status || '');
  if (v.value.jailed) return 'sz-chip--bad';
  if (s === 'BOND_STATUS_BONDED') return 'sz-chip--ok';
  if (s === 'BOND_STATUS_UNBONDING') return 'sz-chip--warn';
  if (s === 'BOND_STATUS_UNBONDED') return 'sz-chip--info';
  return '';
});

/** Gno status chip — ACTIVE / PENDING / INACTIVE (not Cosmos BONDED). */
const gnoStatusLabel = computed(() => {
  if (!isGno.value) return statusLabel.value;
  return gnoChain.value?.status || (gnoRpc.value?.votingPower ? 'ACTIVE' : statusLabel.value) || '—';
});
const gnoStatusChip = computed(() => {
  if (!isGno.value) return statusChip.value;
  const s = String(gnoStatusLabel.value || '').toUpperCase();
  if (s === 'ACTIVE') return 'sz-chip--ok';
  if (s === 'PENDING') return 'sz-chip--warn';
  if (s === 'INACTIVE') return 'sz-chip--bad';
  return 'sz-chip--info';
});



const powerPercent = computed(() => {
  if (!v.value.tokens || !staking.totalPower) return '—';
  return format.calculatePercent(v.value.tokens, String(staking.totalPower));
});

const bondDenomDisplay = computed(() => {
  // Gno/TM2 voting power is unitless — never apply ugnot exponent/symbol.
  if (isGno.value) return 'VP';
  const d = String(staking.params.bond_denom || '');
  return d.replace(/^u/, '').toUpperCase() || d.toUpperCase();
});

const rank = computed(() => {
  const list = staking.validators || [];
  const idx = list.findIndex((x) => x.operator_address === validator.value);
  if (idx >= 0) return idx + 1;
  // inactive / not in active set
  return null;
});

const logo = (id?: string) => {
  if (!id) return '';
  const url = avatars.value[id] || '';
  if (!url || url === 'undefined') return '';
  return url.startsWith('http') ? url : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
};

const fetchAvatar = (id: string) => {
  return new Promise<void>((resolve) => {
    staking
      .keybase(id)
      .then((d) => {
        if (Array.isArray(d.them) && d.them.length > 0) {
          const uri = String(d.them[0]?.pictures?.primary?.url).replace(
            'https://s3.amazonaws.com/keybase_processed_uploads/',
            ''
          );
          avatars.value[id] = uri;
          resolve();
        } else throw new Error(`failed to fetch avatar for ${id}.`);
      })
      .catch(() => resolve());
  });
};

const loadAvatar = (id: string) => {
  fetchAvatar(id).then(() => {
    localStorage.setItem('avatars', JSON.stringify(avatars.value));
  });
};

/** Fetch ALL delegations for this validator, sorted globally by balance desc.
 *  LCD page order is unstable across pages, so we cannot rely on per-page sort.
 *
 *  Progressive: each page that lands is pushed + sorted immediately, so the
 *  first rows render after ONE request instead of after all ~46 pages. The
 *  table stays globally sorted at every step (no final reorder jump).
 *  Per-page failures retry 3×, then the page is skipped — partial data beats
 *  an empty table. A generation token aborts the loop on unmount/reload. */
const allDelegations = ref<any[]>([]);
const delLoadError = ref(false);
let delLoadToken = 0;

async function fetchDelPage(pr: PageRequest, page: number, token: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (token !== delLoadToken) return null; // aborted
    try {
      pr.setPage(page);
      return await blockchain.rpc.getStakingValidatorsDelegations(validator.value, pr);
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
  return null; // permanent failure for this page
}

async function loadAllDelegations() {
  // Gno/TM2 has no Cosmos LCD delegations — skip the multi-page LCD crawl.
  if (isGno.value) return;
  if (!blockchain.rpc || !validator.value) return;
  // already loading or already have data — skip
  if (delegationsLoading.value) return;
  const token = ++delLoadToken; // invalidate any previous loop
  allDelegations.value = [];
  delegatorTotal.value = 0;
  delLoadError.value = false;
  delegationsLoading.value = true;
  try {
    const PAGE = 100;
    const pr = new PageRequest();
    pr.limit = PAGE;
    pr.count_total = true;
    pr.offset = 0;
    let page = 1;
    let failedPages = 0;
    while (token === delLoadToken) {
      const res: any = await fetchDelPage(pr, page, token);
      if (token !== delLoadToken) return; // aborted mid-await
      if (!res) {
        failedPages++;
        // page 1 total failure = no data at all — give up; the rpc
        // watcher retries when the endpoint fallback lands.
        if (page === 1) break;
        page += 1;
        if (page > 50) break;
        continue;
      }
      const rows = res?.delegation_responses || [];
      if (rows.length) {
        allDelegations.value.push(...rows);
        // incremental sort — table stays globally desc while streaming
        allDelegations.value.sort((a, b) => {
          const aa = Number(a?.balance?.amount || 0);
          const bb = Number(b?.balance?.amount || 0);
          return bb - aa;
        });
      }
      const total = Number(res?.pagination?.total || 0);
      if (total > 0) {
        delegatorTotal.value = total;
        if (allDelegations.value.length >= total) break;
      }
      if (rows.length < PAGE) break;
      page += 1;
      // hard cap to avoid runaway on broken LCDs
      if (page > 50) break;
    }
    if (!delegatorTotal.value) {
      delegatorTotal.value = allDelegations.value.length;
    }
    if (failedPages && !allDelegations.value.length) delLoadError.value = true;
  } finally {
    if (token === delLoadToken) delegationsLoading.value = false;
  }
}

/** Page flip is pure client-side once allDelegations is loaded. */
function pageload(p: number) {
  delPageNum.value = p;
  // If we haven't loaded yet, kick off the full fetch
  if (!allDelegations.value.length && !delegationsLoading.value) {
    loadAllDelegations();
  }
}

/** Row-count selector (10/25/50). Reset to page 1 on size change. */
function onDelPageSizeChange() {
  delPageNum.value = 1;
}

function loadPowerEvents(_p: number, type: EventType) {
  // Gno/TM2: tx_index=off + no LCD events — skip Cosm power-event queries.
  if (isGno.value) {
    selectedEventType.value = type;
    return;
  }
  console.info('[val] loadPowerEvents', type, 'rpc=', !!blockchain.rpc, 'current=', !!blockchain.current);
  selectedEventType.value = type;
  pePageNum.value = 1;
  if (type === EventType.Redelegate) {
    fetchRedelegateCombined();
    return;
  }

  const tmpl = eventTypeQuery[type][0];
  const q = tmpl.replace('{validator}', validator.value);
  blockchain
    .fetchPowerEventsTxs(`?${q}`, { validator: validator.value }, powerPage, ACTIVITY_LIMIT)
    .then((res: any) => {
      events.value = capPowerEvents(res);
    })
    .catch(() => {
      events.value = {} as PaginatedTxs;
    });
}

/** Cap the rows we hold (latest POWER_MAX) while keeping the chain's true
 *  pagination.total for an honest "latest X of Y" footer. */
function capPowerEvents(res: any): PaginatedTxs {
  if (!res) return {} as PaginatedTxs;
  const rows = res.tx_responses || [];
  return {
    ...res,
    tx_responses: rows.length > POWER_MAX ? rows.slice(0, POWER_MAX) : rows,
  } as PaginatedTxs;
}

/**
 * Redelegate tab = "in" (destination) + "out" (source) merged.
 * Each side uses archive-first fallback, then merged + sorted + tagged.
 */
async function fetchRedelegateCombined() {
  pePageNum.value = 1;
  const [inQ, outQ] = eventTypeQuery[EventType.Redelegate].map((t) =>
    `?${t.replace('{validator}', validator.value)}`
  );

  // Run both archive-first walks in parallel; tag rows by which side matched.
  const [inRes, outRes] = await Promise.all([
    blockchain.fetchPowerEventsTxs(inQ, { validator: validator.value }, powerPage, ACTIVITY_LIMIT),
    blockchain.fetchPowerEventsTxs(outQ, { validator: validator.value }, powerPage, ACTIVITY_LIMIT),
  ]);

  const inRows = ((inRes as any)?.tx_responses || []).map((r: any) => ({
    ...r,
    _side: 'destination_validator',
  }));
  const outRows = ((outRes as any)?.tx_responses || []).map((r: any) => ({
    ...r,
    _side: 'source_validator',
  }));

  // Merge: redelegate.in + redelegate.out going to this validator. Sort by height desc.
  const merged = [...inRows, ...outRows].sort(
    (a: any, b: any) => Number(b.height || 0) - Number(a.height || 0)
  );

  const total = String(
    Number((inRes as any)?.pagination?.total ?? (inRes as any)?.total ?? 0) +
      Number((outRes as any)?.pagination?.total ?? (outRes as any)?.total ?? 0)
  );

  events.value = {
    tx_responses: merged.length > POWER_MAX ? merged.slice(0, POWER_MAX) : merged,
    pagination: { total, next_key: null },
    total,
  } as unknown as PaginatedTxs;
}

function pagePowerEvents(p: number) {
  pePageNum.value = p;
}

/** Power-event rows for the current page (client-side slice of the capped,
 *  already height-desc set we hold in memory). */
const pagedPowerEvents = computed(() => {
  const rows = events.value?.tx_responses || [];
  const offset = (pePageNum.value - 1) * PE_PAGE_SIZE;
  return rows.slice(offset, offset + PE_PAGE_SIZE);
});

// ─── Account Transactions (scroll, first 20) ──────────────────────────────
const txsLoading = ref(false);
const txsHasMore = ref(false);
let txsPage = 1;

function loadAccountTxs() {
  txsLoading.value = true;
  blockchain
    .fetchAccountTxs(addresses.value.account, undefined, ACTIVITY_LIMIT)
    .then((x: any) => {
      txs.value = x || ({ tx_responses: [] } as unknown as PaginatedTxs);
      txsPage = 1;
      txsHasMore.value = (x?.tx_responses?.length || 0) >= ACTIVITY_LIMIT;
    })
    .catch(() => {
      txs.value = { tx_responses: [] } as unknown as PaginatedTxs;
      txsHasMore.value = false;
    })
    .finally(() => {
      txsLoading.value = false;
    });
}

function loadMoreAccountTxs() {
  if (!txsHasMore.value || txsLoading.value) return;
  // Hard cap: stop piling txs into memory on busy validators.
  if ((txs.value?.tx_responses?.length || 0) >= TXS_MAX) {
    txsHasMore.value = false;
    return;
  }
  txsLoading.value = true;
  txsPage += 1;
  const pr = new PageRequest();
  pr.setPageSize(ACTIVITY_LIMIT);
  pr.setPage(txsPage);
  blockchain
    .fetchAccountTxs(addresses.value.account, pr, ACTIVITY_LIMIT)
    .then((x: any) => {
      const rows = x?.tx_responses || [];
      let combined = [...(txs.value?.tx_responses || []), ...rows];
      if (combined.length > TXS_MAX) combined = combined.slice(0, TXS_MAX);
      txs.value = {
        ...txs.value,
        tx_responses: combined,
      } as PaginatedTxs;
      // more only if under cap AND the page was full
      txsHasMore.value = combined.length < TXS_MAX && rows.length >= ACTIVITY_LIMIT;
    })
    .catch(() => {
      txsHasMore.value = false;
    })
    .finally(() => {
      txsLoading.value = false;
    });
}

/** True once the Transactions list hit the TXS_MAX cap. */
const txsCapped = computed(() => (txs.value?.tx_responses?.length || 0) >= TXS_MAX);

// IntersectionObserver sentinel for "load more on scroll"
const txsSentinel = ref<HTMLElement | null>(null);
let txsObserver: IntersectionObserver | null = null;
onMounted(() => {
  // Initial load of account txs (deferred until after refs are declared)
  if (txs.value && !txs.value.tx_responses?.length) loadAccountTxs();
  txsObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreAccountTxs();
    },
    { rootMargin: '200px' }
  );
  if (txsSentinel.value) txsObserver.observe(txsSentinel.value);
});
onUnmounted(() => {
  txsObserver?.disconnect();
  delLoadToken++; // abort in-flight delegation streaming
  stopGnoHeightWatch();
});

/** Prefer same-origin /vote-api (Vercel rewrite). Override via VITE_VOTE_INDEXER_URL. */
const VOTE_INDEXER_URL = (() => {
  const raw = import.meta.env.VITE_VOTE_INDEXER_URL;
  if (raw === '') return '';
  if (raw == null || raw === undefined) return '/vote-api';
  return String(raw).replace(/\/$/, '');
})();

async function loadVotes(p = 1) {
  if (!VOTE_INDEXER_URL) {
    votes.value = [];
    votesTotal.value = 0;
    return;
  }
  const chainKey = String(props.chain || blockchain.chainName || '');
  const voter = addresses.value.account;
  if (!chainKey || !voter) return;
  votesLoading.value = true;
  votesPage.value = p;
  const offset = (p - 1) * VOTES_LIMIT;
  try {
    const url =
      `${VOTE_INDEXER_URL}/v1/${encodeURIComponent(chainKey)}/voters/` +
      `${encodeURIComponent(voter)}/votes?limit=${VOTES_LIMIT}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      votes.value = [];
      votesTotal.value = 0;
      return;
    }
    const data = await res.json();
    votes.value = (data?.votes || []) as ValidatorVoteRow[];
    votesTotal.value = Number(data?.pagination?.total || votes.value.length || 0);
  } catch {
    votes.value = [];
    votesTotal.value = 0;
  } finally {
    votesLoading.value = false;
  }
}

function pageVotes(p: number) {
  loadVotes(p);
}

function setActivityTab(tab: ActivityTab) {
  activityTab.value = tab;
  if (tab === 'votes' && votes.value.length === 0 && !votesLoading.value) {
    loadVotes(1);
  }
  if (tab === 'power' && !events.value.tx_responses) {
    pagePowerEvents(1);
  }
}

function optionLabel(opt?: string): string {
  if (!opt) return '—';
  return String(opt).replace('VOTE_OPTION_', '').replace(/_/g, ' ');
}

function optionChipClass(opt: string): string {
  switch (opt) {
    case 'VOTE_OPTION_YES':
      return 'sz-chip--ok';
    case 'VOTE_OPTION_NO':
      return 'sz-chip--bad';
    case 'VOTE_OPTION_NO_WITH_VETO':
      return 'sz-chip--bad';
    case 'VOTE_OPTION_ABSTAIN':
      return 'sz-chip--warn';
    default:
      return 'sz-chip--info';
  }
}

function shortTx(hash?: string): string {
  if (!hash) return '—';
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function shortAddr(addr?: string): string {
  if (!addr) return '—';
  if (addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function voteTimeLabel(ts?: string): string {
  if (!ts) return '—';
  return format.toDay(ts, 'from');
}

/**
 * Per-row +/- sign.
 * - Single-query kinds (delegate, unbond): all rows share the kind's sign.
 * - Redelegate: derive from the _side tag attached by loadPowerEvents.
 */
function rowSign(item: any): 1 | -1 {
  const kind = selectedEventType.value;
  if (kind === EventType.Redelegate) {
    return item?._side === 'destination_validator' ? 1 : -1;
  }
  return eventSign[kind];
}

function mapEvents(evts: { type: string; attributes: { key: string; value: string }[] }[]) {
  const wanted = eventTypeAttrKey[selectedEventType.value];
  const attributes = evts
    .filter((x) => x.type === wanted)
    .filter(
      (x) =>
        x.attributes.findIndex(
          (attr) => attr.value === validator.value || attr.value === toBase64(stringToUint8Array(validator.value))
        ) >= 0
    )
    .map((x) => {
      const output = {} as { [key: string]: string };
      if (x.attributes.findIndex((a) => a.key === `amount`) > -1) {
        x.attributes.forEach((attr) => {
          output[attr.key] = attr.value;
        });
      } else {
        x.attributes.forEach((attr) => {
          output[uint8ArrayToString(fromBase64(attr.key))] = uint8ArrayToString(fromBase64(attr.value));
        });
      }
      return output;
    });

  const coinsAsString = attributes.map((x: any) => x.amount).join(',');
  const coins = parseCoins(coinsAsString);
  return coins.map((coin) => format.formatToken(coin)).join(', ');
}

function mapDelegators(messages: any[]) {
  if (!messages) return [];
  return Array.from(new Set(messages.map((x) => x.delegator_address || x.grantee).filter(Boolean)));
}

let showCopyToast = ref(0);
const copyWebsite = async (url: string) => {
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    showCopyToast.value = 1;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  } catch {
    showCopyToast.value = 2;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  }
};
const tipMsg = computed(() => {
  return showCopyToast.value === 2
    ? { class: 'error', msg: 'Copy Error!' }
    : { class: 'success', msg: 'Copy Success!' };
});

/** Sorted (desc by amount) delegations for the current page.
 *  allDelegations is globally sorted; slice by page number/size (reactive). */
const sortedDelegations = computed(() => {
  const offset = (delPageNum.value - 1) * delPageSize.value;
  return allDelegations.value.slice(offset, offset + delPageSize.value);
});

/** Validator object + distribution rewards/commission. Retried via the rpc
 *  watch below — onMounted can fire before the chain's REST client exists on
 *  slow-connecting chains (e.g. CosmosHub). blockchain.rpc.<method> (no
 *  optional chaining) would otherwise throw on undefined and leave
 *  v / rewards / commission empty — which also zeroes the self-rate tile,
 *  since selfRate = calculatePercent(selfBond, v.tokens). */
function loadValidatorCore() {
  const valAddr = validator.value;
  if (!valAddr) return;
  // Gno/TM2: no Cosmos LCD validator endpoint — pull identity/logo from the
  // valopers registry (AtomOne-enriched Keybase identity) instead.
  if (isGno.value) {
    initGnoValopers()
      .catch((e: any) => {
        console.warn('[gno-valopers] init:', e?.message || e);
      })
      .then(() => {
        const meta = lookupGnoValoper(valAddr);
        if (!meta) {
          // Still try txs with route address only — operator may be unknown.
          loadGnoTxs();
          return;
        }
        gnoMeta.value = meta;
        if (meta.identity) {
          identity.value = meta.identity;
          if (!avatars.value[meta.identity]) loadAvatar(meta.identity);
        }
        // Rich valoper profile (Indonode-style) from the official realm registry:
        // moniker, description, website, socials, networks, addresses, pubkey, server.
        const website = (meta.website || '').trim();
        const cleanWebsite =
          website && /^https?:\/\//i.test(website) && !/discord\.gg|t\.me\//i.test(website)
            ? website
            : '';
        v.value.description = {
          ...(v.value.description || {}),
          moniker: meta.moniker || v.value.description?.moniker,
          details: meta.description || v.value.description?.details,
          website: cleanWebsite || v.value.description?.website,
          identity: meta.identity || v.value.description?.identity,
          security_contact: meta.email || v.value.description?.security_contact,
        } as any;
        v.value.operator_address = meta.operatorAddress || v.value.operator_address;
        // Gno addresses: signing (account), operator, consensus pubkey (hex slot),
        // and the g1 signing address also doubles as the "signer" display.
        // SoT (topaz valopers): Signing Address ≠ Operator Address — do not swap.
        addresses.value.account = meta.signingAddress || addresses.value.account;
        addresses.value.operAddress = meta.operatorAddress || addresses.value.operAddress;
        addresses.value.hex = meta.pubKey || addresses.value.hex;
        addresses.value.valCons = meta.signingAddress || addresses.value.valCons;
        // The detail route param is the signing address — resolve the moniker
        // for the hero even when the registry lookup by this address missed.
        if (!v.value.description?.moniker && meta.moniker) {
          v.value.description = { ...(v.value.description || {}), moniker: meta.moniker } as any;
        }
        // TX history needs operator — load only after meta is set.
        loadGnoTxs();
        loadGnoBalances();
      });
    // Live status + voting power from the onbloc indexer (Gno has no LCD validator endpoint).
    const idxUrl = (blockchain.current as any)?.indexer_api;
    if (idxUrl) {
      getGnoIndexer(idxUrl)
        .getAllValidators()
        .then((list) => {
          const match =
            list.find((x) => x.address === valAddr) ||
            list.find((x) => x.address === gnoMeta.value?.signingAddress) ||
            list.find((x) => x.address === gnoMeta.value?.operatorAddress);
          if (match) {
            gnoChain.value = {
              status: match.status,
              votingPower: match.votingPower,
            };
            v.value.tokens = match.votingPower || v.value.tokens;
            v.value.status =
              match.status === 'ACTIVE'
                ? 'BOND_STATUS_BONDED'
                : match.status === 'INACTIVE'
                  ? 'BOND_STATUS_UNBONDED'
                  : 'BOND_STATUS_UNBONDING';
            v.value.jailed = match.status === 'INACTIVE';
          }
        })
        .catch(() => undefined);
    }
    loadGnoRpc(valAddr);
    loadGnoSigning(valAddr);
    return;
  }
  if (!blockchain.rpc) return;
  if (!v.value.operator_address) {
    staking
      .fetchValidator(valAddr)
      .then((res) => {
        v.value = res.validator;
        identity.value = res.validator?.description?.identity || '';
        if (identity.value && !avatars.value[identity.value]) loadAvatar(identity.value);
        addresses.value.hex = consensusPubkeyToHexAddress(v.value.consensus_pubkey);
        addresses.value.valCons = pubKeyToValcons(
          v.value.consensus_pubkey,
          blockchain.current?.bech32ConsensusPrefix || ''
        );
      })
      .catch((e) => {
        console.warn('[val] fetchValidator failed (will retry on next rpc change):', e?.message || e);
      });
  }
  if (!rewards.value?.length) {
    blockchain.rpc
      .getDistributionValidatorOutstandingRewards(valAddr)
      .then((res) => {
        rewards.value = res.rewards?.rewards?.sort((a, b) => Number(b.amount) - Number(a.amount));
        res.rewards?.rewards?.forEach((x) => {
          if (x.denom.startsWith('ibc/')) format.fetchDenomTrace(x.denom);
        });
      })
      .catch(() => {});
  }
  if (!commission.value?.length) {
    blockchain.rpc
      .getDistributionValidatorCommission(valAddr)
      .then((res) => {
        commission.value = res.commission?.commission?.sort((a, b) => Number(b.amount) - Number(a.amount));
        res.commission?.commission?.forEach((x) => {
          if (x.denom.startsWith('ibc/')) format.fetchDenomTrace(x.denom);
        });
      })
      .catch(() => {});
  }
}

onMounted(() => {
  if (!validator.value) return;

  loadValidatorCore();
  if (isGno.value) startGnoHeightWatch();

  // Delegators — fetch all and sort globally desc.
  // Wait for rpc readiness: onMounted can fire before chain endpoint is set.
  if (blockchain.rpc) {
    loadAllDelegations();
    loadPowerEvents(1, EventType.Delegate);
  }
  // Prefetch votes in background so Activities → Votes is instant
  loadVotes(1);
});

function gnoRpcEndpoint(): string {
  return (
    (blockchain.current?.endpoints as any)?.rpc?.[0]?.address ||
    (blockchain.current?.endpoints as any)?.rest?.[0]?.address ||
    (blockchain.endpoint as any)?.address ||
    ''
  );
}

/** Prefer navbar tip (baseStore.latest) — same SSOT as header #height. */
function gnoTipHeight(): number {
  return Number(baseStore.latest?.block?.header?.height || 0);
}

function recomputeGnoSigning(
  cells: { height: string; color: string }[],
  counts: Record<string, number>,
  from: number,
  tip: number,
) {
  const visible = cells.length;
  const signed = counts.commit || 0;
  const uptime = visible ? ((signed / visible) * 100).toFixed(2) + '%' : '—';
  const health = !visible
    ? '—'
    : signed / visible >= 0.99
      ? 'Healthy'
      : signed / visible >= 0.9
        ? 'Degraded'
        : 'Unhealthy';
  gnoSigning.value = {
    from: String(from),
    to: String(tip),
    visible,
    uptime,
    health,
    counts,
    cells,
  };
}

/** Classify one block's precommit for this signing address. */
function gnoCellFromBlock(b: any, height: string, valAddr: string): { height: string; color: string; kind: 'commit' | 'nil' | 'absent' } | null {
  const pcs =
    b?.result?.block?.last_commit?.precommits ||
    b?.result?.block?.last_commit?.signatures ||
    b?.block?.last_commit?.precommits ||
    b?.block?.last_commit?.signatures ||
    [];
  if (!pcs.length) return null;
  const pc = pcs.find((p: any) => p && (p.validator_address === valAddr || p.address === valAddr));
  if (pc) {
    const signed = !!(pc.signature || pc.block_id?.hash);
    if (signed) return { height, color: 'bg-green-500', kind: 'commit' };
    return { height, color: 'bg-yellow-500', kind: 'nil' };
  }
  return { height, color: 'bg-red-500', kind: 'absent' };
}

/** Gno/TM2 — live consensus status. tipHint = navbar height when known. */
async function loadGnoRpc(valAddr: string, tipHint?: number) {
  const ep = gnoRpcEndpoint();
  if (!ep || !valAddr) return;
  try {
    const tipKnown = Number(tipHint || gnoTipHeight() || 0);
    const jobs: Promise<any>[] = [tm2Get(ep, '/validators?per_page=200')];
    if (!tipKnown) jobs.unshift(tm2Get(ep, '/status'));
    const results = await Promise.all(jobs);
    let height = tipKnown ? String(tipKnown) : '';
    let vs: any;
    if (!tipKnown) {
      const st = results[0];
      vs = results[1];
      height = String(st?.result?.sync_info?.latest_block_height || '');
    } else {
      vs = results[0];
    }
    const vals: any[] = vs?.result?.validators || [];
    const me = vals.find((x) => x.address === valAddr);
    const totalVp = vals.reduce((s: number, x: any) => s + Number(x.voting_power || 0), 0);
    const vp = me ? String(me.voting_power) : '';
    const share = me && totalVp ? ((Number(me.voting_power) / totalVp) * 100).toFixed(2) + '%' : '';
    const pk = me?.pub_key || {};
    gnoRpc.value = {
      height: height || gnoRpc.value?.height || '',
      votingPower: vp || gnoRpc.value?.votingPower || '',
      vpShare: share || gnoRpc.value?.vpShare || '',
      proposerPriority: me ? String(me.proposer_priority) : gnoRpc.value?.proposerPriority || '',
      consensusKeyType: pk['@type'] || gnoRpc.value?.consensusKeyType || '',
      consensusPubKey: pk.value || gnoRpc.value?.consensusPubKey || '',
    };
    if (me) {
      v.value.tokens = vp || v.value.tokens;
      v.value.status = 'BOND_STATUS_BONDED';
      v.value.jailed = false;
    }
  } catch (e: any) {
    console.warn('[val] gno rpc status failed:', e?.message || e);
  }
}

/**
 * Gno/TM2 — signing history last-N.
 * Full walk on first load; on tip advance only fetch the missing new heights
 * and slide the window (so realtime is cheap and keeps up with navbar).
 */
async function loadGnoSigning(valAddr: string, tipHint?: number) {
  const ep = gnoRpcEndpoint();
  if (!ep || !valAddr) return;
  if (gnoSigningBusy.value) return;
  const N = 100;
  gnoSigningBusy.value = true;
  try {
    let tip = Number(tipHint || gnoTipHeight() || 0);
    if (!tip) {
      const st = await tm2Get(ep, '/status');
      tip = Number(st?.result?.sync_info?.latest_block_height || 0);
    }
    if (!tip) return;

    const prev = gnoSigning.value;
    const prevTo = Number(prev.to || 0);
    const prevCells = prev.cells || [];

    // Incremental: tip advanced a little and we already have a full window.
    if (prevCells.length >= N && prevTo > 0 && tip > prevTo && tip - prevTo <= 20) {
      const newHeights = Array.from({ length: tip - prevTo }, (_, i) => String(prevTo + 1 + i));
      const blocks = await Promise.all(
        newHeights.map((h) => tm2Get(ep, `/block?height=${h}`).catch(() => null)),
      );
      const counts: Record<string, number> = {
        commit: prev.counts.commit || 0,
        absent: prev.counts.absent || 0,
        nil: prev.counts.nil || 0,
      };
      let cells = prevCells.slice();
      for (let i = 0; i < newHeights.length; i++) {
        const cell = gnoCellFromBlock(blocks[i], newHeights[i], valAddr);
        if (!cell) continue;
        if (cells.length) {
          const drop = cells[0];
          if (drop.color.includes('green')) counts.commit = Math.max(0, (counts.commit || 0) - 1);
          else if (drop.color.includes('yellow')) counts.nil = Math.max(0, (counts.nil || 0) - 1);
          else counts.absent = Math.max(0, (counts.absent || 0) - 1);
          cells = cells.slice(1);
        }
        counts[cell.kind] = (counts[cell.kind] || 0) + 1;
        cells.push({ height: cell.height, color: cell.color });
      }
      while (cells.length > N) {
        const drop = cells.shift()!;
        if (drop.color.includes('green')) counts.commit = Math.max(0, (counts.commit || 0) - 1);
        else if (drop.color.includes('yellow')) counts.nil = Math.max(0, (counts.nil || 0) - 1);
        else counts.absent = Math.max(0, (counts.absent || 0) - 1);
      }
      const from = cells.length ? Number(cells[0].height) : tip - N + 1;
      recomputeGnoSigning(cells, counts, from, tip);
      return;
    }

    // Full rebuild
    const from = tip - N + 1;
    const heights = Array.from({ length: N }, (_, i) => String(from + i));
    const blocks = await Promise.all(
      heights.map((h) => tm2Get(ep, `/block?height=${h}`).catch(() => null)),
    );
    const cells: { height: string; color: string }[] = [];
    const counts: Record<string, number> = { commit: 0, absent: 0, nil: 0 };
    blocks.forEach((b, i) => {
      const cell = gnoCellFromBlock(b, heights[i], valAddr);
      if (!cell) return;
      counts[cell.kind] = (counts[cell.kind] || 0) + 1;
      cells.push({ height: cell.height, color: cell.color });
    });
    recomputeGnoSigning(cells, counts, from, tip);
  } catch (e: any) {
    console.warn('[val] gno signing history failed:', e?.message || e);
  } finally {
    gnoSigningBusy.value = false;
  }
}

/** When navbar tip height advances, refresh consensus + signing history. */
function onGnoTipAdvance(tip: number) {
  if (!isGno.value || !tip) return;
  const valAddr = validator.value;
  if (!valAddr) return;
  if (tip === gnoLastTip.value && gnoRpc.value?.height === String(tip) && Number(gnoSigning.value.to || 0) === tip) {
    return;
  }
  const prev = gnoLastTip.value;
  gnoLastTip.value = tip;
  // Always keep Indexed Height in lockstep with navbar.
  if (gnoRpc.value) gnoRpc.value = { ...gnoRpc.value, height: String(tip) };
  void loadGnoRpc(valAddr, tip);
  if (!prev || tip > prev || !gnoSigning.value.cells?.length) {
    void loadGnoSigning(valAddr, tip);
  }
}

function startGnoHeightWatch() {
  if (gnoHeightUnwatch) return;
  gnoHeightUnwatch = watch(
    () => Number(baseStore.latest?.block?.header?.height || 0),
    (tip) => {
      if (!isGno.value || !tip) return;
      onGnoTipAdvance(tip);
    },
    { immediate: true },
  );
}

function stopGnoHeightWatch() {
  gnoHeightUnwatch?.();
  gnoHeightUnwatch = null;
}

/** Gno/TM2 — validator account activity via onbloc indexer.
 *  RPC has tx_index=off. Valoper realm txs are signed by the **operator**
 *  address (not the Tendermint2 signing address used in the route). */
async function loadGnoTxs() {
  const idxUrl = (blockchain.current as any)?.indexer_api;
  const signing = validator.value;
  if (!idxUrl || !signing) return;
  gnoTxsLoading.value = true;
  gnoTxsError.value = false;
  const maxAttempts = 3;
  let lastErr: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Prefer meta already hydrated; fall back to registry lookup.
      const meta = gnoMeta.value || lookupGnoValoper(signing);
      const operator =
        meta?.operatorAddress ||
        addresses.value.operAddress ||
        (meta && meta.signingAddress === signing ? meta.operatorAddress : '') ||
        '';
      const page = await getGnoIndexer(idxUrl).getValidatorTransactions(signing, operator || undefined);
      gnoTxs.value = page.items;
      gnoTxsCursor.value = page.cursor;
      gnoTxsHasNext.value = page.hasNext;
      gnoTxsPrimaryAddr.value = page.primaryAddress;
      gnoTxsTick.value = Date.now();
      gnoTxHistoryPage.value = 1;
      lastErr = null;
      break;
    } catch (e: any) {
      lastErr = e;
      console.warn(`[val] gno account txs failed (attempt ${attempt + 1}/${maxAttempts}):`, e?.message || e);
      if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  if (lastErr) gnoTxsError.value = true;
  gnoTxsLoading.value = false;
}

async function loadMoreGnoTxs() {
  const idxUrl = (blockchain.current as any)?.indexer_api;
  const primary = gnoTxsPrimaryAddr.value || addresses.value.operAddress || validator.value;
  if (!idxUrl || !gnoTxsHasNext.value || !gnoTxsCursor.value || gnoTxsLoadingMore.value || !primary) return;
  gnoTxsLoadingMore.value = true;
  try {
    const page = await getGnoIndexer(idxUrl).getAccountTransactionsAfter(primary, gnoTxsCursor.value);
    const seen = new Set(gnoTxs.value.map((t) => t.txHash));
    for (const t of page.items) if (t.txHash && !seen.has(t.txHash)) gnoTxs.value.push(t);
    gnoTxsCursor.value = page.cursor;
    gnoTxsHasNext.value = page.hasNext;
  } catch (e: any) {
    console.warn('[val] gno account txs more failed:', e?.message || e);
  } finally {
    gnoTxsLoadingMore.value = false;
  }
}

// Retry delegations + power events once REST client is ready
watch(
  () => blockchain.rpc,
  (rpc) => {
    console.info('[val] rpc watch fired, rpc=', !!rpc, 'events=', events.value?.tx_responses?.length);
    if (!rpc) return;
    if (isGno.value) {
      // Gno: liquid balances + core (valopers/indexer) once RPC is ready.
      // Re-run core if meta/operator still empty after first paint race.
      if (!gnoMeta.value || !addresses.value.operAddress) {
        loadValidatorCore();
      }
      loadGnoBalances();
      return;
    }
    if (!allDelegations.value.length && !delegationsLoading.value) {
      loadAllDelegations();
    }
    if (!selfBonded.value.balance?.amount) {
      loadSelfBond();
    }
    if (!v.value.operator_address) {
      loadValidatorCore();
    }
    if (!events.value?.tx_responses?.length) {
      console.info('[val] calling loadPowerEvents');
      loadPowerEvents(1, selectedEventType.value || EventType.Delegate);
    }
  },
  { immediate: true }
);

// After valopers/meta fills operator address, re-fetch balances (first rpc
// tick often only has signing address → operator balance stayed 0 until refresh).
watch(
  () => [addresses.value.operAddress, addresses.value.account, isGno.value] as const,
  ([op, sign, gno], prev) => {
    if (!gno || !blockchain.rpc) return;
    if (op || sign) {
      const prevOp = prev?.[0];
      const prevSign = prev?.[1];
      if (op !== prevOp || sign !== prevSign || !gnoBalances.value.operator?.length) {
        loadGnoBalances();
      }
    }
  }
);

watch(
  () => props.validator,
  (newVal: string, oldVal: string) => {
    if (newVal && newVal !== oldVal) {
      // SPA navigation: reload all data for the new validator
      v.value = {} as Validator;
      identity.value = '';
      gnoMeta.value = undefined;
      gnoChain.value = undefined;
      gnoRpc.value = undefined;
      gnoSigning.value = { counts: {}, cells: [] };
      gnoLastTip.value = 0;
      gnoProfileExpanded.value = false;
      gnoTxs.value = [];
      gnoTxsCursor.value = undefined;
      gnoTxsHasNext.value = false;
      gnoTxsError.value = false;
      gnoTxsPrimaryAddr.value = '';
      gnoBalances.value = { loading: false };
      rewards.value = [];
      commission.value = [];
      delegations.value = {} as PaginatedDelegations;
      allDelegations.value = [];
      delegationsLoading.value = false;
      events.value = { tx_responses: [], pagination: { total: '0', next_key: null } } as unknown as PaginatedTxs;
      selfBonded.value = {} as Delegation;
      loadValidatorCore();
      if (isGno.value) startGnoHeightWatch();
      if (blockchain.rpc) {
        loadAllDelegations();
        loadPowerEvents(1, EventType.Delegate);
      }
      loadVotes(1);
    }
  }
);
</script>
<template>
  <div class="sz-val-detail">
    <!-- HERO -->
    <section class="sz-section sz-val-hero mb-4 overflow-hidden">
      <div class="sz-val-hero-inner">
        <div class="flex flex-col sm:!flex-row gap-4 sm:!gap-5 items-start">
          <div class="sz-val-avatar shrink-0">
            <img
              v-if="identity && logo(identity)"
              v-lazy="logo(identity)"
              class="h-full w-full object-cover"
              alt=""
              @error="() => loadAvatar(identity)"
            />
            <div v-else class="sz-val-avatar-fallback">
              {{ (v.description?.moniker || '?').slice(0, 1).toUpperCase() }}
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <div class="sz-section-kicker mb-1">Validator</div>
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <h1 class="sz-page-title !mb-0 !text-[1.55rem] sm:!text-[1.75rem] truncate max-w-full">
                {{ v.description?.moniker || shortAddr(validator.value) }}
              </h1>
              <span v-if="rank" class="sz-chip sz-chip--info font-mono">#{{ rank }}</span>
              <span class="sz-chip" :class="isGno ? gnoStatusChip : statusChip">{{ isGno ? gnoStatusLabel : statusLabel }}</span>
              <span v-if="v.jailed && !isGno" class="sz-chip sz-chip--bad">JAILED</span>
            </div>

            <!-- Cosmos: description + links live in the hero -->
            <template v-if="!isGno">
              <p v-if="v.description?.details" class="sz-val-details text-secondary text-[13px] leading-relaxed mt-1 mb-3">
                {{ v.description.details }}
              </p>
              <p v-else class="text-secondary text-[12.5px] italic mt-1 mb-3">
                {{ $t('staking.no_description') }}
              </p>
            </template>

            <!-- Gno: hero stays lean (profile lives in the Valoper card) — just the
                 official valopers realm profile link -->
            <div v-if="isGno" class="flex flex-wrap items-center gap-2 mt-2">
              <a
                :href="gnoValopersUrl"
                target="_blank"
                rel="noopener"
                class="sz-hero-link"
                title="Official valoper profile on gno.land"
              >
                <Icon icon="mdi-account-card-details-outline" class="text-base" />
                <span class="sz-hero-link-label">Valoper Profile</span>
                <span class="sz-hero-link-value">gnops/valopers</span>
              </a>
            </div>

            <div v-if="!isGno" class="flex flex-wrap items-center gap-2">
              <a
                v-if="v.description?.website"
                :href="safeUrl(v.description.website)"
                target="_blank"
                rel="noopener"
                class="sz-hero-link"
                :title="v.description.website"
              >
                <Icon icon="mdi-web" class="text-base" />
                <span class="sz-hero-link-label">{{ $t('staking.website') }}</span>
                <span class="sz-hero-link-value">{{ v.description.website }}</span>
              </a>
              <span v-else class="sz-hero-link sz-hero-link--muted" :title="$t('staking.website')">
                <Icon icon="mdi-web" class="text-base" />
                <span class="sz-hero-link-label">{{ $t('staking.website') }}</span>
                <span class="sz-hero-link-value">—</span>
              </span>

              <a
                v-if="v.description?.security_contact"
                :href="safeMailto(v.description.security_contact)"
                class="sz-hero-link"
                :title="v.description.security_contact"
              >
                <Icon icon="mdi-email-outline" class="text-base" />
                <span class="sz-hero-link-label">{{ $t('staking.contact') }}</span>
                <span class="sz-hero-link-value">{{ v.description.security_contact }}</span>
              </a>
              <span v-else class="sz-hero-link sz-hero-link--muted" :title="$t('staking.contact')">
                <Icon icon="mdi-email-outline" class="text-base" />
                <span class="sz-hero-link-label">{{ $t('staking.contact') }}</span>
                <span class="sz-hero-link-value">—</span>
              </span>

              <span v-if="identity" class="sz-chip font-mono !text-[10px] !font-medium text-secondary">
                {{ identity }}
              </span>
              <button
                type="button"
                class="btn btn-primary btn-sm ml-auto sm:!ml-0"
                @click="dialog.open('delegate', { validator_address: v.operator_address || validator.value })"
              >
                <Icon icon="mdi-handshake-outline" class="text-base mr-1" />
                {{ $t('account.btn_delegate') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- METRIC STRIP — Cosmos (bonded / self / delegators / commission / APR / min) -->
    <div v-if="!isGno" class="grid grid-cols-2 md:!grid-cols-3 xl:!grid-cols-6 gap-3 mb-4">
      <div class="sz-stat" style="--stat-hue: var(--sz-accent)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.total_bonded') }}</span></div>
        <div class="sz-stat-value">
          {{ format.formatToken({ amount: v.tokens, denom: staking.params.bond_denom }, false, '0,0') }}
          <span class="sz-stat-unit">{{ bondDenomDisplay }}</span>
        </div>
        <div class="sz-stat-sub">{{ powerPercent }} of network</div>
      </div>

      <div class="sz-stat" style="--stat-hue: #764bc8">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.self_bonded') }}</span></div>
        <div class="sz-stat-value">
          {{ format.formatToken(selfBonded.balance, false, '0,0') || '—' }}
          <span class="sz-stat-unit">{{ bondDenomDisplay }}</span>
        </div>
        <div class="sz-stat-sub">{{ selfRate }}</div>
      </div>

      <div class="sz-stat" style="--stat-hue: #0ea5e9">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.delegators') }}</span></div>
        <div class="sz-stat-value">
          {{ delegatorTotal > 0 ? delegatorTotal.toLocaleString() : (delegationsLoading ? '…' : '—') }}
        </div>
        <div class="sz-stat-sub">{{ $t('staking.delegators_sub') }}</div>
      </div>

      <div class="sz-stat" style="--stat-hue: var(--sz-warn)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.commission') }}</span></div>
        <div class="sz-stat-value">{{ commissionRate }}</div>
        <div class="sz-stat-sub">max {{ commissionMax }} · Δ {{ commissionChange }}</div>
      </div>

      <div class="sz-stat" style="--stat-hue: var(--sz-success)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.annual_profit') }}</span></div>
        <div class="sz-stat-value">{{ apr }}</div>
        <div class="sz-stat-sub">est. after commission</div>
      </div>

      <div class="sz-stat" style="--stat-hue: #64748b">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.min_self') }}</span></div>
        <div class="sz-stat-value">
          {{ v.min_self_delegation || '—' }}
          <span class="sz-stat-unit">{{ bondDenomDisplay }}</span>
        </div>
        <div class="sz-stat-sub">min self bond</div>
      </div>
    </div>

    <!-- METRIC STRIP — Gno/TM2 Current Status (UTSA-style) -->
    <div v-else class="sz-section overflow-hidden mb-4">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Consensus</div>
          <div class="sz-section-title">Current Status</div>
        </div>
        <div v-if="gnoSigning.health" class="text-xs font-semibold" :class="{
          'text-success': gnoSigning.health === 'Healthy',
          'text-warning': gnoSigning.health === 'Degraded',
          'text-error': gnoSigning.health === 'Unhealthy',
        }">{{ gnoSigning.health }}</div>
      </div>
      <div class="grid grid-cols-2 md:!grid-cols-3 xl:!grid-cols-6 gap-0 divide-x divide-base-content/10">
        <div class="px-4 py-3">
          <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Status</div>
          <div class="text-sm font-semibold">{{ gnoStatusLabel }}</div>
        </div>
        <div class="px-4 py-3">
          <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Indexed Height</div>
          <div class="text-sm font-mono">{{ gnoRpc?.height || (baseStore.latest?.block?.header?.height) || '…' }}</div>
        </div>
        <div class="px-4 py-3">
          <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Voting Power</div>
          <div class="text-sm font-mono">{{ gnoRpc?.votingPower || gnoChain?.votingPower || v.tokens || '—' }}</div>
          <div v-if="gnoRpc?.vpShare" class="text-[11px] text-secondary mt-0.5">{{ gnoRpc.vpShare }} of set</div>
        </div>
        <div class="px-4 py-3">
          <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Proposer Priority</div>
          <div class="text-sm font-mono">{{ gnoRpc?.proposerPriority || '—' }}</div>
        </div>
        <div class="px-4 py-3">
          <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Uptime (100 blks)</div>
          <div class="text-sm font-semibold">{{ gnoSigning.uptime || '…' }}</div>
          <div v-if="gnoSigning.visible" class="text-[11px] text-secondary mt-0.5">{{ gnoSigning.counts.commit || 0 }}/{{ gnoSigning.visible }} signed</div>
        </div>
        <div class="px-4 py-3">
          <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Server</div>
          <div class="text-sm">{{ gnoMeta?.serverType || '—' }}</div>
        </div>
      </div>
      <div v-if="gnoRpc?.consensusPubKey" class="px-4 py-2.5 border-t border-base-content/10 flex flex-wrap items-center gap-2 text-[12px]">
        <span class="text-[11px] font-bold uppercase tracking-wider text-secondary">Consensus Key</span>
        <span v-if="gnoRpc.consensusKeyType" class="sz-chip sz-chip--info !text-[10px]">{{ gnoRpc.consensusKeyType }}</span>
        <code class="sz-hash break-all text-[11px] flex-1 min-w-0">{{ gnoRpc.consensusPubKey }}</code>
        <Icon
          icon="mdi:content-copy"
          class="cursor-pointer text-sm opacity-70 hover:opacity-100 shrink-0"
          @click="copyWebsite(gnoRpc.consensusPubKey || '')"
        />
      </div>
    </div>

    <!-- GNO SIGNING HISTORY (UTSA-style) -->
    <div v-if="isGno" class="sz-section overflow-hidden mb-4">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Uptime</div>
          <div class="sz-section-title">Signing History</div>
        </div>
        <div v-if="gnoSigning.from" class="text-[11px] text-secondary font-mono">
          #{{ gnoSigning.from }} → #{{ gnoSigning.to }}
        </div>
      </div>
      <div class="px-4 py-3 space-y-3">
        <div class="flex flex-wrap gap-3 text-[12px]">
          <span class="inline-flex items-center gap-1.5">
            <i class="w-2.5 h-2.5 rounded-sm bg-green-500 inline-block"></i>
            Commit {{ gnoSigning.counts.commit || 0 }}
          </span>
          <span class="inline-flex items-center gap-1.5">
            <i class="w-2.5 h-2.5 rounded-sm bg-yellow-500 inline-block"></i>
            Nil {{ gnoSigning.counts.nil || 0 }}
          </span>
          <span class="inline-flex items-center gap-1.5">
            <i class="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block"></i>
            Absent {{ gnoSigning.counts.absent || 0 }}
          </span>
          <span class="text-secondary ml-auto">
            {{ gnoSigning.visible || 0 }} of last 100 blocks visible
          </span>
        </div>
        <div v-if="gnoSigning.cells.length" class="flex flex-wrap gap-[2px]">
          <div
            v-for="c in gnoSigning.cells"
            :key="c.height"
            class="w-[7px] h-4 rounded-[1px]"
            :class="c.color"
            :title="'#' + c.height"
          ></div>
        </div>
        <div v-else class="text-secondary text-xs py-2">Loading signing history…</div>
      </div>
    </div>

    <!-- GNO PROFILE (valopers) + IDENTITY (addresses) — UTSA-style -->
    <div v-if="isGno" class="grid grid-cols-1 lg:!grid-cols-5 gap-4 mb-4">
      <div class="sz-section overflow-hidden lg:!col-span-3 flex flex-col">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Valoper</div>
            <div class="sz-section-title">Profile</div>
          </div>
        </div>
        <div class="px-4 py-3 flex-1">
          <div
            class="sz-gno-profile space-y-4"
            :class="{ 'sz-gno-profile--clamped': !gnoProfileExpanded }"
          >
            <div v-if="v.description?.moniker || gnoMeta?.moniker">
              <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Validator Name</div>
              <div class="text-[13px] font-semibold">{{ v.description?.moniker || gnoMeta?.moniker }}</div>
            </div>
            <div v-if="v.description?.details || gnoMeta?.description">
              <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1">Description</div>
              <p class="text-[13px] leading-relaxed text-base-content/90 whitespace-pre-line">{{ v.description?.details || gnoMeta?.description }}</p>
            </div>
            <div v-if="gnoMeta?.networks?.length">
              <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1.5">Networks</div>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="(n, i) in gnoMeta.networks"
                  :key="`net-${i}`"
                  class="sz-chip sz-chip--info !text-[11px]"
                >{{ n }}</span>
              </div>
            </div>
            <div>
              <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1.5">Links & Contact</div>
              <div class="flex flex-wrap gap-2">
                <a
                  v-if="v.description?.website || gnoMeta?.website"
                  :href="safeUrl(v.description?.website || gnoMeta?.website)"
                  target="_blank"
                  rel="noopener"
                  class="sz-hero-link"
                >
                  <Icon icon="mdi-web" class="text-base" />
                  <span class="sz-hero-link-label">Website</span>
                </a>
                <a
                  v-if="gnoMeta?.twitter"
                  :href="safeUrl(gnoMeta.twitter)"
                  target="_blank"
                  rel="noopener"
                  class="sz-hero-link"
                >
                  <Icon icon="mdi-twitter" class="text-base" />
                  <span class="sz-hero-link-label">X</span>
                </a>
                <a
                  v-if="gnoMeta?.telegram"
                  :href="safeUrl(gnoMeta.telegram)"
                  target="_blank"
                  rel="noopener"
                  class="sz-hero-link"
                >
                  <Icon icon="mdi-send" class="text-base" />
                  <span class="sz-hero-link-label">Telegram</span>
                </a>
                <a
                  v-if="gnoMeta?.github"
                  :href="safeUrl(gnoMeta.github)"
                  target="_blank"
                  rel="noopener"
                  class="sz-hero-link"
                >
                  <Icon icon="mdi-github" class="text-base" />
                  <span class="sz-hero-link-label">GitHub</span>
                </a>
                <a
                  v-if="gnoMeta?.email || v.description?.security_contact"
                  :href="safeMailto(gnoMeta?.email || v.description?.security_contact)"
                  class="sz-hero-link"
                >
                  <Icon icon="mdi-email-outline" class="text-base" />
                  <span class="sz-hero-link-label">{{ gnoMeta?.email || v.description?.security_contact }}</span>
                </a>
                <span
                  v-if="gnoMeta?.discord"
                  class="sz-hero-link sz-hero-link--muted"
                  :title="'Discord: ' + gnoMeta.discord"
                >
                  <Icon icon="mdi-discord" class="text-base" />
                  <span class="sz-hero-link-label">{{ gnoMeta.discord }}</span>
                </span>
                <span
                  v-if="!(v.description?.website || gnoMeta?.website) && !gnoMeta?.twitter && !gnoMeta?.telegram && !gnoMeta?.github && !gnoMeta?.email && !gnoMeta?.discord && !v.description?.security_contact"
                  class="text-secondary text-xs"
                >—</span>
              </div>
            </div>
          </div>
          <button
            v-if="v.description?.details || gnoMeta?.description || gnoMeta?.networks?.length"
            type="button"
            class="sz-gno-profile-toggle mt-2 text-xs font-semibold text-primary"
            @click="gnoProfileExpanded = !gnoProfileExpanded"
          >
            {{ gnoProfileExpanded ? 'Show less' : 'Read more' }}
          </button>
        </div>
      </div>

      <div class="sz-section overflow-hidden lg:!col-span-2">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Identity</div>
            <div class="sz-section-title">{{ $t('staking.addresses') }}</div>
          </div>
        </div>
        <div class="px-4 py-3 space-y-3">
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              Signing Address
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="addresses.account"
                @click="copyWebsite(addresses.account || '')"
              />
            </div>
            <!-- Gno: signing key is consensus identity only — no /account link (spins / empty activity).
                 Account balance + valoper TX history live on the OPERATOR address. -->
            <div class="sz-hash text-[12px] break-all">{{ addresses.account || '—' }}</div>
            <div class="mt-1 text-[11px] text-secondary">
              Balance:
              <span class="font-mono text-base-content">{{ gnoBalances.loading ? '…' : formatGnoBal(gnoBalances.signing) }}</span>
              <span class="opacity-60"> · no account link (from gnoland secrets)</span>
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              Operator Address
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="addresses.operAddress || v.operator_address"
                @click="copyWebsite(addresses.operAddress || v.operator_address || '')"
              />
            </div>
            <RouterLink
              v-if="addresses.operAddress || v.operator_address"
              class="sz-hash text-primary link link-hover break-all text-[12px]"
              :to="`/${chain}/account/${addresses.operAddress || v.operator_address}`"
            >{{ addresses.operAddress || v.operator_address }}</RouterLink>
            <div v-else class="sz-hash text-[12px] break-all">—</div>
            <div class="mt-1 text-[11px] text-secondary">
              Balance:
              <span class="font-mono text-base-content">{{ gnoBalances.loading ? '…' : formatGnoBal(gnoBalances.operator) }}</span>
              <span class="opacity-60"> · account + valoper activity (from gnokey)</span>
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              Signing PubKey
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="gnoMeta?.pubKey || addresses.hex"
                @click="copyWebsite(gnoMeta?.pubKey || addresses.hex || '')"
              />
            </div>
            <div class="sz-hash text-[12px] break-all">{{ gnoMeta?.pubKey || addresses.hex || '—' }}</div>
          </div>
          <div v-if="identity">
            <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">Keybase Identity</div>
            <div class="sz-hash text-[12px] break-all font-mono">{{ identity }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- COMMISSION & EARNINGS (merged) + ADDRESSES — Cosmos only -->
    <div v-if="!isGno" class="grid grid-cols-1 lg:!grid-cols-5 gap-4 mb-4">
      <div class="sz-section overflow-hidden lg:!col-span-3 flex flex-col">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Commission</div>
            <div class="sz-section-title">{{ $t('staking.commissions_&_rewards') }}</div>
          </div>
        </div>
        <div class="grid grid-cols-1 md:!grid-cols-2 gap-0 flex-1 min-h-0">
          <div class="px-2 pt-1 pb-3 md:!border-r border-base-content/10">
            <CommissionRate :commission="v.commission" embedded />
          </div>
          <div class="px-4 py-3 flex flex-col gap-3 min-h-0">
            <div class="overflow-auto flex-1 max-h-56">
              <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1.5">
                {{ $t('staking.commissions') }}
              </div>
              <div class="flex flex-wrap gap-1.5 mb-3">
                <span
                  v-for="(i, k) in commission"
                  :key="`c-${k}`"
                  class="badge badge-sm badge-outline font-mono text-[11px]"
                >{{ format.formatToken2(i) }}</span>
                <span v-if="!commission?.length" class="text-secondary text-xs">—</span>
              </div>
              <div class="text-[11px] font-bold uppercase tracking-wider text-secondary mb-1.5">
                {{ $t('staking.outstanding') }} {{ $t('account.rewards') }}
              </div>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="(i, k) in rewards"
                  :key="`r-${k}`"
                  class="badge badge-sm badge-outline font-mono text-[11px]"
                >{{ format.formatToken2(i) }}</span>
                <span v-if="!rewards?.length" class="text-secondary text-xs">—</span>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-primary btn-sm w-full mt-auto"
              @click="dialog.open('withdraw_commission', { validator_address: v.operator_address || validator.value })"
            >{{ $t('account.btn_withdraw') }}</button>
          </div>
        </div>
      </div>

      <div class="sz-section overflow-hidden lg:!col-span-2">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Identity</div>
            <div class="sz-section-title">{{ $t('staking.addresses') }}</div>
          </div>
        </div>
        <div class="px-4 py-3 space-y-3">
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              {{ $t('staking.account_addr') }}
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="addresses.account"
                @click="copyWebsite(addresses.account || '')"
              />
            </div>
            <RouterLink
              class="sz-hash text-primary link link-hover break-all text-[12px]"
              :to="`/${chain}/account/${addresses.account}`"
            >{{ addresses.account || '—' }}</RouterLink>
          </div>
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              {{ $t('staking.operator_addr') }}
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="v.operator_address"
                @click="copyWebsite(v.operator_address || '')"
              />
            </div>
            <div class="sz-hash text-[12px] break-all">{{ v.operator_address || validator.value }}</div>
          </div>
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              {{ $t('staking.consensus_pub_key') }}
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="v.consensus_pubkey?.key"
                @click="copyWebsite(v.consensus_pubkey?.key || '')"
              />
            </div>
            <div class="sz-hash text-[12px] break-all">{{ v.consensus_pubkey?.key || '—' }}</div>
            <div
              v-if="v.consensus_pubkey?.['@type']"
              class="text-[10.5px] text-secondary font-mono mt-0.5 break-all opacity-80"
            >{{ v.consensus_pubkey['@type'] }}</div>
          </div>
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              {{ $t('staking.hex_addr') }}
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="addresses.hex"
                @click="copyWebsite(addresses.hex || '')"
              />
            </div>
            <div class="sz-hash text-[12px] break-all">{{ addresses.hex || '—' }}</div>
          </div>
          <div>
            <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-secondary mb-0.5">
              {{ $t('staking.signer_addr') }}
              <Icon
                icon="mdi:content-copy"
                class="cursor-pointer text-sm opacity-70 hover:opacity-100"
                v-show="addresses.valCons"
                @click="copyWebsite(addresses.valCons || '')"
              />
            </div>
            <div class="sz-hash text-[12px] break-all">{{ addresses.valCons || '—' }}</div>
          </div>
        </div>
      </div>
    </div>
    <!-- DELEGATIONS / DELEGATORS -->
    <section v-if="!isGno" id="sz-delegations" class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">{{ $t('account.delegations') }}</div>
          <div class="sz-section-title">
            {{ $t('staking.delegators') }}
            <span class="font-mono text-secondary font-medium text-sm ml-2">
              {{ delegatorTotal > 0 ? delegatorTotal.toLocaleString() : (delegations.delegation_responses?.length || 0) }}
            </span>
            <span
              v-if="delegationsLoading && allDelegations.length"
              class="font-mono text-[10.5px] text-secondary opacity-60 ml-1"
            >loading {{ allDelegations.length.toLocaleString() }}/{{ delegatorTotal ? delegatorTotal.toLocaleString() : '…' }}</span>
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th style="width: 3rem">#</th>
              <th>{{ $t('account.delegator') }}</th>
              <th class="text-right">{{ $t('account.delegation') }}</th>
              <th class="text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="delegationsLoading && !sortedDelegations.length">
              <td colspan="4" class="text-center text-secondary py-8 text-sm">Loading delegators…</td>
            </tr>
            <tr v-else-if="!sortedDelegations.length">
              <td colspan="4" class="text-center text-secondary py-8 text-sm">
                <template v-if="delLoadError">
                  Failed to load delegations — retrying when the endpoint recovers…
                </template>
                <template v-else>
                  {{ $t('account.no_delegations') || 'No delegations found.' }}
                </template>
              </td>
            </tr>
            <tr
              v-for="(row, i) in sortedDelegations"
              :key="row.delegation?.delegator_address + '-' + i"
            >
              <td>
                <span class="sz-chip font-mono !text-[10px]">
                  {{ (delPageNum - 1) * delPageSize + i + 1 }}
                </span>
              </td>
              <td>
                <RouterLink
                  class="sz-hash text-primary link link-hover"
                  :to="`/${chain}/account/${row.delegation?.delegator_address}`"
                >{{ shortAddr(row.delegation?.delegator_address) }}</RouterLink>
              </td>
              <td class="text-right font-mono text-[12.5px] tabular">
                {{ format.formatToken(row.balance) }}
              </td>
              <td class="text-right font-mono text-[12.5px] tabular text-secondary">
                {{ format.calculatePercent(row.balance?.amount, v.tokens) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-1">
        <label class="flex items-center gap-2 text-[11.5px] text-secondary">
          <span>Rows</span>
          <select
            v-model.number="delPageSize"
            class="select select-bordered select-xs !h-7 !min-h-0 font-mono text-[12px]"
            @change="onDelPageSizeChange"
          >
            <option v-for="s in DEL_PAGE_SIZES" :key="s" :value="s">{{ s }}</option>
          </select>
          <span class="opacity-70">per page</span>
        </label>
        <PaginationBar
          :key="delPageSize"
          :total="String(delegatorTotal || delegations.pagination?.total || 0)"
          :limit="delPageSize"
          :callback="pageload"
        />
      </div>
    </section>

    <!-- GNO TRANSACTIONS (indexer — RPC has tx_index=off) -->
    <section v-if="isGno" class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head flex-wrap gap-3">
        <div>
          <div class="sz-section-kicker">History</div>
          <div class="sz-section-title">
            Transactions
            <span v-if="gnoTxs.length" class="text-[12px] font-normal text-secondary ml-1">
              ({{ gnoTxs.length }}{{ gnoTxsHasNext ? '+' : '' }} · showing {{ gnoTxsPage.length }})
            </span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2 text-[11.5px] text-secondary">
            <span class="font-mono" :title="gnoTxsPrimaryAddr || addresses.operAddress || validator">
              {{ shortAddr(gnoTxsPrimaryAddr || addresses.operAddress || validator) }}
            </span>
            <span class="opacity-60">·</span>
            <span>operator · via indexer</span>
          </div>
          <div class="sz-acc-page-size">
            <button
              v-for="size in GNO_TX_PAGE_SIZES"
              :key="size"
              type="button"
              class="sz-acc-page-btn"
              :class="{ 'sz-acc-page-btn--active': gnoTxHistoryLimit === size }"
              @click="setGnoTxHistorySize(size)"
            >{{ size }}</button>
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th style="width: 9%">Block</th>
              <th style="width: 17%">Tx Hash</th>
              <th style="width: 15%">Function</th>
              <th style="width: 17%">From</th>
              <th style="width: 13%">Amount</th>
              <th style="width: 10%">Fee</th>
              <th style="width: 8%">Status</th>
              <th style="width: 11%" class="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="gnoTxsLoading && !gnoTxs.length">
              <td colspan="8" class="text-center text-secondary py-8 text-sm">Loading transactions…</td>
            </tr>
            <tr v-else-if="gnoTxsError && !gnoTxs.length">
              <td colspan="8" class="text-center text-secondary py-8 text-sm">Failed to load transactions — indexer may be temporarily unavailable.</td>
            </tr>
            <tr v-else-if="!gnoTxs.length">
              <td colspan="8" class="text-center text-secondary py-8 text-sm">No transactions for this address yet.</td>
            </tr>
            <tr v-for="(tx, i) in gnoTxsPage" :key="tx.txHash || i">
              <td>
                <RouterLink class="font-mono text-[12px] text-primary link link-hover" :to="`/${chain}/block/${tx.blockHeight}`">
                  #{{ tx.blockHeight }}
                </RouterLink>
              </td>
              <td class="max-w-[180px]">
                <RouterLink
                  v-if="tx.txHash"
                  class="sz-hash font-mono text-[11.5px] text-primary link link-hover"
                  :to="`/${chain}/tx/${encodeURIComponent(tx.txHash)}`"
                  :title="tx.txHash"
                >{{ shortTxHash(tx.txHash) }}</RouterLink>
                <span v-else class="sz-hash font-mono text-[11.5px]">—</span>
              </td>
              <td>
                <span class="sz-chip !text-[10px]" :class="gnoTxFuncLabel(tx).slug === 'bank' ? 'sz-chip--ok' : 'sz-chip--info'">
                  {{ gnoTxFuncLabel(tx).label }}
                </span>
                <div
                  v-if="tx.func?.[0]?.pkgPath && tx.func[0].pkgPath !== 'GNOT Transfer'"
                  class="text-[10px] text-secondary font-mono mt-0.5 truncate max-w-[150px]"
                  :title="tx.func[0].pkgPath"
                >{{ tx.func[0].pkgPath.replace(/^gno\.land\//, '') }}</div>
              </td>
              <td>
                <RouterLink
                  v-if="tx.fromAddress"
                  class="font-mono text-[11.5px] text-primary link link-hover"
                  :to="`/${chain}/account/${tx.fromAddress}`"
                  :title="tx.fromAddress"
                >{{ shortAddr(tx.fromAddress) }}</RouterLink>
                <span v-else class="font-mono text-[11.5px]">—</span>
                <div v-if="tx.fromName" class="text-[10px] text-secondary">{{ tx.fromName }}</div>
              </td>
              <td><span class="font-mono text-[11.5px]">{{ gnoTxAmount(tx.amount) }}</span></td>
              <td><span class="font-mono text-[11px] text-secondary">{{ gnoTxAmount(tx.fee) }}</span></td>
              <td>
                <span v-if="tx.successYn" class="sz-chip sz-chip--ok !text-[10px]">OK</span>
                <span v-else class="sz-chip sz-chip--bad !text-[10px]">FAIL</span>
              </td>
              <td class="text-right">
                <span class="font-mono text-[11.5px] text-secondary whitespace-nowrap" :title="tx.timestamp">
                  {{ gnoTxAge(tx.timestamp) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="sz-acc-pager border-t border-base-content/10" v-if="gnoTxs.length > gnoTxHistoryLimit || gnoTxsHasNext">
        <button type="button" class="sz-acc-pager-btn" :disabled="gnoTxHistoryPage === 1" @click="setGnoTxHistoryPage(gnoTxHistoryPage - 1)">← Prev</button>
        <span class="sz-acc-pager-info">Page {{ gnoTxHistoryPage }} / {{ gnoTxHistoryPageCount }}{{ gnoTxsHasNext ? '+' : '' }}</span>
        <button
          type="button"
          class="sz-acc-pager-btn"
          :disabled="gnoTxHistoryPage * gnoTxHistoryLimit >= gnoTxs.length && !gnoTxsHasNext"
          @click="setGnoTxHistoryPage(gnoTxHistoryPage + 1)"
        >Next →</button>
        <button
          v-if="gnoTxsHasNext"
          type="button"
          class="sz-acc-pager-btn ml-2"
          :disabled="gnoTxsLoadingMore"
          @click="loadMoreGnoTxs"
        >{{ gnoTxsLoadingMore ? 'Loading…' : 'Fetch more' }}</button>
      </div>
    </section>

    <!-- ACTIVITIES (Cosmos LCD/tx only — Gno tx_index=off) -->
    <section v-if="!isGno" class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head flex-wrap gap-3">
        <div>
          <div class="sz-section-kicker">History</div>
          <div class="sz-section-title">{{ $t('staking.activities') }}</div>
        </div>
        <div class="sz-tabs">
          <button
            type="button"
            class="sz-tab"
            :class="{ 'sz-tab--active': activityTab === 'power' }"
            @click="setActivityTab('power')"
          >{{ $t('staking.power_events') }}</button>
          <button
            type="button"
            class="sz-tab"
            :class="{ 'sz-tab--active': activityTab === 'votes' }"
            @click="setActivityTab('votes')"
          >
            {{ $t('staking.votes') }}
            <span v-if="votesTotal" class="font-mono text-[10px] ml-1 opacity-70">{{ votesTotal }}</span>
          </button>
          <button
            type="button"
            class="sz-tab"
            :class="{ 'sz-tab--active': activityTab === 'txs' }"
            @click="setActivityTab('txs')"
          >{{ $t('account.transactions') }}</button>
        </div>
      </div>

      <!-- POWER EVENTS -->
      <div v-if="activityTab === 'power'">
        <div class="px-4 pt-3 pb-1 flex flex-wrap items-center gap-2">
          <div class="sz-tabs !p-0.5">
            <button
              type="button"
              class="sz-tab !py-1 !px-3 !text-[12px]"
              :class="{ 'sz-tab--active': selectedEventType === EventType.Delegate }"
              @click="loadPowerEvents(1, EventType.Delegate)"
            >{{ $t('account.btn_delegate') }}</button>
            <button
              type="button"
              class="sz-tab !py-1 !px-3 !text-[12px]"
              :class="{ 'sz-tab--active': selectedEventType === EventType.Unbond }"
              @click="loadPowerEvents(1, EventType.Unbond)"
            >{{ $t('account.btn_unbond') }}</button>
            <button
              type="button"
              class="sz-tab !py-1 !px-3 !text-[12px]"
              :class="{ 'sz-tab--active': selectedEventType === EventType.Redelegate }"
              @click="loadPowerEvents(1, EventType.Redelegate)"
            >{{ $t('account.btn_redelegate') }}</button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="sz-table">
            <thead>
              <tr>
                <th>{{ $t('account.delegator') }}</th>
                <th>{{ $t('account.amount') }}</th>
                <th class="text-right">{{ $t('account.height') }} / {{ $t('account.time') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!events.tx_responses?.length">
                <td colspan="3" class="text-center text-secondary py-8 text-sm">No power events.</td>
              </tr>
              <tr v-for="(item, i) in pagedPowerEvents" :key="item.txhash + '-' + i">
                <td class="max-w-[240px]">
                  <div class="flex flex-col gap-0.5">
                    <RouterLink
                      v-for="d in mapDelegators(item.tx?.body?.messages)"
                      :key="d"
                      class="sz-hash text-primary link link-hover truncate"
                      :to="`/${chain}/account/${d}`"
                    >{{ shortAddr(d) }}</RouterLink>
                  </div>
                </td>
                <td>
                  <div
                    class="flex items-center gap-1.5 font-mono text-[12.5px]"
                    :class="{
                      'text-success': rowSign(item) === 1,
                      'text-error': rowSign(item) === -1,
                    }"
                  >
                    <RouterLink :to="`/${chain}/tx/${item.txhash}`" class="link link-hover">
                      {{ rowSign(item) === 1 ? '+' : '−' }}
                      {{ mapEvents(item.events) }}
                    </RouterLink>
                    <Icon v-if="item.code === 0" icon="mdi-check" class="text-yes text-sm" />
                    <Icon v-else icon="mdi-multiply" class="text-no text-sm" />
                  </div>
                </td>
                <td class="text-right">
                  <RouterLink
                    class="font-mono text-[12px] text-primary link link-hover"
                    :to="`/${chain}/block/${item.height}`"
                  >{{ item.height }}</RouterLink>
                  <div class="text-[11px] text-secondary">{{ format.toDay(item.timestamp, 'from') }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="px-4 py-2.5 border-t border-base-content/10 flex flex-wrap items-center gap-3 text-[11.5px] text-secondary">
          <span>
            Holding the latest
            <b class="font-mono text-main">{{ events.tx_responses?.length || 0 }}</b>
            of
            <b class="font-mono text-main">{{ events.pagination?.total || (events as any).total || 0 }}</b>
            <span>events</span>
          </span>
        </div>
        <div class="px-2">
          <PaginationBar
            :total="String(events.tx_responses?.length || 0)"
            :limit="PE_PAGE_SIZE"
            :callback="pagePowerEvents"
          />
        </div>
      </div>

      <!-- VOTES (from vote-indexer) -->
      <div v-else-if="activityTab === 'votes'">
        <div class="overflow-x-auto">
          <table class="sz-table">
            <thead>
              <tr>
                <th style="width: 4rem">#</th>
                <th>Proposal</th>
                <th class="text-center">Vote</th>
                <th>Tx Hash</th>
                <th class="text-right">{{ $t('account.time') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="votesLoading && !votes.length">
                <td colspan="5" class="text-center text-secondary py-8 text-sm">Loading votes…</td>
              </tr>
              <tr v-else-if="!votes.length">
                <td colspan="5" class="text-center text-secondary py-8 text-sm">
                  {{ $t('staking.no_votes') }}
                </td>
              </tr>
              <tr v-for="row in votes" :key="row.proposal_id + '-' + row.txhash">
                <td>
                  <RouterLink
                    class="sz-chip font-mono !text-[10px] text-primary link link-hover"
                    :to="`/${chain}/gov/${row.proposal_id}`"
                  >#{{ row.proposal_id }}</RouterLink>
                </td>
                <td class="max-w-[18rem]">
                  <RouterLink
                    class="text-[13px] font-semibold text-primary no-underline hover:underline truncate block max-w-full"
                    :to="`/${chain}/gov/${row.proposal_id}`"
                  >{{ row.title || `Proposal #${row.proposal_id}` }}</RouterLink>
                  <div class="text-[11px] text-secondary font-mono">h {{ row.height || '—' }}</div>
                </td>
                <td class="text-center">
                  <span class="sz-chip !text-[10px]" :class="optionChipClass(row.option)">
                    {{ optionLabel(row.option) }}
                  </span>
                </td>
                <td>
                  <RouterLink
                    v-if="row.txhash"
                    :to="`/${chain}/tx/${row.txhash}`"
                    class="sz-hash link link-hover text-primary font-mono text-[11.5px]"
                    :title="row.txhash"
                  >{{ shortTx(row.txhash) }}</RouterLink>
                  <span v-else class="text-secondary font-mono text-[11.5px]">—</span>
                </td>
                <td class="text-right">
                  <span class="font-mono text-[11.5px] text-secondary whitespace-nowrap" :title="row.timestamp || ''">
                    {{ voteTimeLabel(row.timestamp) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="px-4 py-2.5 border-t border-base-content/10 flex flex-wrap items-center gap-3 text-[11.5px] text-secondary">
          <span>
            Indexed votes
            <b class="font-mono text-main">{{ votesTotal }}</b>
            <span class="opacity-70"> · source: vote-indexer</span>
          </span>
        </div>
        <div class="px-2">
          <PaginationBar
            :total="String(votesTotal)"
            :limit="VOTES_LIMIT"
            :callback="pageVotes"
          />
        </div>
      </div>

      <!-- TRANSACTIONS -->
      <div v-else>
        <div class="overflow-x-auto">
          <table class="sz-table">
            <thead>
              <tr>
                <th>{{ $t('account.height') }}</th>
                <th>{{ $t('account.hash') }}</th>
                <th>{{ $t('account.messages') }}</th>
                <th class="text-right">{{ $t('account.time') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!txs.tx_responses?.length">
                <td colspan="4" class="text-center text-secondary py-8 text-sm">No transactions.</td>
              </tr>
              <tr v-for="(item, i) in txs.tx_responses" :key="item.txhash + '-' + i">
                <td>
                  <RouterLink
                    class="font-mono text-[12px] text-primary link link-hover"
                    :to="`/${chain}/block/${item.height}`"
                  >{{ item.height }}</RouterLink>
                </td>
                <td class="max-w-[200px]">
                  <RouterLink
                    class="sz-hash text-primary link link-hover"
                    :to="`/${chain}/tx/${item.txhash}`"
                  >{{ shortTx(item.txhash) }}</RouterLink>
                </td>
                <td>
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="truncate text-[12.5px]">{{ format.messages(item.tx.body.messages) }}</span>
                    <Icon v-if="item.code === 0" icon="mdi-check" class="text-yes shrink-0" />
                    <Icon v-else icon="mdi-multiply" class="text-no shrink-0" />
                  </div>
                </td>
                <td class="text-right font-mono text-[11.5px] text-secondary whitespace-nowrap">
                  {{ format.toDay(item.timestamp, 'from') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div ref="txsSentinel" class="px-4 py-2.5 border-t border-base-content/10 flex items-center justify-between text-[11.5px] text-secondary">
          <span>
            Showing the latest
            <b class="font-mono text-main">{{ txs.tx_responses?.length || 0 }}</b>
            tx
          </span>
          <span v-if="txsLoading" class="flex items-center gap-1.5">
            <span class="loading loading-spinner loading-xs"></span>
            Loading…
          </span>
          <RouterLink
            v-else-if="txsCapped"
            class="link link-primary no-underline hover:underline"
            :to="`/${chain}/account/${addresses.operAddress || addresses.account}`"
          >
            Capped at {{ TXS_MAX }} — full history on the account page →
          </RouterLink>
          <span v-else-if="!txsHasMore && (txs.tx_responses?.length || 0) > 0" class="opacity-70">
            End of list
          </span>
          <span v-else-if="txsHasMore && (txs.tx_responses?.length || 0) > 0" class="opacity-70">Scroll for more</span>
        </div>
      </div>
    </section>

    <!-- copy toasts -->
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
  </div>
</template>

<style scoped>
.sz-val-hero-inner {
  padding: 1.15rem 1.25rem 1.25rem;
}
.sz-val-avatar {
  width: 5.25rem;
  height: 5.25rem;
  border-radius: 16px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--sz-border);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sz-val-avatar-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.75rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: hsl(var(--p));
  background: var(--sz-accent-soft);
}
.sz-val-details {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* Gno valoper profile — Cosmos SDK hero-style clamp + read more */
.sz-gno-profile--clamped {
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sz-gno-profile-toggle {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.sz-gno-profile-toggle:hover {
  text-decoration: underline;
}
.sz-hero-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
  padding: 0.28rem 0.7rem;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  border: 1px solid var(--sz-border);
  background: transparent;
  text-decoration: none;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.sz-hero-link:hover {
  color: hsl(var(--p));
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, var(--sz-border));
  background: var(--sz-accent-soft);
}
.sz-hero-link--muted {
  opacity: 0.72;
  cursor: default;
}
.sz-hero-link-label {
  color: var(--text-secondary);
  font-weight: 700;
  letter-spacing: 0.02em;
}
.sz-hero-link-value {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-main);
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sz-hero-link--muted .sz-hero-link-value {
  color: var(--text-secondary);
}

/* Gno tx history pager — match account AtomOne UX (classes shared) */
.sz-acc-page-size {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 10px;
  background: color-mix(in srgb, hsl(var(--bc)) 5%, transparent);
  border: 1px solid var(--sz-border, rgba(128,128,128,.25));
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
  color: var(--text-secondary, #888);
  cursor: pointer;
}
.sz-acc-page-btn--active {
  color: white;
  background: hsl(var(--p));
}
.sz-acc-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  padding: 0.85rem 1rem 0.95rem;
}
.sz-acc-pager-btn {
  display: inline-flex;
  align-items: center;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 700;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: transparent;
  border: 1px solid var(--sz-border, rgba(128,128,128,.25));
  cursor: pointer;
}
.sz-acc-pager-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.sz-acc-pager-info {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-secondary, #888);
}
</style>
