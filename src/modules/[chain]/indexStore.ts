import {
  useBlockchain,
  useCoingecko,
  useBaseStore,
  useBankStore,
  useFormatter,
  useGovStore,
  useDistributionStore,
  useMintStore,
  useStakingStore,
} from '@/stores';
import type { Coin, Tally } from '@/types';
import numeral from 'numeral';
import { defineStore } from 'pinia';

export function colorMap(color: string) {
  switch (color) {
    case 'yellow':
      return 'warning';
    case 'green':
      return 'success';
    default:
      return 'secondary';
  }
}

const CODEMAP: Record<string, string[]> = {
  'binance.com': ['ref', 'CPA_004JZGRX6A'],
  'gate.com': ['ref', 'U1gVBl9a'],
  bybit: ['affiliate_id', 'JKRRZX9'],
};

export const useIndexModule = defineStore('module-index', {
  state: () => {
    return {
      days: 14,
      tickerIndex: 0,
      coinInfo: {
        name: '',
        symbol: '',
        description: {
          en: '',
        },
        categories: [] as string[],
        market_cap_rank: 0,
        links: {
          twitter_screen_name: '',
          homepage: [] as string[],
          repos_url: {
            github: [],
          },
          telegram_channel_identifier: '',
        },
        market_data: {
          price_change_percentage_24h: 0,
        },
        tickers: [] as {
          market: {
            name: string;
            identifier: string;
          };
          coin_id: string;
          target_coin_id: string;
          trust_score: string;
          trade_url: string;
          converted_last: {
            btc: number;
            eth: number;
            usd: number;
          };
          base: string;
          target: string;
        }[],
      },
      marketData: {
        market_caps: [],
        prices: [] as number[],
        total_volumes: [] as number[],
      },
      communityPool: [] as { amount: string; denom: string }[],
      tally: {} as Record<string, Tally>,
      githubActivity: {
        loading: false,
        error: '' as string,
        fullName: '' as string,
        htmlUrl: '' as string,
        description: '' as string,
        stars: 0,
        forks: 0,
        openIssues: 0,
        language: '' as string,
        pushedAt: '' as string,
        defaultBranch: '' as string,
        watchers: 0,
        sizeKb: 0,
        /** 52 weeks × 7 days (Sun→Sat), commit counts — nodes.guru style boxes */
        weeks: [] as { week: number; days: number[] }[],
        totalCommitsYear: 0,
        maxDayCommits: 0,
        commits: [] as {
          sha: string;
          message: string;
          author: string;
          date: string;
          htmlUrl: string;
        }[],
      },
    };
  },
  getters: {
    blockchain() {
      const chain = useBlockchain();
      return chain.current;
    },
    coingecko() {
      return useCoingecko();
    },
    bankStore() {
      return useBankStore();
    },
    twitter(): string {
      if (!this.coinInfo?.links?.twitter_screen_name) return '';
      return `https://twitter.com/${this.coinInfo?.links.twitter_screen_name}`;
    },
    homepage(): string {
      if (!this.coinInfo?.links?.homepage) return '';
      const [page1, page2, page3] = this.coinInfo?.links?.homepage;
      return page1 || page2 || page3;
    },
    github(): string {
      if (!this.coinInfo?.links?.repos_url) return '';
      const [page1, page2, page3] = this.coinInfo?.links?.repos_url?.github;
      return page1 || page2 || page3;
    },
    telegram(): string {
      if (!this.coinInfo?.links?.homepage) return '';
      return `https://t.me/${this.coinInfo?.links.telegram_channel_identifier}`;
    },

    priceChange(): string {
      if (!this.coinInfo?.market_data?.price_change_percentage_24h) return '';
      const change = this.coinInfo?.market_data?.price_change_percentage_24h || 0;
      return numeral(change).format('+0.[00]');
    },

    priceColor(): string {
      if (!this.coinInfo?.market_data?.price_change_percentage_24h) return '';
      const change = this.coinInfo?.market_data?.price_change_percentage_24h || 0;
      switch (true) {
        case change > 0:
          return 'text-success';
        case change < 0:
          return 'text-error';
        default:
          return '';
      }
    },
    trustColor(): string {
      if (!this.coinInfo?.tickers) return '';
      const change = this.coinInfo?.tickers[this.tickerIndex]?.trust_score;
      return change;
    },

    pool() {
      const staking = useStakingStore();
      return staking.pool;
    },

    proposals() {
      const gov = useGovStore();
      return gov.proposals['2'];
    },

    stats() {
      const base = useBaseStore();
      const bank = useBankStore();
      const staking = useStakingStore();
      const mintStore = useMintStore();
      const formatter = useFormatter();

      return [
        {
          title: 'Height',
          color: 'primary',
          icon: 'mdi-pound',
          stats: String(base?.latest?.block?.header?.height || 0),
          change: 0,
        },
        {
          title: 'Validators',
          color: 'error',
          icon: 'mdi-human-queue',
          stats: String(base?.latest?.block?.last_commit?.signatures.length || 0),
          change: 0,
        },
        {
          title: 'Supply',
          color: 'success',
          icon: 'mdi-currency-usd',
          stats: formatter.formatTokenAmount(bank.supply),
          change: 0,
        },
        {
          title: 'Bonded Tokens',
          color: 'warning',
          icon: 'mdi-lock',
          stats: formatter.formatTokenAmount({
            // @ts-ignore
            amount: this.pool.bonded_tokens,
            denom: staking.params.bond_denom,
          }),
          change: 0,
        },
        {
          title: 'Inflation',
          color: 'success',
          icon: 'mdi-chart-multiple',
          stats: formatter.formatDecimalToPercent(mintStore.inflation),
          change: 0,
        },
        {
          title: 'Community Pool',
          color: 'primary',
          icon: 'mdi-bank',
          stats: formatter.formatTokens(
            // @ts-ignore
            this.communityPool?.filter((x: Coin) => x.denom === staking.params.bond_denom)
          ),
          change: 0,
        },
      ];
    },

    coingeckoId() {
      this.tickerIndex = 0;
      // @ts-ignore
      const [firstAsset] = this.blockchain?.assets || [];
      return firstAsset.coingecko_id;
    },
  },
  actions: {
    async loadDashboard() {
      this.$reset();
      this.initCoingecko();
      // kick github early; coingecko may refine repo URL after coinInfo loads
      this.loadGithubActivity();
      useMintStore().fetchInflation();
      useDistributionStore()
        .fetchCommunityPool()
        .then((x) => {
          this.communityPool = x?.pool
            ?.filter((t) => t.denom.length < 10)
            ?.map((t) => ({
              amount: String(parseInt(t.amount)),
              denom: t.denom,
            }));
        })
        .catch((e: any) => console.warn('[dashboard] communityPool:', e?.message || e));
      // const gov = useGovStore();
      // gov.fetchProposals('2').then((x) => {
      //   this.proposals = x;
      // });
    },
    tickerColor(color: string) {
      return colorMap(color);
    },
    initCoingecko() {
      this.tickerIndex = 0;
      const [firstAsset] = this.blockchain?.assets || [];
      // Prefer asset coingecko_id; fall back to top-level chain.coingecko
      const cgId =
        firstAsset?.coingecko_id ||
        // @ts-ignore
        this.blockchain?.coingecko ||
        '';
      if (cgId) {
        // CoinGecko free tier is flaky (CORS / rate-limit / network). Never
        // let a rejection surface as an uncaught pageerror
        // (`TypeError: Network request failed` from cross-fetch).
        this.coingecko
          .getCoinInfo(cgId)
          .then((x) => {
            this.coinInfo = x;
            this.loadGithubActivity();
          })
          .catch((e: any) => {
            console.warn('[dashboard] coinInfo failed:', e?.message || e);
          });
        this.coingecko
          .getMarketChart(this.days, cgId)
          .then((x) => {
            this.marketData = x;
          })
          .catch((e: any) => {
            console.warn('[dashboard] marketChart failed:', e?.message || e);
          });
      }
    },

    parseGithubRepo(url: string): { owner: string; repo: string } | null {
      if (!url) return null;
      try {
        const cleaned = url.trim().replace(/\.git$/i, '').replace(/\/$/, '');
        const m = cleaned.match(/github\.com[/:]([^/\s]+)[/]([^/\s?#]+)/i);
        if (!m) return null;
        return { owner: m[1], repo: m[2] };
      } catch {
        return null;
      }
    },

    resolveGithubUrl(): string {
      // Prefer any candidate that parses to owner/repo.
      // CoinGecko often returns org-only URLs (e.g. https://github.com/cosmos)
      // which fail parseGithubRepo — those must NOT block chain-config repos.
      const chain: any = this.blockchain || {};
      const candidates = [
        this.github, // CoinGecko links.repos_url.github[0]
        chain?.github,
        chain?.codebase?.git_repo,
        chain?.git_repo,
        chain?.links?.github,
      ].filter(Boolean) as string[];

      for (const c of candidates) {
        if (this.parseGithubRepo(c)) return c;
      }
      // last resort: first raw candidate (may still fail parse → card hidden)
      return candidates[0] || '';
    },

    async loadGithubActivity() {
      const url = this.resolveGithubUrl();
      const parsed = this.parseGithubRepo(url);
      if (!parsed) {
        // keep empty card hidden when no repo known
        this.githubActivity.fullName = '';
        this.githubActivity.error = '';
        this.githubActivity.loading = false;
        this.githubActivity.commits = [];
        this.githubActivity.weeks = [];
        this.githubActivity.totalCommitsYear = 0;
        this.githubActivity.maxDayCommits = 0;
        return;
      }

      // v2 cache: includes contribution weeks heatmap
      const cacheKey = `sz-gh-activity-v2:${parsed.owner}/${parsed.repo}`;
      try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
          const data = JSON.parse(cached);
          if (data && data.fullName && Date.now() - (data._ts || 0) < 15 * 60 * 1000) {
            this.githubActivity = { ...data, loading: false, error: '' };
            return;
          }
        }
      } catch {
        /* ignore cache parse */
      }

      this.githubActivity.loading = true;
      this.githubActivity.error = '';
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
      };
      const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;

      try {
        const [repoRes, commitsRes, activityRes] = await Promise.all([
          fetch(base, { headers }),
          fetch(`${base}/commits?per_page=8`, { headers }),
          fetch(`${base}/stats/commit_activity`, { headers }),
        ]);

        if (!repoRes.ok) {
          throw new Error(`GitHub repo ${repoRes.status}`);
        }
        const repo = await repoRes.json();
        let commits: any[] = [];
        if (commitsRes.ok) {
          commits = await commitsRes.json();
        }

        // commit_activity may 202 while GitHub computes; treat as empty, not fatal
        let weeks: { week: number; days: number[] }[] = [];
        let totalCommitsYear = 0;
        let maxDayCommits = 0;
        if (activityRes.ok) {
          const raw = await activityRes.json();
          if (Array.isArray(raw)) {
            weeks = raw.map((w: any) => ({
              week: Number(w.week) || 0,
              days: Array.isArray(w.days)
                ? w.days.map((d: any) => Number(d) || 0)
                : [0, 0, 0, 0, 0, 0, 0],
            }));
            for (const w of weeks) {
              totalCommitsYear += w.days.reduce((a, b) => a + b, 0);
              for (const d of w.days) {
                if (d > maxDayCommits) maxDayCommits = d;
              }
            }
          }
        }

        const next = {
          loading: false,
          error: '',
          fullName: repo.full_name || `${parsed.owner}/${parsed.repo}`,
          htmlUrl: repo.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
          description: repo.description || '',
          stars: repo.stargazers_count || 0,
          forks: repo.forks_count || 0,
          openIssues: repo.open_issues_count || 0,
          language: repo.language || '',
          pushedAt: repo.pushed_at || '',
          defaultBranch: repo.default_branch || 'main',
          watchers: repo.subscribers_count || repo.watchers_count || 0,
          sizeKb: repo.size || 0,
          weeks,
          totalCommitsYear,
          maxDayCommits,
          commits: (Array.isArray(commits) ? commits : []).slice(0, 8).map((c: any) => ({
            sha: (c.sha || '').slice(0, 7),
            message: String(c.commit?.message || '').split('\n')[0].slice(0, 120),
            author: c.commit?.author?.name || c.author?.login || 'unknown',
            date: c.commit?.author?.date || '',
            htmlUrl: c.html_url || '',
          })),
        };
        this.githubActivity = next as any;
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ...next, _ts: Date.now() }));
        } catch {
          /* quota */
        }
      } catch (e: any) {
        this.githubActivity.loading = false;
        this.githubActivity.error = e?.message || 'GitHub unavailable';
        // still show link if we have a name
        if (!this.githubActivity.fullName) {
          this.githubActivity.fullName = `${parsed.owner}/${parsed.repo}`;
          this.githubActivity.htmlUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
        }
      }
    },
    selectTicker(i: number) {
      this.tickerIndex = i;
    },
  },
});

/**
 * Adds or replaces a query parameter in the provided URL.
 * @param url - The base URL.
 * @param param - The name of the parameter to add or replace.
 * @param value - The value to set for the parameter.
 * @returns The new URL with the parameter added or replaced.
 */
export function addOrReplaceUrlParam(url: string, param: string, value: string): string {
  // Parse the URL
  const urlObj = new URL(url, window.location.origin);

  // Set (add or replace) the query parameter
  urlObj.searchParams.set(param, value);

  // Return the string representation of the new URL
  return urlObj.toString();
}

export function tickerUrl(url: string) {
  for (const domain of Object.keys(CODEMAP)) {
    if (url.indexOf(domain) > -1) {
      const v = CODEMAP[domain];
      return addOrReplaceUrlParam(url, v[0], v[1]);
    }
  }
  return url;
}
