<script lang="ts" setup>
import { useBaseStore, useBlockchain, useFormatter, useMintStore, useStakingStore, useTxDialog } from '@/stores';
import { computed } from '@vue/reactivity';
import { onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import type { Key, SlashingParam, Validator } from '@/types';
import { formatSeconds } from '@/libs/utils';
import { diff } from 'semver';

const staking = useStakingStore();
const base = useBaseStore();
const format = useFormatter();
const dialog = useTxDialog();
const chainStore = useBlockchain();
const mintStore = useMintStore();

const cache = JSON.parse(localStorage.getItem('avatars') || '{}');
const avatars = ref(cache || {});
const latest = ref({} as Record<string, number>);
const yesterday = ref({} as Record<string, number>);
const tab = ref('active');
const unbondList = ref([] as Validator[]);
const slashing = ref({} as SlashingParam);

onMounted(() => {
  staking.fetchUnbondingValdiators().then((res) => {
    unbondList.value = res.concat(unbondList.value);
  });
  staking.fetchInacitveValdiators().then((res) => {
    unbondList.value = unbondList.value.concat(res);
  });
  chainStore.rpc.getSlashingParams().then((res) => {
    slashing.value = res.params;
  });
});

async function fetchChange(blockWindow: number = 14400) {
  let page = 0;

  let height = Number(base.latest?.block?.header?.height || 0);
  if (height > blockWindow) {
    height -= blockWindow;
  } else {
    height = 1;
  }
  // voting power in 24h ago
  while (page < staking.validators.length && height > 0) {
    await base.fetchValidatorByHeight(height, page).then((x) => {
      x.validators.forEach((v) => {
        yesterday.value[v.pub_key.key] = Number(v.voting_power);
      });
    });
    page += 100;
  }

  page = 0;
  // voting power for now
  while (page < staking.validators.length) {
    await base.fetchLatestValidators(page).then((x) => {
      x.validators.forEach((v) => {
        latest.value[v.pub_key.key] = Number(v.voting_power);
      });
    });
    page += 100;
  }
}

const changes = computed(() => {
  const changes = {} as Record<string, number>;
  Object.keys(latest.value).forEach((k) => {
    const l = latest.value[k] || 0;
    const y = yesterday.value[k] || 0;
    changes[k] = l - y;
  });
  return changes;
});

const change24 = (entry: { consensus_pubkey: Key; tokens: string }) => {
  const txt = entry.consensus_pubkey.key;
  // const n: number = latest.value[txt];
  // const o: number = yesterday.value[txt];
  // // console.log( txt, n, o)
  // return n > 0 && o > 0 ? n - o : 0;

  const latestValue = latest.value[txt];
  if (!latestValue) {
    return 0;
  }

  const displayTokens = format.tokenAmountNumber({
    amount: parseInt(entry.tokens, 10).toString(),
    denom: staking.params.bond_denom,
  });
  const coefficient = displayTokens / latestValue;
  return changes.value[txt] * coefficient;
};

const change24Text = (entry: { consensus_pubkey: Key; tokens: string }) => {
  if (!entry) return '';
  const v = change24(entry);
  return v && v !== 0 ? format.showChanges(v) : '';
};

const change24Color = (entry: { consensus_pubkey: Key; tokens: string }) => {
  if (!entry) return '';
  const v = change24(entry);
  if (v > 0) return 'text-success';
  if (v < 0) return 'text-error';
};

const calculateRank = function (position: number) {
  let sum = 0;
  for (let i = 0; i < position; i++) {
    sum += Number(staking.validators[i]?.delegator_shares);
  }
  const percent = sum / staking.totalPower;

  switch (true) {
    case tab.value === 'active' && percent < 0.33:
      return 'error';
    case tab.value === 'active' && percent < 0.67:
      return 'warning';
    default:
      return 'primary';
  }
};

const list = computed(() => {
  if (tab.value === 'active') {
    return staking.validators.map((x, i) => ({ v: x, rank: calculateRank(i), logo: logo(x.description.identity) }));
  }
  return unbondList.value.map((x, i) => ({ v: x, rank: 'primary', logo: logo(x.description.identity) }));
});

const fetchAvatar = (identity: string) => {
  // fetch avatar from keybase
  return new Promise<void>((resolve) => {
    staking
      .keybase(identity)
      .then((d) => {
        if (Array.isArray(d.them) && d.them.length > 0) {
          const uri = String(d.them[0]?.pictures?.primary?.url).replace(
            'https://s3.amazonaws.com/keybase_processed_uploads/',
            ''
          );

          avatars.value[identity] = uri;
          resolve();
        } else throw new Error(`failed to fetch avatar for ${identity}`);
      })
      .catch((error) => {
        // console.error(error); // uncomment this if you want the user to see which avatars failed to load.
        resolve();
      });
  });
};

const loadAvatar = (identity: string) => {
  // fetches avatar from keybase and stores it in localStorage
  fetchAvatar(identity).then(() => {
    localStorage.setItem('avatars', JSON.stringify(avatars.value));
  });
};

const loadAvatars = () => {
  // fetches all avatars from keybase and stores it in localStorage
  const promises = staking.validators.map((validator) => {
    const identity = validator.description?.identity;

    // Here we also check whether we haven't already fetched the avatar
    if (identity && !avatars.value[identity]) {
      return fetchAvatar(identity);
    } else {
      return Promise.resolve();
    }
  });

  Promise.all(promises).then(() => localStorage.setItem('avatars', JSON.stringify(avatars.value)));
};

const logo = (identity?: string) => {
  if (!identity || !avatars.value[identity]) return '';
  const url = avatars.value[identity] || '';
  return url.startsWith('http') ? url : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
};

const loaded = ref(false);
base.$subscribe((_, s) => {
  if (s.recents.length >= 2 && loaded.value === false) {
    loaded.value = true;
    const diff_time = Date.parse(s.recents[1].block.header.time) - Date.parse(s.recents[0].block.header.time);
    const diff_height = Number(s.recents[1].block.header.height) - Number(s.recents[0].block.header.height);
    const block_window = Number(Number((86400 * 1000 * diff_height) / diff_time).toFixed(0));
    fetchChange(block_window);
  }
});

loadAvatars();
</script>
<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Proof of Stake</div>
        <h1 class="sz-page-title">{{ $t('module.validator') }}</h1>
        <div class="sz-page-sub">
          <span class="font-mono">{{ list.length }}</span> / {{ staking.params.max_validators }}
          {{ $t('staking.validator').toLowerCase() }}
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'active' }" @click="tab = 'active'">
          {{ $t('staking.active') }}
        </a>
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'inactive' }" @click="tab = 'inactive'">
          {{ $t('staking.inactive') }}
        </a>
      </div>
    </div>

    <!-- network staking vitals -->
    <div class="grid grid-cols-2 gap-3 xl:!grid-cols-4">
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">{{ $t('staking.inflation') }}</div>
            <div class="sz-metric-value truncate">{{ format.percent(mintStore.inflation) }}</div>
          </div>
          <span class="sz-metric-icon sz-metric-icon--success"><Icon icon="mdi:trending-up" /></span>
        </div>
      </div>
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">{{ $t('staking.unbonding_time') }}</div>
            <div class="sz-metric-value truncate">{{ formatSeconds(staking.params?.unbonding_time) }}</div>
          </div>
          <span class="sz-metric-icon"><Icon icon="mdi:lock-open-outline" /></span>
        </div>
      </div>
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">{{ $t('staking.double_sign_slashing') }}</div>
            <div class="sz-metric-value truncate">{{ format.percent(slashing.slash_fraction_double_sign) }}</div>
          </div>
          <span class="sz-metric-icon sz-metric-icon--error"><Icon icon="mdi:alert-octagon-outline" /></span>
        </div>
      </div>
      <div class="sz-metric">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="sz-metric-label">{{ $t('staking.downtime_slashing') }}</div>
            <div class="sz-metric-value truncate">{{ format.percent(slashing.slash_fraction_downtime) }}</div>
          </div>
          <span class="sz-metric-icon sz-metric-icon--warning"><Icon icon="mdi:pause" /></span>
        </div>
      </div>
    </div>

    <!-- validator set -->
    <div class="sz-section mt-4 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th style="width: 3.5rem">{{ $t('staking.rank') }}</th>
              <th>{{ $t('staking.validator') }}</th>
              <th class="text-right">{{ $t('staking.voting_power') }}</th>
              <th class="text-right">{{ $t('staking.24h_changes') }}</th>
              <th class="text-right">{{ $t('staking.commission') }}</th>
              <th class="text-center">{{ $t('staking.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="({ v, rank, logo }, i) in list" :key="v.operator_address">
              <!-- rank -->
              <td>
                <span
                  class="sz-chip font-mono !text-[11px]"
                  :class="{
                    'sz-chip--bad': rank === 'error',
                    'sz-chip--warn': rank === 'warning',
                    'sz-chip--info': rank === 'primary',
                  }"
                >
                  {{ i + 1 }}
                </span>
              </td>
              <!-- validator -->
              <td>
                <div class="flex items-center gap-3 overflow-hidden" style="max-width: 320px">
                  <div class="relative h-9 w-9 shrink-0 overflow-hidden rounded-full bg-base-200 ring-1 ring-base-content/10">
                    <img v-if="logo" :src="logo" class="h-full w-full object-contain"
                      @error="() => { const identity = v.description?.identity; if (identity) loadAvatar(identity); }"
                    />
                    <div v-else class="flex h-full w-full items-center justify-center text-base-content/40">
                      <Icon icon="mdi:help-circle-outline" class="text-xl" />
                    </div>
                  </div>
                  <div class="min-w-0">
                    <RouterLink
                      :to="{ name: 'chain-staking-validator', params: { validator: v.operator_address } }"
                      class="block truncate text-[13.5px] font-semibold text-primary no-underline hover:underline"
                    >
                      {{ v.description?.moniker }}
                    </RouterLink>
                    <span class="block truncate text-[11px] text-secondary">
                      {{ v.description?.website || v.description?.identity || '-' }}
                    </span>
                  </div>
                </div>
              </td>
              <!-- voting power -->
              <td class="text-right">
                <div class="font-mono text-[13px] font-semibold whitespace-nowrap">
                  {{ format.formatToken({ amount: parseInt(v.tokens).toString(), denom: staking.params.bond_denom }, true, '0,0') }}
                </div>
                <div class="mt-1 flex items-center justify-end gap-1.5">
                  <div class="h-1 w-16 overflow-hidden rounded-full bg-base-content/10">
                    <div
                      class="h-full rounded-full"
                      :class="rank === 'error' ? 'bg-error' : rank === 'warning' ? 'bg-warning' : 'bg-primary'"
                      :style="{ width: (staking.totalPower ? Math.min(100, (Number(v.delegator_shares) / staking.totalPower) * 100) : 0) + '%' }"
                    ></div>
                  </div>
                  <span class="text-[10.5px] text-secondary">{{ format.calculatePercent(v.delegator_shares, staking.totalPower) }}</span>
                </div>
              </td>
              <!-- 24h change -->
              <td class="text-right font-mono text-[12px]" :class="change24Color(v)">
                {{ change24Text(v) || '—' }}
              </td>
              <!-- commission -->
              <td class="text-right font-mono text-[12px]">
                {{ format.formatCommissionRate(v.commission?.commission_rates?.rate) }}
              </td>
              <!-- action -->
              <td class="text-center">
                <span v-if="v.jailed" class="sz-chip sz-chip--bad">{{ $t('staking.jailed') }}</span>
                <label
                  v-else
                  for="delegate"
                  class="btn btn-xs btn-primary rounded-md capitalize"
                  @click="dialog.open('delegate', { validator_address: v.operator_address })"
                >
                  {{ $t('account.btn_delegate') }}
                </label>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-base-content/10 px-4 py-3">
        <span class="sz-chip sz-chip--bad">{{ $t('staking.top') }} 33%</span>
        <span class="sz-chip sz-chip--warn">{{ $t('staking.top') }} 67%</span>
        <span class="hidden text-[11.5px] text-secondary md:!inline">{{ $t('staking.description') }}</span>
      </div>
    </div>
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'validator',
      order: 3
    }
  }
</route>
