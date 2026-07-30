/**
 * Gnoland valoper registry — bundled seed + live JSON refresh.
 *
 * Identity model:
 *   - operatorAddress = stable registration id (almost never changes)
 *   - signingAddress / pubkey = mutable (UpdateSigningKey)
 *   - moniker / description = mutable (UpdateDescription)
 *
 * Logo / Keybase identity priority (highest → lowest):
 *   0. Manual pin  identity-overrides.json  (operator > signing > moniker)
 *      — applied at cron into live JSON; also re-applied client-side so a pin
 *        cannot be wiped by a stale live row or AtomOne auto-match
 *   1. Live JSON identity field (cron: overrides → AtomOne enrich → final pin)
 *   2. Bundled valopers-data.ts seed
 *
 * Live source (preferred, no git/deploy):
 *   https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json
 */
import staticRegistry from './valopers-data';
import type { GnoValoperRow } from './valopers-data';
import overrideFile from './identity-overrides.json';

export type GnoValoper = GnoValoperRow;

const bySigning = new Map<string, GnoValoper>();
const byOperator = new Map<string, GnoValoper>();

/** operator / signing / monikerLower → Keybase identity (16 hex). */
const overrideByOperator = new Map<string, string>();
const overrideBySigning = new Map<string, string>();
const overrideByMoniker = new Map<string, string>();

function loadOverridesFromJson(raw: unknown) {
  overrideByOperator.clear();
  overrideBySigning.clear();
  overrideByMoniker.clear();
  const ov =
    raw && typeof raw === 'object' && (raw as { overrides?: Record<string, unknown> }).overrides
      ? (raw as { overrides: Record<string, unknown> }).overrides
      : {};
  for (const [key, val] of Object.entries(ov || {})) {
    if (!key || val == null) continue;
    const id =
      typeof val === 'string'
        ? val.trim()
        : typeof val === 'object' && val && (val as { identity?: string }).identity
          ? String((val as { identity: string }).identity).trim()
          : '';
    if (!id) continue;
    const k = key.trim();
    if (/^g1[a-z0-9]{38,}$/i.test(k)) {
      overrideByOperator.set(k.toLowerCase(), id);
      overrideBySigning.set(k.toLowerCase(), id);
    } else {
      overrideByMoniker.set(k.toLowerCase(), id);
    }
    if (typeof val === 'object' && val) {
      const o = val as { operator?: string; signing?: string; moniker?: string };
      if (o.operator) overrideByOperator.set(String(o.operator).toLowerCase(), id);
      if (o.signing) overrideBySigning.set(String(o.signing).toLowerCase(), id);
      if (o.moniker) overrideByMoniker.set(String(o.moniker).toLowerCase(), id);
    }
  }
}

loadOverridesFromJson(overrideFile);

/** Resolve manual Keybase pin — operator > signing > moniker. Never auto-cleared. */
export function resolveIdentityOverride(row: {
  operatorAddress?: string;
  signingAddress?: string;
  moniker?: string;
}): string | undefined {
  const op = (row.operatorAddress || '').toLowerCase();
  const sig = (row.signingAddress || '').toLowerCase();
  const mon = (row.moniker || '').toLowerCase();
  if (op && overrideByOperator.has(op)) return overrideByOperator.get(op);
  if (sig && overrideBySigning.has(sig)) return overrideBySigning.get(sig);
  if (mon && overrideByMoniker.has(mon)) return overrideByMoniker.get(mon);
  return undefined;
}

function pinIdentity(row: GnoValoperRow): GnoValoperRow {
  const pinned = resolveIdentityOverride(row);
  if (!pinned) return row;
  if (row.identity === pinned) return row;
  return { ...row, identity: pinned };
}

/** Default public URL on our Gno RPC vhost (same server as cron). */
export const DEFAULT_GNO_VALOPERS_LIVE_URL =
  'https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json';

// Seed with static data (instant, bundled) + apply pins
for (const row of staticRegistry) {
  applyRow(pinIdentity(row as GnoValoperRow));
}

function applyRow(row: GnoValoperRow): boolean {
  if (!row.signingAddress && !row.operatorAddress) return false;
  row = pinIdentity(row);

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
  add(DEFAULT_GNO_VALOPERS_LIVE_URL);
  add('/data/gno-valopers.json');
  return out;
}

async function fetchRows(url: string): Promise<GnoValoperRow[] | null> {
  const join = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${join}t=${Date.now()}`, {
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return null;
  const data = await res.json();
  if (Array.isArray(data)) return data as GnoValoperRow[];
  if (data && Array.isArray(data.valopers)) return data.valopers as GnoValoperRow[];
  if (data && Array.isArray(data.items)) return data.items as GnoValoperRow[];
  return null;
}

/**
 * Load live registry. Tries RPC static URL first, then same-origin.
 * Manual identity overrides are re-applied on every row (cannot be changed by live JSON).
 */
export function initGnoValopers(chainOrUrl = 'gnoland-testnet', liveUrl?: string): Promise<void> {
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
        return;
      } catch (e) {
        console.warn(`[gno-valopers] fetch failed ${url}:`, (e as any)?.message || e);
      }
    }
    console.warn('[gno-valopers] all live candidates failed; using bundled seed');
  })();
}

export function lookupGnoValoper(address?: string): GnoValoper | undefined {
  if (!address) return undefined;
  const hit = bySigning.get(address) || byOperator.get(address);
  if (!hit) return undefined;
  // Always surface pinned identity even if maps were seeded before override edit
  return pinIdentity(hit);
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
    out.push(pinIdentity(row));
  }
  for (const row of bySigning.values()) {
    const k = row.operatorAddress || row.signingAddress || row.moniker;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(pinIdentity(row));
  }
  return out;
}
