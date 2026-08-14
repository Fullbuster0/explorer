import { defineStore } from 'pinia';
import { get } from '@/libs/http';
import type { ChainConfig, DirectoryChainConfig, Endpoint, LocalChainConfig } from '@/types/chaindata';
import { ConfigSource, NetworkType } from '@/types/chaindata';
import { coingeckoUrl, coingeckoHeaders, fetchPriceMap } from '@/stores';

function apiConverter(api?: any[] | string) {
  if (!api) return [] as Endpoint[];
  const array = typeof api === 'string' ? [api] : api;
  return array.map((x) => {
    if (typeof x === 'string') {
      const parts = String(x).split('.');
      return {
        address: x,
        provider: parts.length >= 2 ? parts[parts.length - 2] : x,
      };
    } else {
      return x as Endpoint;
    }
  });
}

export function convertFromLocal(lc: LocalChainConfig): ChainConfig {
  const conf = {} as ChainConfig;
  if (lc.assets && Array.isArray(lc.assets)) {
    conf.assets = lc.assets.map((x) => ({
      name: x.base,
      base: x.base,
      display: x.symbol,
      symbol: x.symbol,
      logo_URIs: { svg: x.logo },
      coingecko_id: x.coingecko_id,
      exponent: x.exponent,
      denom_units: [
        { denom: x.base, exponent: 0 },
        { denom: x.symbol.toLowerCase(), exponent: Number(x.exponent) },
      ],
      type_asset: 'sdk.coin',
    }));
  } else {
    conf.assets = [];
  }
  conf.versions = {
    cosmosSdk: lc.sdk_version,
  };
  conf.bech32Prefix = lc.addr_prefix;
  conf.bech32ConsensusPrefix = lc.consensus_prefix ?? lc.addr_prefix + 'valcons';
  conf.chainName = lc.chain_name;
  conf.chainId = lc.chain_id || '';
  conf.networkType = lc.network_type;
  conf.coinType = lc.coin_type;
  conf.prettyName = lc.registry_name || lc.chain_name;
  conf.endpoints = {
    rest: apiConverter(lc.api),
    rpc: apiConverter(lc.rpc),
    grpc: apiConverter(lc.grpc || []),
  };
  if (lc.archived_api?.length) {
    conf.endpoints.archive = apiConverter(lc.archived_api);
  }
  if (lc.provider_chain) {
    conf.providerChain = {
      api: apiConverter(lc.provider_chain.api),
    };
  }
  conf.features = lc.features;
  if (lc.engine) conf.engine = lc.engine;
  if (lc.indexer_api) conf.indexer_api = lc.indexer_api;
  if (lc.valopers_live_url) conf.valopers_live_url = lc.valopers_live_url;
  if (lc.uptime_live_url) conf.uptime_live_url = lc.uptime_live_url;
  if (lc.gnoweb) conf.gnoweb = lc.gnoweb;
  if (lc.valopers_source?.base_url) conf.valopers_source = { ...lc.valopers_source };
  // Absolute logos as-is; site-local /logos/* stay same-origin; other relatives use ping.pub.
  conf.logo = lc.logo
    ? lc.logo.startsWith('http')
      ? lc.logo
      : lc.logo.startsWith('/logos/')
        ? lc.logo
        : `https://ping.pub${lc.logo.startsWith('/') ? '' : '/'}${lc.logo}`
    : '';
  conf.keplrFeatures = lc.keplr_features;
  conf.keplrPriceStep = lc.keplr_price_step;
  conf.themeColor = lc.theme_color;
  conf.faucet = lc.faucet;
  if (lc.github) conf.github = lc.github;
  // Manual hero/social meta (CoinGecko substitute for unlisted / testnet chains)
  if (lc.description) conf.description = lc.description;
  if (lc.website) conf.website = lc.website;
  if (lc.twitter) conf.twitter = lc.twitter;
  if (lc.discord) conf.discord = lc.discord;
  if (lc.telegram) conf.telegram = lc.telegram;
  return conf;
}

export function convertFromDirectory(source: DirectoryChainConfig): ChainConfig {
  const conf = {} as ChainConfig;
  (conf.assets = source.assets),
    (conf.bech32Prefix = source.bech32_prefix),
    (conf.bech32ConsensusPrefix = source.bech32_prefix + 'valcons'),
    (conf.chainId = source.chain_id),
    (conf.chainName = source.chain_name),
    (conf.prettyName = source.pretty_name),
    (conf.networkType = source.network_type),
    (conf.versions = {
      application: source.versions?.application_version || '',
      cosmosSdk: source.versions?.cosmos_sdk_version || '',
      tendermint: source.versions?.tendermint_version || '',
    }),
    (conf.logo = pathConvert(source.image));
  conf.endpoints = source.best_apis;
  return conf;
}

function pathConvert(path: string | undefined) {
  if (path) {
    path = path.replace('https://raw.githubusercontent.com/cosmos/chain-registry/master', 'https://registry.ping.pub');
  }
  return path || '';
}

export function getLogo(
  conf:
    | {
        svg?: string;
        png?: string;
        jpeg?: string;
      }
    | undefined
) {
  if (conf) {
    return pathConvert(conf.svg || conf.png || conf.jpeg);
  }
  return undefined;
}

