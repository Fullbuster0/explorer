/**
 * Gnoland / Tendermint2 (TM2) helpers.
 *
 * Gno is NOT Cosmos SDK — no LCD/REST. Explorers talk Tendermint2 JSON-RPC
 * directly (`/status`, `/block`, `/validators`, `/abci_query`, …).
 * These helpers normalize TM2 payloads into the shapes our ping-pub UI expects.
 */
import { fromBase64, fromBech32, toBase64, toHex } from '@cosmjs/encoding';
import { get } from '@/libs/http';
import type { Block, NodeInfo, PaginatedTendermintValidator } from '@/types';
import type { PaginatedValdiators, StakingParam, StakingPool, Validator } from '@/types/staking';

const UA_HEADERS = { 'User-Agent': 'ShazoesExplorer/1.0' };

function base(endpoint: string) {
  return String(endpoint || '').replace(/\/+$/, '');
}

/** Decode TM2 block/part hashes (base64) → uppercase hex for UI consistency. */
export function tm2HashToHex(hash?: string | null): string {
  if (!hash) return '';
  // already hex?
  if (/^[0-9a-fA-F]{40,64}$/.test(hash)) return hash.toUpperCase();
  try {
    return toHex(fromBase64(hash)).toUpperCase();
  } catch {
    return String(hash);
  }
}

function normalizeBlockId(id: any) {
  if (!id) {
    return { hash: '', part_set_header: { total: 0, hash: '' } };
  }
  const parts = id.parts || id.part_set_header || {};
  return {
    hash: tm2HashToHex(id.hash),
    part_set_header: {
      total: Number(parts.total || 0),
      hash: tm2HashToHex(parts.hash),
    },
  };
}

function normalizeHeader(header: any) {
  if (!header) return header;
  const versionRaw = header.version;
  const version =
    versionRaw && typeof versionRaw === 'object'
      ? versionRaw
      : { block: String(versionRaw || ''), app: String(header.app_version || '') };

  return {
    version,
    chain_id: header.chain_id,
    height: String(header.height),
    time: header.time,
    last_block_id: normalizeBlockId(header.last_block_id),
    last_commit_hash: tm2HashToHex(header.last_commit_hash),
    data_hash: tm2HashToHex(header.data_hash),
    validators_hash: tm2HashToHex(header.validators_hash),
    next_validators_hash: tm2HashToHex(header.next_validators_hash),
    consensus_hash: tm2HashToHex(header.consensus_hash),
    app_hash: tm2HashToHex(header.app_hash),
    last_results_hash: tm2HashToHex(header.last_results_hash),
    // Keep evidence_hash key for Cosmos Block type even when TM2 omits it
    evidence_hash: tm2HashToHex(header.evidence_hash),
    // TM2 already returns bech32 (g1…) proposer addresses
    proposer_address: header.proposer_address,
    num_txs: header.num_txs,
    total_txs: header.total_txs,
  };
}

/**
 * TM2 last_commit uses `precommits[]` with bech32 validator_address.
 * Cosmos UI (uptime heatmap) expects `signatures[]` with base64 address bytes
 * and BLOCK_ID_FLAG_*.
 */
function normalizeLastCommit(lastCommit: any) {
  if (!lastCommit) {
    return { height: '', round: 0, block_id: normalizeBlockId(null), signatures: [] };
  }
  const precommits: any[] = lastCommit.precommits || lastCommit.signatures || [];
  const signatures = precommits
    .filter(Boolean)
    .map((pc: any) => {
      let validator_address = pc.validator_address || '';
      // bech32 g1… → base64 of 20-byte address (matches uptime mapValidator)
      if (validator_address.startsWith('g')) {
        try {
          validator_address = toBase64(fromBech32(validator_address).data);
        } catch {
          /* keep raw */
        }
      }
      const hasSig = !!(pc.signature || pc.block_id?.hash);
      return {
        block_id_flag: hasSig ? 'BLOCK_ID_FLAG_COMMIT' : 'BLOCK_ID_FLAG_ABSENT',
        validator_address,
        timestamp: pc.timestamp || '',
        signature: pc.signature || '',
      };
    });

  return {
    height: String(lastCommit.height || precommits[0]?.height || ''),
    round: Number(lastCommit.round || precommits[0]?.round || 0),
    block_id: normalizeBlockId(lastCommit.block_id),
    signatures,
  };
}

/** Normalize TM2 `/block` result → ping-pub `Block`. */
export function adaptTm2Block(rpcResult: any): Block {
  const result = rpcResult?.result ?? rpcResult;
  const meta = result?.block_meta || {};
  const block = result?.block || {};
  const headerSrc = block.header || meta.header || {};
  const blockIdSrc = meta.block_id || result?.block_id || block.last_commit?.block_id;

  return {
    block_id: normalizeBlockId(blockIdSrc),
    block: {
      header: normalizeHeader(headerSrc) as Block['block']['header'],
      data: {
        txs: block.data?.txs || [],
      },
      evidence: {
        evidence: block.evidence?.evidence || [],
      },
      last_commit: normalizeLastCommit(block.last_commit) as any,
    },
  };
}

