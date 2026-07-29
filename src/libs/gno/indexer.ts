/**
 * Gno Indexer API client — onbloc REST API.
 *
 * Source: https://topaz.api.onbloc.xyz/v1
 * CORS: access-control-allow-origin: * (browser-safe)
 *
 * Provides transactions, realms, and GRC20 token data that the
 * public Gno RPC cannot (tx_index=off on all public nodes).
 *
 * Pagination is CURSOR-based: responses carry `page.cursor` + `page.hasNext`.
 * The `size` param is ignored server-side (always ~20 items).
 */

export interface GnoTx {
  txHash: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  toName: string;
  amount: { value: string; denom: string };
  /** Account-endpoint shape (valoper activity) — prefer over amount when set. */
  amountIn?: { value: string; denom: string };
  amountOut?: { value: string; denom: string };
  fee: { value: string; denom: string };
  storageDeposit: { value: string; denom: string };
  maxDeposit: { value: string; denom: string };
  func: { messageType: string; funcType: string; pkgPath: string }[];
  blockHeight: number;
  messageCount: number;
  successYn: boolean;
  timestamp: string;
  storageUsage: number;
}

/** Normalize account-tx payload (amountIn/Out) onto the shared GnoTx shape. */
function normalizeAccountTx(raw: any): GnoTx {
  const amountIn = raw?.amountIn;
  const amountOut = raw?.amountOut;
  const amount =
    raw?.amount ||
    (amountOut && amountOut.value && amountOut.value !== '0' ? amountOut : null) ||
    (amountIn && amountIn.value && amountIn.value !== '0' ? amountIn : null) ||
    amountOut ||
    amountIn ||
    { value: '0', denom: 'ugnot' };
  return {
    txHash: raw?.txHash || '',
    fromAddress: raw?.fromAddress || raw?.callerAddress || '',
    fromName: raw?.fromName || '',
    toAddress: raw?.toAddress || '',
    toName: raw?.toName || '',
    amount,
    amountIn,
    amountOut,
    fee: raw?.fee || { value: '0', denom: 'ugnot' },
    storageDeposit: raw?.storageDeposit || { value: '0', denom: 'ugnot' },
    maxDeposit: raw?.maxDeposit || { value: '0', denom: 'ugnot' },
    func: Array.isArray(raw?.func) ? raw.func : [],
    blockHeight: Number(raw?.blockHeight) || 0,
    messageCount: Number(raw?.messageCount) || 0,
    successYn: !!raw?.successYn,
    timestamp: raw?.timestamp || '',
    storageUsage: Number(raw?.storageUsage) || 0,
  };
}

export interface GnoRealm {
  name: string;
  path: string;
  publisher: string;
  publisherName: string;
  blockHeight: number;
  funcCount: number;
  totalCallCountSuccess: number;
  totalCallCountFailed: number;
  totalStorageUsage: number;
  totalReleaseStorageUsage: number;
  storageUsage: { value: string; unit: string };
  totalGasUsed: { value: string; denom: string };
  totalStorageDeposit: { value: string; denom: string };
  totalUnlockDeposit: { value: string; denom: string };
  index: number;
}

export interface GnoToken {
  tokenId: string;
  name: string;
  symbol: string;
  path: string;
  slug: string;
  owner: string;
  totalSupply: string;
  holders: number;
  decimals: number;
  logoUrl: string;
  funcTypesList: string[];
}

/** Validator entry from onbloc indexer — has ACTIVE / INACTIVE / PENDING. */
export interface GnoIndexerValidator {
  id: number;
  monikerName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING' | string;
  address: string;
  votingPower: string;
  shareRate: string;
  firstCommittedHeight: number;
  inActivatedHeight: number | null;
  firstCommittedTime: string | null;
  proposalId: string | null;
}

export interface GnoPage<T> {
  items: T[];
  /** Opaque cursor for the next page (base64). Undefined on the last page. */
  cursor?: string;
  hasNext: boolean;
}

