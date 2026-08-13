/**
 * gov.ts — Gnoland GovDAO proposal data layer.
 *
 * Source: realm gno.land/r/gov/dao, scraped independently by gno-valopers.
 * The deployed explorer consumes the chain-scoped JSON artifact from
 * `/data/gno-valopers/testnet/sapphire-1/gov.json`.
 *
 * Load order:
 *   1. chain-scoped runtime artifact (freshest deployment snapshot)
 *   2. bundled seed (gov-data.json) — keeps the page alive if the artifact
 *      is unavailable.
 */
import seed from './gov-data.json';

// ---- types ----
export interface GnoValidatorUpdate {
  address: string;
  action: 'add' | 'remove' | 'update' | 'change' | string;
  power: number | null;
}
export interface GnoGovVoter {
  address: string;
  vote: 'YES' | 'NO' | 'ABSTAIN' | string;
  /** Eligible tier the voter voted under (T1/T2/T3). */
  tier?: string;
  /** VPPM — voting power (tier weight) at vote time. */
  voting_power?: number | null;
}
export interface GnoGovProposal {
  proposal_id: number;
  title: string;
  author_address: string | null;
  status: 'ACCEPTED' | 'REJECTED' | 'ACTIVE' | string;
  eligible_tiers: string[];
  yes_percent: number | null;
  no_percent: number | null;
  abstain_percent: number | null;
  description: string;
  validator_updates: GnoValidatorUpdate[];
  voters: GnoGovVoter[];
}
export interface GnoGovData {
  source: {
    chain_id: string;
    realm_path: string;
    gnoweb_base?: string;
    scraped_at: string;
    page_count?: number;
    proposal_count: number;
    latest_proposal_id: number | null;
  };
  status_counts: { active: number; accepted: number; rejected: number; unknown: number };
  proposals: GnoGovProposal[];
}

/** Coerce arbitrary parsed JSON into a safe GnoGovData shape. */
function normalize(raw: any): GnoGovData | null {
  if (!raw || !Array.isArray(raw.proposals)) return null;
  const proposals: GnoGovProposal[] = raw.proposals
    .filter((p: any) => p && typeof p.proposal_id !== 'undefined')
    .map((p: any) => ({
      proposal_id: Number(p.proposal_id),
      title: String(p.title || `Proposal #${p.proposal_id}`),
      author_address: p.author_address ? String(p.author_address) : null,
      status: String(p.status || 'UNKNOWN').toUpperCase(),
      eligible_tiers: Array.isArray(p.eligible_tiers) ? p.eligible_tiers.map(String) : [],
      yes_percent: p.yes_percent == null ? null : Number(p.yes_percent),
      no_percent: p.no_percent == null ? null : Number(p.no_percent),
      abstain_percent: p.abstain_percent == null ? null : Number(p.abstain_percent),
      description: String(p.description || ''),
      validator_updates: Array.isArray(p.validator_updates)
        ? p.validator_updates.map((u: any) => ({
            address: String(u.address || ''),
            action: String(u.action || 'update'),
            power: u.power == null ? null : Number(u.power),
          }))
        : [],
      voters: Array.isArray(p.voters)
        ? p.voters.map((v: any) => ({
            address: String(v.address || ''),
            vote: String(v.vote || ''),
            tier: v.tier ? String(v.tier) : undefined,
            voting_power: v.voting_power == null ? null : Number(v.voting_power),
          }))
        : [],
    }));
  const counts = { active: 0, accepted: 0, rejected: 0, unknown: 0 };
  for (const p of proposals) {
    if (p.status === 'ACCEPTED') counts.accepted++;
    else if (p.status === 'REJECTED') counts.rejected++;
    else if (p.status === 'ACTIVE') counts.active++;
    else counts.unknown++;
  }
  return {
    source: {
      chain_id: String(raw.source?.chain_id || 'sapphire-1'),
      realm_path: String(raw.source?.realm_path || 'gno.land/r/gov/dao'),
      gnoweb_base: raw.source?.gnoweb_base,
      scraped_at: String(raw.source?.scraped_at || ''),
      proposal_count: proposals.length,
      latest_proposal_id: proposals.length ? Math.max(...proposals.map((p) => p.proposal_id)) : null,
    },
    status_counts: counts,
    proposals: proposals.sort((a, b) => b.proposal_id - a.proposal_id),
  };
}

const SEED = normalize(seed) as GnoGovData;

/** Derive the chain-scoped governance JSON URL from the valopers URL. */
export function govLiveUrl(valopersLiveUrl?: string): string | null {
  if (!valopersLiveUrl) return null;
  // Runtime artifacts are same-origin and chain-scoped. Keep this strict so a
  // malformed config cannot turn the browser into an arbitrary fetch proxy.
  if (valopersLiveUrl.startsWith('/') && !valopersLiveUrl.startsWith('//')) {
    return valopersLiveUrl.replace(/\/valopers\.json(?:\?.*)?$/i, '/gov.json');
  }
  if (!/^https:\/\//i.test(valopersLiveUrl)) return null;
  try {
    const u = new URL(valopersLiveUrl);
    return `${u.origin}${u.pathname.replace(/\/valopers\.json(?:\?.*)?$/i, '/gov.json')}`;
  } catch {
    return null;
  }
}

export interface GnoGovResult {
  data: GnoGovData;
  /** true when served from the live static host, false when bundled seed. */
  live: boolean;
}

/**
 * Load GovDAO proposals. Tries the live static JSON first (fresh), falls back
 * to the bundled seed so the page never renders empty.
 */
export async function loadGnoGov(valopersLiveUrl?: string): Promise<GnoGovResult> {
  const url = govLiveUrl(valopersLiveUrl);
  if (url) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
        cache: 'no-store',
      });
      if (res.ok) {
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html')) throw new Error('governance artifact returned HTML');
        const fresh = normalize(await res.json());
        if (fresh && fresh.source.chain_id === 'sapphire-1') return { data: fresh, live: true };
      }
    } catch {
      /* static host down / not wired yet → seed */
    }
  }
  return { data: SEED, live: false };
}

/** The bundled seed (synchronous access for instant first paint). */
export function govSeed(): GnoGovData {
  return SEED;
}

/** Proposal kind — valset change vs sys/users registration vs other. */
export function proposalKind(p: GnoGovProposal): 'valset' | 'register' | 'other' {
  const t = p.title.toLowerCase();
  if (/register user|sys\/users/.test(t)) return 'register';
  if (/validator|valset|valoper/.test(t) || p.validator_updates.length) return 'valset';
  return 'other';
}
