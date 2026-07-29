/**
 * CosmosRestClient-compatible facade backed by Tendermint2 JSON-RPC.
 * Only the methods the explorer actually calls on chain init / core pages
 * are implemented; everything else returns empty safe defaults so stores
 * don't throw and freeze the UI.
 */
import type { PageRequest } from '@/types';
import type { Validator } from '@/types/staking';
import {
  adaptTm2Block,
  adaptTm2StakingValidators,
  adaptTm2Status,
  adaptTm2Validators,
  gnoStakingParams,
  gnoStakingPool,
  tm2Block,
  tm2Get,
  tm2Status,
  tm2Validators,
  tm2ValidatorToStaking,
  tm2HashToHex,
} from './tm2';
import { fromBase64, toHex } from '@cosmjs/encoding';

function emptyPage() {
  return { next_key: undefined as string | undefined, total: '0' };
}

/** TM2 abci_query ResponseBase.Data is base64 JSON (Value is often null). */
async function tm2AbciJson(endpoint: string, path: string): Promise<any | null> {
  try {
    const data = await tm2Get(endpoint, `/abci_query?path=${encodeURIComponent(path)}`);
    const resp = data?.result?.response || data?.response || data;
    const rb = resp?.ResponseBase || resp?.response_base || {};
    const b64 = rb.Data || rb.data || resp?.Value || resp?.value || null;
    if (!b64) return null;
    const text = new TextDecoder().decode(fromBase64(b64));
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

/** Parse Gno coins string "123ugnot,456foo" → Coin[]. */
function parseGnoCoins(coins: string | null | undefined): { denom: string; amount: string }[] {
  if (!coins || typeof coins !== 'string') return [];
  const out: { denom: string; amount: string }[] = [];
  for (const part of coins.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(-?\d+)([a-zA-Z][a-zA-Z0-9/:._-]*)$/);
    if (m) out.push({ amount: m[1], denom: m[2] });
  }
  return out;
}

/**
 * Normalize a user-supplied Gno tx hash into forms TM2 accepts.
 * Accepts: base64 (with/without padding), 0x-hex, bare hex.
 */
function normalizeGnoTxHash(input: string): { hex: string; b64: string; raw: string } {
  const s = String(input || '').trim();
  // base64 (TM2 native) — 44 chars with padding for 32-byte hash
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(s) && !/^[0-9a-fA-F]{64}$/.test(s)) {
    try {
      const bytes = fromBase64(s);
      const hex = toHex(bytes).toLowerCase();
      return { hex, b64: s, raw: s };
    } catch {
      /* fall through */
    }
  }
  const hex = s.replace(/^0x/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) {
    // build standard base64 from hex for alternate try
    try {
      const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      // browser/node btoa of binary
      let bin = '';
      bytes.forEach((b) => (bin += String.fromCharCode(b)));
      const b64 =
        typeof btoa !== 'undefined'
          ? btoa(bin)
          : Buffer.from(bytes).toString('base64');
      return { hex, b64, raw: s };
    } catch {
      return { hex, b64: '', raw: s };
    }
  }
  return { hex: s.replace(/^0x/i, ''), b64: s, raw: s };
}