// Unused function, kept for reference
// function createChainFromDirectory(source: DirectoryChain): ChainConfig {
//   const conf = {} as ChainConfig;
//   conf.apis = source.best_apis;
//   conf.bech32_prefix = source.bech32_prefix;
//   conf.chain_id = source.chain_id;
//   conf.chain_name = source.chain_name;
//   conf.explorers = source.explorers;
//   conf.pretty_name = source.pretty_name;
//   if (source.versions) {
//     conf.codebase = {
//       recommended_version: source.versions.application_version,
//       cosmos_sdk_version: source.versions.cosmos_sdk_version,
//       tendermint_version: source.versions.tendermint_version,
//     };
//   }
//   if (source.image) {
//     conf.logo_URIs = {
//       svg: source.image,
//     };
//   }
//   return conf;
// }

export enum LoadingStatus {
  Empty,
  Loading,
  Loaded,
}

export const useDashboard = defineStore('dashboard', {
  state: () => {
    return {
      status: LoadingStatus.Empty,
      source: ConfigSource.MainnetCosmosDirectory,
      networkType: NetworkType.Mainnet,
      chains: {} as Record<string, ChainConfig>,
      prices: {} as Record<string, any>,
      coingecko: {} as Record<string, { coinId: string; exponent: number; symbol: string }>,
    };
  },
  getters: {
    length(): number {
      return Object.keys(this.chains).length;
    },
  },
  actions: {
    async initial() {
      await this.loadingFromLocal();
      //await this.loadingFromRegistry()
    },
    loadingPrices() {
      const coinIds = [] as string[];
      const keys = Object.keys(this.chains); // load all blockchain
      keys.forEach((k) => {
        if (Array.isArray(this.chains[k]?.assets))
          this.chains[k].assets.forEach((a) => {
            if (a.coingecko_id !== undefined && a.coingecko_id.length > 0) {
              coinIds.push(a.coingecko_id);
              a.denom_units.forEach((u) => {
                this.coingecko[u.denom] = {
                  coinId: a.coingecko_id || '',
                  exponent: u.exponent,
                  symbol: a.symbol,
                };
              });
            }
          });
      });

      const currencies = ['usd', 'cny']; // usd,cny,eur,jpy,krw,sgd,hkd
      // /simple/price is now key-gated (403); use /coins/markets via fetchPriceMap.
      fetchPriceMap(coinIds, currencies)
        .then((x) => {
          this.prices = x;
        })
        .catch((e) => console.warn('[dashboard] price fetch failed:', e?.message || e));
    },
    async loadingFromRegistry() {
      if (this.status === LoadingStatus.Empty) {
        this.status = LoadingStatus.Loading;
        get(this.source).then((res: { chains: DirectoryChainConfig[] }) => {
          res.chains.forEach((x: DirectoryChainConfig) => {
            this.chains[x.chain_name] = convertFromDirectory(x);
          });
          this.status = LoadingStatus.Loaded;
        });
      }
    },
    async loadingFromLocal() {
      if (window.location.hostname.search('testnet') > -1) {
        this.networkType = NetworkType.Testnet;
      }
      // Load BOTH mainnet and testnet so the home page can toggle between them.
      // Vite JSON modules may be either the raw object or `{ default: obj }`.
      const unwrap = (mod: any): LocalChainConfig | null => {
        const x = (mod && (mod.default || mod)) as LocalChainConfig;
        return x && x.chain_name ? x : null;
      };
      const mainnetSource = import.meta.glob('../../chains/mainnet/*.json', { eager: true });
      const testnetSource = import.meta.glob('../../chains/testnet/*.json', { eager: true });
      Object.values(mainnetSource).forEach((mod: any) => {
        const x = unwrap(mod);
        if (!x) return;
        this.chains[x.chain_name] = convertFromLocal(x);
        this.chains[x.chain_name].networkType = 'mainnet';
      });
      Object.values(testnetSource).forEach((mod: any) => {
        const x = unwrap(mod);
        if (!x) return;
        this.chains[x.chain_name] = convertFromLocal(x);
        this.chains[x.chain_name].networkType = 'testnet';
      });
      this.setupDefault();
      this.status = LoadingStatus.Loaded;
    },
    async loadLocalConfig(network: NetworkType) {
      const config: Record<string, ChainConfig> = {};
      const unwrap = (mod: any): LocalChainConfig | null => {
        const x = (mod && (mod.default || mod)) as LocalChainConfig;
        return x && x.chain_name ? x : null;
      };
      const source =
        network === NetworkType.Mainnet
          ? import.meta.glob('../../chains/mainnet/*.json', { eager: true })
          : import.meta.glob('../../chains/testnet/*.json', { eager: true });
      Object.values(source).forEach((mod: any) => {
        const x = unwrap(mod);
        if (!x) return;
        config[x.chain_name] = convertFromLocal(x);
        if (!config[x.chain_name].networkType) {
          config[x.chain_name].networkType = network.toString().toLowerCase();
        }
      });
      return config;
    },
    setupDefault() {
      // Home is chain-agnostic (indonode-style landing). Do NOT auto-select a
      // chain here — chain is set only via router when user opens /:chain/...
      if (this.length > 0) {
        this.loadingPrices();
      }
    },
    setConfigSource(newSource: ConfigSource) {
      this.source = newSource;
      this.initial();
    },
  },
});
