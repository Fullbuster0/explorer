import { defineStore } from 'pinia';
import { useBlockchain } from './useBlockchain';
import { useStorageStore } from './useStorageStore';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import type { Delegation, Coin, UnbondingResponses, DelegatorRewards, WalletConnected } from '@/types';
import { useStakingStore } from './useStakingStore';
import router from '@/router';
import { decryptWallet } from '@/utils/crypto';

/**
 * Persist only the public connection metadata (address + wallet name + hdPath).
 * Never store mnemonic/private keys here — signing stays in the extension.
 *
 * Honour storage preference: session mode must NOT leak into localStorage
 * (previous dual-write defeated the "Persist session" toggle).
 */
function persistConnectedWallet(key: string, value: WalletConnected, storage: Storage) {
  // Allowlist fields — drop anything unexpected from a compromised widget event
  const safe: WalletConnected = {
    // @ts-ignore — WalletConnected shape
    cosmosAddress: value.cosmosAddress,
    // @ts-ignore
    hdPath: value.hdPath,
    // @ts-ignore
    wallet: value.wallet,
  };
  if (!(safe as any).cosmosAddress) return;
  const plaintext = JSON.stringify(safe);
  storage.setItem(key, plaintext);
  // Mirror to the other store only when user opted into durable local persistence
  if (storage === localStorage) {
    // durable mode: primary is localStorage (already set)
  } else {
    // session mode: ensure localStorage copy is cleared so a shared PC
    // doesn't keep the address after the tab closes
    localStorage.removeItem(key);
  }
}

