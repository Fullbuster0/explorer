<script lang="ts" setup>
import { useBlockchain, useFormatter, useStakingStore } from '@/stores';
import { select } from '@/components/dynamic/index';
import type { PaginatedProposals, GovProposal } from '@/types';
import type { PropType } from 'vue';
import { computed, ref } from 'vue';
import { unescapeLiteralNewlines } from '@/libs/utils';

defineProps({
  proposals: { type: Object as PropType<PaginatedProposals> },
});

const format = useFormatter();
const staking = useStakingStore();
const chain = useBlockchain();

const total = computed(() => staking.pool?.bonded_tokens);

function showType(v?: string) {
  if (!v) return '';
  return v.substring(v.lastIndexOf('.') + 1).replace('Msg', '').replace('Proposal', '');
}

/** Map SDK proposal status → short label + tone slug for styling. */
function statusOf(status?: string): { label: string; tone: string } {
  switch (status) {
    case 'PROPOSAL_STATUS_VOTING_PERIOD':
      return { label: 'Voting', tone: 'voting' };
    case 'PROPOSAL_STATUS_PASSED':
      return { label: 'Passed', tone: 'passed' };
    case 'PROPOSAL_STATUS_REJECTED':
      return { label: 'Rejected', tone: 'rejected' };
    case 'PROPOSAL_STATUS_FAILED':
      return { label: 'Failed', tone: 'failed' };
    case 'PROPOSAL_STATUS_DEPOSIT_PERIOD':
      return { label: 'Deposit', tone: 'deposit' };
    default:
      return { label: status ? status.replace('PROPOSAL_STATUS_', '') : '—', tone: 'failed' };
  }
}

/** Tally percentages (of bonded supply) for the in-card bar. */
function tallySegs(item: GovProposal) {
  const t = item.final_tally_result;
  return {
    yes: format.calculatePercent(t?.yes, total.value),
    no: format.calculatePercent(t?.no, total.value),
    veto: format.calculatePercent(t?.no_with_veto, total.value),
    abstain: format.calculatePercent(t?.abstain, total.value),
  };
}

function proposalTitle(item: GovProposal): string {
  return item.title || item.content?.title || metaItem(item.metadata)?.title || `Proposal #${item.proposal_id}`;
}

function proposalSummary(item: GovProposal): string {
  // Double-escaped summaries would otherwise show visible \n litter in the card preview.
  return unescapeLiteralNewlines(
    item.summary || item.content?.description || metaItem(item.metadata)?.summary || ''
  );
}

function metaItem(metadata?: string): { title?: string; summary?: string } {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

const proposalInfo = ref<GovProposal>();
</script>

<template>
  <div class="sz-gov-list">
    <RouterLink
      v-for="(item, index) in proposals?.proposals"
      :key="item.proposal_id || index"
      :to="`/${chain.chainName}/gov/${item.proposal_id}`"
      class="sz-gov-card"
      :data-status="statusOf(item.status).tone"
    >
      <div class="sz-gov-row">
        <div class="sz-gov-body">
          <div class="sz-gov-title-row">
            <span class="sz-gov-id">#{{ item.proposal_id }}</span>
            <span class="sz-gov-title">{{ proposalTitle(item) }}</span>
          </div>

          <div class="sz-gov-meta" style="margin-top: 0.4rem">
            <span v-if="item.content?.['@type']" class="sz-gov-type-pill">{{ showType(item.content['@type']) }}</span>
            <span v-if="item.is_expedited" class="sz-gov-expedited">Expedited</span>
            <span class="sz-gov-meta-item">
              <span class="sz-gov-meta-label">Submitted</span>
              <span class="sz-gov-meta-value">{{ format.toDay(item.submit_time, 'from') }}</span>
            </span>
            <span class="sz-gov-meta-item">
              <span class="sz-gov-meta-label">Voting ends</span>
              <span
                class="sz-gov-meta-value"
                :class="{ 'sz-gov-time--live': statusOf(item.status).tone === 'voting' }"
              >
                {{ format.toDay(item.voting_end_time, 'from') }}
              </span>
            </span>
          </div>

          <p v-if="proposalSummary(item)" class="sz-gov-sub">{{ proposalSummary(item) }}</p>
        </div>

        <div class="sz-gov-side">
          <span class="sz-gov-status" :data-tone="statusOf(item.status).tone">
            {{ statusOf(item.status).label }}
          </span>
          <div class="sz-gov-side-meta">
            <strong>{{ format.toDay(item.voting_end_time, 'from') }}</strong>
            {{ statusOf(item.status).tone === 'voting' ? 'remaining' : 'closed' }}
          </div>
        </div>
      </div>

      <!-- tally bar -->
      <div class="sz-gov-tally">
        <div class="sz-gov-tally-bar">
          <div class="sz-gov-tally-seg" data-seg="yes" :style="{ width: tallySegs(item).yes }"></div>
          <div class="sz-gov-tally-seg" data-seg="no" :style="{ width: tallySegs(item).no }"></div>
          <div class="sz-gov-tally-seg" data-seg="veto" :style="{ width: tallySegs(item).veto }"></div>
          <div class="sz-gov-tally-seg" data-seg="abstain" :style="{ width: tallySegs(item).abstain }"></div>
        </div>
        <div class="sz-gov-tally-legend">
          <span class="sz-gov-tally-legend-item"><span class="sz-gov-tally-swatch" data-seg="yes"></span>{{ tallySegs(item).yes }}</span>
          <span class="sz-gov-tally-legend-item"><span class="sz-gov-tally-swatch" data-seg="no"></span>{{ tallySegs(item).no }}</span>
          <span class="sz-gov-tally-legend-item"><span class="sz-gov-tally-swatch" data-seg="veto"></span>{{ tallySegs(item).veto }}</span>
          <span class="sz-gov-tally-legend-item"><span class="sz-gov-tally-swatch" data-seg="abstain"></span>{{ tallySegs(item).abstain }}</span>
        </div>
      </div>
    </RouterLink>

    <!-- empty / loading state -->
    <div v-if="!proposals?.proposals?.length" class="sz-gov-empty">
      <div class="sz-gov-empty-icon">◇</div>
      <div class="sz-gov-empty-title">No proposals in this state</div>
      <div class="sz-gov-empty-sub">
        Nothing here right now — switch tabs above to browse voting, passed, or rejected proposals.
      </div>
    </div>

    <!-- description modal (kept from original) -->
    <input type="checkbox" id="proposal-detail-modal" class="modal-toggle" />
    <label for="proposal-detail-modal" class="modal">
      <label class="modal-box !w-11/12 !max-w-5xl" for="">
        <label for="proposal-detail-modal" class="btn btn-sm btn-circle absolute right-2 top-2">✕</label>
        <h3 class="font-bold text-lg">Description</h3>
        <p class="py-4">
          <Component
            v-if="
              proposalInfo?.content?.description || proposalInfo?.summary || metaItem(proposalInfo?.metadata)?.summary
            "
            :is="
              select(
                proposalInfo?.content?.description ||
                  proposalInfo?.summary ||
                  metaItem(proposalInfo?.metadata)?.summary,
                'horizontal'
              )
            "
            :value="
              proposalInfo?.content?.description || proposalInfo?.summary || metaItem(proposalInfo?.metadata)?.summary
            "
          >
          </Component>
        </p>
      </label>
    </label>
  </div>
</template>
