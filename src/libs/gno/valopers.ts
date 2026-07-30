/**
 * Gnoland valoper registry — bundled seed + live JSON refresh.
 *
 * Identity model:
 *   - operatorAddress = stable registration id (almost never changes)
 *   - signingAddress / pubkey = mutable (UpdateSigningKey)
 *   - moniker / description = mutable (UpdateDescription)
 *
 * Logo / Keybase identity priority (highest → lowest):
 *   0. Manual pin  identity-overrides.json  (operator > signing > moniker)
 *      — applied at cron into live JSON; also re-applied client-side so a pin
 *        cannot be wiped by a stale live row or AtomOne auto-match
 *   1. Live JSON identity field (cron: overrides → AtomOne enrich → final pin)
 *   2. Bundled valopers-data.ts seed
 *
 * Live source (preferred, no git/deploy):
 *   https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json
 */
import staticRegistry from './valopers-data';
import type { GnoValoperRow } from './valopers-data';
import overrideFile from './identity-overrides.json';

export type GnoValoper = GnoValoperRow;

const bySigning = new Map<string, GnoValoper>();
const byOperator = new Map<string, GnoValoper>();

/** operator / signing / monikerLower → Keybase identity (16 hex). */
const overrideByOperator = new Map<string, string>();
const overrideBySigning = new Map<string, string>();
const overrideByMoniker = new Map<string, string>();

function loadOverridesFromJson(raw: unknown) {
  overrideByOperator.clear();
  overrideBySigning.clear();
  overrideByMoniker.clear();
  const ov =
    raw && typeof raw === 'object' && (raw as { overrides?: Record<string, unknown> }).overrides
      ? (raw as { overrides: Record<string, unknown> }).overrides
      : {};
  for (const [key, val] of Object.entries(ov || {})) {
    if (!key || val == null) continue;
    const id =
      typeof val === 'string'
        ? val.trim()
        : typeof val === 'object' && val && (val as { identity?: string }).identity
          ? String((val as { identity: string }).identity).trim()
          : '';
    if (!id) continue;
    const k = key.trim();
    if (/^g1[a-z0-9]{38,}$/i.test(k)) {
      overrideByOperator.set(k.toLowerCase(), id);
      overrideBySigning.set(k.toLowerCase(), id);
    } else {
      overrideByMoniker.set(k.toLowerCase(), id);
    }
    if (typeof val === 'object' && val) {
      const o = val as { operator?: string; signing?: string; moniker?: string };
      if (o.operator) overrideByOperator.set(String(o.operator).toLowerCase(), id);
      if (o.signing) overrideBySigning.set(String(o.signing).toLowerCase(), id);
      if (o.moniker) overrideByMoniker.set(String(o.moniker).toLowerCase(), id);
    }
  }
}

loadOverridesFromJson(overrideFile);

/** Resolve manual Keybase pin — operator > signing > moniker. Never auto-cleared. */
export function resolveIdentityOverride(row: {
  operatorAddress?: string;
  signingAddress?: string;
  moniker?: string;
}): string | undefined {
  const op = (row.operatorAddress || '').toLowerCase();
  const sig = (row.signingAddress || '').toLowerCase();
  const mon = (row.moniker || '').toLowerCase();
  if (op && overrideByOperator.has(op)) return overrideByOperator.get(op);
  if (sig && overrideBySigning.has(sig)) return overrideBySigning.get(sig);
  if (mon && overrideByMoniker.has(mon)) return overrideByMoniker.get(mon);
  return undefined;
}

function pinIdentity(row: GnoValoperRow): GnoValoperRow {
  const pinned = resolveIdentityOverride(row);
  if (!pinned) return row;
  if (row.identity === pinned) return row;
  return { ...row, identity: pinned };
}

/** Default public URL on our Gno RPC vhost (same server as cron). */
export const DEFAULT_GNO_VALOPERS_LIVE_URL =
  'https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json';

// Seed with static data (instant, bundled) + apply pins
for (const row of staticRegistry) {
  applyRow(pinIdentity(row as GnoValoperRow));
}

/** Normalize g1 bech32 map keys (case-insensitive). Non-g1 keys kept as-is. */
function addrKey(a?: string): string {
  const s = String(a || '').trim();
  if (!s) return '';
  return /^g1[a-z0-9]+$/i.test(s) ? s.toLowerCase() : s;
}

