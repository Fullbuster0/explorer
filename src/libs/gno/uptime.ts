/**
 * Gno rolling uptime read model.
 *
 * This is the explorer's authoritative validator-list/status source. The
 * runtime SQLite database never reaches the browser; gno-valopers publishes
 * this atomic JSON artifact instead.
 *
 * Onbloc is intentionally not used here. It remains a history-only provider
 * because public Gno RPC commonly runs with tx_index=off.
 */

export type GnoUptimeStatus = 'ACTIVE' | 'INACTIVE' | 'PENDING' | string;

export interface GnoUptimeValidator {
  operatorAddress: string;
  signingAddress: string;
  moniker?: string;
  status: GnoUptimeStatus;
  chainStatus?: string;
  reason?: string;
  sampledBlocks?: number;
  eligibleBlocks?: number;
  signed?: number;
  missed?: number;
  uptime?: number | null;
  consecutiveMissed?: number;
  observed?: boolean;
  fullWindow?: boolean;
  votingPower?: string;
}

export interface GnoUptimeSnapshot {
  chainId?: string;
  observedHeight?: number;
  commitHeight?: number;
  windowBlocks?: number;
  sampledFrom?: number;
  sampledTo?: number;
  sampledBlocks?: number;
  updatedAt?: string;
  validators: GnoUptimeValidator[];
}

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export async function fetchGnoUptimeSnapshot(url: string): Promise<GnoUptimeSnapshot> {
  const join = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${join}t=${Date.now()}`, {
    signal: abortAfter(10_000),
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Gno uptime snapshot HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.validators)) {
    throw new Error('Gno uptime snapshot has invalid schema');
  }
  return {
    ...payload,
    validators: payload.validators.filter(
      (row: any) => row && typeof row === 'object' && (row.operatorAddress || row.signingAddress),
    ),
  } as GnoUptimeSnapshot;
}

export function uptimeValidatorKey(row: Pick<GnoUptimeValidator, 'operatorAddress' | 'signingAddress'>): string[] {
  return [row.operatorAddress, row.signingAddress].map((value) => String(value || '').trim()).filter(Boolean);
}

export function findGnoUptimeValidator(
  rows: GnoUptimeValidator[],
  address: string,
): GnoUptimeValidator | undefined {
  const wanted = String(address || '').trim();
  if (!wanted) return undefined;
  return rows.find((row) => uptimeValidatorKey(row).includes(wanted));
}

export function gnoUptimeSnapshotCounts(rows: GnoUptimeValidator[]) {
  return rows.reduce(
    (counts, row) => {
      if (row.status === 'ACTIVE') counts.ACTIVE += 1;
      else if (row.status === 'INACTIVE') counts.INACTIVE += 1;
      else if (row.status === 'PENDING') counts.PENDING += 1;
      return counts;
    },
    { ACTIVE: 0, INACTIVE: 0, PENDING: 0 },
  );
}

export const DEFAULT_GNO_UPTIME_LIVE_URL =
  'https://data.shazoes.xyz/gno/testnet/sapphire-1/uptime.json';
export const DEFAULT_GNO_UPTIME_WINDOW = 10_000;
