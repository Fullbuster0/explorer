#!/usr/bin/env node
/**
 * Regenerates the CHAINS map inside api/og.js from chains/{mainnet,testnet}/*.json.
 * Run after adding/renaming a chain:
 *   node scripts/gen-og-chains.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://shazoes-explorer.vercel.app';

function load(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return {};
  const out = {};
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'));
    let pretty = c.registry_name || c.chain_name.replace(/-mainnet$|-testnet$/i, '');
    if (/cosmoshub/i.test(pretty)) pretty = 'Cosmos Hub';
    if (/-testnet$/i.test(c.chain_name) && !/\(testnet\)/i.test(pretty)) {
      pretty = `${pretty} (testnet)`;
    }
    let logo = c.logo || '';
    if (logo.startsWith('/')) logo = SITE + logo;
    out[c.chain_name] = { pretty, chain_id: c.chain_id || '', logo };
  }
  return out;
}

const map = { ...load('chains/mainnet'), ...load('chains/testnet') };
const lit = JSON.stringify(map, null, 2)
  .replace(/"([^"]+)":/g, "'$1':")
  .replace(/"/g, "'");

const apiPath = path.join(root, 'api/og.js');
let src = fs.readFileSync(apiPath, 'utf8');
const re = /const CHAINS = \{[\s\S]*?\n\};/;
if (!re.test(src)) {
  console.error('CHAINS block not found in api/og.js');
  process.exit(1);
}
src = src.replace(re, `const CHAINS = ${lit};`);
fs.writeFileSync(apiPath, src);
console.log(`Updated CHAINS (${Object.keys(map).length} entries) in api/og.js`);
