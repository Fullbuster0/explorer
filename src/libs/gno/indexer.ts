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

  /** Fetch all validators across ACTIVE / INACTIVE / PENDING (cursor-paginated). */
  async getAllValidators(): Promise<GnoIndexerValidator[]> {
    const out: GnoIndexerValidator[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const params: Record<string, string | number> = cursor ? { cursor } : { page: 1 };
      const data = await this.get<{ items: GnoIndexerValidator[]; page?: { cursor?: string; hasNext?: boolean } }>(
        '/validators',
        params
      );
      out.push(...(data.items || []));
      if (!data.page?.hasNext || !data.page?.cursor) break;
      cursor = data.page.cursor;
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
