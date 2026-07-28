import { defineStore } from 'pinia';
import { useBlockchain, useDashboard } from '@/stores';
import { PageRequest, type Channel, type Connection } from '@/types';
import router from '@/router';

/**
 * IBC "Relayers" store — Mintscan-style flow (summary + per-chain table),
 * but the data model is our own: group connections/channels by remote chain.
 *
 * Data sources (all from the active chain's LCD — no indexer):
 *   - /ibc/core/connection/v1/connections   -> connections[]
 *   - /ibc/core/channel/v1/channels         -> channels[]
 *   - /ibc/core/client/v1/client_states     -> client_id -> remote chain_id map
 *
 * Primary connection selection (critical for trade routes):
 *   NEVER pick the lowest connection-N just because it is OPEN.
 *   Prefer: (1) chain-registry preferred channel, (2) OPEN conn that already
 *   has an OPEN transfer channel, (3) any OPEN conn, (4) first.
 *   AtomOne↔Osmosis example: registry says connection-2 / channel-2
 *   (Osmosis channel-94814). connection-0 / channel-0 is a dead alternate.
 */

export interface IbcChainRow {
  chainId: string;
  name: string;
  logo: string;
  connections: Connection[];
  channels: Channel[];
  openConnections: number;
  openChannels: number;
  /** Connection that should be the default drill-down target. */
  primaryConnectionId: string;
  /** OPEN transfer channel on the preferred path, if any. */
  preferredChannelId: string;
  /** Counterparty channel id for preferred path (e.g. Osmosis channel-94814). */
  preferredCounterpartyChannelId: string;
  /** True when primary came from chain-registry preferred tag. */
  registryPreferred: boolean;
  wellKnown: boolean; // present in the cosmos chain-registry _IBC set
}

export interface IbcSummary {
  connections: number;
  openConnections: number;
  channels: number;
  openChannels: number;
  chains: number;
  wellKnownChains: number;
}

// chain_id -> pretty name/logo fallback for remote chains we don't host.
const CHAIN_META: Record<string, { name: string; logo: string; registry?: string }> = {
  'osmosis-1': {
    name: 'Osmosis',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmosis-chain-logo.png',
    registry: 'osmosis',
  },
  'stargaze-1': {
    name: 'Stargaze',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/stargaze/images/logo.png',
    registry: 'stargaze',
  },
  'beezee-1': {
    name: 'BeeZee',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/beezee/images/bze.png',
    registry: 'beezee',
  },
  'dungeon-1': {
    name: 'Dungeon',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/dungeon/images/logo.png',
    registry: 'dungeon',
  },
  'axelar-dojo-1': {
    name: 'Axelar',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/axelar/images/axelar-logo.png',
    registry: 'axelar',
  },
  'columbus-5': {
    name: 'Terra Classic',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/terra/images/luna.png',
    registry: 'terra',
  },
  'morocco-1': { name: 'Morocco', logo: '', registry: 'morocco' },
  'cosmoshub-4': {
    name: 'Cosmos Hub',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.png',
    registry: 'cosmoshub',
  },
  'agoric-3': {
    name: 'Agoric',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/agoric/images/Agoric-logo-color.png',
    registry: 'agoric',
  },
  'noble-1': {
    name: 'Noble',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/noble/images/noble.png',
    registry: 'noble',
  },
  'neutron-1': {
    name: 'Neutron',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/neutron/images/ntrn.png',
    registry: 'neutron',
  },
  'dydx-mainnet-1': {
    name: 'dYdX',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/dydx/images/dydx.png',
    registry: 'dydx',
  },
  'injective-1': {
    name: 'Injective',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/injective/images/inj.png',
    registry: 'injective',
  },
  'kaiyo-1': {
    name: 'Kujira',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/kujira/images/kujira.png',
    registry: 'kujira',
  },
  celestia: {
    name: 'Celestia',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/celestia/images/celestia.png',
    registry: 'celestia',
  },
  'juno-1': {
    name: 'Juno',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/juno/images/juno.png',
    registry: 'juno',
  },
  'akashnet-2': {
    name: 'Akash',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/akash/images/akt.png',
    registry: 'akash',
  },
  'secret-4': {
    name: 'Secret',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/secretnetwork/images/scrt.png',
    registry: 'secretnetwork',
  },
  'core-1': {
    name: 'Persistence',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/persistence/images/xprt.png',
    registry: 'persistence',
  },
  'sommelier-3': {
    name: 'Sommelier',
    logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/sommelier/images/somm.png',
    registry: 'sommelier',
  },
};

