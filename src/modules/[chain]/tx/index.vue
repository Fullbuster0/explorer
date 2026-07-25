<script lang="ts" setup>
import { computed, ref } from '@vue/reactivity';
import { useBaseStore, useBlockchain, useFormatter } from '@/stores';
import type { PaginatedTxs } from '@/types';
import { useRouter } from 'vue-router';
import { onMounted } from 'vue';
const props = defineProps(['chain']);
const vueRouters = useRouter();
const tab = ref('recent');

const base = useBaseStore();
const chainStore = useBlockchain();

const format = useFormatter();
const hashReg = /^[A-Z\d]{64}$/;
const hash = ref('');
const current = chainStore?.current?.chainName || '';
onMounted(() => {
  tab.value = String(vueRouters.currentRoute.value.query.tab || 'recent');
});
function search() {
  if (hashReg.test(hash.value)) {
    vueRouters.push({ path: `/${current}/tx/${hash.value}` });
  }
}
</script>
<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Chain</div>
        <h1 class="sz-page-title">{{ $t('module.tx') }}</h1>
        <div class="sz-page-sub">
          {{ base.txsInRecents?.length || 0 }} recent · from last {{ base.recents?.length || 0 }} blocks
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'recent' }" @click="tab = 'recent'">
          {{ $t('block.recent') }}
        </a>
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'search' }" @click="tab = 'search'">Search</a>
      </div>
    </div>

    <div v-show="tab === 'recent'" class="sz-section overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th>{{ $t('account.height') }}</th>
              <th>{{ $t('account.hash') }}</th>
              <th>{{ $t('account.messages') }}</th>
              <th class="text-right">{{ $t('block.fees') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in base.txsInRecents" :key="item.hash || index">
              <td class="font-mono text-sm">
                <RouterLink class="link link-hover text-primary" :to="`/${props.chain}/block/${item.height}`">
                  #{{ item.height }}
                </RouterLink>
              </td>
              <td class="max-w-[280px] truncate">
                <RouterLink class="sz-hash link link-hover text-primary" :to="`/${props.chain}/tx/${item.hash}`">
                  {{ item.hash }}
                </RouterLink>
              </td>
              <td>
                <span class="sz-msg">{{ format.messages(item.tx.body.messages) }}</span>
              </td>
              <td class="text-right font-mono text-xs">
                {{ format.formatTokens(item.tx.authInfo.fee?.amount) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="border-t border-base-content/10 p-4">
        <div class="flex items-start gap-2 text-sm text-secondary">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current flex-shrink-0 w-5 h-5 opacity-60">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span>{{ $t('block.only_tx') }}</span>
        </div>
      </div>
    </div>

    <div v-show="tab === 'search'" class="sz-section p-5">
      <div class="form-control max-w-xl">
        <label class="sz-metric-label mb-2">Transaction Hash</label>
        <div class="flex gap-2">
          <input
            v-model="hash"
            type="text"
            class="input input-bordered flex-1 font-mono text-sm"
            placeholder="Search by Tx Hash"
            @keyup.enter="search"
          />
          <button class="btn btn-primary" @click="search">Search</button>
        </div>
      </div>
    </div>
  </div>
</template>

<route>
    {
      meta: {
        i18n: 'tx',
        order: 5
      }
    }
  </route>
