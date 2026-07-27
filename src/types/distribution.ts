import type { Coin, PaginatedResponse } from './common';

export interface DistributionParams {
  params: {
    community_tax: string;
    base_proposer_reward: string;
    bonus_proposer_reward: string;
    withdraw_addr_enabled: boolean;
    // atomone-specific: see https://github.com/atomone-foundation/atomone
    nakamoto_bonus?: {
      enabled?: boolean;
      step?: string;
      period_epoch_identifier?: string;
      minimum_coefficient?: string;
      maximum_coefficient?: string;
      [key: string]: any;
    };
  };
}

export interface DelegatorRewards {
  rewards: {
    validator_address: string;
    reward: Coin[];
  }[];
  total: Coin[];
}

export interface PaginatedSlashes extends PaginatedResponse {
  slashes: any[];
}

export interface WalletConnected {
  wallet: string;
  cosmosAddress: string;
  hdPath: string;
}
