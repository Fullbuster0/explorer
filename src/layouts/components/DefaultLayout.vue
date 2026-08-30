<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

// Components
import newFooter from '@/layouts/components/NavFooter.vue';
import NavbarThemeSwitcher from '@/layouts/components/NavbarThemeSwitcher.vue';
import NavbarSearch from '@/layouts/components/NavbarSearch.vue';
import ChainProfile from '@/layouts/components/ChainProfile.vue';

import { useDashboard } from '@/stores/useDashboard';
import { NetworkType } from '@/types/chaindata';
import { useBaseStore, useBlockchain } from '@/stores';

import NavBarWallet from './NavBarWallet.vue';
import type {
  NavGroup,
  NavLink,
  NavSectionTitle,
  VerticalNavItems,
} from '../types';
import dayjs from 'dayjs';

const dashboard = useDashboard();
const blockchain = useBlockchain();
// Dashboard config loading is async. Do not probe before it has populated the
// current chain: that produced a permanent degraded state (empty endpoint
// list) on cold loads and rapid route changes.
let setupPromise: Promise<void> | undefined;
async function setupCurrentChain() {
  setupPromise ||= dashboard.initial().then(async () => {
    // Unknown/unconfigured chain slug has no endpoints at all. Probing it only
    // produces a false "can't reach the network" degraded state — the shell
    // renders a "Chain not found" panel instead, so skip the probe entirely.
    if (blockchain.chainName && blockchain.current) await blockchain.randomSetupEndpoint();
  });
  await setupPromise;
}
setupCurrentChain().catch((e) => console.warn('[explorer] chain setup failed:', e));
const baseStore = useBaseStore();
const route = useRoute();

/** Gno has no staking/delegation — hide Wallet Helper (Keplr suggest) too. */
const isGno = computed(
  () => blockchain.current?.engine === 'gno' || blockchain.current?.engine === 'tm2'
);
const gnoUptimeObservedHeight = ref(0);
function onGnoUptimeSnapshot(event: Event) {
  const height = Number((event as CustomEvent<{ observedHeight?: number }>).detail?.observedHeight || 0);
  gnoUptimeObservedHeight.value = Number.isFinite(height) && height > 0 ? height : 0;
}
onMounted(() => window.addEventListener('gno-uptime-snapshot', onGnoUptimeSnapshot));
onUnmounted(() => window.removeEventListener('gno-uptime-snapshot', onGnoUptimeSnapshot));
watch(
  () => route.path,
  (path) => {
    // Do not carry a previous uptime snapshot height into a later visit.
    // The page will publish its fresh snapshot height after it loads.
    if (!path.endsWith('/uptime')) gnoUptimeObservedHeight.value = 0;
  },
  { immediate: true },
);
const headerHeight = computed(() => {
  const useCollectorHeight = isGno.value && route.path.endsWith('/uptime') && gnoUptimeObservedHeight.value > 0;
  return useCollectorHeight ? gnoUptimeObservedHeight.value : Number(baseStore.latest?.block?.header?.height || 0);
});

const current = ref(''); // the current chain
const temp = ref('');
blockchain.$subscribe((m, s) => {
  if (!s.chainName) return;
  if (current.value === s.chainName && temp.value != s.endpoint.address) {
    temp.value = s.endpoint.address;
    // endpoint switch — wipe stale height then re-init
    baseStore.resetBlockState();
    blockchain.initial();
  }
  if (current.value != s.chainName) {
    current.value = s.chainName;
    temp.value = ''; // clear stale endpoint so we don't trigger the endpoint-switch branch
    // chain switch — clear previous chain state so navbar doesn't lag
    baseStore.resetBlockState();
    // Reset connection phase immediately so user doesn't see "Reconnecting"
    // from the previous chain lingering while the new probe runs.
    blockchain.connPhase = 'ok';
    blockchain.connErr = '';
    setupPromise = undefined;
    setupCurrentChain().catch((e) => console.warn('[explorer] chain switch setup failed:', e));
  }
});

const sidebarShow = ref(false);

// Lock body scroll while the mobile drawer is open. Done in JS (not CSS
// :has) because scoped styles can't target <html>.
watch(sidebarShow, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
});
onUnmounted(() => {
  document.body.style.overflow = '';
});

