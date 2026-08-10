<script lang="ts" setup>
import { onMounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import TxsElement from '@/components/dynamic/TxsElement.vue';
import DynamicComponent from '@/components/dynamic/DynamicComponent.vue';
import Loading from '@/components/Loading.vue';
import { computed } from '@vue/reactivity';
import { onBeforeRouteUpdate } from 'vue-router';
import { useBaseStore, useFormatter } from '@/stores';
import type { Block } from '@/types';
import Countdown from '@/components/Countdown.vue';

const props = defineProps(['height', 'chain']);

const store = useBaseStore();
const format = useFormatter();
const current = ref({} as Block);
const target = ref(Number(props.height || 0));
const loading = ref(true);
let loadSequence = 0;

const height = computed(() => {
  return Number(current.value.block?.header?.height || props.height || 0);
});

const isFutureBlock = computed(() => {
  const latest = store.latest?.block?.header.height;
  if (!latest) return false;
  return target.value > Number(latest);
});

const remainingBlocks = computed(() => {
  const latest = store.latest?.block?.header.height;
  return latest ? Number(target.value) - Number(latest) : 0;
});

const estimateTime = computed(() => {
  const seconds = Number((remainingBlocks.value * store.blocktime).toFixed(2));
  return seconds;
});

const estimateDate = computed(() => {
  return new Date(new Date().getTime() + estimateTime.value);
});

const edit = ref(false);
const newHeight = ref(props.height);
function updateTarget() {
  target.value = Number(newHeight.value);
  loadBlock(target.value);
}

async function loadBlock(h: number | string) {
  const sequence = ++loadSequence;
  loading.value = true;
  try {
    // Wait for base store / chain rpc readiness (Gno cold nav race)
    if (!store.latest?.block?.header?.height) {
      for (let i = 0; i < 20; i++) {
        try {
          await store.fetchLatest();
        } catch {
          /* retry */
        }
        if (store.latest?.block?.header?.height) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    const latest = store.latest?.block?.header?.height;
    if (latest && Number(h) <= Number(latest)) {
      // light retry — first tick after endpoint swap can miss
      let lastErr: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const fetched = await store.fetchBlock(h);
          if (sequence !== loadSequence) return;
          current.value = fetched;
          if (current.value?.block?.header?.height) {
            lastErr = null;
            break;
          }
        } catch (e: any) {
          lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
      if (lastErr && !current.value?.block?.header?.height) {
        console.warn('[block] fetch failed:', lastErr?.message || lastErr);
        current.value = {} as Block;
      }
    } else {
      current.value = {} as Block;
    }
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

onMounted(() => {
  loadBlock(target.value);
});

// SPA navigation: reload when height changes (e.g., search → block A → block B)
watch(
  () => props.height,
  (newHeight: string, oldHeight: string) => {
    if (newHeight && newHeight !== oldHeight) {
      target.value = Number(newHeight);
      loadBlock(target.value);
    }
  }
);

// Re-fetch when latest lands late (cold race) for current target
watch(
  () => store.latest?.block?.header?.height,
  (h, prev) => {
    if (h && !prev && target.value && !current.value?.block?.header?.height && !loading.value) {
      loadBlock(target.value);
    }
  }
);

onBeforeRouteUpdate(async (to, from, next) => {
  if (from.path !== to.path) {
    target.value = Number(to.params.height);
    current.value = {} as Block;
    loadBlock(target.value);
  }
  next();
});
</script>
<template>
  <div>
    <Loading v-if="loading" />
    <div v-else-if="isFutureBlock" class="text-center">
      <div v-if="remainingBlocks > 0">
        <div class="text-primary font-bold text-lg my-10">#{{ target }}</div>
        <Countdown :time="estimateTime" css="md:!text-5xl font-sans md:mx-5" />
        <div class="my-5">
          {{ $t('block.estimated_time') }}:
          <span class="text-xl font-bold">{{ format.toLocaleDate(estimateDate) }}</span>
        </div>
        <div class="pt-10 flex justify-center">
          <table class="table w-max rounded-lg bg-base-100">
            <tbody>
              <tr class="hover cursor-pointer" @click="edit = !edit">
                <td>{{ $t('block.countdown_for_block') }}:</td>
                <td class="text-right">
                  <span class="md:!ml-40">{{ target }}</span>
                </td>
              </tr>
              <tr v-if="edit">
                <td colspan="2" class="text-center">
                  <h3 class="text-lg font-bold">{{ $t('block.countdown_for_block_input') }}</h3>
                  <div class="py-4">
                    <div class="join">
                      <input class="input input-bordered join-item" v-model="newHeight" type="number" />
                      <button class="btn btn-primary join-item" @click="updateTarget()">
                        {{ $t('block.btn_update') }}
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
              <tr>
                <td>{{ $t('block.current_height') }}:</td>
                <td class="text-right">
                  #{{ store.latest?.block?.header.height }}
                </td>
              </tr>
              <tr>
                <td>{{ $t('block.remaining_blocks') }}:</td>
                <td class="text-right">{{ remainingBlocks }}</td>
              </tr>
              <tr>
                <td>{{ $t('block.average_block_time') }}:</td>
                <td class="text-right">
                  {{ (store.blocktime / 1000).toFixed(1) }}s
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div v-else class="block-detail">
      <section class="block-hero">
        <div>
          <div class="sz-section-kicker">Block record</div>
          <h1 class="block-hero__title">#{{ current.block?.header?.height }}</h1>
          <p class="block-hero__meta">{{ store.blockchain.chainId }} · {{ format.toLocaleDate(current.block?.header?.time) }}</p>
        </div>
        <div v-if="props.height" class="block-hero__nav">
          <RouterLink :to="`/${store.blockchain.chainName}/block/${height - 1}`" class="block-nav" aria-label="Previous block"><Icon icon="mdi-arrow-left" /></RouterLink>
          <RouterLink :to="`/${store.blockchain.chainName}/block/${height + 1}`" class="block-nav block-nav--next" aria-label="Next block"><Icon icon="mdi-arrow-right" /></RouterLink>
        </div>
      </section>

      <section class="block-facts">
        <div><span>CHAIN ID</span><strong>{{ current.block?.header?.chain_id }}</strong></div>
        <div><span>HEIGHT</span><strong>#{{ current.block?.header?.height }}</strong></div>
        <div><span>PROPOSER</span><strong>{{ current.block?.header?.proposer_address ? format.validator(current.block.header.proposer_address) : '—' }}</strong></div>
        <div><span>TRANSACTIONS</span><strong>{{ current.block?.data?.txs?.length || 0 }}</strong></div>
      </section>

      <section class="block-panel block-panel--identity">
        <div class="block-panel__head"><div><div class="sz-section-kicker">Identity</div><h2>Block fingerprint</h2></div><span class="block-status">FINALIZED</span></div>
        <div class="block-id"><span>BLOCK ID</span><DynamicComponent :value="current.block_id" /></div>
      </section>

      <section class="block-panel">
        <div class="block-panel__head"><div><div class="sz-section-kicker">Consensus data</div><h2>Header fields</h2></div><Icon icon="mdi-tune-variant" /></div>
        <DynamicComponent :value="current.block?.header" />
      </section>

      <section class="block-panel">
        <div class="block-panel__head"><div><div class="sz-section-kicker">Payload</div><h2>{{ $t('account.transactions') }}</h2></div><span class="block-count">{{ current.block?.data?.txs?.length || 0 }} tx</span></div>
        <TxsElement :value="current.block?.data?.txs" />
      </section>

      <section class="block-panel block-panel--commit">
        <div class="block-panel__head"><div><div class="sz-section-kicker">Validator signatures</div><h2>{{ $t('block.last_commit') }}</h2></div><Icon icon="mdi-check-decagram-outline" /></div>
        <DynamicComponent :value="current.block?.last_commit" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.block-detail { display:grid; gap:16px; }
.block-hero { display:flex; justify-content:space-between; align-items:center; padding:28px 30px; border-radius:20px; color:#f7fbff; background:#111b2d; box-shadow:0 12px 30px rgba(17,27,45,.16); }
.block-hero__title { margin:4px 0 2px; font-size:clamp(2rem,5vw,3.2rem); letter-spacing:-.06em; font-weight:800; }
.block-hero__meta { margin:0; color:#a9bad2; font-size:13px; }
.block-hero .sz-section-kicker { color:#79d8c4; }
.block-hero__nav { display:flex; gap:8px; }
.block-nav { display:grid; place-items:center; width:42px; height:42px; border:1px solid #3b4b63; border-radius:12px; color:#d9e7f5; font-size:22px; }
.block-nav--next { background:#79d8c4; border-color:#79d8c4; color:#102033; }
.block-facts { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
.block-facts > div { padding:16px 18px; border:1px solid var(--sz-border); border-radius:14px; background:var(--sz-surface, #fff); }
.block-facts span,.block-id > span { display:block; color:#718198; font-size:10px; font-weight:800; letter-spacing:.12em; }
.block-facts strong { display:block; margin-top:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
.block-panel { padding:22px; border:1px solid var(--sz-border); border-radius:18px; background:var(--sz-surface, #fff); box-shadow:0 7px 20px rgba(33,55,80,.05); overflow:hidden; }
html.dark .block-panel, html[data-theme='dark'] .block-panel { box-shadow:0 10px 28px rgba(0,0,0,.22); }
.block-id { color:var(--text-main); background:var(--bg-active); }
.block-panel__head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
.block-panel__head h2 { margin:2px 0 0; font-size:20px; letter-spacing:-.025em; }
.block-panel__head > svg { color:#3985a6; font-size:22px; }
.block-status,.block-count { padding:5px 9px; border-radius:999px; color:#176d5f; background:#d9f4ec; font-size:10px; font-weight:800; letter-spacing:.08em; }
.block-id { padding:14px 16px; border-radius:12px; background:#f2f6fa; }
.block-id :deep(table) { margin-top:5px; }
.block-panel--commit { border-top:3px solid #79d8c4; }
@media (max-width: 640px) { .block-hero { padding:22px 18px; border-radius:16px; } .block-facts { grid-template-columns:repeat(2,minmax(0,1fr)); } .block-panel { padding:17px 14px; border-radius:15px; } .block-panel__head h2 { font-size:17px; } }
</style>
