import { useBlockchain } from '@/stores';
import { createRouter, createWebHistory } from 'vue-router';
// @ts-ignore
import { setupLayouts } from 'virtual:generated-layouts';
// @ts-ignore
import routes from '~pages';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [...setupLayouts(routes)],
});

const SITE = 'Shazoes Explorer';

function shortAddr(s: string, head = 10, tail = 6) {
  if (!s || s.length <= head + tail + 1) return s || '';
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Browser-tab title only (crawlers get real OG via /api/og). */
function titleFor(to: { path: string; params: Record<string, any> }) {
  const chain = to.params.chain ? String(to.params.chain) : '';
  const segs = to.path.split('/').filter(Boolean);
  if (!chain) return `${SITE} — Cosmos Blockchain Explorer`;

  // Prefer pretty name from store when available
  let pretty = chain;
  try {
    const blockchain = useBlockchain();
    if (blockchain.current?.prettyName) pretty = blockchain.current.prettyName;
  } catch {
    /* pinia may not be ready on first tick */
  }

  const section = segs[1];
  const id = segs[2] || '';
  switch (section) {
    case 'validator':
      return id
        ? `Validator ${shortAddr(id, 12, 6)} · ${pretty} — ${SITE}`
        : `Validators · ${pretty} — ${SITE}`;
    case 'account':
      return id
        ? `Account ${shortAddr(id)} · ${pretty} — ${SITE}`
        : `Accounts · ${pretty} — ${SITE}`;
    case 'tx':
    case 'gno-tx':
      return id
        ? `Tx ${shortAddr(id, 12, 8)} · ${pretty} — ${SITE}`
        : `Transactions · ${pretty} — ${SITE}`;
    case 'gno-realms':
    case 'realms':
      return `Realms · ${pretty} — ${SITE}`;
    case 'gno-tokens':
    case 'tokens':
      return `Tokens · ${pretty} — ${SITE}`;
    case 'block':
      return id ? `Block #${id} · ${pretty} — ${SITE}` : `Blocks · ${pretty} — ${SITE}`;
    case 'gov':
    case 'gno-gov':
    case 'governance':
      return id
        ? `Proposal #${id} · ${pretty} — ${SITE}`
        : `Governance · ${pretty} — ${SITE}`;
    case 'uptime':
      return `Uptime · ${pretty} — ${SITE}`;
    case 'parameters':
    case 'params':
      return `Parameters · ${pretty} — ${SITE}`;
    case 'consensus':
      return `Consensus · ${pretty} — ${SITE}`;
    case 'ibc':
      return `IBC · ${pretty} — ${SITE}`;
    default:
      return section ? `${pretty} / ${section} — ${SITE}` : `${pretty} — ${SITE}`;
  }
}

//update current blockchain + document title
router.beforeEach((to) => {
  const { chain } = to.params;
  if (chain) {
    const blockchain = useBlockchain();
    if (chain !== blockchain.chainName) {
      // setCurrent is async (may await dashboard init) — do NOT block navigation
      // on it. A hung await here would freeze the whole router (sidebar clicks
      // stop responding until a hard refresh). Fire-and-forget + swallow errors.
      Promise.resolve(blockchain.setCurrent(chain.toString())).catch((e) =>
        console.warn('[router] setCurrent failed', e)
      );
    }
  }
});

router.afterEach((to) => {
  try {
    document.title = titleFor(to);
  } catch {
    /* ignore */
  }
});

// Surface hard navigation failures (e.g. lazy chunk load error after a deploy)
// instead of silently leaving the user on a blank/stuck page.
router.onError((err, to) => {
  console.error('[router] navigation error:', err?.message || err);
  const msg = String(err?.message || '');
  if (/Loading chunk|Failed to fetch dynamically imported|Importing a module script failed/i.test(msg)) {
    // Stale chunk after a new deploy — one clean reload to pick up fresh assets.
    // Normalize to a single leading slash: a fullPath like `//evil.com` would
    // be a protocol-relative URL and location.replace() would leave the origin
    // (open redirect). Forcing `/…` keeps the reload same-origin.
    const raw = to?.fullPath || window.location.pathname;
    const target = `/${String(raw).replace(/^\/+/, '')}`;
    window.location.replace(target);
  }
});

// Docs: https://router.vuejs.org/guide/advanced/navigation-guards.html#global-before-guards

export default router;
