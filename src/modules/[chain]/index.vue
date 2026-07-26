<script lang="ts" setup>
import MdEditor from 'md-editor-v3';
import PriceMarketChart from '@/components/charts/PriceMarketChart.vue';

import { Icon } from '@iconify/vue';
import {
  useBlockchain,
  useFormatter,
  useTxDialog,
  useWalletStore,
  useStakingStore,
  useGovStore,
  useMintStore,
  useBankStore,
  useDistributionStore,
} from '@/stores';
import { LoadingStatus } from '@/stores/useDashboard';
import { onMounted, ref, computed } from 'vue';
import { useIndexModule, colorMap, tickerUrl } from './indexStore';
import { formatSeconds } from '@/libs/utils';

import ProposalListItem from '@/components/ProposalListItem.vue';
import Loading from '@/components/Loading.vue';

const props = defineProps(['chain']);

const blockchain = useBlockchain();
const store = useIndexModule();
const walletStore = useWalletStore();
const format = useFormatter();
const dialog = useTxDialog();
const stakingStore = useStakingStore();
const govStore = useGovStore();
const mintStore = useMintStore();
const bankStore = useBankStore();
const distStore = useDistributionStore();
const coinInfo = computed(() => {
  return store.coinInfo;
});
const isProposalsLoading = computed(() => govStore.loading['2'] !== LoadingStatus.Loaded);

function refreshDashboard() {
  store.loadDashboard();
  walletStore.loadMyAsset();
  // warm tokenomics sources (pool/supply/inflation/tax) after chain switch
  distStore.fetchParams();
  stakingStore.fetchPool();
  stakingStore.fetchParams();
  mintStore.fetchInflation();
  bankStore.initial();
}

onMounted(() => {
  refreshDashboard();
});
const ticker = computed(() => store.coinInfo.tickers[store.tickerIndex]);

const currName = ref('');
blockchain.$subscribe((m, s) => {
  if (s.chainName !== currName.value) {
    currName.value = s.chainName;
    refreshDashboard();
  }
});
function shortName(name: string, id: string) {
  return name.toLowerCase().startsWith('ibc/') || name.toLowerCase().startsWith('0x') ? id : name;
}

const comLinks = computed(() => {
  return [
    {
      name: 'Website',
      icon: 'mdi-web',
      href: store.homepage,
    },
    {
      name: 'Twitter',
      icon: 'mdi-twitter',
      href: store.twitter,
    },
    {
      name: 'Telegram',
      icon: 'mdi-telegram',
      href: store.telegram,
    },
    {
      name: 'Github',
      icon: 'mdi-github',
      href: store.github,
    },
  ].filter((x) => !!x.href);
});

// wallet box
const change = computed(() => {
  const token = walletStore.balanceOfStakingToken;
  return token ? format.priceChanges(token.denom) : 0;
});
const color = computed(() => {
  switch (true) {
    case change.value > 0:
      return 'text-green-600';
    case change.value === 0:
      return 'text-grey-500';
    case change.value < 0:
      return 'text-red-600';
  }
});

function updateState() {
  walletStore.loadMyAsset();
}

function trustColor(v: string) {
  return `text-${colorMap(v)}`;
}

function formatGithubDate(iso: string) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

const githubCard = computed(() => store.githubActivity);

function commitLevel(n: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!n) return 0;
  if (!max || max <= 1) return 1;
  const r = n / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

function dayTitle(weekUnix: number, dayIdx: number, n: number): string {
  try {
    const d = new Date((weekUnix + dayIdx * 86400) * 1000);
    const label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return `${n} commit${n === 1 ? '' : 's'} · ${label}`;
  } catch {
    return `${n} commits`;
  }
}

const heatmapCells = computed(() => {
  const weeks = githubCard.value.weeks || [];
  const max = githubCard.value.maxDayCommits || 0;
  const cells: { level: 0 | 1 | 2 | 3 | 4; title: string; key: string }[] = [];
  for (const w of weeks) {
    const days = w.days?.length === 7 ? w.days : [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 7; i++) {
      const n = days[i] || 0;
      cells.push({
        level: commitLevel(n, max),
        title: dayTitle(w.week, i, n),
        key: `${w.week}-${i}`,
      });
    }
  }
  return cells;
});

