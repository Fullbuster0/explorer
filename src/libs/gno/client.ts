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
} from './tm2';

function emptyPage() {
  return { next_key: undefined as string | undefined, total: '0' };
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
    if (this._vals.length) p.params.max_validators = Math.max(p.params.max_validators, this._vals.length);
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
  async getBankBalances(_address: string) {
    return { balances: [], pagination: emptyPage() };
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
  async getAuthAccount(_address: string) {
    return { account: null };
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
    // TM2: /tx?hash=0x...  (may 400 if tx_index=off — most public Gno RPCs have tx_index off)
    try {
      const raw = String(_hash || '').replace(/^0x/i, '');
      const data = await tm2Get(this.endpoint, `/tx?hash=0x${raw}`);
      return data?.result || data;
    } catch {
      return { tx: null, tx_response: null };
    }
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