// Pause aurora CSS animations while the user is scrolling — biggest paint thrash source.
const auroraPaused = ref(false);
let auroraResumeTimer: ReturnType<typeof setTimeout> | null = null;
function onWindowScroll() {
  if (!auroraPaused.value) auroraPaused.value = true;
  if (auroraResumeTimer) clearTimeout(auroraResumeTimer);
  auroraResumeTimer = setTimeout(() => {
    auroraPaused.value = false;
    auroraResumeTimer = null;
  }, 180);
}
onMounted(() => {
  window.addEventListener('scroll', onWindowScroll, { passive: true });
});
onUnmounted(() => {
  window.removeEventListener('scroll', onWindowScroll);
  if (auroraResumeTimer) clearTimeout(auroraResumeTimer);
});

function isNavGroup(nav: VerticalNavItems | any): nav is NavGroup {
  return (<NavGroup>nav).children !== undefined;
}
function isNavLink(nav: VerticalNavItems | any): nav is NavLink {
  return (<NavLink>nav).to !== undefined;
}
function isNavTitle(nav: VerticalNavItems | any): nav is NavSectionTitle {
  return (<NavSectionTitle>nav).heading !== undefined;
}
function selected(route: any, nav: NavLink) {
  const b =
    route.path === nav.to?.path || (route.path.startsWith(nav.to?.path) && nav.title.indexOf('dashboard') === -1);
  return b;
}
const blocktime = computed(() => {
  return dayjs(baseStore.latest?.block?.header?.time);
});

const behind = computed(() => {
  const current = dayjs().subtract(10, 'minute');
  return blocktime.value.isBefore(current);
});

/**
 * Unknown chain slug guard.
 *
 * A URL like `/xxx-mainnet/gov` resolves the route (`[chain]` matches anything)
 * but `blockchain.current` stays undefined, so `restEndpoints()` is empty and
 * `randomSetupEndpoint()` parks the shell in `degraded` forever. The user got
 * "Trouble connecting / We can't reach the network right now" plus an empty
 * module page — both wrong: the network is fine, the chain simply is not
 * configured here. Only trust this once the async dashboard config has landed
 * (`dashboard.length > 0`), otherwise cold loads would flash a false negative.
 */
const unknownChain = computed(
  () => dashboard.length > 0 && !!route.params.chain && !blockchain.current
);

/** Status chip: never ask users to pick an RPC. Auto-heal is the product. */
const statusLabel = computed(() => {
  if (unknownChain.value) return 'Chain not found';
  if (blockchain.connPhase === 'reconnecting' || blockchain.fallbackInProgress) return 'Reconnecting';
  if (blockchain.connPhase === 'degraded') return 'Trouble connecting';
  if (baseStore.connected) return 'Connected';
  if (baseStore.hasConnectedOnce) return 'Disconnected';
  return 'Connecting';
});
const statusChipClass = computed(() => {
  if (blockchain.connPhase === 'reconnecting' || blockchain.fallbackInProgress) return 'sz-chip--warn';
  if (blockchain.connPhase === 'degraded') return 'sz-chip--bad';
  if (baseStore.connected) return 'sz-chip--ok';
  if (baseStore.hasConnectedOnce) return 'sz-chip--bad';
  return 'sz-chip--warn';
});
const statusDotClass = computed(() => {
  if (blockchain.connPhase === 'reconnecting' || blockchain.fallbackInProgress) return '!bg-amber-400';
  if (blockchain.connPhase === 'degraded') return '!bg-red-500';
  if (baseStore.connected) return '';
  if (baseStore.hasConnectedOnce) return '!bg-red-500';
  return '!bg-amber-400';
});
const showConnBanner = computed(
  () =>
    !unknownChain.value &&
    (blockchain.connPhase === 'reconnecting' ||
      blockchain.connPhase === 'degraded' ||
      blockchain.justRecovered)
);
function onTryAgain() {
  blockchain.reconnectNow();
}

dayjs();
</script>

