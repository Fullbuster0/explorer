<script lang="ts" setup>
import { computed } from '@vue/reactivity';
import { useFormatter } from '@/stores';
import { formatSeconds } from '@/libs/utils';

interface ParamItem {
  subtitle: string;
  value: any;
  kind?: 'duration' | 'percent' | 'coin' | 'coinlist' | 'denom' | 'boolean' | 'integer' | string;
}
interface SubGroup {
  title: string;
  items: ParamItem[];
}
interface ParamCard {
  title: string;
  module?: string;
  items?: ParamItem[];
  subGroups?: SubGroup[];
}

const props = defineProps<{
  card: ParamCard;
  loading?: boolean;
}>();

const format = useFormatter();

/**
 * Tooltip text describing what each param means. Helps the reader who
 * only knows Cosmos casually — most of these names are opaque.
 */
const tooltips: Record<string, string> = {
  unbonding_time: 'How long tokens are locked after undelegating before they become spendable.',
  max_validators: 'Maximum number of active validators in the active set.',
  max_entries: 'Maximum number of unbonding entries per delegator-validator pair.',
  historical_entries: 'How many historical validator signing infos the chain retains for slashing.',
  bond_denom: 'The staking denomination for this chain.',
  min_commission_rate: 'Lowest commission rate a validator may set.',
  max_commission_rate: 'Highest commission rate a validator may set.',
  min_self_delegation: 'Minimum amount a validator must self-delegate.',
  key_rotation_fee: 'Fee charged for rotating a validator\'s consensus key (atomone-specific).',
  signed_blocks_window: 'Number of blocks in the sliding window used to detect downtime.',
  min_signed_per_window: 'Minimum fraction of blocks a validator must sign in the window or get jailed.',
  downtime_jail_duration: 'How long a validator is jailed for missing blocks.',
  slash_fraction_double_sign: 'Fraction of stake slashed when a validator double-signs.',
  slash_fraction_downtime: 'Fraction of stake slashed for downtime (in addition to jail).',
  community_tax: 'Fraction of rewards taken by the community pool before distribution.',
  withdraw_addr_enabled: 'Whether delegators may set a separate withdraw address for rewards.',
  base_proposer_reward: 'Base reward rate given to block proposers.',
  bonus_proposer_reward: 'Bonus reward rate scaling with pre-commit count.',
  voting_period: 'How long a proposal remains open for voting.',
  min_deposit: 'Minimum deposit required to enter the voting period.',
  max_deposit_period: 'Window during which the deposit must be raised.',
  quorum: 'Minimum fraction of voting power that must vote for a proposal to be valid.',
  threshold: 'Fraction of "yes" votes (excluding abstains) required to pass.',
  veto_threshold: 'Fraction of "no-with-veto" votes required to reject a proposal outright.',
  inflation_rate_change: 'Maximum rate at which inflation can change per update.',
  inflation_max: 'Upper bound on annual inflation.',
  inflation_min: 'Lower bound on annual inflation.',
  goal_bonded: 'Target fraction of supply that should be bonded.',
  blocks_per_year: 'Approximate number of blocks produced per year (used by inflation calc).',
  mint_denom: 'The denomination the mint module can issue.',
  period_epoch_identifier: 'Epoch identifier (e.g. "week") used for the nakamoto bonus cadence.',
  minimum_coefficient: 'Lowest nakamoto bonus multiplier applied to a delegator.',
  maximum_coefficient: 'Highest nakamoto bonus multiplier applied to a delegator.',
  step: 'Increment of the bonus coefficient per period.',
  enabled: 'Master toggle for this sub-feature.',
};

function tip(k: string) {
  return tooltips[k] || '';
}

/** Render a value according to its `kind` tag from the store. Falls
 *  back to a sensible stringification for unknown kinds. */
