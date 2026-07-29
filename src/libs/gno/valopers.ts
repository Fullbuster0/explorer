/**
 * Gnoland valoper moniker registry — hybrid static + live.
 *
 * Static bundle (valopers-data.ts) provides instant lookup on first paint.
 * On init, fires an async fetch to /api/gno-valopers (Vercel serverless
 * proxy for the official gnops realm) and merges live data over static.
 *
 * No cron. No git push for data updates. Config-driven via chain JSON
 * valopers_source.base_url (read by the serverless function).
 *
 * Lookup key is the Tendermint2 signing address (/validators address,
 * block proposer, precommit validator_address) — NOT the operator address.
 */
import staticRegistry from './valopers-data';
import type { GnoValoperRow } from './valopers-data';

export type GnoValoper = GnoValoperRow;

const bySigning = new Map<string, GnoValoper>();
const byOperator = new Map<string, GnoValoper>();

// Seed with static data (instant, bundled)
for (const row of staticRegistry) {
  if (row.signingAddress) bySigning.set(row.signingAddress, row);
  if (row.operatorAddress) byOperator.set(row.operatorAddress, row);
}

let liveLoaded = false;
let livePromise: Promise<void> | null = null;

/**
 * Fetch live registry from /api/gno-valopers and merge over static.
 * Fire-and-forget on app init; lookups work immediately from static.
 * Safe to call multiple times — dedupes via livePromise.
 */
export function initGnoValopers(chain = 'gnoland-testnet'): Promise<void> {
  if (liveLoaded || livePromise) return livePromise || Promise.resolve();
  livePromise = (async () => {
    try {
      const res = await fetch(`/api/gno-valopers?chain=${encodeURIComponent(chain)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return;
      const json = await res.json();
      const rows: GnoValoperRow[] = json.valopers || [];
      let updated = 0;
      for (const row of rows) {
        if (!row.signingAddress && !row.operatorAddress) continue;
        // Live wins over static
        if (row.signingAddress) {
          const existing = bySigning.get(row.signingAddress);
          if (!existing || existing.moniker !== row.moniker || existing.serverType !== row.serverType) {
            bySigning.set(row.signingAddress, row);
            updated++;
          }
        }
        if (row.operatorAddress) {
          byOperator.set(row.operatorAddress, row);
        }
      }
      liveLoaded = true;
      if (updated > 0) {
        console.info(`[gno-valopers] live merge: ${updated} updated, ${rows.length} total from realm`);
      }
    } catch {
      // Silent — static fallback is fine
    }
  })();
  return livePromise;
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
