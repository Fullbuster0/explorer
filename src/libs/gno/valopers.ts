/**
 * Gnoland valoper moniker registry — static JSON file only.
 *
 * No Vercel. No SPA. No browser.
 * Cron writes public/data/gno-valopers.json every 30 min.
 * This module just reads that file (or falls back to bundled static).
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

/**
 * Optional: load from public/data/gno-valopers.json if available.
 * Called on Gno chain init and before each validators refresh.
 * File is written by cron every 30 min — no git, no Vercel for local/dev.
 * Production SPA still ships bundled valopers-data.ts (committed).
 */
export function initGnoValopers(_chain = 'gnoland-testnet'): Promise<void> {
  return (async () => {
    try {
      // cache-bust so a just-written cron file is visible without hard refresh
      const res = await fetch(`/data/gno-valopers.json?t=${Date.now()}`, {
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      if (!res.ok) return;
      const rows: GnoValoperRow[] = await res.json();
      let updated = 0;
      for (const row of rows) {
        if (!row.signingAddress && !row.operatorAddress) continue;
        if (row.signingAddress) {
          const existing = bySigning.get(row.signingAddress);
          if (!existing || existing.moniker !== row.moniker || existing.operatorAddress !== row.operatorAddress) {
            bySigning.set(row.signingAddress, row);
            updated++;
          }
        }
        if (row.operatorAddress) {
          byOperator.set(row.operatorAddress, row);
        }
      }
      if (updated > 0) {
        console.info(`[gno-valopers] loaded ${rows.length} from /data/gno-valopers.json (${updated} updated)`);
      }
    } catch {
      // Silent — static fallback is fine (Vercel has no gitignored JSON)
    }
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

/** All known valoper rows (bundled + optional /data refresh). Deduped by operator. */
export function listGnoValopers(): GnoValoper[] {
  const seen = new Set<string>();
  const out: GnoValoper[] = [];
  for (const row of byOperator.values()) {
    const k = row.operatorAddress || row.signingAddress || row.moniker;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  // Include signing-only rows not already keyed by operator
  for (const row of bySigning.values()) {
    const k = row.operatorAddress || row.signingAddress || row.moniker;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}
