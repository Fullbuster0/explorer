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

/** Sub-group icon — a single glyph makes each section scannable at a
 *  glance. Helps the reader orient on mobile where the dense list can
 *  feel monotonous. */
const sgIcons: Record<string, { glyph: string; key: string }> = {
  'Voting':         { glyph: '🗳', key: 'vote' },
  'Deposit':        { glyph: '💎', key: 'deposit' },
  'Tally':          { glyph: '📊', key: 'tally' },
  'Bond config':    { glyph: '🔗', key: 'bond' },
  'Nakamoto bonus': { glyph: '⭐', key: 'bonus' },
  'Slash fractions':{ glyph: '⚡', key: 'slash' },
  'Penalties':      { glyph: '⚡', key: 'slash' },
  'Windows':        { glyph: '⏱', key: 'windows' },
};
function sgIcon(title: string): string {
  return sgIcons[title]?.glyph || '·';
}
function sgIconKey(title: string): string {
  return sgIcons[title]?.key || 'default';
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
            <span class="sz-params-subgroup-icon" :data-icon="sgIconKey(sg.title)">
              {{ sgIcon(sg.title) }}
            </span>
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

<!-- Shared .sz-params-* styles live in src/style.css (global) so
     params/index.vue Overview / App / Node grids get the same layout. -->