<script lang="ts" setup>
import { useBaseStore, useBlockchain, useFormatter, useMintStore, useStakingStore, useTxDialog } from '@/stores';
import { computed } from '@vue/reactivity';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import type { Key, SlashingParam, Validator } from '@/types';
import { formatSeconds } from '@/libs/utils';
import { diff } from 'semver';
import { getGnoIndexer, type GnoIndexerValidator } from '@/libs/gno/indexer';
import { lookupGnoValoper, initGnoValopers } from '@/libs/gno/valopers';

const staking = useStakingStore();
const base = useBaseStore();
const format = useFormatter();
const dialog = useTxDialog();
const chainStore = useBlockchain();
const mintStore = useMintStore();

/** Gno/TM2 has no Cosmos staking/delegation — hide Delegate CTAs. */
const isGno = computed(
  () => chainStore.current?.engine === 'gno' || chainStore.current?.engine === 'tm2'
);

const indexerUrl = computed(() => (chainStore.current as any)?.indexer_api || '');

const cache = JSON.parse(localStorage.getItem('avatars') || '{}');
const avatars = ref(cache || {});
const latest = ref({} as Record<string, number>);
const yesterday = ref({} as Record<string, number>);
const tab = ref('active');
const unbondList = ref([] as Validator[]);
const slashing = ref({} as SlashingParam);

// ---- Gno: ACTIVE / INACTIVE / PENDING come from the onbloc indexer ----
const gnoValidators = ref<GnoIndexerValidator[]>([]);
const gnoLoading = ref(false);
const gnoError = ref('');
/** Toast for real set changes (new pending register / activated / inactivated). */
const gnoToast = ref('');
let gnoToastTimer: ReturnType<typeof setTimeout> | null = null;
let gnoPollTimer: ReturnType<typeof setInterval> | null = null;
/** First successful fetch is baseline — don't toast on initial load. */
let gnoBaselineReady = false;

function shortAddr(a: string): string {
  if (!a) return '—';
  return a.length > 18 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a;
}

/** Build a Validator-shaped object from an onbloc indexer entry.
 *  Moniker resolution: valopers realm registry first (covers ACTIVE signing
 *  addresses → operator moniker, and PENDING operator addresses), then onbloc
 *  monikerName, then short address.
 *
 *  NOTE on double-counting: onbloc lists an operator TWICE once they're voted
 *  in — once as ACTIVE (by signing address) and once as PENDING (by operator
 *  address, the original registration record). The validators page dedupes the
 *  PENDING tab against the ACTIVE set (see activeOperatorAddrs) so a validator
 *  that is already signing only shows under Active.
 */
