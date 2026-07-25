<script lang="ts" setup>
import { ref, onMounted, computed, onUnmounted } from 'vue';
import { fromHex, toBase64, fromBase64, toHex } from '@cosmjs/encoding';
import { useStakingStore, useBaseStore, useBlockchain, useFormatter } from '@/stores';
import UptimeBar from '@/components/UptimeBar.vue';
import type { SlashingParam, SigningInfo, Block } from '@/types';
import { consensusPubkeyToHexAddress, valconsToBase64 } from '@/libs';

const props = defineProps(['chain']);

const stakingStore = useStakingStore();
const format = useFormatter();
const baseStore = useBaseStore();
const chainStore = useBlockchain();
const latest = ref(0);
const keyword = ref('');
const live = ref(true);
const slashingParam = ref({} as SlashingParam);
const signingInfo = ref({} as Record<string, SigningInfo>);
const consumerValidators = ref([] as { moniker: string; base64: string }[]);

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
  uptime: number;
  signing: SigningInfo;
}

function padding(blocks: BlockColor[] = []) {
  const raw = Array(50)
    .fill({ height: '0', color: 'bg-secondary' } as BlockColor)
    .concat(blocks);
  return raw.slice(raw.length - 50);
}

const validatorSet = computed(() => {
  if (chainStore.isConsumerChain) {
    return consumerValidators.value.map((v) => {
      const b64 = valconsToBase64(v.moniker);
      const moniker = stakingStore.validators.find(
        (x) => toBase64(fromHex(consensusPubkeyToHexAddress(x.consensus_pubkey))) === b64
      )?.description.moniker;
      return {
        moniker: moniker || v.moniker,
        base64: v.base64,
      };
    });
  }
  return stakingStore.validators.map((v) => {
    const hex = consensusPubkeyToHexAddress(v.consensus_pubkey);
    return {
      moniker: v.description.moniker,
      base64: toBase64(fromHex(hex)),
    };
  });
});

const blockColors = ref({} as Record<string, BlockColor[]>);

const grid = computed(() => {
  const validators =
    keyword.value.length === 0
      ? validatorSet.value
      : validatorSet.value.filter((v) => v.moniker.toLowerCase().includes(keyword.value.toLowerCase()));

  const window = Number(slashingParam.value.signed_blocks_window || 0);
  return validators.map((v) => {
    const signing = signingInfo.value[v.base64];
    const uptime = signing && window > 0 ? (window - Number(signing.missed_blocks_counter)) / window : undefined;
    return {
      moniker: v.moniker,
      base64: v.base64,
      blocks: padding(blockColors.value[v.base64] || []),
      uptime,
      missed_blocks_counter: signing?.missed_blocks_counter,
      signing,
    } as ValidatorUnit;
  });
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

    if (Number(state.latest.block.header.height) % 7 === 0) updateTotalSigningInfo();
    fillblock(state.latest);
  }
});

onMounted(() => {
  live.value = true;

  // fill the recent blocks
  baseStore.recents?.forEach((b) => {
    fillblock(b, 'start');
  });

  updateTotalSigningInfo();

  chainStore.rpc.getSlashingParams().then((x) => {
    slashingParam.value = x.params;
  });
});

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
  validatorSet.value.forEach((v) => {
    const sig = b.block.last_commit?.signatures.find((s) => s.validator_address === v.base64);
    const block = blockColors.value[v.base64] || [];
    let color = {
      height: b.block.header.height,
      color: 'bg-red-500',
    };
    if (sig) {
      color = {
        height: b.block.header.height,
        color: sig.block_id_flag === 'BLOCK_ID_FLAG_COMMIT' ? 'bg-green-500' : 'bg-yellow-500',
      };
    }
    if (direction === 'end') {
      block.push(color);
    } else {
      block.unshift(color);
    }
    if (block.length > 50) block.shift();
    blockColors.value[v.base64] = block;
  });
}

function updateTotalSigningInfo() {
  chainStore.rpc.getSlashingSigningInfos().then((x) => {
    x.info?.forEach((i) => {
      signingInfo.value[valconsToBase64(i.address)] = i;
    });
  });
}

onUnmounted(() => {
  live.value = false;
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
          <span>
            Live · window
            <span class="font-mono">{{ slashingParam.signed_blocks_window || '—' }}</span>
            · min
            <span class="font-mono">{{ format.percent(slashingParam.min_signed_per_window) }}</span>
          </span>
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

    <div class="sz-section p-4 sm:p-5">
      <div class="flex items-center gap-3 mb-4">
        <input
          type="text"
          v-model="keyword"
          placeholder="Filter validators…"
          class="input input-sm w-full flex-1 border border-base-content/10 bg-base-100 focus:border-primary"
        />
        <span class="hidden sm:inline sz-chip font-mono">{{ grid.length }}</span>
      </div>

      <!-- block heatmap -->
      <div :class="tab === '2' ? '' : 'hidden'">
        <div class="flex flex-row flex-wrap gap-x-4 gap-y-3 justify-center">
          <div v-for="(unit, i) in grid" :key="i" class="sz-uptime-unit">
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

      <!-- overall table -->
      <div :class="tab === '3' ? '' : 'hidden'" class="overflow-x-auto -mx-4 sm:-mx-5">
        <table class="sz-table">
          <thead>
            <tr>
              <th>{{ $t('account.validator') }}</th>
              <th class="text-right">{{ $t('module.uptime') }}</th>
              <th>{{ $t('uptime.last_jailed_time') }}</th>
              <th class="text-right">{{ $t('uptime.signed_precommits') }}</th>
              <th class="text-right">{{ $t('uptime.start_height') }}</th>
              <th>{{ $t('uptime.tombstoned') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(v, i) in grid" :key="v.base64 || i">
              <td>
                <div class="truncate max-w-sm">
                  <span class="text-secondary font-mono mr-1.5 text-[11px]">{{ i + 1 }}.</span>
                  {{ v.moniker }}
                </div>
              </td>
              <td class="text-right">
                <span
                  class="sz-chip font-mono"
                  :class="v.uptime && v.uptime > 0.95 ? 'sz-chip--ok' : 'sz-chip--bad'"
                >
                  <span class="tooltip" :data-tip="`${v.missed_blocks_counter} missing blocks`">
                    {{ format.percent(v.uptime) }}
                  </span>
                </span>
              </td>
              <td>
                <span v-if="v.signing && !v.signing.jailed_until.startsWith('1970')">
                  <div class="tooltip" :data-tip="format.toDay(v.signing.jailed_until, 'long')">
                    <span class="text-xs">{{ format.toDay(v.signing.jailed_until, 'from') }}</span>
                  </div>
                </span>
                <span v-else class="text-secondary">—</span>
              </td>
              <td class="text-right font-mono text-xs">
                <span v-if="v.signing && v.signing.jailed_until.startsWith('1970')">
                  {{ format.percent(Number(v.signing.index_offset) / (latest - Number(v.signing.start_height))) }}
                </span>
                {{ v.signing?.index_offset }}
              </td>
              <td class="text-right font-mono text-xs">{{ v.signing?.start_height || '—' }}</td>
              <td class="capitalize text-xs">{{ v.signing?.tombstoned ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="flex flex-wrap items-center gap-2 border-t border-base-content/10 px-4 py-3">
          <span class="text-[11.5px] text-secondary">{{ $t('uptime.minimum_uptime') }}:</span>
          <span class="sz-chip sz-chip--bad font-mono tooltip" :data-tip="`Window size: ${slashingParam.signed_blocks_window}`">
            {{ format.percent(slashingParam.min_signed_per_window) }}
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
