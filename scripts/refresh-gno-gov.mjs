#!/usr/bin/env node
/**
 * refresh-gno-gov.mjs — Scrape Gnoland GovDAO proposals from the official realm
 * rendered on gnoweb, write a static JSON the explorer SPA can consume.
 *
 * Data source: realm gno.land/r/gov/dao (server-rendered by gnoweb).
 * Same proven mechanism as refresh-gno-valopers.mjs (scrape gnoweb HTML, NOT
 * RPC qrender/qcall, NOT onbloc). Governance data is onbloc-independent.
 *
 * List:   <base>/r/gov/dao?page=N   → proposal ids (href /r/gov/dao:<id>)
 * Detail: <base>/r/gov/dao:<id>     → title/author/status/tiers/vote-split/updates
 *
 * Usage:
 *   node scripts/refresh-gno-gov.mjs [--chain gnoland-testnet] [--out /path/gno-gov.json]
 *
 * Output schema (UTSA-compatible + extras):
 *   { source, status_counts, proposals: [{ proposal_id, title, author_address,
 *     status, eligible_tiers, yes_percent, no_percent, abstain_percent,
 *     description, validator_updates, voters }] }
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.GNO_EXPLORER_ROOT ? process.env.GNO_EXPLORER_ROOT : join(__dirname, '..');

// --- args ---
const args = process.argv.slice(2);
const chainArg = args.includes('--chain') ? args[args.indexOf('--chain') + 1] : 'gnoland-testnet';
const outIdx = args.indexOf('--out');
const outFromCli = outIdx >= 0 ? args[outIdx + 1] : null;
const OUTPUT_FILE =
  outFromCli ||
  process.env.GOV_JSON ||
  process.env.GNO_GOV_OUT ||
  join(process.env.HOME || '/home/hermes', 'gno-valopers', 'data', 'gno-gov.json');

const UA = 'ShazoesExplorer/1.0 (gov-refresh)';
const DELAY_MS = 250; // polite on gnoweb rate limits (match valopers scraper)
const MAX_PAGES = 20;
const REALM = 'gno.land/r/gov/dao';

function findChainConfig(name) {
  for (const dir of ['chains/testnet', 'chains/mainnet']) {
    const p = join(ROOT, dir, `${name}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
  }
  throw new Error(`Chain config not found: ${name} under ${ROOT}`);
}

const config = findChainConfig(chainArg);
const vs = config.valopers_source;
if (!vs || vs.type !== 'gno-realm') {
  console.log(`SKIP: ${chainArg} has no gno-realm valopers_source`);
  process.exit(0);
}
// base_url includes the valopers realm path (.../r/gnops/valopers) — strip to
// the gnoweb ROOT so we can address a different realm (gov/dao) below.
const BASE = vs.base_url.replace(/\/r\/gnops\/valopers.*$/, '').replace(/\/$/, '');
const CHAIN_ID = config.chain_id || 'topaz-1';
console.log(`Chain: ${chainArg} (${CHAIN_ID}) | gnoweb: ${BASE} | realm: ${REALM} | out: ${OUTPUT_FILE}`);

// --- fetch helper (3 attempts, exponential backoff — cron runs unattended) ---
async function get(url, accept = 'text/html') {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: accept },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        console.warn(`    retry ${attempt}/3 ${url} (${e.message})`);
        await sleep(DELAY_MS * attempt * 2);
      }
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract the server-rendered realm body (<md-renderer class="c-realm-view">). */
function realmBody(html) {
  const m = html.match(/<md-renderer[^>]*>([\s\S]*?)<\/md-renderer>/i);
  const raw = m ? m[1] : html;
  return raw;
}
/** Tags → plain text (keep newlines as separators for line-oriented parsing). */
function toText(body) {
  return body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ');
}

// --- list: collect proposal ids across pages ---
async function collectProposalIds() {
  const ids = new Set();
  let lastPage = 1;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}/r/gov/dao?page=${page}`;
    const html = await get(url);
    const body = realmBody(html);
    // proposal ids from detail hrefs: /r/gov/dao:<id>
    const hrefRe = /\/r\/gov\/dao:(\d+)/g;
    let m;
    let foundThisPage = 0;
    while ((m = hrefRe.exec(body))) {
      ids.add(parseInt(m[1], 10));
      foundThisPage++;
    }
    // also catch "Prop #N" in case hrefs absent
    const propRe = /Prop\s*#(\d+)/g;
    while ((m = propRe.exec(body))) ids.add(parseInt(m[1], 10));
    // detect max page from pager links ?page=N
    const pageRe = /\?page=(\d+)/g;
    while ((m = pageRe.exec(html))) lastPage = Math.max(lastPage, parseInt(m[1], 10));
    console.log(`  list page ${page}: +${foundThisPage} hrefs (total ids ${ids.size})`);
    if (page >= lastPage) break;
    await sleep(DELAY_MS);
  }
  return { ids: [...ids].sort((a, b) => b - a), lastPage };
}

// --- detail: parse one proposal ---
function parsePercent(text, label) {
  const m = text.match(new RegExp(`${label}\\s*PERCENT:?\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'i'));
  return m ? parseFloat(m[1]) : null;
}
function parseStatus(text) {
  let m = text.match(/PROPOSAL HAS BEEN (\w+)/i);
  if (m) return m[1].toUpperCase();
  m = text.match(/Status:\s*([A-Za-z]+)/i);
  if (m) return m[1].toUpperCase();
  if (/ACCEPTED/i.test(text)) return 'ACCEPTED';
  if (/REJECTED/i.test(text)) return 'REJECTED';
  if (/ACTIVE|VOTING|OPEN/i.test(text)) return 'ACTIVE';
  return 'UNKNOWN';
}

