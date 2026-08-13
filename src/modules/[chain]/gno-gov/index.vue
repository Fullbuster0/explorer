<script lang="ts" setup>
/**
 * Gnoland GovDAO — proposal list.
 * Data: realm gno.land/r/gov/dao scraped to static JSON (see libs/gno/gov.ts).
 * Onbloc-independent. Design: reuses the sz-gov card/tally system from Cosmos
 * governance, extended with DAO tiers (T1/T2/T3) and valset-update awareness.
 */
import { ref, computed, onMounted } from 'vue';
import { useBlockchain } from '@/stores';
import { loadGnoGov, proposalKind, type GnoGovData, type GnoGovProposal } from '@/libs/gno/gov';

const chainStore = useBlockchain();

const gov = ref<GnoGovData | null>(null);
const live = ref(false);
const loading = ref(true);

const typeFilter = ref<'all' | 'valset' | 'register' | 'other'>('all');
const statusFilter = ref<'all' | 'ACCEPTED' | 'ACTIVE' | 'REJECTED'>('all');

const proposals = computed<GnoGovProposal[]>(() => gov.value?.proposals || []);

const filtered = computed(() =>
  proposals.value.filter((p) => {
    if (typeFilter.value !== 'all' && proposalKind(p) !== typeFilter.value) return false;
    if (statusFilter.value !== 'all' && p.status !== statusFilter.value) return false;
    return true;
  })
);

const counts = computed(() => gov.value?.status_counts || { active: 0, accepted: 0, rejected: 0, unknown: 0 });
const total = computed(() => proposals.value.length);
const latest = computed(() => gov.value?.source?.latest_proposal_id);
const realmPath = computed(() => gov.value?.source?.realm_path || 'gno.land/r/gov/dao');

/** Distinct tiers in play, for the legend. */
const tiers = computed(() => {
  const s = new Set<string>();
  proposals.value.forEach((p) => p.eligible_tiers.forEach((t) => s.add(t)));
  return [...s].sort();
});

function statusTone(s: string): string {
  if (s === 'ACCEPTED') return 'passed';
  if (s === 'REJECTED') return 'rejected';
  if (s === 'ACTIVE') return 'voting';
  return 'failed';
}
function statusLabel(s: string): string {
  if (s === 'ACCEPTED') return 'Accepted';
  if (s === 'REJECTED') return 'Rejected';
  if (s === 'ACTIVE') return 'Voting';
  return s;
}
function kindLabel(p: GnoGovProposal): string {
  const k = proposalKind(p);
  return k === 'valset' ? 'Valset' : k === 'register' ? 'Register' : 'Other';
}
function pct(v: number | null): string {
  return v == null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}
