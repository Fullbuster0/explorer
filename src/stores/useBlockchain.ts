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
            keys: ['dashboard', 'blocks', 'tx', 'validator', 'uptime', 'account'],
          },
          {
            heading: 'Staking & Governance',
            keys: ['staking', 'governance'],
          },
          {
            heading: 'Advanced',
            keys: ['ibc', 'cosmwasm', 'parameters', 'consensus', 'nft'],
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

    async randomSetupEndpoint() {
      const endpoint = this.randomEndpoint(this.chainName);
      if (endpoint) await this.setRestEndpoint(endpoint);
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
