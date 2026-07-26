<script lang="ts" setup>
import { useBaseStore, useBlockchain, useFormatter } from '@/stores';
import DynamicComponent from '@/components/dynamic/DynamicComponent.vue';
import { computed, ref, watch } from 'vue';
import type { Tx, TxResponse } from '@/types';

import { JsonViewer } from 'vue3-json-viewer';
// if you used v1.0.5 or latster ,you should add import "vue3-json-viewer/dist/index.css"
import 'vue3-json-viewer/dist/index.css';

const props = defineProps(['hash', 'chain']);

const blockchain = useBlockchain();
const baseStore = useBaseStore();
const format = useFormatter();
const tx = ref(
  {} as {
    tx: Tx;
    tx_response: TxResponse;
  }
);
const loading = ref(false);
const error = ref('');
const sourceHint = ref('');

async function loadTx(hash?: string) {
  const h = (hash || '').trim();
  if (!h) return;
  loading.value = true;
  error.value = '';
  sourceHint.value = '';
  try {
    // Wait briefly for REST endpoint if chain just mounted
    if (!blockchain.endpoint?.address) {
      for (let i = 0; i < 20 && !blockchain.endpoint?.address; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    // Archive-aware: active REST first, then archive / non-pruned list
    const res = await blockchain.fetchTx(h);
    if (res && res.tx_response) {
      tx.value = res as any;
    } else {
      tx.value = {} as any;
      error.value = 'Transaction not found on active or archive REST endpoints.';
    }
  } catch (e: any) {
    tx.value = {} as any;
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.hash, blockchain.endpoint?.address] as const,
  ([h]) => {
    if (h) loadTx(h);
  },
  { immediate: true }
);

const messages = computed(() => {
  return (
    tx.value.tx?.body?.messages.map((x) => {
      if (x.packet?.data) {
        // @ts-ignore
        x.message = format.base64ToString(x.packet.data);
      }
      return x;
    }) || []
  );
});
</script>
<template>
  <div>
    <div class="tabs tabs-boxed bg-transparent mb-4">
      <RouterLink class="tab text-gray-400 uppercase" :to="`/${chain}/tx/?tab=recent`">{{
        $t('block.recent')
      }}</RouterLink>
      <RouterLink class="tab text-gray-400 uppercase" :to="`/${chain}/tx/?tab=search`">Search</RouterLink>
      <a class="tab text-gray-400 uppercase tab-active">Transaction</a>
    </div>

    <div v-if="loading" class="bg-base-100 px-4 py-6 rounded shadow mb-4 text-sm opacity-70">
      Loading transaction… (trying active REST, then archive)
    </div>

    <div v-else-if="error && !tx.tx_response" class="bg-base-100 px-4 py-4 rounded shadow mb-4 text-sm">
      <b class="text-error">Not found</b>
      <div class="mt-1 opacity-80">{{ error }}</div>
      <div class="mt-2 text-xs opacity-60">
        Hash: <span class="font-mono">{{ hash }}</span>
      </div>
    </div>

    <div v-if="tx.tx_response" class="bg-base-100 px-4 pt-3 pb-4 rounded shadow mb-4">
      <h2 class="card-title truncate mb-2">{{ $t('tx.title') }}</h2>
      <div class="overflow-hidden">
        <table class="table text-sm">
          <tbody>
            <tr>
              <td>{{ $t('tx.tx_hash') }}</td>
              <td class="overflow-hidden">{{ tx.tx_response.txhash }}</td>
            </tr>
            <tr>
              <td>{{ $t('account.height') }}</td>
              <td>
                <RouterLink :to="`/${props.chain}/block/${tx.tx_response.height}`" class="text-primary dark:invert"
                  >{{ tx.tx_response.height }}
                </RouterLink>
              </td>
            </tr>
            <tr>
              <td>{{ $t('staking.status') }}</td>
              <td>
                <span
                  class="text-xs truncate relative py-2 px-4 w-fit mr-2 rounded"
                  :class="`text-${tx.tx_response.code === 0 ? 'success' : 'error'}`"
                >
                  <span
                    class="inset-x-0 inset-y-0 opacity-10 absolute"
                    :class="`bg-${tx.tx_response.code === 0 ? 'success' : 'error'}`"
                  ></span>
                  {{ tx.tx_response.code === 0 ? 'Success' : 'Failed' }}
                </span>
                <span>
                  {{ tx.tx_response.code === 0 ? '' : tx?.tx_response?.raw_log }}
                </span>
              </td>
            </tr>
            <tr>
              <td>{{ $t('account.time') }}</td>
              <td>
                {{ format.toLocaleDate(tx.tx_response.timestamp) }} ({{
                  format.toDay(tx.tx_response.timestamp, 'from')
                }})
              </td>
            </tr>
            <tr>
              <td>{{ $t('tx.gas') }}</td>
              <td>{{ tx.tx_response.gas_used }} / {{ tx.tx_response.gas_wanted }}</td>
            </tr>
            <tr>
              <td>{{ $t('tx.fee') }}</td>
              <td>
                {{ format.formatTokens(tx.tx?.auth_info?.fee?.amount, true, '0,0.[00]') }}
              </td>
            </tr>
            <tr>
              <td>{{ $t('tx.memo') }}</td>
              <td>{{ tx.tx.body.memo }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="tx.tx_response" class="bg-base-100 px-4 pt-3 pb-4 rounded shadow mb-4">
      <h2 class="card-title truncate mb-2">{{ $t('account.messages') }}: ({{ messages.length }})</h2>
      <div v-for="(msg, i) in messages" :key="i">
        <div class="border border-slate-400 rounded-md mt-4">
          <DynamicComponent :value="msg" />
        </div>
      </div>
      <div v-if="messages.length === 0">{{ $t('tx.no_messages') }}</div>
    </div>

    <div v-if="tx.tx_response" class="bg-base-100 px-4 pt-3 pb-4 rounded shadow">
      <h2 class="card-title truncate mb-2">JSON</h2>
      <JsonViewer
        :value="tx"
        :theme="baseStore.theme"
        style="background: transparent"
        copyable
        boxed
        sort
        expand-depth="5"
      />
    </div>
  </div>
</template>
