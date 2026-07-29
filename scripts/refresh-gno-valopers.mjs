#!/usr/bin/env node
/**
 * refresh-gno-valopers.mjs — Auto-refresh Gnoland valoper registry from official realm.
 *
 * Writes:
 *   1) public/data/gno-valopers.json   (runtime, gitignored — cron only, NO commit)
 *   2) src/libs/gno/valopers-data.ts   (bundled for Vercel SPA; identity committed so
 *      live logos work — Vercel can't serve the gitignored JSON)
 *
 * Identity enrichment (Keybase logos):
 *   Gno valopers have empty identity. Match moniker (case-insensitive exact)
 *   against AtomOne mainnet validators and copy their Keybase identity.
 *   Existing avatar pipeline (keybase() → S3 → localStorage) then shows logos.
 *
 * Usage: node scripts/refresh-gno-valopers.mjs [--chain gnoland-testnet]
 * Exit 0 = success. Exit 1 = error.
 *
 * Rate: safe at any interval ≥ 5 min. Normal run = 2 GETs (list pages).
 * Detail fetches only on change (~100 GETs, ~2 min, polite 150ms delay).
 * AtomOne enrich = 1 paginated LCD pull (no Keybase hit here — browser does that).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'public', 'data');
const OUTPUT_FILE = join(OUTPUT_DIR, 'gno-valopers.json');
const BUNDLE_FILE = join(ROOT, 'src', 'libs', 'gno', 'valopers-data.ts');

const UA = 'ShazoesExplorer/1.0 (valoper-refresh)';
const DELAY_MS = 150;
const MAX_PAGES = 10;

// AtomOne mainnet LCD — source of Keybase identities for moniker-matched Gno vals.
// Prefer allinbits (official), fall back to cogwheel / nodeshub.
const ATOMONE_LCDS = [
  'https://atomone-api.allinbits.com',
  'https://atomone-api.cogwheel.zone',
  'https://atomone.api.nodeshub.online',
];

// --- args ---
const args = process.argv.slice(2);
const chainArg = args.includes('--chain') ? args[args.indexOf('--chain') + 1] : 'gnoland-testnet';
const skipAtomone = args.includes('--skip-atomone');
const skipBundle = args.includes('--skip-bundle');

function findChainConfig(name) {
  for (const dir of ['chains/testnet', 'chains/mainnet']) {
    const p = join(ROOT, dir, `${name}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
  }
  throw new Error(`Chain config not found: ${name}`);
}

const config = findChainConfig(chainArg);
const vs = config.valopers_source;
if (!vs || vs.type !== 'gno-realm') {
  console.log(`SKIP: ${chainArg} has no gno-realm valopers_source`);
  process.exit(0);
}
const BASE = vs.base_url.replace(/\/$/, '');
console.log(`Chain: ${chainArg} | Source: ${BASE} | Output: ${OUTPUT_FILE}`);

// --- fetch helper ---
async function get(url, accept = 'text/html') {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- list pages ---
async function fetchListPages() {
  const ops = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await get(`${BASE}?page=${page}`);
    const re = /href="\/r\/gnops\/valopers:(g1[a-z0-9]+)"[^>]*>\s*([^<]+?)\s*<\/a>/gi;
    let m;
    let newCount = 0;
    while ((m = re.exec(html)) !== null) {
      const moniker = m[2].trim();
      if (moniker && moniker.toLowerCase() !== 'profile') {
        ops.push({ operatorAddress: m[1], moniker });
        newCount++;
      }
    }
    console.log(`  list page ${page}: ${newCount} entries`);
    if (newCount === 0) break;
    await sleep(DELAY_MS);
  }
  return ops;
}

// --- detail page ---
async function fetchDetail(operatorAddress) {
  const html = await get(`${BASE}:${operatorAddress}`);
  const signMatch = html.match(/Signing Address:[\s\S]{0,200}?(g1[a-z0-9]{38,45})/i);
  const serverMatch = html.match(/Server Type:[\s\S]{0,100}?(cloud|on-prem|data-center)/i);
  const text = html.replace(/<[^>]+>/g, '\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 20);
  const descCands = lines.filter(
    (l) => !/^(Operator|Signing|Server|Moniker|Website|Description|g1|gpub)/i.test(l)
  );
  const description = descCands.length
    ? descCands.reduce((a, b) => (b.length > a.length ? b : a)).slice(0, 200)
    : '';
  const wsMatch = description.match(/https?:\/\/[^\s]+/);
  return {
    signingAddress: signMatch ? signMatch[1] : '',
    serverType: serverMatch ? serverMatch[1] : '',
    description,
    website: wsMatch ? wsMatch[0] : '',
  };
}

/**
 * Pull AtomOne mainnet validators → Map monikerLower → Keybase identity.
 * Exact case-insensitive moniker match only (no fuzzy) to avoid false logos.
 */