/** Normalize TM2 `/status` → Cosmos LCD-ish NodeInfo. */
export function adaptTm2Status(rpcResult: any): NodeInfo {
  const result = rpcResult?.result ?? rpcResult;
  const ni = result?.node_info || {};
  const sync = result?.sync_info || {};
  const build = result?.build_version || '';
  return {
    default_node_info: {
      protocol_version: { p2p: '', block: '', app: '' },
      default_node_id: String(ni.net_address || '').split('@')[0] || '',
      listen_addr: ni.other?.rpc_address || '',
      network: ni.network || '',
      version: ni.version || '',
      channels: ni.channels || '',
      moniker: ni.moniker || '',
      other: {
        tx_index: ni.other?.tx_index || 'off',
        rpc_address: ni.other?.rpc_address || '',
      },
    },
    application_version: {
      name: 'gnoland',
      app_name: 'gnoland',
      version: build || ni.version || '',
      git_commit: '',
      build_tags: '',
      go_version: '',
      build_deps: [{ path: 'github.com/gnolang/gno', version: 'tm2', sum: '' }],
      cosmos_sdk_version: 'gno-tm2',
    },
  };
}

/** Convert TM2 validator pubkey → cosmos ed25519 shape so address helpers work. */
export function normalizeTm2PubKey(pub: any): { '@type': string; key: string } {
  if (!pub) return { '@type': '/cosmos.crypto.ed25519.PubKey', key: '' };
  const key = pub.key || pub.value || '';
  return {
    '@type': '/cosmos.crypto.ed25519.PubKey',
    key,
  };
}

function shortMoniker(address: string) {
  if (!address) return 'validator';
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-4)}` : address;
}

/** TM2 `/validators` row → Cosmos staking Validator (synthetic). */
export function tm2ValidatorToStaking(v: any): Validator {
  const address = v.address || '';
  const power = String(v.voting_power ?? v.power ?? '0');
  const pub = normalizeTm2PubKey(v.pub_key);
  return {
    operator_address: address,
    consensus_pubkey: pub,
    jailed: false,
    status: 'BOND_STATUS_BONDED',
    tokens: power,
    delegator_shares: power,
    description: {
      moniker: shortMoniker(address),
      identity: '',
      website: '',
      security_contact: '',
      details: 'Gnoland TM2 validator (no Cosmos staking module)',
    },
    unbonding_height: '0',
    unbonding_time: '1970-01-01T00:00:00Z',
    commission: {
      commission_rates: {
        rate: '0',
        max_rate: '0',
        max_change_rate: '0',
      },
      update_time: '1970-01-01T00:00:00Z',
    },
    min_self_delegation: '1',
    liquid_shares: '0',
    validator_bond_shares: '0',
  };
}

export function adaptTm2Validators(rpcResult: any): PaginatedTendermintValidator {
  const result = rpcResult?.result ?? rpcResult;
  const validators = (result?.validators || []).map((v: any) => ({
    address: v.address,
    pub_key: normalizeTm2PubKey(v.pub_key),
    voting_power: String(v.voting_power ?? '0'),
    proposer_priority: String(v.proposer_priority ?? '0'),
  }));
  return {
    validators,
    block_height: String(result?.block_height || ''),
  };
}

export function adaptTm2StakingValidators(rpcResult: any): PaginatedValdiators {
  const result = rpcResult?.result ?? rpcResult;
  const validators = (result?.validators || []).map(tm2ValidatorToStaking);
  // sort by power desc
  validators.sort((a: Validator, b: Validator) => Number(b.tokens) - Number(a.tokens));
  return {
    validators,
    pagination: {
      next_key: undefined,
      total: String(validators.length),
    },
  };
}

export async function tm2Get(endpoint: string, pathAndQuery: string) {
  const url = `${base(endpoint)}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
  return get(url, { headers: UA_HEADERS as any });
}

export async function tm2Status(endpoint: string) {
  return tm2Get(endpoint, '/status');
}

export async function tm2Block(endpoint: string, height?: string | number) {
  const q = height != null && height !== '' ? `?height=${height}` : '';
  return tm2Get(endpoint, `/block${q}`);
}

export async function tm2Validators(endpoint: string, height?: string | number) {
  const q = height != null && height !== '' ? `?height=${height}` : '';
  return tm2Get(endpoint, `/validators${q}`);
}

export async function tm2Health(endpoint: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base(endpoint)}/status`, {
      signal: controller.signal,
      headers: UA_HEADERS as any,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    const height = data?.result?.sync_info?.latest_block_height;
    const network = data?.result?.node_info?.network;
    return !!(height && network);
  } catch {
    return false;
  }
}

export function gnoStakingParams(): StakingParam {
  return {
    params: {
      unbonding_time: '0s',
      max_validators: 100,
      max_entries: 0,
      historical_entries: 0,
      bond_denom: 'ugnot',
      min_commission_rate: '0',
      min_self_delegation: '1',
    },
  };
}

export function gnoStakingPool(validators: Validator[]): StakingPool {
  const bonded = validators.reduce((s, v) => s + Number(v.tokens || 0), 0);
  return {
    pool: {
      bonded_tokens: String(bonded),
      not_bonded_tokens: '0',
    },
  };
}

/** True when this chain config is Gnoland / TM2 (no Cosmos LCD). */
export function isGnoChain(chain: any): boolean {
  if (!chain) return false;
  if (chain.engine === 'gno' || chain.engine === 'tm2') return true;
  const name = String(chain.chainName || chain.chain_name || '').toLowerCase();
  const id = String(chain.chainId || chain.chain_id || '').toLowerCase();
  if (name.includes('gnoland') || name.includes('gnotopaz') || name.startsWith('gno')) return true;
  if (id.startsWith('topaz') || id.startsWith('gnoland') || id.includes('gno')) return true;
  // sdk_version marker
  const sdk = String(chain.versions?.cosmosSdk || chain.sdk_version || '').toLowerCase();
  if (sdk.includes('gno') || sdk.includes('tm2')) return true;
  return false;
}
