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
const CACHE_TTL_MS = 60_000;
const responseCache = new Map<string, { at: number; value: any }>();
const inFlight = new Map<string, Promise<any>>();

function cachedGet(url: string): Promise<any> {
  const now = Date.now();
  const cached = responseCache.get(url);
  if (cached && now - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.value);
  const pending = inFlight.get(url);
  if (pending) return pending;
  const request = get(url, { headers: coingeckoHeaders }).then((value) => {
    responseCache.set(url, { at: Date.now(), value });
    return value;
  }).finally(() => inFlight.delete(url));
  inFlight.set(url, request);
  return request;
}

export const coingeckoUrl = import.meta.env.VITE_COINGECKO_URL || 'https://api.coingecko.com';

// Optional free demo API key — raises rate limits. Set VITE_COINGECKO_API_KEY.
const cgApiKey = import.meta.env.VITE_COINGECKO_API_KEY as string | undefined;
export const coingeckoHeaders: Record<string, string> = cgApiKey
  ? { 'x-cg-demo-api-key': cgApiKey }
  : {};

/**
 * CoinGecko locked the free `/simple/price` endpoint behind an API key
 * (returns 403 without one), but `/coins/markets` is still open. Fetch prices
 * via markets and reshape the array into the `{ coinId: PriceMeta }` map the
 * rest of the app expects (same shape /simple/price used to return).
 */
export async function fetchPriceMap(
  coinIds: string[],
  vsCurrencies: string[]
): Promise<Record<string, PriceMeta>> {
  if (!coinIds.length) return {};
  const vs = vsCurrencies.filter((c) => !!c);
  const primary = vs[0] || 'usd';
  const url =
    `${coingeckoUrl}/api/v3/coins/markets?vs_currency=${encodeURIComponent(primary)}` +
    `&ids=${encodeURIComponent(coinIds.join(','))}` +
    `&price_change_percentage=24h&per_page=250`;
  try {
    const rows: any[] = await cachedGet(url);
    const out: Record<string, PriceMeta> = {};
    if (!Array.isArray(rows)) return out;
    for (const r of rows) {
      if (!r?.id) continue;
      const meta: PriceMeta = {};
      const price = r.current_price;
      if (price != null) (meta as any)[primary] = String(price);
      const ch = r.price_change_percentage_24h;
      if (ch != null) (meta as any)[`${primary}_24h_change`] = String(ch);
      out[r.id] = meta;
    }
    return out;
  } catch (e: any) {
    // Soft-fail: prices are nice-to-have. CORS / rate-limit / offline
    // must not cascade into uncaught rejections on every page.
    console.warn('[coingecko] fetchPriceMap failed:', e?.message || e);
    return {};
  }
}

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
      return cachedGet(
        `${coingeckoUrl}/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`
      );
    },

    fetchCoinPrice(ids: string[]) {
      // Filter null/empty secondary currency so we never send "usd,null".
      const vs = (['usd', this.currency] as (string | null | undefined)[]).filter(
        (c): c is string => !!c
      );
      fetchPriceMap(ids, vs)
        .then((data) => {
          this.prices = { ...this.prices, ...data };
        })
        .catch((e) => console.warn('[coingecko] price fetch failed:', e?.message || e));
    },
    getCoinInfo(coinId: string) {
      return cachedGet(`${coingeckoUrl}/api/v3/coins/${encodeURIComponent(coinId)}`);
    },
    setSecondaryCurrency(currency: string) {
      if (currency !== 'usd') {
        localStorage.setItem(LocalStoreKey, currency);
        this.currency = currency;
      }
    },
  },
});
