<script lang="ts" setup>
import MdEditor from 'md-editor-v3';
import PriceMarketChart from '@/components/charts/PriceMarketChart.vue';

import { Icon } from '@iconify/vue';
import { useBlockchain, useFormatter, useTxDialog, useWalletStore, useStakingStore, useParamStore, useGovStore } from '@/stores';
import { LoadingStatus } from '@/stores/useDashboard';
import { onMounted, ref } from 'vue';
import { useIndexModule, colorMap, tickerUrl } from './indexStore';
import { computed } from '@vue/reactivity';

import CardStatisticsVertical from '@/components/CardStatisticsVertical.vue';
import ProposalListItem from '@/components/ProposalListItem.vue';
import ArrayObjectElement from '@/components/dynamic/ArrayObjectElement.vue';
import Loading from '@/components/Loading.vue';

const props = defineProps(['chain']);

const blockchain = useBlockchain();
const store = useIndexModule();
const walletStore = useWalletStore();
const format = useFormatter();
const dialog = useTxDialog();
const stakingStore = useStakingStore();
const paramStore = useParamStore();
const govStore = useGovStore();
const coinInfo = computed(() => {
  return store.coinInfo;
});
const isAppVersionLoading = computed(
  () => !Array.isArray(paramStore.appVersion?.items) || paramStore.appVersion.items.length === 0
);
const isNodeVersionLoading = computed(
  () => !Array.isArray(paramStore.nodeVersion?.items) || paramStore.nodeVersion.items.length === 0
);
const isProposalsLoading = computed(() => govStore.loading['2'] !== LoadingStatus.Loaded);

onMounted(() => {
  store.loadDashboard();
  walletStore.loadMyAsset();
  paramStore.handleAbciInfo();
});
const ticker = computed(() => store.coinInfo.tickers[store.tickerIndex]);

const currName = ref('');
blockchain.$subscribe((m, s) => {
  if (s.chainName !== currName.value) {
    currName.value = s.chainName;
    store.loadDashboard();
    walletStore.loadMyAsset();
    paramStore.handleAbciInfo();
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
  ];
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
    return quantity.value * ticker.value.converted_last.usd || 0;
  },
  set: (val) => {
    quantity.value = val / ticker.value.converted_last.usd || 0;
  },
});
</script>

<template>
  <div class="space-y-4">
    <!-- ===== Chain hero ===== -->
    <section v-if="coinInfo && coinInfo.name" class="sz-chain-hero relative overflow-hidden rounded-2xl">
      <div class="relative z-10 p-5 sm:p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2.5">
              <h1 class="sz-hero-chain">{{ coinInfo.name }}</h1>
              <span class="sz-chip sz-chip--info font-mono uppercase">{{ coinInfo.symbol }}</span>
              <span class="sz-chip font-mono">Rank #{{ coinInfo.market_cap_rank }}</span>
            </div>
            <div class="mt-2.5 flex flex-wrap items-baseline gap-2.5">
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
          <div class="flex items-center gap-2">
            <label class="btn btn-sm btn-outline" for="calculator">
              <Icon icon="mdi-calculator" class="text-base" />
              <span class="hidden sm:inline">{{ $t('index.price_calculator') }}</span>
            </label>
            <a
              class="btn btn-sm btn-primary text-white"
              :class="{ '!btn-success': store.trustColor === 'green', '!btn-warning': store.trustColor === 'yellow' }"
              :href="tickerUrl(ticker.trade_url)"
              target="_blank"
            >
              {{ $t('index.buy') }} {{ coinInfo.symbol || '' }}
            </a>
          </div>
        </div>
      </div>

      <!-- calculator modal -->
      <input type="checkbox" id="calculator" class="modal-toggle" />
      <div class="modal">
        <div class="modal-box">
          <h3 class="text-lg font-bold">{{ $t('index.price_calculator') }}</h3>
          <div class="flex flex-col w-full mt-5">
            <div class="grid h-20 flex-grow card rounded-box place-items-center">
              <div class="join w-full">
                <label class="join-item btn"><span class="uppercase">{{ coinInfo.symbol }}</span></label>
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
    </section>

    <!-- ===== Network vitals ===== -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <CardStatisticsVertical v-for="(item, key) in store.stats" :key="key" v-bind="item" />
    </div>

    <!-- ===== Market ===== -->
    <section v-if="coinInfo && coinInfo.name" class="sz-section">
      <div class="sz-section-head">
        <div class="min-w-0">
          <div class="sz-section-kicker">Market</div>
          <div class="sz-section-title truncate">
            {{ ticker?.market?.name || '' }} ·
            {{ shortName(ticker?.base, ticker?.coin_id) }}/{{ shortName(ticker?.target, ticker?.target_coin_id) }}
          </div>
        </div>
      </div>
      <div class="p-4">
        <PriceMarketChart />
      </div>
      <div v-if="coinInfo.description?.en" class="max-h-[220px] overflow-auto border-t border-base-content/10 px-4 py-3 text-sm">
        <MdEditor :model-value="coinInfo.description?.en" previewOnly />
      </div>
      <div v-if="coinInfo.categories?.length" class="flex flex-wrap gap-2 border-t border-base-content/10 px-4 py-3">
        <span v-for="tag in coinInfo.categories" :key="tag" class="sz-chip">{{ tag }}</span>
      </div>
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

    <!-- ===== Node ===== -->
    <section class="sz-section">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Node</div>
          <div class="sz-section-title">{{ $t('index.app_versions') }}</div>
        </div>
      </div>
      <Loading v-if="isAppVersionLoading" :bordered="false" />
      <ArrayObjectElement v-else :value="paramStore.appVersion?.items" :thead="false" />
      <div class="h-3"></div>
    </section>

    <section v-if="!store.coingeckoId" class="sz-section">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Node</div>
          <div class="sz-section-title">{{ $t('index.node_info') }}</div>
        </div>
      </div>
      <Loading v-if="isNodeVersionLoading" :bordered="false" />
      <ArrayObjectElement v-else :value="paramStore.nodeVersion?.items" :thead="false" />
      <div class="h-3"></div>
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
</style>

<route>
  {
    meta: {
      i18n: 'dashboard',
      order: 1,
    }
  }
</route>
