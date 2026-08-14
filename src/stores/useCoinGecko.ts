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
// The backend cache refreshes on a 15-minute cadence. Keep a browser copy
// longer than one request interval so a transient edge/provider error cannot
// turn an already-known price into an empty/$0 state.
const CACHE_TTL_MS = 5 * 60_000;
const STALE_CACHE_TTL_MS = 30 * 60_000;
const responseCache = new Map<string, { at: number; value: any }>();
const inFlight = new Map<string, Promise<any>>();

function cachedGet(url: string): Promise<any> {
  const now = Date.now();
  const cached = responseCache.get(url);
  if (cached && now - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.value);
  const pending = inFlight.get(url);
  if (pending) return pending;
  const request = get(url, { headers: coingeckoHeaders })
    .then((value) => {
      responseCache.set(url, { at: Date.now(), value });
      return value;
    })
    .catch((error) => {
      // Keep the last successful market response usable during a transient
      // edge/provider failure. Never synthesize a numeric zero from failure.
      if (cached && now - cached.at < STALE_CACHE_TTL_MS) {
        console.warn('[market] request failed; serving stale cached response:', error?.message || error);
        return cached.value;
      }
      throw error;
    })
    .finally(() => inFlight.delete(url));
  inFlight.set(url, request);
  return request;
}

// Production builds use the first-party cache even when Vercel has no
// VITE_COINGECKO_URL environment variable. Local development may still opt in
// to direct CoinGecko explicitly with VITE_COINGECKO_URL.
const defaultCoingeckoUrl = import.meta.env.PROD ? 'https://api.shazoes.xyz' : 'https://api.coingecko.com';
const configuredCoingeckoUrl = (import.meta.env.VITE_COINGECKO_URL || defaultCoingeckoUrl).replace(/\/$/, '');
export const usingMarketCache = (() => {
  try {
    return new URL(configuredCoingeckoUrl).hostname.toLowerCase() === 'api.shazoes.xyz';
  } catch {
    // Keep the direct CoinGecko fallback for malformed local environment values.
    return false;
  }
})();
export const coingeckoUrl = configuredCoingeckoUrl;

// The custom market cache is already public and must not receive CoinGecko keys.
// Direct CoinGecko remains supported for local/dev deployments.
const cgApiKey = import.meta.env.VITE_COINGECKO_API_KEY as string | undefined;
export const coingeckoHeaders: Record<string, string> = !usingMarketCache && cgApiKey
  ? { 'x-cg-demo-api-key': cgApiKey }
  : {};

const marketCacheUrl = `${coingeckoUrl}/v1/market`;
const marketCacheGet = (url: string) => cachedGet(url);

function marketPriceMap(ids: string[]): Promise<Record<string, PriceMeta>> {
  const query = ids.length ? `?ids=${encodeURIComponent([...new Set(ids)].join(','))}` : '';
  return marketCacheGet(`${marketCacheUrl}/prices${query}`).then((payload: any) => {
    const out: Record<string, PriceMeta> = {};
    for (const [id, row] of Object.entries(payload?.data || {})) {
      const value = row as any;
      const meta: PriceMeta = {};
      if (value.current_price != null) meta.usd = String(value.current_price);
      if (value.price_change_percentage_24h != null) meta.usd_24h_change = String(value.price_change_percentage_24h);
      out[id] = meta;
    }
    return out;
  });
}

