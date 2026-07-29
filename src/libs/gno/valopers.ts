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
 * Called once on Gno chain init. Fire-and-forget.
 * File is written by cron every 30 min — no git, no Vercel.
 */
export function initGnoValopers(_chain = 'gnoland-testnet'): Promise<void> {
  return (async () => {
    try {
      const res = await fetch('/data/gno-valopers.json', {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const rows: GnoValoperRow[] = await res.json();
      let updated = 0;
      for (const row of rows) {
        if (!row.signingAddress && !row.operatorAddress) continue;
        if (row.signingAddress) {
          const existing = bySigning.get(row.signingAddress);
          if (!existing || existing.moniker !== row.moniker) {
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
      // Silent — static fallback is fine
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
