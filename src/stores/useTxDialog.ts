import { defineStore } from 'pinia';
import { nextTick } from 'vue';
import { useWalletStore } from './useWalletStore';
import { useBlockchain } from './useBlockchain';
import router from '@/router';

let CALLBACK: any = null;

/**
 * Programmatically open the daisyUI modal checkbox inside <ping-tx-dialog>.
 * Must run AFTER Vue has flushed :type / :params onto the custom element —
 * otherwise initial() reads a stale validator_address / proposal_id (wrong val A→B).
 */
function openModalCheckbox(type: string, attempt = 0) {
  const el = document.getElementById(type) as HTMLInputElement | null;
  if (!el) {
    // :key remount of <ping-tx-dialog> can lag a frame — retry briefly.
    if (attempt < 8) {
      setTimeout(() => openModalCheckbox(type, attempt + 1), 16 * (attempt + 1));
    }
    return;
  }
  const fire = () => el.dispatchEvent(new Event('change', { bubbles: true }));
  if (el.checked) {
    // Re-open so form.initial() re-runs with the latest params.
    el.checked = false;
    fire();
    nextTick(() => {
      el.checked = true;
      fire();
    });
  } else {
    el.checked = true;
    fire();
  }
}

export const useTxDialog = defineStore('txDialogStore', {
  state: () => {
    return {
      sender: '',
      type: 'send',
      endpoint: '',
      params: '',
      /** Bumps on every open so <ping-tx-dialog :key> remounts clean form state. */
      nonce: 0,
    };
  },
  getters: {
    walletAddress() {
      return useWalletStore().currentAddress;
    },
    currentEndpoint() {
      return useBlockchain().endpoint?.address;
    },
    blockchain() {
      return useBlockchain();
    },
    hdPaths() {
      return useBlockchain().defaultHDPath;
    },
    /** Stable key for remounting the CE when type/params change. */
    instanceKey(): string {
      return `${this.type}::${this.nonce}`;
    },
  },
  actions: {
    setParams(param: any) {
      this.params = JSON.stringify(param ?? {});
    },
    openWithArgument(
      type: string,
      sender: string,
      endpoint: string,
      param: any
    ) {
      this.type = type;
      this.sender = sender;
      this.endpoint = endpoint;
      this.params = JSON.stringify(param ?? {});
      this.nonce += 1;
      nextTick(() => nextTick(() => openModalCheckbox(type)));
    },
    /**
     * Open a tx dialog with explicit message params.
     * Callers MUST pass the target identity in `param` (e.g. validator_address,
     * proposal_id). Do NOT use <label for="delegate"> — that races the checkbox
     * change handler ahead of Vue prop flush and can show the wrong validator.
     * Use a <button @click="dialog.open(...)"> instead.
     */
    open(type: string, param: any = {}, callback?: Function) {
      const safe =
        param && typeof param === 'object' && !Array.isArray(param) ? { ...param } : {};
      // Normalize common ids to strings so CE JSON.parse always sees primitives.
      if (safe.validator_address != null) {
        safe.validator_address = String(safe.validator_address);
      }
      if (safe.proposal_id != null) {
        safe.proposal_id = String(safe.proposal_id);
      }
      this.type = type;
      this.sender = this.walletAddress;
      this.endpoint = this.currentEndpoint || '';
      this.params = JSON.stringify(safe);
      this.nonce += 1;
      if (callback) {
        CALLBACK = callback;
      } else {
        CALLBACK = undefined;
      }
      // Double nextTick: (1) pinia→TxDialog props (2) CE attribute apply + :key remount
      nextTick(() => nextTick(() => openModalCheckbox(type)));
    },
    view(tx: {
      detail: {
        eventType: string;
        hash: string;
      };
    }) {
      console.log(tx.detail);
      if (tx.detail && tx.detail.hash)
        router.push({ path: `/${this.blockchain.chainName}/tx/${tx.detail.hash}` });
    },
    confirmed(tx: any) {
      console.log('confirmed:', tx);
      if (CALLBACK) {
        CALLBACK();
      }
    },
  },
});