async function fetchProposal(id) {
  const url = `${BASE}/r/gov/dao:${id}`;
  const html = await get(url);
  const text = toText(realmBody(html));

  const titleM = text.match(new RegExp(`Prop\\s*#${id}\\s*-\\s*(.+)`, 'i'));
  const title = titleM ? titleM[1].trim() : `Proposal #${id}`;
  const authorM = text.match(/Author:\s*(g1[a-z0-9]+)/i);
  const tiersM = text.match(/Tiers eligible to vote:\s*([^\n]+)/i);
  const eligible_tiers = tiersM
    ? tiersM[1].split(',').map((s) => s.trim()).filter((s) => /^T\d+$/i.test(s))
    : [];

  // description = first "Batch-add/Remove/Update ..." line after author
  let description = '';
  const descM = text.match(/((?:Batch-(?:add|remove|update)|Add|Remove|Update)[^\n]*valset[^\n]*)/i);
  if (descM) description = descM[1].trim();

  // validator updates: "g1... : add (power 5)"
  const validator_updates = [];
  const updRe = /(g1[a-z0-9]+)\s*:\s*(add|remove|update|change)\s*(?:\(power\s*(\d+)\))?/gi;
  let um;
  while ((um = updRe.exec(text))) {
    validator_updates.push({
      address: um[1],
      action: um[2].toLowerCase(),
      power: um[3] ? parseInt(um[3], 10) : null,
    });
  }

  // voters: addresses in the "Detailed voting list" section
  const voters = [];
  const vlIdx = text.search(/Detailed voting list/i);
  if (vlIdx >= 0) {
    const section = text.slice(vlIdx, vlIdx + 4000);
    const voterRe = /(g1[a-z0-9]+)[^\n]*?(YES|NO|ABSTAIN)/gi;
    let vm;
    const seen = new Set();
    while ((vm = voterRe.exec(section))) {
      if (!seen.has(vm[1])) {
        seen.add(vm[1]);
        voters.push({ address: vm[1], vote: vm[2].toUpperCase() });
      }
    }
  }

  return {
    proposal_id: id,
    title,
    author_address: authorM ? authorM[1] : null,
    status: parseStatus(text),
    eligible_tiers,
    yes_percent: parsePercent(text, 'YES'),
    no_percent: parsePercent(text, 'NO'),
    abstain_percent: parsePercent(text, 'ABSTAIN'),
    description,
    validator_updates,
    voters,
  };
}

// --- main ---
async function main() {
  console.log('Collecting proposal ids from list pages...');
  const { ids, lastPage } = await collectProposalIds();
  console.log(`Found ${ids.length} proposals across ${lastPage} pages: [${ids.join(', ')}]`);

  const proposals = [];
  for (const id of ids) {
    try {
      const p = await fetchProposal(id);
      proposals.push(p);
      console.log(
        `  #${id} ${p.status} Y${p.yes_percent}/N${p.no_percent}/A${p.abstain_percent} ` +
          `tiers=${p.eligible_tiers.join('/')} updates=${p.validator_updates.length} "${p.title.slice(0, 40)}"`
      );
    } catch (e) {
      console.warn(`  #${id} FAILED: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  const status_counts = { active: 0, accepted: 0, rejected: 0, unknown: 0 };
  for (const p of proposals) {
    const k = p.status === 'ACCEPTED' ? 'accepted' : p.status === 'REJECTED' ? 'rejected' : p.status === 'ACTIVE' ? 'active' : 'unknown';
    status_counts[k]++;
  }

  const out = {
    source: {
      chain_id: CHAIN_ID,
      realm_path: REALM,
      gnoweb_base: BASE,
      scraped_at: new Date().toISOString(),
      page_count: lastPage,
      proposal_count: proposals.length,
      latest_proposal_id: ids.length ? Math.max(...ids) : null,
    },
    status_counts,
    proposals,
  };

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWROTE ${OUTPUT_FILE} (${proposals.length} proposals)`);
  console.log(`status_counts: ${JSON.stringify(status_counts)}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
