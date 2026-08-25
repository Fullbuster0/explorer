/**
 * tx-indexer integration — adapter + fetch for the Shazoes tx-indexer.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Cosmos "Recent Transactions" feed (tx/index.vue → fetchRecentTxs) queries
 * the live LCD with `query=tx.height>0 order_by=DESC`. Validated 2026-08-25:
 * that range query is REJECTED by many public LCDs — 5 of our 8 chains fail:
 *   cosmoshub / lava / terra → HTTP 400 "specify tx.height with strict equality"
 *   zetachain → timeout,  axone → 500
 * Only atomone / hippo / shentu answer it. The tx-indexer (VPS :8879, exposed at
 * tx-indexer.shazoes.xyz behind Cloudflare) already stores the newest 100 txs per
 * chain for ALL 8, so it is the correct primary source. LCD stays as fallback.
 *
 * INDEXER ROW SHAPE (GET /v1/{chain}/txs?limit=&offset=)
 *   { chain, total, limit, offset, txs: [ {
 *       txhash, height, timestamp, code,
 *       msgs: [{type, ...}],          // COMPACT summary, bare type "MsgDelegate"
 *       fee:  [{denom, amount}],
 *       gas_wanted, gas_used,
 *       raw:  "<JSON tx_response>"    // FULL LCD tx_response, but capped at 20000 chars
 *   } ] }
 *
 * ADAPTER STRATEGY (validated against live data 2026-08-25)
 *   1. code === -1  → SKIP. Indexer writes a minimal placeholder row when the
 *      detail fetch failed (raw="", msgs=[], timestamp=""). Rendering it would
 *      show a bogus "Failed ✕ -1". Only axone had these (26/36), but guard all.
 *   2. Try JSON.parse(raw). When intact this yields the real tx_response with
 *      tx.body.messages[].'@type' (full proto path) and auth_info.fee — the SPA
 *      renders correct module-colour pills and fees with zero loss.
 *   3. raw is truncated at 20000 chars (lava 82/100, cosmoshub 30/100, …), so the
 *      parse throws. Fall back to synthesising a minimal tx_response from the
 *      compact msgs/fee/code fields. Pill LABELS stay correct ("Delegate"); only
 *      the pill COLOUR degrades to 'default' because moduleSlug() matches on the
 *      full proto path which the bare type lacks. Acceptable for a live feed.
 *
 * We deliberately DO NOT raise the indexer's raw cap or reindex — that touches a
 * freshly-stabilised backend for a cosmetic (pill colour) gain on truncated rows,
 * and busy chains refill the 100-row window within minutes anyway.
 */
import type { PaginatedTxs, TxResponse } from '@/types';

/** Compact message summary as stored by the indexer. */
interface IndexerMsg {
  type?: string;
  [k: string]: unknown;
}

/** One row from GET /v1/{chain}/txs. */
interface IndexerTxRow {
  txhash: string;
  height: number | string;
  timestamp: string;
  code: number;
  msgs?: IndexerMsg[];
  fee?: { denom: string; amount: string }[];
  gas_wanted?: number | string;
  gas_used?: number | string;
  raw?: string;
}

interface IndexerTxsResponse {
  chain: string;
  total: number;
  limit: number;
  offset: number;
  txs: IndexerTxRow[];
}

/**
 * Bare "MsgDelegate" → best-effort full proto path so the SPA's moduleSlug()
 * (which matches substrings like "cosmos.staking") can still colour the pill.
 * Only covers the common modules; anything unmapped keeps the bare type and
 * falls through to the 'default' colour — the label is unaffected either way.
 */
const MSG_TYPE_PREFIX: Record<string, string> = {
  MsgSend: '/cosmos.bank.v1beta1.',
  MsgMultiSend: '/cosmos.bank.v1beta1.',
  MsgDelegate: '/cosmos.staking.v1beta1.',
  MsgUndelegate: '/cosmos.staking.v1beta1.',
  MsgBeginRedelegate: '/cosmos.staking.v1beta1.',
  MsgCreateValidator: '/cosmos.staking.v1beta1.',
  MsgEditValidator: '/cosmos.staking.v1beta1.',
  MsgWithdrawDelegatorReward: '/cosmos.distribution.v1beta1.',
  MsgWithdrawValidatorCommission: '/cosmos.distribution.v1beta1.',
  MsgSetWithdrawAddress: '/cosmos.distribution.v1beta1.',
  MsgFundCommunityPool: '/cosmos.distribution.v1beta1.',
  MsgVote: '/cosmos.gov.v1beta1.',
  MsgVoteWeighted: '/cosmos.gov.v1beta1.',
  MsgSubmitProposal: '/cosmos.gov.v1beta1.',
  MsgDeposit: '/cosmos.gov.v1beta1.',
  MsgExec: '/cosmos.authz.v1beta1.',
  MsgGrant: '/cosmos.authz.v1beta1.',
  MsgRevoke: '/cosmos.authz.v1beta1.',
  MsgTransfer: '/ibc.applications.transfer.v1.',
  MsgRecvPacket: '/ibc.core.channel.v1.',
  MsgAcknowledgement: '/ibc.core.channel.v1.',
  MsgUpdateClient: '/ibc.core.client.v1.',
  MsgTimeout: '/ibc.core.channel.v1.',
  MsgRelayPayment: '/lavanet.lava.pairing.',
};