/** Adapt TM2 /tx result → Cosmos {tx, tx_response} shape for detail page. */
function adaptTm2Tx(result: any, preferHash?: string): { tx: any; tx_response: any } | null {
  if (!result) return null;
  // unwrap jsonrpc
  const r = result.result || result;
  if (!r || (!r.hash && !r.tx && !r.height)) return null;

  const hashB64 = r.hash || '';
  const hashHex = tm2HashToHex(hashB64) || (preferHash || '').replace(/^0x/i, '').toUpperCase();
  const height = String(r.height ?? '');
  const tr = r.tx_result || r.tx_response || {};
  const rb = tr.ResponseBase || tr.response_base || {};
  const err = rb.Error || rb.error;
  const code = err ? 1 : 0;
  const log = rb.Log || rb.log || '';
  const gasWanted = String(tr.GasWanted ?? tr.gas_wanted ?? '0');
  const gasUsed = String(tr.GasUsed ?? tr.gas_used ?? '0');

  // Best-effort decode of amino/proto bytes for display
  let messages: any[] = [];
  let rawTx: any = { '@type': '/tm2.Tx', body: { messages: [] as any[] }, auth_info: { fee: { amount: [], gas_limit: gasWanted }, signer_infos: [] }, signatures: [] };
  try {
    if (r.tx) {
      const bytes = fromBase64(r.tx);
      const text = new TextDecoder('utf-8', { fatal: false } as any).decode(bytes);
      // Pull ASCII type URLs + g1 addresses + amounts for a minimal message view
      const typeMatch = text.match(/\/[a-zA-Z][a-zA-Z0-9_.]*\.[A-Za-z][A-Za-z0-9_]*/g) || [];
      const addrs = text.match(/g1[a-z0-9]{38,60}/g) || [];
      const amounts = text.match(/\d+ugnot/g) || [];
      const typeUrl = typeMatch[0] || '/tm2.Unknown';
      const msg: any = { '@type': typeUrl };
      if (addrs[0]) msg.from_address = addrs[0];
      if (addrs[1]) msg.to_address = addrs[1];
      if (amounts[0]) {
        const m = amounts[0].match(/^(\d+)(ugnot)$/);
        if (m) msg.amount = [{ amount: m[1], denom: m[2] }];
      }
      // fee often second ugnot amount
      if (amounts[1]) {
        const m = amounts[1].match(/^(\d+)(ugnot)$/);
        if (m) {
          rawTx.auth_info.fee.amount = [{ amount: m[1], denom: m[2] }];
        }
      }
      messages = [msg];
      rawTx.body.messages = messages;
      rawTx._raw_b64 = r.tx;
    }
  } catch {
    /* keep empty messages */
  }

  const tx_response = {
    height,
    txhash: hashHex || hashB64,
    codespace: '',
    code,
    data: rb.Data || '',
    raw_log: log,
    logs: [],
    info: rb.Info || '',
    gas_wanted: gasWanted,
    gas_used: gasUsed,
    tx: rawTx,
    timestamp: '',
    events: [],
    // Gno extras for UI
    _gno_hash_b64: hashB64,
    _gno_index: r.index,
  };

  return { tx: rawTx, tx_response };
}

