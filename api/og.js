/**
 * OG / social-crawler injector for Shazoes Explorer.
 *
 * SPA rewrites always serve the same index.html — Telegram/X/Discord bots
 * never execute JS, so they only see the generic title. This function
 * intercepts bot User-Agents (via vercel.json rewrite `has`) and returns
 * a minimal HTML page with per-route Open Graph + Twitter Card tags.
 *
 * Humans still get the normal SPA (index.html).
 */

const SITE = 'https://shazoes-explorer.vercel.app';
const SITE_NAME = 'Shazoes Explorer';
const DEFAULT_DESC =
  'Multi-chain Cosmos SDK block explorer by Shazoes Validator — Cosmos Hub, AtomOne, Babylon, MANTRA, Terra and more.';
const DEFAULT_IMAGE = `${SITE}/logo.png`;

// Built from chains/mainnet + chains/testnet at commit time. Keep in sync
// when adding a new chain (or regenerate — see scripts/gen-og-chains.mjs).
const CHAINS = {
  'CosmosHub-mainnet': {
    'pretty': 'Cosmos Hub',
    'chain_id': 'cosmoshub-4',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.png'
  },
  'atomone-mainnet': {
    'pretty': 'AtomOne',
    'chain_id': 'atomone-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/atomone/images/atomone.png'
  },
  'axone-mainnet': {
    'pretty': 'Axone',
    'chain_id': 'axone-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/axone/images/chain.png'
  },
  'babylon-mainnet': {
    'pretty': 'Babylon Genesis',
    'chain_id': 'bbn-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/babylon/images/logo.svg'
  },
  'hippo-mainnet': {
    'pretty': 'Hippo',
    'chain_id': 'hippo-protocol-1',
    'logo': 'https://shazoes-explorer.vercel.app/logos/hippo-protocol.png'
  },
  'lava-mainnet': {
    'pretty': 'Lava',
    'chain_id': 'lava-mainnet-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/lava/images/lava.png'
  },
  'mantra-mainnet': {
    'pretty': 'MANTRA',
    'chain_id': 'mantra-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/mantrachain/images/OM-Prim-Col.png'
  },
  'nillion-mainnet': {
    'pretty': 'Nillion',
    'chain_id': 'nillion-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/nillion/images/nil.png'
  },
  'provenance-mainnet': {
    'pretty': 'Provenance',
    'chain_id': 'pio-mainnet-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/provenance/images/prov.png'
  },
  'seda-mainnet': {
    'pretty': 'SEDA',
    'chain_id': 'seda-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/seda/images/seda.png'
  },
  'shentu-mainnet': {
    'pretty': 'Shentu',
    'chain_id': 'shentu-2.2',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/shentu/images/ctk.png'
  },
  'tellor-mainnet': {
    'pretty': 'Tellor',
    'chain_id': 'tellor-1',
    'logo': 'https://shazoes-explorer.vercel.app/logos/tellor.png'
  },
  'terra-mainnet': {
    'pretty': 'Terra',
    'chain_id': 'phoenix-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/terra2/images/luna.png'
  },
  'union-mainnet': {
    'pretty': 'Union',
    'chain_id': 'union-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/union/images/u.png'
  },
  'zetachain-mainnet': {
    'pretty': 'ZetaChain',
    'chain_id': 'zetachain_7000-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/zetachain/images/zetachain.png'
  },
  'airchain-testnet': {
    'pretty': 'Airchain (testnet)',
    'chain_id': 'varanasi-1',
    'logo': 'https://shazoes-explorer.vercel.app/logos/airchain.png'
  },
  'atomone-testnet': {
    'pretty': 'AtomOne (testnet)',
    'chain_id': 'atomone-testnet-1',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/atomone/images/atomone.png'
  },
  'empeiria-testnet': {
    'pretty': 'Empeiria (testnet)',
    'chain_id': 'empe-testnet-2',
    'logo': 'https://shazoes-explorer.vercel.app/logos/empe.png'
  },
  'gnoland-testnet': {
    'pretty': 'gnoland',
    'chain_id': 'topaz-1',
    'logo': 'https://shazoes-explorer.vercel.app/logos/gno.png',
    'card': 'summary_large_image',
    'description': 'Gnoland Tendermint2 testnet (topaz-1) · 89 validators · RPC-only block explorer by Shazoes.'
  },
  'hippo-testnet': {
    'pretty': 'Hippo Protocol (testnet)',
    'chain_id': 'hippo-protocol-testnet-1',
    'logo': 'https://shazoes-explorer.vercel.app/logos/hippo-protocol.png'
  },
  'pushchain-testnet': {
    'pretty': 'pushchain-testnet (testnet)',
    'chain_id': 'push_42101-1',
    'logo': 'https://shazoes-explorer.vercel.app/logos/pchain.png'
  },
  'seda-testnet': {
    'pretty': 'SEDA (testnet)',
    'chain_id': 'seda-1-testnet',
    'logo': 'https://raw.githubusercontent.com/cosmos/chain-registry/master/seda/images/seda.png'
  },
  'structs-testnet': {
    'pretty': 'Structs (testnet)',
    'chain_id': 'structstestnet-111',
    'logo': 'https://shazoes-explorer.vercel.app/logos/structs.jpg'
  },
  'tellor-testnet': {
    'pretty': 'Tellor (testnet)',
    'chain_id': 'layertest-5',
    'logo': 'https://shazoes-explorer.vercel.app/logos/tellor.png'
  }
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function short(s, head = 10, tail = 6) {
  const t = String(s || '');
  if (t.length <= head + tail + 1) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function parsePath(pathname) {
  const segs = String(pathname || '/')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  if (segs.length === 0) {
    return {
      title: `${SITE_NAME} — Cosmos Blockchain Explorer`,
      description: DEFAULT_DESC,
      image: DEFAULT_IMAGE,
      type: 'website',
    };
  }

  const chainKey = segs[0];
  const chain = CHAINS[chainKey];
  const pretty = chain?.pretty || chainKey;
  const chainImg = chain?.logo || DEFAULT_IMAGE;
  const chainId = chain?.chain_id ? ` · ${chain.chain_id}` : '';

  // /:chain
  if (segs.length === 1) {
    return {
      title: `${pretty} — ${SITE_NAME}`,
      description: chain?.description || `Explore ${pretty}${chainId}: blocks, transactions, validators, governance and accounts on Shazoes Explorer.`,
      image: chainImg,
      type: 'website',
      card: chain?.card || 'summary',
    };
  }

  const section = segs[1];
  const id = segs[2] || '';

  switch (section) {
    case 'validator':
      return {
        title: id
          ? `Validator ${short(id, 12, 6)} · ${pretty} — ${SITE_NAME}`
          : `Validators · ${pretty} — ${SITE_NAME}`,
        description: id
          ? `Validator profile on ${pretty}${chainId}. Commission, voting power, uptime and delegations.`
          : `Active validator set for ${pretty}${chainId}.`,
        image: chainImg,
        type: 'profile',
      };
    case 'account':
      return {
        title: id
          ? `Account ${short(id)} · ${pretty} — ${SITE_NAME}`
          : `Accounts · ${pretty} — ${SITE_NAME}`,
        description: id
          ? `Account ${short(id, 14, 8)} on ${pretty}${chainId}: balances, delegations, rewards and activity.`
          : `Browse accounts on ${pretty}.`,
        image: chainImg,
        type: 'profile',
      };
    case 'tx':
      return {
        title: id
          ? `Tx ${short(id, 12, 8)} · ${pretty} — ${SITE_NAME}`
          : `Transactions · ${pretty} — ${SITE_NAME}`,
        description: id
          ? `Transaction ${short(id, 16, 8)} on ${pretty}${chainId}. Messages, fees, height and result.`
          : `Latest transactions on ${pretty}${chainId}.`,
        image: chainImg,
        type: 'article',
      };
    case 'block':
      return {
        title: id
          ? `Block #${id} · ${pretty} — ${SITE_NAME}`
          : `Blocks · ${pretty} — ${SITE_NAME}`,
        description: id
          ? `Block height ${id} on ${pretty}${chainId}: proposer, txs and timestamp.`
          : `Recent blocks on ${pretty}${chainId}.`,
        image: chainImg,
        type: 'article',
      };
    case 'gov':
    case 'governance':
      return {
        title: id
          ? `Proposal #${id} · ${pretty} — ${SITE_NAME}`
          : `Governance · ${pretty} — ${SITE_NAME}`,
        description: id
          ? `Governance proposal #${id} on ${pretty}${chainId}.`
          : `Active and past governance proposals on ${pretty}${chainId}.`,
        image: chainImg,
        type: 'article',
      };
    case 'uptime':
      return {
        title: `Uptime · ${pretty} — ${SITE_NAME}`,
        description: `Validator uptime and signing window on ${pretty}${chainId}.`,
        image: chainImg,
        type: 'website',
      };
    case 'parameters':
      return {
        title: `Parameters · ${pretty} — ${SITE_NAME}`,
        description: `Chain parameters for ${pretty}${chainId}: staking, slashing, gov, mint and more.`,
        image: chainImg,
        type: 'website',
      };
    case 'ibc':
      return {
        title: `IBC · ${pretty} — ${SITE_NAME}`,
        description: `IBC channels and connections for ${pretty}${chainId}.`,
        image: chainImg,
        type: 'website',
      };
    default:
      return {
        title: `${pretty} / ${section}${id ? ' / ' + short(id) : ''} — ${SITE_NAME}`,
        description: `View ${section} on ${pretty}${chainId} via Shazoes Explorer.`,
        image: chainImg,
        type: 'website',
      };
  }
}

function renderHtml({ title, description, image, type, url, card }) {
  const t = esc(title);
  const d = esc(description);
  const img = esc(image || DEFAULT_IMAGE);
  const u = esc(url);
  const ty = esc(type || 'website');
  const twCard = esc(card || 'summary');
  // Minimal bot page: OG tags + noscript link. No SPA bundle needed.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${t}</title>
  <meta name="description" content="${d}" />
  <link rel="canonical" href="${u}" />
  <meta property="og:type" content="${ty}" />
  <meta property="og:site_name" content="${esc(SITE_NAME)}" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:url" content="${u}" />
  <meta property="og:image" content="${img}" />
  <meta property="og:image:alt" content="${t}" />
  <meta name="twitter:card" content="${twCard}" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />
  <meta name="twitter:image" content="${img}" />
  <meta name="robots" content="index,follow" />
</head>
<body>
  <h1>${t}</h1>
  <p>${d}</p>
  <p><a href="${u}">Open in ${esc(SITE_NAME)}</a></p>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  try {
    // path comes from rewrite: /api/og?path=CosmosHub-mainnet/validator/...
    // or from raw URL if called directly
    const url = new URL(req.url, SITE);
    let pathname = url.searchParams.get('path') || url.pathname || '/';
    if (pathname.startsWith('/api/og')) pathname = '/';
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    // strip trailing slash except root
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    const meta = parsePath(pathname);
    const canonical = `${SITE}${pathname === '/' ? '' : pathname}`;
    const html = renderHtml({ ...meta, url: canonical });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    res.setHeader('X-Robots-Tag', 'all');
    res.statusCode = 200;
    res.end(html);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('OG render error');
  }
};
