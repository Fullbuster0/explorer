<script lang="ts" setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import MdEditor from 'md-editor-v3';
import ObjectElement from '@/components/dynamic/ObjectElement.vue';
import Countdown from '@/components/Countdown.vue';
import {
  useBaseStore,
  useBlockchain,
  useFormatter,
  useGovStore,
  useStakingStore,
  useTxDialog,
} from '@/stores';
import { PageRequest, type GovProposal, type GovVote, type Validator } from '@/types';
import { fromBech32, toHex } from '@cosmjs/encoding';

const props = defineProps(['proposal_id', 'chain']);
const format = useFormatter();
const store = useGovStore();
const dialog = useTxDialog();
const stakingStore = useStakingStore();
const chainStore = useBlockchain();
const baseStore = useBaseStore();

// expose for template
const proposal_id = computed(() => props.proposal_id);
const chain = computed(() => props.chain);

const proposal = ref({} as GovProposal);
const loading = ref(true);
const votesLoading = ref(true);
const allVotes = ref([] as GovVote[]);
const deposits = ref(
  [] as { amount: { amount: string; denom: string }[]; proposal_id: string; depositor: string }[]
);

const voteFilter = ref<'all' | 'yes' | 'no' | 'veto' | 'abstain' | 'did_not_vote'>('all');
const voteSearch = ref('');
const voteFilters = [
  { key: 'all' as const, label: 'All' },
  { key: 'yes' as const, label: 'Yes' },
  { key: 'no' as const, label: 'No' },
  { key: 'veto' as const, label: 'Veto' },
  { key: 'abstain' as const, label: 'Abstain' },
  { key: 'did_not_vote' as const, label: 'Did not vote' },
];

/** Client-side page sizes: keep tables short on mobile/desktop. */
const VAL_PAGE_SIZE = 20;
const OTHER_PAGE_SIZE = 10;
/** Max numbered page buttons, always including the last page (e.g. 1 2 3 4 …99). */
const PAGE_SLOT_MAX = 5;
const valPage = ref(1);
const otherPage = ref(1);

// ---- validator logos (keybase, cached in localStorage) — same as validators/blocks ----
const avatars = ref<Record<string, string>>(JSON.parse(localStorage.getItem('avatars') || '{}'));

function logo(identity?: string) {
  if (!identity || !avatars.value[identity]) return '';
  const url = avatars.value[identity] || '';
  return url.startsWith('http') ? url : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
}

function fetchAvatar(identity: string) {
  return new Promise<void>((resolve) => {
    stakingStore
      .keybase(identity)
      .then((d: any) => {
        if (Array.isArray(d.them) && d.them.length > 0) {
          const uri = String(d.them[0]?.pictures?.primary?.url).replace(
            'https://s3.amazonaws.com/keybase_processed_uploads/',
            ''
          );
          avatars.value[identity] = uri;
        }
        resolve();
      })
      .catch(() => resolve());
  });
}

function loadAvatars(identities: string[]) {
  const ids = identities.filter((id) => id && !avatars.value[id]);
  if (!ids.length) return;
  Promise.all(ids.map((id) => fetchAvatar(id))).then(() =>
    localStorage.setItem('avatars', JSON.stringify(avatars.value))
  );
}

let tallyTimer: ReturnType<typeof setInterval> | null = null;

function bech32DataHex(addr: string): string {
  try {
    return toHex(fromBech32(addr).data);
  } catch {
    return '';
  }
}

function optionLabel(opt?: string | { option?: string }): string {
  if (!opt) return '—';
  const raw = typeof opt === 'string' ? opt : opt.option || '';
  if (!raw) return '—';
  return String(raw).replace('VOTE_OPTION_', '').replace(/_/g, ' ');
}

function primaryOption(v: GovVote): string {
  if (v.option && v.option !== 'VOTE_OPTION_UNSPECIFIED') return v.option;
  if (v.options?.length) {
    const top = [...v.options].sort((a, b) => Number(b.weight) - Number(a.weight))[0];
    return top?.option || '';
  }
  return '';
}

function optionChipClass(opt: string): string {
  switch (opt) {
    case 'VOTE_OPTION_YES':
      return 'sz-chip--ok';
    case 'VOTE_OPTION_NO':
      return 'sz-chip--bad';
    case 'VOTE_OPTION_NO_WITH_VETO':
      return 'sz-chip--bad';
    case 'VOTE_OPTION_ABSTAIN':
      return 'sz-chip--warn';
    default:
      return 'sz-chip--info';
  }
}

function statusChipFor(status: string): string {
  switch (status) {
    case 'PROPOSAL_STATUS_PASSED':
      return 'sz-chip--ok';
    case 'PROPOSAL_STATUS_REJECTED':
    case 'PROPOSAL_STATUS_FAILED':
      return 'sz-chip--bad';
    case 'PROPOSAL_STATUS_VOTING_PERIOD':
      return 'sz-chip--info';
    case 'PROPOSAL_STATUS_DEPOSIT_PERIOD':
      return 'sz-chip--warn';
    default:
      return '';
  }
}

function statusText(status?: string): string {
  if (!status) return '—';
  return status.replace('PROPOSAL_STATUS_', '').replace(/_/g, ' ');
}

function msgTypeOf(content: any): string {
  const t = content?.['@type'] || '';
  if (!t) return '';
  return t.substring(t.lastIndexOf('.') + 1);
}

function metaItem(metadata: string | undefined): { title: string; summary: string } {
  if (!metadata) return { title: '', summary: '' };
  try {
    if (metadata.startsWith('{') && metadata.endsWith('}')) return JSON.parse(metadata);
  } catch {
    /* plain string */
  }
  return { title: metadata, summary: '' };
}