function applyRow(row: GnoValoperRow): boolean {
  if (!row.signingAddress && !row.operatorAddress) return false;
  row = pinIdentity(row);

  const opKey = addrKey(row.operatorAddress);
  const sigKey = addrKey(row.signingAddress);

  // Rebind on UpdateSigningKey: drop stale signing→row links for this operator.
  if (opKey) {
    const prev = byOperator.get(opKey);
    if (prev?.signingAddress && addrKey(prev.signingAddress) !== sigKey) {
      const prevSig = addrKey(prev.signingAddress);
      const mapped = bySigning.get(prevSig);
      if (mapped && addrKey(mapped.operatorAddress) === opKey) {
        bySigning.delete(prevSig);
      }
    }
  }

  let changed = false;
  if (sigKey) {
    const existing = bySigning.get(sigKey);
    if (
      !existing ||
      existing.moniker !== row.moniker ||
      existing.operatorAddress !== row.operatorAddress ||
      existing.identity !== row.identity ||
      existing.website !== row.website
    ) {
      changed = true;
    }
    bySigning.set(sigKey, row);
  }
  if (opKey) {
    const existing = byOperator.get(opKey);
    if (
      !existing ||
      existing.moniker !== row.moniker ||
      existing.signingAddress !== row.signingAddress ||
      existing.identity !== row.identity
    ) {
      changed = true;
    }
    byOperator.set(opKey, row);
  }
  return changed;
}

function candidateUrls(explicit?: string): string[] {
  const out: string[] = [];
  const add = (u?: string) => {
    if (!u || out.includes(u)) return;
    out.push(u);
  };
  add(explicit);
  add(DEFAULT_GNO_VALOPERS_LIVE_URL);
  add('/data/gno-valopers.json');
  return out;
}

