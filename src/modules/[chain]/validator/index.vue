<script lang="ts" setup>
import { useBaseStore, useBlockchain, useFormatter, useMintStore, useStakingStore, useTxDialog } from '@/stores';
import { computed } from '@vue/reactivity';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import type { Key, SlashingParam, Validator } from '@/types';
import { formatSeconds, getLocalJson } from '@/libs/utils';
import { diff } from 'semver';
import { getGnoIndexer, type GnoIndexerValidator } from '@/libs/gno/indexer';
import { lookupGnoValoper, initGnoValopers, listGnoValopers } from '@/libs/gno/valopers';

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
const uptimeUrl = computed(() => (chainStore.current as any)?.uptime_live_url || '');

const cache = getLocalJson<Record<string, string>>('avatars', {});
const avatars = ref(cache || {});
const latest = ref({} as Record<string, number>);
const yesterday = ref({} as Record<string, number>);
const tab = ref('active');
const unbondList = ref([] as Validator[]);
const slashing = ref({} as SlashingParam);

// ---- Gno: status + uptime come from the bounded collector snapshot ----
const gnoValidators = ref<GnoIndexerValidator[]>([]);
const gnoLoading = ref(false);
const gnoError = ref('');
const gnoUptime = ref<Record<string, GnoIndexerValidator['uptime']>>({});
const gnoUptimeError = ref('');
const gnoUptimeWindow = ref(10_000);
/** Toast for real set changes (new pending register / activated / inactivated). */
const gnoToast = ref('');
let gnoToastTimer: ReturnType<typeof setTimeout> | null = null;
let gnoPollTimer: ReturnType<typeof setInterval> | null = null;
/** Bump every fetchGnoValidators call so stale in-flight results are ignored. */
let gnoFetchGen = 0;
/** First successful fetch is baseline — don't toast on initial load. */
let gnoBaselineReady = false;

function shortAddr(a: string): string {
  if (!a) return '—';
  return a.length > 18 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a;
}