function shortTime(v?: string) {
  return v ? format.toDay(v, 'from') : '';
}

function shortAddr(addr?: string): string {
  if (!addr) return '—';
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function shortTx(hash?: string): string {
  if (!hash) return '—';
  const h = String(hash);
  if (h.length <= 14) return h;
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function voteTimeLabel(ts?: string): string {
  if (!ts) return '—';
  // Prefer relative "from" when formatter available; fall back to short date.
  try {
    const rel = format.toDay(ts, 'from');
    if (rel) return rel;
  } catch {
    /* ignore */
  }
  try {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().replace('T', ' ').replace(/:\d{2}\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
    }
  } catch {
    /* ignore */
  }
  return ts;
}

/**
 * Compact page list: at most PAGE_SLOT_MAX numbers, always includes last page.
 * Examples (current=1, total=99): 1 2 3 4 … 99
 *          (current=50): 1 … 49 50 51 … 99  → still max 5 numbers so: 1 … 49 50 … 99
 *          (current=98): 1 … 96 97 98 99
 */
function pageItems(current: number, total: number): Array<{ type: 'page' | 'ellipsis'; page?: number }> {
  const t = Math.max(1, total | 0);
  const c = Math.min(Math.max(1, current | 0), t);
  if (t <= PAGE_SLOT_MAX) {
    return Array.from({ length: t }, (_, i) => ({ type: 'page' as const, page: i + 1 }));
  }
  // Always show first + last. Fill remaining (PAGE_SLOT_MAX - 2) around current.
  const slots = PAGE_SLOT_MAX - 2; // middle numeric slots
  let start = Math.max(2, c - Math.floor((slots - 1) / 2));
  let end = start + slots - 1;
  if (end > t - 1) {
    end = t - 1;
    start = Math.max(2, end - slots + 1);
  }
  const items: Array<{ type: 'page' | 'ellipsis'; page?: number }> = [{ type: 'page', page: 1 }];
  if (start > 2) items.push({ type: 'ellipsis' });
  for (let p = start; p <= end; p++) items.push({ type: 'page', page: p });
  if (end < t - 1) items.push({ type: 'ellipsis' });
  items.push({ type: 'page', page: t });
  // Deduplicate accidental overlap (e.g. start==1)
  const seen = new Set<number>();
  const out: typeof items = [];
  for (const it of items) {
    if (it.type === 'page') {
      if (!it.page || seen.has(it.page)) continue;
      seen.add(it.page);
    }
    out.push(it);
  }
  return out;
}

const proposalTitle = computed(() => {
  const p = proposal.value;
  if (p?.title) return p.title;
  if (p?.content?.title) return p.content.title;
  if (p?.content?.plan?.name) {
    const t = msgTypeOf(p.content);
    return t ? `${t}: ${p.content.plan.name}` : String(p.content.plan.name);
  }
  const meta = metaItem(p?.metadata);
  return meta.title || `Proposal #${props.proposal_id}`;
});

const proposalSummary = computed(() => {
  const p = proposal.value;
  if (p?.summary) return p.summary;
  if (p?.content?.description) return p.content.description;
  return metaItem(p?.metadata).summary || '';
});

const statusChipClass = computed(() => statusChipFor(proposal.value?.status || ''));
const statusLabel = computed(() => statusText(proposal.value?.status));
const msgTypeLabel = computed(() => msgTypeOf(proposal.value?.content));
const isVoting = computed(() => proposal.value?.status === 'PROPOSAL_STATUS_VOTING_PERIOD');

const totalVoted = computed(() => {
  const tally = proposal.value?.final_tally_result;
  if (!tally) return 0;
  return (
    Number(tally.yes || 0) +
    Number(tally.no || 0) +
    Number(tally.no_with_veto || 0) +
    Number(tally.abstain || 0)
  );
});

const bonded = computed(() => Number(stakingStore.pool?.bonded_tokens || 0) || 1);

const turnoutPct = computed(() => {
  if (totalVoted.value <= 0) return 0;
  return totalVoted.value / bonded.value;
});

const turnoutLabel = computed(() => format.percent(turnoutPct.value));

const optionRows = computed(() => {
  const tally = proposal.value?.final_tally_result || ({} as any);
  const total = totalVoted.value || 1;
  const denom = stakingStore.params?.bond_denom || '';
  const defs = [
    { key: 'yes', name: 'Yes', raw: Number(tally.yes || 0), segClass: 'sz-tally-seg--yes', chipClass: 'sz-chip--ok', barClass: 'bg-success' },
    { key: 'no', name: 'No', raw: Number(tally.no || 0), segClass: 'sz-tally-seg--no', chipClass: 'sz-chip--bad', barClass: 'bg-error' },
    { key: 'veto', name: 'No With Veto', raw: Number(tally.no_with_veto || 0), segClass: 'sz-tally-seg--veto', chipClass: 'sz-chip--bad', barClass: 'bg-red-800' },
    { key: 'abstain', name: 'Abstain', raw: Number(tally.abstain || 0), segClass: 'sz-tally-seg--abstain', chipClass: 'sz-chip--warn', barClass: 'bg-warning' },
  ];
  return defs.map((r) => {
    const pctNum = totalVoted.value > 0 ? (r.raw / total) * 100 : 0;
    return {
      ...r,
      pctNum,
      pct: format.percent(pctNum / 100),
      amountLabel: denom
        ? format.formatToken({ amount: String(Math.trunc(r.raw)), denom }, true, '0,0.00a')
        : format.formatNumber(r.raw, '0,0.00a') || String(r.raw),
    };
  });
});

const votingCountdown = computed((): number => {
  const end = new Date(proposal.value?.voting_end_time || 0).getTime();
  return end - Date.now();
});

const upgradeCountdown = computed((): number => {
  const height = Number(proposal.value?.content?.plan?.height || 0);
  if (height > 0) {
    const current = Number(baseStore.latest?.block?.header?.height || 0);
    const bt = Number((baseStore.blocktime / 1000).toFixed()) || 6;
    return (height - current) * bt * 1000;
  }
  const end = new Date(proposal.value?.content?.plan?.time || '').getTime();
  return end - Date.now();
});

const totalPower = computed(() => {
  if (stakingStore.totalPower) return stakingStore.totalPower;
  return (stakingStore.validators || []).reduce((s, v) => s + Number(v.delegator_shares || 0), 0);
});

const valHexMap = computed(() => {
  const map = new Map<string, Validator>();
  for (const v of stakingStore.validators || []) {
    const hex = bech32DataHex(v.operator_address);
    if (hex) map.set(hex, v);
  }
  return map;
});

type ValVoteRow = {
  operator_address: string;
  moniker: string;
  identity: string;
  vp: number;
  vpPct: number;
  vpLabel: string;
  option: string;
  voted: boolean;
  chipClass: string;
  optionLabel: string;
  txhash: string;
  timestamp: string;
};

/** Empty votes on a closed proposal = pruned LCD index, NOT "nobody voted". */
const votesUnavailable = computed(() => {
  if (votesLoading.value) return false;
  if (allVotes.value.length > 0) return false;
  // During voting period empty can still mean early; only treat closed+tally as pruned.
  if (isVoting.value) return false;
  return totalVoted.value > 0;
});

/** Have real per-voter records to split Yes/No/Did-not-vote. */
const hasVoteRecords = computed(() => allVotes.value.length > 0);

const validatorRows = computed((): ValVoteRow[] => {
  const voteByHex = new Map<string, GovVote>();
  for (const vote of allVotes.value) {
    const hex = bech32DataHex(vote.voter);
    if (hex && valHexMap.value.has(hex)) voteByHex.set(hex, vote);
  }

  // When records are pruned, never invent DID NOT VOTE — that contradicts tally.
  const recordsMissing = votesUnavailable.value || (!hasVoteRecords.value && !votesLoading.value && !isVoting.value);

  const power = totalPower.value || 1;
  const rows: ValVoteRow[] = [];
  for (const [hex, v] of valHexMap.value) {
    const vote = voteByHex.get(hex);
    const opt = vote ? primaryOption(vote) : '';
    const voted = !!vote;
    const vp = Number(v.delegator_shares || v.tokens || 0);
    const vpPct = vp / power;

    let chipClass = 'sz-chip--info';
    let label = '—';
    if (voted) {
      chipClass = optionChipClass(opt);
      label = optionLabel(opt);
    } else if (recordsMissing) {
      chipClass = '';
      label = '—';
    } else if (!votesLoading.value) {
      // Real empty slot only when we actually have a vote index (or live voting).
      chipClass = 'sz-chip--warn';
      label = 'DID NOT VOTE';
    } else {
      chipClass = '';
      label = '…';
    }

    rows.push({
      operator_address: v.operator_address,
      moniker: v.description?.moniker || v.operator_address,
      identity: v.description?.identity || '',
      vp,
      vpPct,
      vpLabel: format.percent(vpPct),
      option: opt,
      voted,
      chipClass,
      optionLabel: label,
      txhash: vote?.txhash || '',
      timestamp: vote?.timestamp || '',
    });
  }
  rows.sort((a, b) => b.vp - a.vp);
  return rows;
});

const otherVotes = computed(() => {
  return allVotes.value
    .filter((vote) => {
      const hex = bech32DataHex(vote.voter);
      return !hex || !valHexMap.value.has(hex);
    })
    .map((vote) => ({
      voter: vote.voter,
      option: primaryOption(vote),
      txhash: vote.txhash || '',
      timestamp: vote.timestamp || '',
    }));
});

const activeVoteFilters = computed(() => {
  // Option filters only make sense when we have per-voter records.
  if (!hasVoteRecords.value) {
    return voteFilters.filter((f) => f.key === 'all');
  }
  return voteFilters;
});

const filteredValidatorRows = computed(() => {
  const q = voteSearch.value.trim().toLowerCase();
  return validatorRows.value.filter((r) => {
    if (hasVoteRecords.value) {
      if (voteFilter.value === 'yes' && r.option !== 'VOTE_OPTION_YES') return false;
      if (voteFilter.value === 'no' && r.option !== 'VOTE_OPTION_NO') return false;
      if (voteFilter.value === 'veto' && r.option !== 'VOTE_OPTION_NO_WITH_VETO') return false;
      if (voteFilter.value === 'abstain' && r.option !== 'VOTE_OPTION_ABSTAIN') return false;
      if (voteFilter.value === 'did_not_vote' && r.voted) return false;
    }
    if (q && !r.moniker.toLowerCase().includes(q) && !r.operator_address.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
});

const valTotalPages = computed(() => Math.max(1, Math.ceil(filteredValidatorRows.value.length / VAL_PAGE_SIZE)));
const pagedValidatorRows = computed(() => {
  const page = Math.min(Math.max(valPage.value, 1), valTotalPages.value);
  const start = (page - 1) * VAL_PAGE_SIZE;
  return filteredValidatorRows.value.slice(start, start + VAL_PAGE_SIZE);
});
const valPageStart = computed(() => {
  if (!filteredValidatorRows.value.length) return 0;
  return (Math.min(valPage.value, valTotalPages.value) - 1) * VAL_PAGE_SIZE;
});

const otherTotalPages = computed(() => Math.max(1, Math.ceil(otherVotes.value.length / OTHER_PAGE_SIZE)));
const pagedOtherVotes = computed(() => {
  const page = Math.min(Math.max(otherPage.value, 1), otherTotalPages.value);
  const start = (page - 1) * OTHER_PAGE_SIZE;
  return otherVotes.value.slice(start, start + OTHER_PAGE_SIZE);
});

function goValPage(p: number) {
  const total = valTotalPages.value;
  valPage.value = Math.min(Math.max(1, Number(p) || 1), total);
}
function nextValPage() {
  if (valPage.value < valTotalPages.value) valPage.value += 1;
}
function prevValPage() {
  if (valPage.value > 1) valPage.value -= 1;
}
function goOtherPage(p: number) {
  const total = otherTotalPages.value;
  otherPage.value = Math.min(Math.max(1, Number(p) || 1), total);
}
function nextOtherPage() {
  if (otherPage.value < otherTotalPages.value) otherPage.value += 1;
}
function prevOtherPage() {
  if (otherPage.value > 1) otherPage.value -= 1;
}

const valPageItems = computed(() =>
  pageItems(Math.min(valPage.value, valTotalPages.value), valTotalPages.value)
);
const otherPageItems = computed(() =>
  pageItems(Math.min(otherPage.value, otherTotalPages.value), otherTotalPages.value)
);

// Prefetch logos for visible validator page + full set identities once
watch(
  pagedValidatorRows,
  (rows) => {
    loadAvatars(rows.map((r) => r.identity).filter(Boolean));
  },
  { immediate: true }
);
watch(
  () => stakingStore.validators?.length || 0,
  () => {
    const ids = (stakingStore.validators || [])
      .map((v) => v.description?.identity || '')
      .filter(Boolean)
      .slice(0, 40);
    loadAvatars(ids);
  },
  { immediate: true }
);

// Reset page when filter/search changes
watch([voteFilter, voteSearch], () => {
  valPage.value = 1;
});
watch(
  () => otherVotes.value.length,
  () => {
    otherPage.value = 1;
  }
);

const votedCount = computed(() => validatorRows.value.filter((r) => r.voted).length);
const didNotVoteCount = computed(() => {
  if (!hasVoteRecords.value) return 0;
  return validatorRows.value.filter((r) => !r.voted).length;
});
const votes = allVotes;
const depositList = deposits;

function addCurrentParams(res: any) {
  if (proposal.value.content && res.params) {
    proposal.value.content.params = [proposal.value.content?.params];
    proposal.value.content.current = [res.params];
  }
}

async function loadParamContext(detail: GovProposal) {
  if (detail.content?.changes) {
    for (const item of detail.content.changes) {
      try {
        const res = await chainStore.rpc.getParams(item.subspace, item.key);
        if (proposal.value.content && res.param) {
          if (proposal.value.content.current) proposal.value.content.current.push(res.param);
          else proposal.value.content.current = [res.param];
        }
      } catch {
        /* ignore */
      }
    }
  }
  const msg = detail.content?.['@type'] || '';
  if (!msg.endsWith('MsgUpdateParams')) return;
  try {
    if (msg.indexOf('staking') > -1) addCurrentParams(await chainStore.rpc.getStakingParams());
    else if (msg.indexOf('gov') > -1) addCurrentParams(await chainStore.rpc.getGovParamsVoting());
    else if (msg.indexOf('distribution') > -1) addCurrentParams(await chainStore.rpc.getDistributionParams());
    else if (msg.indexOf('slashing') > -1) addCurrentParams(await chainStore.rpc.getSlashingParams());
  } catch {
    /* ignore */
  }
}

/**
 * Prefer Shazoes vote-indexer (reconstructs MsgVote from archive tx queries).
 * FE stays on Vercel; indexer is a separate HTTPS API (CORS *).
 * Falls back to LCD /gov/.../votes when indexer empty/unreachable.
 */
/**
 * Default: same-origin `/vote-api` (Vercel rewrite → vote-indexer on VPS).
 * Override with absolute URL via VITE_VOTE_INDEXER_URL if needed.
 * Empty string "" disables indexer (LCD only).
 */
const VOTE_INDEXER_URL = (() => {
  const raw = import.meta.env.VITE_VOTE_INDEXER_URL;
  if (raw === '') return '';
  if (raw == null || raw === undefined) return '/vote-api';
  return String(raw).replace(/\/$/, '');
})();

async function fetchIndexerVotes(proposalId: string): Promise<GovVote[] | null> {
  if (!VOTE_INDEXER_URL) return null;
  const chainKey = String(props.chain || chainStore.chainName || '');
  if (!chainKey) return null;
  try {
    const url =
      `${VOTE_INDEXER_URL}/v1/${encodeURIComponent(chainKey)}/proposals/` +
      `${encodeURIComponent(proposalId)}/votes?limit=10000`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const votes = (data?.votes || []) as GovVote[];
    if (!votes.length) return null;
    return votes;
  } catch {
    return null;
  }
}

async function fetchAllVotes(proposalId: string): Promise<GovVote[]> {
  // 1) Indexer first (closed proposals where LCD vote store is pruned)
  const indexed = await fetchIndexerVotes(proposalId);
  if (indexed && indexed.length > 0) return indexed;

  // 2) Native LCD pagination
  const all: GovVote[] = [];
  const pr = new PageRequest();
  pr.limit = 100;
  pr.count_total = true;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await store.fetchProposalVotes(proposalId, pr);
      const batch = res?.votes || [];
      all.push(...batch);
      const next = res?.pagination?.next_key;
      if (!next || batch.length === 0 || batch.length < pr.limit) break;
      pr.key = next;
      pr.offset = undefined;
    } catch {
      break;
    }
  }
  return all;
}

function normalizeTally(raw: any) {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    yes: raw.yes ?? raw.yes_count ?? '0',
    no: raw.no ?? raw.no_count ?? '0',
    no_with_veto: raw.no_with_veto ?? raw.no_with_veto_count ?? '0',
    abstain: raw.abstain ?? raw.abstain_count ?? '0',
  };
}

function normalizeProposal(raw: any): GovProposal {
  if (!raw) return raw;
  const p: any = { ...raw };
  // gov v1 uses id; keep proposal_id for template/links
  if (!p.proposal_id && p.id != null) p.proposal_id = String(p.id);
  if (p.messages?.length && !p.content) {
    p.content = p.messages[0].content || p.messages[0];
  }
  if (p.final_tally_result) p.final_tally_result = normalizeTally(p.final_tally_result);
  return p as GovProposal;
}

async function waitForRpc(timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (chainStore.rpc && typeof (chainStore.rpc as any).getGovProposal === 'function') {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return !!(chainStore.rpc && typeof (chainStore.rpc as any).getGovProposal === 'function');
}

async function refreshTally() {
  try {
    const tallRes = await store.fetchTally(props.proposal_id);
    if (tallRes?.tally && proposal.value) {
      proposal.value.final_tally_result = normalizeTally(tallRes.tally) as any;
    }
  } catch {
    /* ignore */
  }
}

async function loadProposal() {
  loading.value = true;
  try {
    const ready = await waitForRpc();
    if (!ready) return;

    if (!stakingStore.validators?.length) {
      await stakingStore.fetchAcitveValdiators().catch(() => null);
    }
    if (!stakingStore.pool?.bonded_tokens) {
      await stakingStore.fetchPool().catch(() => null);
    }
    if (!stakingStore.params?.bond_denom) {
      await stakingStore.fetchParams().catch(() => null);
    }

    const res = await store.fetchProposal(props.proposal_id);
    if (!res?.proposal) return;
    const detail = reactive(normalizeProposal(res.proposal)) as GovProposal;

    // Live tally for voting period; also fill if final_tally is empty/zero on closed proposals
    const needLiveTally =
      detail?.status === 'PROPOSAL_STATUS_VOTING_PERIOD' ||
      !(
        Number(detail?.final_tally_result?.yes || 0) +
        Number(detail?.final_tally_result?.no || 0) +
        Number(detail?.final_tally_result?.no_with_veto || 0) +
        Number(detail?.final_tally_result?.abstain || 0)
      );
    if (needLiveTally) {
      try {
        const tallRes = await store.fetchTally(props.proposal_id);
        if (tallRes?.tally) detail.final_tally_result = normalizeTally(tallRes.tally) as any;
      } catch {
        /* keep final_tally_result */
      }
    }
    proposal.value = detail;
    await loadParamContext(detail);
  } catch (e) {
    console.warn('[gov] loadProposal failed', e);
  } finally {
    loading.value = false;
  }
}

async function loadVotesAndDeposits() {
  votesLoading.value = true;
  try {
    const ready = await waitForRpc();
    if (!ready) return;
    const [voteList, dep] = await Promise.all([
      fetchAllVotes(props.proposal_id),
      store.fetchProposalDeposits(props.proposal_id).catch(() => null),
    ]);
    allVotes.value = voteList;
    const list = (dep as any)?.deposits;
    deposits.value = Array.isArray(list) ? list : list ? [list] : [];
  } catch (e) {
    console.warn('[gov] loadVotesAndDeposits failed', e);
  } finally {
    votesLoading.value = false;
  }
}

function startTallyPoll() {
  stopTallyPoll();
  if (!isVoting.value) return;
  tallyTimer = setInterval(() => {
    refreshTally();
  }, 15000);
}

function stopTallyPoll() {
  if (tallyTimer) {
    clearInterval(tallyTimer);
    tallyTimer = null;
  }
}

async function bootstrap() {
  stopTallyPoll();
  allVotes.value = [];
  voteFilter.value = 'all';
  voteSearch.value = '';
  valPage.value = 1;
  otherPage.value = 1;
  await loadProposal();
  await loadVotesAndDeposits();
  startTallyPoll();
}

watch(
  () => props.proposal_id,
  () => {
    bootstrap();
  }
);

// Retry once RPC becomes available (first paint often races chain connect)
watch(
  () => chainStore.endpoint?.address,
  (addr, prev) => {
    if (addr && addr !== prev) bootstrap();
  }
);

onMounted(() => {
  bootstrap();
});

onUnmounted(() => stopTallyPoll());
</script>

<template>
  <div class="gov-detail">
    <!-- HERO -->
    <div class="sz-page-head">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-1.5">
          <span class="sz-chip font-mono !text-[11px]">#{{ proposal_id }}</span>
          <span class="sz-chip" :class="statusChipClass">{{ statusLabel }}</span>
          <span v-if="msgTypeLabel" class="sz-msg">{{ msgTypeLabel }}</span>
        </div>
        <h1 class="sz-page-title break-words">{{ proposalTitle }}</h1>
        <div class="sz-page-sub mt-1">
          <span v-if="proposal.submit_time">Submitted {{ format.toDay(proposal.submit_time, 'from') }}</span>
          <span v-if="proposal.voting_end_time"> · Ends {{ format.toDay(proposal.voting_end_time) }}</span>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 shrink-0">
        <label
          for="vote"
          class="btn btn-primary btn-sm"
          @click="dialog.open('vote', { proposal_id })"
        >{{ $t('gov.btn_vote') }}</label>
        <label
          for="deposit"
          class="btn btn-outline btn-sm"
          @click="dialog.open('deposit', { proposal_id })"
        >{{ $t('gov.btn_deposit') }}</label>
      </div>
    </div>

    <!-- TALLY + TIMELINE -->
    <div class="grid gap-4 mb-4 lg:!grid-cols-5">
      <!-- Tally -->
      <div class="sz-section lg:!col-span-3 overflow-hidden">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Result</div>
            <div class="sz-section-title">{{ $t('gov.tally') }}</div>
          </div>
          <div class="text-right">
            <div class="sz-metric-label">Turnout</div>
            <div class="font-mono text-lg font-bold tabular">{{ turnoutLabel }}</div>
          </div>
        </div>
        <div class="p-4">
          <!-- segmented stack -->
          <div class="sz-tally-stack mb-4">
            <div
              v-for="opt in optionRows"
              :key="opt.key"
              class="sz-tally-seg"
              :class="opt.segClass"
              :style="{ width: opt.pctNum + '%' }"
              :title="opt.name + ' ' + opt.pct"
            ></div>
          </div>

          <div class="space-y-2.5">
            <div
              v-for="opt in optionRows"
              :key="opt.key"
              class="flex items-center gap-3"
            >
              <span class="sz-chip !text-[10px] w-16 justify-center" :class="opt.chipClass">{{ opt.name }}</span>
              <div class="flex-1 h-1.5 rounded-full bg-base-content/10 overflow-hidden">
                <div class="h-full rounded-full" :class="opt.barClass" :style="{ width: opt.pctNum + '%' }"></div>
              </div>
              <span class="font-mono text-[12.5px] font-semibold w-14 text-right tabular">{{ opt.pct }}</span>
              <span class="font-mono text-[11px] text-secondary w-28 text-right truncate tabular">{{ opt.amountLabel }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Timeline -->
      <div class="sz-section lg:!col-span-2 overflow-hidden">
        <div class="sz-section-head">
          <div>
            <div class="sz-section-kicker">Schedule</div>
            <div class="sz-section-title">{{ $t('gov.timeline') }}</div>
          </div>
        </div>
        <div class="p-4 space-y-3.5">
          <div class="flex items-start gap-3">
            <div class="w-2 h-2 rounded-full bg-error mt-1.5 shrink-0"></div>
            <div class="min-w-0 flex-1">
              <div class="text-[12px] text-secondary">{{ $t('gov.submit_at') }}</div>
              <div class="text-[13px] font-medium">{{ format.toDay(proposal.submit_time) }}</div>
            </div>
            <div class="text-[11px] text-secondary shrink-0">{{ shortTime(proposal.submit_time) }}</div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0"></div>
            <div class="min-w-0 flex-1">
              <div class="text-[12px] text-secondary">{{ $t('gov.deposited_at') }}</div>
              <div class="text-[13px] font-medium">
                {{
                  format.toDay(
                    proposal.status === 'PROPOSAL_STATUS_DEPOSIT_PERIOD'
                      ? proposal.deposit_end_time
                      : proposal.voting_start_time
                  )
                }}
              </div>
            </div>
            <div class="text-[11px] text-secondary shrink-0">
              {{
                shortTime(
                  proposal.status === 'PROPOSAL_STATUS_DEPOSIT_PERIOD'
                    ? proposal.deposit_end_time
                    : proposal.voting_start_time
                )
              }}
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-2 h-2 rounded-full bg-yes mt-1.5 shrink-0"></div>
            <div class="min-w-0 flex-1">
              <div class="text-[12px] text-secondary">{{ $t('gov.vote_start_from') }}</div>
              <div class="text-[13px] font-medium">{{ format.toDay(proposal.voting_start_time) }}</div>
              <div v-if="isVoting" class="mt-1.5">
                <Countdown :time="votingCountdown" />
              </div>
            </div>
            <div class="text-[11px] text-secondary shrink-0">{{ shortTime(proposal.voting_start_time) }}</div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-2 h-2 rounded-full bg-success mt-1.5 shrink-0"></div>
            <div class="min-w-0 flex-1">
              <div class="text-[12px] text-secondary">{{ $t('gov.vote_end') }}</div>
              <div class="text-[13px] font-medium">{{ format.toDay(proposal.voting_end_time) }}</div>
              <div class="text-[11px] text-secondary mt-0.5">
                {{ $t('gov.current_status') }}:
                <span class="font-semibold text-main">{{ statusLabel }}</span>
              </div>
            </div>
            <div class="text-[11px] text-secondary shrink-0">{{ shortTime(proposal.voting_end_time) }}</div>
          </div>
          <div
            v-if="proposal?.content?.['@type']?.endsWith('SoftwareUpgradeProposal') || proposal?.content?.['@type']?.endsWith('MsgSoftwareUpgrade')"
            class="flex items-start gap-3 pt-1 border-t border-base-content/10"
          >
            <div class="w-2 h-2 rounded-full bg-warning mt-1.5 shrink-0"></div>
            <div class="min-w-0 flex-1">
              <div class="text-[12px] text-secondary">{{ $t('gov.upgrade_plan') }}</div>
              <div class="text-[13px] font-medium">
                <span v-if="Number(proposal.content?.plan?.height || '0') > 0">
                  Height #{{ proposal.content?.plan?.height }} (EST)
                </span>
                <span v-else>{{ format.toDay(proposal.content?.plan?.time) }}</span>
              </div>
              <div class="mt-1.5">
                <Countdown :time="upgradeCountdown" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- CONTENT -->
    <div class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Proposal</div>
          <div class="sz-section-title">Content</div>
        </div>
      </div>
      <div class="p-4">
        <div v-if="proposal.content" class="mb-3">
          <ObjectElement :value="proposal.content" />
        </div>
        <div v-if="proposalSummary">
          <MdEditor
            :model-value="format.multiLine(proposalSummary)"
            previewOnly
            class="md-editor-recover"
          />
        </div>
      </div>
    </div>

    <!-- VALIDATOR VOTES -->
    <div class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head flex-wrap">
        <div>
          <div class="sz-section-kicker">Active set</div>
          <div class="sz-section-title">
            Validator votes
            <span class="font-mono text-secondary text-sm font-normal ml-1">
              {{ validatorRows.length }}
            </span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div v-if="hasVoteRecords" class="sz-tabs !p-0.5">
            <a
              v-for="f in activeVoteFilters"
              :key="f.key"
              class="sz-tab !px-2.5 !py-1 !text-[11px]"
              :class="{ 'sz-tab--active': voteFilter === f.key }"
              @click="voteFilter = f.key"
            >{{ f.label }}</a>
          </div>
          <input
            v-model="voteSearch"
            type="search"
            placeholder="Search moniker"
            class="input input-sm input-bordered w-36 font-normal"
          />
        </div>
      </div>

      <!-- honest empty / pruned banner — do NOT imply validators skipped voting -->
      <div v-if="votesUnavailable" class="mx-4 mt-3 mb-1 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-secondary">
        <b class="text-main">Per-validator votes unavailable</b> on this LCD (pruned / not indexed).
        Tally above is the on-chain result — rows below list the active set + VP only; vote option is unknown, not “did not vote”.
      </div>

      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th style="width: 3rem">#</th>
              <th>Validator</th>
              <th class="text-right">VP %</th>
              <th class="text-center">Vote</th>
              <th>Tx Hash</th>
              <th class="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="filteredValidatorRows.length === 0">
              <td colspan="6" class="text-center text-secondary py-8 text-sm">
                {{
                  votesLoading
                    ? 'Loading votes…'
                    : votesUnavailable
                      ? 'Active set loading…'
                      : 'No validators match this filter.'
                }}
              </td>
            </tr>
            <tr v-for="(row, i) in pagedValidatorRows" :key="row.operator_address">
              <td>
                <span class="sz-chip font-mono !text-[10px]">{{ valPageStart + i + 1 }}</span>
              </td>
              <td>
                <div class="flex items-center gap-2 min-w-0">
                  <div class="h-7 w-7 shrink-0 overflow-hidden rounded-full bg-base-200 ring-1 ring-base-content/10">
                    <img
                      v-if="logo(row.identity)"
                      :src="logo(row.identity)"
                      class="h-full w-full object-cover"
                      alt=""
                      @error="() => { if (row.identity) fetchAvatar(row.identity).then(() => localStorage.setItem('avatars', JSON.stringify(avatars))); }"
                    />
                    <div
                      v-else
                      class="flex h-full w-full items-center justify-center text-[10px] font-semibold text-secondary"
                    >
                      {{ (row.moniker || '?').slice(0, 1).toUpperCase() }}
                    </div>
                  </div>
                  <RouterLink
                    :to="`/${chain}/validator/${row.operator_address}`"
                    class="text-[13px] font-semibold text-primary no-underline hover:underline truncate max-w-[12rem] sm:max-w-xs"
                  >
                    {{ row.moniker }}
                  </RouterLink>
                </div>
              </td>
              <td class="text-right">
                <span class="font-mono text-[12.5px] tabular">{{ row.vpLabel }}</span>
              </td>
              <td class="text-center">
                <span class="sz-chip !text-[10px]" :class="row.chipClass">{{ row.optionLabel }}</span>
              </td>
              <td>
                <RouterLink
                  v-if="row.txhash"
                  :to="`/${chain}/tx/${row.txhash}`"
                  class="sz-hash link link-hover text-primary font-mono text-[11.5px]"
                  :title="row.txhash"
                >
                  {{ shortTx(row.txhash) }}
                </RouterLink>
                <span v-else class="text-secondary font-mono text-[11.5px]">—</span>
              </td>
              <td class="text-right">
                <span class="font-mono text-[11.5px] text-secondary whitespace-nowrap" :title="row.timestamp || ''">
                  {{ voteTimeLabel(row.timestamp) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="px-4 py-2.5 border-t border-base-content/10 flex flex-wrap items-center gap-3 text-[11.5px] text-secondary">
        <span>Active set <b class="font-mono text-main">{{ validatorRows.length }}</b></span>
        <span v-if="filteredValidatorRows.length">
          Showing
          <b class="font-mono text-main">{{ valPageStart + 1 }}–{{ valPageStart + pagedValidatorRows.length }}</b>
          of
          <b class="font-mono text-main">{{ filteredValidatorRows.length }}</b>
        </span>
        <template v-if="hasVoteRecords">
          <span>Voted <b class="font-mono text-main">{{ votedCount }}</b></span>
          <span>Did not vote <b class="font-mono text-main">{{ didNotVoteCount }}</b></span>
          <span>Records <b class="font-mono text-main">{{ votes.length }}</b></span>
        </template>
        <span v-else-if="votesUnavailable">Vote options unknown (index pruned)</span>
        <span v-else-if="votesLoading">Loading vote records…</span>
        <div v-if="valTotalPages > 1" class="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            class="btn btn-xs btn-ghost"
            :disabled="valPage <= 1"
            @click.stop.prevent="prevValPage"
          >Prev</button>
          <template v-for="(it, idx) in valPageItems" :key="'vp-' + idx + '-' + (it.page || 'e')">
            <span v-if="it.type === 'ellipsis'" class="px-1 font-mono text-secondary select-none">…</span>
            <button
              v-else
              type="button"
              class="btn btn-xs min-w-[1.75rem] font-mono tabular"
              :class="Math.min(valPage, valTotalPages) === it.page ? 'btn-primary' : 'btn-ghost'"
              @click.stop.prevent="goValPage(it.page!)"
            >{{ it.page }}</button>
          </template>
          <button
            type="button"
            class="btn btn-xs btn-primary"
            :disabled="valPage >= valTotalPages"
            @click.stop.prevent="nextValPage"
          >Next</button>
        </div>
      </div>
    </div>

    <!-- OTHER VOTES (non-validator) -->
    <div
      v-if="otherVotes.length > 0 || votesUnavailable || (!votesLoading && hasVoteRecords)"
      class="sz-section mb-4 overflow-hidden"
    >
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Delegators</div>
          <div class="sz-section-title">
            Other votes
            <span class="font-mono text-secondary text-sm font-normal ml-1">{{ otherVotes.length }}</span>
          </div>
        </div>
      </div>

      <div v-if="votesUnavailable" class="px-4 py-6 text-[12.5px] leading-relaxed text-secondary">
        Non-validator voter list needs the same per-vote index as above.
        This LCD returned <span class="font-mono text-main">0</span> vote records for a closed proposal
        (tally still shows real turnout). No address-level Yes/No split is available from public REST.
      </div>

      <div v-else-if="otherVotes.length === 0" class="px-4 py-6 text-center text-sm text-secondary">
        No non-validator votes in the returned set — all records matched bonded validators, or none yet.
      </div>

      <div v-else class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th>Address</th>
              <th class="text-center">Vote</th>
              <th>Tx Hash</th>
              <th class="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in pagedOtherVotes" :key="item.voter">
              <td>
                <RouterLink
                  :to="`/${chain}/account/${item.voter}`"
                  class="sz-hash link link-hover text-primary"
                >
                  {{ shortAddr(item.voter) }}
                </RouterLink>
              </td>
              <td class="text-center">
                <span class="sz-chip !text-[10px]" :class="optionChipClass(item.option)">
                  {{ optionLabel(item.option) }}
                </span>
              </td>
              <td>
                <RouterLink
                  v-if="item.txhash"
                  :to="`/${chain}/tx/${item.txhash}`"
                  class="sz-hash link link-hover text-primary font-mono text-[11.5px]"
                  :title="item.txhash"
                >
                  {{ shortTx(item.txhash) }}
                </RouterLink>
                <span v-else class="text-secondary font-mono text-[11.5px]">—</span>
              </td>
              <td class="text-right">
                <span class="font-mono text-[11.5px] text-secondary whitespace-nowrap" :title="item.timestamp || ''">
                  {{ voteTimeLabel(item.timestamp) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div
          v-if="otherTotalPages > 1"
          class="px-4 py-2.5 border-t border-base-content/10 flex flex-wrap items-center gap-3 text-[11.5px] text-secondary"
        >
          <span>
            Showing
            <b class="font-mono text-main">{{ (Math.min(otherPage, otherTotalPages) - 1) * OTHER_PAGE_SIZE + 1 }}–{{ (Math.min(otherPage, otherTotalPages) - 1) * OTHER_PAGE_SIZE + pagedOtherVotes.length }}</b>
            of
            <b class="font-mono text-main">{{ otherVotes.length }}</b>
          </span>
          <div class="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              :disabled="otherPage <= 1"
              @click.stop.prevent="prevOtherPage"
            >Prev</button>
            <template v-for="(it, idx) in otherPageItems" :key="'op-' + idx + '-' + (it.page || 'e')">
              <span v-if="it.type === 'ellipsis'" class="px-1 font-mono text-secondary select-none">…</span>
              <button
                v-else
                type="button"
                class="btn btn-xs min-w-[1.75rem] font-mono tabular"
                :class="Math.min(otherPage, otherTotalPages) === it.page ? 'btn-primary' : 'btn-ghost'"
                @click.stop.prevent="goOtherPage(it.page!)"
              >{{ it.page }}</button>
            </template>
            <button
              type="button"
              class="btn btn-xs btn-primary"
              :disabled="otherPage >= otherTotalPages"
              @click.stop.prevent="nextOtherPage"
            >Next</button>
          </div>
        </div>
      </div>
    </div>

    <!-- DEPOSITS -->
    <div class="sz-section mb-4 overflow-hidden">
      <div class="sz-section-head">
        <div>
          <div class="sz-section-kicker">Funding</div>
          <div class="sz-section-title">
            Deposits
            <span class="font-mono text-secondary text-sm font-normal ml-1">
              {{ depositList.length }}
            </span>
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th>Depositor</th>
              <th class="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="depositList.length === 0">
              <td colspan="2" class="text-center text-secondary py-6 text-sm">No deposits recorded.</td>
            </tr>
            <tr v-for="(d, i) in depositList" :key="i">
              <td>
                <RouterLink
                  :to="`/${chain}/account/${d.depositor}`"
                  class="sz-hash link link-hover text-primary"
                >
                  {{ shortAddr(d.depositor) }}
                </RouterLink>
              </td>
              <td class="text-right font-mono text-[12.5px] tabular">
                {{ format.formatTokens(d.amount) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sz-tally-stack {
  display: flex;
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, hsl(var(--bc)) 8%, transparent);
}
.sz-tally-seg {
  height: 100%;
  min-width: 0;
  transition: width 0.3s ease;
}
.sz-tally-seg--yes { background: #10b981; }
.sz-tally-seg--no { background: #ef4444; }
.sz-tally-seg--veto { background: #991b1b; }
.sz-tally-seg--abstain { background: #f59e0b; }
</style>