/** Preferred IBC path from cosmos/chain-registry `_IBC/<a>-<b>.json`. */
export interface RegistryIbcPath {
  connectionId: string;
  channelId: string;
  counterpartyConnectionId: string;
  counterpartyChannelId: string;
  preferred: boolean;
}

function isOpenState(state?: string) {
  const s = state || '';
  // Exact open only — TRYOPEN is not open for transfers.
  return s === 'STATE_OPEN' || s === 'OPEN';
}

function isOpenConnection(state?: string) {
  // STATE_OPEN only — STATE_TRYOPEN contains "OPEN" but is NOT trade-ready.
  const s = state || '';
  return s === 'STATE_OPEN' || s === 'OPEN';
}

/**
 * Explorer chain keys are often `atomone-mainnet`; registry uses `atomone`.
 */
function registrySlugFromExplorerName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/-mainnet$/i, '')
    .replace(/-testnet$/i, '')
    .replace(/-devnet$/i, '');
}

function registrySlugFromChainId(chainId: string, metaRegistry?: string): string {
  if (metaRegistry) return metaRegistry;
  return (chainId || '')
    .toLowerCase()
    .replace(/-\d+$/, '')
    .replace(/net-\d+$/, '');
}

export const useIBCModule = defineStore('module-ibc', {
  state: () => {
    return {
      loading: false,
      loaded: false,
      loadGen: 0,
      error: '',
      connections: [] as Connection[],
      channels: [] as Channel[],
      clientChain: {} as Record<string, string>, // client_id -> remote chain_id
      rows: [] as IbcChainRow[],
      summary: {
        connections: 0,
        openConnections: 0,
        channels: 0,
        openChannels: 0,
        chains: 0,
        wellKnownChains: 0,
      } as IbcSummary,
      /** remote chain_id -> preferred registry path (best effort). */
      registryPaths: {} as Record<string, RegistryIbcPath>,
      // legacy registry fields kept for the connection detail page
      registryConf: {} as any,
      connectionId: '' as string,
    };
  },
  getters: {
    chain() {
      return useBlockchain();
    },
    chainName(): string {
      return this.chain.chainName;
    },
  },
  actions: {
    async load(force = false) {
      if (this.loaded && !force) return;
      if (this.loading && !force) return;
      // A force load (e.g. endpoint fallback) supersedes any in-flight load.
      const gen = ++this.loadGen;
      this.loading = true;
      this.error = '';
      try {
        const rpc = this.chain.rpc;
        const [conns, chans, clients] = await Promise.all([
          this.fetchCursor<Connection>((pr) =>
            rpc.getIBCConnections(pr).then((x: any) => ({ items: x.connections || [], next: x.pagination?.next_key }))
          ),
          this.fetchCursor<Channel>((pr) =>
            rpc.getIBCChannels(pr).then((x: any) => ({ items: x.channels || [], next: x.pagination?.next_key }))
          ),
          this.fetchClientChains(gen),
        ]);
        if (gen !== this.loadGen) return; // superseded by a newer load
        this.connections = conns;
        this.channels = chans;
        this.clientChain = clients;
        // Build rows first so UI has data even if registry fetch is slow/fails.
        this.buildRows();
        this.loaded = true;
        // Enrich with chain-registry preferred paths (non-blocking for first paint).
        void this.enrichRegistryPaths(gen);
      } catch (e: any) {
        if (gen !== this.loadGen) return;
        this.error = String(e?.message || e);
      } finally {
        if (gen === this.loadGen) this.loading = false;
      }
    },

    /**
     * Cursor pagination via pagination.next_key. Several public LCD nodes
     * (e.g. nodestake) IGNORE pagination.offset/limit on IBC endpoints, which
     * broke the old offset loop into 20 redundant 1.7MB fetches and a timeout.
     * next_key is the Cosmos-standard cursor and terminates reliably.
     */
    async fetchCursor<T>(fetchPage: (pr: PageRequest) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
      const out: T[] = [];
      const pr = new PageRequest();
      pr.setPageSize(500);
      pr.count_total = false;
      let guard = 0;
      while (guard < 40) {
        guard++;
        const { items, next } = await fetchPage(pr);
        if (items.length) out.push(...items);
        if (!next || items.length === 0) break;
        pr.key = next;
      }
      return out;
    },

    async fetchClientChains(gen?: number): Promise<Record<string, string>> {
      const map: Record<string, string> = {};
      const rpc = this.chain.rpc;
      const pr = new PageRequest();
      pr.setPageSize(500);
      pr.count_total = false;
      let guard = 0;
      while (guard < 40) {
        guard++;
        if (gen !== undefined && gen !== this.loadGen) return map; // superseded mid-flight
        const res: any = await rpc.getIBCClientStates(pr);
        const list = res?.client_states || [];
        for (const cs of list) {
          const cid = cs?.client_id;
          const remote = cs?.client_state?.chain_id;
          if (cid && remote) map[cid] = remote;
        }
        const next = res?.pagination?.next_key;
        if (!next || list.length === 0) break;
        pr.key = next;
      }
      return map;
    },

    /**
     * Pull preferred channel/connection from cosmos/chain-registry for each
     * remote chain that appears in our rows. Soft-fail per file.
     */
    async enrichRegistryPaths(gen: number) {
      const localSlug = registrySlugFromExplorerName(this.chainName);
      if (!localSlug) return;
      const paths: Record<string, RegistryIbcPath> = { ...this.registryPaths };
      const remotes = [...new Set(this.rows.map((r) => r.chainId).filter((id) => id && id !== 'unknown'))];

      await Promise.all(
        remotes.map(async (remoteId) => {
          if (gen !== this.loadGen) return;
          const meta = CHAIN_META[remoteId];
          const remoteSlug = registrySlugFromChainId(remoteId, meta?.registry);
          if (!remoteSlug || remoteSlug === localSlug) return;
          const path = await this.fetchRegistryIbcPair(localSlug, remoteSlug);
          if (path) paths[remoteId] = path;
        })
      );

      if (gen !== this.loadGen) return;
      this.registryPaths = paths;
      // Rebuild so primaryConnectionId / badges pick up registry hits.
      this.buildRows();
    },

    async fetchRegistryIbcPair(a: string, b: string): Promise<RegistryIbcPath | null> {
      const names = [`${a}-${b}.json`, `${b}-${a}.json`];
      for (const file of names) {
        try {
          const url = `https://raw.githubusercontent.com/cosmos/chain-registry/master/_IBC/${file}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue;
          const data = await res.json();
          return this.parseRegistryIbc(data, a);
        } catch {
          // soft-fail — registry optional
        }
      }
      return null;
    },

    parseRegistryIbc(data: any, localSlug: string): RegistryIbcPath | null {
      if (!data?.chain_1 || !data?.chain_2 || !Array.isArray(data.channels) || !data.channels.length) {
        return null;
      }
      const c1 = data.chain_1;
      const c2 = data.chain_2;
      const localIs1 = (c1.chain_name || '').toLowerCase() === localSlug.toLowerCase();
      const localIs2 = (c2.chain_name || '').toLowerCase() === localSlug.toLowerCase();
      if (!localIs1 && !localIs2) return null;

      // Prefer channel tagged preferred/ACTIVE; else first.
      const channels: any[] = data.channels;
      const preferred =
        channels.find((ch) => ch?.tags?.preferred === true) ||
        channels.find((ch) => String(ch?.tags?.status || '').toUpperCase() === 'ACTIVE') ||
        channels[0];
      if (!preferred) return null;

      const localSide = localIs1 ? preferred.chain_1 : preferred.chain_2;
      const remoteSide = localIs1 ? preferred.chain_2 : preferred.chain_1;
      const localConn = localIs1 ? c1.connection_id : c2.connection_id;
      const remoteConn = localIs1 ? c2.connection_id : c1.connection_id;
      if (!localConn || !localSide?.channel_id) return null;

      return {
        connectionId: String(localConn),
        channelId: String(localSide.channel_id),
        counterpartyConnectionId: String(remoteConn || ''),
        counterpartyChannelId: String(remoteSide?.channel_id || ''),
        preferred: preferred?.tags?.preferred === true,
      };
    },

    /**
     * Pick the connection users should land on when they click a chain row.
     * Order:
     *  1. Registry preferred connection (if OPEN and present)
     *  2. OPEN connection that owns at least one OPEN transfer channel
     *  3. Any OPEN connection
     *  4. First connection
     */
    pickPrimary(
      conns: Connection[],
      chans: Channel[],
      reg?: RegistryIbcPath | null
    ): { connId: string; channelId: string; cpChannelId: string; fromRegistry: boolean } {
      const openConns = conns.filter((c) => isOpenConnection(c.state));
      const chansByConn = new Map<string, Channel[]>();
      for (const ch of chans) {
        const hop = ch.connection_hops?.[0];
        if (!hop) continue;
        if (!chansByConn.has(hop)) chansByConn.set(hop, []);
        chansByConn.get(hop)!.push(ch);
      }

      const transferOpen = (connId: string) =>
        (chansByConn.get(connId) || []).find(
          (ch) => isOpenState(ch.state) && (ch.port_id === 'transfer' || !ch.port_id)
        );

      if (reg?.connectionId) {
        const hit = conns.find((c) => c.id === reg.connectionId);
        if (hit && isOpenConnection(hit.state)) {
          const ch =
            (chansByConn.get(hit.id) || []).find((c) => c.channel_id === reg.channelId) ||
            transferOpen(hit.id);
          return {
            connId: hit.id,
            channelId: ch?.channel_id || reg.channelId || '',
            cpChannelId: ch?.counterparty?.channel_id || reg.counterpartyChannelId || '',
            fromRegistry: true,
          };
        }
      }

      // Prefer OPEN conn that already carries an OPEN transfer channel.
      for (const c of openConns) {
        const ch = transferOpen(c.id!);
        if (ch) {
          return {
            connId: c.id!,
            channelId: ch.channel_id || '',
            cpChannelId: ch.counterparty?.channel_id || '',
            fromRegistry: false,
          };
        }
      }

      if (openConns[0]?.id) {
        const ch = transferOpen(openConns[0].id);
        return {
          connId: openConns[0].id,
          channelId: ch?.channel_id || '',
          cpChannelId: ch?.counterparty?.channel_id || '',
          fromRegistry: false,
        };
      }

      const first = conns[0];
      return {
        connId: first?.id || '',
        channelId: '',
        cpChannelId: '',
        fromRegistry: false,
      };
    },

    buildRows() {
      const dash = useDashboard();
      const byChain = new Map<string, { conns: Connection[]; chans: Channel[] }>();

      // channels -> connection via connection_hops[0]
      const chansByConn = new Map<string, Channel[]>();
      for (const ch of this.channels) {
        const hop = ch.connection_hops?.[0];
        if (!hop) continue;
        if (!chansByConn.has(hop)) chansByConn.set(hop, []);
        chansByConn.get(hop)!.push(ch);
      }

      for (const conn of this.connections) {
        const remote = this.clientChain[conn.client_id] || 'unknown';
        if (!byChain.has(remote)) byChain.set(remote, { conns: [], chans: [] });
        const g = byChain.get(remote)!;
        g.conns.push(conn);
        for (const ch of chansByConn.get(conn.id) || []) g.chans.push(ch);
      }

      // Stable sort connections: OPEN first, then by numeric id ascending
      // (so UI lists are predictable — primary is chosen separately).
      const connSort = (a: Connection, b: Connection) => {
        const ao = isOpenConnection(a.state) ? 0 : 1;
        const bo = isOpenConnection(b.state) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const an = parseInt(String(a.id || '').replace(/\D/g, ''), 10) || 0;
        const bn = parseInt(String(b.id || '').replace(/\D/g, ''), 10) || 0;
        return an - bn;
      };

      const rows: IbcChainRow[] = [];
      for (const [chainId, g] of byChain) {
        g.conns.sort(connSort);
        // Channels: OPEN transfer first, then by channel number
        g.chans.sort((a, b) => {
          const ao = isOpenState(a.state) ? 0 : 1;
          const bo = isOpenState(b.state) ? 0 : 1;
          if (ao !== bo) return ao - bo;
          const an = parseInt(String(a.channel_id || '').replace(/\D/g, ''), 10) || 0;
          const bn = parseInt(String(b.channel_id || '').replace(/\D/g, ''), 10) || 0;
          return an - bn;
        });

        const meta = this.resolveChainMeta(chainId, dash);
        const reg = this.registryPaths[chainId];
        const primary = this.pickPrimary(g.conns, g.chans, reg);

        // openConnections: only STATE_OPEN (not TRYOPEN)
        const openConnections = g.conns.filter((c) => isOpenConnection(c.state)).length;
        const openChannels = g.chans.filter((c) => isOpenState(c.state)).length;

        rows.push({
          chainId,
          name: meta.name,
          logo: meta.logo,
          connections: g.conns,
          channels: g.chans,
          openConnections,
          openChannels,
          primaryConnectionId: primary.connId,
          preferredChannelId: primary.channelId,
          preferredCounterpartyChannelId: primary.cpChannelId,
          registryPreferred: primary.fromRegistry,
          wellKnown: !!meta.known || !!reg,
        });
      }
      // Sort: most open transfer channels first, then open conns, then name.
      rows.sort(
        (a, b) =>
          b.openChannels - a.openChannels ||
          b.openConnections - a.openConnections ||
          a.name.localeCompare(b.name)
      );
      this.rows = rows;
      this.summary = {
        connections: this.connections.length,
        openConnections: this.connections.filter((c) => isOpenConnection(c.state)).length,
        channels: this.channels.length,
        openChannels: this.channels.filter((c) => isOpenState(c.state)).length,
        chains: rows.length,
        wellKnownChains: rows.filter((r) => r.wellKnown).length,
      };
    },

    resolveChainMeta(chainId: string, dash: any): { name: string; logo: string; known: boolean } {
      // 1) hosted chain (we run an explorer page for it)
      const hosted = Object.values(dash.chains || {}).find((c: any) => c.chainId === chainId) as any;
      if (hosted) {
        return { name: hosted.prettyName || hosted.chainName || chainId, logo: hosted.logo || '', known: true };
      }
      // 2) curated meta map
      const meta = CHAIN_META[chainId];
      if (meta) return { name: meta.name, logo: meta.logo, known: true };
      // 3) derive a readable name from the chain id
      const pretty = chainId
        .replace(/-\d+$/, '')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (m) => m.toUpperCase());
      return { name: pretty || chainId, logo: '', known: false };
    },

    /** Row helper used by list UI — always the registry-aware primary. */
    primaryConnection(row: IbcChainRow): Connection | undefined {
      if (row.primaryConnectionId) {
        const hit = row.connections.find((c) => c.id === row.primaryConnectionId);
        if (hit) return hit;
      }
      return row.connections.find((c) => isOpenConnection(c.state)) || row.connections[0];
    },

    showConnection(connId?: string | number) {
      const path = `/${this.chain.chainName}/ibc/connection/${connId || `connection-${this.connectionId || 0}`}`;
      router.push(path);
    },

    showChain(remoteChainId: string) {
      const path = `/${this.chain.chainName}/ibc/connection/chain/${encodeURIComponent(remoteChainId)}`;
      router.push(path);
    },
  },
});
