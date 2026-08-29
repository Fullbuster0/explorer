<script lang="ts" setup>
import { useGovStore } from '@/stores';
import { useBlockchain } from '@/stores';
import ProposalListItem from '@/components/ProposalListItem.vue';
import { ref, onMounted, computed, watch } from 'vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { PageRequest } from '@/types';

const tab = ref('2');
const store = useGovStore();
const chainStore = useBlockchain();
const pageRequest = ref(new PageRequest());

function bootstrap() {
  store.fetchProposals('2').then((x) => {
    if (x?.proposals?.length === 0) {
      tab.value = '3';
    }
    // '3' was previously fetched twice (once inside the branch above, once
    // here) — the duplicate request could resolve out of order and clobber the
    // list. One call per status is enough.
    store.fetchProposals('3');
    store.fetchProposals('4');
  });
}

onMounted(() => {
  bootstrap();
});

// First paint races chain connect: `blockchain.rpc` is undefined then, so
// getGovProposals resolves to undefined and every tab renders the empty state
// with no retry. Re-run once a working endpoint lands.
watch(
  () => chainStore.endpoint?.address,
  (addr, prev) => {
    if (addr && addr !== prev) bootstrap();
  }
);

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
  const bucket = store?.proposals?.[tab.value];
  const cur = Number(bucket?.pagination?.total || 0);
  // Several public LCDs (polkachu among them) answer gov queries with
  // `pagination.total: "0"` even when `proposals[]` is populated. Falling back
  // to the row count keeps the header from claiming there are no proposals
  // while the list right below it renders them.
  return cur || Number(bucket?.proposals?.length || 0);
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
