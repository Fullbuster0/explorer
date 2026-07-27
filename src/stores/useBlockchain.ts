import { defineStore } from 'pinia';
import type { ChainConfig, Endpoint } from '@/types/chaindata';
import { useDashboard} from './useDashboard';
import type { NavGroup, NavLink, NavSectionTitle, VerticalNavItems } from '@/layouts/types';
import { useRouter } from 'vue-router';
import { CosmosRestClient } from '@/libs/client';
import {
  useBankStore,
  useBaseStore,
  useDistributionStore,
  useGovStore,
  useMintStore,
  useStakingStore,
  useWalletStore,
} from '.';
import { useBlockModule } from '@/modules/[chain]/block/block';
import { DEFAULT } from '@/libs';
import { hexToRgb, rgbToHsl } from '@/libs/utils';

export const useBlockchain = defineStore('blockchain', {
  state: () => {
    return {
      status: {} as Record<string, string>,
      rest: '',
      chainName: '',
      endpoint: {} as Endpoint,
      connErr: '',
      fallbackInProgress: false,
      lastFallbackAt: 0,
      // Declared in state so watchers (validator page power-events) react to it.
      rpc: undefined as CosmosRestClient | undefined,
    };
  },
  getters: {
    current(): ChainConfig | undefined {
      const chain = this.dashboard.chains[this.chainName];
      // update chain config with dynamic updated sdk version
      const sdkversion = localStorage.getItem(`sdk_version_${this.chainName}`);
      if (sdkversion && chain?.versions) {
        chain.versions.cosmosSdk = sdkversion;
      }
      return chain;
    },
    logo(): string {
      return this.current?.logo || '';
    },
    defaultHDPath(): string {
      const cointype = this.current?.coinType || '118';
      return `m/44'/${cointype}/0'/0/0`;
    },
    dashboard() {
      return useDashboard();
    },
    isConsumerChain() {
      // @ts-ignore
      return this.current && this.current.providerChain;
    },
    computedChainMenu() {
      const router = useRouter();
      const routes = router?.getRoutes() || [];
      const items: VerticalNavItems = [];

      if (this.current && routes) {
        if (this.current?.themeColor) {
          const { color } = hexToRgb(this.current?.themeColor);
          const { h, s, l } = rgbToHsl(color);
          document.body.style.setProperty('--p', `${h} ${s}% ${l}%`);
        } else {
          document.body.style.setProperty('--p', '214 100% 40%');
        }

        // Module icon map (distinct from generic chevron-right ping-pub look)
        const iconMap: Record<string, string> = {
          dashboard: 'mdi-view-dashboard-outline',
          blocks: 'mdi-cube-outline',
          tx: 'mdi-swap-horizontal',
          validator: 'mdi-shield-account-outline',
          uptime: 'mdi-heart-pulse',
          account: 'mdi-wallet-outline',
          staking: 'mdi-lock-outline',
          governance: 'mdi-vote-outline',
          ibc: 'mdi-transit-connection-variant',
          cosmwasm: 'mdi-code-braces',
          parameters: 'mdi-cog-outline',
          consensus: 'mdi-radar',
          nft: 'mdi-image-outline',
        };

        // Section grouping — signature of Fluxen / GnoLens style explorers
        const groups: { heading: string; keys: string[] }[] = [
          {
            heading: 'Explorer',
            keys: ['dashboard', 'governance', 'staking', 'blocks', 'tx', 'validator', 'uptime', 'account'],
          },
          {
            heading: 'Advanced',
            keys: ['consensus', 'ibc', 'cosmwasm', 'parameters', 'nft'],
          },
        ];

        const available = routes
          .filter((x) => x.meta.i18n)
          .filter(
            (x) =>
              !this.current?.features ||
              this.current.features.includes(String(x.meta.i18n))
          )
          .map((x) => ({
            key: String(x.meta.i18n),
            title: `module.${x.meta.i18n}`,
            to: { path: x.path.replace(':chain', this.chainName) },
            icon: {
              icon: iconMap[String(x.meta.i18n)] || 'mdi-chevron-right',
              size: '20',
            },
            i18n: true,
            order: Number(x.meta.order || 100),
          }));

        const used = new Set<string>();
        for (const g of groups) {
          const children = g.keys
            .map((k) => available.find((a) => a.key === k))
            .filter(Boolean) as any[];
          if (children.length === 0) continue;
          items.push({ heading: g.heading } as NavSectionTitle);
          children.forEach((c) => {
            used.add(c.key);
            items.push(c as NavLink);
          });
        }
        // Any leftover modules
        const rest = available.filter((a) => !used.has(a.key)).sort((a, b) => a.order - b.order);
        if (rest.length) {
          items.push({ heading: 'More' } as NavSectionTitle);
          rest.forEach((c) => items.push(c as NavLink));
        }
      }

      // Favorites
      const favNavItems: VerticalNavItems = [];
      Object.keys(this.dashboard.favoriteMap).forEach((name) => {
        const ch = this.dashboard.chains[name];
        if (ch && this.dashboard.favoriteMap?.[name]) {
          favNavItems.push({
            title: ch.prettyName || ch.chainName || name,
            to: { path: `/${ch.chainName || name}` },
            icon: { image: ch.logo, size: '22' },
          });
        }
      });

      items.push({ heading: 'Ecosystem' } as NavSectionTitle);
      if (favNavItems.length) {
        items.push({
          title: 'Favorite',
          children: favNavItems,
          badgeContent: favNavItems.length,
          badgeClass: 'bg-primary',
          i18n: true,
          icon: { icon: 'mdi-star', size: '22' },
        } as NavGroup);
      }
      items.push({
        title: 'All Blockchains',
        to: { path: '/' },
        badgeContent: this.dashboard.length,
        badgeClass: 'bg-primary',
        i18n: true,
        icon: { icon: 'mdi-grid', size: '22' },
      } as NavLink);

      return items;
    },
  },
  actions: {
    async initial() {
      // this.current?.themeColor {
      //     const { global } = useTheme();
      //     global.current
      // }
      useWalletStore().$reset();
      if (!this.isConsumerChain) {
        await useStakingStore().init();
      }
      useBankStore().initial();
      useBaseStore().initial();
      useGovStore().initial();
      useMintStore().initial();
      useBlockModule().initial();
      useDistributionStore().initial();
    },

    randomEndpoint(chainName: string): Endpoint | undefined {
      const end = localStorage.getItem(`endpoint-${chainName}`);
      if (end) {
        return JSON.parse(end);
      } else {
        const all = this.current?.endpoints?.rest;
        if (all) {
          const rn = Math.random();
          const endpoint = all[Math.floor(rn * all.length)];
          return endpoint;
        }
      }
    },

    restEndpoints(): Endpoint[] {
      return this.current?.endpoints?.rest || [];
    },

    // Historical REST order: archive / non-pruned first, then rest of the list.
    // Used only for one-shot historical lookups (tx hash, old block) — does NOT
    // permanently switch the live endpoint (archives can lag on tip data).
    historicalRestOrder(preferCurrent = true): Endpoint[] {
      const all = this.restEndpoints();
      if (!all.length) return [];
      const current = (this.endpoint?.address || '').replace(/\/$/, '');
      const score = (ep: Endpoint) => {
        const blob = `${ep.address || ''} ${ep.provider || ''}`.toLowerCase();
        let s = 0;
        if (blob.includes('archive')) s += 100;
        if (blob.includes('full') || blob.includes('history')) s += 40;
        if (blob.includes('allinbits') || blob.includes('citizenweb3')) s += 20;
        if (preferCurrent && (ep.address || '').replace(/\/$/, '') === current) s -= 5;
        return s;
      };
      // Stable sort: higher score first, keep relative order for ties.
      return all
        .map((ep, i) => ({ ep, i, s: score(ep) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.ep);
    },

    /**
     * Fetch a tx by hash with archive/non-pruned REST fallback.
     * 1) try active endpoint
     * 2) on miss/404/pruned error, walk REST list archive-first
     * Never permanently switches the live endpoint.
     */
    async fetchTx(hash: string): Promise<{ tx: any; tx_response: any } | null> {
      const clean = (hash || '').trim();
      if (!clean) return null;

      const tryOne = async (base: string) => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        const res = await client.getTx(clean);
        // Some LCD return 200 with empty body on pruned history — treat as miss.
        if (res && (res as any).tx_response && (res as any).tx_response.txhash) return res;
        if (res && (res as any).tx && (res as any).tx_response) return res;
        return null;
      };

      // 1) active endpoint first (fast path for recent txs)
      const active = this.endpoint?.address;
      if (active && this.rpc) {
        try {
          const hit = await tryOne(active);
          if (hit) return hit as any;
        } catch (e: any) {
          // fall through — pruned / 404 / network
          console.info(`[explorer] tx miss on active REST (${active}): ${e?.message || e}`);
        }
      }

      // 2) walk remaining REST, archive-first
      const seen = new Set<string>();
      if (active) seen.add(active.replace(/\/$/, ''));
      for (const ep of this.historicalRestOrder(false)) {
        const addr = (ep.address || '').replace(/\/$/, '');
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        try {
          const hit = await tryOne(addr);
          if (hit) {
            console.info(`[explorer] tx found via historical REST: ${addr} (${ep.provider || 'unknown'})`);
            return hit as any;
          }
        } catch (e: any) {
          // keep walking
        }
      }
      return null;
    },

    /**
     * Fetch a block by height with archive REST fallback (same policy as fetchTx).
     */
    async fetchHistoricalBlock(height: string | number): Promise<any | null> {
      const h = String(height);
      if (!h) return null;

      const tryOne = async (base: string) => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        const res = await client.getBaseBlockAt(h);
        if (res && (res as any).block?.header?.height) return res;
        return null;
      };

      const active = this.endpoint?.address;
      if (active && this.rpc) {
        try {
          const hit = await tryOne(active);
          if (hit) return hit;
        } catch (e: any) {
          console.info(`[explorer] block ${h} miss on active REST (${active}): ${e?.message || e}`);
        }
      }

      const seen = new Set<string>();
      if (active) seen.add(active.replace(/\/$/, ''));
      for (const ep of this.historicalRestOrder(false)) {
        const addr = (ep.address || '').replace(/\/$/, '');
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        try {
          const hit = await tryOne(addr);
          if (hit) {
            console.info(`[explorer] block ${h} found via historical REST: ${addr}`);
            return hit;
          }
        } catch (e: any) {
          // keep walking
        }
      }
      return null;
    },

    /**
     * Fetch power-event txs with archive-first fallback.
     *
     * Order:
     *   1) archive / history-heavy endpoints (historicalRestOrder, preferCurrent=false)
     *   2) active endpoint (fast path, may be pruned)
     *   3) remaining REST endpoints in config order
     *
     * Returns the first response whose total > 0, or the last response if all
     * endpoints return zero (chain genuinely has no events of that kind).
     * Never permanently switches the live endpoint.
     */
    async fetchPowerEventsTxs(
      query: string,
      params: Record<string, any>,
      page?: PageRequest,
      limit?: number
    ): Promise<PaginatedTxs | null> {
      const tryOne = async (base: string): Promise<PaginatedTxs | null> => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        try {
          const res = await client.getTxs(query, params, page, limit);
          if (res && (res as any).tx_responses) return res as PaginatedTxs;
        } catch (e: any) {
          // pruned / 500 / network — keep walking
        }
        return null;
      };

      const total = (r: PaginatedTxs | null): number => {
        if (!r) return -1;
        const t = (r as any).pagination?.total ?? (r as any).total;
        return Number(t || 0);
      };

      // 1) archive-first walk
      const seen = new Set<string>();
      for (const ep of this.historicalRestOrder(false)) {
        const addr = (ep.address || '').replace(/\/$/, '');
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const res = await tryOne(addr);
        if (res && total(res) > 0) {
          console.info(`[explorer] power-events via archive REST: ${addr} (${ep.provider || 'unknown'}) total=${total(res)}`);
          return res;
        }
      }

      // 2) active endpoint (may be pruned but fast)
      const active = this.endpoint?.address;
      if (active && this.rpc) {
        const addr = active.replace(/\/$/, '');
        if (!seen.has(addr)) {
          seen.add(addr);
          const res = await tryOne(addr);
          if (res) return res;
        }
      }

      // 3) remaining endpoints in config order
      for (const ep of this.restEndpoints()) {
        const addr = (ep.address || '').replace(/\/$/, '');
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const res = await tryOne(addr);
        if (res) return res;
      }

      return null;
    },

    /**
     * Fetch account txs (message.sender) with archive-first fallback.
     * Same policy as fetchPowerEventsTxs: archive → active → rest.
     */
    async fetchAccountTxs(
      sender: string,
      page?: PageRequest,
      limit?: number
    ): Promise<PaginatedTxs | null> {
      const tryOne = async (base: string): Promise<PaginatedTxs | null> => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        try {
          const res = await client.getTxsBySender(sender, page, limit);
          if (res && (res as any).tx_responses) return res as PaginatedTxs;
        } catch (e: any) {
          // pruned / 403 / 500 / network — keep walking
        }
        return null;
      };

      const total = (r: PaginatedTxs | null): number => {
        if (!r) return -1;
        const t = (r as any).pagination?.total ?? (r as any).total;
        return Number(t || 0);
      };

      const seen = new Set<string>();
      for (const ep of this.historicalRestOrder(false)) {
        const addr = (ep.address || '').replace(/\/$/, '');
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const res = await tryOne(addr);
        if (res && total(res) > 0) return res;
      }

      const active = this.endpoint?.address;
      if (active && this.rpc) {
        const addr = active.replace(/\/$/, '');
        if (!seen.has(addr)) {
          seen.add(addr);
          const res = await tryOne(addr);
          if (res) return res;
        }
      }

      for (const ep of this.restEndpoints()) {
        const addr = (ep.address || '').replace(/\/$/, '');
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const res = await tryOne(addr);
        if (res) return res;
      }

      return null;
    },

    // Lightweight liveness probe for a REST/LCD endpoint.
    async healthCheck(address: string, timeoutMs = 6000): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const url = `${address.replace(/\/$/, '')}/cosmos/base/tendermint/v1beta1/blocks/latest`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return false;
        const data = await res.json();
        return !!(data && data.block && data.block.header && data.block.header.height);
      } catch (e) {
        return false;
      }
    },

    async randomSetupEndpoint() {
      const endpoint = this.randomEndpoint(this.chainName);
      if (endpoint) {
        await this.setRestEndpoint(endpoint);
        // Self-heal: if the chosen endpoint is dead, fall back in the background
        // so non-technical users are never stuck on a down RPC.
        this.healthCheck(endpoint.address, 6000).then((ok) => {
          if (!ok) this.fallbackEndpoint();
        });
      }
    },

    // Auto-switch to a healthy REST endpoint when the current one is down.
    async fallbackEndpoint() {
      const all = this.restEndpoints();
      if (all.length <= 1) return;
      const now = Date.now();
      // Guard against concurrent / rapid-fire fallback loops.
      if (this.fallbackInProgress || now - this.lastFallbackAt < 15000) return;
      this.fallbackInProgress = true;
      this.lastFallbackAt = now;
      try {
        const current = this.endpoint?.address;
        const candidates = all.filter((e) => e.address !== current);
        const results = await Promise.all(
          candidates.map(async (ep) => ({ ep, ok: await this.healthCheck(ep.address, 5000) }))
        );
        // Pick the first healthy candidate in config order.
        const healthy = results.find((r) => r.ok);
        if (healthy && healthy.ep.address !== current) {
          console.info(`[explorer] RPC fallback: ${current} -> ${healthy.ep.address}`);
          this.connErr = '';
          await this.setRestEndpoint(healthy.ep);
        }
      } finally {
        this.fallbackInProgress = false;
      }
    },

    async setRestEndpoint(endpoint: Endpoint) {
      this.connErr = '';
      this.endpoint = endpoint;
      this.rpc = CosmosRestClient.newStrategy(endpoint.address, this.current);
      localStorage.setItem(`endpoint-${this.chainName}`, JSON.stringify(endpoint));
    },
    async setCurrent(name: string) {
      // Ensure chains are loaded due to asynchronous calls.
      if (this.dashboard.length === 0) {
        await this.dashboard.initial();
      }

      // Find the case-sensitive name for the chainName, else simply use the parameter-value.
      const caseSensitiveName =
        Object.keys(this.dashboard.chains).find((x) => x.toLowerCase() === name.toLowerCase()) || name;

      // Update chainName if needed
      if (caseSensitiveName !== this.chainName) {
        this.chainName = caseSensitiveName;
      }
    },
    supportModule(mod: string) {
      return !this.current?.features || this.current.features.includes(mod);
    },
  },
});
