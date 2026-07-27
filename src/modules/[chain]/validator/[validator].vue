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
const delPage = new PageRequest();

addresses.value.account = operatorAddressToAccount(validator);

// self bond
staking.fetchValidatorDelegation(validator, addresses.value.account).then((x) => {
  if (x) selfBonded.value = x.delegation_response;
});

// account txs
blockchain.rpc.getTxsBySender(addresses.value.account).then((x) => {
  txs.value = x;
});

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

const commissionRate = computed(() => {
  const r = Number(v.value.commission?.commission_rates?.rate || 0);
  return `${(r * 100).toFixed(2)}%`;
});

const commissionMax = computed(() => {
  const r = Number(v.value.commission?.commission_rates?.max_rate || 0);
  return `${(r * 100).toFixed(0)}%`;
});

const commissionChange = computed(() => {
  const r = Number(v.value.commission?.commission_rates?.max_change_rate || 0);
  return `${(r * 100).toFixed(0)}%`;
});

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

/** Fetch ALL delegations for this validator, then sort globally by balance desc.
 *  LCD page order is unstable across pages, so we cannot rely on per-page sort. */
const allDelegations = ref<any[]>([]);
async function loadAllDelegations() {
  if (!blockchain.rpc || !validator) return;
  // already loading or already have data — skip
  if (delegationsLoading.value) return;
  allDelegations.value = [];
  delegationsLoading.value = true;
  try {
    const PAGE = 100;
    const pr = new PageRequest();
    pr.limit = PAGE;
    pr.count_total = true;
    pr.offset = 0;
    let page = 1;
    while (true) {
      pr.setPage(page);
      let res: any = null;
      try {
        res = await blockchain.rpc.getStakingValidatorsDelegations(validator, pr);
      } catch {
        break;
      }
      const rows = res?.delegation_responses || [];
      if (!rows.length) break;
      allDelegations.value.push(...rows);
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
    // global sort desc by amount
    allDelegations.value.sort((a, b) => {
      const aa = Number(a?.balance?.amount || 0);
      const bb = Number(b?.balance?.amount || 0);
      return bb - aa;
    });
    if (!delegatorTotal.value) {
      delegatorTotal.value = allDelegations.value.length;
    }
  } finally {
    delegationsLoading.value = false;
  }
}

/** Page flip is pure client-side once allDelegations is loaded. */
function pageload(p: number) {
  delPage.limit = 10;
  delPage.setPage(p);
  // If we haven't loaded yet, kick off the full fetch
  if (!allDelegations.value.length && !delegationsLoading.value) {
    loadAllDelegations();
  }
}

function loadPowerEvents(p: number, type: EventType) {
  selectedEventType.value = type;
  powerPage.setPage(p);
  powerPage.setPageSize(10);

  if (type === EventType.Redelegate) {
    fetchRedelegateCombined(p);
    return;
  }

  const tmpl = eventTypeQuery[type][0];
  const q = tmpl.replace('{validator}', validator);
  blockchain
    .fetchPowerEventsTxs(`?${q}`, { validator }, powerPage)
    .then((res: any) => {
      events.value = res || ({} as PaginatedTxs);
    })
    .catch(() => {
      events.value = {} as PaginatedTxs;
    });
}

/**
 * Redelegate tab = "in" (destination) + "out" (source) merged.
 * Each side uses archive-first fallback, then merged + sorted + tagged.
 */
async function fetchRedelegateCombined(p: number) {
  powerPage.setPage(p);
  powerPage.setPageSize(10);

  const [inQ, outQ] = eventTypeQuery[EventType.Redelegate].map((t) =>
    `?${t.replace('{validator}', validator)}`
  );

  // Run both archive-first walks in parallel; tag rows by which side matched.
  const [inRes, outRes] = await Promise.all([
    blockchain.fetchPowerEventsTxs(inQ, { validator }, powerPage),
    blockchain.fetchPowerEventsTxs(outQ, { validator }, powerPage),
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
    tx_responses: merged,
    pagination: { total, next_key: null },
    total,
  } as PaginatedTxs;
}

function pagePowerEvents(p: number) {
  loadPowerEvents(p, selectedEventType.value);
}

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
 *  allDelegations is globally sorted; slice by page offset/limit. */
const sortedDelegations = computed(() => {
  const limit = delPage.limit || 10;
  const offset = delPage.offset || 0;
  return allDelegations.value.slice(offset, offset + limit);
});

onMounted(() => {
  if (!validator) return;

  staking.fetchValidator(validator).then((res) => {
    v.value = res.validator;
    identity.value = res.validator?.description?.identity || '';
    if (identity.value && !avatars.value[identity.value]) loadAvatar(identity.value);

    addresses.value.hex = consensusPubkeyToHexAddress(v.value.consensus_pubkey);
    addresses.value.valCons = pubKeyToValcons(
      v.value.consensus_pubkey,
      blockchain.current?.bech32ConsensusPrefix || ''
    );
  });

  blockchain.rpc.getDistributionValidatorOutstandingRewards(validator).then((res) => {
    rewards.value = res.rewards?.rewards?.sort((a, b) => Number(b.amount) - Number(a.amount));
    res.rewards?.rewards?.forEach((x) => {
      if (x.denom.startsWith('ibc/')) format.fetchDenomTrace(x.denom);
    });
  });

  blockchain.rpc.getDistributionValidatorCommission(validator).then((res) => {
    commission.value = res.commission?.commission?.sort((a, b) => Number(b.amount) - Number(a.amount));
    res.commission?.commission?.forEach((x) => {
      if (x.denom.startsWith('ibc/')) format.fetchDenomTrace(x.denom);
    });
  });

  // Delegators — fetch all and sort globally desc.
  // Wait for rpc readiness: onMounted can fire before chain endpoint is set.
  if (blockchain.rpc) {
    loadAllDelegations();
  }
  pagePowerEvents(1);
  // Prefetch votes in background so Activities → Votes is instant
  loadVotes(1);
});

// Retry delegations once REST client is ready
watch(
  () => blockchain.rpc,
  (rpc) => {
    if (rpc && !allDelegations.value.length && !delegationsLoading.value) {
      loadAllDelegations();
    }
  }
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

    <!-- METRIC STRIP -->
    <div class="grid grid-cols-2 md:!grid-cols-3 xl:!grid-cols-6 gap-3 mb-4">
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="sz-metric-label">{{ $t('staking.total_bonded') }}</div>
          <div class="sz-metric-icon"><Icon icon="mdi-coin" /></div>
        </div>
        <div class="sz-metric-value !text-[1.15rem]">
          {{
            format.formatToken2({
              amount: v.tokens,
              denom: staking.params.bond_denom,
            })
          }}
        </div>
        <div class="sz-metric-sub">VP {{ powerPercent }}</div>
      </div>

      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="sz-metric-label">{{ $t('staking.self_bonded') }}</div>
          <div class="sz-metric-icon"><Icon icon="mdi-account-circle-outline" /></div>
        </div>
        <div class="sz-metric-value !text-[1.15rem]">
          {{ format.formatToken(selfBonded.balance) || '—' }}
        </div>
        <div class="sz-metric-sub">{{ selfRate }}</div>
      </div>

      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="sz-metric-label">{{ $t('staking.delegators') }}</div>
          <div class="sz-metric-icon"><Icon icon="mdi-account-group-outline" /></div>
        </div>
        <div class="sz-metric-value !text-[1.15rem]">
          {{ delegatorTotal > 0 ? delegatorTotal.toLocaleString() : (delegationsLoading ? '…' : '—') }}
        </div>
        <div class="sz-metric-sub">{{ $t('staking.delegators_sub') }}</div>
      </div>

      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="sz-metric-label">{{ $t('staking.commission') }}</div>
          <div class="sz-metric-icon"><Icon icon="mdi-percent-outline" /></div>
        </div>
        <div class="sz-metric-value !text-[1.15rem]">{{ commissionRate }}</div>
        <div class="sz-metric-sub">max {{ commissionMax }} · Δ {{ commissionChange }}</div>
      </div>

      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="sz-metric-label">{{ $t('staking.annual_profit') }}</div>
          <div class="sz-metric-icon sz-metric-icon--success"><Icon icon="mdi-finance" /></div>
        </div>
        <div class="sz-metric-value !text-[1.15rem]">{{ apr }}</div>
        <div class="sz-metric-sub">est. after commission</div>
      </div>

      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="sz-metric-label">{{ $t('staking.min_self') }}</div>
          <div class="sz-metric-icon"><Icon icon="mdi-lock-outline" /></div>
        </div>
        <div class="sz-metric-value !text-[1.05rem] !leading-snug">
          {{ v.min_self_delegation || '—' }}
        </div>
        <div class="sz-metric-sub font-mono">{{ staking.params.bond_denom || '' }}</div>
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
    <section class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">{{ $t('account.delegations') }}</div>
          <div class="sz-section-title">
            {{ $t('staking.delegators') }}
            <span class="font-mono text-secondary font-medium text-sm ml-2">
              {{ delegatorTotal > 0 ? delegatorTotal.toLocaleString() : (delegations.delegation_responses?.length || 0) }}
            </span>
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
                {{ $t('account.no_delegations') || 'No delegations found.' }}
              </td>
            </tr>
            <tr
              v-for="(row, i) in sortedDelegations"
              :key="row.delegation?.delegator_address + '-' + i"
            >
              <td>
                <span class="sz-chip font-mono !text-[10px]">
                  {{ (delPage.offset || 0) + i + 1 }}
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
      <div class="px-2">
        <PaginationBar
          :total="String(delegatorTotal || delegations.pagination?.total || 0)"
          :limit="delPage.limit"
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
              <tr v-for="(item, i) in events.tx_responses" :key="item.txhash + '-' + i">
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
        <div class="px-2">
          <PaginationBar
            :total="events.pagination?.total"
            :limit="powerPage.limit"
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
