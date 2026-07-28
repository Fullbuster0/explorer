<script setup lang="ts">
import { parseCoins } from '@cosmjs/stargate';
import {
  useBankStore,
  useBlockchain,
  useDistributionStore,
  useFormatter,
  useMintStore,
  useStakingStore,
  useTxDialog,
} from '@/stores';
import { onMounted, computed, ref, watch } from 'vue';
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

const props = defineProps(['validator', 'chain']);

const staking = useStakingStore();
const blockchain = useBlockchain();
const format = useFormatter();
const dialog = useTxDialog();

const validator: string = props.validator;

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

addresses.value.account = operatorAddressToAccount(validator);

// self bond — refetched via the rpc watch below. Setup runs before the chain's
// REST client exists on slow-connecting chains (e.g. CosmosHub); rpc?. would
// otherwise resolve undefined silently and leave this stuck at "—".
function loadSelfBond(force = false) {
  if (!blockchain.rpc || !validator) return;
  // Keep account derivation in sync (valoper → account) every call.
  if (!addresses.value.account) {
    addresses.value.account = operatorAddressToAccount(validator);
  }
  if (!addresses.value.account) return;
  if (!force && selfBonded.value.balance?.amount) return; // already loaded
  staking
    .fetchValidatorDelegation(validator, addresses.value.account)
    .then((x) => {
      if (x?.delegation_response) selfBonded.value = x.delegation_response;
    })
    .catch((e: any) => {
      // Many public LCDs 500 on the single-delegation path; fall back by
      // scanning the first page of validator delegations for this account.
      console.warn('[val] self-bond direct path failed:', e?.message || e);
      return blockchain.rpc
        .getStakingValidatorsDelegations(validator, (() => {
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

const powerPercent = computed(() => {
  if (!v.value.tokens || !staking.totalPower) return '—';
  return format.calculatePercent(v.value.tokens, String(staking.totalPower));
});

const bondDenomDisplay = computed(() => {
  const d = String(staking.params.bond_denom || '');
  return d.replace(/^u/, '').toUpperCase() || d.toUpperCase();
});

const rank = computed(() => {
  const list = staking.validators || [];
  const idx = list.findIndex((x) => x.operator_address === validator);
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
      return await blockchain.rpc.getStakingValidatorsDelegations(validator, pr);
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
  return null; // permanent failure for this page
}

async function loadAllDelegations() {
  if (!blockchain.rpc || !validator) return;
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
  console.info('[val] loadPowerEvents', type, 'rpc=', !!blockchain.rpc, 'current=', !!blockchain.current);
  selectedEventType.value = type;
  pePageNum.value = 1;
  if (type === EventType.Redelegate) {
    fetchRedelegateCombined();
    return;
  }

  const tmpl = eventTypeQuery[type][0];
  const q = tmpl.replace('{validator}', validator);
  blockchain
    .fetchPowerEventsTxs(`?${q}`, { validator }, powerPage, ACTIVITY_LIMIT)
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
    `?${t.replace('{validator}', validator)}`
  );

  // Run both archive-first walks in parallel; tag rows by which side matched.
  const [inRes, outRes] = await Promise.all([
    blockchain.fetchPowerEventsTxs(inQ, { validator }, powerPage, ACTIVITY_LIMIT),
    blockchain.fetchPowerEventsTxs(outQ, { validator }, powerPage, ACTIVITY_LIMIT),
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
  } as PaginatedTxs;
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
      txs.value = x || ({ tx_responses: [] } as PaginatedTxs);
      txsPage = 1;
      txsHasMore.value = (x?.tx_responses?.length || 0) >= ACTIVITY_LIMIT;
    })
    .catch(() => {
      txs.value = { tx_responses: [] } as PaginatedTxs;
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
          (attr) => attr.value === validator || attr.value === toBase64(stringToUint8Array(validator))
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
  if (!blockchain.rpc || !validator) return;
  if (!v.value.operator_address) {
    staking
      .fetchValidator(validator)
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
      .getDistributionValidatorOutstandingRewards(validator)
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
      .getDistributionValidatorCommission(validator)
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
  if (!validator) return;

  loadValidatorCore();

  // Delegators — fetch all and sort globally desc.
  // Wait for rpc readiness: onMounted can fire before chain endpoint is set.
  if (blockchain.rpc) {
    loadAllDelegations();
    loadPowerEvents(1, EventType.Delegate);
  }
  // Prefetch votes in background so Activities → Votes is instant
  loadVotes(1);
});

// Retry delegations + power events once REST client is ready
watch(
  () => blockchain.rpc,
  (rpc) => {
    console.info('[val] rpc watch fired, rpc=', !!rpc, 'events=', events.value?.tx_responses?.length);
    if (rpc && !allDelegations.value.length && !delegationsLoading.value) {
      loadAllDelegations();
    }
    if (rpc && !selfBonded.value.balance?.amount) {
      loadSelfBond();
    }
    if (rpc && !v.value.operator_address) {
      loadValidatorCore();
    }
    if (rpc && !events.value?.tx_responses?.length) {
      console.info('[val] calling loadPowerEvents');
      loadPowerEvents(1, selectedEventType.value || EventType.Delegate);
    }
  },
  { immediate: true }
);

watch(
  () => props.validator,
  () => {
    // hard reload path — route param change remounts typically; keep safe
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
                {{ v.description?.moniker || shortAddr(validator) }}
              </h1>
              <span v-if="rank" class="sz-chip sz-chip--info font-mono">#{{ rank }}</span>
              <span class="sz-chip" :class="statusChip">{{ statusLabel }}</span>
              <span v-if="v.jailed" class="sz-chip sz-chip--bad">JAILED</span>
            </div>

            <p v-if="v.description?.details" class="sz-val-details text-secondary text-[13px] leading-relaxed mt-1 mb-3">
              {{ v.description.details }}
            </p>
            <p v-else class="text-secondary text-[12.5px] italic mt-1 mb-3">
              {{ $t('staking.no_description') }}
            </p>

            <div class="flex flex-wrap items-center gap-2">
              <a
                v-if="v.description?.website"
                :href="v.description.website.startsWith('http') ? v.description.website : `https://${v.description.website}`"
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
                :href="'mailto:' + v.description.security_contact"
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
              <label
                for="delegate"
                class="btn btn-primary btn-sm ml-auto sm:!ml-0"
                @click="dialog.open('delegate', { validator_address: v.operator_address || validator })"
              >
                <Icon icon="mdi-handshake-outline" class="text-base mr-1" />
                {{ $t('account.btn_delegate') }}
              </label>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- METRIC STRIP (sz-stat instrument tiles) -->
    <div class="grid grid-cols-2 md:!grid-cols-3 xl:!grid-cols-6 gap-3 mb-4">
      <div class="sz-stat" style="--stat-hue: var(--sz-accent)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.total_bonded') }}</span></div>
        <div class="sz-stat-value">
          {{ format.formatToken({ amount: v.tokens, denom: staking.params.bond_denom }, false, '0,0') }}
          <span class="sz-stat-unit">{{ bondDenomDisplay }}</span>
        </div>
        <div class="sz-stat-sub">VP {{ powerPercent }}</div>
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

    <!-- COMMISSION & EARNINGS (merged) + ADDRESSES -->
    <div class="grid grid-cols-1 lg:!grid-cols-5 gap-4 mb-4">
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
            <label
              for="withdraw_commission"
              class="btn btn-primary btn-sm w-full mt-auto"
              @click="dialog.open('withdraw_commission', { validator_address: v.operator_address || validator })"
            >{{ $t('account.btn_withdraw') }}</label>
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
            <div class="sz-hash text-[12px] break-all">{{ v.operator_address || validator }}</div>
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
    <section id="sz-delegations" class="sz-section mb-4 overflow-hidden">
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

    <!-- ACTIVITIES -->
    <section class="sz-section mb-4 overflow-hidden">
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
            <b class="font-mono text-main">{{ events.pagination?.total || events.total || 0 }}</b>
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
            :to="`/${chain}/account/${addresses.account}`"
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
</style>
