#!/usr/bin/env node
/**
 * refresh-gno-valopers.mjs — Auto-refresh Gnoland valoper registry from official realm.
 *
 * Writes:
 *   1) public/data/gno-valopers.json   (runtime, gitignored — cron only, NO commit)
 *   2) src/libs/gno/valopers-data.ts   (bundled for Vercel SPA; identity committed so
 *      live logos work — Vercel can't serve the gitignored JSON)
 *
 * Identity enrichment (Keybase logos), priority high→low:
 *   0. Manual overrides  src/libs/gno/identity-overrides.json  (operator-controlled)
 *   1. Exact moniker match vs AtomOne mainnet
 *   2. Normalize-exact (strip emoji/decor)
 *   3. Prefix / contains (shorter≥60% longer, UNIQUE identity only)
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
const OVERRIDE_FILE = join(ROOT, 'src', 'libs', 'gno', 'identity-overrides.json');

const UA = 'ShazoesExplorer/1.0 (valoper-refresh)';
const DELAY_MS = 250; // was 150 — softer on gnoweb rate limits
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

// --- detail page (full valoper profile from <md-renderer>) ---
/** Decode Cloudflare email-protection hex (data-cfemail). */
function decodeCfEmail(hex) {
  try {
    if (!hex || hex.length < 4) return '';
    const r = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ r);
    }
    return out.includes('@') ? out : '';
  } catch {
    return '';
  }
}

/**
 * Parse a single valoper detail HTML page into a rich profile.
 * Source: https://topaz.testnets.gno.land/r/gnops/valopers:<operator>
 * Layout is markdown-rendered inside <md-renderer class="c-realm-view">.
 */
