/**
 * Gnoland valoper registry — bundled seed + live JSON refresh.
 *
 * Identity model:
 *   - operatorAddress = stable registration id (almost never changes)
 *   - signingAddress / pubkey = mutable (UpdateSigningKey)
 *   - moniker / description = mutable (UpdateDescription)
 *
 * Live source (preferred, no git/deploy):
 *   https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json
 *   (nginx static location on the same RPC host; CORS *)
 *
 * Fallbacks:
 *   1) chain config `valopers_live_url`
 *   2) same-origin `/data/gno-valopers.json` (self-host explorer / local)
 *   3) bundled `valopers-data.ts` (cold start only)
 *
 * Cron on this box scrapes r/gnops/valopers → writes the JSON file.
 * After RPC static is live, auto-commit of the TS bundle is optional.
 */
import staticRegistry from './valopers-data';
import type { GnoValoperRow } from './valopers-data';

export type GnoValoper = GnoValoperRow;

const bySigning = new Map<string, GnoValoper>();
const byOperator = new Map<string, GnoValoper>();

/** Default public URL on our Gno RPC vhost (same server as cron). */
export const DEFAULT_GNO_VALOPERS_LIVE_URL =
  'https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json';

// Seed with static data (instant, bundled)
for (const row of staticRegistry) {
  applyRow(row);
}

function applyRow(row: GnoValoperRow): boolean {
  if (!row.signingAddress && !row.operatorAddress) return false;

  // Rebind on UpdateSigningKey: drop stale signing→row links for this operator.
  if (row.operatorAddress) {
    const prev = byOperator.get(row.operatorAddress);
    if (prev?.signingAddress && prev.signingAddress !== row.signingAddress) {
      const mapped = bySigning.get(prev.signingAddress);
      if (mapped && mapped.operatorAddress === row.operatorAddress) {
        bySigning.delete(prev.signingAddress);
      }
    }
  }

  let changed = false;
  if (row.signingAddress) {
    const existing = bySigning.get(row.signingAddress);
    if (
      !existing ||
      existing.moniker !== row.moniker ||
      existing.operatorAddress !== row.operatorAddress ||
      existing.identity !== row.identity ||
      existing.website !== row.website
    ) {
      changed = true;
    }
    bySigning.set(row.signingAddress, row);
  }
  if (row.operatorAddress) {
    const existing = byOperator.get(row.operatorAddress);
    if (
      !existing ||
      existing.moniker !== row.moniker ||
      existing.signingAddress !== row.signingAddress ||
      existing.identity !== row.identity
    ) {
      changed = true;
    }
    byOperator.set(row.operatorAddress, row);
  }
  return changed;
}

function candidateUrls(explicit?: string): string[] {
  const out: string[] = [];
  const add = (u?: string) => {
    if (!u || out.includes(u)) return;
    out.push(u);
  };
  add(explicit);
  // Bundled chain config may set valopers_live_url (imported at build time via chain json)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (globalThis as any).__GNO_VALOPERS_LIVE_URL__ as string | undefined;
    add(cfg);
  } catch {
    /* ignore */
  }
  add(DEFAULT_GNO_VALOPERS_LIVE_URL);
  // Same-origin (self-host explorer / local vite public/)
  add('/data/gno-valopers.json');
  return out;
}

async function fetchRows(url: string): Promise<GnoValoperRow[] | null> {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}t=${Date.now()}`, {
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // Vercel SPA fallback returns text/html for missing /data/* — reject that
  if (ct.includes('text/html')) return null;
  const data = await res.json();
  if (Array.isArray(data)) return data as GnoValoperRow[];
  if (data && Array.isArray(data.valopers)) return data.valopers as GnoValoperRow[];
  if (data && Array.isArray(data.items)) return data.items as GnoValoperRow[];
  return null;
}

/**
 * Load live registry. Tries RPC static URL first, then same-origin.
 * Safe to call often (validator poll); failures keep bundled seed.
 *
 * @param chainOrUrl  chain name (ignored for URL pick except logging) OR full URL override
 * @param liveUrl     optional explicit live JSON URL (from chain config)
 */
export function initGnoValopers(chainOrUrl = 'gnoland-testnet', liveUrl?: string): Promise<void> {
  // Back-compat: single arg that looks like URL
  let explicit = liveUrl;
  if (!explicit && /^https?:\/\//i.test(chainOrUrl)) explicit = chainOrUrl;

  return (async () => {
    const urls = candidateUrls(explicit);
    for (const url of urls) {
      try {
        const rows = await fetchRows(url);
        if (!rows || !rows.length) continue;
        let updated = 0;
        for (const row of rows) {
          if (applyRow(row)) updated++;
        }
        if (updated > 0 || rows.length) {
          console.info(
            `[gno-valopers] live ${rows.length} from ${url} (${updated} fields changed)`
          );
        }
        return; // first successful source wins
      } catch {
        // try next candidate
      }
    }
    // All failed — bundled seed already in maps
  })();
}

export function lookupGnoValoper(address?: string): GnoValoper | undefined {
  if (!address) return undefined;
  return bySigning.get(address) || byOperator.get(address);
}

export function gnoMoniker(address?: string, fallback?: string): string {
  const hit = lookupGnoValoper(address);
  if (hit?.moniker) return hit.moniker;
  if (fallback) return fallback;
  if (!address) return 'validator';
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-4)}` : address;
}

export function gnoValoperCount() {
  return bySigning.size;
}

/** All known valoper rows (bundled + live). Deduped by operator. */
export function listGnoValopers(): GnoValoper[] {
  const seen = new Set<string>();
  const out: GnoValoper[] = [];
  for (const row of byOperator.values()) {
    const k = row.operatorAddress || row.signingAddress || row.moniker;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  for (const row of bySigning.values()) {
    const k = row.operatorAddress || row.signingAddress || row.moniker;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}
