import { defineStore } from 'pinia';
import type { ChainConfig, Endpoint } from '@/types/chaindata';
import { useDashboard} from './useDashboard';
import type { NavLink, NavSectionTitle, VerticalNavItems } from '@/layouts/types';
import { useRouter } from 'vue-router';
import { CosmosRestClient } from '@/libs/client';
import { GnoTm2Client } from '@/libs/gno/client';
import { isGnoChain, tm2Health } from '@/libs/gno/tm2';
import { initGnoValopers } from '@/libs/gno/valopers';
import {
  rankRpcs,
  pickTipPeers,
  qualityToEndpoint,
  type RpcQuality,
} from '@/libs/rpc-quality';
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

// ---- RPC endpoint health denylist (localStorage-backed) ----
// Endpoints that fail browser-side (CORS, timeout, lagging) get marked bad.
// randomEndpoint / fallbackEndpoint skip them for a TTL so users don't
// repeatedly land on broken hosts.
const DENY_TTL_MS = 60 * 60 * 1000; // 1 hour
const LAG_THRESHOLD = 100; // blocks behind → demote

interface DenyEntry { ok: boolean; reason: string; ts: number; lag?: number }
type DenyMap = Record<string, DenyEntry>;

function denyKey(chain: string) { return `endpoint-health-${chain}`; }
function readDeny(chain: string): DenyMap {
  try { return JSON.parse(localStorage.getItem(denyKey(chain)) || '{}'); } catch { return {}; }
}
function writeDeny(chain: string, map: DenyMap) {
  try { localStorage.setItem(denyKey(chain), JSON.stringify(map)); } catch { /* quota */ }
}
function markBad(chain: string, addr: string, reason: string, lag?: number) {
  const m = readDeny(chain);
  m[addr] = { ok: false, reason, ts: Date.now(), lag };
  writeDeny(chain, m);
}
function markGood(chain: string, addr: string) {
  const m = readDeny(chain);
  if (m[addr]) { delete m[addr]; writeDeny(chain, m); }
}
function isDenied(chain: string, addr: string): boolean {
  const e = readDeny(chain)[addr];
  if (!e) return false;
  if (e.ok) return false;
  if (Date.now() - e.ts > DENY_TTL_MS) return false; // TTL expired → retry
  return true;
}

// Richest RPC tx_search index per chain+address, cached so account-history
// page turns don't re-probe every click (fetchAccountTxsPage).
const pageRpcCache = new Map<string, { base: string; total: number }>();

