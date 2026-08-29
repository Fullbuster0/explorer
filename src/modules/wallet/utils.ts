import { useDashboard } from '@/stores';
import type { Coin } from '@/types';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { decryptWallet } from '@/utils/crypto';

export interface AccountEntry {
  chainName: string;
  logo: string;
  address: string;
  coinType: string;
  endpoint?: string;
  compatiable?: boolean;
}

export interface LocalKey {
  cosmosAddress: string;
  hdPath: string;
}

export function scanLocalKeys() {
  const connected = [] as LocalKey[];
  const storages = [localStorage, sessionStorage];
  storages.forEach((storage) => {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith('m/44')) {
        const raw = storage.getItem(key) || '';
        let wallet: LocalKey;
        try {
          wallet = JSON.parse(raw);
        } catch {
          try {
            wallet = JSON.parse(decryptWallet(raw));
            storage.setItem(key, JSON.stringify(wallet));
          } catch {
            continue;
          }
        }
        if (wallet && !connected.find((w) => w.cosmosAddress === wallet.cosmosAddress)) {
          connected.push(wallet);
        }
      }
    }
  });
  return connected;
}

export function scanCompatibleAccounts(keys: LocalKey[]) {
  const dashboard = useDashboard();
  const available = [] as AccountEntry[];
  keys.forEach((wallet) => {
    // fromBech32 THROWS on partial/invalid input ("No separator character",
    // "Data too short", "Unknown character"). This function runs inside a
    // computed that re-evaluates on every keystroke of the import field, so an
    // unguarded throw propagates as a Vue render error and blanks the whole
    // page until the address happens to be complete. Decode once, skip the
    // whole key if it isn't a valid bech32 address yet.
    let data: Uint8Array;
    try {
      data = fromBech32(wallet.cosmosAddress).data;
    } catch {
      return;
    }
    Object.values(dashboard.chains).forEach((chain) => {
      let address: string;
      try {
        address = toBech32(chain.bech32Prefix, data);
      } catch {
        return;
      }
      available.push({
        chainName: chain.chainName,
        logo: chain.logo,
        address,
        coinType: chain.coinType,
        compatiable: wallet.hdPath.indexOf(chain.coinType) > 0,
        endpoint: chain.endpoints.rest?.at(0)?.address,
      });
    });
  });
  return available;
}
