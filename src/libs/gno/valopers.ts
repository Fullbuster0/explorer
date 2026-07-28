/**
 * Static Gnoland Topaz valoper moniker registry.
 * Source: Indonode explorer bundle + noderuner validator-dashboard
 * (Gno has no Cosmos staking module → monikers are off-chain).
 *
 * Lookup key is the Tendermint2 signing address (`/validators` address,
 * block proposer, precommit validator_address) — NOT the operator address.
 */
import registry from './valopers-data';
import type { GnoValoperRow } from './valopers-data';

export type GnoValoper = GnoValoperRow;

const bySigning = new Map<string, GnoValoper>();
const byOperator = new Map<string, GnoValoper>();

for (const row of registry) {
  if (row.signingAddress) bySigning.set(row.signingAddress, row);
  if (row.operatorAddress) byOperator.set(row.operatorAddress, row);
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