export const useWalletStore = defineStore('walletStore', {
  state: () => {
    return {
      balances: [] as Coin[],
      delegations: [] as Delegation[],
      unbonding: [] as UnbondingResponses[],
      rewards: { total: [], rewards: [] } as DelegatorRewards,
      wallet: {} as WalletConnected,
      // Tracks which sources have completed their first fetch — separates
      // "loading" (… placeholder) from "loaded & 0" (real zero).
      loadedBalances: false,
      loadedDelegations: false,
      loadedUnbonding: false,
      loadedRewards: false,
    };
  },
  getters: {
    blockchain() {
      return useBlockchain();
    },
    connectedWallet() {
      // @ts-ignore
      if (this.wallet.cosmosAddress) return this.wallet;
      const chainStore = useBlockchain();
      const key = chainStore.defaultHDPath;
      const storageStore = useStorageStore();
      const storage = storageStore.currentStorage;
      const raw = storage.getItem(key) || localStorage.getItem(key);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.cosmosAddress || parsed?.hdPath) {
          persistConnectedWallet(key, parsed, storage);
          return parsed;
        }
      } catch {
        // not plaintext JSON, try decrypting
      }
      const decrypted = decryptWallet(raw);
      try {
        const parsed = JSON.parse(decrypted);
        persistConnectedWallet(key, parsed, storage);
        return parsed;
      } catch {
        return {};
      }
    },
    balanceOfStakingToken(): Coin {
      const stakingStore = useStakingStore();
      return (
        this.balances.find((x) => x.denom === stakingStore.params.bond_denom) || {
          amount: '0',
          denom: stakingStore.params.bond_denom,
        }
      );
    },
    stakingAmount() {
      const stakingStore = useStakingStore();
      let amt = 0;
      let denom = stakingStore.params.bond_denom;
      this.delegations.forEach((i) => {
        amt += Number(i.balance.amount);
        denom = i.balance.denom;
      });
      return { amount: String(amt), denom };
    },
    rewardAmount() {
      const stakingStore = useStakingStore();
      // @ts-ignore
      const reward = this.rewards.total?.find((x: Coin) => x.denom === stakingStore.params.bond_denom);
      return reward || { amount: '0', denom: stakingStore.params.bond_denom };
    },
    unbondingAmount() {
      let amt = 0;
      this.unbonding.forEach((i) => {
        i.entries.forEach((e) => {
          amt += Number(e.balance);
        });
      });

      const stakingStore = useStakingStore();
      return { amount: String(amt), denom: stakingStore.params.bond_denom };
    },
    currentAddress() {
      if (!this.connectedWallet?.cosmosAddress) return '';
      const { prefix, data } = fromBech32(this.connectedWallet.cosmosAddress);
      const chainStore = useBlockchain();
      return toBech32(chainStore.current?.bech32Prefix || prefix, data);
    },
    shortAddress() {
      const address: string = this.currentAddress;
      if (address.length > 4) {
        return `${address.substring(address.length - 4)}`;
      }
      return '';
    },
  },
  actions: {
    async loadMyAsset() {
      if (!this.currentAddress) return;
      // Soft-fail each source so a single LCD miss doesn't leave portfolio hanging
      // or throw uncaught rejections after connect.
      this.blockchain.rpc
        .getBankBalances(this.currentAddress)
        .then((x) => {
          this.balances = x.balances;
          this.loadedBalances = true;
        })
        .catch((e: any) => {
          console.warn('[wallet] balances:', e?.message || e);
          this.balances = [];
          this.loadedBalances = true;
        });
      this.blockchain.rpc
        .getStakingDelegations(this.currentAddress)
        .then((x) => {
          this.delegations = x.delegation_responses;
          this.loadedDelegations = true;
        })
        .catch((e: any) => {
          console.warn('[wallet] delegations:', e?.message || e);
          this.delegations = [];
          this.loadedDelegations = true;
        });
      this.blockchain.rpc
        .getStakingDelegatorUnbonding(this.currentAddress)
        .then((x) => {
          this.unbonding = x.unbonding_responses;
          this.loadedUnbonding = true;
        })
        .catch((e: any) => {
          console.warn('[wallet] unbonding:', e?.message || e);
          this.unbonding = [];
          this.loadedUnbonding = true;
        });
      this.blockchain.rpc
        .getDistributionDelegatorRewards(this.currentAddress)
        .then((x) => {
          this.rewards = x;
          this.loadedRewards = true;
        })
        .catch((e: any) => {
          console.warn('[wallet] rewards:', e?.message || e);
          this.rewards = { total: [], rewards: [] } as any;
          this.loadedRewards = true;
        });
    },
    myBalance() {
      return this.blockchain.rpc.getBankBalances(this.currentAddress);
    },
    myDelegations() {
      return this.blockchain.rpc.getStakingDelegations(this.currentAddress);
    },
    myUnbonding() {
      return this.blockchain.rpc.getStakingDelegatorUnbonding(this.currentAddress);
    },
    disconnect() {
      const chainStore = useBlockchain();
      const key = chainStore.defaultHDPath;
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
      this.$reset();
    },
    setConnectedWallet(value: WalletConnected) {
      if (!value || !(value as any).cosmosAddress) return;
      // Reject payloads that look like they carry secrets (defense in depth)
      const raw = JSON.stringify(value);
      if (/mnemonic|privateKey|privKey|seedPhrase|\"seed\"/i.test(raw)) {
        console.error('[wallet] refused connect payload that looks like it contains secrets');
        return;
      }
      const chainStore = useBlockchain();
      const key = chainStore.defaultHDPath;
      const storageStore = useStorageStore();
      const storage = storageStore.currentStorage;
      persistConnectedWallet(key, value, storage);
      if (storageStore.isSession) {
        localStorage.removeItem(key);
      } else {
        sessionStorage.removeItem(key);
      }
      this.wallet = {
        cosmosAddress: (value as any).cosmosAddress,
        hdPath: (value as any).hdPath,
        wallet: (value as any).wallet,
      } as WalletConnected;
      this.loadMyAsset();
    },
    suggestChain() {
      if (window.location.pathname === '/SIDE-Testnet') {
        router.push({ path: '/wallet/unisat' });
      } else {
        router.push({ path: '/wallet/keplr' });
      }
    },
  },
});
