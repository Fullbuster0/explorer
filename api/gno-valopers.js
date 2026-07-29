/**
 * Vercel serverless: Gnoland valoper registry proxy.
 *
 * Fetches the official gnops realm (list + detail pages) server-side
 * (bypasses browser CORS), caches in-memory with TTL, and returns JSON.
 * CDN-cached via Cache-Control so the function only runs once per TTL
 * per region.
 *
 * GET /api/gno-valopers?chain=gnoland-testnet
 *
 * Config-driven: reads valopers_source.base_url from chain JSON.
 * Swap base_url for mainnet — zero code change.
 */

const CHAIN_CONFIGS = {
  'gnoland-testnet': {
    base_url: 'https://topaz.testnets.gno.land/r/gnops/valopers',
  },
  // future: 'gnoland-mainnet': { base_url: 'https://mainnet.gno.land/r/gnops/valopers' },
};

const UA = 'ShazoesExplorer/1.0 (valoper-api)';
const DELAY_MS = 100;
const MAX_PAGES = 10;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// In-memory cache (persists across invocations in same region)
let cache = { data: null, ts: 0, chain: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function fetchListPages(base) {
  const ops = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await get(`${base}?page=${page}`);
    const re = /href="\/r\/gnops\/valopers:(g1[a-z0-9]+)"[^>]*>\s*([^<]+?)\s*<\/a>/gi;
    let m;
    let count = 0;
    while ((m = re.exec(html)) !== null) {
      const moniker = m[2].trim();
      if (moniker && moniker.toLowerCase() !== 'profile') {
        ops.push({ operatorAddress: m[1], moniker });
        count++;
      }
    }
    if (count === 0) break;
    await sleep(DELAY_MS);
  }
  return ops;
}

async function fetchDetail(base, operatorAddress) {
  const html = await get(`${base}:${operatorAddress}`);
  const signMatch = html.match(/Signing Address:[\s\S]{0,200}?(g1[a-z0-9]{38,45})/i);
  const serverMatch = html.match(/Server Type:[\s\S]{0,100}?(cloud|on-prem|data-center)/i);
  const text = html.replace(/<[^>]+>/g, '\n');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 20);
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

async function buildRegistry(base) {
  const ops = await fetchListPages(base);
  const rows = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      const detail = await fetchDetail(base, op.operatorAddress);
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
      // skip failed detail — list entry still useful
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

export default async function handler(req, res) {
  const chain = (req.query.chain || 'gnoland-testnet').toString();
  const config = CHAIN_CONFIGS[chain];
  if (!config) {
    res.status(404).json({ error: `Unknown chain: ${chain}` });
    return;
  }

  const now = Date.now();
  const stale = !cache.data || now - cache.ts > CACHE_TTL_MS || cache.chain !== chain;

  if (stale) {
    try {
      const data = await buildRegistry(config.base_url);
      cache = { data, ts: now, chain };
    } catch (e) {
      // If fetch fails and we have old cache, serve stale
      if (cache.data && cache.chain === chain) {
        // serve stale with warning
      } else {
        res.status(502).json({ error: `Upstream fetch failed: ${e.message}` });
        return;
      }
    }
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    chain,
    source: config.base_url,
    count: cache.data.length,
    generated_at: new Date(cache.ts).toISOString(),
    valopers: cache.data,
  });
}