/** Reconstruct a proto `@type` from a bare compact type, best-effort. */
function toTypeUrl(bare: string): string {
  if (!bare) return '';
  if (bare.startsWith('/')) return bare; // already a full path
  const prefix = MSG_TYPE_PREFIX[bare];
  return prefix ? `${prefix}${bare}` : bare;
}

/**
 * Convert one indexer row into the SPA's TxResponse shape.
 * Returns null for rows that must not be rendered (code === -1 placeholder).
 */
export function indexerRowToTxResponse(row: IndexerTxRow): TxResponse | null {
  // 1) skip broken placeholder rows
  if (row.code === -1) return null;
  if (!row.txhash) return null;

  // 2) prefer the full raw tx_response when it survived the 20000-char cap
  if (row.raw) {
    try {
      const parsed = JSON.parse(row.raw);
      // sanity: a real tx_response has txhash + tx.body
      if (parsed && parsed.txhash && parsed.tx?.body) {
        return parsed as TxResponse;
      }
    } catch {
      // truncated / malformed → fall through to synthesis
    }
  }

  // 3) synthesise a minimal tx_response from the compact fields
  const messages = (row.msgs || []).map((m) => ({
    '@type': toTypeUrl(String(m.type || '')),
  }));
  return {
    height: String(row.height ?? ''),
    txhash: row.txhash,
    code: row.code ?? 0,
    timestamp: row.timestamp || '',
    gas_wanted: String(row.gas_wanted ?? ''),
    gas_used: String(row.gas_used ?? ''),
    tx: {
      '@type': '/cosmos.tx.v1beta1.Tx',
      body: { messages, memo: '', timeout_height: '0' },
      auth_info: {
        fee: { amount: row.fee || [], gas_limit: String(row.gas_wanted ?? ''), payer: '', granter: '' },
      },
    },
  } as unknown as TxResponse;
}

/**
 * Base URL for the tx-indexer.
 *   - unset / default  → 'https://tx-indexer.shazoes.xyz' (direct; CORS allows
 *     the Vercel + custom-domain origins, and CF-Connecting-IP makes the nginx
 *     rate-limit per real user rather than per Vercel egress IP).
 *   - '/tx-api'        → same-origin path (Vercel rewrite / nginx proxy).
 *   - '' (empty)       → indexer DISABLED, LCD-only. Escape hatch for debugging.
 */
export function txIndexerBase(): string | null {
  const raw = import.meta.env.VITE_TX_INDEXER_URL as string | undefined;
  if (raw === '') return null; // explicitly disabled
  if (raw == null) return 'https://tx-indexer.shazoes.xyz';
  return raw.replace(/\/$/, '');
}

/**
 * Fetch the newest `limit` txs for `chain` from the tx-indexer and adapt them
 * to the SPA's PaginatedTxs shape. Returns null on any failure (disabled,
 * network, HTTP error, empty) so the caller can fall back to the LCD walk.
 */
export async function fetchRecentTxsFromIndexer(
  chain: string,
  limit = 5,
  timeoutMs = 8000
): Promise<PaginatedTxs | null> {
  const base = txIndexerBase();
  if (!base) return null;
  if (!chain) return null;

  const url = `${base}/v1/${encodeURIComponent(chain)}/txs?limit=${encodeURIComponent(String(limit))}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as IndexerTxsResponse;
    const rows = Array.isArray(data?.txs) ? data.txs : [];
    const tx_responses = rows
      .map(indexerRowToTxResponse)
      .filter((r): r is TxResponse => r !== null)
      .slice(0, limit);
    if (!tx_responses.length) return null; // nothing usable → let LCD try
    return {
      txs: tx_responses.map((r) => (r as any).tx),
      tx_responses,
      pagination: { total: String(data.total ?? tx_responses.length) },
    } as unknown as PaginatedTxs;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