<template>
  <div class="sz-page-shell min-h-screen text-base-content">
    <!-- Shazoes aurora field — full motion (orbs + sparks + rings + beams); pause on scroll -->
    <div class="sz-aurora" :class="{ 'sz-aurora--paused': auroraPaused }" aria-hidden="true">
      <span class="sz-orb sz-orb-a"></span>
      <span class="sz-orb sz-orb-b"></span>
      <span class="sz-orb sz-orb-c"></span>
      <span class="sz-orb sz-orb-d"></span>
      <span class="sz-orb sz-orb-e"></span>
      <span class="sz-orb sz-orb-f"></span>
      <span class="sz-orb sz-orb-g"></span>
      <span class="sz-orb sz-orb-h"></span>
      <span class="sz-spark sz-spark-1"></span>
      <span class="sz-spark sz-spark-2"></span>
      <span class="sz-spark sz-spark-3"></span>
      <span class="sz-spark sz-spark-4"></span>
      <span class="sz-spark sz-spark-5"></span>
      <span class="sz-spark sz-spark-6"></span>
      <span class="sz-ring sz-ring-1"></span>
      <span class="sz-ring sz-ring-2"></span>
      <span class="sz-ring sz-ring-3"></span>
      <span class="sz-ring sz-ring-4"></span>
      <span class="sz-beam sz-beam-1"></span>
      <span class="sz-beam sz-beam-2"></span>
    </div>
    <!-- Mobile sidebar backdrop — tap outside to close. xl+ sidebar is always
         visible so backdrop is xl:hidden. z-40 sits under sidebar (z-50). -->
    <div
      v-if="sidebarShow"
      class="sz-sidebar-backdrop fixed inset-0 z-40 xl:!hidden"
      aria-hidden="true"
      @click="sidebarShow = false"
    ></div>
    <!-- ===== SIDEBAR ===== -->
    <aside
      class="sz-sidebar fixed left-0 top-0 bottom-0 z-50 w-64 overflow-y-auto"
      :class="{ block: sidebarShow, 'hidden xl:!block': !sidebarShow }"
    >
      <!-- brand lockup -->
      <RouterLink to="/" class="flex items-center gap-3 px-5 pt-6 pb-5">
        <span class="sz-logo-mark">
          <img class="h-8 w-8 object-contain" src="../../assets/logo.svg" alt="Shazoes" />
        </span>
        <span class="flex flex-col leading-none">
          <span class="sz-brand-name">Shazoes</span>
          <span class="sz-brand-sub">Explorer</span>
        </span>
        <button
          class="ml-auto text-slate-400 hover:text-slate-100 xl:!hidden"
          @click.prevent="sidebarShow = false"
        >
          <Icon icon="mdi-close" class="text-xl" />
        </button>
      </RouterLink>

      <!-- nav -->
      <nav class="px-3 pb-6">
        <template v-for="(item, index) of blockchain.computedChainMenu" :key="index">
          <!-- section heading -->
          <div v-if="isNavTitle(item)" class="sz-section-title">{{ item?.heading }}</div>

          <!-- collapsible group (generic) -->
          <div v-else-if="isNavGroup(item)" :tabindex="index" class="collapse collapse-arrow">
            <input type="checkbox" class="cursor-pointer !h-10 block" />
            <div class="collapse-title !py-0 px-3 flex items-center cursor-pointer rounded-lg hover:bg-white/5">
              <Icon v-if="item?.icon?.icon" :icon="item?.icon?.icon" class="text-lg mr-2.5 sz-nav-icon" />
              <span class="text-[13.5px] font-semibold capitalize flex-1 text-slate-200 whitespace-nowrap">
                {{ item?.title }}
              </span>
              <span
                v-if="item?.badgeContent"
                class="mr-6 badge badge-sm border-none text-white"
                :class="item?.badgeClass"
              >
                {{ item?.badgeContent }}
              </span>
            </div>
            <div class="collapse-content">
              <RouterLink
                v-for="(el, k) of item?.children"
                :key="k"
                :to="(el as any).to"
                @click="sidebarShow = false"
                class="sz-nav-item group"
                :class="{ 'sz-nav-item--active': selected($route, el) }"
              >
                <span class="sz-nav-rail" aria-hidden="true"></span>
                <img
                  v-if="el?.icon?.image"
                  :src="el?.icon?.image"
                  class="w-6 h-6 rounded-full mr-2.5 ml-1"
                  :class="{ 'ring-1 ring-white/40': selected($route, el) }"
                />
                <span
                  class="text-[13.5px] capitalize"
                  :class="selected($route, el) ? 'font-semibold' : 'text-slate-400 group-hover:text-slate-200'"
                >
                  {{ el?.title }}
                </span>
              </RouterLink>
            </div>
          </div>

          <!-- direct link -->
          <RouterLink
            v-else-if="isNavLink(item)"
            :to="item?.to"
            @click="sidebarShow = false"
            class="sz-nav-item group"
            :class="{ 'sz-nav-item--active': selected($route, item) }"
          >
            <span class="sz-nav-rail" aria-hidden="true"></span>
            <Icon
              v-if="item?.icon?.icon"
              :icon="item?.icon?.icon"
              class="text-[18px] mr-2.5 ml-1 sz-nav-icon"
            />
            <img
              v-if="item?.icon?.image"
              :src="item?.icon?.image"
              class="w-6 h-6 rounded-full mr-2.5 ml-1 border border-white/20"
            />
            <span
              class="text-[13.5px] capitalize flex-1 whitespace-nowrap"
              :class="selected($route, item) ? 'font-semibold' : 'text-slate-300 group-hover:text-slate-100'"
            >
              {{ item?.i18n ? $t(item.title) : item?.title }}
            </span>
            <span
              v-if="item?.badgeContent"
              class="badge badge-sm border-none text-white"
              :class="item?.badgeClass"
            >
              {{ item?.badgeContent }}
            </span>
          </RouterLink>
        </template>

        <!-- tools + links -->
        <div class="sz-section-title">Tools</div>
        <RouterLink v-if="!isGno" to="/wallet/suggest" class="sz-nav-item group">
          <span class="sz-nav-rail" aria-hidden="true"></span>
          <Icon icon="mdi:frequently-asked-questions" class="text-[18px] mr-2.5 ml-1 sz-nav-icon" />
          <span class="text-[13.5px] capitalize text-slate-300 group-hover:text-slate-100">Wallet Helper</span>
        </RouterLink>
        <div class="sz-section-title">Connect</div>
        <a href="https://x.com/shazoes" target="_blank" rel="noopener noreferrer" class="sz-nav-item group">
          <span class="sz-nav-rail" aria-hidden="true"></span>
          <Icon icon="mdi:twitter" class="text-[18px] mr-2.5 ml-1 sz-nav-icon" />
          <span class="text-[13.5px] capitalize text-slate-300 group-hover:text-slate-100">X / Twitter</span>
        </a>
        <a href="https://t.me/shazoes" target="_blank" rel="noopener noreferrer" class="sz-nav-item group">
          <span class="sz-nav-rail" aria-hidden="true"></span>
          <Icon icon="mdi:telegram" class="text-[18px] mr-2.5 ml-1 sz-nav-icon" />
          <span class="text-[13.5px] capitalize text-slate-300 group-hover:text-slate-100">Telegram</span>
        </a>
        <a href="http://discordapp.com/users/906483432811561000" target="_blank" rel="noopener noreferrer" class="sz-nav-item group">
          <span class="sz-nav-rail" aria-hidden="true"></span>
          <Icon icon="mdi:discord" class="text-[18px] mr-2.5 ml-1 sz-nav-icon" />
          <span class="text-[13.5px] capitalize text-slate-300 group-hover:text-slate-100">Discord</span>
        </a>
        <a href="mailto:hello@shazoes.xyz" class="sz-nav-item group">
          <span class="sz-nav-rail" aria-hidden="true"></span>
          <Icon icon="mdi:email-outline" class="text-[18px] mr-2.5 ml-1 sz-nav-icon" />
          <span class="text-[13.5px] capitalize text-slate-300 group-hover:text-slate-100">Email</span>
        </a>
        <a href="https://services.shazoes.xyz" target="_blank" rel="noopener noreferrer" class="sz-nav-item group">
          <span class="sz-nav-rail" aria-hidden="true"></span>
          <Icon icon="mdi:server" class="text-[18px] mr-2.5 ml-1 sz-nav-icon" />
          <span class="text-[13.5px] capitalize text-slate-300 group-hover:text-slate-100">Services</span>
        </a>
      </nav>
    </aside>

    <!-- ===== MAIN ===== -->
    <div class="relative z-10 xl:!ml-64 flex min-h-screen flex-col px-4 sm:px-6 lg:px-8 pt-4">
      <!-- header -->
      <header class="sz-header sticky top-0 z-40 mb-4 flex items-center gap-3 rounded-xl px-4 py-2.5">
        <button class="text-2xl xl:!hidden" @click="sidebarShow = true" aria-label="Open menu">
          <Icon icon="mdi-menu" />
        </button>

        <ChainProfile :height-override="headerHeight" />

        <div class="flex-1 w-0"></div>

        <!-- search left of theme toggle (desktop expands) -->
        <NavbarSearch class="!inline-block" />
        <NavbarThemeSwitcher class="!inline-block" />
        <NavBarWallet />
      </header>

      <!-- network status strip -->
      <div class="sz-statusbar mb-5 flex flex-wrap items-center gap-2 rounded-xl px-4 py-2">
        <span class="sz-live-dot" :class="statusDotClass"></span>
        <span class="sz-chip" :class="statusChipClass">
          {{ statusLabel }}
        </span>
        <span v-if="blockchain.justRecovered" class="sz-chip sz-chip--ok">Back online</span>
        <span class="sz-chip sz-chip--info font-mono">{{ baseStore.currentChainId || '—' }}</span>
        <span class="sz-chip font-mono">#{{ headerHeight.toLocaleString() }}</span>
        <span class="sz-chip font-mono">
          {{ baseStore.blocktime ? (baseStore.blocktime / 1000).toFixed(1) + 's' : '—' }} / block
        </span>
        <span v-if="behind" class="sz-chip sz-chip--warn">Out of sync</span>
        <!-- Recovery is one tap — never an endpoint list for normal users -->
        <button
          v-if="!unknownChain && (blockchain.connPhase === 'degraded' || blockchain.connPhase === 'reconnecting')"
          type="button"
          class="sz-chip sz-chip--info ml-auto cursor-pointer hover:opacity-90"
          :disabled="blockchain.fallbackInProgress"
          @click="onTryAgain"
        >
          {{ blockchain.fallbackInProgress ? 'Working…' : 'Try again' }}
        </button>
      </div>

      <!-- Non-technical connection banner (no RPC / endpoint jargon) -->
      <div
        v-if="showConnBanner"
        class="mb-4 rounded-xl px-4 py-3 text-sm flex flex-wrap items-start gap-3"
        :class="
          blockchain.justRecovered
            ? 'bg-success/10 border border-success/30'
            : blockchain.connPhase === 'degraded'
              ? 'bg-error/10 border border-error/30'
              : 'bg-warning/10 border border-warning/30'
        "
      >
        <div class="flex-1 min-w-0">
          <div class="font-semibold">
            <template v-if="blockchain.justRecovered">Back online</template>
            <template v-else-if="blockchain.connPhase === 'reconnecting'">Reconnecting…</template>
            <template v-else>Connection trouble</template>
          </div>
          <div class="opacity-80 mt-0.5">
            <template v-if="blockchain.justRecovered">
              We restored the connection automatically. You don’t need to change any settings.
            </template>
            <template v-else-if="blockchain.connPhase === 'reconnecting'">
              We’re switching to a working connection in the background. No action needed.
            </template>
            <template v-else>
              {{ blockchain.connErr || "We're having trouble reaching the network. Tap Try again — we'll reconnect automatically." }}
            </template>
          </div>
        </div>
        <button
          v-if="!blockchain.justRecovered"
          type="button"
          class="btn btn-sm btn-primary shrink-0"
          :disabled="blockchain.fallbackInProgress"
          @click="onTryAgain"
        >
          {{ blockchain.fallbackInProgress ? 'Working…' : 'Try again' }}
        </button>
      </div>

      <!-- pages -->
      <main class="flex-1" style="min-height: calc(100vh - 210px)">
        <div v-if="behind" class="alert alert-error mb-4">
          <div class="flex gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current flex-shrink-0 w-6 h-6">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              ></path>
            </svg>
            <span>{{ $t('pages.out_of_sync') }} {{ blocktime.format() }} ({{ blocktime.fromNow() }})</span>
          </div>
        </div>
        <!--
          SPA page swap: avoid mode="out-in" without a named transition.
          Unnamed Transition + out-in can leave the leaving component stuck
          (opacity 0 / display:none) when CSS enter/leave classes are missing
          → user sees chrome+statusbar but blank main until hard refresh.
          Instant swap is correct for data pages; keep Transition only if named.
        -->
        <!--
          Unknown chain slug: render an explicit not-found panel instead of the
          module page. Before this, `[chain]` matched any slug so the module
          rendered with no data while the statusbar claimed a network problem.
        -->
        <div v-if="unknownChain" class="text-center my-16">
          <div class="text-5xl mb-4 opacity-40">◇</div>
          <div class="text-xl font-bold mb-2">Chain not found</div>
          <p class="opacity-70 max-w-md mx-auto">
            "{{ route.params.chain }}" is not one of the networks configured on this
            explorer. Pick a chain from the list below.
          </p>
          <div class="pt-8 flex justify-center gap-3">
            <RouterLink class="btn btn-primary" to="/">All blockchains</RouterLink>
          </div>
        </div>
        <RouterView v-else />
      </main>

      <newFooter />
    </div>
  </div>