/** Stable Gno order shared with the uptime page. */
function compareGnoValidators(a: GnoIndexerValidator, b: GnoIndexerValidator): number {
  const power = Number(b.votingPower || 0) - Number(a.votingPower || 0);
  if (power !== 0) return power;
  const aName = (lookupGnoValoper(a.address)?.moniker || a.monikerName || a.address || '').trim();
  const bName = (lookupGnoValoper(b.address)?.moniker || b.monikerName || b.address || '').trim();
  return aName.localeCompare(bName, undefined, { sensitivity: 'base' })
    || String(a.address || '').localeCompare(String(b.address || ''));
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
      security_contact: meta?.email || '',
      details: meta?.description || (meta?.serverType ? `Gnoland validator · ${meta.serverType}` : ''),
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
 * Fingerprint a validator for set-diff: status + address only.
 * Moniker is display-only — renames must NOT toast as set changes.
 */
function uptimeFor(g: GnoIndexerValidator) {
  const meta = lookupGnoValoper(g.address);
  return gnoUptime.value[g.address]
    || (meta?.signingAddress ? gnoUptime.value[meta.signingAddress] : undefined)
    || (meta?.operatorAddress ? gnoUptime.value[meta.operatorAddress] : undefined);
}

/** Collector snapshot is authoritative for uptime-derived ACTIVE/INACTIVE/PENDING.
 * Keep indexer metadata (moniker, proposal, voting power) and replace only the
 * status/read-model fields when the matching operator or signing address exists.
 */
function applyUptime(rows: GnoIndexerValidator[]): GnoIndexerValidator[] {
  return rows.map((row) => {
    const uptime = uptimeFor(row);
    // The collector snapshot is authoritative for the Gno tabs. If an
    // indexer row has not reached the collector yet, keep it out of Active;
    // it is an unobserved/pending validator, not an ACTIVE+PENDING hybrid.
    if (!uptime) {
      return { ...row, status: 'PENDING', uptime: undefined };
    }
    return {
      ...row,
      status: uptime.status || row.status,
      uptime,
    };
  });
}

function mergeWithUptime(rows: GnoIndexerValidator[]): GnoIndexerValidator[] {
  // Deduplicate the indexer’s operator-registration PENDING rows before
  // applying uptime. Otherwise operator lookup promotes those duplicates to
  // ACTIVE and they survive the filter as a second copy.
  return applyUptime(mergeRegistryPending(rows));
}

function uptimeLabel(g?: GnoIndexerValidator | null): string {
  // Inactive validators are intentionally shown as zero in the Inactive tab.
  // Classification still comes from the collector snapshot; this is only the
  // compact table presentation requested for this explorer.
  if (g?.status === 'INACTIVE') return '0.00%';
  const u = g ? uptimeFor(g) : undefined;
  if (!u || u.uptime == null) return 'PENDING';
  return `${Number(u.uptime).toFixed(2)}%`;
}

async function fetchGnoUptime() {
  if (!isGno.value || !uptimeUrl.value) return;
  try {
    const response = await fetch(uptimeUrl.value, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const next: Record<string, GnoIndexerValidator['uptime']> = {};
    for (const row of Array.isArray(payload?.validators) ? payload.validators : []) {
      if (!row || typeof row !== 'object') continue;
      const op = String(row.operatorAddress || '');
      const sig = String(row.signingAddress || '');
      if (op) next[op] = row;
      if (sig) next[sig] = row;
    }
    gnoUptimeWindow.value = Number(payload?.windowBlocks) || 10_000;
    gnoUptime.value = next;
    // Do not let the indexer’s historical status override the collector’s
    // rolling-window policy. Re-apply it to the already loaded rows.
    if (gnoValidators.value.length) {
      gnoValidators.value = applyUptime(gnoValidators.value);
    }
    gnoUptimeError.value = '';
  } catch (e: any) {
    gnoUptimeError.value = e?.message || String(e);
    console.warn('[validator] gno uptime snapshot:', gnoUptimeError.value);
  }
}

function gnoFingerprint(g: GnoIndexerValidator): string {
  return `${g.status}|${g.address}`;
}

function gnoSetKey(rows: GnoIndexerValidator[]): string {
  return rows
    .map(gnoFingerprint)
    .sort()
    .join('\n');
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
      // Toast only if this address is not already an ACTIVE/INACTIVE op/sig pair.
      // Never match by moniker — same name can be a different valoper.
      const settled = next.some((x) => {
        if (x.status !== 'ACTIVE' && x.status !== 'INACTIVE') return false;
        if (x.address === g.address) return true;
        const xm = lookupGnoValoper(x.address);
        if (xm?.operatorAddress === g.address) return true;
        if (xm?.signingAddress === g.address) return true;
        const gm = lookupGnoValoper(g.address);
        if (gm && xm) {
          if (gm.operatorAddress && gm.operatorAddress === xm.operatorAddress) return true;
          if (gm.signingAddress && gm.signingAddress === xm.signingAddress) return true;
        }
        return false;
      });
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

/**
 * onbloc keeps a PENDING row for every registration — including operators that
 * later became ACTIVE (address = operator, while ACTIVE row uses signing addr).
 * Those double-entries must stay hidden — matched by address only.
 *
 * Separately, NEW registrations often appear ONLY on the official valopers
 * realm (gnoweb page 3+) before onbloc indexes them. We synthesize PENDING
 * rows from the valopers registry for operators not yet in ACTIVE/INACTIVE.
 *
 * Moniker is display-only. Two valopers can share "LuckyStar" / "onbloc-val-01"
 * — identity key is always operatorAddress + signingAddress.
 */
function mergeRegistryPending(indexerRows: GnoIndexerValidator[]): GnoIndexerValidator[] {
  const settled = new Set<string>();
  const seenPend = new Set<string>();

  for (const g of indexerRows) {
    if (g.status !== 'ACTIVE' && g.status !== 'INACTIVE') continue;
    settled.add(g.address);
    const meta = lookupGnoValoper(g.address);
    // Only the paired op/sig for THIS address — never all rows with same moniker.
    if (meta?.operatorAddress) settled.add(meta.operatorAddress);
    if (meta?.signingAddress) settled.add(meta.signingAddress);
  }

  const belongsToSettledPair = (g: GnoIndexerValidator): boolean => {
    if (settled.has(g.address)) return true;
    const meta = lookupGnoValoper(g.address);
    return Boolean(
      (meta?.operatorAddress && settled.has(meta.operatorAddress)) ||
      (meta?.signingAddress && settled.has(meta.signingAddress))
    );
  };

  // OnBloc keeps the original PENDING registration row after the same
  // operator enters the set. Remove that duplicate BEFORE applying uptime;
  // otherwise operator-address lookup promotes the duplicate to ACTIVE.
  const out = indexerRows.filter(
    (g) => g.status !== 'PENDING' || !belongsToSettledPair(g)
  );
  for (const g of out) {
    if (g.status === 'PENDING') seenPend.add(g.address);
  }

  let synthId = -1;
  for (const row of listGnoValopers()) {
    const op = (row.operatorAddress || '').trim();
    const sig = (row.signingAddress || '').trim();
    const mon = (row.moniker || '').trim();
    if (!op && !sig) continue;
    // Address-only: already active/inactive (this valoper pair).
    if (sig && settled.has(sig)) continue;
    if (op && settled.has(op)) continue;
    // Already have an onbloc PENDING row for this operator/signing.
    if (op && seenPend.has(op)) continue;
    if (sig && seenPend.has(sig)) continue;

    out.push({
      id: synthId--,
      monikerName: mon || shortAddr(op || sig),
      status: 'PENDING',
      // Pending detail / account activity keys off operator (gnokey), not secrets.
      address: op || sig,
      votingPower: '0',
      shareRate: '0',
      firstCommittedHeight: 0,
      inActivatedHeight: null,
      firstCommittedTime: null,
      proposalId: null,
    });
    if (op) seenPend.add(op);
    if (sig) seenPend.add(sig);
  }
  return out;
}

async function fetchGnoValidators(opts: { silent?: boolean } = {}) {
  if (!isGno.value) return;
  // Wait briefly for chain config to settle (indexer_api arrives with current)
  if (!indexerUrl.value) {
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!indexerUrl.value) {
    console.warn('[validator] no indexer_api — Active/Inactive/Pending tabs will be empty');
    // Soft fallback: ACTIVE set from TM2 RPC so the page is never blank forever.
    await fetchGnoValidatorsFromRpc();
    return;
  }
  // Generation token: a new call always supersedes an older in-flight one.
  // Never gate on gnoLoading — that caused "SPA nav blank until hard refresh"
  // when a hung/slow indexer left loading=true and later mounts no-op'd.
  const gen = ++gnoFetchGen;
  if (!opts.silent) gnoLoading.value = true;
  const maxAttempts = opts.silent ? 1 : 3;
  let lastErr: any = null;
  // Snapshot for silent poll toast (progressive assign would otherwise make prev===next)
  const prevSnapshot = opts.silent ? gnoValidators.value.slice() : null;
  // Silent background polls must NOT progressive-paint: swapping partial pages
  // (20 → 40 → 88) several times per minute makes the table "refresh" and
  // flicker for the user. Keep the current rows until the full set is ready,
  // then swap once + toast only on real identity-set changes.
  const paintProgressive = !opts.silent;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (gen !== gnoFetchGen) return;
    try {
      // Ensure valopers registry is loaded (moniker + signing↔operator + pending synth)
      // Bust HTTP cache so new registrations from cron land without hard refresh.
      await initGnoValopers().catch((e: any) => console.warn('[gno-valopers] init:', e?.message || e));
      if (gen !== gnoFetchGen) return;
      const nextRaw = await getGnoIndexer(indexerUrl.value).getAllValidators((partial, done) => {
        if (gen !== gnoFetchGen) return;
        if (!paintProgressive) return; // silent: hold UI until full merge below
        // First paint only when list empty; later progressive appends for cold load
        gnoValidators.value = mergeWithUptime(partial);
        if (done) gnoError.value = '';
        if (partial.length) loadAvatars();
      });
      if (gen !== gnoFetchGen) return;
      const next = mergeWithUptime(nextRaw);
      if (opts.silent && prevSnapshot) {
        // Compare identity fingerprints; toast only for real add/remove/status
        diffAndToast(prevSnapshot, next);
        // Skip DOM thrash if the set is identical (common every 30s poll)
        if (gnoSetKey(prevSnapshot) !== gnoSetKey(next)) {
          gnoValidators.value = next;
          loadAvatars();
        }
      } else {
        if (!gnoBaselineReady) gnoBaselineReady = true;
        gnoValidators.value = next;
        loadAvatars();
      }
      gnoError.value = '';
      lastErr = null;
      break;
    } catch (e: any) {
      lastErr = e;
      console.warn(
        `[validator] gno indexer fetch failed (attempt ${attempt + 1}/${maxAttempts}):`,
        e?.message || e
      );
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  if (gen !== gnoFetchGen) return;
  if (lastErr) {
    if (!opts.silent) gnoError.value = lastErr?.message || String(lastErr);
    // Indexer down: keep existing rows if any; else RPC ACTIVE fallback + still show registry pending.
    if (!gnoValidators.value.length) {
      await fetchGnoValidatorsFromRpc();
    } else {
      // Re-merge in case registry JSON updated while indexer errored
      gnoValidators.value = mergeRegistryPending(
        gnoValidators.value.filter((g) => g.id >= 0) // drop prior synth, re-add
      );
    }
  }
  if (!opts.silent) gnoLoading.value = false;
}

/** TM2 /validators ACTIVE-only fallback when indexer is missing/down. */
async function fetchGnoValidatorsFromRpc() {
  const rpc = chainStore.rpc as any;
  if (!rpc?.getStakingValidators) return;
  try {
    await initGnoValopers().catch((e: any) => console.warn('[gno-valopers] init:', e?.message || e));
    const res = await rpc.getStakingValidators('BOND_STATUS_BONDED');
    const vals = (res?.validators || []) as Validator[];
    // Map to indexer shape so list/tabs keep working (ACTIVE only).
    const mapped: GnoIndexerValidator[] = vals.map((v, i) => ({
      id: i,
      monikerName: v.description?.moniker || '',
      status: 'ACTIVE',
      address: v.operator_address,
      votingPower: v.tokens || '0',
      shareRate: '0',
      firstCommittedHeight: 0,
      inActivatedHeight: null,
      firstCommittedTime: null,
      proposalId: null,
    }));
    if (mapped.length) {
      // Still surface registry-only registrations as Pending when indexer is down.
      gnoValidators.value = mergeRegistryPending(mapped);
      gnoError.value = gnoError.value || 'Indexer unavailable — showing RPC active set';
      if (!gnoBaselineReady) gnoBaselineReady = true;
      loadAvatars();
    }
  } catch (e: any) {
    console.warn('[validator] RPC active-set fallback failed:', e?.message || e);
  }
}

/**
 * Operator/signing addresses of ACTIVE + INACTIVE validators.
 * Used to strip PENDING rows that are just the registration record of a
 * validator already in (or formerly in) the set — onbloc keeps both rows.
 *
 * Identity key = address only (operator OR signing). Moniker is NEVER used:
 * different valopers can share the same moniker (LuckyStar / onbloc-val-01).
 *
 * Priority: ACTIVE > INACTIVE > PENDING (registration-only).
 */
const settledAddrs = computed(() => {
  const addrs = new Set<string>();
  for (const g of gnoValidators.value) {
    if (g.status !== 'ACTIVE' && g.status !== 'INACTIVE') continue;
    // The onbloc ACTIVE/INACTIVE row itself (usually signing address)
    addrs.add(g.address);
    // Paired operator/signing from valopers registry for THIS address only
    const meta = lookupGnoValoper(g.address);
    if (meta?.operatorAddress) addrs.add(meta.operatorAddress);
    if (meta?.signingAddress) addrs.add(meta.signingAddress);
  }
  return addrs;
});

/**
 * True PENDING = registered, not yet (and never was) in the validator set.
 * Drop only when this row's address is the operator/signing of an
 * ACTIVE/INACTIVE entry. Same moniker + different valoper = still pending.
 */
function isTruePending(g: GnoIndexerValidator): boolean {
  if (g.status !== 'PENDING') return false;
  if (settledAddrs.value.has(g.address)) return false;
  // Also resolve via registry: pending row may be operator while settled
  // set only has signing (or vice versa) for the SAME valoper pair.
  const meta = lookupGnoValoper(g.address);
  if (meta?.operatorAddress && settledAddrs.value.has(meta.operatorAddress)) return false;
  if (meta?.signingAddress && settledAddrs.value.has(meta.signingAddress)) return false;
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
  // Guard rpc — onMounted can race chain connect (Gno "need refresh" class).
  const rpc = chainStore.rpc;
  if (rpc) {
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
    rpc
      .getSlashingParams()
      .then((res) => {
        slashing.value = res.params;
      })
      .catch((e: any) => console.warn('[validator] slashing params:', e?.message || e));
  }
  // Gno: pull the full ACTIVE/INACTIVE/PENDING set from the indexer and
  // independently load rolling signing statistics from the collector.
  fetchGnoValidators();
  fetchGnoUptime();
  // Re-fetch if indexer_api arrives after mount (race with chain init)
  watch(indexerUrl, (url, prev) => {
    if (url && url !== prev) fetchGnoValidators();
  });
  // Also re-fetch when engine/current settles (first paint often has empty indexer_api)
  watch(
    () => [isGno.value, chainStore.current?.chainName, !!chainStore.rpc] as const,
    ([gno, , hasRpc], prev) => {
      if (gno && (!prev || !prev[0] || !gnoValidators.value.length)) {
        fetchGnoValidators();
      }
      // Cosmos soft-fail params once rpc appears
      if (!gno && hasRpc && !slashing.value?.signed_blocks_window) {
        chainStore.rpc
          ?.getSlashingParams()
          .then((res) => {
            slashing.value = res.params;
          })
          .catch(() => undefined);
      }
      // Gno: if rpc lands late and we still have zero rows (indexer miss), try again
      if (gno && hasRpc && !gnoValidators.value.length && !gnoLoading.value) {
        fetchGnoValidators();
      }
    }
  );
  // After RPC fallback swaps endpoint, re-pull active set / soft params without refresh
  watch(
    () => chainStore.endpoint?.address,
    (addr, prev) => {
      if (!isGno.value || !addr || addr === prev) return;
      // Don't clear rows — just refresh; progressive will repaint
      fetchGnoValidators({ silent: !!gnoValidators.value.length });
      const rpc = chainStore.rpc as any;
      if (rpc?.getSlashingParams) {
        rpc
          .getSlashingParams()
          .then((res: any) => {
            slashing.value = res.params;
          })
          .catch(() => undefined);
      }
    }
  );
  // Near-realtime: poll every 45s while this page is open.
  // Fetch is fully silent (no progressive paint, no loading spinner). Toast
  // only fires on real set changes (new pending / activated / inactivated).
  if (isGno.value) {
    gnoPollTimer = setInterval(() => {
      fetchGnoValidators({ silent: true });
      fetchGnoUptime();
    }, 45_000);
  }
  // Start poller when isGno flips true after mount (chain switch / late engine)
  watch(isGno, (gno) => {
    if (gno && !gnoPollTimer) {
      fetchGnoValidators();
      fetchGnoUptime();
      gnoPollTimer = setInterval(() => {
        fetchGnoValidators({ silent: true });
        fetchGnoUptime();
      }, 45_000);
    }
  });
  // Visibility resume: re-pull when user returns to the tab (catch registrations
  // that landed while backgrounded — no hard refresh). Debounced so rapid
  // tab switches don't stack progressive-less fetches.
  if (typeof document !== 'undefined') {
    let visCooldown = 0;
    const onVis = () => {
      if (document.visibilityState !== 'visible' || !isGno.value) return;
      const now = Date.now();
      if (now - visCooldown < 15_000) return;
      visCooldown = now;
      fetchGnoValidators({ silent: true });
    };
    document.addEventListener('visibilitychange', onVis);
    onUnmounted(() => document.removeEventListener('visibilitychange', onVis));
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
      x?.validators?.forEach((v: any) => {
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
      x?.validators?.forEach((v: any) => {
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
      .sort(compareGnoValidators)
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
            <span v-if="gnoLoading && !gnoValidators.length" class="opacity-60"> · loading…</span>
            <span v-else-if="gnoError" class="text-amber-500"> · {{ gnoError }}</span>
          </template>
          <template v-else-if="isGno && gnoLoading">
            · loading from indexer…
          </template>
          <template v-else-if="isGno && gnoError">
            · <span class="text-amber-500">{{ gnoError }}</span>
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
    <div
      v-if="isGno"
      class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-base-content/10 bg-base-200/40 px-4 py-3"
    >
      <div class="flex items-start gap-3">
        <Icon icon="mdi:information-outline" class="mt-0.5 shrink-0 text-primary" />
        <div>
          <div class="text-[12px] font-semibold text-base-content">Uptime rolling window</div>
          <div class="mt-0.5 text-[11.5px] text-secondary">
            Uptime is calculated from the last {{ gnoUptimeWindow.toLocaleString() }} blocks. Each missed block lowers the percentage.
          </div>
        </div>
      </div>
      <span class="sz-chip sz-chip--info font-mono !text-[10px]">{{ gnoUptimeWindow.toLocaleString() }} BLOCKS</span>
    </div>
    <div class="sz-section mt-4 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="sz-table">
          <thead>
            <tr>
              <th style="width: 3.5rem">{{ $t('staking.rank') }}</th>
              <th>{{ $t('staking.validator') }}</th>
              <th class="text-right">{{ $t('staking.voting_power') }}</th>
              <th v-if="isGno" class="text-right">Uptime</th>
              <th v-if="!isGno" class="text-right">{{ $t('staking.24h_changes') }}</th>
              <th class="text-right">{{ isGno ? $t('staking.status') : $t('staking.commission') }}</th>
              <th v-if="!isGno" class="text-center">{{ $t('staking.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="isGno && gnoLoading && !gnoValidators.length">
              <td :colspan="isGno ? 6 : 6" class="py-10 text-center text-[12.5px] text-secondary">
                Loading validators from indexer…
              </td>
            </tr>
            <tr v-else-if="isGno && gnoError && !gnoValidators.length">
              <td :colspan="isGno ? 6 : 6" class="py-10 text-center text-[12.5px] text-error">
                {{ gnoError }}
              </td>
            </tr>
            <tr v-else-if="!list.length">
              <td :colspan="isGno ? 6 : 6" class="py-10 text-center text-[12.5px] text-secondary">
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
              <!-- uptime (Gno collector) -->
              <td v-if="gno" class="text-right font-mono text-[12px]">
                <span
                  :class="{
                    'text-success': gno.status === 'ACTIVE',
                    'text-error': gno.status === 'INACTIVE',
                    'text-warning': gno.status === 'PENDING',
                  }"
                  :title="uptimeFor(gno)?.reason || ''"
                >{{ uptimeLabel(gno) }}</span>
              </td>
              <!-- 24h change (Cosmos only) -->
              <td v-if="!gno" class="text-right font-mono text-[12px]" :class="change24Color(v)">
                {{ change24Text(v) || '—' }}
              </td>
              <!-- status / uptime (Gno) or commission (Cosmos) -->
              <td class="text-right font-mono text-[12px]">
                <template v-if="gno">
                  <div class="flex flex-col items-end gap-1">
                    <span
                      class="sz-chip !text-[10px]"
                      :class="{
                        'sz-chip--good': gno.status === 'ACTIVE',
                        'sz-chip--bad': gno.status === 'INACTIVE',
                        'sz-chip--warn': gno.status === 'PENDING',
                      }"
                    >{{ gno.status }}</span>
                  </div>
                </template>
                <template v-else>{{ format.formatCommissionRate(v.commission?.commission_rates?.rate) }}</template>
              </td>
              <!-- actions (Cosmos only — Gno has no height column) -->
              <td v-if="!isGno" class="text-center">
                <span v-if="v.jailed" class="sz-chip sz-chip--bad">{{ $t('staking.jailed') }}</span>
                <button
                  v-else
                  type="button"
                  class="btn btn-xs btn-primary rounded-md capitalize"
                  @click="dialog.open('delegate', { validator_address: v.operator_address })"
                >
                  {{ $t('account.btn_delegate') }}
                </button>
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