export class GnoIndexerClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Indexer API ${res.status}: ${path}`);
    const json = await res.json();
    return json.data as T;
  }

  /** First page of transactions (newest first). */
  async getTransactions(): Promise<GnoPage<GnoTx>> {
    const data = await this.get<{ items: GnoTx[]; page?: { cursor?: string; hasNext?: boolean } }>(
      '/transactions',
      { page: 1 }
    );
    return {
      items: data.items || [],
      cursor: data.page?.cursor,
      hasNext: !!data.page?.hasNext,
    };
  }

  /** Next page via opaque cursor. */
  async getTransactionsAfter(cursor: string): Promise<GnoPage<GnoTx>> {
    const data = await this.get<{ items: GnoTx[]; page?: { cursor?: string; hasNext?: boolean } }>(
      '/transactions',
      { cursor }
    );
    return {
      items: data.items || [],
      cursor: data.page?.cursor,
      hasNext: !!data.page?.hasNext,
    };
  }

  /** Transactions involving a specific address (newest first).
   *  onbloc exposes this under /accounts/{addr}/transactions (CORS-safe).
   *  The generic /transactions endpoint ignores address filters, so this
   *  dedicated route is the only way to get per-account history.
   *
   *  Note: account txs use amountIn/amountOut (not amount). We normalize
   *  onto GnoTx so UI helpers stay shared with the global /transactions feed.
   *
   *  For Gno validators, valoper realm activity (Register / UpdateDescription)
   *  is signed by the **operator** address, not the Tendermint2 signing address.
   *  Query the operator for history; merge signing only when different. */
  async getAccountTransactions(address: string): Promise<GnoPage<GnoTx>> {
    const data = await this.get<{ items: any[]; page?: { cursor?: string; hasNext?: boolean } }>(
      `/accounts/${address}/transactions`,
      { page: 1 }
    );
    return {
      items: (data.items || []).map(normalizeAccountTx),
      cursor: data.page?.cursor,
      hasNext: !!data.page?.hasNext,
    };
  }

  /** Next page of account transactions via opaque cursor. */
  async getAccountTransactionsAfter(address: string, cursor: string): Promise<GnoPage<GnoTx>> {
    const data = await this.get<{ items: any[]; page?: { cursor?: string; hasNext?: boolean } }>(
      `/accounts/${address}/transactions`,
      { cursor }
    );
    return {
      items: (data.items || []).map(normalizeAccountTx),
      cursor: data.page?.cursor,
      hasNext: !!data.page?.hasNext,
    };
  }

  /**
   * Validator-detail helper: fetch txs for operator (primary) + signing
   * (secondary if distinct), merge by txHash, sort newest first.
   * Pagination cursor tracks the operator stream only (where activity lives).
   */
  async getValidatorTransactions(
    signingAddress: string,
    operatorAddress?: string
  ): Promise<GnoPage<GnoTx> & { primaryAddress: string }> {
    const primary = operatorAddress || signingAddress;
    const secondary =
      signingAddress && operatorAddress && signingAddress !== operatorAddress
        ? signingAddress
        : '';

    const primaryPage = await this.getAccountTransactions(primary);
    let items = primaryPage.items.slice();
    if (secondary) {
      try {
        const sec = await this.getAccountTransactions(secondary);
        const seen = new Set(items.map((t) => t.txHash));
        for (const t of sec.items) if (t.txHash && !seen.has(t.txHash)) items.push(t);
      } catch {
        // secondary is best-effort
      }
    }
    items.sort((a, b) => {
      const hb = Number(b.blockHeight) || 0;
      const ha = Number(a.blockHeight) || 0;
      if (hb !== ha) return hb - ha;
      return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
    });
    return {
      items,
      cursor: primaryPage.cursor,
      hasNext: primaryPage.hasNext,
      primaryAddress: primary,
    };
  }

  async getRealms(): Promise<GnoPage<GnoRealm>> {
    const data = await this.get<{ items: GnoRealm[]; page?: { cursor?: string; hasNext?: boolean } }>(
      '/realms',
      { page: 1 }
    );
    return {
      items: data.items || [],
      cursor: data.page?.cursor,
      hasNext: !!data.page?.hasNext,
    };
  }

  async getRealmsAfter(cursor: string): Promise<GnoPage<GnoRealm>> {
    const data = await this.get<{ items: GnoRealm[]; page?: { cursor?: string; hasNext?: boolean } }>(
      '/realms',
      { cursor }
    );
    return {
      items: data.items || [],
      cursor: data.page?.cursor,
      hasNext: !!data.page?.hasNext,
    };
  }

  /** All tokens fit in one page on testnet (hasNext=false). */
  async getTokens(): Promise<GnoPage<GnoToken>> {
    const data = await this.get<{ items: GnoToken[]; page?: { cursor?: string; hasNext?: boolean } }>(
      '/tokens',
      { page: 1 }
    );
    return {
      items: data.items || [],
      cursor: data.page?.cursor,
      hasNext: !!data.page?.hasNext,
    };
  }

  /** Fetch all validators across ACTIVE / INACTIVE / PENDING (cursor-paginated).
   *  Optional onPage fires after each page so UI can paint progressively
   *  (first ~20 rows in <1s instead of waiting ~5s for full set). */
  async getAllValidators(
    onPage?: (itemsSoFar: GnoIndexerValidator[], done: boolean) => void
  ): Promise<GnoIndexerValidator[]> {
    const out: GnoIndexerValidator[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const params: Record<string, string | number> = cursor ? { cursor } : { page: 1 };
      const data = await this.get<{
        items: GnoIndexerValidator[];
        page?: { cursor?: string; hasNext?: boolean };
      }>('/validators', params);
      out.push(...(data.items || []));
      const done = !data.page?.hasNext || !data.page?.cursor;
      onPage?.(out.slice(), done);
      if (done) break;
      cursor = data.page!.cursor;
    }
    return out;
  }
}

/** Singleton per base URL */
const clients = new Map<string, GnoIndexerClient>();

export function getGnoIndexer(baseUrl: string): GnoIndexerClient {
  const key = baseUrl.replace(/\/$/, '');
  let c = clients.get(key);
  if (!c) {
    c = new GnoIndexerClient(key);
    clients.set(key, c);
  }
  return c;
}
