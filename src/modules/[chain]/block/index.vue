<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { getLocalJson } from '@/libs/utils';
import { fromBase64, toHex } from '@cosmjs/encoding';
import { useBaseStore, useFormatter, useStakingStore } from '@/stores';
import { consensusPubkeyToHexAddress } from '@/libs';
import { gnoMoniker, lookupGnoValoper } from '@/libs/gno/valopers';
import TxsInBlocksChart from '@/components/charts/TxsInBlocksChart.vue';
import { Icon } from '@iconify/vue';

const props = defineProps(['chain']);

const tab = ref('blocks');

const base = useBaseStore();
const format = useFormatter();
const staking = useStakingStore();

// ---- avatars (keybase, cached in localStorage) — same pattern as consensus / validators ----
const avatars = ref<Record<string, string>>(getLocalJson('avatars', {}));

function logo(identity?: string) {
  if (!identity || !avatars.value[identity]) return '';
  const url = avatars.value[identity] || '';
  return url.startsWith('http') ? url : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
}

function fetchAvatar(identity: string) {
  return new Promise<void>((resolve) => {
    staking
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

// Template can't touch the `localStorage` global (Vue resolves it as
// _ctx.localStorage → undefined → throws on img @error). Persist via a method.
function persistAvatars() {
  localStorage.setItem('avatars', JSON.stringify(avatars.value));
}

function loadAvatars(identities: string[]) {
  const ids = identities.filter((id) => id && !avatars.value[id]);
  if (!ids.length) return;
  Promise.all(ids.map((id) => fetchAvatar(id))).then(() => persistAvatars());
}

/** Resolve block proposer_address → validator moniker + identity + logo + route.
 *  Cosmos: proposer is base64 of 20-byte cons address.
 *  Gnoland/TM2: proposer is already bech32 `g1…` (matches signing / operator). */
function resolveProposer(proposerAddress?: string) {
  if (!proposerAddress) return { moniker: '', identity: '', logo: '', signing: '', to: '' };
  // TM2 / Gno: bech32 proposer — match operator_address or valoper registry.
  // Fall back to static valoper registry so moniker works even before
  // staking store finishes loading.
  if (proposerAddress.startsWith('g1') || (!/[=+/]/.test(proposerAddress) && proposerAddress.length >= 20 && !/^[0-9A-F]{40}$/i.test(proposerAddress) && proposerAddress.includes('1'))) {
    const val = staking.validators.find((x) => x.operator_address === proposerAddress);
    const reg = lookupGnoValoper(proposerAddress);
    const moniker =
      val?.description?.moniker ||
      reg?.moniker ||
      gnoMoniker(proposerAddress);
    const identity = val?.description?.identity || '';
    // Validator detail route key = Tendermint2 signing address
    const signing = reg?.signingAddress || (val ? proposerAddress : '') || proposerAddress;
    const to = signing ? `/${props.chain}/validator/${signing}` : '';
    return {
      moniker: moniker || proposerAddress,
      identity,
      logo: logo(identity),
      signing,
      to,
    };
  }
  try {
    const hex = toHex(fromBase64(proposerAddress)).toUpperCase();
    const val = staking.validators.find(
      (x) => consensusPubkeyToHexAddress(x.consensus_pubkey) === hex
    );
    const identity = val?.description?.identity || '';
    const moniker = val?.description?.moniker || format.validator(proposerAddress) || proposerAddress;
    const to = val?.operator_address ? `/${props.chain}/validator/${val.operator_address}` : '';
    return { moniker, identity, logo: logo(identity), signing: val?.operator_address || '', to };
  } catch {
    // also try hex direct / operator match fallback
    const val = staking.validators.find(
      (x) =>
        x.operator_address === proposerAddress ||
        consensusPubkeyToHexAddress(x.consensus_pubkey) === proposerAddress.toUpperCase()
    );
    if (val) {
      const identity = val.description?.identity || '';
      return {
        moniker: val.description?.moniker || proposerAddress,
        identity,
        logo: logo(identity),
        signing: val.operator_address,
        to: `/${props.chain}/validator/${val.operator_address}`,
      };
    }
    return {
      moniker: format.validator(proposerAddress) || proposerAddress,
      identity: '',
      logo: '',
      signing: '',
      to: '',
    };
  }
}

const list = computed(() => {
  return (base.recents || []).map((item) => {
    const proposer = resolveProposer(item.block?.header?.proposer_address);
    return { item, proposer };
  });
});

// Prefetch avatars for proposers currently in view
watch(
  () => list.value.map((x) => x.proposer.identity).filter(Boolean),
  (ids) => loadAvatars([...new Set(ids)]),
  { immediate: true }
);

// Also prefetch when staking validators load (identity map becomes available)
watch(
  () => staking.validators.length,
  () => {
    const ids = list.value.map((x) => x.proposer.identity).filter(Boolean);
    loadAvatars([...new Set(ids)]);
  }
);
</script>
<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Chain</div>
        <h1 class="sz-page-title">{{ $t('module.blocks') }}</h1>
        <div class="sz-page-sub flex items-center gap-2">
          <span class="sz-live-dot"></span>
          <span>{{ $t('block.recent') }} · #{{ Number(base.latest?.block?.header?.height || 0).toLocaleString() }}</span>
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'blocks' }" @click="tab = 'blocks'">
          {{ $t('block.recent') }}
        </a>
        <RouterLink class="sz-tab" :to="`/${chain}/block/${Number(base.latest?.block?.header.height || 0) + 10000}`">
          {{ $t('block.future') }}
        </RouterLink>
      </div>
    </div>

    <div v-show="tab === 'blocks'">
      <TxsInBlocksChart />

      <div class="grid grid-cols-1 gap-3 md:!grid-cols-4 xl:!grid-cols-6 mt-4">
        <RouterLink
          v-for="{ item, proposer } in list"
          :key="item.block.header.height"
          class="sz-block-card"
          :to="`/${chain}/block/${item.block.header.height}`"
        >
          <div class="flex items-start justify-between gap-2">
            <span class="sz-block-height">#{{ item.block.header.height }}</span>
            <span class="sz-chip sz-chip--ok font-mono !text-[10px]">
              {{ item.block?.data?.txs.length }} tx
            </span>
          </div>
          <div class="flex min-w-0 items-center gap-2">
            <div
              class="relative h-7 w-7 shrink-0 overflow-hidden rounded-full bg-base-200 ring-1 ring-base-content/10"
              :title="proposer.moniker"
            >
              <img
                v-if="proposer.logo"
                :src="proposer.logo"
                class="h-full w-full object-cover"
                alt=""
                @error="() => { if (proposer.identity) fetchAvatar(proposer.identity).then(persistAvatars); }"
              />
              <div
                v-else
                class="flex h-full w-full items-center justify-center text-[11px] font-bold uppercase text-base-content/50"
              >
                {{ (proposer.moniker || '?').slice(0, 1) }}
              </div>
            </div>
            <div class="min-w-0 flex-1">
              <!-- Nested RouterLink is invalid HTML; use span + @click.stop for val deep-link -->
              <div
                class="truncate text-[11.5px] font-medium text-base-content"
                :class="proposer.to ? 'hover:text-primary cursor-pointer' : ''"
                :title="proposer.moniker"
                @click.stop="proposer.to && $router.push(proposer.to)"
              >
                {{ proposer.moniker || '—' }}
              </div>
              <div class="mt-0.5 text-[11px] font-medium text-green-600">
                {{ format.toDay(item.block?.header?.time, 'from') }}
              </div>
            </div>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<route>
    {
      meta: {
        i18n: 'blocks',
        order: 5
      }
    }
  </route>
