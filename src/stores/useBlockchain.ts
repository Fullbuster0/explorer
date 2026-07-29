import { defineStore } from 'pinia';
import type { ChainConfig, Endpoint } from '@/types/chaindata';
import { useDashboard} from './useDashboard';
import type { NavLink, NavSectionTitle, VerticalNavItems } from '@/layouts/types';
import { useRouter } from 'vue-router';
import { CosmosRestClient } from '@/libs/client';
import { GnoTm2Client } from '@/libs/gno/client';
import { isGnoChain, tm2Health } from '@/libs/gno/tm2';
import { initGnoValopers } from '@/libs/gno/valopers';
import { PageRequest, type PaginatedTxs, type TxResponse } from '@/types';
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
      // For Gno/TM2 chains this is a GnoTm2Client (same method surface).
      rpc: undefined as CosmosRestClient | GnoTm2Client | undefined,
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

        // Prefer explicit nav routes (meta.order set). Detail routes like
        // /ibc/connection/chain/:chain_id also carry meta.i18n but have no
        // order — picking them would put a literal ":chain_id" in the sidebar.
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
            _hasOrder: x.meta.order !== undefined,
          }));

        // One nav entry per module key — the route with explicit meta.order
        // wins; only fall back to the lowest-order route if none is marked.
        const byKey = new Map<string, (typeof available)[number]>();
        for (const a of available) {
          const prev = byKey.get(a.key);
          if (!prev) {
            byKey.set(a.key, a);
          } else if (a._hasOrder && !prev._hasOrder) {
            byKey.set(a.key, a);
          } else if (a._hasOrder === prev._hasOrder && a.order < prev.order) {
            byKey.set(a.key, a);
          }
        }
        const uniqueAvailable = [...byKey.values()];

        const used = new Set<string>();
        for (const g of groups) {
          const children = g.keys
            .map((k) => uniqueAvailable.find((a) => a.key === k))
            .filter(Boolean) as any[];
          if (children.length === 0) continue;
          items.push({ heading: g.heading } as NavSectionTitle);
          children.forEach((c) => {
            used.add(c.key);
            items.push(c as NavLink);
          });
        }
        // Any leftover modules
        const rest = uniqueAvailable.filter((a) => !used.has(a.key)).sort((a, b) => a.order - b.order);
        if (rest.length) {
          items.push({ heading: 'More' } as NavSectionTitle);
          rest.forEach((c) => items.push(c as NavLink));
        }
      }

      items.push({ heading: 'Ecosystem' } as NavSectionTitle);
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
      const all = this.current?.endpoints?.rest;
      const end = localStorage.getItem(`endpoint-${chainName}`);
      if (end) {
        try {
          const saved = JSON.parse(end) as Endpoint;
          // Only trust the cached endpoint if it still belongs to this chain's
          // current list. A stale/dead cached endpoint (e.g. from an old config
          // or a node that went down) would otherwise be re-used forever and
          // freeze the app until the user cleared storage / hard-refreshed.
          if (saved?.address && all?.some((e) => e.address === saved.address)) {
            return saved;
          }
        } catch {
          /* corrupt cache — fall through to weighted pick */
        }
      }
      if (all && all.length) {
        // Weighted toward the front of the config list. Chain JSON is curated
        // with reliable/CORS-friendly hosts first; pure Math.random() across
        // 20+ public LCDs often landed on CORS-broken or archive hosts
        // (citizenweb3, kleomedes, …) and first-paint failed until fallback.
        // Weight ≈ (n - i): index 0 is n× more likely than the last entry.
        const n = all.length;
        let total = 0;
        const weights = all.map((_, i) => {
          const w = n - i;
          total += w;
          return w;
        });
        let r = Math.random() * total;
        for (let i = 0; i < n; i++) {
          r -= weights[i];
          if (r <= 0) return all[i];
        }
        return all[0];
      }
      return undefined;
    },

    restEndpoints(): Endpoint[] {
      return this.current?.endpoints?.rest || [];
    },

    /** Archive (tx_indexer-heavy) endpoints — chain may declare these
     *  separately under `endpoints.archive` to enable historical txs
     *  queries without sacrificing the live `api[]` order. */
    archiveEndpoints(): Endpoint[] {
      return this.current?.endpoints?.archive || [];
    },

    // Historical REST order: explicit archive endpoints first, then any
    // provider/url substring matches (archive/full/history/allinbits/...), then
    // the rest of the list. Used only for one-shot historical lookups (tx
    // hash, old block, account history) — does NOT permanently switch the
    // live endpoint (archives can lag on tip data).
    historicalRestOrder(preferCurrent = true): Endpoint[] {
      // First hop: explicit `archived_api` from chain config (curated).
      // Second hop: same scoring heuristic on the live `restEndpoints()` list.
      const archive = this.archiveEndpoints();
      const all = this.restEndpoints();
      if (!archive.length && !all.length) return [];
      const explicit = new Set(
        archive.map((ep) => (ep.address || '').replace(/\/$/, ''))
      );
      const current = (this.endpoint?.address || '').replace(/\/$/, '');
      const score = (ep: Endpoint, isExplicit: boolean) => {
        const blob = `${ep.address || ''} ${ep.provider || ''}`.toLowerCase();
        let s = isExplicit ? 1000 : 0;
        if (blob.includes('archive')) s += 100;
        if (blob.includes('full') || blob.includes('history')) s += 40;
        if (blob.includes('allinbits') || blob.includes('citizenweb3')) s += 20;
        if (preferCurrent && (ep.address || '').replace(/\/$/, '') === current) s -= 5;
        return s;
      };
      const rank = (entries: Endpoint[], isExplicit: boolean) =>
        entries
          .map((ep, i) => ({ ep, i, s: score(ep, isExplicit) }))
          .sort((a, b) => b.s - a.s || a.i - b.i)
          .map((x) => x.ep);
      const rankedExplicit = rank(archive, true);
      const rankedRest = rank(
        all.filter(
          (ep) => !explicit.has((ep.address || '').replace(/\/$/, ''))
        ),
        false
      );
      return [...rankedExplicit, ...rankedRest];
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
      console.info('[store] fetchPowerEventsTxs', query.slice(0, 60), 'current=', !!this.current, 'endpoint=', !!this.endpoint?.address);
      const tryOne = async (base: string): Promise<PaginatedTxs | null> => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        try {
          console.info(`[store] tryOne ${base.slice(0, 40)} query=${query.slice(0, 50)}`);
          // Race: fetch vs 15s timeout
          const res = await Promise.race([
            client.getTxs(query, params, page, limit),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_15S')), 15000)),
          ]);
          const t = (res as any)?.pagination?.total ?? (res as any)?.total ?? 0;
          console.info(`[store] tryOne ${base.slice(0, 40)} → total=${t} rows=${(res as any)?.tx_responses?.length ?? 0}`);
          if (res && (res as any).tx_responses) return res as PaginatedTxs;
        } catch (e: any) {
          const msg = e?.message === 'TIMEOUT_15S' ? 'TIMEOUT (15s)' : (e?.message || e);
          console.warn(`[store] tryOne ${base.slice(0, 40)} FAILED: ${msg}`);
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
     * Fetch the latest N transactions chain-wide (most-recent first).
     * Uses the indexed tx search (query=tx.height>0 + order_by desc) so it works
     * even on low-traffic chains where the last 50 blocks are all empty.
     * Fast path: active endpoint first (this feed refreshes every ~block, so we
     * want the quickest healthy node); then archive; then remaining rest.
     */
    async fetchRecentTxs(limit = 5): Promise<PaginatedTxs | null> {
      const query = `?query=tx.height>0`;
      const page = new PageRequest();
      page.setPageSize(limit);

      const tryOne = async (base: string): Promise<PaginatedTxs | null> => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        try {
          const res = await Promise.race([
            client.getTxs(query, {}, page, limit),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_12S')), 12000)),
          ]);
          if (res && (res as any).tx_responses?.length) return res as PaginatedTxs;
        } catch (e) {
          // pruned / 403 / 500 / network / timeout — keep walking
        }
        return null;
      };

      const seen = new Set<string>();

      // 1) active endpoint (fastest, already selected as healthy)
      const active = this.endpoint?.address;
      if (active && this.rpc) {
        const addr = active.replace(/\/$/, '');
        seen.add(addr);
        const res = await tryOne(addr);
        if (res) return res;
      }

      // 2) archive-first walk (in case active is pruned/indexer-disabled)
      for (const ep of this.historicalRestOrder(false)) {
        const addr = (ep.address || '').replace(/\/$/, '');
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const res = await tryOne(addr);
        if (res) return res;
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
     * Fetch an address's full tx history with archive-first failover +
     * sender/receiver UNION.
     *
     * Why this is shaped the way it is:
     *
     *   - Cosmos SDK tx-search doesn't accept OR (no `sender OR recipient`).
     *     So we must issue TWO queries — one for `message.sender` (outbound /
     *     signed txs) and one for `coin_received.receiver` (inbound txs the
     *     user didn't sign, e.g. airdrop multi-sends, IBC incoming).
     *
     *   - Each archive indexes a different subset. Probed against the test
     *     address (atone1ez8k...4s3v, 2026-07-27):
     *       PublicNode     : 100/167 total, exposes `total` field
     *       AllinBits      :  26/?    sender only, no `total`
     *       cosmos.directory: 14 IN   receiver only (sender proxy broken)
     *       ITRocket       : down
     *     Every endpoint IGNORES `pagination.limit` and `pagination.offset` —
     *     they always return the first ≤100 of the indexed set.
     *
     *   - We walk ONLY the curated `archiveEndpoints()` list (typically
     *     4 mirrors per chain). We do NOT touch the live `restEndpoints()`
     *     list — those are the user's live balance/delegation sources and
     *     may be pruned or slow, plus iterating 33 of them per page load
     *     was the cause of the infinite-loading bug.
     *
     *   - Stop walking as soon as the merged set hits SERVER_CAP (100). Every
     *     archive caps at 100 rows anyway, so further archives can't add.
     *
     *   - Pagination stays client-side (the slice logic in the page). Server
     *     `count_total` is unreliable — we expose `txs_total` as the actual
     *     fetched count.
     */
    async fetchAccountTxs(
      address: string,
      page?: PageRequest,
      limit?: number
    ): Promise<PaginatedTxs | null> {
      const tryBoth = async (
        base: string
      ): Promise<TxResponse[] | null> => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        const seen = new Map<string, TxResponse>(); // hash -> response (dedupe)
        const tryOne = async (
          q: 'sender' | 'receiver'
        ): Promise<TxResponse[] | null> => {
          try {
            const res =
              q === 'sender'
                ? await client.getTxsBySender(address, page, limit)
                : await client.getTxsByReceiver(address, page, limit);
            if (!res) return null;
            const rows = (res as any).tx_responses || (res as any).txs || [];
            return Array.isArray(rows) ? (rows as TxResponse[]) : null;
          } catch (e: any) {
            // pruned / 403 / 500 / network / unsupported event filter
            return null;
          }
        };

        const s = await tryOne('sender');
        if (s) for (const r of s) if (r.txhash) seen.set(r.txhash, r);
        const r = await tryOne('receiver');
        if (r) for (const x of r) if (x.txhash) seen.set(x.txhash, x);

        if (!seen.size) return null;
        return Array.from(seen.values()).sort(
          (a, b) => Number(b.height || 0) - Number(a.height || 0)
        );
      };

      // Walk ONLY the curated archive endpoints. Walking the full 33-entry
      // `restEndpoints()` list was the previous bug — every page load fired
      // ~74 HTTP requests (~37 endpoints × sender+receiver) and waited for
      // all of them, even after we'd already saturated the indexed result
      // set on the first archive. We only need the few archive mirrors here.
      const merged = new Map<string, TxResponse>();
      let bestTotal = 0;
      const seenEndpoints = new Set<string>();

      // Hard cap mirrors the server-side reality: every atomone LCD ignores
      // `pagination.limit` and caps at ~100 rows. No endpoint exposes more.
      // (Verified 2026-07-27 against PublicNode/AllinBits/cosmos.directory.)
      const SERVER_CAP = 100;

      const collect = async (addr: string) => {
        const cleaned = addr.replace(/\/$/, '');
        if (!cleaned || seenEndpoints.has(cleaned)) return;
        // We've already saturated the indexed result. Stop walking.
        if (merged.size >= SERVER_CAP) return;
        seenEndpoints.add(cleaned);
        const rows = await tryBoth(cleaned);
        if (!rows) return;
        for (const r of rows) if (r.txhash) merged.set(r.txhash, r);
      };

      for (const ep of this.archiveEndpoints()) {
        if (merged.size >= SERVER_CAP) break;
        await collect(ep.address);
      }

      if (!merged.size) return null;

      // Sort by height DESC — matches what a single endpoint would return.
      const sorted = Array.from(merged.values()).sort(
        (a, b) => Number(b.height || 0) - Number(a.height || 0)
      );

      // We don't have a trustworthy global total (each endpoint returns its
      // own view). Use the largest fetch as a lower-bound estimate.
      bestTotal = sorted.length;

      return {
        txs: [] as any[],
        tx_responses: sorted,
        pagination: { total: String(bestTotal) } as any,
      } as unknown as PaginatedTxs;
    },

    // Lightweight liveness probe for a REST/LCD endpoint.
    async healthCheck(address: string, timeoutMs = 6000): Promise<boolean> {
      // Gnoland / TM2 has no Cosmos LCD — probe `/status` on the JSON-RPC host.
      if (isGnoChain(this.current)) {
        return tm2Health(address, timeoutMs);
      }
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
      } else {
        // No endpoint configured at all — still try a fallback pick so the page
        // doesn't sit forever waiting for an RPC that will never be wired.
        this.fallbackEndpoint();
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
          // Re-run chain init so stores that already gave up (or never started
          // because the old RPC was dead) get a fresh shot — no manual refresh.
          this.initial();
        }
      } finally {
        this.fallbackInProgress = false;
      }
    },

    async setRestEndpoint(endpoint: Endpoint) {
      this.connErr = '';
      this.endpoint = endpoint;
      // Gnoland (Tendermint2): no Cosmos LCD — wire the TM2 JSON-RPC client.
      // `api[]` in chain config holds the same RPC hosts (so restEndpoints /
      // health / fallback keep working without a parallel code path).
      if (isGnoChain(this.current)) {
        this.rpc = GnoTm2Client.new(endpoint.address) as unknown as CosmosRestClient;
        // Fire-and-forget: merge live valoper registry from official realm
        initGnoValopers(this.chainName).catch(() => {});
      } else {
        this.rpc = CosmosRestClient.newStrategy(endpoint.address, this.current);
      }
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