export const useBlockchain = defineStore('blockchain', {
  state: () => {
    return {
      status: {} as Record<string, string>,
      rest: '',
      chainName: '',
      endpoint: {} as Endpoint,
      /** User-facing connection hint (never raw RPC jargon as primary copy). */
      connErr: '',
      fallbackInProgress: false,
      lastFallbackAt: 0,
      /** ok | reconnecting | degraded — drives statusbar without requiring RPC literacy. */
      connPhase: 'ok' as 'ok' | 'reconnecting' | 'degraded',
      /** Short chip after a successful silent switch (cleared by UI after a few seconds). */
      justRecovered: false,
      /** How many auto-fallback sweeps ran since last healthy connect. */
      fallbackAttempts: 0,
      /** Epoch guard: bumped on every chain switch so stale probes can't set connPhase. */
      _setupEpoch: 0,
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
          realms: 'mdi-package-variant-closed',
          tokens: 'mdi-circle-multiple-outline',
        };

        // Section grouping — signature of Fluxen / GnoLens style explorers
        const groups: { heading: string; keys: string[] }[] = [
          {
            heading: 'Explorer',
            keys: ['dashboard', 'governance', 'staking', 'blocks', 'tx', 'validator', 'uptime', 'account', 'realms', 'tokens'],
          },
          {
            heading: 'Advanced',
            keys: ['consensus', 'ibc', 'cosmwasm', 'parameters', 'nft'],
          },
        ];

        // Prefer explicit nav routes (meta.order set). Detail routes like
        // /ibc/connection/chain/:chain_id also carry meta.i18n but have no
        // order — picking them would put a literal ":chain_id" in the sidebar.
        const isGnoEngine =
          this.current?.engine === 'gno' || this.current?.engine === 'tm2';
        const available = routes
          .filter((x) => x.meta.i18n)
          .filter(
            (x) =>
              !this.current?.features ||
              this.current.features.includes(String(x.meta.i18n))
          )
          // Gno-only modules (realms/tokens + any /gno-* page) show only on Gno chains
          .filter((x) => {
            const key = String(x.meta.i18n);
            const gnoOnly = key === 'realms' || key === 'tokens' || x.path.includes('/gno-');
            return gnoOnly ? isGnoEngine : true;
          })
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
            _gno: x.path.includes('/gno-'),
          }));

        // One nav entry per module key. On Gno chains prefer the /gno-* route
        // (e.g. gno-tx over the Cosmos LCD tx page); on Cosmos chains prefer
        // the non-gno route. Otherwise the explicit meta.order wins.
        const byKey = new Map<string, (typeof available)[number]>();
        for (const a of available) {
          const prev = byKey.get(a.key);
          if (!prev) {
            byKey.set(a.key, a);
          } else if (isGnoEngine && a._gno && !prev._gno) {
            byKey.set(a.key, a);
          } else if (!isGnoEngine && !a._gno && prev._gno) {
            byKey.set(a.key, a);
          } else if (a._gno === prev._gno && a._hasOrder && !prev._hasOrder) {
            byKey.set(a.key, a);
          } else if (a._gno === prev._gno && a._hasOrder === prev._hasOrder && a.order < prev.order) {
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
          // current list AND is not in the health denylist.
          if (saved?.address && all?.some((e) => e.address === saved.address) && !isDenied(chainName, saved.address)) {
            return saved;
          }
        } catch {
          /* corrupt cache — fall through to weighted pick */
        }
      }
      if (all && all.length) {
        // Filter out denied endpoints first
        const healthy = all.filter((e) => !isDenied(chainName, e.address));
        const pool = healthy.length > 0 ? healthy : all; // never empty
        // Weighted toward the front of the config list.
        const n = pool.length;
        let total = 0;
        const weights = pool.map((_, i) => {
          const w = n - i;
          total += w;
          return w;
        });
        let r = Math.random() * total;
        for (let i = 0; i < n; i++) {
          r -= weights[i];
          if (r <= 0) return pool[i];
        }
        return pool[0];
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
     *
     * Gno/TM2: use the live GnoTm2Client directly (RPC /tx) — do NOT walk
     * Cosmos REST endpoints (they don't exist on TM2).
     */
    async fetchTx(hash: string): Promise<{ tx: any; tx_response: any } | null> {
      const clean = (hash || '').trim();
      if (!clean) return null;

      // Gno path — single RPC client, multi-format hash inside getTx
      if (this.current && isGnoChain(this.current as any)) {
        try {
          if (this.rpc && typeof (this.rpc as any).getTx === 'function') {
            const res = await (this.rpc as any).getTx(clean);
            if (res && (res as any).tx_response && ((res as any).tx_response.txhash || (res as any).tx_response.height)) {
              return res as any;
            }
          }
          // Rebuild client from active endpoint if store rpc not ready
          const active = this.endpoint?.address;
          if (active) {
            const client = GnoTm2Client.new(active);
            const res = await client.getTx(clean);
            if (res && (res as any).tx_response && ((res as any).tx_response.txhash || (res as any).tx_response.height)) {
              return res as any;
            }
          }
        } catch (e: any) {
          console.info(`[explorer] gno tx miss: ${e?.message || e}`);
        }
        return null;
      }

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
     *
     * Gno/TM2: use GnoTm2Client.getBaseBlockAt (JSON-RPC /block) — do NOT walk
     * Cosmos LCD against TM2 hosts.
     */
    async fetchHistoricalBlock(height: string | number): Promise<any | null> {
      const h = String(height);
      if (!h) return null;

      // Gno path — single RPC client
      if (this.current && isGnoChain(this.current as any)) {
        try {
          if (this.rpc && typeof (this.rpc as any).getBaseBlockAt === 'function') {
            const res = await (this.rpc as any).getBaseBlockAt(h);
            if (res && (res as any).block?.header?.height) return res;
          }
          const active = this.endpoint?.address;
          if (active) {
            const client = GnoTm2Client.new(active);
            const res = await client.getBaseBlockAt(h);
            if (res && (res as any).block?.header?.height) return res;
          }
        } catch (e: any) {
          console.info(`[explorer] gno block ${h} miss: ${e?.message || e}`);
        }
        return null;
      }

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
      // Gno/TM2: no Cosms tx-search / LCD events — never walk REST against TM2.
      if (this.current && isGnoChain(this.current as any)) {
        return null;
      }
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
      // Gno uses /gno-tx indexer feed — Cosms tx.height search does not exist on TM2.
      if (this.current && isGnoChain(this.current as any)) {
        return null;
      }
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
      limit?: number,
      onProgress?: (rows: TxResponse[], total: number) => void
    ): Promise<PaginatedTxs | null> {
      // Gno/TM2: no Cosmos LCD archives. Account history comes from the onbloc
      // indexer (see account/[address].vue loadTxHistory). Walking archiveEndpoints
      // against Gno RPC hosts hangs 12s×N and freezes the page until refresh.
      if (isGnoChain(this.current)) {
        return {
          txs: [] as any[],
          tx_responses: [],
          pagination: { total: '0' } as any,
        } as unknown as PaginatedTxs;
      }
      const tryBoth = async (
        base: string
      ): Promise<{ rows: TxResponse[]; total: number } | null> => {
        const client = CosmosRestClient.newStrategy(base, this.current);
        const seen = new Map<string, TxResponse>(); // hash -> response (dedupe)
        let total = 0; // chain-wide (sender+receiver count_total) if exposed
        const tryOne = async (
          q: 'sender' | 'receiver'
        ): Promise<TxResponse[] | null> => {
          try {
            const res =
              q === 'sender'
                ? await client.getTxsBySender(address, page, limit)
                : await client.getTxsByReceiver(address, page, limit);
            if (!res) return null;
            // count_total is on by default (PageRequest) — archives that honour
            // it expose the true chain-wide total for this query. Sum sender +
            // receiver ≈ the mintscan-style "all txs involving this address".
            const t = Number((res as any)?.pagination?.total ?? (res as any)?.total ?? 0);
            if (Number.isFinite(t)) total += t;
            const rows = (res as any).tx_responses || (res as any).txs || [];
            return Array.isArray(rows) ? (rows as TxResponse[]) : null;
          } catch (e: any) {
            // pruned / 403 / 500 / network / unsupported event filter
            return null;
          }
        };

        // Sender + receiver are independent queries — fire them in parallel.
        const [s, r] = await Promise.all([tryOne('sender'), tryOne('receiver')]);
        if (s) for (const x of s) if (x.txhash) seen.set(x.txhash, x);
        if (r) for (const x of r) if (x.txhash) seen.set(x.txhash, x);

        if (!seen.size) return null;
        const rows = Array.from(seen.values()).sort(
          (a, b) => Number(b.height || 0) - Number(a.height || 0)
        );
        return { rows, total };
      };

      // Walk ONLY the curated archive endpoints. Walking the full 33-entry
      // `restEndpoints()` list was the previous bug — every page load fired
      // ~74 HTTP requests (~37 endpoints × sender+receiver) and waited for
      // all of them, even after we'd already saturated the indexed result
      // set on the first archive. We only need the few archive mirrors here.
      const merged = new Map<string, TxResponse>();
      let bestTotal = 0;
      const seenEndpoints = new Set<string>();

      // Client buffer cap (Option A): load up to 500 newest txs and paginate
      // them client-side. Each LCD still returns only its first ≤100 rows
      // (offsets ignored), but the union across mirrors + the RPC fallback
      // can reach 500. The TRUE chain-wide total is carried separately in
      // `bestTotal` (from count_total / total_count) so the header can show
      // e.g. "2,948 Transactions" even when only 500 are loaded.
      const SERVER_CAP = 500;

      // Progressive first paint: hand the caller whatever rows we have so far so
      // the table renders the moment the FIRST archive responds — instead of
      // making the user wait for the full multi-source union. Matters most for
      // relayer accounts (terra/lava) whose txs carry full light-client headers:
      // each archive query is ~5MB, so the union takes many seconds but the
      // fastest mirror returns usable rows in ~1s. total updates as archives
      // report their count_total; rows are deduped+sorted on every emit.
      let lastEmitted = -1;
      const emit = () => {
        if (!onProgress || merged.size === lastEmitted) return;
        lastEmitted = merged.size;
        const rows = Array.from(merged.values())
          .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
          .slice(0, SERVER_CAP);
        onProgress(rows, bestTotal > 0 ? bestTotal : rows.length);
      };

      const collect = async (addr: string) => {
        const cleaned = addr.replace(/\/$/, '');
        if (!cleaned || seenEndpoints.has(cleaned)) return;
        // Buffer full — stop fetching rows, but keep walking cheaply? No:
        // archives cap at 100 rows so the union rarely hits 500 from LCD
        // alone; walking all mirrors also gives us the best (max) total.
        if (merged.size >= SERVER_CAP) return;
        seenEndpoints.add(cleaned);
        const hit = await tryBoth(cleaned);
        if (!hit) return;
        for (const r of hit.rows) if (r.txhash) merged.set(r.txhash, r);
        if (hit.total > bestTotal) bestTotal = hit.total;
        emit(); // first paint / progressive update as each archive lands
      };

      // Probe all curated archives in parallel (independent endpoints). Was a
      // sequential `for…await` — each dead/slow archive added its full timeout
      // to the wait. collect() still early-stops once the shared buffer is full.
      await Promise.all(this.archiveEndpoints().map((ep) => collect(ep.address)));

      // Consult the RPC tx_search index whenever the LCD buffer isn't full.
      //
      // Two failure modes this must cover:
      //  1. LCD dead end (Lava): relayer wallets produce result sets larger
      //     than every public LCD's internal gRPC max-message size, so
      //     tx-by-event queries fail with "received message larger than max"
      //     → merged stays empty.
      //  2. Pruned LCD masquerading as complete (Cosmos Hub): lavenderfive
      //     returns only its recent slice WITH count_total matching that
      //     slice (e.g. 2 of the true 511), so `bestTotal == merged.size`
      //     and the old `bestTotal > merged.size` guard never fired — the
      //     archive RPC (citizenweb3, total_count 511) was never consulted.
      //
      // Pruned LCDs report their own shrunken view as count_total, so LCD
      // bestTotal alone can't be trusted as the chain-wide total. The RPC
      // union picks the archive node's true total_count and fills the buffer
      // up to SERVER_CAP. Skip only when LCD already saturated the buffer —
      // nothing more to load (e.g. Terra: 500 loaded, total carried as 2,950).
      if (merged.size < SERVER_CAP) {
        const fb = await this.rpcTxSearchFallback(address);
        for (const r of fb.rows) if (r.txhash) merged.set(r.txhash, r);
        if (fb.total > bestTotal) bestTotal = fb.total;
        emit(); // RPC union may add rows + the archive node's true total
      }

      if (!merged.size) return null;

      // Sort by height DESC — matches what a single endpoint would return.
      const sorted = Array.from(merged.values())
        .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
        .slice(0, SERVER_CAP);

      // Prefer the true chain-wide total (count_total / total_count) so the
      // header matches mintscan; fall back to the fetched count if no archive
      // exposed a total.
      const total = bestTotal > 0 ? bestTotal : sorted.length;

      return {
        txs: [] as any[],
        tx_responses: sorted,
        pagination: { total: String(total) } as any,
      } as unknown as PaginatedTxs;
    },

    /**
     * Tendermint RPC tx_search fallback for account history.
     *
     * Some chains' public LCDs cannot serve tx-by-event queries for very
     * active accounts: Lava relayer wallets produce result sets larger than
     * the node's internal gRPC max-message size (~10MB), so every LCD returns
     * `grpc: received message larger than max` no matter the pagination.limit
     * (which most LCDs ignore anyway). RPC `/tx_search` honours `per_page`
     * and returns compact indexed results. Verified 2026-08-01 against
     * lava-rpc.polkachu.com (CORS: *).
     *
     * Conversion: tx_search items → TxResponse-shaped rows the account table
     * already renders. Message @types come from the `message.action` event
     * (base64 on Tendermint 0.34, plain on CometBFT 0.37+). Timestamps need
     * a block-header fetch per unique height (batched, capped at 40).
     */
    async rpcTxSearchFallback(address: string): Promise<{ rows: TxResponse[]; total: number }> {
      const rpcs = (this.current?.endpoints?.rpc || []).slice(0, 8);
      if (!rpcs.length) return { rows: [], total: 0 };

      // address is interpolated raw into the tx_search query string below
      // (`message.sender='${address}'`). Real bech32/gno addresses are pure
      // [a-zA-Z0-9]; reject anything else so a crafted route param can't break
      // out of the quoted value and reshape the query. Client-side, so this is
      // defense-in-depth (no cross-user impact), not a live vuln.
      if (!/^[a-zA-Z0-9]+$/.test(address)) return { rows: [], total: 0 };

      // Tendermint 0.34 base64-encodes event keys/values; CometBFT 0.37+
      // emits plain strings. Decode only when it looks like base64 AND
      // yields printable text.
      const decodeAttr = (s: string): string => {
        if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 === 1) return s;
        try {
          const d = atob(s);
          return /^[\x20-\x7e]+$/.test(d) ? d : s;
        } catch {
          return s;
        }
      };

      const fetchJson = async (url: string, timeoutMs = 8000): Promise<any> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null; // CORS / timeout / network — try next endpoint
        } finally {
          clearTimeout(timer);
        }
      };

      const queries = [
        `message.sender='${address}'`,
        `coin_received.receiver='${address}'`,
      ];

      const RPC_CAP = 500; // match the LCD buffer cap (Option A)
      type RawItem = { hash: string; height: string; tx_result?: any };
      const found = new Map<string, RawItem>();
      let workingRpc = '';
      let total = 0; // chain-wide (sender+receiver total_count), max across RPCs

      // tx_search requires the query wrapped in double quotes; order_by must be
      // a quoted JSON string ("desc") — bare `desc` fails the URI→JSON-RPC param
      // converter on Tendermint 0.34. per_page maxes at 100, so page 1..5 for cap.
      const fetchPage = async (base: string, q: string, pg: number) => {
        const url = `${base}/tx_search?query=${encodeURIComponent(`"${q}"`)}&per_page=100&page=${pg}&order_by=${encodeURIComponent('"desc"')}`;
        return await fetchJson(url);
      };

      // PHASE 1 — parallel probe: page 1 of every RPC × both queries at once.
      // Was a sequential `for (rpc) for (q) while (pg)` — up to ~40 serial
      // requests, which is why "Fetching history from archive…" hung for tens
      // of seconds. Probing yields each provider's total_count + its newest
      // ≤100 rows (a union of recent tx across mirrors, nearly free).
      const probes = await Promise.all(
        rpcs.map(async (rpc) => {
          const base = (rpc.address || '').replace(/\/$/, '');
          if (!base) return { base: '', rpcTotal: 0, got: false };
          let rpcTotal = 0;
          let got = false;
          await Promise.all(
            queries.map(async (q) => {
              const data = await fetchPage(base, q, 1);
              const txs = data?.result?.txs;
              if (!Array.isArray(txs)) return;
              const tc = Number(data?.result?.total_count ?? 0);
              if (Number.isFinite(tc)) rpcTotal += tc; // sender + receiver
              for (const t of txs) if (t?.hash) { found.set(t.hash, t); got = true; }
            })
          );
          return { base, rpcTotal, got };
        })
      );

      // Pick the richest index (max total_count) = the most complete archive.
      // Pruned mirrors report small totals and lose; the archive node wins and
      // is the one we page for depth (cosmoshub: citizenweb3 511 vs polkachu 0).
      let best: { base: string; rpcTotal: number } | null = null;
      for (const p of probes) {
        if (p.got && !workingRpc) workingRpc = p.base; // for block-header timestamps
        if (p.rpcTotal > total) total = p.rpcTotal;
        if (p.base && (!best || p.rpcTotal > best.rpcTotal)) best = { base: p.base, rpcTotal: p.rpcTotal };
      }

      // PHASE 2 — page the best RPC (pages 2..5, both queries) in parallel to
      // fill the buffer to RPC_CAP. Depth from the richest index beats unioning
      // deep pages of pruned mirrors (those are subsets of the archive anyway).
      if (best && found.size < RPC_CAP) {
        const b = best.base;
        await Promise.all(
          [2, 3, 4, 5].map(async (pg) => {
            await Promise.all(
              queries.map(async (q) => {
                if (found.size >= RPC_CAP) return;
                const data = await fetchPage(b, q, pg);
                const txs = data?.result?.txs;
                if (Array.isArray(txs)) for (const t of txs) if (t?.hash) found.set(t.hash, t);
              })
            );
          })
        );
      }

      const items = Array.from(found.values());
      if (!items.length) return { rows: [], total };

      const rows: TxResponse[] = items.map((item) => {
        const tr = item.tx_result || {};
        const events = (Array.isArray(tr.events) ? tr.events : []).map((ev: any) => ({
          type: decodeAttr(String(ev.type || '')),
          attributes: (Array.isArray(ev.attributes) ? ev.attributes : []).map((at: any) => ({
            key: decodeAttr(String(at.key || '')),
            value: decodeAttr(String(at.value || '')),
          })),
        }));
        // Message @types: decoded message.action events first, raw_log fallback.
        const msgTypes: string[] = [];
        for (const ev of events) {
          if (ev.type === 'message') {
            for (const at of ev.attributes) {
              if (at.key === 'action' && at.value.startsWith('/')) msgTypes.push(at.value);
            }
          }
        }
        if (!msgTypes.length && typeof tr.log === 'string' && tr.log.startsWith('[')) {
          try {
            for (const l of JSON.parse(tr.log)) {
              for (const ev of l?.events || []) {
                if (ev?.type !== 'message') continue;
                for (const at of ev.attributes || []) {
                  const k = decodeAttr(String(at.key || ''));
                  const v = decodeAttr(String(at.value || ''));
                  if (k === 'action' && v.startsWith('/')) msgTypes.push(v);
                }
              }
            }
          } catch {
            /* malformed log — messages stay empty */
          }
        }
        return {
          height: String(item.height || '0'),
          txhash: item.hash,
          codespace: tr.codespace || '',
          code: Number(tr.code || 0),
          data: tr.data || '',
          raw_log: typeof tr.log === 'string' ? tr.log : '',
          logs: [] as any,
          info: '',
          gas_wanted: String(tr.gas_wanted || '0'),
          gas_used: String(tr.gas_used || '0'),
          tx: { body: { messages: msgTypes.map((t) => ({ '@type': t })) } } as any,
          timestamp: '',
          events,
        } as unknown as TxResponse;
      });

      // Timestamps: batch block-header fetch per unique height (capped).
      if (workingRpc) {
        const heights = [...new Set(rows.map((r) => r.height))].slice(0, 40);
        const times = new Map<string, string>();
        await Promise.all(
          heights.map(async (h) => {
            const data = await fetchJson(`${workingRpc}/block?height=${h}`, 6000);
            const t = data?.result?.block?.header?.time;
            if (t) times.set(h, t);
          })
        );
        for (const r of rows) (r as any).timestamp = times.get(r.height) || '';
      }

      const sorted = rows.sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
      return { rows: sorted, total: total > 0 ? total : sorted.length };
    },

    /**
     * Server-side paginated account history via RPC tx_search.
     *
     * Unlike the LCD union (which caps at ~500 because LCDs ignore offset),
     * tx_search HONOURS page/per_page, so this can reach the full chain-wide
     * history (e.g. Terra relayer: all 2,948 tx, one page downloaded per turn).
     *
     * sender + receiver are separate event streams (CometBFT rejects OR across
     * event types with HTTP 500), so we fetch the requested page of EACH from
     * the richest index and merge. For relayer/delegation wallets sender
     * dominates (receiver ≈ 0-2), so the merged page is effectively the sender
     * page; only perfectly-balanced addresses see minor page-boundary overlap.
     *
     * Returns null when no RPC exposes a tx index for this address — the caller
     * then falls back to the LCD union buffer.
     */
    async fetchAccountTxsPage(
      address: string,
      page: number,
      pageSize: number
    ): Promise<{ rows: TxResponse[]; total: number } | null> {
      // Probe up to 8 RPCs — AtomOne-class chains list 6 public mirrors and the
      // richest tx index is often NOT in the first 4 (slice(0,4) silently dropped
      // ITRocket's complete index, leaving only a flapping publicnode backend).
      const rpcs = (this.current?.endpoints?.rpc || []).slice(0, 8);
      if (!rpcs.length) return null;

      const decodeAttr = (s: string): string => {
        if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 === 1) return s;
        try {
          const d = atob(s);
          return /^[\x20-\x7e]+$/.test(d) ? d : s;
        } catch {
          return s;
        }
      };
      const fetchJson = async (url: string, timeoutMs = 8000): Promise<any> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      };
      const queries = [
        `message.sender='${address}'`,
        `coin_received.receiver='${address}'`,
      ];
      const fetchPage = async (base: string, q: string, pg: number, perPage: number) => {
        const url = `${base}/tx_search?query=${encodeURIComponent(`"${q}"`)}&per_page=${perPage}&page=${pg}&order_by=${encodeURIComponent('"desc"')}`;
        return await fetchJson(url);
      };

      // Pick the richest index (max sender+receiver total_count). Cached per
      // chain+address so page turns don't re-probe; re-probes if the cached
      // host stops answering. Probe is cheap (per_page=1, totals only).
      const cacheKey = `${this.chainName}:${address}`;
      type Probe = { base: string; total: number; ok: boolean };
      const probeAll = async (): Promise<Probe[]> =>
        Promise.all(
          rpcs.map(async (rpc): Promise<Probe> => {
            const base = (rpc.address || '').replace(/\/$/, '');
            if (!base) return { base: '', total: 0, ok: false };
            let total = 0;
            let ok = false;
            await Promise.all(
              queries.map(async (q) => {
                const data = await fetchPage(base, q, 1, 1);
                const txs = data?.result?.txs;
                if (!Array.isArray(txs)) return;
                ok = true;
                const tc = Number(data?.result?.total_count ?? 0);
                if (Number.isFinite(tc)) total += tc;
              })
            );
            return { base, total, ok };
          })
        );

      // Rank candidate indexes by probe total (desc).
      const rankProbes = (ps: Probe[]) =>
        ps.filter((p) => p.ok && p.total > 0).sort((a, b) => b.total - a.total);

      // Fetch the requested page of BOTH streams from one index, merged + deduped.
      const fetchMerge = async (base: string) => {
        const acc = new Map<string, any>();
        let tot = 0;
        await Promise.all(
          queries.map(async (q) => {
            const data = await fetchPage(base, q, page, pageSize);
            const txs = data?.result?.txs;
            if (!Array.isArray(txs)) return;
            const tc = Number(data?.result?.total_count ?? 0);
            if (Number.isFinite(tc)) tot += tc;
            for (const t of txs) if (t?.hash) acc.set(t.hash, t);
          })
        );
        return { found: acc, tot };
      };

      // Serve the page from the best candidate that isn't flapping. Load-balanced
      // public RPCs (AtomOne publicnode) answer the probe healthy (17,998) then
      // return a degraded partial page (30) when the request lands on a stale
      // backend. Detect a >3× collapse (or an empty page) and fall through to the
      // next candidate. The last candidate is always accepted so we never hide
      // data that exists.
      const serveFrom = async (ranked: Probe[]) => {
        for (let i = 0; i < ranked.length; i++) {
          const cand = ranked[i];
          const m = await fetchMerge(cand.base);
          const collapsed = m.tot > 0 && m.tot * 3 < cand.total;
          const empty = m.found.size === 0 && m.tot === 0;
          if (i < ranked.length - 1 && (collapsed || empty)) continue;
          return { cand, found: m.found, total: m.tot };
        }
        return undefined;
      };

      // Cached winner leads (page turns skip the probe); otherwise probe every
      // live index and rank.
      let ranked: Probe[] = (() => {
        const c = pageRpcCache.get(cacheKey);
        return c ? [{ base: c.base, total: c.total, ok: true }] : [];
      })();
      if (!ranked.length) ranked = rankProbes(await probeAll());
      if (!ranked.length) return null; // no index → LCD fallback

      let served = await serveFrom(ranked);
      // Cached winner flapped/dead and was the only candidate → full re-probe
      // (ranking every other live index) and retry once.
      if (served && ranked.length === 1 && pageRpcCache.has(cacheKey)) {
        const bad =
          (served.total > 0 && served.total * 3 < served.cand.total) ||
          (served.found.size === 0 && served.total === 0);
        if (bad) {
          pageRpcCache.delete(cacheKey);
          ranked = rankProbes(await probeAll()).filter((p) => p.base !== served!.cand.base);
          if (ranked.length) served = (await serveFrom(ranked)) || served;
        }
      }
      if (!served) return null;

      const best: Probe = served.cand;
      pageRpcCache.set(cacheKey, { base: best.base, total: best.total });
      const found = served.found;
      const total = served.total;

      const items = Array.from(found.values());
      if (!items.length) return { rows: [], total: total || best.total };

      const rows: TxResponse[] = items.map((item) => {
        const tr = item.tx_result || {};
        const events = (Array.isArray(tr.events) ? tr.events : []).map((ev: any) => ({
          type: decodeAttr(String(ev.type || '')),
          attributes: (Array.isArray(ev.attributes) ? ev.attributes : []).map((at: any) => ({
            key: decodeAttr(String(at.key || '')),
            value: decodeAttr(String(at.value || '')),
          })),
        }));
        const msgTypes: string[] = [];
        for (const ev of events) {
          if (ev.type === 'message') {
            for (const at of ev.attributes) {
              if (at.key === 'action' && at.value.startsWith('/')) msgTypes.push(at.value);
            }
          }
        }
        return {
          height: String(item.height || '0'),
          txhash: item.hash,
          codespace: tr.codespace || '',
          code: Number(tr.code || 0),
          data: tr.data || '',
          raw_log: typeof tr.log === 'string' ? tr.log : '',
          logs: [] as any,
          info: '',
          gas_wanted: String(tr.gas_wanted || '0'),
          gas_used: String(tr.gas_used || '0'),
          tx: { body: { messages: msgTypes.map((t) => ({ '@type': t })) } } as any,
          timestamp: '',
          events,
        } as unknown as TxResponse;
      });

      // Sort + page FIRST, then fetch timestamps only for the rows actually
      // displayed. (Previously timestamps were fetched for the first 40 unique
      // heights in Map-insertion order — effectively arbitrary hash order —
      // before sorting, so displayed rows could miss their timestamp while we
      // wasted block fetches on rows that got sliced away.)
      const sorted = rows
        .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
        .slice(0, pageSize);

      // Timestamps: batch block-header fetch per unique displayed height.
      const heights = [...new Set(sorted.map((r) => r.height))];
      const times = new Map<string, string>();
      await Promise.all(
        heights.map(async (h) => {
          const data = await fetchJson(`${best!.base}/block?height=${h}`, 6000);
          const t = data?.result?.block?.header?.time;
          if (t) times.set(h, t);
        })
      );
      for (const r of sorted) (r as any).timestamp = times.get(r.height) || '';

      return { rows: sorted, total: total > 0 ? total : best.total };
    },

    // Lightweight liveness probe for a REST/LCD endpoint.
    async healthCheck(address: string, timeoutMs = 6000): Promise<boolean> {
      // Gnoland / TM2 has no Cosmos LCD — probe `/status` on the JSON-RPC host.
      if (isGnoChain(this.current)) {
        const ok = await tm2Health(address, timeoutMs);
        if (ok) markGood(this.chainName, address);
        else markBad(this.chainName, address, 'tm2-unreachable');
        return ok;
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const url = `${address.replace(/\/$/, '')}/cosmos/base/tendermint/v1beta1/blocks/latest`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) { markBad(this.chainName, address, `http-${res.status}`); return false; }
        const data = await res.json();
        const ok = !!(data && data.block && data.block.header && data.block.header.height);
        if (ok) markGood(this.chainName, address);
        else markBad(this.chainName, address, 'bad-payload');
        return ok;
      } catch (e) {
        // CORS errors land here (TypeError: Failed to fetch)
        markBad(this.chainName, address, 'cors-or-timeout');
        return false;
      }
    },

    engineTag(): string | undefined {
      return this.current?.engine;
    },

    /**
     * Rank all live REST/api[] peers by tip height (+ valset on Gno).
     * Shared quality gate for startup, fallback, and consensus-style picks.
     */
    async rankRestEndpoints(timeoutMs = 4500): Promise<RpcQuality[]> {
      const all = this.restEndpoints();
      if (!all.length) return [];
      const ranked = await rankRpcs(all, {
        engine: this.engineTag(),
        timeoutMs,
      });
      // Mirror deny/good for sticky randomEndpoint compatibility
      for (const r of ranked) {
        if (r.ok) markGood(this.chainName, r.address);
        else markBad(this.chainName, r.address, r.reason || 'rank-fail');
      }
      return ranked;
    },

    /**
     * Probe-first endpoint setup (option A).
     * Never wire a dead/lagging preferred host before quality ranking — that
     * was the blank-page + sticky-Shazoes failure mode (set then async heal).
     */
    async randomSetupEndpoint() {
      const all = this.restEndpoints();
      if (!all.length) {
        this.connPhase = 'degraded';
        this.connErr = "We can't reach the network right now. Please try again in a moment.";
        return;
      }

      // Epoch guard: if the user switches chain mid-probe, stale results
      // from the previous chain must NOT mutate connPhase/endpoint.
      const myEpoch = ++this._setupEpoch;
      this.connPhase = 'reconnecting';
      const probeChain = this.chainName;
      try {
        const ranked = await this.rankRestEndpoints(4500);
        // Stale probe guard: user may have switched chain while we waited
        if (myEpoch !== this._setupEpoch || probeChain !== this.chainName) return;
        const tip = pickTipPeers(ranked);

        // Honor localStorage only if that peer is still a tip-quality host
        const chainName = this.chainName;
        let saved: Endpoint | undefined;
        try {
          const raw = localStorage.getItem(`endpoint-${chainName}`);
          if (raw) saved = JSON.parse(raw) as Endpoint;
        } catch {
          /* ignore */
        }
        const savedAddr = (saved?.address || '').replace(/\/+$/, '');
        const savedTip = tip.find((t) => t.address.replace(/\/+$/, '') === savedAddr);

        // Among tip peers: prefer config order (Shazoes first when healthy at tip)
        const configOrder = all.map((e) => e.address.replace(/\/+$/, ''));
        const tipByConfig = [...tip].sort((a, b) => {
          const ia = configOrder.indexOf(a.address.replace(/\/+$/, ''));
          const ib = configOrder.indexOf(b.address.replace(/\/+$/, ''));
          const sa = ia === -1 ? 999 : ia;
          const sb = ib === -1 ? 999 : ib;
          return sa - sb || b.valCount - a.valCount || b.height - a.height;
        });

        const bestQ = savedTip || tipByConfig[0] || ranked.find((r) => r.ok);
        if (bestQ) {
          const ep = qualityToEndpoint(bestQ);
          const prev = (this.endpoint?.address || '').replace(/\/+$/, '');
          await this.setRestEndpoint(ep);
          this.connPhase = 'ok';
          this.connErr = '';
          this.fallbackAttempts = 0;
          console.info(
            `[explorer] RPC probe-first: ${ep.address} h=${bestQ.height}` +
              (bestQ.valCount ? ` vals=${bestQ.valCount}` : '') +
              (bestQ.provider ? ` (${bestQ.provider})` : '')
          );
          // If we already had a different dead endpoint wired, refresh stores
          if (prev && prev !== ep.address.replace(/\/+$/, '')) {
            this.initial();
          }
          return;
        }

        // Nobody ranked ok — last resort: weighted config pick + async heal (legacy)
        const endpoint = this.randomEndpoint(this.chainName);
        if (endpoint) {
          await this.setRestEndpoint(endpoint);
          this.connPhase = 'degraded';
          this.connErr =
            "We're having trouble reaching the network. Tap Try again — we'll reconnect automatically.";
          this.fallbackEndpoint({ reason: 'startup-unhealthy' });
        } else {
          this.connPhase = 'degraded';
          this.connErr = "We can't reach the network right now. Please try again in a moment.";
        }
      } catch (e: any) {
        if (myEpoch !== this._setupEpoch || probeChain !== this.chainName) return;
        console.warn('[explorer] randomSetupEndpoint rank failed', e?.message || e);
        // Degrade gracefully to legacy path
        const endpoint = this.randomEndpoint(this.chainName);
        if (endpoint) {
          await this.setRestEndpoint(endpoint);
          this.healthCheck(endpoint.address, 6000).then((ok) => {
            if (!ok) this.fallbackEndpoint({ reason: 'startup-unhealthy' });
            else this.connPhase = 'ok';
          });
        } else {
          this.connPhase = 'degraded';
        }
      }
    },

    /**
     * Force a reconnect sweep — the ONLY user-facing recovery action.
     * No endpoint picker: we probe the pool and switch silently.
     */
    async reconnectNow() {
      this.lastFallbackAt = 0; // bypass cooldown
      this.fallbackInProgress = false;
      this.connPhase = 'reconnecting';
      this.connErr = '';
      await this.fallbackEndpoint({ reason: 'user-retry', force: true });
    },

    /**
     * Auto-switch to the best tip-quality endpoint when current is down/lagging.
     * Ranks all peers (height + sync) — does NOT pick "first config-order OK".
     */
    async fallbackEndpoint(opts: { reason?: string; force?: boolean } = {}) {
      const all = this.restEndpoints();
      if (!all.length) {
        this.connPhase = 'degraded';
        this.connErr = "We can't reach the network right now. Please try again in a moment.";
        return;
      }
      const now = Date.now();
      // Guard against concurrent / rapid-fire fallback loops (unless force).
      if (!opts.force) {
        if (this.fallbackInProgress) return;
        // Soft cooldown — shorter when already disconnected so recovery is snappy
        const cool = this.connPhase === 'degraded' ? 5000 : 12000;
        if (now - this.lastFallbackAt < cool) return;
      } else if (this.fallbackInProgress) {
        // force while in-flight: skip duplicate
        return;
      }
      this.fallbackInProgress = true;
      this.lastFallbackAt = now;
      this.connPhase = 'reconnecting';
      this.fallbackAttempts += 1;
      try {
        const current = (this.endpoint?.address || '').replace(/\/+$/, '');

        if (all.length === 1) {
          const only = all[0];
          const ok = await this.healthCheck(only.address, 5000);
          if (ok) {
            this.connErr = '';
            this.connPhase = 'ok';
            if (only.address.replace(/\/+$/, '') !== current) {
              await this.setRestEndpoint(only);
              this.initial();
            }
          } else {
            this.connPhase = 'degraded';
            this.connErr =
              "We're having trouble reaching the network. Tap Try again — we'll reconnect automatically.";
          }
          return;
        }

        const ranked = await this.rankRestEndpoints(5000);
        const tip = pickTipPeers(ranked);
        // Prefer a tip peer that isn't the failing current (unless current is still tip-best)
        let best =
          tip.find((t) => t.address.replace(/\/+$/, '') !== current) || tip[0] || ranked.find((r) => r.ok);

        if (best) {
          const ep = qualityToEndpoint(best);
          const switched = ep.address.replace(/\/+$/, '') !== current;
          console.info(
            `[explorer] RPC auto-fallback (${opts.reason || 'auto'}): ${current || '∅'} -> ${ep.address}` +
              ` h=${best.height}` +
              (best.valCount ? ` vals=${best.valCount}` : '')
          );
          this.connErr = '';
          this.connPhase = 'ok';
          this.fallbackAttempts = 0;
          if (switched) {
            this.justRecovered = true;
            await this.setRestEndpoint(ep);
            this.initial();
            setTimeout(() => {
              if (this.justRecovered) this.justRecovered = false;
            }, 6000);
          }
          return;
        }

        this.connPhase = 'degraded';
        this.connErr =
          "We're having trouble reaching the network. We'll keep trying — or tap Try again.";
        console.warn(`[explorer] RPC auto-fallback exhausted (${opts.reason || 'auto'}); all peers unhealthy`);
        if (!opts.force) {
          setTimeout(() => {
            if (this.connPhase === 'degraded' && !this.fallbackInProgress) {
              this.fallbackEndpoint({ reason: 'auto-retry' });
            }
          }, 8000);
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
        const liveUrl = (this.current as any)?.valopers_live_url as string | undefined;
        initGnoValopers(this.chainName, liveUrl).catch((e: any) => {
          console.warn('[gno-valopers] init failed:', e?.message || e);
        });
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
