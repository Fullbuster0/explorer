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

onMounted(() => {
  pageload(1);
});

function pageload(p: number) {
  pageRequest.value.setPage(p);
  chainStore.rpc.getAuthAccounts(pageRequest.value).then((x) => {
    accounts.value = x.accounts;
    pageResponse.value = x.pagination;
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
