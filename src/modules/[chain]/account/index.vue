<script lang="ts" setup>
import { computed, ref } from '@vue/reactivity';
import { useBaseStore, useBlockchain, useFormatter } from '@/stores';
import { PageRequest, type AuthAccount, type Pagination } from '@/types';
import { onMounted } from 'vue';
import PaginationBar from '@/components/PaginationBar.vue';
const props = defineProps(['chain']);

const chainStore = useBlockchain();

const accounts = ref([] as AuthAccount[]);
const pageRequest = ref(new PageRequest());
const pageResponse = ref({} as Pagination);
const loading = ref(false);
const errorMsg = ref('');

onMounted(() => {
  pageload(1);
});

function pageload(p: number) {
  pageRequest.value.setPage(p);
  loading.value = true;
  errorMsg.value = '';
  chainStore.rpc
    .getAuthAccounts(pageRequest.value)
    .then((x) => {
      accounts.value = x?.accounts || [];
      pageResponse.value = x?.pagination || ({} as Pagination);
      if (!accounts.value.length) {
        errorMsg.value =
          'No accounts returned. This LCD may restrict the auth accounts list — try another endpoint from the network menu, or open a specific address via search.';
      }
    })
    .catch((e: any) => {
      accounts.value = [];
      pageResponse.value = {} as Pagination;
      const msg = String(e?.message || e || 'Failed to load accounts');
      errorMsg.value = msg.includes('HTTP error')
        ? `${msg}. Many public LCDs block /cosmos/auth/v1beta1/accounts — switch endpoint or search an address directly.`
        : msg;
    })
    .finally(() => {
      loading.value = false;
    });
}

function showType(v: string) {
  return v.replace('/cosmos.auth.v1beta1.', '');
}
function findField(v: any, field: string) {
  if (!v || Array.isArray(v) || typeof v === 'string') return null;
  const fields = Object.keys(v);
  if (fields.includes(field)) {
    return v[field];
  }
  for (let i = 0; i < fields.length; i++) {
    const re: any = findField(v[fields[i]], field);
    if (re) return re;
  }
}
function showAddress(v: any) {
  return findField(v, 'address');
}
function showAccountNumber(v: any) {
  return findField(v, 'account_number');
}
function showSequence(v: any) {
  return findField(v, 'sequence');
}
function showPubkey(v: any) {
  return findField(v, 'pub_key');
}
</script>
<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Chain</div>
        <h1 class="sz-page-title">{{ $t('module.account') }}</h1>
        <div class="sz-page-sub">All registered accounts on this network</div>
      </div>
    </div>

    <div v-if="errorMsg" class="alert alert-warning mb-4 text-sm">
      <span>{{ errorMsg }}</span>
    </div>

    <div class="sz-section overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th>{{ $t('account.type') }}</th>
              <th>{{ $t('account.address') }}</th>
              <th class="text-right">{{ $t('account.acc_num') }}</th>
              <th class="text-right">{{ $t('account.sequence') }}</th>
              <th>{{ $t('account.pub_key') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="5" class="text-center opacity-60 py-6">Loading accounts…</td>
            </tr>
            <tr v-for="acc in accounts" :key="showAddress(acc)">
              <td><span class="sz-msg">{{ showType(acc['@type']) }}</span></td>
              <td>
                <RouterLink class="sz-hash link link-hover text-primary" :to="`/${chain}/account/${showAddress(acc)}`">
                  {{ showAddress(acc) }}
                </RouterLink>
              </td>
              <td class="text-right font-mono text-xs">{{ showAccountNumber(acc) }}</td>
              <td class="text-right font-mono text-xs">{{ showSequence(acc) }}</td>
              <td class="font-mono text-xs truncate max-w-[220px]">{{ showPubkey(acc) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationBar :limit="pageRequest.limit" :total="pageResponse.total" :callback="pageload" />
    </div>
  </div>
</template>
