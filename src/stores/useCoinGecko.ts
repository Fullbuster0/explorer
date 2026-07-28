import { defineStore } from 'pinia';
import { get } from '@/libs/http';
import type { LoadingStatus } from '@/stores';

export interface PriceMeta {
  usd?: string;
  usd_24h_change?: string;
  cny?: string;
  cny_24h_change?: string;
  eur?: string;
  eur_24h_change?: string;
}

const LocalStoreKey = 'currency';

export const coingeckoUrl = import.meta.env.VITE_COINGECKO_URL || 'https://api.coingecko.com';

// Optional free demo API key — bypasses the aggressive public-tier rate limit /
// datacenter-IP 403s. Set VITE_COINGECKO_API_KEY to enable. Without it the app
// still works, prices just may be unavailable (handled gracefully downstream).
const cgApiKey = import.meta.env.VITE_COINGECKO_API_KEY as string | undefined;
export const coingeckoHeaders: Record<string, string> = cgApiKey
  ? { 'x-cg-demo-api-key': cgApiKey }
  : {};

export const useCoingecko = defineStore('coingecko', {
  state: () => {
    const currency = localStorage.getItem(LocalStoreKey);
    return {
      currency, // secondary currency
      loadStatus: {} as Record<string, LoadingStatus | undefined>,
      prices: {} as Record<string, PriceMeta>,
      marketChart: {},
    };
  },
  getters: {},

  actions: {
    getMarketChart(days = 30, coinId = 'cosmos') {
      return get(`${coingeckoUrl}/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`, {
        headers: coingeckoHeaders,
      });
    },

    fetchCoinPrice(ids: string[]) {
      // Filter null/empty secondary currency so we never send "usd,null".
      const vs = ['usd', this.currency].filter((c) => !!c).join(',');
      const url = `${coingeckoUrl}/api/v3/simple/price?include_24hr_change=true&vs_currencies=${vs}&ids=${ids.join(',')}`;
      get(url, { headers: coingeckoHeaders })
        .then((data) => {
          if (data && typeof data === 'object') this.prices = { ...this.prices, ...data };
        })
        .catch((e) => console.warn('[coingecko] price fetch failed:', e?.message || e));
    },
    getCoinInfo(coinId: string) {
      return get(`${coingeckoUrl}/api/v3/coins/${coinId}`, { headers: coingeckoHeaders });
    },
    setSecondaryCurrency(currency: string) {
      if (currency !== 'usd') {
        localStorage.setItem(LocalStoreKey, currency);
        this.currency = currency;
      }
    },
  },
});