async function fetchDetail(operatorAddress) {
  const html = await get(`${BASE}:${operatorAddress}`);

  // Prefer the md-renderer body (clean profile), fall back to whole page
  const mdMatch = html.match(/<md-renderer[^>]*>([\s\S]*?)<\/md-renderer>/i);
  const body = mdMatch ? mdMatch[1] : html;

  // Strip scripts/styles/svg icons, keep structure for label parsing
  let clean = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  // Plain-text extraction — strip tags, keep line structure
  const text = clean
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi, ' $1 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#160;/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n');

  // Cloudflare-protected email
  let email = '';
  const cf = clean.match(/data-cfemail=["']([0-9a-fA-F]+)["']/);
  if (cf) email = decodeCfEmail(cf[1]);
  if (!email) {
    const em = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (em && !/newtendermint|example\.com/i.test(em[0])) email = em[0];
  }

  // Line-oriented labeled field pickup (bare URLs; no <a href> required)
  function pickLabeled(lineRe) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      const m = t.match(lineRe);
      if (m && m[1]) return m[1].replace(/[),.;]+$/, "").trim();
    }
    return '';
  }
  let website = pickLabeled(/^Website\s*:\s*(https?:\/\/\S+)/i);
  let twitter = pickLabeled(/^(?:X\s*\(?Twitter\)?|Twitter)\s*:\s*(https?:\/\/\S+)/i);
  let github = pickLabeled(/^GitHub\s*:\s*(https?:\/\/\S+)/i);
  let telegram = pickLabeled(/^Telegram\s*:\s*(https?:\/\/\S+)/i);
  let discord = '';
  {
    const dUrl = pickLabeled(/^Discord(?:\s*Username)?\s*:\s*(https?:\/\/\S+)/i);
    if (dUrl) discord = dUrl;
    else {
      const dName = pickLabeled(/^Discord(?:\s*Username)?\s*:\s*([^\s].{0,39})$/i);
      if (dName && !/^g1/i.test(dName) && !/^https?:/i.test(dName)) discord = dName;
    }
  }

  // Label may be followed by a /u/<addr> profile path before the bare g1/gpub.
  const signMatch = text.match(/Signing Address[\s\S]{0,120}?\b(g1[a-z0-9]{38,45})\b/i);
  const opMatch = text.match(/Operator Address[\s\S]{0,120}?\b(g1[a-z0-9]{38,45})\b/i);
  const pubMatch = text.match(/Signing PubKey[\s\S]{0,80}?\b(gpub1[a-z0-9]+)\b/i);
  const serverMatch = text.match(/Server Type[:\s]+(cloud|on-prem|data-center|bare-?metal|vps|dedicated)/i);

  // Description: bio + optional Why / Contributions narrative (full structured text for UI).
  // Cap total length; UI collapses with read-more.
  let description = '';
  {
    const chunks = [];
    const afterName = text.split(/Validator Name[:\s]+[^\n]+/i)[1] || text;
    const bioBody = afterName.split(
      /Networks (?:You|We) Are Currently Validating|Links to (?:Your|Our) Digital Presence|Contact Details|Why (?:You Are|We're|We Are) Interested|Operator Address|Total AuM/i
    )[0];
    const bioParas = bioBody
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 20 &&
          !/^(Valoper|Validator Name|g1|Profile|On this page|Infra\s*&)/i.test(l) &&
          !/^https?:\/\//i.test(l)
      );
    if (bioParas.length) {
      const sorted = [...bioParas].sort((a, b) => b.length - a.length);
      chunks.push(sorted[0].slice(0, 800));
    }
    const whySec = text.split(/Why (?:You Are|We're|We Are) Interested[^:]*:\s*/i)[1] || '';
    const whyBody = whySec.split(
      /Contributions|Operator Address|Signing Address|Server Type|Services Already/i
    )[0]
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 30 && !/^https?:\/\//i.test(l));
    if (whyBody.length) {
      chunks.push('Why gno.land: ' + whyBody.slice(0, 3).join(' ').slice(0, 600));
    }
    const contribSec = text.split(/Contributions[^:]*:\s*/i)[1] || '';
    const contribBody = contribSec.split(
      /Operator Address|Signing Address|Server Type|Profile link/i
    )[0]
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 5 && !/^g1|^gpub/i.test(l));
    if (contribBody.length) {
      chunks.push('Contributions: ' + contribBody.slice(0, 8).join(' · ').slice(0, 600));
    }
    description = chunks.join('\n\n').slice(0, 1800);
  }

  // Networks list — accept "You" or "We", and "Name (TICKER)" lines
  const networks = [];
  {
    const netSec =
      text.split(/Networks (?:You|We) Are Currently Validating[:\s]*/i)[1] || '';
    const netBody = netSec.split(
      /Links to (?:Your|Our) Digital Presence|Contact Details|Why (?:You Are|We're|We Are)|Operator Address|Contributions|Total AuM/i
    )[0];
    for (const line of netBody.split(/\n+/)) {
      let t = line.trim().replace(/^[-*•]\s*/, '');
      // Drop trailing "full list" junk on same line
      t = t.replace(/\s*[—-]\s*.*$/, '').replace(/\s+https?:\/\/\S+.*$/, '').trim();
      if (!t || t.length < 2 || t.length > 80) continue;
      if (/^(And Other|Mainnets|Testnets|http|30\+|Total AuM)/i.test(t)) continue;
      if (/^g1|^gpub/i.test(t)) continue;
      if (/full list/i.test(t)) continue;
      networks.push(t);
      if (networks.length >= 30) break;
    }
  }

  // Discord username (plain text, not always a link)
  let discordName = '';
  {
    const dm = text.match(/Discord(?:\s*Username)?[:\s]+([^\n]{2,40})/i);
    if (dm) {
      const raw = dm[1].trim().replace(/^https?:\/\/\S+/i, '').trim();
      if (raw && !/^g1/i.test(raw) && raw.length < 40) discordName = raw;
    }
  }

  return {
    signingAddress: signMatch ? signMatch[1] : '',
    operatorAddressDetail: opMatch ? opMatch[1] : '',
    pubKey: pubMatch ? pubMatch[1] : '',
    serverType: serverMatch ? serverMatch[1].toLowerCase().replace(/baremetal/, 'bare-metal') : '',
    description,
    website,
    twitter,
    github,
    telegram,
    discord: discord || discordName,
    email,
    networks,
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
        pubKey: detail.pubKey || prev.pubKey || '',
        twitter: detail.twitter || prev.twitter || '',
        github: detail.github || prev.github || '',
        telegram: detail.telegram || prev.telegram || '',
        discord: detail.discord || prev.discord || '',
        email: detail.email || prev.email || '',
        networks: (detail.networks && detail.networks.length)
          ? detail.networks
          : (prev.networks || []),
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
        pubKey: prev.pubKey || '',
        twitter: prev.twitter || '',
        github: prev.github || '',
        telegram: prev.telegram || '',
        discord: prev.discord || '',
        email: prev.email || '',
        networks: prev.networks || [],
      });
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  detail ${i + 1}/${ops.length}`);
      await sleep(DELAY_MS);
    }
  }

  // --- Manual identity overrides (highest priority) ---
  // Keys may be moniker OR g1 operatorAddress OR g1 signingAddress.
  // Lookup order when applying: operator → signing → moniker
  // (addresses are stable; moniker is mutable).
  let overrideByMoniker = new Map(); // monikerLower → identity
  let overrideByOperator = new Map(); // operatorAddress → identity
  let overrideBySigning = new Map(); // signingAddress → identity
  try {
    if (existsSync(OVERRIDE_FILE)) {
      const raw = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8'));
      const ov = raw.overrides || {};
      for (const [key, val] of Object.entries(ov)) {
        if (!key || !val) continue;
        // Support both "identity-string" and { identity: "..." } forms
        const id =
          typeof val === 'string'
            ? val.trim()
            : typeof val === 'object' && val.identity
              ? String(val.identity).trim()
              : '';
        if (!id) continue;
        const k = key.trim();
        if (/^g1[a-z0-9]{38,}$/i.test(k)) {
          // g1 address — could be operator or signing; index both
          overrideByOperator.set(k.toLowerCase(), id);
          overrideBySigning.set(k.toLowerCase(), id);
        } else {
          overrideByMoniker.set(k.toLowerCase(), id);
        }
        // Structured form may also pin operator/signing explicitly
        if (typeof val === 'object') {
          if (val.operator) overrideByOperator.set(String(val.operator).toLowerCase(), id);
          if (val.signing) overrideBySigning.set(String(val.signing).toLowerCase(), id);
          if (val.moniker) overrideByMoniker.set(String(val.moniker).toLowerCase(), id);
        }
      }
      const total =
        overrideByMoniker.size + overrideByOperator.size + overrideBySigning.size;
      if (total > 0) {
        console.log(
          `Loaded overrides: ${overrideByMoniker.size} moniker, ${overrideByOperator.size} operator/signing keys`
        );
      }
    }
  } catch (e) {
    console.warn(`  Override file load failed: ${e.message || e}`);
  }

  function resolveOverride(r) {
    const op = (r.operatorAddress || '').toLowerCase();
    const sig = (r.signingAddress || '').toLowerCase();
    const mon = (r.moniker || '').toLowerCase();
    if (op && overrideByOperator.has(op)) return overrideByOperator.get(op);
    if (sig && overrideBySigning.has(sig)) return overrideBySigning.get(sig);
    if (mon && overrideByMoniker.has(mon)) return overrideByMoniker.get(mon);
    return null;
  }

  // Apply overrides FIRST (before AtomOne enrich)
  {
    let applied = 0;
    for (const r of rows) {
      const id = resolveOverride(r);
      if (id) {
        r.identity = id;
        applied++;
      }
    }
    if (applied > 0) console.log(`  Manual overrides applied: ${applied}`);
  }

  // --- AtomOne moniker → Keybase identity enrichment ---
  if (!skipAtomone) {
    console.log('Enriching identity from AtomOne mainnet (exact + normalize + contains)…');
    try {
      const { exactMap, normMap } = await fetchAtomoneIdentityMap();
      let hit = 0;
      let kept = 0;
      for (const r of rows) {
        // Skip if already has manual override (any key type) — immutable pin
        if (resolveOverride(r)) {
          kept++;
          continue;
        }

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

  // FINAL PIN: manual overrides always win — re-apply after AtomOne so nothing
  // can overwrite operator/signing/moniker pins (highest priority, immutable).
  {
    let pinned = 0;
    for (const r of rows) {
      const id = resolveOverride(r);
      if (!id) continue;
      r.identity = id;
      pinned++;
    }
    if (pinned > 0) console.log(`  Manual overrides final-pin: ${pinned} rows locked`);
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
  pubKey?: string;
  twitter?: string;
  github?: string;
  telegram?: string;
  discord?: string;
  email?: string;
  networks?: string[];
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