export class GnoTm2Client {
  endpoint: string;
  version: string;
  /** Cache last validator set for pool/params-ish derived data */
  private _vals: Validator[] = [];

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.version = 'gno-tm2';
  }

  static new(endpoint: string) {
    return new GnoTm2Client(endpoint);
  }

  // ---- tendermint / base (used by useBaseStore) ----
  async getBaseBlockLatest() {
    return adaptTm2Block(await tm2Block(this.endpoint));
  }
  async getBaseBlockAt(height: string | number) {
    return adaptTm2Block(await tm2Block(this.endpoint, height));
  }
  async getBaseNodeInfo() {
    return adaptTm2Status(await tm2Status(this.endpoint));
  }
  async getBaseValidatorsetLatest(_offset = 0) {
    return adaptTm2Validators(await tm2Validators(this.endpoint));
  }
  async getBaseValidatorsetAt(height: string | number, _offset = 0) {
    return adaptTm2Validators(await tm2Validators(this.endpoint, height));
  }
  async getBaseAbciQuery() {
    return {};
  }

  // ---- staking (validator list page + dashboard power) ----
  async getStakingValidators(status: string, _limit = 500) {
    // TM2 has a single active set — treat anything non-bonded as empty
    if (status && status !== 'BOND_STATUS_BONDED' && status !== 'bonded') {
      return { validators: [], pagination: emptyPage() };
    }
    const adapted = adaptTm2StakingValidators(await tm2Validators(this.endpoint));
    this._vals = adapted.validators;
    return adapted;
  }
  async getStakingValidator(validator_addr: string) {
    if (!this._vals.length) {
      await this.getStakingValidators('BOND_STATUS_BONDED');
    }
    const match = (v: Validator) =>
      v.operator_address === validator_addr ||
      // also accept registry operatorAddress in the URL
      (v as any)._operatorAddress === validator_addr;
    const hit = this._vals.find(match);
    if (hit) return { validator: hit };
    // try live fetch + match
    const all = adaptTm2StakingValidators(await tm2Validators(this.endpoint));
    this._vals = all.validators;
    const found = this._vals.find(match);
    if (found) return { validator: found };
    // Lookup by moniker registry operator → signing address, then refetch
    const { lookupGnoValoper } = await import('./valopers');
    const meta = lookupGnoValoper(validator_addr);
    if (meta?.signingAddress && meta.signingAddress !== validator_addr) {
      const viaSign = this._vals.find((v: Validator) => v.operator_address === meta.signingAddress);
      if (viaSign) return { validator: viaSign };
    }
    // synthetic stub so detail page doesn't crash
    return {
      validator: tm2ValidatorToStaking({ address: validator_addr, voting_power: '0', pub_key: null }),
    };
  }
  async getStakingParams() {
    const p = gnoStakingParams();
    // Mirror live set size only — never invent a higher cap than reality.
    // UI on Gno hides "max validators" entirely when this would mislead.
    if (this._vals.length) p.params.max_validators = this._vals.length;
    return p;
  }
  async getStakingPool() {
    if (!this._vals.length) {
      try {
        await this.getStakingValidators('BOND_STATUS_BONDED');
      } catch {
        /* empty pool */
      }
    }
    return gnoStakingPool(this._vals);
  }
  async getStakingDelegations(_delegator: string) {
    return { delegation_responses: [], pagination: emptyPage() };
  }
  async getStakingDelegatorUnbonding(_delegator: string) {
    return { unbonding_responses: [], pagination: emptyPage() };
  }
  async getStakingValidatorsDelegations(_validator_addr: string) {
    return { delegation_responses: [], pagination: emptyPage() };
  }
  async getStakingValidatorsDelegationsDelegator(_validator_addr: string, _delegator_addr: string) {
    return { delegation_response: null };
  }
  async getStakingValidatorsDelegationsUnbonding(_a: string, _b: string) {
    return { unbond: null };
  }
  async getStakingDelegatorValidators(_delegator: string) {
    return { validators: [], pagination: emptyPage() };
  }
  async getStakingRedelegations(_delegator: string) {
    return { redelegation_responses: [], pagination: emptyPage() };
  }

  // ---- bank / auth / mint / dist / gov / ibc / tx : safe empties ----
  async getBankSupplyByDenom(denom: string) {
    return { amount: { denom, amount: '0' } };
  }
  async getBankSupply() {
    return { supply: [], pagination: emptyPage() };
  }
  async getBankBalances(address: string) {
    const raw = await tm2AbciJson(this.endpoint, `auth/accounts/${address}`);
    const coinsStr =
      raw?.BaseAccount?.coins ??
      raw?.base_account?.coins ??
      raw?.coins ??
      null;
    const balances = parseGnoCoins(coinsStr);
    return { balances, pagination: emptyPage() };
  }
  async getBankParams() {
    return { params: {} };
  }
  async getBankDenomMetadata() {
    return { metadatas: [], pagination: emptyPage() };
  }
  async getAuthAccounts() {
    return { accounts: [], pagination: emptyPage() };
  }
  async getAuthAccount(address: string) {
    const raw = await tm2AbciJson(this.endpoint, `auth/accounts/${address}`);
    // Always return a BaseAccount-shaped object so the account page never
    // infinite-spins on "Loading account…" for never-used / zero-activity g1s.
    if (!raw) {
      return {
        account: {
          '@type': '/gno.BaseAccount',
          address,
          pub_key: null,
          account_number: '0',
          sequence: '0',
          coins: [] as { denom: string; amount: string }[],
          raw: null,
          _empty: true,
        },
      };
    }
    const ba = raw.BaseAccount || raw.base_account || raw;
    const coins = parseGnoCoins(ba.coins);
    const account = {
      '@type': '/gno.BaseAccount',
      address: ba.address || address,
      pub_key: ba.public_key || ba.pub_key || null,
      account_number: String(ba.account_number ?? '0'),
      sequence: String(ba.sequence ?? '0'),
      coins,
      raw: ba,
    };
    return { account };
  }
  async getMintParam() {
    return { params: {} };
  }
  async getMintInflation() {
    return { inflation: '0' };
  }
  async getMintAnnualProvisions() {
    return { annual_provisions: '0' };
  }
  async getDistributionParams() {
    return { params: {} };
  }
  async getDistributionCommunityPool() {
    return { pool: [] };
  }
  async getDistributionDelegatorRewards(_addr: string) {
    return { rewards: [], total: [] };
  }
  async getDistributionValidatorCommission(_addr: string) {
    return { commission: { commission: [] } };
  }
  async getDistributionValidatorOutstandingRewards(_addr: string) {
    return { rewards: { rewards: [] } };
  }
  async getDistributionValidatorSlashes(_addr: string) {
    return { slashes: [], pagination: emptyPage() };
  }
  async getSlashingParams() {
    // Gno has no slashing module. Return synthetic params so the uptime page
    // renders a window size + uptime % instead of "—". The window matches the
    // heatmap depth (50 blocks). min_signed = 0 (no jail threshold on Gno).
    return {
      params: {
        signed_blocks_window: '50',
        min_signed_per_window: '0',
        downtime_jail_duration: '0s',
        slash_fraction_double_sign: '0',
        slash_fraction_downtime: '0',
      },
    };
  }
  async getSlashingSigningInfos() {
    return { info: [], pagination: emptyPage() };
  }
  async getGovParamsVoting() {
    return { voting_params: {} };
  }
  async getGovParamsDeposit() {
    return { deposit_params: {} };
  }
  async getGovParamsTally() {
    return { tally_params: {} };
  }
  async getGovProposals(_status: string, _page?: PageRequest) {
    return { proposals: [], pagination: emptyPage() };
  }
  async getGovProposal(_id: string) {
    return { proposal: null };
  }
  async getGovProposalDeposits(_id: string) {
    return { deposits: [], pagination: emptyPage() };
  }
  async getGovProposalTally(_id: string) {
    return { tally: { yes: '0', no: '0', abstain: '0', no_with_veto: '0' } };
  }
  async getGovProposalVotes(_id: string, _page?: PageRequest) {
    return { votes: [], pagination: emptyPage() };
  }
  async getGovProposalVotesVoter(_id: string, _voter: string) {
    return { vote: null };
  }
  async getParams(_subspace: string, _key: string) {
    return { param: null };
  }
  async getTxs(_query: string, _params: any, _page?: PageRequest, _limit?: number) {
    return { txs: [], tx_responses: [], pagination: emptyPage() };
  }
  async getTxsAt(_height: string | number) {
    return { txs: [], tx_responses: [], pagination: emptyPage() };
  }
  async getTx(_hash: string) {
    // TM2 /tx accepts base64 hash OR 0x+hex. Bare hex often fails.
    // Status may report tx_index=off but /tx still works on Topaz RPCs.
    const n = normalizeGnoTxHash(_hash);
    const attempts: string[] = [];
    if (n.b64) attempts.push(`/tx?hash=${encodeURIComponent(n.b64)}`);
    if (n.hex && n.hex.length === 64) {
      attempts.push(`/tx?hash=0x${n.hex}`);
      attempts.push(`/tx?hash=${encodeURIComponent(n.b64 || n.hex)}`);
    }
    if (n.raw && !attempts.length) attempts.push(`/tx?hash=${encodeURIComponent(n.raw)}`);

    for (const path of attempts) {
      try {
        const data = await tm2Get(this.endpoint, path);
        if (data?.error) continue;
        const adapted = adaptTm2Tx(data, n.hex);
        if (adapted?.tx_response?.txhash || adapted?.tx_response?.height) return adapted;
      } catch {
        /* try next form */
      }
    }
    return { tx: null, tx_response: null };
  }
  async getTxsBySender(_sender: string, _page?: PageRequest, _limit?: number) {
    return { txs: [], tx_responses: [], pagination: emptyPage() };
  }
  async getTxsByReceiver(_receiver: string, _page?: PageRequest, _limit?: number) {
    return { txs: [], tx_responses: [], pagination: emptyPage() };
  }
  async getIBCAppTransferDenom(_hash: string) {
    return { denom_trace: { path: '', base_denom: '' } };
  }
  async getIBCConnections(_page?: PageRequest) {
    return { connections: [], pagination: emptyPage() };
  }
  async getIBCConnectionsById(_id: string) {
    return { connection: null };
  }
  async getIBCConnectionsClientState(_id: string) {
    return { identified_client_state: null, proof: null, proof_height: null };
  }
  async getIBCConnectionsChannels(_id: string) {
    return { channels: [], pagination: emptyPage() };
  }
  async getIBCChannels(_page?: PageRequest) {
    return { channels: [], pagination: emptyPage() };
  }
  async getIBCClientStates(_page?: PageRequest) {
    return { client_states: [], pagination: emptyPage() };
  }
  async getIBCChannelAcknowledgements(_c: string, _p: string) {
    return { acknowledgements: [], pagination: emptyPage() };
  }
  async getIBCChannelNextSequence(_c: string, _p: string) {
    return { next_sequence_receive: '0' };
  }
  async getInterchainSecurityValidatorRotatedKey(_a: string, _b: string) {
    return { consumer_address: '' };
  }
  async getInterchainSecurityProviderOptedInValidators(_chain_id: string) {
    return { validators: [] };
  }
  async getInterchainSecurityConsumerValidators(_chain_id: string) {
    return { validators: [] };
  }
}