function shortAddr(a?: string | null): string {
  if (!a) return '—';
  return a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

onMounted(async () => {
  const res = await loadGnoGov((chainStore.current as any)?.valopers_live_url);
  gov.value = res.data;
  live.value = res.live;
  loading.value = false;
});
</script>

<template>
  <div>
    <!-- page head -->
    <div class="sz-page-head">
      <div>
        <div class="sz-section-kicker">Gnoland · GovDAO</div>
        <h1 class="sz-page-title">Governance</h1>
        <div class="sz-page-sub flex items-center gap-2">
          <span class="sz-live-dot" v-if="total"></span>
          <span>
            <span v-if="loading">Reading the DAO realm…</span>
            <span v-else>{{ total }} proposal{{ total === 1 ? '' : 's' }} · <code class="sz-govdao-realm">{{ realmPath }}</code></span>
          </span>
        </div>
      </div>
      <div class="sz-govdao-source" v-if="!loading">
        <span class="sz-chip" :class="live ? 'sz-chip--ok' : 'sz-chip--info'">
          {{ live ? 'chain-scoped snapshot' : 'bundled snapshot' }}
        </span>
      </div>
    </div>

    <!-- summary band — one strip, big monospace figures, not card grid -->
    <div class="sz-govdao-band" v-if="!loading && total">
      <div class="sz-govdao-stat">
        <span class="sz-govdao-stat-num">{{ total }}</span>
        <span class="sz-govdao-stat-label">Total</span>
      </div>
      <div class="sz-govdao-stat" data-tone="passed">
        <span class="sz-govdao-stat-num">{{ counts.accepted }}</span>
        <span class="sz-govdao-stat-label">Accepted</span>
      </div>
      <div class="sz-govdao-stat" data-tone="voting">
        <span class="sz-govdao-stat-num">{{ counts.active }}</span>
        <span class="sz-govdao-stat-label">Voting</span>
      </div>
      <div class="sz-govdao-stat" data-tone="rejected">
        <span class="sz-govdao-stat-num">{{ counts.rejected }}</span>
        <span class="sz-govdao-stat-label">Rejected</span>
      </div>
      <div class="sz-govdao-band-spacer"></div>
      <div class="sz-govdao-band-right">
        <div class="sz-govdao-latest" v-if="latest != null">latest <strong>#{{ latest }}</strong></div>
        <div class="sz-govdao-tiers" v-if="tiers.length">
          <span class="sz-govdao-tier-legend">eligible tiers</span>
          <span v-for="t in tiers" :key="t" class="sz-tier" :data-tier="t">{{ t }}</span>
        </div>
      </div>
    </div>

    <!-- filters -->
    <div class="sz-govdao-filters" v-if="!loading && total">
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': typeFilter === 'all' }" @click="typeFilter = 'all'">All</a>
        <a class="sz-tab" :class="{ 'sz-tab--active': typeFilter === 'valset' }" @click="typeFilter = 'valset'">Valset</a>
        <a class="sz-tab" :class="{ 'sz-tab--active': typeFilter === 'register' }" @click="typeFilter = 'register'">Register</a>
      </div>
      <div class="sz-govdao-statusfilter">
        <a
          v-for="s in (['all', 'ACCEPTED', 'ACTIVE', 'REJECTED'] as const)"
          :key="s"
          class="sz-govdao-schip"
          :class="{ 'sz-govdao-schip--on': statusFilter === s }"
          @click="statusFilter = s"
        >{{ s === 'all' ? 'any status' : statusLabel(s) }}</a>
      </div>
    </div>

    <!-- proposal cards -->
    <div class="sz-gov-list" v-if="!loading">
      <RouterLink
        v-for="(p, i) in filtered"
        :key="p.proposal_id"
        :to="`/${chainStore.chainName}/gno-gov/${p.proposal_id}`"
        class="sz-gov-card sz-reveal"
        :data-status="statusTone(p.status)"
        :style="{ animationDelay: `${Math.min(i, 12) * 40}ms` }"
      >
        <div class="sz-gov-row">
          <div class="sz-gov-body">
            <div class="sz-gov-title-row">
              <span class="sz-gov-id">#{{ p.proposal_id }}</span>
              <span class="sz-gov-title">{{ p.title }}</span>
            </div>
            <div class="sz-gov-meta" style="margin-top: 0.4rem">
              <span class="sz-gov-type-pill" :data-kind="proposalKind(p)">{{ kindLabel(p) }}</span>
              <span v-for="t in p.eligible_tiers" :key="t" class="sz-tier" :data-tier="t">{{ t }}</span>
              <span class="sz-gov-meta-item">
                <span class="sz-gov-meta-label">Author</span>
                <span class="sz-gov-meta-value">{{ shortAddr(p.author_address) }}</span>
              </span>
              <span class="sz-gov-meta-item" v-if="p.validator_updates.length">
                <span class="sz-gov-meta-label">Valset changes</span>
                <span class="sz-gov-meta-value">{{ p.validator_updates.length }}</span>
              </span>
            </div>
          </div>
          <div class="sz-gov-side">
            <span class="sz-gov-status" :data-tone="statusTone(p.status)">{{ statusLabel(p.status) }}</span>
            <div class="sz-gov-side-meta">
              <strong>{{ p.voters.length || '—' }}</strong> vote{{ p.voters.length === 1 ? '' : 's' }}
            </div>
          </div>
        </div>

        <!-- tally bar (Gno: yes / no / abstain — no veto) -->
        <div class="sz-gov-tally">
          <div class="sz-gov-tally-bar">
            <div class="sz-gov-tally-seg" data-seg="yes" :style="{ width: pct(p.yes_percent) }"></div>
            <div class="sz-gov-tally-seg" data-seg="no" :style="{ width: pct(p.no_percent) }"></div>
            <div class="sz-gov-tally-seg" data-seg="abstain" :style="{ width: pct(p.abstain_percent) }"></div>
          </div>
          <div class="sz-gov-tally-legend">
            <span class="sz-gov-tally-legend-item"><span class="sz-gov-tally-swatch" data-seg="yes"></span>{{ pct(p.yes_percent) }}</span>
            <span class="sz-gov-tally-legend-item"><span class="sz-gov-tally-swatch" data-seg="no"></span>{{ pct(p.no_percent) }}</span>
            <span class="sz-gov-tally-legend-item"><span class="sz-gov-tally-swatch" data-seg="abstain"></span>{{ pct(p.abstain_percent) }}</span>
          </div>
        </div>
      </RouterLink>

      <!-- empty -->
      <div v-if="!filtered.length" class="sz-gov-empty">
        <div class="sz-gov-empty-icon">◇</div>
        <div class="sz-gov-empty-title">No proposals match</div>
        <div class="sz-gov-empty-sub">Clear the filters above to browse every GovDAO proposal.</div>
      </div>
    </div>

    <!-- loading skeleton -->
    <div v-if="loading" class="sz-govdao-loading">
      <div class="sz-govdao-loading-bar"></div>
      <span>Querying <code>gno.land/r/gov/dao</code>…</span>
    </div>
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