</template>

<style scoped>
/* ---- sidebar: always-dark brand surface ---- */
.sz-sidebar {
  background:
    radial-gradient(600px 280px at 0% 0%, rgba(0, 95, 204, 0.18), transparent 55%),
    radial-gradient(500px 240px at 100% 100%, rgba(118, 75, 200, 0.12), transparent 50%),
    linear-gradient(180deg, #070b14 0%, #0a1020 55%, #0c1226 100%);
  border-right: 1px solid rgba(148, 163, 184, 0.1);
  /* no backdrop-filter — solid dark surface, zero scroll paint cost */
}
.sz-sidebar-backdrop {
  background: rgba(6, 10, 20, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.sz-logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 4px 14px -4px rgba(0, 95, 204, 0.45);
  overflow: hidden;
  padding: 4px;
}
.sz-brand-name {
  font-size: 19px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #f1f5f9;
}
.sz-brand-sub {
  margin-top: 3px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.32em;
  color: #64748b;
}
.sz-section-title {
  padding: 16px 12px 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.2em;
  color: #5b6b85;
}
.sz-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 10px;
  padding: 8px 10px;
  margin: 1px 0;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.sz-nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.sz-nav-icon {
  color: #64748b;
  transition: color 0.15s ease;
}
.sz-nav-item:hover .sz-nav-icon {
  color: #93c5fd;
}
.sz-nav-rail {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%) scaleY(0);
  width: 3px;
  height: 60%;
  border-radius: 999px;
  background: hsl(var(--p));
  transition: transform 0.18s ease;
}
.sz-nav-item--active {
  background: rgba(255, 255, 255, 0.07);
}
.sz-nav-item--active .sz-nav-rail {
  transform: translateY(-50%) scaleY(1);
}
.sz-nav-item--active .sz-nav-icon {
  color: #93c5fd;
}
.sz-nav-item--active span {
  color: #f8fafc !important;
}

/* ---- header ---- glass lite (opaque-ish; tiny blur only on desktop) */
.sz-header {
  background: color-mix(in srgb, hsl(var(--b1)) 92%, transparent);
  border: 1px solid var(--sz-border);
  box-shadow: 0 8px 24px -20px rgba(0, 0, 0, 0.45);
}
@media (min-width: 1024px) {
  .sz-header {
    background: color-mix(in srgb, hsl(var(--b1)) 86%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
}

/* ---- status strip ---- solid-ish, no continuous blur */
.sz-statusbar {
  background: color-mix(in srgb, hsl(var(--b1)) 94%, transparent);
  border: 1px solid var(--sz-border);
}
</style>