// --- moniker normalization (strip emoji/decor, lower, collapse spaces) ---
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1FA00}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{2640}-\u{2642}]+/gu;
const DECOR_RE = /[\s★☆✦✧•·|[\]{}()<>«»◆◇■□●○✓✔✕✖♥♡™®©]+/g;

function normalizeMoniker(s) {
  return (s || '')
    .replace(EMOJI_RE, '')
    .replace(DECOR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function fetchAtomoneIdentityMap() {
  let lastErr;
  for (const lcd of ATOMONE_LCDS) {
    try {
      const map = new Map(); // monikerLower → { moniker, identity }
      const normMap = new Map(); // normalized moniker → { moniker, identity }
      let key = null;
      let pages = 0;
      do {
        let url = `${lcd}/cosmos/staking/v1beta1/validators?pagination.limit=200&status=BOND_STATUS_BONDED`;
        // Also pull unbonding/unbonded so Roomit/Provalidator (if unbonded on AtomOne) still match
        // We pull ALL statuses via three calls is wasteful — instead omit status filter.
        url = `${lcd}/cosmos/staking/v1beta1/validators?pagination.limit=200`;
        if (key) url += `&pagination.key=${encodeURIComponent(key)}`;
        const data = await getJson(url);
        for (const v of data.validators || []) {
          const mon = (v.description?.moniker || '').trim();
          const id = (v.description?.identity || '').trim();
          if (!mon || !id) continue;
          // Prefer first hit; Keybase identities rarely differ across statuses of same moniker
          const k = mon.toLowerCase();
          if (!map.has(k)) map.set(k, { moniker: mon, identity: id });
          // normalized key (strip emoji/decor)
          const nk = normalizeMoniker(mon);
          if (nk && !normMap.has(nk)) normMap.set(nk, { moniker: mon, identity: id });
        }
        key = data.pagination?.next_key || null;
        pages++;
        if (pages > 20) break;
        if (key) await sleep(100);
      } while (key);
      console.log(`  AtomOne LCD ${lcd}: ${map.size} monikers with identity`);
      return { exactMap: map, normMap };
    } catch (e) {
      lastErr = e;
      console.warn(`  AtomOne LCD fail ${lcd}: ${e.message || e}`);
    }
  }
  throw lastErr || new Error('all AtomOne LCDs failed');
}

// --- build registry ---
async function buildRegistry() {
  const ops = await fetchListPages();
  console.log(`Total operators from list: ${ops.length}`);

  // Load previous JSON so we can keep signingAddress/identity when detail fetch fails
  // and so re-runs don't wipe AtomOne identities on transient errors.
  let prevByOp = new Map();
  try {
    if (existsSync(OUTPUT_FILE)) {
      const prev = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
      for (const r of prev) {
        if (r.operatorAddress) prevByOp.set(r.operatorAddress, r);
      }
    }
  } catch {
    /* ignore */
  }

  const rows = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const prev = prevByOp.get(op.operatorAddress) || {};
    try {
      const detail = await fetchDetail(op.operatorAddress);
      rows.push({
        moniker: op.moniker,
        signingAddress: detail.signingAddress || prev.signingAddress || '',
        operatorAddress: op.operatorAddress,
        website: detail.website || prev.website || '',
        // identity filled later from AtomOne; keep prev so re-run without --skip keeps it
        identity: prev.identity || '',
        serverType: detail.serverType || prev.serverType || '',
        description: detail.description || prev.description || '',
      });
    } catch (e) {
      rows.push({
        moniker: op.moniker,
        signingAddress: prev.signingAddress || '',
        operatorAddress: op.operatorAddress,
        website: prev.website || '',
        identity: prev.identity || '',
        serverType: prev.serverType || '',
        description: prev.description || '',
      });
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  detail ${i + 1}/${ops.length}`);
      await sleep(DELAY_MS);
    }
  }

  // --- AtomOne moniker → Keybase identity enrichment ---
  if (!skipAtomone) {
    console.log('Enriching identity from AtomOne mainnet (exact + normalize + contains)…');
    try {
      const { exactMap, normMap } = await fetchAtomoneIdentityMap();
      let hit = 0;
      let kept = 0;
      for (const r of rows) {
        const mon = r.moniker || '';
        const monLower = mon.toLowerCase();
        const monNorm = normalizeMoniker(mon);

        // Tier 1: exact (existing)
        let hitRow = exactMap.get(monLower);

        // Tier 2: normalize-exact (strip emoji/decor)
        if (!hitRow?.identity && monNorm) {
          hitRow = normMap.get(monNorm);
        }

        // Tier 3: prefix OR contains (shorter ≥60% of longer), UNIQUE identity only.
        // Prefix covers "Nodeist" ← "Nodeist 🛡️ Slash Protected" (ratio would be 7/23 < 0.6).
        // Contains+ratio covers "AviaOne" ← "AVIAONE.com 🟢".
        // UNIQUE identity rejects ambiguous collisions (no fuzzy).
        if (!hitRow?.identity && monNorm && monNorm.length >= 4) {
          const cands = [];
          for (const [nk, val] of normMap) {
            if (!nk || nk.length < 4) continue;
            const a = Math.min(monNorm.length, nk.length);
            const b = Math.max(monNorm.length, nk.length);
            const isPrefix = nk.startsWith(monNorm) || monNorm.startsWith(nk);
            const isContains =
              (monNorm.includes(nk) || nk.includes(monNorm)) && a / b >= 0.6;
            if (isPrefix || isContains) cands.push(val);
          }
          const ids = new Set(cands.map((c) => c.identity));
          if (ids.size === 1) {
            hitRow = cands[0];
          }
        }

        if (hitRow?.identity) {
          if (r.identity !== hitRow.identity) {
            r.identity = hitRow.identity;
            hit++;
          } else {
            kept++;
          }
        }
      }
      console.log(`  AtomOne match: ${hit} new/updated, ${kept} already set, ${rows.filter((r) => r.identity).length} total with identity`);
    } catch (e) {
      console.warn(`  AtomOne enrich SKIPPED: ${e.message || e}`);
    }
  } else {
    console.log('AtomOne enrich skipped (--skip-atomone)');
  }

  rows.sort((a, b) => a.moniker.localeCompare(b.moniker, 'en', { sensitivity: 'base' }));
  return rows;
}

function writeBundle(rows) {
  const header = `/** Auto-generated Gnoland valoper moniker registry.
 * Source: ${BASE}
 * Identity: AtomOne mainnet moniker match → Keybase (for logos)
 * Generated: ${new Date().toISOString()}
 * Do not hand-edit — run: node scripts/refresh-gno-valopers.mjs
 */
export interface GnoValoperRow {
  moniker: string;
  signingAddress: string;
  operatorAddress: string;
  website?: string;
  identity?: string;
  serverType?: string;
  description?: string;
}

const registry: GnoValoperRow[] = `;
  const body = JSON.stringify(rows, null, 2);
  const footer = `;\n\nexport default registry;\n`;
  writeFileSync(BUNDLE_FILE, header + body + footer);
  console.log(`UPDATED ${BUNDLE_FILE} (${rows.length} valopers, ${rows.filter((r) => r.identity).length} with identity)`);
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const data = await buildRegistry();
  const json = JSON.stringify(data, null, 2);
  writeFileSync(OUTPUT_FILE, json);
  console.log(
    `UPDATED ${OUTPUT_FILE} (${data.length} valopers, ${data.filter((r) => r.identity).length} with identity) [gitignored — no commit]`
  );
  if (!skipBundle) {
    writeBundle(data);
  } else {
    console.log('Bundle write skipped (--skip-bundle)');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