function renderValue(item: ParamItem): { display: string; tone?: string } {
  const v = item.value;
  const k = item.kind;
  switch (k) {
    case 'duration':
      return { display: formatSeconds(String(v)) };
    case 'percent': {
      const n = Number(v);
      if (!isFinite(n)) return { display: String(v) };
      // 0.05 -> "5.00%"; 0.0001 -> "0.0100%". Use enough precision for
      // small fractions (slashing fractions can be 0.01%).
      const pct = n * 100;
      const fixed = pct < 0.01 ? pct.toFixed(4) : pct < 1 ? pct.toFixed(3) : pct.toFixed(2);
      return { display: `${fixed}%` };
    }
    case 'coin': {
      // A Coin {denom, amount} — format with the chain's display symbol.
      if (!v || typeof v !== 'object') return { display: String(v) };
      const out = format.formatToken(v, true, '0,0.[000000]');
      return { display: out };
    }
    case 'coinlist': {
      if (!Array.isArray(v) || v.length === 0) return { display: '—' };
      // Render one coin per line for readability.
      const lines = v
        .map((c) => format.formatToken(c, true, '0,0.[000000]'))
        .join(' · ');
      return { display: lines };
    }
    case 'denom': {
      const symbol = format.tokenDisplayDenom(String(v))?.toUpperCase();
      return { display: symbol || String(v), tone: 'denom' };
    }
    case 'boolean': {
      return { display: v ? 'ENABLED' : 'DISABLED', tone: v ? 'on' : 'off' };
    }
    case 'integer': {
      const n = Number(v);
      if (!isFinite(n)) return { display: String(v) };
      // Thousands separator, no decimals.
      return { display: n.toLocaleString('en-US') };
    }
    default: {
      // Fallback — stringify but keep the chain-config display symbol
      // for raw denom-looking strings.
      if (typeof v === 'string' && v.startsWith('ibc/')) {
        return { display: v, tone: 'denom' };
      }
      if (typeof v === 'string' && /^\d+s$/.test(v)) {
        return { display: formatSeconds(v) };
      }
      return { display: String(v) };
    }
  }
}

/** Pretty-print the key: `unbonding_time` -> `Unbonding time` */
function prettyKey(k: string) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Group tag tones for the section header. */
const moduleTone = computed(() => {
  switch (props.card?.module) {
    case 'staking':
      return 'staking';
    case 'slashing':
      return 'slashing';
    case 'distribution':
      return 'distribution';
    case 'gov':
      return 'gov';
    case 'mint':
      return 'mint';
    default:
      return 'default';
  }
});
</script>