export async function fetchPortfolioMarketRows(ids: string[], currency = 'usd') {
  const cleanIds = [...new Set(ids.filter(Boolean))];
  if (!cleanIds.length) return [];

  if (!usingMarketCache) {
    const url =
      `${coingeckoUrl}/api/v3/coins/markets?vs_currency=${encodeURIComponent(currency)}` +
      `&ids=${encodeURIComponent(cleanIds.join(','))}` +
      '&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=14d&locale=en';
    return cachedGet(url);
  }

  const payload: any = await marketCacheGet(
    `${marketCacheUrl}/prices?ids=${encodeURIComponent(cleanIds.join(','))}`
  );
  const rows = payload?.data || {};
  return Promise.all(
    cleanIds.map(async (id) => {
      const row = rows[id] || {};
      let sparkline: number[] = [];
      try {
        const chart = await marketChart(id);
        // The cache stores 14 days of points. Keep the most recent 7 days;
        // tolerate an empty/short chart during an upstream refresh gap.
        sparkline = Array.isArray(chart?.prices)
          ? chart.prices
              .slice(-168)
              .map((point: any) => Number(point?.[1]))
              .filter(Number.isFinite)
          : [];
      } catch (e: any) {
        console.warn('[market-cache] portfolio chart failed:', e?.message || e);
      }
      const current = Number(row.current_price) || 0;
      const changePct = Number(row.price_change_percentage_24h) || 0;
      return {
        id,
        symbol: id,
        name: id,
        current_price: current,
        market_cap: Number(row.market_cap) || 0,
        market_cap_rank: Number(row.market_cap_rank) || 0,
        price_change_24h: current * changePct / 100,
        price_change_percentage_24h: changePct,
        sparkline_in_7d: { prices: sparkline },
      };
    })
  );
}

function marketChart(coinId: string): Promise<any> {
  return marketCacheGet(`${marketCacheUrl}/charts/${encodeURIComponent(coinId)}`).then((payload: any) => payload?.data || { prices: [] });
}

function marketCoinInfo(coinId: string): Promise<any> {
  return marketCacheGet(`${marketCacheUrl}/prices?ids=${encodeURIComponent(coinId)}`).then((payload: any) => {
    const row = payload?.data?.[coinId] || {};
    const current = Number(row.current_price);
    // `Number(null)` is 0; do not turn a partial/missing cache row into a
    // false $0 market ticker and a misleading "market available" state.
    const hasPrice = row.current_price != null && Number.isFinite(current);
    return {
      id: coinId,
      // The cache intentionally stores market numbers, not CoinGecko project
      // metadata. Chain JSON remains the title/symbol/socials source.
      symbol: '',
      name: '',
      market_cap_rank: row.market_cap_rank || 0,
      market_data: {
        current_price: { usd: row.current_price },
        price_change_percentage_24h: row.price_change_percentage_24h,
        market_cap: { usd: row.market_cap },
        market_cap_rank: row.market_cap_rank,
      },
      links: { homepage: [], twitter_screen_name: '', repos_url: { github: [] } },
      description: { en: '' },
      // The market cache currently exposes price metrics only. Never invent
      // an exchange/market label; render one only when the cache actually
      // provides it (for example `market_name` or `market.name`).
      tickers: hasPrice
        ? [{
            market: {
              name: String(row.market_name || row.market?.name || '').trim(),
              identifier: String(row.market_identifier || row.market?.identifier || '').trim(),
            },
            coin_id: coinId,
            target_coin_id: 'usd',
            trust_score: 'green',
            trade_url: String(row.trade_url || '').trim(),
            converted_last: { btc: 0, eth: 0, usd: current },
            base: coinId,
            target: 'USD',
          }]
        : [],
    };
  });
}

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
  if (usingMarketCache) {
    try {
      return await marketPriceMap(coinIds);
    } catch (e: any) {
      console.warn('[market-cache] fetchPriceMap failed:', e?.message || e);
      return {};
    }
  }
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
      if (usingMarketCache) {
        return marketChart(coinId).catch((e: any) => {
          console.warn('[market-cache] market chart failed:', e?.message || e);
          return { prices: [], total_volumes: [], __error: true, __errorMessage: e?.message || 'request failed' };
        });
      }
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
      if (usingMarketCache) {
        return marketCoinInfo(coinId).catch((e: any) => {
          console.warn('[market-cache] coin info failed:', e?.message || e);
          return {
            id: coinId,
            symbol: '',
            name: '',
            market_data: {},
            links: { homepage: [], twitter_screen_name: '', repos_url: { github: [] } },
            description: { en: '' },
            tickers: [],
          };
        });
      }
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
