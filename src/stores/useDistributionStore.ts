import { defineStore } from 'pinia';
import { useBlockchain } from './useBlockchain';

export const useDistributionStore = defineStore('distributionStore', {
  state: () => {
    return {
      params: {} as {
        community_tax: string;
        base_proposer_reward: string;
        bonus_proposer_reward: string;
        withdraw_addr_enabled: boolean;
      },
    };
  },
  getters: {
    blockchain() {
      return useBlockchain();
    },
  },
  actions: {
    initial() {
      this.fetchParams();
    },
    async fetchParams() {
      try {
        const response = await this.blockchain.rpc?.getDistributionParams();
        if (response?.params) this.params = response.params;
      } catch (e: any) {
        console.warn('[distribution] params:', e?.message || e);
      }
      return this.params;
    },
    async fetchCommunityPool() {
      try {
        return await this.blockchain.rpc?.getDistributionCommunityPool();
      } catch (e: any) {
        console.warn('[distribution] communityPool:', e?.message || e);
        return { pool: [] } as any;
      }
    },
  },
});
