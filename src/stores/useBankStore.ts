import { defineStore } from 'pinia';

import { useBlockchain } from './useBlockchain';
import { useStakingStore } from './useStakingStore';
import type { Coin, DenomTrace } from '@/types';

export const useBankStore = defineStore('bankstore', {
  state: () => {
    return {
      supply: {} as Coin,
      balances: {} as Record<string, Coin[]>,
      totalSupply: { supply: [] as Coin[] },
      ibcDenoms: {} as Record<string, DenomTrace>,
    };
  },
  getters: {
    blockchain() {
      return useBlockchain();
    },
    staking() {
      return useStakingStore();
    },
  },
  actions: {
    initial() {
      this.$reset();
      this.supply = {} as Coin;
      const denom = this.staking.params.bond_denom || this.blockchain.current?.assets[0].base;
      if (denom) {
        // Some LCDs 500/501 on /supply/{denom} (Pocket, pruned nodes). Soft-fail.
        // rpc may be unresolved on first paint (async setCurrent) — optional-chain
        // both the client and the promise so a late engine can't unhandled-reject.
        this.blockchain.rpc
          ?.getBankSupplyByDenom(denom)
          ?.then((res) => {
            if (res.amount) this.supply = res.amount;
          })
          ?.catch((e: any) => console.warn('[bank] supply:', e?.message || e));
      }
    },
    async fetchSupply(denom: string) {
      try {
        return await this.blockchain.rpc?.getBankSupplyByDenom(denom);
      } catch (e: any) {
        console.warn('[bank] fetchSupply:', e?.message || e);
        return { amount: { amount: '0', denom } } as any;
      }
    },
    async fetchDenomTrace(denom: string) {
      const hash = denom.replace('ibc/', '');
      let trace = this.ibcDenoms[hash];
      if (!trace) {
        // Same soft-fail as useFormatter: legacy /denom_traces/{hash} 501s on
        // ibc-go v8 chains and callers don't always await.
        try {
          trace = (await this.blockchain.rpc.getIBCAppTransferDenom(hash)).denom_trace;
          this.ibcDenoms[hash] = trace;
        } catch (e: any) {
          console.warn('[bank] denom trace unavailable:', hash, e?.message || e);
          return undefined;
        }
      }
      return trace;
    },
  },
});
