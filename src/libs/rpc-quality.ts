/**
 * Shared RPC quality ranking — single source of truth for endpoint pick.
 *
 * Used by:
 *   - useBlockchain (block/tx/dashboard/startup/fallback)
 *   - consensus page (validator set + tip)
 *
 * Rule: never trust config order or localStorage alone. Prefer fully-synced
 * peers at tip height. A lagging node can return HTTP 200 with a tiny
 * historical validator set (e.g. 2-of-89) and look "healthy" to naive checks.
 */
import type { Endpoint } from '@/types/chaindata';

export type RpcQuality = {
  address: string;
  provider?: string;
  ok: boolean;
  height: number;
  catchingUp: boolean;
  /** TM2 `/validators` size when probed; 0 if unknown / Cosmos LCD path */
  valCount: number;
  score: number;
  reason?: string;
};

function baseOf(addr?: string) {
  return String(addr || '').replace(/\/+$/, '');
}

export function lagTolerance(tipMax: number): number {
  return Math.max(500, Math.floor(tipMax * 0.01));
}

/** Keep peers within lag of the best tip; sort by valCount then height. */
export function pickTipPeers(ranked: RpcQuality[]): RpcQuality[] {
  const healthy = ranked.filter((r) => r.ok);
  if (!healthy.length) return [];
  const tipMax = healthy.reduce((m, r) => Math.max(m, r.height), 0);
  const tol = lagTolerance(tipMax);
  const tip = healthy.filter((r) => tipMax - r.height <= tol);
  tip.sort((a, b) => b.valCount - a.valCount || b.height - a.height || b.score - a.score);
  return tip;
}

export function qualityToEndpoint(q: RpcQuality): Endpoint {
  return { address: q.address, provider: q.provider };
}

type ProbeOpts = {
  /** gno/tm2 → /status + /validators; else Cosmos LCD latest block */
  engine?: string;
  timeoutMs?: number;
  /**
   * Force the probe transport instead of inferring it from `engine`.
   *
   * `'tm'`  → Tendermint JSON-RPC (`/status` + `/validators`)
   * `'lcd'` → Cosmos REST/LCD (`/cosmos/base/tendermint/v1beta1/blocks/latest`)
   *
   * Needed because a Cosmos SDK chain has BOTH transports, on different hosts.
   * A Tendermint RPC answers 404 for the LCD path, so probing an RPC list with
   * the LCD default marks every healthy RPC `ok: false` — the ranking then has
   * no tip/lag signal at all. Callers that rank an RPC pool (consensus monitor)
   * must pass `probe: 'tm'`. Callers that rank a REST pool (useBlockchain)
   * keep the default and are unaffected.
   */
  probe?: 'tm' | 'lcd';
};

async function probeOne(ep: Endpoint, opts: ProbeOpts): Promise<RpcQuality> {
  const address = baseOf(ep.address);
  const provider = ep.provider;
  const base: RpcQuality = {
    address,
    provider,
    ok: false,
    height: 0,
    catchingUp: true,
    valCount: 0,
    score: -1,
  };
  if (!address) return { ...base, reason: 'empty-address' };

  const timeoutMs = opts.timeoutMs ?? 4500;
  // `probe` wins when set; otherwise fall back to engine inference (legacy behaviour).
  const useTm = opts.probe ? opts.probe === 'tm' : opts.engine === 'gno' || opts.engine === 'tm2';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (useTm) {
      const [stRes, valRes] = await Promise.all([
        fetch(`${address}/status`, { signal: controller.signal }),
        fetch(`${address}/validators?per_page=100&page=1`, { signal: controller.signal }),
      ]);
      clearTimeout(timer);
      if (!stRes.ok) {
        return { ...base, reason: `http-${stRes.status}` };
      }
      const st = await stRes.json();
      const si = st?.result?.sync_info || {};
      const height = Number(si.latest_block_height || 0);
      const catchingUp = si.catching_up === true;
      const network = st?.result?.node_info?.network;
      let valCount = 0;
      if (valRes.ok) {
        try {
          const val = await valRes.json();
          const vals = val?.result?.validators || [];
          const total = Number(val?.result?.total ?? vals.length) || vals.length;
          valCount = Math.max(total, vals.length);
        } catch {
          /* ignore val parse */
        }
      }
      if (catchingUp) {
        return { ...base, height, catchingUp, valCount, reason: 'catching-up' };
      }
      if (!height || !network) {
        return { ...base, height, catchingUp, valCount, reason: 'bad-status' };
      }
      // height dominates; larger valset breaks ties (full committee >> lag set of 2)
      const score = height * 1000 + valCount;
      return {
        address,
        provider,
        ok: true,
        height,
        catchingUp: false,
        valCount,
        score,
      };
    }

    // Cosmos SDK LCD
    const url = `${address}/cosmos/base/tendermint/v1beta1/blocks/latest`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ...base, catchingUp: false, reason: `http-${res.status}` };
    const data = await res.json();
    const height = Number(data?.block?.header?.height || 0);
    if (!height) return { ...base, catchingUp: false, reason: 'bad-payload' };
    return {
      address,
      provider,
      ok: true,
      height,
      catchingUp: false,
      valCount: 0,
      score: height * 1000,
    };
  } catch {
    // A browser CORS failure is endpoint-local. Do not let one blocked peer
    // make the whole chain look offline; rankRpcs still keeps other peers.
    return { ...base, reason: 'cors-or-timeout' };
  }
}

/**
 * Probe all endpoints in parallel; return sorted best→worst (ok first by score).
 */
export async function rankRpcs(endpoints: Endpoint[], opts: ProbeOpts = {}): Promise<RpcQuality[]> {
  const list = (endpoints || []).filter((e) => e?.address);
  if (!list.length) return [];
  const results = await Promise.all(list.map((ep) => probeOne(ep, opts)));
  return results.sort((a, b) => b.score - a.score);
}

/** Dedupe rpc + rest + optional extra by address. */
export function mergeEndpointLists(...lists: (Endpoint[] | undefined)[]): Endpoint[] {
  const seen = new Set<string>();
  const out: Endpoint[] = [];
  for (const list of lists) {
    for (const ep of list || []) {
      const b = baseOf(ep?.address);
      if (!b || seen.has(b)) continue;
      seen.add(b);
      out.push({ address: b, provider: ep.provider });
    }
  }
  return out;
}
