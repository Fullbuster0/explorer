<script lang="ts" setup>
/**
 * Gnoland GovDAO — proposal detail.
 * Vote split, eligible tiers, valset updates, and the voter list for a single
 * proposal from gno.land/r/gov/dao.
 */
import { ref, computed, onMounted, watch } from 'vue';
import { useBlockchain } from '@/stores';
import { loadGnoGov, proposalKind, type GnoGovData, type GnoGovProposal } from '@/libs/gno/gov';

const props = defineProps(['proposal_id', 'chain']);
const chainStore = useBlockchain();

const gov = ref<GnoGovData | null>(null);
const live = ref(false);
const loading = ref(true);

const proposal = computed<GnoGovProposal | null>(() => {
  const id = Number(props.proposal_id);
  return gov.value?.proposals.find((p) => p.proposal_id === id) || null;
});

function statusTone(s?: string): string {
  if (s === 'ACCEPTED') return 'passed';
  if (s === 'REJECTED') return 'rejected';
  if (s === 'ACTIVE') return 'voting';
  return 'failed';
}
function statusLabel(s?: string): string {
  if (s === 'ACCEPTED') return 'Accepted';
  if (s === 'REJECTED') return 'Rejected';
  if (s === 'ACTIVE') return 'Voting';
  return s || '—';
}
function pct(v: number | null): string {
  return v == null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}
function actionTone(a: string): string {
  if (a === 'add') return 'add';
  if (a === 'remove') return 'remove';
  return 'update';
}
function gnowebProposalUrl(): string {
  const base = (chainStore.current as any)?.gnoweb || gov.value?.source?.gnoweb_base || 'https://topaz.testnets.gno.land';
  return `${base.replace(/\/$/, '')}/r/gov/dao:${props.proposal_id}`;
}

async function load() {
  loading.value = true;
  const res = await loadGnoGov((chainStore.current as any)?.valopers_live_url);
  gov.value = res.data;
  live.value = res.live;
  loading.value = false;
}

onMounted(load);
watch(() => props.proposal_id, load);
</script>