function gnoToValidator(g: GnoIndexerValidator): Validator {
  const meta = lookupGnoValoper(g.address);
  const moniker = meta?.moniker || (g.monikerName || '').trim() || shortAddr(g.address);
  let website = (meta?.website || '').trim();
  if (website && (!/^https?:\/\//i.test(website) || /\]\(|discord\.gg|t\.me\//i.test(website))) {
    website = '';
  }
  return {
    operator_address: g.address,
    consensus_pubkey: { '@type': '/cosmos.crypto.ed25519.PubKey', key: '' } as Key,
    jailed: g.status === 'INACTIVE',
    status: g.status === 'ACTIVE' ? 'BOND_STATUS_BONDED' : 'BOND_STATUS_UNBONDED',
    tokens: g.votingPower || '0',
    delegator_shares: g.votingPower || '0',
    description: {
      moniker,
      identity: meta?.identity || '',
      website,
      security_contact: '',
      details: meta?.serverType ? `Gnoland validator · ${meta.serverType}` : '',
    },
    unbonding_height: String(g.inActivatedHeight || '0'),
    unbonding_time: '1970-01-01T00:00:00Z',
    commission: {
      commission_rates: { rate: '0', max_rate: '0', max_change_rate: '0' },
      update_time: '1970-01-01T00:00:00Z',
    },
    min_self_delegation: '1',
  } as Validator;
}

/**
 * Fingerprint a validator for set-diff: status + address + moniker.
 * Used to detect real changes between polls (not every poll → toast).
 */
function gnoFingerprint(g: GnoIndexerValidator): string {
  return `${g.status}|${g.address}|${(g.monikerName || '').trim()}`;
}

function showGnoToast(msg: string) {
  gnoToast.value = msg;
  if (gnoToastTimer) clearTimeout(gnoToastTimer);
  gnoToastTimer = setTimeout(() => {
    gnoToast.value = '';
    gnoToastTimer = null;
  }, 6000);
}

/**
 * Diff previous vs next raw onbloc set, then toast only meaningful changes
 * after dedupe (true pending / active / inactive). Quiet if nothing changed.
 */
function diffAndToast(prev: GnoIndexerValidator[], next: GnoIndexerValidator[]) {
  if (!gnoBaselineReady) {
    gnoBaselineReady = true;
    return;
  }
  const prevFp = new Set(prev.map(gnoFingerprint));
  const nextFp = new Set(next.map(gnoFingerprint));
  const added = next.filter((g) => !prevFp.has(gnoFingerprint(g)));
  const removed = prev.filter((g) => !nextFp.has(gnoFingerprint(g)));
  if (!added.length && !removed.length) return;

  // Classify using post-dedupe semantics so we don't toast for onbloc double-entries.
  // Temporarily use next as source for settled sets (caller assigns after toast).
  const msgs: string[] = [];
  for (const g of added) {
    const mon =
      lookupGnoValoper(g.address)?.moniker ||
      (g.monikerName || '').trim() ||
      shortAddr(g.address);
    if (g.status === 'PENDING') {
      // Only toast if it would survive isTruePending against the NEW set.
      // We'll re-check after assignment; for toast we approximate: not matching
      // any ACTIVE/INACTIVE moniker in the new set.
      const settled = next.some(
        (x) =>
          (x.status === 'ACTIVE' || x.status === 'INACTIVE') &&
          ((lookupGnoValoper(x.address)?.moniker || '').toLowerCase() === mon.toLowerCase() ||
            (x.monikerName || '').trim().toLowerCase() === mon.toLowerCase() ||
            x.address === g.address ||
            lookupGnoValoper(x.address)?.operatorAddress === g.address),
      );
      if (!settled) msgs.push(`New pending: ${mon}`);
    } else if (g.status === 'ACTIVE') {
      msgs.push(`Activated: ${mon}`);
    } else if (g.status === 'INACTIVE') {
      msgs.push(`Inactivated: ${mon}`);
    }
  }
  // Status flips (same operator moved ACTIVE→INACTIVE etc.) show as remove+add;
  // the add branch already covers the new status. Skip pure removals to avoid noise.
  if (msgs.length) showGnoToast(msgs.slice(0, 3).join(' · '));
}

async function fetchGnoValidators(opts: { silent?: boolean } = {}) {
  if (!isGno.value) return;
  // Wait briefly for chain config to settle (indexer_api arrives with current)
  if (!indexerUrl.value) {
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!indexerUrl.value) {
    console.warn('[validator] no indexer_api — Active/Inactive/Pending tabs will be empty');
    return;
  }
  if (!opts.silent) gnoLoading.value = true;
  try {
    // Ensure valopers registry is loaded (moniker + signing↔operator link for dedupe)
    await initGnoValopers().catch(() => undefined);
    const next = await getGnoIndexer(indexerUrl.value).getAllValidators();
    diffAndToast(gnoValidators.value, next);
    gnoValidators.value = next;
    gnoError.value = '';
    // Kick avatar fetch for AtomOne-enriched identities (no-op if already cached)
    loadAvatars();
  } catch (e: any) {
    console.warn('[validator] gno indexer fetch failed:', e?.message || e);
    if (!opts.silent) gnoError.value = e?.message || String(e);
  } finally {
    if (!opts.silent) gnoLoading.value = false;
  }
}

/**
 * Operator addresses of ACTIVE + INACTIVE validators (via valopers signing→operator).
 * Used to strip PENDING rows that are just the registration record of a validator
 * already in (or formerly in) the set — onbloc keeps both rows, we only show one.
 *
 * Priority: ACTIVE > INACTIVE > PENDING (registration-only).
 * Roomit / Provalidator: INACTIVE by signing addr + PENDING by operator addr →
 * show only under Inactive (they left the set at inActivatedHeight).
 */
const settledOperatorAddrs = computed(() => {
  const ops = new Set<string>();
  for (const g of gnoValidators.value) {
    if (g.status !== 'ACTIVE' && g.status !== 'INACTIVE') continue;
    const meta = lookupGnoValoper(g.address); // signing address → registry row
    if (meta?.operatorAddress) ops.add(meta.operatorAddress);
    // Also treat the signing address itself as settled (genesis / same-key cases).
    ops.add(g.address);
  }
  return ops;
});

/** Monikers of ACTIVE + INACTIVE (registry + onbloc monikerName), lowercased. */
const settledMonikers = computed(() => {
  const mons = new Set<string>();
  for (const g of gnoValidators.value) {
    if (g.status !== 'ACTIVE' && g.status !== 'INACTIVE') continue;
    const meta = lookupGnoValoper(g.address);
    if (meta?.moniker) mons.add(meta.moniker.toLowerCase());
    const onbloc = (g.monikerName || '').trim().toLowerCase();
    if (onbloc) mons.add(onbloc);
  }
  return mons;
});

/**
 * True PENDING = registered, not yet (and never was) in the validator set.
 * Drop if this operator is already ACTIVE or INACTIVE (onbloc double-entry).
 */
function isTruePending(g: GnoIndexerValidator): boolean {
  if (g.status !== 'PENDING') return false;
  // Drop if operator address already settled (Active or Inactive).
  if (settledOperatorAddrs.value.has(g.address)) return false;
  // Drop if moniker matches a settled validator (covers missing address link).
  const mon = (g.monikerName || '').trim().toLowerCase();
  if (mon && settledMonikers.value.has(mon)) return false;
  const meta = lookupGnoValoper(g.address);
  if (meta?.moniker && settledMonikers.value.has(meta.moniker.toLowerCase())) return false;
  return true;
}

const gnoCounts = computed(() => {
  let ACTIVE = 0;
  let INACTIVE = 0;
  let PENDING = 0;
  for (const v of gnoValidators.value) {
    if (v.status === 'ACTIVE') ACTIVE++;
    else if (v.status === 'INACTIVE') INACTIVE++;
    else if (v.status === 'PENDING' && isTruePending(v)) PENDING++;
  }
  return { ACTIVE, INACTIVE, PENDING };
});

onMounted(() => {
  // Soft-fail: unbonding/inactive lists + slashing params are nice-to-have.
  // Some LCDs 500 on historical validatorsets / custom modules — must not
  // surface as uncaught pageerrors that fail the whole validators page.
  staking
    .fetchUnbondingValdiators()
    .then((res) => {
      unbondList.value = res.concat(unbondList.value);
    })
    .catch((e: any) => console.warn('[validator] unbonding list:', e?.message || e));
  staking
    .fetchInacitveValdiators()
    .then((res) => {
      unbondList.value = unbondList.value.concat(res);
    })
    .catch((e: any) => console.warn('[validator] inactive list:', e?.message || e));
  chainStore.rpc
    .getSlashingParams()
    .then((res) => {
      slashing.value = res.params;
    })
    .catch((e: any) => console.warn('[validator] slashing params:', e?.message || e));
  // Gno: pull the full ACTIVE/INACTIVE/PENDING set from the indexer
  fetchGnoValidators();
  // Re-fetch if indexer_api arrives after mount (race with chain init)
  watch(indexerUrl, (url, prev) => {
    if (url && url !== prev) fetchGnoValidators();
  });
  // Near-realtime: poll every 60s while this page is open. Toast only on real
  // set changes (new pending register / activated / inactivated) — not every tick.
  // Same idea as TX page polling, but validators change rarely so toast is useful.
  if (isGno.value) {
    gnoPollTimer = setInterval(() => fetchGnoValidators({ silent: true }), 60_000);
  }
});

onUnmounted(() => {
  if (gnoPollTimer) {
    clearInterval(gnoPollTimer);
    gnoPollTimer = null;
  }
  if (gnoToastTimer) {
    clearTimeout(gnoToastTimer);
    gnoToastTimer = null;
  }
});

async function fetchChange(blockWindow: number = 14400) {
  let page = 0;

  let height = Number(base.latest?.block?.header?.height || 0);
  if (height > blockWindow) {
    height -= blockWindow;
  } else {
    height = 1;
  }
  // voting power in 24h ago — soft-fail per page (pruned LCDs 500 often)
  while (page < staking.validators.length && height > 0) {
    try {
      const x = await base.fetchValidatorByHeight(height, page);
      x?.validators?.forEach((v) => {
        if (v?.pub_key?.key) yesterday.value[v.pub_key.key] = Number(v.voting_power);
      });
    } catch (e: any) {
      console.warn('[validator] set@height failed:', e?.message || e);
      break;
    }
    page += 100;
  }

  page = 0;
  // voting power for now
  while (page < staking.validators.length) {
    try {
      const x = await base.fetchLatestValidators(page);
      x?.validators?.forEach((v) => {
        if (v?.pub_key?.key) latest.value[v.pub_key.key] = Number(v.voting_power);
      });
    } catch (e: any) {
      console.warn('[validator] latest set failed:', e?.message || e);
      break;
    }
    page += 100;
  }
}

const changes = computed(() => {
  const changes = {} as Record<string, number>;
  Object.keys(latest.value).forEach((k) => {
    const l = latest.value[k] || 0;
    const y = yesterday.value[k] || 0;
    changes[k] = l - y;
  });
  return changes;
});

const change24 = (entry: { consensus_pubkey: Key; tokens: string }) => {
  const txt = entry.consensus_pubkey.key;
  // const n: number = latest.value[txt];
  // const o: number = yesterday.value[txt];
  // // console.log( txt, n, o)
  // return n > 0 && o > 0 ? n - o : 0;

  const latestValue = latest.value[txt];
  if (!latestValue) {
    return 0;
  }

  const displayTokens = format.tokenAmountNumber({
    amount: parseInt(entry.tokens, 10).toString(),
    denom: staking.params.bond_denom,
  });
  const coefficient = displayTokens / latestValue;
  return changes.value[txt] * coefficient;
};

const change24Text = (entry: { consensus_pubkey: Key; tokens: string }) => {
  if (!entry) return '';
  const v = change24(entry);
  return v && v !== 0 ? format.showChanges(v) : '';
};

const change24Color = (entry: { consensus_pubkey: Key; tokens: string }) => {
  if (!entry) return '';
  const v = change24(entry);
  if (v > 0) return 'text-success';
  if (v < 0) return 'text-error';
};

const calculateRank = function (position: number) {
  let sum = 0;
  for (let i = 0; i < position; i++) {
    sum += Number(staking.validators[i]?.delegator_shares);
  }
  const percent = sum / staking.totalPower;

  switch (true) {
    case tab.value === 'active' && percent < 0.33:
      return 'error';
    case tab.value === 'active' && percent < 0.67:
      return 'warning';
    default:
      return 'primary';
  }
};

const list = computed(() => {
  // Gno: ONLY the onbloc indexer set (ACTIVE / INACTIVE / PENDING).
  // Never fall back to staking.validators (RPC) — that list is moniker-polluted
  // by valopers overlay and has no status dimension, so Active looks identical
  // to Pending and every row is "ACTIVE".
  if (isGno.value) {
    if (!gnoValidators.value.length) return [];
    const want =
      tab.value === 'active' ? 'ACTIVE' : tab.value === 'pending' ? 'PENDING' : 'INACTIVE';
    return gnoValidators.value
      .filter((g) => g.status === want)
      // PENDING: drop onbloc double-entries that are already signing (Active tab)
      // or formerly active (Inactive tab) — residual Roomit/Provalidator case
      .filter((g) => (want === 'PENDING' ? isTruePending(g) : true))
      .sort((a, b) => Number(b.votingPower) - Number(a.votingPower))
      .map((g, i) => {
        const v = gnoToValidator(g);
        return {
          v,
          rank: want === 'ACTIVE' ? calculateRank(i) : 'primary',
          // AtomOne-enriched Keybase identity → same logo() path as Cosmos
          logo: logo(v.description?.identity),
          gno: g as GnoIndexerValidator | null,
        };
      });
  }
  if (tab.value === 'active') {
    return staking.validators.map((x, i) => ({
      v: x,
      rank: calculateRank(i),
      logo: logo(x.description.identity),
      gno: null as GnoIndexerValidator | null,
    }));
  }
  return unbondList.value.map((x, i) => ({
    v: x,
    rank: 'primary',
    logo: logo(x.description.identity),
    gno: null as GnoIndexerValidator | null,
  }));
});

const fetchAvatar = (identity: string) => {
  // fetch avatar from keybase
  return new Promise<void>((resolve) => {
    staking
      .keybase(identity)
      .then((d) => {
        if (Array.isArray(d.them) && d.them.length > 0) {
          const uri = String(d.them[0]?.pictures?.primary?.url).replace(
            'https://s3.amazonaws.com/keybase_processed_uploads/',
            ''
          );

          avatars.value[identity] = uri;
          resolve();
        } else throw new Error(`failed to fetch avatar for ${identity}`);
      })
      .catch((error) => {
        // console.error(error); // uncomment this if you want the user to see which avatars failed to load.
        resolve();
      });
  });
};

const loadAvatar = (identity: string) => {
  // fetches avatar from keybase and stores it in localStorage
  fetchAvatar(identity).then(() => {
    localStorage.setItem('avatars', JSON.stringify(avatars.value));
  });
};

const loadAvatars = () => {
  // fetches all avatars from keybase and stores it in localStorage
  // Gno: pull identities from the mapped validator list (AtomOne-enriched)
  const source = isGno.value
    ? list.value.map((row) => row.v)
    : staking.validators;
  const promises = source.map((validator) => {
    const identity = validator.description?.identity;

    // Here we also check whether we haven't already fetched the avatar
    if (identity && !avatars.value[identity]) {
      return fetchAvatar(identity);
    } else {
      return Promise.resolve();
    }
  });

  Promise.all(promises).then(() => localStorage.setItem('avatars', JSON.stringify(avatars.value)));
};

const logo = (identity?: string) => {
  if (!identity || !avatars.value[identity]) return '';
  const url = avatars.value[identity] || '';
  return url.startsWith('http') ? url : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
};

const loaded = ref(false);
base.$subscribe((_, s) => {
  if (s.recents.length >= 2 && loaded.value === false) {
    loaded.value = true;
    const diff_time = Date.parse(s.recents[1].block.header.time) - Date.parse(s.recents[0].block.header.time);
    const diff_height = Number(s.recents[1].block.header.height) - Number(s.recents[0].block.header.height);
    const block_window = Number(Number((86400 * 1000 * diff_height) / diff_time).toFixed(0));
    fetchChange(block_window);
  }
});

loadAvatars();
</script>
<template>
  <div>
    <div class="sz-page-head">
      <div>
        <h1 class="sz-page-title">{{ $t('module.validator') }}</h1>
        <div class="sz-page-sub">
          <span class="font-mono">{{ isGno ? (gnoValidators.length ? (gnoCounts.ACTIVE + gnoCounts.PENDING + gnoCounts.INACTIVE) : '…') : list.length }}</span>
          <template v-if="isGno && gnoValidators.length">
            validators · {{ gnoCounts.ACTIVE }} active · {{ gnoCounts.PENDING }} pending · {{ gnoCounts.INACTIVE }} inactive
          </template>
          <template v-else-if="isGno && gnoLoading">
            · loading from indexer…
          </template>
          <template v-else-if="!isGno">
            / {{ staking.params.max_validators }} {{ $t('staking.validator').toLowerCase() }}
          </template>
        </div>
      </div>
      <div class="sz-tabs">
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'active' }" @click="tab = 'active'">
          {{ $t('staking.active') }}
          <span v-if="isGno" class="sz-tab-count">{{ gnoCounts.ACTIVE }}</span>
        </a>
        <a class="sz-tab" :class="{ 'sz-tab--active': tab === 'inactive' }" @click="tab = 'inactive'">
          {{ $t('staking.inactive') }}
          <span v-if="isGno" class="sz-tab-count">{{ gnoCounts.INACTIVE }}</span>
        </a>
        <a v-if="isGno" class="sz-tab" :class="{ 'sz-tab--active': tab === 'pending' }" @click="tab = 'pending'">
          {{ $t('staking.pending') }}
          <span class="sz-tab-count">{{ gnoCounts.PENDING }}</span>
        </a>
      </div>
    </div>

    <!-- Gno status legend — Pending ≠ inactive; registered but not yet signing -->
    <div v-if="isGno" class="sz-section mt-3 px-4 py-3 text-[12px] leading-relaxed text-secondary">
      <div class="flex flex-wrap items-start gap-x-5 gap-y-2">
        <span class="inline-flex items-center gap-1.5">
          <span class="sz-chip sz-chip--ok !text-[10px]">ACTIVE</span>
          Signing blocks now (in the Tendermint2 validator set).
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="sz-chip sz-chip--warn !text-[10px]">PENDING</span>
          Registered, not signing yet — needs community voting to become active.
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="sz-chip sz-chip--bad !text-[10px]">INACTIVE</span>
          Left the active set (jailed / removed).
        </span>
      </div>
      <div class="mt-2 text-[11px] text-secondary/80">
        Auto-refreshes every 60s from the indexer · toast on new register / activate / inactivate.
      </div>
    </div>

    <!-- network staking vitals — Gno has no mint/slashing modules -->
    <div v-if="!isGno" class="grid grid-cols-2 gap-3 xl:!grid-cols-4">
      <div class="sz-stat" style="--stat-hue: var(--sz-success)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.inflation') }}</span></div>
        <div class="sz-stat-value">{{ format.percent(mintStore.inflation) }}</div>
      </div>
      <div class="sz-stat" style="--stat-hue: var(--sz-accent)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.unbonding_time') }}</span></div>
        <div class="sz-stat-value">{{ formatSeconds(staking.params?.unbonding_time) }}</div>
      </div>
      <div class="sz-stat" style="--stat-hue: var(--sz-danger)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.double_sign_slashing') }}</span></div>
        <div class="sz-stat-value">{{ format.percent(slashing.slash_fraction_double_sign) }}</div>
      </div>
      <div class="sz-stat" style="--stat-hue: var(--sz-warn)">
        <div class="sz-stat-head"><i class="sz-stat-tick"></i><span class="sz-stat-label">{{ $t('staking.downtime_slashing') }}</span></div>
        <div class="sz-stat-value">{{ format.percent(slashing.slash_fraction_downtime) }}</div>
      </div>
    </div>

    <!-- validator set -->
    <div class="sz-section mt-4 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th style="width: 3.5rem">{{ $t('staking.rank') }}</th>
              <th>{{ $t('staking.validator') }}</th>
              <th class="text-right">{{ $t('staking.voting_power') }}</th>
              <th class="text-right">{{ isGno ? 'Share' : $t('staking.24h_changes') }}</th>
              <th class="text-right">{{ isGno ? $t('staking.status') : $t('staking.commission') }}</th>
              <th class="text-center">{{ isGno ? 'Height' : $t('staking.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="isGno && gnoLoading && !gnoValidators.length">
              <td colspan="6" class="py-10 text-center text-[12.5px] text-secondary">
                Loading validators from indexer…
              </td>
            </tr>
            <tr v-else-if="isGno && gnoError && !gnoValidators.length">
              <td colspan="6" class="py-10 text-center text-[12.5px] text-error">
                {{ gnoError }}
              </td>
            </tr>
            <tr v-else-if="!list.length">
              <td colspan="6" class="py-10 text-center text-[12.5px] text-secondary">
                No validators in this status.
              </td>
            </tr>
            <tr v-for="({ v, rank, logo, gno }, i) in list" :key="v.operator_address">
              <!-- rank -->
              <td>
                <span
                  class="sz-chip font-mono !text-[11px]"
                  :class="{
                    'sz-chip--bad': rank === 'error',
                    'sz-chip--warn': rank === 'warning',
                    'sz-chip--info': rank === 'primary',
                  }"
                >
                  {{ i + 1 }}
                </span>
              </td>
              <!-- validator -->
              <td>
                <div class="flex items-center gap-3 overflow-hidden" style="max-width: 320px">
                  <div class="relative h-9 w-9 shrink-0 overflow-hidden rounded-full bg-base-200 ring-1 ring-base-content/10">
                    <img v-if="logo" :src="logo" class="h-full w-full object-contain"
                      @error="() => { const identity = v.description?.identity; if (identity) loadAvatar(identity); }"
                    />
                    <div v-else class="flex h-full w-full items-center justify-center text-base-content/40">
                      <Icon icon="mdi:help-circle-outline" class="text-xl" />
                    </div>
                  </div>
                  <div class="min-w-0">
                    <RouterLink
                      :to="`/${$route.params.chain}/validator/${v.operator_address}`"
                      class="block truncate text-[13.5px] font-semibold text-primary no-underline hover:underline"
                    >
                      {{ v.description?.moniker }}
                    </RouterLink>
                    <span class="block truncate font-mono text-[11px] text-secondary">
                      <template v-if="gno">{{ shortAddr(v.operator_address) }}</template>
                      <template v-else>{{ v.description?.website || v.description?.identity || '-' }}</template>
                    </span>
                  </div>
                </div>
              </td>
              <!-- voting power -->
              <td class="text-right">
                <div class="font-mono text-[13px] font-semibold whitespace-nowrap">
                  {{ format.formatToken({ amount: parseInt(v.tokens).toString(), denom: staking.params.bond_denom }, true, '0,0') }}
                </div>
                <div class="mt-1 flex items-center justify-end gap-1.5">
                  <div class="h-1 w-16 overflow-hidden rounded-full bg-base-content/10">
                    <div
                      class="h-full rounded-full"
                      :class="rank === 'error' ? 'bg-error' : rank === 'warning' ? 'bg-warning' : 'bg-primary'"
                      :style="{ width: (staking.totalPower ? Math.min(100, (Number(v.delegator_shares) / staking.totalPower) * 100) : 0) + '%' }"
                    ></div>
                  </div>
                  <span class="text-[10.5px] text-secondary">{{ format.calculatePercent(v.delegator_shares, staking.totalPower) }}</span>
                </div>
              </td>
              <!-- share (Gno) / 24h change (Cosmos) -->
              <td class="text-right font-mono text-[12px]" :class="gno ? '' : change24Color(v)">
                <template v-if="gno">{{ gno.shareRate }}%</template>
                <template v-else>{{ change24Text(v) || '—' }}</template>
              </td>
              <!-- status (Gno) / commission (Cosmos) -->
              <td class="text-right font-mono text-[12px]">
                <template v-if="gno">
                  <span
                    class="sz-chip !text-[10px]"
                    :class="{
                      'sz-chip--good': gno.status === 'ACTIVE',
                      'sz-chip--ok': gno.status === 'ACTIVE',
                      'sz-chip--bad': gno.status === 'INACTIVE',
                      'sz-chip--warn': gno.status === 'PENDING',
                    }"
                  >{{ gno.status }}</span>
                </template>
                <template v-else>{{ format.formatCommissionRate(v.commission?.commission_rates?.rate) }}</template>
              </td>
              <!-- height (Gno) / action (Cosmos) -->
              <td class="text-center">
                <template v-if="gno">
                  <span v-if="gno.status === 'INACTIVE' && gno.inActivatedHeight" class="font-mono text-[11px] text-secondary" :title="'Inactivated at'">
                    #{{ gno.inActivatedHeight }}
                  </span>
                  <RouterLink
                    v-else-if="gno.firstCommittedHeight"
                    class="sz-height-link font-mono text-[11px]"
                    :to="`/${$route.params.chain}/block/${gno.firstCommittedHeight}`"
                  >
                    <span class="sz-height-hash">#</span>{{ gno.firstCommittedHeight }}
                  </RouterLink>
                  <span v-else class="text-[11px] text-secondary">—</span>
                </template>
                <template v-else>
                  <span v-if="v.jailed" class="sz-chip sz-chip--bad">{{ $t('staking.jailed') }}</span>
                  <span v-else-if="isGno" class="text-[11px] text-secondary">—</span>
                  <button type="button"
                    v-else
                    class="btn btn-xs btn-primary rounded-md capitalize"
                    @click="dialog.open('delegate', { validator_address: v.operator_address })"
                  >
                    {{ $t('account.btn_delegate') }}
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-base-content/10 px-4 py-3">
        <span class="sz-chip sz-chip--bad">{{ $t('staking.top') }} 33%</span>
        <span class="sz-chip sz-chip--warn">{{ $t('staking.top') }} 67%</span>
        <span class="hidden text-[11.5px] text-secondary md:!inline">{{ $t('staking.description') }}</span>
      </div>
    </div>

    <!-- Gno realtime toast — fires only on real validator set changes -->
    <Transition name="gno-toast">
      <div
        v-if="gnoToast"
        class="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-3 rounded-xl border border-base-content/10 bg-base-100 px-4 py-3 shadow-lg"
      >
        <span class="sz-chip sz-chip--ok !text-[10px]">LIVE</span>
        <span class="text-[13px] font-medium text-base-content">{{ gnoToast }}</span>
        <button
          class="ml-1 text-base-content/40 hover:text-base-content"
          @click="gnoToast = ''"
        >✕</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.gno-toast-enter-active,
.gno-toast-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.gno-toast-enter-from,
.gno-toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>

<route>
  {
    meta: {
      i18n: 'validator',
      order: 3
    }
  }
</route>
