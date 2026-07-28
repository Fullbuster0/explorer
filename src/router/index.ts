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
      return id
        ? `Tx ${shortAddr(id, 12, 8)} · ${pretty} — ${SITE}`
        : `Transactions · ${pretty} — ${SITE}`;
    case 'block':
      return id ? `Block #${id} · ${pretty} — ${SITE}` : `Blocks · ${pretty} — ${SITE}`;
    case 'gov':
    case 'governance':
      return id
        ? `Proposal #${id} · ${pretty} — ${SITE}`
        : `Governance · ${pretty} — ${SITE}`;
    case 'uptime':
      return `Uptime · ${pretty} — ${SITE}`;
    case 'parameters':
      return `Parameters · ${pretty} — ${SITE}`;
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
      blockchain.setCurrent(chain.toString());
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

// Docs: https://router.vuejs.org/guide/advanced/navigation-guards.html#global-before-guards

export default router;