const chainLogo = computed(() => blockchain.logo || blockchain.current?.logo || '');
const chainTitle = computed(() => {
  if (coinInfo.value?.name) return coinInfo.value.name;
  return blockchain.current?.prettyName || blockchain.current?.chainName || props.chain || '';
});
const chainSymbol = computed(() => {
  if (coinInfo.value?.symbol) return coinInfo.value.symbol;
  const [a] = blockchain.current?.assets || [];
  return a?.symbol || '';
});
const hasMarket = computed(() => !!(coinInfo.value && coinInfo.value.name));

/** nodes.guru-style tokenomics snapshot from live chain stores */
const tokenomics = computed(() => {
  const denom =
    stakingStore.params?.bond_denom ||
    bankStore.supply?.denom ||
    blockchain.current?.assets?.[0]?.base ||
    '';
  const bondedN = Number(stakingStore.pool?.bonded_tokens || 0);
  const notBondedN = Number(stakingStore.pool?.not_bonded_tokens || 0);
  const supplyN = Number(bankStore.supply?.amount || 0);
  const inflationN = Number(mintStore.inflation || 0);
  const communityTaxN = Number(distStore.params?.community_tax || 0);
  const bondedRatio = supplyN > 0 ? bondedN / supplyN : 0;
  // network APR estimate at 0% commission (same formula as validator page)
  const apr = bondedRatio > 0 ? ((1 - communityTaxN) * inflationN) / bondedRatio : 0;
  const bondedPct = Math.max(0, Math.min(100, bondedRatio * 100));

  return {
    denom,
    supply: supplyN
      ? format.formatTokenAmount({ amount: String(supplyN), denom })
      : '—',
    bonded: bondedN
      ? format.formatTokenAmount({ amount: String(bondedN), denom })
      : '—',
    notBonded: notBondedN
      ? format.formatTokenAmount({ amount: String(notBondedN), denom })
      : '—',
    bondedRatio: format.percent(bondedRatio),
    bondedPct,
    inflation: format.percent(inflationN),
    apr: format.percent(apr),
    communityTax: format.percent(communityTaxN),
    communityPool: format.formatTokens(
      // @ts-ignore
      (store.communityPool || []).filter((x: any) => x.denom === denom)
    ) || '—',
    unbonding: formatSeconds(stakingStore.params?.unbonding_time) || '—',
    maxValidators: stakingStore.params?.max_validators || '—',
  };
});


const quantity = ref(100);
const qty = computed({
  get: () => {
    return parseFloat(quantity.value.toFixed(6));
  },
  set: (val) => {
    quantity.value = val;
  },
});
const amount = computed({
  get: () => {
    return quantity.value * (ticker.value?.converted_last?.usd || 0) || 0;
  },
  set: (val) => {
    const p = ticker.value?.converted_last?.usd || 0;
    quantity.value = p ? val / p : 0;
  },
});
</script>

