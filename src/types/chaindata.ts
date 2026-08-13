import type { Asset as RegistryAsset, DenomUnit as RegistryDenomUnit } from '@chain-registry/types';
import type { Chain as RegistryChain, Endpoint as RegistryEndPoint } from '@chain-registry/types/chain.schema';

export enum NetworkType {
  Mainnet,
  Testnet,
}

export enum ConfigSource {
  MainnetCosmosDirectory = 'https://chains.cosmos.directory',
  TestnetCosmosDirectory = 'https://chains.testcosmos.directory',
  Local = 'local',
}

export enum EndpointType {
  rpc,
  rest,
  grpc,
  // webgrpc
}

export interface Chain extends RegistryChain {}
export interface Asset extends RegistryAsset {
  exponent?: string | number;
}
export interface Endpoint extends RegistryEndPoint {}
export interface DenomUnit extends RegistryDenomUnit {}

export interface LocalChainConfig {
  addr_prefix: string;
  consensus_prefix?: string;
  alias?: string;
  api: string[] | Endpoint[];
  /**
   * Optional "archive" API endpoints — providers that run a full tx_indexer
   * and can serve historical `txs` queries by sender / events. Used
   * opportunistically (e.g. on the account page) when the primary
   * `api[]` endpoints aren't indexed.
   */
  archived_api?: Endpoint[];
  grpc?: Endpoint[];
  provider_chain?: {
    api: string[] | Endpoint[];
  };
  assets: {
    base: string;
    coingecko_id?: string;
    exponent: string;
    logo?: string;
    symbol: string;
  }[];
  chain_name: string;
  chain_id?: string;
  network_type?: string;
  /**
   * Execution engine. Default cosmos (LCD/REST). Set `gno` / `tm2` for
   * Gnoland Tendermint2 chains that have no Cosmos SDK REST API — the
   * explorer then talks JSON-RPC directly via GnoTm2Client.
   */
  engine?: 'cosmos' | 'gno' | 'tm2';
  /**
   * Gno/TM2 only: onbloc-style indexer REST base URL (e.g.
   * https://sapphire.api.onbloc.xyz/v1). Public Gno RPC has tx_index=off, so
   * transactions / realms / tokens / validator statuses come from here.
   */
  indexer_api?: string;
  /**
   * Gno/TM2 only: public JSON of the chain-scoped valoper registry.
   * Copied through convertFromLocal → ChainConfig.valopers_live_url.
   * Example: /data/gno-valopers/testnet/sapphire-1/valopers.json.
   */
  valopers_live_url?: string;
  /**
   * Optional gnoweb base (realms/tokens deep links). e.g.
   * https://sapphire.testnets.gno.land
   */
  gnoweb?: string;
  /**
   * Gno valoper registry realm source (cron + SPA profile links).
   * e.g. { type: 'gno-realm', base_url: 'https://sapphire…/r/gnops/valopers' }
   */
  valopers_source?: {
    type?: string;
    base_url?: string;
    note?: string;
  };
  coin_type: string;
  logo: string;
  theme_color?: string;
  min_tx_fee: string;
  rpc: string[] | Endpoint[];
  sdk_version: string;
  registry_name?: string;
  /** Optional chain codebase repo (used by dashboard GitHub activity card). */
  github?: string;
  /**
   * Manual chain meta for dashboard hero when CoinGecko is unavailable
   * (testnets / unlisted chains). Copied through convertFromLocal.
   */
  description?: string;
  website?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  features?: string[];
  keplr_price_step?: {
    low: number;
    average: number;
    high: number;
  };
  keplr_features?: string[];
  faucet?: {
    amount: string;
    ip_limit: number;
    address_limit: number;
    fees: string;
  };
}

// Chain config structure of cosmos.directory
export interface DirectoryChainConfig {
  assets: Asset[];
  bech32_prefix: string;
  best_apis: {
    rest: Endpoint[];
    rpc: Endpoint[];
  };
  chain_id: string;
  chain_name: string;
  pretty_name: string;
  coingecko_id: string;
  cosmwasm_enabled: boolean;
  decimals: number;
  denom: string;
  display: string;
  explorers:
    | {
        name?: string | undefined;
        kind?: string | undefined;
        url?: string | undefined;
        tx_page?: string | undefined;
        account_page?: string | undefined;
      }[]
    | undefined;
  height: number;
  image: string;
  name: string;
  network_type: string;
  symbol: string;
  versions?: {
    application_version: string;
    cosmos_sdk_version: string;
    tendermint_version: string;
  };
}

export interface ChainConfig {
  chainName: string;
  prettyName: string;
  networkType?: string;
  bech32Prefix: string;
  bech32ConsensusPrefix: string;
  chainId: string;
  coinType: string;
  assets: Asset[];
  themeColor?: string;
  features?: string[];
  /** See LocalChainConfig.engine — gno/tm2 → Tendermint2 JSON-RPC client. */
  engine?: 'cosmos' | 'gno' | 'tm2';
  /** Gno/TM2 indexer REST base URL (tx/realms/tokens/validator status). */
  indexer_api?: string;
  /** Gno/TM2 live valoper registry JSON (CORS). See LocalChainConfig.valopers_live_url. */
  valopers_live_url?: string;
  /** Optional gnoweb base for realm/token deep links. */
  gnoweb?: string;
  /** Gno valoper registry realm (profile links + cron source meta). */
  valopers_source?: {
    type?: string;
    base_url?: string;
    note?: string;
  };
  endpoints: {
    rest?: Endpoint[];
    rpc?: Endpoint[];
    grpc?: Endpoint[];
    /** Archive / indexed-tx providers (full tx_indexer). Optional. */
    archive?: Endpoint[];
  };
  logo: string;
  /** Optional GitHub repo URL for dashboard activity card. */
  github?: string;
  /** Manual hero meta when CoinGecko is empty (testnets). */
  description?: string;
  website?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  versions: {
    application?: string;
    cosmosSdk?: string;
    tendermint?: string;
  };
  exponent: string;
  excludes?: string;
  providerChain: {
    api: Endpoint[];
  };
  // keplr config
  keplrFeatures?: string[];
  keplrPriceStep?: {
    low: number;
    average: number;
    high: number;
  };
  faucet?: {
    amount: string;
    ip_limit: number;
    address_limit: number;
    fees: string;
  };
}
