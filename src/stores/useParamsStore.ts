import { defineStore } from 'pinia';
import { useBlockchain } from './useBlockchain';
import { percent, formatNumber, formatTokenAmount } from '@/libs/utils';

/**
 * Staking params payload — extended for atomone which adds
 * `key_rotation_fee` (a Coin, not on vanilla cosmos-sdk 0.45).
 */
export interface stakingItem {
  unbonding_time: string;
  max_validators: number;
  max_entries: number;
  historical_entries: number;
  bond_denom: string;
  min_commission_rate: string;
  max_commission_rate?: string;
  min_self_delegation?: string;
  key_rotation_fee?: { denom: string; amount: string };
}

/**
 * Grouped param card — `{title, items, subGroups?}` so the UI can render
 * one module as several semantic pills (e.g. Gov = Voting + Deposit + Tally)
 * instead of one flat dump that loses context.
 */
export interface ParamCard {
  title: string;
  module: string;
  items: Array<{ subtitle: string; value: any; kind?: string }>;
  subGroups?: Array<{ title: string; items: Array<{ subtitle: string; value: any; kind?: string }> }>;
  description?: string;
}

export const useParamStore = defineStore('paramstore', {
  state: () => ({
    latestTime: '',
    chain: {
      title: '',
      class: 'border-primary',
      items: [
        { subtitle: 'height', icon: 'BoxIcon', color: 'light-success', value: '-' },
        { subtitle: 'bonded_and_supply', icon: 'DollarSignIcon', color: 'light-danger', value: '-' },
        { subtitle: 'bonded_ratio', icon: 'PercentIcon', color: 'light-warning', value: '-' },
        { subtitle: 'inflation', icon: 'TrendingUpIcon', color: 'light-primary', value: '-' },
      ],
    },
    mint: { title: 'Mint Parameters', module: 'mint', items: [] as any[] } as ParamCard,
    staking: { title: 'Staking Parameters', module: 'staking', items: [] as any[] } as ParamCard,
    distribution: { title: 'Distribution Parameters', module: 'distribution', items: [] as any[] } as ParamCard,
    slashing: { title: 'Slashing Parameters', module: 'slashing', items: [] as any[] } as ParamCard,
    gov: { title: 'Governance Parameters', module: 'gov', items: [] as any[], subGroups: [] as any[] } as ParamCard,
    appVersion: { title: 'Application Version', items: [] as any[] },
    nodeVersion: { title: 'Node Information', items: [] as any[] },
    /** True if the module isn't present on this chain (mint on atomone
     *  returns "not implemented", tally returns unknown proto). Lets the
     *  page hide the card instead of showing a broken empty state. */
    modulesHidden: {
      mint: false,
      gov_tally: false,
    },
  }),
  getters: {
    blockchain() {
      return useBlockchain();
    },
  },
  actions: {
    initial() {
      this.handleBaseBlockLatest();
      this.handleMintParam();
      this.handleStakingParams();
      this.handleSlashingParams();
      this.handleDistributionParams();
      this.handleGovernanceParams();
      this.handleAbciInfo();
    },
    async handleBaseBlockLatest() {
      try {
        const res = await this.getBaseTendermintBlockLatest();
        const height = this.chain.items.findIndex((x) => x.subtitle === 'height');
        this.chain.title = `Chain ID: ${res.block.header.chain_id}`;
        this.chain.items[height].value = res.block.header.height;
        this.latestTime = res.block.header.time;
      } catch (error) {
        console.warn(error);
      }
    },

    /**
     * Staking — split into "General" + "Bond" sub-groups because the
     * `key_rotation_fee` Coin object (atomone-specific) doesn't sit well
     * alongside raw integers like `max_validators`.
     */
    async handleStakingParams() {
      const res = await this.getStakingParams();
      if (!res?.params) return;
      const p = res.params;
      const bond_denom = p.bond_denom;
      const generalItems: any[] = [];
      const bondItems: any[] = [];
      // Group + tag so the UI knows how to render each value.
      const tag = (k: string, v: any, kind?: string) => ({ subtitle: k, value: v, kind });
      generalItems.push(tag('unbonding_time', p.unbonding_time, 'duration'));
      generalItems.push(tag('max_validators', p.max_validators, 'integer'));
      generalItems.push(tag('max_entries', p.max_entries, 'integer'));
      generalItems.push(tag('historical_entries', p.historical_entries, 'integer'));
      bondItems.push(tag('bond_denom', bond_denom, 'denom'));
      if (p.min_commission_rate !== undefined) bondItems.push(tag('min_commission_rate', p.min_commission_rate, 'percent'));
      if (p.max_commission_rate !== undefined) bondItems.push(tag('max_commission_rate', p.max_commission_rate, 'percent'));
      if (p.min_self_delegation) bondItems.push(tag('min_self_delegation', p.min_self_delegation, 'coin'));
      if (p.key_rotation_fee) bondItems.push(tag('key_rotation_fee', p.key_rotation_fee, 'coin'));
      this.staking.items = generalItems;
      this.staking.subGroups = [{ title: 'Bond config', items: bondItems }];

      Promise.all([this.getStakingPool(), this.getBankTotal(bond_denom)]).then((resArr) => {
        const pool = resArr[0]?.pool;
        const amount = resArr[1]?.amount?.amount;
        const assets = this.blockchain.current?.assets;
        const bondedAndSupply = this.chain.items.findIndex((x) => x.subtitle === 'bonded_and_supply');
        this.chain.items[bondedAndSupply].value = `${formatNumber(
          formatTokenAmount(assets, pool.bonded_tokens, 2, bond_denom, false),
          true,
          0
        )}/${formatNumber(formatTokenAmount(assets, amount, 2, bond_denom, false), true, 0)}`;
        const bondedRatio = this.chain.items.findIndex((x) => x.subtitle === 'bonded_ratio');
        this.chain.items[bondedRatio].value = `${percent(Number(pool.bonded_tokens) / Number(amount))}%`;
      });
    },

    /**
     * Mint — many chains (atomone included) disable this module. We probe
     * and gracefully mark the card as hidden so the UI can drop it
     * entirely instead of rendering an empty section.
     */
    async handleMintParam() {
      const excludes = this.blockchain.current?.excludes;
      if (excludes && excludes.indexOf('mint') > -1) return;
      try {
        const res = await this.getMintParam();
        if (!res?.params) {
          this.modulesHidden.mint = true;
          return;
        }
        const p = res.params;
        const items: any[] = [];
        if (p.mint_denom) items.push({ subtitle: 'mint_denom', value: p.mint_denom, kind: 'denom' });
        if (p.inflation_rate_change !== undefined) items.push({ subtitle: 'inflation_rate_change', value: p.inflation_rate_change, kind: 'percent' });
        if (p.inflation_max !== undefined) items.push({ subtitle: 'inflation_max', value: p.inflation_max, kind: 'percent' });
        if (p.inflation_min !== undefined) items.push({ subtitle: 'inflation_min', value: p.inflation_min, kind: 'percent' });
        if (p.goal_bonded !== undefined) items.push({ subtitle: 'goal_bonded', value: p.goal_bonded, kind: 'percent' });
        if (p.blocks_per_year !== undefined) items.push({ subtitle: 'blocks_per_year', value: p.blocks_per_year, kind: 'integer' });
        this.mint.items = items;
      } catch (e: any) {
        // atomone returns 'not implemented' — mark hidden.
        this.modulesHidden.mint = true;
      }
    },

    /**
     * Slashing — split into "Windows" (block windows + jail duration) and
     * "Penalties" (slash fractions). Lets the reader see at a glance what
     * the punishment regime looks like.
     */
    async handleSlashingParams() {
      const res = await this.getSlashingParams();
      if (!res?.params) return;
      const p = res.params;
      const tag = (k: string, v: any, kind?: string) => ({ subtitle: k, value: v, kind });
      const windows = [
        tag('signed_blocks_window', p.signed_blocks_window, 'integer'),
        tag('min_signed_per_window', p.min_signed_per_window, 'percent'),
        tag('downtime_jail_duration', p.downtime_jail_duration, 'duration'),
      ];
      const penalties = [
        tag('slash_fraction_double_sign', p.slash_fraction_double_sign, 'percent'),
        tag('slash_fraction_downtime', p.slash_fraction_downtime, 'percent'),
      ];
      // Keep any future fields visible too.
      const known = new Set([
        'signed_blocks_window', 'min_signed_per_window', 'downtime_jail_duration',
        'slash_fraction_double_sign', 'slash_fraction_downtime',
      ]);
      Object.entries(p).forEach(([k, v]) => {
        if (!known.has(k)) windows.push(tag(k, v, typeof v === 'number' ? 'integer' : undefined));
      });
      this.slashing.items = windows;
      this.slashing.subGroups = [{ title: 'Slash fractions', items: penalties }];
    },

    /**
     * Distribution — atomone adds `nakamoto_bonus` (an object, not in
     * vanilla SDK). Render it as its own sub-card so the boolean + nested
     * coefs are legible instead of one flattened key/value dump.
     */
    async handleDistributionParams() {
      const res = await this.getDistributionParams();
      if (!res?.params) return;
      const p = res.params;
      const tag = (k: string, v: any, kind?: string) => ({ subtitle: k, value: v, kind });
      const general: any[] = [];
      if (p.community_tax !== undefined) general.push(tag('community_tax', p.community_tax, 'percent'));
      if (p.withdraw_addr_enabled !== undefined) general.push(tag('withdraw_addr_enabled', p.withdraw_addr_enabled, 'boolean'));
      if (p.base_proposer_reward !== undefined) general.push(tag('base_proposer_reward', p.base_proposer_reward, 'percent'));
      if (p.bonus_proposer_reward !== undefined) general.push(tag('bonus_proposer_reward', p.bonus_proposer_reward, 'percent'));
      // Keep unknown flat fields too (future-proof).
      const known = new Set([
        'community_tax', 'withdraw_addr_enabled', 'base_proposer_reward', 'bonus_proposer_reward', 'nakamoto_bonus',
      ]);
      Object.entries(p).forEach(([k, v]) => {
        if (!known.has(k)) general.push(tag(k, v));
      });
      this.distribution.items = general;
      // nakamoto_bonus is atomone-specific and structured — render as a sub-card.
      if (p.nakamoto_bonus) {
        const nb = p.nakamoto_bonus;
        const nbItems: any[] = [];
        if (nb.enabled !== undefined) nbItems.push(tag('enabled', nb.enabled, 'boolean'));
        if (nb.step !== undefined) nbItems.push(tag('step', nb.step, 'percent'));
        if (nb.period_epoch_identifier) nbItems.push(tag('period_epoch_identifier', nb.period_epoch_identifier));
        if (nb.minimum_coefficient !== undefined) nbItems.push(tag('minimum_coefficient', nb.minimum_coefficient, 'percent'));
        if (nb.maximum_coefficient !== undefined) nbItems.push(tag('maximum_coefficient', nb.maximum_coefficient, 'percent'));
        // Surface anything new atomone adds in a future upgrade.
        const knownNb = new Set(['enabled', 'step', 'period_epoch_identifier', 'minimum_coefficient', 'maximum_coefficient']);
        Object.entries(nb).forEach(([k, v]) => {
          if (!knownNb.has(k)) nbItems.push(tag(k, v));
        });
        this.distribution.subGroups = [{ title: 'Nakamoto bonus', items: nbItems }];
      }
    },

    /**
     * Gov — the three sub-params (voting / deposit / tally) live on
     * separate endpoints and aren't semantically one blob. Split them
     * so the page can render 3 pills instead of one mashed list. Atomone
     * returns 'unknown params type: tally' on the tally endpoint — hide
     * that sub-group if so.
     */
    async handleGovernanceParams() {
      const excludes = this.blockchain.current?.excludes;
      if (excludes && excludes.indexOf('governance') > -1) return;
      const subGroups: { title: string; items: any[] }[] = [];
      const tag = (k: string, v: any, kind?: string) => ({ subtitle: k, value: v, kind });
      // Voting
      try {
        const r = await this.getGovParamsVoting();
        const vp = r?.voting_params || {};
        const items: any[] = [];
        if (vp.voting_period) items.push(tag('voting_period', vp.voting_period, 'duration'));
        if (items.length) subGroups.push({ title: 'Voting', items });
      } catch (e) { /* keep empty */ }
      // Deposit
      try {
        const r = await this.getGovParamsDeposit();
        const dp = r?.deposit_params || {};
        const items: any[] = [];
        if (dp.min_deposit) items.push(tag('min_deposit', dp.min_deposit, 'coinlist'));
        if (dp.max_deposit_period) items.push(tag('max_deposit_period', dp.max_deposit_period, 'duration'));
        if (items.length) subGroups.push({ title: 'Deposit', items });
      } catch (e) { /* keep empty */ }
      // Tally — many chains (atomone) return unknown proto. Hide if so.
      try {
        const r = await this.getGovParamsTally();
        const tp = r?.tally_params || {};
        const items: any[] = [];
        if (tp.quorum !== undefined) items.push(tag('quorum', tp.quorum, 'percent'));
        if (tp.threshold !== undefined) items.push(tag('threshold', tp.threshold, 'percent'));
        if (tp.veto_threshold !== undefined) items.push(tag('veto_threshold', tp.veto_threshold, 'percent'));
        if (items.length) subGroups.push({ title: 'Tally', items });
        else this.modulesHidden.gov_tally = true;
      } catch (e) {
        this.modulesHidden.gov_tally = true;
      }
      // Don't keep an empty top-level `items` — render via subGroups only.
      this.gov.items = [];
      this.gov.subGroups = subGroups;
    },
    async handleAbciInfo() {
      try {
        const res = await this.fetchAbciInfo();
        if (!res) return;
        localStorage.setItem(`sdk_version_${this.blockchain.chainName}`, res.application_version?.cosmos_sdk_version);
        // Build deps are an array of {path, version, sum} — flatten those
        // too so each row in the UI is a key/value pair.
        const flatAppVersion: Array<{ subtitle: string; value: any }> = [];
        Object.entries(res.application_version || {}).forEach(([key, value]) => {
          if (key === 'build_deps' && Array.isArray(value)) {
            value.forEach((dep: any, idx: number) => {
              flatAppVersion.push({ subtitle: `build_deps.${idx}.path`, value: dep.path });
              if (dep.version) flatAppVersion.push({ subtitle: `build_deps.${idx}.version`, value: dep.version });
              if (dep.sum) flatAppVersion.push({ subtitle: `build_deps.${idx}.sum`, value: dep.sum });
            });
          } else {
            flatAppVersion.push({ subtitle: key, value });
          }
        });
        this.appVersion.items = flatAppVersion;
        // Node info: protocol_version is nested, other is an object, version
        // fields can be big strings. Flatten everything to key/value rows.
        const flatNodeVersion: Array<{ subtitle: string; value: any }> = [];
        const ni = res.default_node_info || {};
        if (ni.protocol_version) {
          flatNodeVersion.push({ subtitle: 'protocol_version.p2p', value: ni.protocol_version.p2p });
          flatNodeVersion.push({ subtitle: 'protocol_version.block', value: ni.protocol_version.block });
          flatNodeVersion.push({ subtitle: 'protocol_version.app', value: ni.protocol_version.app });
        }
        if (ni.network) flatNodeVersion.push({ subtitle: 'network', value: ni.network });
        if (ni.moniker) flatNodeVersion.push({ subtitle: 'moniker', value: ni.moniker });
        if (ni.version) flatNodeVersion.push({ subtitle: 'version', value: ni.version });
        if (ni.default_node_id) flatNodeVersion.push({ subtitle: 'default_node_id', value: ni.default_node_id });
        if (ni.listen_addr) flatNodeVersion.push({ subtitle: 'listen_addr', value: ni.listen_addr });
        if (ni.channels) flatNodeVersion.push({ subtitle: 'channels', value: ni.channels });
        if (ni.other && typeof ni.other === 'object') {
          Object.entries(ni.other).forEach(([k, v]) => flatNodeVersion.push({ subtitle: `other.${k}`, value: v }));
        }
        this.nodeVersion.items = flatNodeVersion;
      } catch (e) {
        console.warn(e);
      }
    },
    async getBaseTendermintBlockLatest() {
      return await this.blockchain.rpc?.getBaseBlockLatest();
    },
    async getMintParam() {
      return await this.blockchain.rpc?.getMintParam();
    },
    async getStakingParams() {
      return await this.blockchain.rpc?.getStakingParams();
    },
    async getStakingPool() {
      return await this.blockchain.rpc?.getStakingPool();
    },
    async getBankTotal(denom: string) {
      return await this.blockchain.rpc?.getBankSupplyByDenom(denom);
      // if (compareVersions(this.config.sdk_version, '0.46.2') > 0) {
      //     return this.get(`/cosmos/bank/v1beta1/supply/by_denom?denom=${denom}`).then(data => commonProcess(data).amount)
      //   }
      //   if (compareVersions(this.config.sdk_version, '0.40') < 0) {
      //     return this.get(`/supply/total/${denom}`).then(data => ({ amount: commonProcess(data), denom }))
      //   }
      //   return this.get(`/cosmos/bank/v1beta1/supply/${denom}`).then(data => commonProcess(data).amount)
    },
    async getSlashingParams() {
      return await this.blockchain.rpc?.getSlashingParams();
    },
    async getDistributionParams() {
      return await this.blockchain.rpc?.getDistributionParams();
    },
    async getGovParamsVoting() {
      return await this.blockchain.rpc?.getGovParamsVoting();
    },
    async getGovParamsDeposit() {
      return await this.blockchain.rpc?.getGovParamsDeposit();
    },
    async getGovParamsTally() {
      return await this.blockchain.rpc?.getGovParamsTally();
    },
    async fetchAbciInfo() {
      return this.blockchain.rpc?.getBaseNodeInfo();
    },
  },
});
