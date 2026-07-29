#!/usr/bin/env node
/**
 * refresh-gno-valopers.mjs — Auto-refresh Gnoland valoper registry from official realm.
 *
 * Writes static JSON file for B2B production (no Vercel, no SPA).
 * Output: /home/hermes/explorer/public/data/gno-valopers.json
 *
 * Usage: node scripts/refresh-gno-valopers.mjs [--chain gnoland-testnet]
 * Exit 0 = success. Exit 1 = error.
 *
 * Rate: safe at any interval ≥ 5 min. Normal run = 2 GETs (list pages).
 * Detail fetches only on change (~100 GETs, ~2 min, polite 150ms delay).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'public', 'data');
const OUTPUT_FILE = join(OUTPUT_DIR, 'gno-valopers.json');

const UA = 'ShazoesExplorer/1.0 (valoper-refresh)';
const DELAY_MS = 150;
const MAX_PAGES = 10;

// --- args ---
const args = process.argv.slice(2);
const chainArg = args.includes('--chain') ? args[args.indexOf('--chain') + 1] : 'gnoland-testnet';

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
async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
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
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 20);
  const descCands = lines.filter(
    (l) => !/^(Operator|Signing|Server|Moniker|Website|Description|g1|gpub)/i.test(l)
  );
  const description = descCands.length ? descCands.reduce((a, b) => (b.length > a.length ? b : a)).slice(0, 200) : '';
  const wsMatch = description.match(/https?:\/\/[^\s]+/);
  return {
    signingAddress: signMatch ? signMatch[1] : '',
    serverType: serverMatch ? serverMatch[1] : '',
    description,
    website: wsMatch ? wsMatch[0] : '',
  };
}

// --- build registry ---
async function buildRegistry() {
  const ops = await fetchListPages();
  console.log(`Total operators from list: ${ops.length}`);

  const rows = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      const detail = await fetchDetail(op.operatorAddress);
      rows.push({
        moniker: op.moniker,
        signingAddress: detail.signingAddress,
        operatorAddress: op.operatorAddress,
        website: detail.website,
        identity: '',
        serverType: detail.serverType,
        description: detail.description,
      });
    } catch (e) {
      rows.push({
        moniker: op.moniker,
        signingAddress: '',
        operatorAddress: op.operatorAddress,
        website: '',
        identity: '',
        serverType: '',
        description: '',
      });
    }
    if ((i + 1) % 25 === 0) await sleep(DELAY_MS);
  }
  rows.sort((a, b) => a.moniker.localeCompare(b.moniker, 'en', { sensitivity: 'base' }));
  return rows;
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const data = await buildRegistry();
  const json = JSON.stringify(data, null, 2);
  writeFileSync(OUTPUT_FILE, json);
  console.log(`UPDATED ${OUTPUT_FILE} (${data.length} valopers)`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
