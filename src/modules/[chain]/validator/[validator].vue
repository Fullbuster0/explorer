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
}
const selectedEventType = ref(EventType.Delegate);

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

function pageload(p: number) {
  delPage.setPage(p);
  delPage.limit = 10;
  delPage.count_total = true;
  delegationsLoading.value = true;
  blockchain.rpc
    .getStakingValidatorsDelegations(validator, delPage)
    .then((res) => {
      delegations.value = res;
      const total = Number(res?.pagination?.total || 0);
      if (total > 0) delegatorTotal.value = total;
      else if (res?.delegation_responses) {
        // some LCDs omit total — fall back to page length on first page
        if (p === 1) delegatorTotal.value = res.delegation_responses.length;
      }
    })
    .catch(() => {
      /* leave empty */
    })
    .finally(() => {
      delegationsLoading.value = false;
    });
}

function loadPowerEvents(p: number, type: EventType) {
  selectedEventType.value = type;
  powerPage.setPage(p);
  powerPage.setPageSize(10);
  blockchain.rpc
    .getTxs("?order_by=2&events={type}.validator='{validator}'", { type: selectedEventType.value, validator }, powerPage)
    .then((res) => {
      events.value = res;
    })
    .catch(() => {
      events.value = {} as PaginatedTxs;
    });
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

function mapEvents(evts: { type: string; attributes: { key: string; value: string }[] }[]) {
  const attributes = evts
    .filter((x) => x.type === selectedEventType.value)
    .filter(
      (x) =>
        x.attributes.findIndex(
          (attr) => attr.value === validator || attr.value === toBase64(stringToUint8Array(validator))
        ) > -1
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

  // Delegators — enabled (count + first page). Was disabled for perf; limit=10 is fine.
  pageload(1);
  pagePowerEvents(1);
  // Prefetch votes in background so Activities → Votes is instant
  loadVotes(1);
});

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
              >
                <Icon icon="mdi-web" class="text-base" />
                {{ $t('staking.website') }}
              </a>
              <a
                v-if="v.description?.security_contact"
                :href="'mailto:' + v.description.security_contact"
                class="sz-hero-link"
              >
                <Icon icon="mdi-email-outline" class="text-base" />
                {{ $t('staking.contact') }}
              </a>
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

    <!-- COMMISSION + REWARDS + ADDRESSES -->
    <div class="grid grid-cols-1 lg:!grid-cols-3 gap-4 mb-4">
      <CommissionRate :commission="v.commission" />

      <div class="sz-section overflow-hidden flex flex-col">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Earnings</div>
            <div class="sz-section-title">{{ $t('staking.commissions_&_rewards') }}</div>
          </div>
        </div>
        <div class="px-4 py-3 flex-1 flex flex-col gap-3 min-h-0">
          <div class="overflow-auto flex-1 max-h-48">
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
            class="btn btn-primary btn-sm w-full"
            @click="dialog.open('withdraw_commission', { validator_address: v.operator_address || validator })"
          >{{ $t('account.btn_withdraw') }}</label>
        </div>
      </div>

      <div class="sz-section overflow-hidden">
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
    <!-- STAKING / DELEGATORS -->
    <section class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Staking</div>
          <div class="sz-section-title">
            {{ $t('account.delegations') }}
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
            <tr v-if="delegationsLoading && !delegations.delegation_responses?.length">
              <td colspan="4" class="text-center text-secondary py-8 text-sm">Loading delegators…</td>
            </tr>
            <tr v-else-if="!delegations.delegation_responses?.length">
              <td colspan="4" class="text-center text-secondary py-8 text-sm">
                {{ $t('account.no_delegations') || 'No delegations found.' }}
              </td>
            </tr>
            <tr
              v-for="(row, i) in delegations.delegation_responses"
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
                      'text-success': selectedEventType === EventType.Delegate,
                      'text-error': selectedEventType === EventType.Unbond,
                    }"
                  >
                    <RouterLink :to="`/${chain}/tx/${item.txhash}`" class="link link-hover">
                      {{ selectedEventType === EventType.Delegate ? '+' : '−' }}
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
</style>
