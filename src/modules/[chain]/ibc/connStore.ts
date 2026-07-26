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
 */

export interface IbcChainRow {
  chainId: string;
  name: string;
  logo: string;
  connections: Connection[];
  channels: Channel[];
  openConnections: number;
  openChannels: number;
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
const CHAIN_META: Record<string, { name: string; logo: string }> = {
  'osmosis-1': { name: 'Osmosis', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmosis-chain-logo.png' },
  'stargaze-1': { name: 'Stargaze', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/stargaze/images/logo.png' },
  'beezee-1': { name: 'BeeZee', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/beezee/images/bze.png' },
  'dungeon-1': { name: 'Dungeon', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/dungeon/images/logo.png' },
  'axelar-dojo-1': { name: 'Axelar', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/axelar/images/axelar-logo.png' },
  'columbus-5': { name: 'Terra Classic', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/terra/images/luna.png' },
  'morocco-1': { name: 'Morocco', logo: '' },
  'cosmoshub-4': { name: 'Cosmos Hub', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.png' },
  'agoric-3': { name: 'Agoric', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/agoric/images/Agoric-logo-color.png' },
  'noble-1': { name: 'Noble', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/noble/images/noble.png' },
  'neutron-1': { name: 'Neutron', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/neutron/images/ntrn.png' },
  'dydx-mainnet-1': { name: 'dYdX', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/dydx/images/dydx.png' },
  'injective-1': { name: 'Injective', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/injective/images/inj.png' },
  'kaiyo-1': { name: 'Kujira', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/kujira/images/kujira.png' },
  'celestia': { name: 'Celestia', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/celestia/images/celestia.png' },
  'juno-1': { name: 'Juno', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/juno/images/juno.png' },
  'akashnet-2': { name: 'Akash', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/akash/images/akt.png' },
  'secret-4': { name: 'Secret', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/secretnetwork/images/scrt.png' },
  'core-1': { name: 'Persistence', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/persistence/images/xprt.png' },
  'sommelier-3': { name: 'Sommelier', logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/sommelier/images/somm.png' },
};

export const useIBCModule = defineStore('module-ibc', {
  state: () => {
    return {
      loading: false,
      loaded: false,
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
      if (this.loading) return;
      if (this.loaded && !force) return;
      this.loading = true;
      this.error = '';
      try {
        const rpc = this.chain.rpc;
        const [conns, chans, clients] = await Promise.all([
          this.fetchAll<Connection>((p) => rpc.getIBCConnections(p).then((x: any) => x.connections || [])),
          this.fetchAll<Channel>((p) => rpc.getIBCChannels(p).then((x: any) => x.channels || [])),
          this.fetchClientChains(),
        ]);
        this.connections = conns;
        this.channels = chans;
        this.clientChain = clients;
        this.buildRows();
        this.loaded = true;
      } catch (e: any) {
        this.error = String(e?.message || e);
      } finally {
        this.loading = false;
      }
    },

    async fetchAll<T>(fn: (p: PageRequest) => Promise<T[]>): Promise<T[]> {
      const out: T[] = [];
      let page = 1;
      const pr = new PageRequest();
      pr.setPageSize(100);
      // Safety cap: most chains have < 200 connections; avoid infinite loops.
      while (page <= 20) {
        pr.setPage(page);
        const batch = await fn(pr);
        if (!batch || batch.length === 0) break;
        out.push(...batch);
        if (batch.length < pr.limit) break;
        page += 1;
      }
      return out;
    },

    async fetchClientChains(): Promise<Record<string, string>> {
      const map: Record<string, string> = {};
      const rpc = this.chain.rpc;
      const pr = new PageRequest();
      pr.setPageSize(100);
      let page = 1;
      while (page <= 20) {
        pr.setPage(page);
        const res: any = await rpc.getIBCClientStates(pr);
        const list = res?.client_states || [];
        if (list.length === 0) break;
        for (const cs of list) {
          const cid = cs?.client_id;
          const remote = cs?.client_state?.chain_id;
          if (cid && remote) map[cid] = remote;
        }
        if (list.length < pr.limit) break;
        page += 1;
      }
      return map;
    },

    buildRows() {
      const dash = useDashboard();
      const byChain = new Map<string, { conns: Connection[]; chans: Channel[] }>();

      const connByClient: Record<string, Connection> = {};
      for (const c of this.connections) connByClient[c.client_id] = c;

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

      const rows: IbcChainRow[] = [];
      for (const [chainId, g] of byChain) {
        const meta = this.resolveChainMeta(chainId, dash);
        rows.push({
          chainId,
          name: meta.name,
          logo: meta.logo,
          connections: g.conns,
          channels: g.chans,
          openConnections: g.conns.filter((c) => (c.state || '').includes('OPEN')).length,
          openChannels: g.chans.filter((c) => (c.state || '').includes('OPEN')).length,
          wellKnown: !!meta.known,
        });
      }
      // Sort: most channels first, then connections, then name.
      rows.sort(
        (a, b) =>
          b.channels.length - a.channels.length ||
          b.connections.length - a.connections.length ||
          a.name.localeCompare(b.name)
      );
      this.rows = rows;
      this.summary = {
        connections: this.connections.length,
        openConnections: this.connections.filter((c) => (c.state || '').includes('OPEN')).length,
        channels: this.channels.length,
        openChannels: this.channels.filter((c) => (c.state || '').includes('OPEN')).length,
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

    showConnection(connId?: string | number) {
      const path = `/${this.chain.chainName}/ibc/connection/${connId || `connection-${this.connectionId || 0}`}`;
      router.push(path);
    },
  },
});
