#!/usr/bin/env node
/**
 * refresh-gno-valopers.mjs — Auto-refresh Gnoland valoper registry from official realm.
 *
 * Reads chain config for valopers_source, fetches list pages + detail pages,
 * writes src/libs/gno/valopers-data.ts. Only fetches details for new/changed
 * operators (cached in .cache/gno-valopers-cache.json).
 *
 * Usage: node scripts/refresh-gno-valopers.mjs [--chain gnoland-testnet] [--force]
 * Exit 0 = no change or updated. Exit 1 = error.
 *
 * Rate: safe at any interval ≥ 5 min. Normal run = 2 HTTP GETs (list pages).
 * Detail fetches only on change (~100 GETs, ~2 min, polite 150ms delay).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'gno-valopers-cache.json');

const UA = 'ShazoesExplorer/1.0 (valoper-refresh)';
const DELAY_MS = 150;
const MAX_PAGES = 10;

// --- args ---
const args = process.argv.slice(2);
const chainArg = args.includes('--chain') ? args[args.indexOf('--chain') + 1] : 'gnoland-testnet';
const force = args.includes('--force');

// --- find chain config ---
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
console.log(`Chain: ${chainArg} | Source: ${BASE}`);

// --- fetch helper ---
async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1) list pages ---
async function fetchListPages() {
  const ops = []; // { operatorAddress, moniker }
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

// --- 2) detail page ---
async function fetchDetail(operatorAddress) {
  const html = await get(`${BASE}:${operatorAddress}`);
  const signMatch = html.match(/Signing Address:[\s\S]{0,200}?(g1[a-z0-9]{38,45})/i);
  const serverMatch = html.match(/Server Type:[\s\S]{0,100}?(cloud|on-prem|data-center)/i);
  const pubkeyMatch = html.match(/Signing PubKey:[\s\S]{0,200}?(gpub1[a-z0-9]+)/i);
  // description: longest non-label text line
  const text = html.replace(/<[^>]+>/g, '\n');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 20);
  const descCands = lines.filter(
    (l) => !/^(Operator|Signing|Server|Moniker|Website|Description|g1|gpub)/i.test(l)
  );
  const description = descCands.length ? descCands.reduce((a, b) => (b.length > a.length ? b : a)).slice(0, 200) : '';
  // website from description
  const wsMatch = description.match(/https?:\/\/[^\s]+/);
  return {
    signingAddress: signMatch ? signMatch[1] : '',
    signingPubKey: pubkeyMatch ? pubkeyMatch[1] : '',
    serverType: serverMatch ? serverMatch[1] : '',
    description,
    website: wsMatch ? wsMatch[0] : '',
  };
}

// --- 3) cache ---
function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
function saveCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// --- 4) generate TS ---
function generateTS(rows) {
  const header = `/** Auto-generated Gnoland valoper moniker registry.
 * Source: ${BASE}
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
  return `${header}${body};\n\nexport default registry;\n`;
}

// --- main ---
async function main() {
  const cache = force ? {} : loadCache();
  const listOps = await fetchListPages();
  console.log(`Total operators from list: ${listOps.length}`);

  // Determine which need detail fetch
  const needFetch = [];
  const cached = [];
  for (const op of listOps) {
    const key = op.operatorAddress;
    const cachedEntry = cache[key];
    if (cachedEntry && cachedEntry.moniker === op.moniker && cachedEntry.signingAddress) {
      cached.push(cachedEntry);
    } else {
      needFetch.push(op);
    }
  }

  console.log(`Cached: ${cached.length}, need fetch: ${needFetch.length}`);

  const fetched = [];
  for (let i = 0; i < needFetch.length; i++) {
    const op = needFetch[i];
    try {
      const detail = await fetchDetail(op.operatorAddress);
      const row = {
        moniker: op.moniker,
        signingAddress: detail.signingAddress,
        operatorAddress: op.operatorAddress,
        website: detail.website,
        identity: '',
        serverType: detail.serverType,
        description: detail.description,
      };
      fetched.push(row);
      cache[op.operatorAddress] = row;
      if ((i + 1) % 25 === 0) console.log(`  fetched ${i + 1}/${needFetch.length}`);
    } catch (e) {
      console.error(`  FAIL ${op.moniker} (${op.operatorAddress}): ${e.message}`);
      // keep stale cache entry if exists
      if (cache[op.operatorAddress]) fetched.push(cache[op.operatorAddress]);
    }
    await sleep(DELAY_MS);
  }

  // Merge: fetched (new) + cached (unchanged), dedupe by operatorAddress
  const allRows = [...fetched, ...cached];
  const seen = new Set();
  const rows = [];
  for (const r of allRows) {
    if (!seen.has(r.operatorAddress) && r.signingAddress) {
      seen.add(r.operatorAddress);
      rows.push(r);
    }
  }
  // Sort by moniker
  rows.sort((a, b) => a.moniker.localeCompare(b.moniker, 'en', { sensitivity: 'base' }));

  console.log(`Final registry: ${rows.length} valopers`);

  // Save cache
  saveCache(cache);

  // Compare with existing file
  const tsPath = join(ROOT, 'src/libs/gno/valopers-data.ts');
  const newTS = generateTS(rows);
  let changed = true;
  if (existsSync(tsPath)) {
    const old = readFileSync(tsPath, 'utf-8');
    // Compare only the JSON array part (ignore timestamp)
    const oldJSON = old.match(/const registry: GnoValoperRow\[\] = ([\s\S]*?);\n\nexport/);
    const newJSON = newTS.match(/const registry: GnoValoperRow\[\] = ([\s\S]*?);\n\nexport/);
    if (oldJSON && newJSON && oldJSON[1].trim() === newJSON[1].trim()) {
      changed = false;
    }
  }

  if (changed) {
    writeFileSync(tsPath, newTS);
    console.log(`UPDATED ${tsPath}`);
    // Print summary of changes
    const withSign = rows.filter((r) => r.signingAddress).length;
    const withServer = rows.filter((r) => r.serverType).length;
    console.log(`  signing: ${withSign}/${rows.length}, serverType: ${withServer}/${rows.length}`);
  } else {
    console.log('NO CHANGE — valopers-data.ts unchanged');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
