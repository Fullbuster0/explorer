<script lang="ts" setup>
import { useGovStore } from '@/stores';
import ProposalListItem from '@/components/ProposalListItem.vue';
import { ref, onMounted, computed } from 'vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { PageRequest } from '@/types';

const tab = ref('2');
const store = useGovStore();
const pageRequest = ref(new PageRequest());

onMounted(() => {
  store.fetchProposals('2').then((x) => {
    if (x?.proposals?.length === 0) {
      tab.value = '3';
      store.fetchProposals('3');
    }
    store.fetchProposals('3');
    store.fetchProposals('4');
  });
});

const changeTab = (val: '2' | '3' | '4') => {
  tab.value = val;
  pageRequest.value.setPage(1);
  store.fetchProposals(val, pageRequest.value);
};

function page(p: number) {
  pageRequest.value.setPage(p);
  store.fetchProposals(tab.value, pageRequest.value);
}

const total = computed(() => {
  const cur = store?.proposals?.[tab.value]?.pagination?.total;
  return Number(cur || 0);
});
const hasAny = computed(() => total.value > 0);

const tabSub: Record<string, string> = {
  '2': 'Open',
  '3': 'Closed',
  '4': 'Closed',
};
</script>

<template>
  <div>
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">On-chain</div>
        <h1 class="sz-page-title">{{ $t('module.governance') }}</h1>
        <div class="sz-page-sub flex items-center gap-2">
          <span class="sz-live-dot" v-if="hasAny"></span>
          <span>
            <span v-if="hasAny">{{ total }} proposal{{ total === 1 ? '' : 's' }} · read-only ledger</span>
            <span v-else>Voting · Passed · Rejected</span>
          </span>
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === '2' }" @click="changeTab('2')">
          {{ $t('gov.voting') }}
        </a>
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === '3' }" @click="changeTab('3')">
          {{ $t('gov.passed') }}
        </a>
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === '4' }" @click="changeTab('4')">
          {{ $t('gov.rejected') }}
        </a>
      </div>
    </div>

    <ProposalListItem :proposals="store?.proposals[tab]" />
    <PaginationBar :total="store?.proposals[tab]?.pagination?.total" :limit="pageRequest.limit" :callback="page" />
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'governance',
      order: 2
    }
  }
</route>
