import { defineStore } from 'pinia';
import { useBlockchain } from '@/stores';
import { decodeTxRaw, type DecodedTxRaw } from '@cosmjs/proto-signing';
import dayjs from 'dayjs';
import type { Block } from '@/types';
import { hashTx } from '@/libs';
import { fromBase64 } from '@cosmjs/encoding';

const FETCH_ALL_BLOCKS = String(import.meta.env.VITE_FETCH_ALL_BLOCKS || '').toLowerCase() === 'true';
const RECENT_BLOCKS_LIMIT = Math.max(1, Number(import.meta.env.VITE_RECENT_BLOCK_LIMIT || 50) || 50);

export const useBaseStore = defineStore('baseStore', {
  state: () => {
    return {
      earliest: {} as Block,
      latest: {} as Block,
      recents: [] as Block[],
      theme: (window.localStorage.getItem('theme') || 'dark') as 'light' | 'dark',
      connected: false,
      // Set true on first successful block fetch; reset on chain change.
      // Lets the UI tell "still connecting" (neutral) from "was up, now
      // dropped" (red) instead of flashing a scary 'disconnected' on load.
      hasConnectedOnce: false,
    };
  },
  getters: {
    blocktime(): number {
      if (this.earliest && this.latest) {
        if (this.latest.block?.header?.height !== this.earliest.block?.header?.height) {
          const diff = dayjs(this.latest.block?.header?.time).diff(this.earliest.block?.header?.time);
          const blocks = Number(this.latest.block.header.height) - Number(this.earliest.block.header.height);
          return Math.round(diff / blocks);
        }
      }
      return 1000; // better to start low and increase
    },
    blockchain() {
      return useBlockchain();
    },
    hasRpc(): boolean {
      return this.blockchain?.rpc as unknown as boolean;
    },
    currentChainId(): string {
      return this.latest.block?.header.chain_id || '';
    },
    txsInRecents() {
      const txs = [] as {
        height: string;
        hash: string;
        tx: DecodedTxRaw;
      }[];
      this.recents.forEach((b) =>
        b.block?.data?.txs.forEach((tx: string) => {
          if (tx) {
            const raw = fromBase64(tx);
            try {
              txs.push({
                height: b.block.header.height,
                hash: hashTx(raw),
                tx: decodeTxRaw(raw),
              });
            } catch (e) {
              console.error(e);
            }
          }
        })
      );
      return txs.sort((a, b) => {
        return Number(b.height) - Number(a.height);
      });
    },
  },
  actions: {
    async initial() {
      // Drop previous chain's height immediately so navbar doesn't show stale #
      this.resetBlockState();
      // Wait for the RPC client to be wired up — but bounded. If endpoint setup
      // fails we must NOT spin forever (that froze the page until hard-refresh).
      let waited = 0;
      while (!this.hasRpc && waited < 12000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        waited += 250;
      }
      if (!this.hasRpc) {
        console.warn('[baseStore] RPC not ready after 12s — giving up initial block poll');
        return;
      }
      await this.fetchLatest();
    },
    resetBlockState() {
      this.earliest = {} as Block;
      this.latest = {} as Block;
      this.recents = [];
      this.connected = false;
      this.hasConnectedOnce = false;
    },
    async clearRecentBlocks() {
      this.recents = [];
    },
    async fetchLatest() {
      if (!this.hasRpc) return this.latest;
      try {
        const next = await this.blockchain.rpc?.getBaseBlockLatest();
        if (next?.block?.header?.height) {
          // Only advance (or accept first / chain change) — avoid regressions from lagging RPC
          const prevH = Number(this.latest?.block?.header?.height || 0);
          const nextH = Number(next.block.header.height);
          const prevChain = this.latest?.block?.header?.chain_id;
          const nextChain = next.block.header.chain_id;
          if (!prevH || prevChain !== nextChain || nextH >= prevH) {
            this.latest = next;
          }
          this.connected = true;
          this.hasConnectedOnce = true;
          // Clear degraded UI once blocks flow again
          if (this.blockchain.connPhase !== 'ok') {
            this.blockchain.connPhase = 'ok';
            this.blockchain.connErr = '';
            this.blockchain.fallbackAttempts = 0;
          }
        }
      } catch (error) {
        console.error('Error fetching latest block:', error);
        this.connected = false;
        // Silent auto-rotate — user never picks an RPC
        this.blockchain.fallbackEndpoint({ reason: 'latest-fail' });
      }
      if (!this.earliest?.block?.header?.height || this.earliest?.block?.header?.chain_id != this.latest?.block?.header?.chain_id) {
        //reset earliest and recents
        this.earliest = this.latest;
        this.recents = [];
      }
      //check if the block exists in recents
      if (
        this.latest?.block_id?.hash &&
        this.recents.findIndex((x) => x?.block_id?.hash === this.latest?.block_id?.hash) === -1
      ) {
        const newBlocks = await this.fetchNewBlocks();
        const combined = [...this.recents, ...newBlocks];
        this.recents = combined.slice(-RECENT_BLOCKS_LIMIT);
      }
      return this.latest;
    },
    /**
     * Fetches all blocks since the last block in recents.
     * Only fetches blocks with height greater than this.recents[-1].block.header.height.
     * Returns an array of new blocks to be added to recents.
     */
    async fetchNewBlocks() {
      if (!this.latest?.block?.header?.height) return [];
      if (!FETCH_ALL_BLOCKS) return [this.latest];
      const oldHeight = Number(this.recents[this.recents.length - 1]?.block?.header?.height);
      const newHeight = Number(this.latest.block.header.height);
      let newBlocks = [];
      // Fetch all blocks between oldHeight+1 and less than newHeight
      for (let h = oldHeight + 1; h < newHeight; h++) {
        const block = await this.fetchBlock(h);
        if (!block?.block?.header?.height) continue; // skip if block not found
        newBlocks.push(block);
      }
      // Add the latest block
      newBlocks.push(this.latest);
      return newBlocks;
    },
    async fetchValidatorByHeight(height?: number, offset = 0) {
      try {
        return await this.blockchain.rpc.getBaseValidatorsetAt(String(height), offset);
      } catch (error: any) {
        // Pruned LCDs frequently 500/404 on historical validatorsets.
        console.warn('[base] validatorset@height:', error?.message || error);
        return { validators: [], pagination: {} } as any;
      }
    },
    async fetchLatestValidators(offset = 0) {
      try {
        return await this.blockchain.rpc.getBaseValidatorsetLatest(offset);
      } catch (error: any) {
        console.warn('[base] validatorset/latest:', error?.message || error);
        return { validators: [], pagination: {} } as any;
      }
    },
    async fetchBlock(height?: number | string) {
      try {
        // Active REST first; on miss (pruned height) walk archive/non-pruned list.
        // fetchHistoricalBlock does NOT permanently switch the live endpoint.
        const block =
          (await this.blockchain.fetchHistoricalBlock(String(height))) ||
          (await this.blockchain.rpc.getBaseBlockAt(String(height)));
        if (block && (block as any).block?.header?.height) {
          this.connected = true;
          this.hasConnectedOnce = true;
          return block as Block;
        }
      } catch (error) {
        console.error('Error fetching block:', error);
        this.connected = false;
        // Liveness fallback only — archive walk already tried above.
        // Auto-rotate; never ask the user to pick an endpoint.
        this.blockchain.fallbackEndpoint({ reason: 'block-fail' });
      }
      return {} as Block;
    },
    async fetchAbciInfo() {
      return this.blockchain.rpc.getBaseNodeInfo();
    },
    // async fetchNodeInfo() {
    //     return this.blockchain.rpc.no()
    // }
  },
});