<template>
  <div>
    <RouterLink :to="`/${chainStore.chainName}/gno-gov`" class="sz-govdao-back">← All proposals</RouterLink>

    <div v-if="loading" class="sz-govdao-loading">
      <div class="sz-govdao-loading-bar"></div>
      <span>Loading proposal…</span>
    </div>

    <div v-else-if="!proposal" class="sz-gov-empty">
      <div class="sz-gov-empty-icon">◇</div>
      <div class="sz-gov-empty-title">Proposal #{{ proposal_id }} not found</div>
      <div class="sz-gov-empty-sub">It may not exist in the GovDAO realm yet.</div>
    </div>

    <div v-else>
      <!-- header -->
      <div class="sz-page-head">
        <div>
          <div class="sz-section-kicker">GovDAO · <span class="sz-govdao-kind">{{ proposalKind(proposal) }}</span></div>
          <h1 class="sz-page-title sz-govdao-detail-title">
            <span class="sz-govdao-hash">#{{ proposal.proposal_id }}</span> {{ proposal.title }}
          </h1>
          <div class="sz-page-sub flex items-center gap-2">
            <span class="sz-gov-status" :data-tone="statusTone(proposal.status)">{{ statusLabel(proposal.status) }}</span>
            <span v-for="t in proposal.eligible_tiers" :key="t" class="sz-tier" :data-tier="t">{{ t }}</span>
          </div>
        </div>
        <div class="sz-govdao-source">
          <a class="sz-chip sz-chip--info" :href="gnowebProposalUrl()" target="_blank" rel="noopener noreferrer">
            view on gnoweb ↗
          </a>
        </div>
      </div>

      <!-- vote split -->
      <section class="sz-govdao-panel sz-reveal">
        <div class="sz-govdao-panel-head">
          <span class="sz-govdao-panel-title">Vote split</span>
          <span class="sz-govdao-panel-meta">{{ proposal.voters.length }} voter{{ proposal.voters.length === 1 ? '' : 's' }} · eligible: {{ proposal.eligible_tiers.join(' / ') || '—' }}</span>
        </div>
        <div class="sz-govdao-votes">
          <div class="sz-govdao-vote" data-seg="yes">
            <span class="sz-govdao-vote-num">{{ pct(proposal.yes_percent) }}</span>
            <span class="sz-govdao-vote-label">Yes</span>
          </div>
          <div class="sz-govdao-vote" data-seg="no">
            <span class="sz-govdao-vote-num">{{ pct(proposal.no_percent) }}</span>
            <span class="sz-govdao-vote-label">No</span>
          </div>
          <div class="sz-govdao-vote" data-seg="abstain">
            <span class="sz-govdao-vote-num">{{ pct(proposal.abstain_percent) }}</span>
            <span class="sz-govdao-vote-label">Abstain</span>
          </div>
        </div>
        <div class="sz-gov-tally-bar sz-govdao-bigbar">
          <div class="sz-gov-tally-seg" data-seg="yes" :style="{ width: pct(proposal.yes_percent) }"></div>
          <div class="sz-gov-tally-seg" data-seg="no" :style="{ width: pct(proposal.no_percent) }"></div>
          <div class="sz-gov-tally-seg" data-seg="abstain" :style="{ width: pct(proposal.abstain_percent) }"></div>
        </div>
      </section>

      <!-- description + author -->
      <section class="sz-govdao-panel sz-reveal" style="animation-delay: 60ms">
        <div class="sz-govdao-panel-head">
          <span class="sz-govdao-panel-title">Details</span>
        </div>
        <div class="sz-govdao-detailgrid">
          <div class="sz-govdao-drow"><span class="sz-govdao-dlabel">Author</span><code class="sz-govdao-dval">{{ proposal.author_address || '—' }}</code></div>
          <div class="sz-govdao-drow"><span class="sz-govdao-dlabel">Realm</span><code class="sz-govdao-dval">{{ gov?.source?.realm_path }}</code></div>
          <div class="sz-govdao-drow" v-if="proposal.description">
            <span class="sz-govdao-dlabel">Description</span><span class="sz-govdao-dval">{{ proposal.description }}</span>
          </div>
        </div>
      </section>

      <!-- validator updates -->
      <section class="sz-govdao-panel sz-reveal" style="animation-delay: 120ms" v-if="proposal.validator_updates.length">
        <div class="sz-govdao-panel-head">
          <span class="sz-govdao-panel-title">Validator updates</span>
          <span class="sz-govdao-panel-meta">{{ proposal.validator_updates.length }} change{{ proposal.validator_updates.length === 1 ? '' : 's' }}</span>
        </div>
        <div class="sz-govdao-updates">
          <div v-for="(u, idx) in proposal.validator_updates" :key="idx" class="sz-govdao-update">
            <span class="sz-govdao-update-action" :data-action="actionTone(u.action)">{{ u.action }}</span>
            <RouterLink :to="`/${chainStore.chainName}/account/${u.address}`" class="sz-govdao-update-addr">{{ u.address }}</RouterLink>
            <span class="sz-govdao-update-power" v-if="u.power != null">power {{ u.power }}</span>
          </div>
        </div>
      </section>

      <!-- voters -->
      <section class="sz-govdao-panel sz-reveal" style="animation-delay: 180ms" v-if="proposal.voters.length">
        <div class="sz-govdao-panel-head">
          <span class="sz-govdao-panel-title">Voters</span>
          <span class="sz-govdao-panel-meta">{{ proposal.voters.length }}</span>
        </div>
        <div class="sz-govdao-voters">
          <div v-for="v in proposal.voters" :key="v.address" class="sz-govdao-voter">
            <RouterLink :to="`/${chainStore.chainName}/account/${v.address}`" class="sz-govdao-update-addr">{{ v.address }}</RouterLink>
            <span class="sz-govdao-voter-vote" :data-seg="v.vote.toLowerCase()">{{ v.vote }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<route>
  {
    meta: {
      i18n: 'governance'
    }
  }
</route>