<template>
  <section
    v-if="loading || (card?.items?.length || card?.subGroups?.length)"
    class="sz-section sz-glass overflow-hidden mb-4"
  >
    <!-- Header: kicker (module) + title + tone dot -->
    <div class="sz-section-head">
      <div class="flex items-center gap-3">
        <span class="sz-params-tone" :data-tone="moduleTone"></span>
        <div>
          <div class="sz-section-kicker">{{ card?.module || 'module' }}</div>
          <div class="sz-section-title">{{ card?.title }}</div>
        </div>
      </div>
    </div>

    <!-- Body — either top-level items, or top-level + sub-groups -->
    <div class="sz-params-body">
      <!-- Direct items -->
      <div v-if="card?.items?.length" class="sz-params-grid">
        <div
          v-for="(it, i) in card.items"
          :key="'top-' + i"
          class="sz-params-cell"
          :class="{ 'sz-params-cell--wide': Array.isArray(it.value) && it.kind === 'coinlist' }"
        >
          <div class="sz-params-key" :title="tip(it.subtitle)">
            {{ prettyKey(it.subtitle) }}
            <span v-if="tip(it.subtitle)" class="sz-params-tip">ⓘ</span>
          </div>
          <div class="sz-params-val" :data-tone="renderValue(it).tone">
            {{ renderValue(it).display }}
          </div>
        </div>
      </div>

      <!-- Sub-groups (e.g. Gov = Voting + Deposit + Tally) -->
      <div v-if="card?.subGroups?.length" class="sz-params-subgroups">
        <div
          v-for="(sg, gi) in card.subGroups"
          :key="'sg-' + gi"
          class="sz-params-subgroup"
        >
          <div class="sz-params-subgroup-head">
            <span class="sz-params-subgroup-title">{{ sg.title }}</span>
          </div>
          <div class="sz-params-grid">
            <div
              v-for="(it, i) in sg.items"
              :key="gi + '-item-' + i"
              class="sz-params-cell"
              :class="{ 'sz-params-cell--wide': Array.isArray(it.value) && it.kind === 'coinlist' }"
            >
              <div class="sz-params-key" :title="tip(it.subtitle)">
                {{ prettyKey(it.subtitle) }}
                <span v-if="tip(it.subtitle)" class="sz-params-tip">ⓘ</span>
              </div>
              <div class="sz-params-val" :data-tone="renderValue(it).tone">
                {{ renderValue(it).display }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Header dot — different tone per module so the eye can scan down a long
   page and instantly know which section it's in. */
.sz-params-tone {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 25%, transparent);
}
.sz-params-tone[data-tone='staking'] {
  background: #3fb6ff;
  color: #3fb6ff;
}
.sz-params-tone[data-tone='slashing'] {
  background: #ff7a59;
  color: #ff7a59;
}
.sz-params-tone[data-tone='distribution'] {
  background: #16d97e;
  color: #16d97e;
}
.sz-params-tone[data-tone='gov'] {
  background: #b892ff;
  color: #b892ff;
}
.sz-params-tone[data-tone='mint'] {
  background: #ffd166;
  color: #ffd166;
}
.sz-params-tone[data-tone='default'] {
  background: hsl(var(--p));
  color: hsl(var(--p));
}

/* Grid for cells — auto-fill so wide screens get more columns, narrow
   phones collapse to a single column. min 180px per cell so values stay
   readable. */
.sz-params-body {
  padding-top: 0.25rem;
}
.sz-params-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 0.65rem 0.85rem;
}
.sz-params-cell {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.65rem 0.85rem;
  border-radius: 10px;
  background: color-mix(in srgb, hsl(var(--bc)) 3%, transparent);
  border: 1px solid var(--sz-border);
  transition: background 0.15s ease, border-color 0.15s ease;
}
.sz-params-cell:hover {
  background: color-mix(in srgb, hsl(var(--p)) 4%, transparent);
  border-color: color-mix(in srgb, hsl(var(--p)) 22%, var(--sz-border));
}
.sz-params-cell--wide {
  grid-column: 1 / -1;
}

/* Key (label) — small, dimmed, uppercase tracking. */
.sz-params-key {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: color-mix(in srgb, hsl(var(--bc)) 55%, transparent);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.sz-params-tip {
  font-size: 11px;
  opacity: 0.55;
  cursor: help;
  transition: opacity 0.15s ease;
}
.sz-params-tip:hover {
  opacity: 1;
}

/* Value — big, monospace, accent on certain tones. */
.sz-params-val {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 14px;
  font-weight: 600;
  color: hsl(var(--bc));
  word-break: break-word;
  line-height: 1.35;
}
.sz-params-val[data-tone='on'] {
  color: #16d97e;
}
.sz-params-val[data-tone='off'] {
  color: #ff7a59;
}
.sz-params-val[data-tone='denom'] {
  color: hsl(var(--p));
  letter-spacing: 0.04em;
}

/* Sub-group rendering — used for Gov (Voting/Deposit/Tally), Staking
   (Bond config), Distribution (Nakamoto bonus), etc. */
.sz-params-subgroups {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.25rem;
}
.sz-params-subgroup {
  border-left: 2px solid color-mix(in srgb, hsl(var(--p)) 25%, transparent);
  padding-left: 0.85rem;
}
.sz-params-subgroup-head {
  margin-bottom: 0.55rem;
}
.sz-params-subgroup-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: color-mix(in srgb, hsl(var(--p)) 70%, hsl(var(--bc)));
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
</style>