<template>
  <div class="space-y-4">
    <!-- ===== Chain hero ===== -->
    <section class="sz-chain-hero relative overflow-hidden rounded-2xl">
      <div class="relative z-10 p-5 sm:p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0 flex items-start gap-3.5">
            <div v-if="chainLogo" class="sz-hero-logo shrink-0">
              <img :src="chainLogo" :alt="chainTitle" width="48" height="48" />
            </div>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2.5">
                <h1 class="sz-hero-chain">{{ chainTitle }}</h1>
                <span v-if="chainSymbol" class="sz-chip sz-chip--info font-mono uppercase">{{ chainSymbol }}</span>
              </div>
              <div v-if="coinInfo?.market_cap_rank" class="mt-2">
                <span class="sz-chip font-mono">Rank #{{ coinInfo.market_cap_rank }}</span>
              </div>
              <div v-if="hasMarket" class="mt-2.5 flex flex-wrap items-baseline gap-2.5">
                <span class="sz-hero-price">${{ ticker?.converted_last?.usd }}</span>
                <span class="text-sm font-semibold font-mono" :class="store.priceColor">{{ store.priceChange }}%</span>
              </div>
              <div class="mt-3.5 flex flex-wrap items-center gap-1.5">
                <a
                  v-for="(item, index) of comLinks"
                  :key="index"
                  :href="item.href"
                  target="_blank"
                  rel="noopener"
                  class="sz-hero-link"
                >
                  <Icon :icon="item?.icon" />
                  <span>{{ item?.name }}</span>
                </a>
              </div>
            </div>
          </div>
          <div v-if="hasMarket" class="flex items-center gap-2">
            <label class="btn btn-sm btn-outline" for="calculator">
              <Icon icon="mdi-calculator" class="text-base" />
              <span class="hidden sm:inline">{{ $t('index.price_calculator') }}</span>
            </label>
            <a
              v-if="ticker?.trade_url"
              class="btn btn-sm btn-primary text-white"
              :class="{ '!btn-success': store.trustColor === 'green', '!btn-warning': store.trustColor === 'yellow' }"
              :href="tickerUrl(ticker.trade_url)"
              target="_blank"
            >
              {{ $t('index.buy') }} {{ chainSymbol || '' }}
            </a>
          </div>
        </div>
      </div>

      <!-- calculator modal -->
      <template v-if="hasMarket">
        <input type="checkbox" id="calculator" class="modal-toggle" />
        <div class="modal">
          <div class="modal-box">
            <h3 class="text-lg font-bold">{{ $t('index.price_calculator') }}</h3>
            <div class="flex flex-col w-full mt-5">
              <div class="grid h-20 flex-grow card rounded-box place-items-center">
                <div class="join w-full">
                  <label class="join-item btn"><span class="uppercase">{{ chainSymbol }}</span></label>
                  <input type="number" v-model="qty" min="0" placeholder="Input a number" class="input grow input-bordered join-item" />
                </div>
              </div>
              <div class="divider">=</div>
              <div class="grid h-20 flex-grow card rounded-box place-items-center">
                <div class="join w-full">
                  <label class="join-item btn"><span>USD</span></label>
                  <input type="number" v-model="amount" min="0" placeholder="Input amount" class="join-item grow input input-bordered" />
                </div>
              </div>
            </div>
          </div>
          <label class="modal-backdrop" for="calculator">{{ $t('index.close') }}</label>
        </div>
      </template>
    </section>

    <!-- ===== Tokenomics (nodes.guru-style) ===== -->
    <section class="sz-section">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Economics</div>
          <div class="sz-section-title">Tokenomics</div>
        </div>
        <div class="sz-chip font-mono">{{ tokenomics.bondedRatio }} bonded</div>
      </div>

      <div class="px-4 pt-4">
        <div class="mb-1.5 flex items-center justify-between gap-2 text-xs">
          <span class="text-secondary font-semibold uppercase tracking-wider">Bonded ratio</span>
          <span class="font-mono font-semibold text-main">{{ tokenomics.bondedRatio }}</span>
        </div>
        <div class="sz-tok-track" aria-hidden="true">
          <div class="sz-tok-fill" :style="{ width: tokenomics.bondedPct + '%' }"></div>
        </div>
        <div class="mt-1.5 flex justify-between text-[11px] text-secondary font-mono">
          <span>Bonded {{ tokenomics.bonded }}</span>
          <span>Not bonded {{ tokenomics.notBonded }}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Total supply</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.supply }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Bonded tokens</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.bonded }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Inflation</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.inflation }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Est. APR</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.apr }}</div>
          <div class="mt-0.5 text-[11px] text-secondary">0% commission</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Community pool</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.communityPool }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Community tax</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.communityTax }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Unbonding time</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.unbonding }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">Max validators</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">{{ tokenomics.maxValidators }}</div>
        </div>
      </div>
    </section>

    <!-- ===== Market (clean nodes.guru-style chart) ===== -->
    <section v-if="hasMarket" class="sz-section">
      <div class="sz-section-head">
        <div class="min-w-0">
          <div class="sz-section-kicker">Market</div>
          <div class="sz-section-title truncate uppercase tracking-wide">
            {{ chainSymbol || shortName(ticker?.base, ticker?.coin_id) }} price
          </div>
        </div>
        <div v-if="ticker?.market?.name" class="sz-chip truncate max-w-[12rem]">
          {{ ticker.market.name }}
        </div>
      </div>
      <div class="px-2 pb-2 pt-1 sm:px-3">
        <PriceMarketChart />
      </div>
      <div
        v-if="coinInfo.description?.en"
        class="max-h-[180px] overflow-auto border-t border-base-content/10 px-4 py-3 text-sm text-secondary"
      >
        <MdEditor :model-value="coinInfo.description?.en" previewOnly />
      </div>
    </section>

      <section
        v-if="githubCard.fullName || githubCard.loading"
        class="sz-section sz-github-activity"
      >
        <div class="sz-section-head">
          <div class="min-w-0">
            <div class="sz-section-kicker">Development</div>
            <div class="sz-section-title">GitHub Activity</div>
          </div>
          <a
            v-if="githubCard.htmlUrl"
            :href="githubCard.htmlUrl"
            target="_blank"
            rel="noopener"
            class="btn btn-sm btn-outline gap-1"
          >
            <Icon icon="mdi-github" class="text-base" />
            <span class="hidden sm:inline font-mono text-xs">{{ githubCard.fullName }}</span>
            <span class="sm:hidden">Repo</span>
          </a>
        </div>

        <div v-if="githubCard.loading" class="px-4 py-6 text-sm text-secondary">Loading repository activity…</div>
        <div v-else-if="githubCard.error && !githubCard.commits?.length" class="px-4 py-4 text-sm text-secondary">
          {{ githubCard.error }}
          <a v-if="githubCard.htmlUrl" :href="githubCard.htmlUrl" class="link link-primary ml-1" target="_blank" rel="noopener">Open on GitHub</a>
        </div>
        <template v-else>
          <!-- contribution heatmap (nodes.guru green boxes) -->
          <div v-if="heatmapCells.length" class="sz-gh-heatmap px-4 pt-3">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div class="text-xs text-secondary">
                <span class="font-mono font-semibold text-main">{{ githubCard.totalCommitsYear.toLocaleString() }}</span>
                commits in the last year
              </div>
              <div class="sz-gh-legend" aria-hidden="true">
                <span>Less</span>
                <span class="sz-gh-cell" data-level="0"></span>
                <span class="sz-gh-cell" data-level="1"></span>
                <span class="sz-gh-cell" data-level="2"></span>
                <span class="sz-gh-cell" data-level="3"></span>
                <span class="sz-gh-cell" data-level="4"></span>
                <span>More</span>
              </div>
            </div>
            <div class="sz-gh-heatmap-scroll">
              <div class="sz-gh-heatmap-grid" role="img" :aria-label="`${githubCard.totalCommitsYear} commits last year`">
                <span
                  v-for="cell in heatmapCells"
                  :key="cell.key"
                  class="sz-gh-cell"
                  :data-level="cell.level"
                  :title="cell.title"
                ></span>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-4">
            <div class="sz-gh-stat">
              <div class="sz-metric-label">Stars</div>
              <div class="sz-gh-stat-val">{{ githubCard.stars }}</div>
            </div>
            <div class="sz-gh-stat">
              <div class="sz-metric-label">Forks</div>
              <div class="sz-gh-stat-val">{{ githubCard.forks }}</div>
            </div>
            <div class="sz-gh-stat">
              <div class="sz-metric-label">Open issues</div>
              <div class="sz-gh-stat-val">{{ githubCard.openIssues }}</div>
            </div>
            <div class="sz-gh-stat">
              <div class="sz-metric-label">Language</div>
              <div class="sz-gh-stat-val truncate">{{ githubCard.language || '—' }}</div>
            </div>
          </div>
          <p v-if="githubCard.description" class="px-4 pt-3 text-sm text-secondary line-clamp-2">
            {{ githubCard.description }}
          </p>
          <div class="mt-3 border-t border-base-content/10">
            <div class="flex items-center justify-between px-4 py-2.5">
              <div class="text-xs font-semibold uppercase tracking-wider text-secondary">Recent commits</div>
              <div v-if="githubCard.pushedAt" class="font-mono text-[11px] text-secondary">
                pushed {{ formatGithubDate(githubCard.pushedAt) }}
              </div>
            </div>
            <ul class="divide-y divide-base-content/10">
              <li
                v-for="c in githubCard.commits"
                :key="c.sha"
                class="px-4 py-2.5 hover:bg-base-content/5 transition-colors"
              >
                <a
                  :href="c.htmlUrl || githubCard.htmlUrl"
                  target="_blank"
                  rel="noopener"
                  class="block no-underline"
                >
                  <div class="flex items-start gap-2">
                    <span class="mt-0.5 shrink-0 rounded bg-base-content/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">{{ c.sha }}</span>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm font-medium text-main">{{ c.message || '—' }}</div>
                      <div class="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-secondary">
                        <span>{{ c.author }}</span>
                        <span v-if="c.date" class="font-mono">{{ formatGithubDate(c.date) }}</span>
                      </div>
                    </div>
                  </div>
                </a>
              </li>
              <li v-if="!githubCard.commits?.length" class="px-4 py-4 text-sm text-secondary">No recent commits</li>
            </ul>
          </div>
        </template>
      </section>

    <!-- ===== Active proposals ===== -->
    <section v-if="blockchain.supportModule('governance')" class="sz-section">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Governance</div>
          <div class="sz-section-title">{{ $t('index.active_proposals') }}</div>
        </div>
      </div>
      <Loading v-if="isProposalsLoading" :bordered="false" />
      <template v-else>
        <div class="px-4 pb-4 pt-2">
          <ProposalListItem :proposals="store?.proposals" />
        </div>
        <div class="pb-8 text-center" v-if="store.proposals?.proposals?.length === 0">
          {{ $t('index.no_active_proposals') }}
        </div>
      </template>
    </section>

    <!-- ===== Wallet ===== -->
    <section class="sz-section">
      <div class="sz-section-head">
        <div class="min-w-0">
          <div class="sz-section-kicker">Wallet</div>
          <div class="sz-section-title truncate font-mono !text-sm">
            {{ walletStore.currentAddress || 'Not Connected' }}
          </div>
        </div>
        <RouterLink
          v-if="walletStore.currentAddress"
          class="shrink-0 text-sm font-medium link link-primary no-underline"
          :to="`/${chain}/account/${walletStore.currentAddress}`"
        >
          {{ $t('index.more') }}
        </RouterLink>
      </div>

      <div class="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-4">
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">{{ $t('account.balance') }}</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">
            {{ format.formatToken(walletStore.balanceOfStakingToken) }}
          </div>
          <div class="text-sm" :class="color">${{ format.tokenValue(walletStore.balanceOfStakingToken) }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">{{ $t('module.staking') }}</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">
            {{ format.formatToken(walletStore.stakingAmount) }}
          </div>
          <div class="text-sm" :class="color">${{ format.tokenValue(walletStore.stakingAmount) }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">{{ $t('index.reward') }}</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">
            {{ format.formatToken(walletStore.rewardAmount) }}
          </div>
          <div class="text-sm" :class="color">${{ format.tokenValue(walletStore.rewardAmount) }}</div>
        </div>
        <div class="sz-wallet-cell">
          <div class="sz-metric-label">{{ $t('index.unbonding') }}</div>
          <div class="mt-1 truncate font-mono text-lg font-semibold text-main">
            {{ format.formatToken(walletStore.unbondingAmount) }}
          </div>
          <div class="text-sm" :class="color">${{ format.tokenValue(walletStore.unbondingAmount) }}</div>
        </div>
      </div>

      <div v-if="walletStore.delegations.length > 0" class="overflow-auto px-4 pb-4">
        <table class="table table-compact w-full table-zebra">
          <thead>
            <tr>
              <th>{{ $t('account.validator') }}</th>
              <th>{{ $t('account.delegations') }}</th>
              <th>{{ $t('account.rewards') }}</th>
              <th>{{ $t('staking.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in walletStore.delegations" :key="index">
              <td>
                <RouterLink
                  class="link link-primary no-underline"
                  :to="`/${chain}/validator/${item?.delegation?.validator_address}`"
                >
                  {{ format.validatorFromBech32(item?.delegation?.validator_address) }}
                </RouterLink>
              </td>
              <td>{{ format.formatToken(item?.balance) }}</td>
              <td>
                {{
                  format.formatTokens(
                    walletStore?.rewards?.rewards?.find(
                      (el) => el?.validator_address === item?.delegation?.validator_address
                    )?.reward
                  )
                }}
              </td>
              <td>
                <div>
                  <label
                    for="delegate"
                    class="btn !btn-xs !btn-primary btn-ghost rounded-sm mr-2"
                    @click="dialog.open('delegate', { validator_address: item.delegation.validator_address }, updateState)"
                  >
                    {{ $t('account.btn_delegate') }}
                  </label>
                  <label
                    for="withdraw"
                    class="btn !btn-xs !btn-primary btn-ghost rounded-sm"
                    @click="dialog.open('withdraw', { validator_address: item.delegation.validator_address }, updateState)"
                  >
                    {{ $t('index.btn_withdraw_reward') }}
                  </label>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="grid grid-cols-3 gap-3 px-4 pb-5">
        <label for="PingTokenConvert" class="btn btn-primary text-white">{{ $t('index.btn_swap') }}</label>
        <label for="send" class="btn !bg-yes !border-yes text-white" @click="dialog.open('send', {}, updateState)">
          {{ $t('account.btn_send') }}
        </label>
        <label for="delegate" class="btn !bg-info !border-info text-white" @click="dialog.open('delegate', {}, updateState)">
          {{ $t('account.btn_delegate') }}
        </label>
        <RouterLink to="/wallet/receive" class="btn !bg-info !border-info text-white hidden">
          {{ $t('index.receive') }}
        </RouterLink>
      </div>
      <Teleport to="body">
        <ping-token-convert
          :chain-name="blockchain?.current?.prettyName"
          :endpoint="blockchain?.endpoint?.address"
          :hd-path="walletStore?.connectedWallet?.hdPath"
        ></ping-token-convert>
      </Teleport>
    </section>

  </div>
</template>

<style scoped>
.sz-chain-hero {
  background:
    radial-gradient(900px 220px at 85% -20%, color-mix(in srgb, hsl(var(--p)) 16%, transparent), transparent 60%),
    linear-gradient(135deg, color-mix(in srgb, hsl(var(--p)) 7%, hsl(var(--b1))), hsl(var(--b1)));
  border: 1px solid var(--sz-border);
}
.sz-hero-logo {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--sz-border);
  overflow: hidden;
}
.sz-hero-logo img {
  width: 38px;
  height: 38px;
  object-fit: contain;
}
.sz-hero-chain {
  font-size: 1.65rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--text-main);
  line-height: 1.1;
}
.sz-hero-price {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-main);
}
.sz-hero-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  border-radius: 999px;
  border: 1px solid var(--sz-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  transition: all 0.15s ease;
}
.sz-hero-link:hover {
  color: hsl(var(--p));
  border-color: color-mix(in srgb, hsl(var(--p)) 45%, var(--sz-border));
  background: color-mix(in srgb, hsl(var(--p)) 7%, transparent);
}
.sz-wallet-cell {
  background: color-mix(in srgb, hsl(var(--b2)) 65%, transparent);
  border: 1px solid var(--sz-border);
  border-radius: 12px;
  padding: 0.8rem 0.9rem;
}
.sz-gh-stat {
  background: color-mix(in srgb, hsl(var(--b2)) 65%, transparent);
  border: 1px solid var(--sz-border);
  border-radius: 12px;
  padding: 0.65rem 0.8rem;
}
.sz-gh-stat-val {
  margin-top: 0.2rem;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-main);
  letter-spacing: -0.02em;
}
/* heatmap */
.sz-gh-heatmap-scroll {
  overflow-x: auto;
  padding-bottom: 4px;
}
.sz-gh-heatmap-grid {
  display: grid;
  grid-template-rows: repeat(7, 11px);
  grid-auto-flow: column;
  grid-auto-columns: 11px;
  gap: 3px;
  width: max-content;
}
.sz-gh-legend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--text-secondary);
}

.sz-tok-track {
  height: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, hsl(var(--bc)) 10%, transparent);
  overflow: hidden;
  border: 1px solid var(--sz-border);
}
.sz-tok-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, hsl(var(--p)), color-mix(in srgb, hsl(var(--su)) 70%, hsl(var(--p))));
  transition: width 0.35s ease;
  min-width: 0;
}
</style>

<route>
  {
    meta: {
      i18n: 'dashboard',
      order: 1,
    }
  }
</route>