/** AbortController timeout — works where AbortSignal.timeout is missing. */
function abortAfter(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchRows(url: string): Promise<GnoValoperRow[] | null> {
  const join = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${join}t=${Date.now()}`, {
    signal: abortAfter(8000),
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return null;
  const data = await res.json();
  if (Array.isArray(data)) return data as GnoValoperRow[];
  if (data && Array.isArray(data.valopers)) return data.valopers as GnoValoperRow[];
  if (data && Array.isArray(data.items)) return data.items as GnoValoperRow[];
  return null;
}

// ---- Live fetch gate (keep valopers_live_url on Shazoes /static) ----
// When the static host is down, do NOT hammer it every page mount. Remember
// chain tip height at failure; only retry after tip has advanced past that.
// Bundled seed (+ last successful in-memory maps) keep monikers working.

const VALOPERS_GATE_KEY = 'gno-valopers-fetch-gate';

type ValopersGate = {
  /** tip height observed when live JSON last failed (per URL) */
  byUrl: Record<string, { downAtHeight: number; failedAt: number }>;
};

function readGate(): ValopersGate {
  try {
    const raw = localStorage.getItem(VALOPERS_GATE_KEY);
    if (!raw) return { byUrl: {} };
    const p = JSON.parse(raw);
    return { byUrl: p?.byUrl && typeof p.byUrl === 'object' ? p.byUrl : {} };
  } catch {
    return { byUrl: {} };
  }
}

function writeGate(g: ValopersGate) {
  try {
    localStorage.setItem(VALOPERS_GATE_KEY, JSON.stringify(g));
  } catch {
    /* quota */
  }
}

function markValopersFetchFailed(url: string, tipHeight: number) {
  const g = readGate();
  const prev = g.byUrl[url]?.downAtHeight ?? 0;
  // Keep the highest tip we saw while down so we don't retry on equal/lower
  g.byUrl[url] = {
    downAtHeight: Math.max(prev, tipHeight, 0),
    failedAt: Date.now(),
  };
  writeGate(g);
}

function clearValopersFetchFailed(url: string) {
  const g = readGate();
  if (!g.byUrl[url]) return;
  delete g.byUrl[url];
  writeGate(g);
}

/**
 * Tip height for the host that serves valopers JSON.
 * Same-origin `/data/...` → no remote status (treat as unknown → always try once).
 * Absolute URL → GET `{origin}/status` (TM2 / Cosmos-style).
 */
async function tipHeightNearValopersUrl(url: string): Promise<number | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const origin = new URL(url).origin;
    const res = await fetch(`${origin}/status`, {
      signal: abortAfter(4000),
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    // TM2
    const tm2 = Number(data?.result?.sync_info?.latest_block_height || 0);
    if (tm2 > 0) return tm2;
    // CosmJS / rare shapes
    const lcd = Number(data?.sync_info?.latest_block_height || data?.result?.height || 0);
    return lcd > 0 ? lcd : null;
  } catch {
    return null;
  }
}

/**
 * true → skip live JSON fetch (host still down / tip not advanced).
 * false → attempt fetch.
 */
function shouldSkipValopersFetch(url: string, tipHeight: number | null): boolean {
  const ent = readGate().byUrl[url];
  if (!ent) return false;

  // Absolute host (Shazoes): tip unknown ⇒ still down — don't hammer static.
  // Relative `/data/...`: no origin /status — use short time backoff only.
  if (tipHeight == null || tipHeight <= 0) {
    if (!/^https?:\/\//i.test(url)) {
      return Date.now() - (ent.failedAt || 0) < 60_000;
    }
    return true;
  }
  // Only retry after chain tip moved past the height recorded at failure.
  if (tipHeight <= ent.downAtHeight) {
    return true;
  }
  return false;
}

/**
 * Load live registry. Tries RPC static URL first, then same-origin.
 * Manual identity overrides are re-applied on every row (cannot be changed by live JSON).
 *
 * Gate: on failure, remember tip height; skip re-fetch until tip is higher
 * (Shazoes `/static` stays the only live URL — no multi-host failover).
 */
export function initGnoValopers(chainOrUrl = 'gnoland-testnet', liveUrl?: string): Promise<void> {
  let explicit = liveUrl;
  if (!explicit && /^https?:\/\//i.test(chainOrUrl)) explicit = chainOrUrl;

  return (async () => {
    const urls = candidateUrls(explicit);
    let anyAttempted = false;
    let anySkipped = false;

    for (const url of urls) {
      const tip = await tipHeightNearValopersUrl(url);
      if (shouldSkipValopersFetch(url, tip)) {
        anySkipped = true;
        console.info(
          `[gno-valopers] skip fetch ${url}` +
            (tip != null
              ? ` (tip ${tip} ≤ downAt ${readGate().byUrl[url]?.downAtHeight})`
              : ' (host tip unreachable; waiting for advance)')
        );
        continue;
      }

      anyAttempted = true;
      try {
        const rows = await fetchRows(url);
        if (!rows || !rows.length) {
          // Empty/404 — treat as fail for gate (cron may not have written yet)
          markValopersFetchFailed(url, tip ?? readGate().byUrl[url]?.downAtHeight ?? 0);
          continue;
        }
        let updated = 0;
        for (const row of rows) {
          if (applyRow(row)) updated++;
        }
        clearValopersFetchFailed(url);
        if (updated > 0 || rows.length) {
          console.info(
            `[gno-valopers] live ${rows.length} from ${url} (${updated} fields changed)` +
              (tip != null ? ` tip=${tip}` : '')
          );
        }
        return;
      } catch (e) {
        markValopersFetchFailed(url, tip ?? 0);
        console.warn(`[gno-valopers] fetch failed ${url}:`, (e as any)?.message || e);
      }
    }

    if (anySkipped && !anyAttempted) {
      console.info('[gno-valopers] live fetch gated; using bundled seed / last in-memory maps');
    } else {
      console.warn('[gno-valopers] all live candidates failed; using bundled seed');
    }
  })();
}

/** Test/debug: clear tip-gated skip state (forces next init to attempt live fetch). */
export function resetGnoValopersFetchGate() {
  try {
    localStorage.removeItem(VALOPERS_GATE_KEY);
  } catch {
    /* ignore */
  }
}

export function lookupGnoValoper(address?: string): GnoValoper | undefined {
  if (!address) return undefined;
  const k = addrKey(address);
  const hit = bySigning.get(k) || byOperator.get(k) || bySigning.get(address) || byOperator.get(address);
  if (!hit) return undefined;
  // Always surface pinned identity even if maps were seeded before override edit
  return pinIdentity(hit);
}

export function gnoMoniker(address?: string, fallback?: string): string {
  const hit = lookupGnoValoper(address);
  if (hit?.moniker) return hit.moniker;
  if (fallback) return fallback;
  if (!address) return 'validator';
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-4)}` : address;
}

export function gnoValoperCount() {
  return bySigning.size;
}

/** All known valoper rows (bundled + live). Deduped by operator. */
export function listGnoValopers(): GnoValoper[] {
  const seen = new Set<string>();
  const out: GnoValoper[] = [];
  for (const row of byOperator.values()) {
    const k = row.operatorAddress || row.signingAddress || row.moniker;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(pinIdentity(row));
  }
  for (const row of bySigning.values()) {
    const k = row.operatorAddress || row.signingAddress || row.moniker;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(pinIdentity(row));
  }
  return out;
}

/** gnoweb base from chain config (realms/tokens deep links). */
export function gnoGnowebBase(chain?: any): string {
  const raw = String(chain?.gnoweb || chain?.valopers_source?.base_url || '').replace(/\/r\/gnops\/valopers\/?$/, '');
  if (raw) return raw.replace(/\/$/, '');
  // Last-resort Topaz — only when chain JSON omitted gnoweb
  return 'https://topaz.testnets.gno.land';
}

/** Valopers realm profile URL for an operator. */
export function gnoValoperProfileUrl(operator: string, chain?: any): string {
  const base =
    String(chain?.valopers_source?.base_url || '').replace(/\/$/, '') ||
    `${gnoGnowebBase(chain)}/r/gnops/valopers`;
  return `${base}:${operator}`;
}
