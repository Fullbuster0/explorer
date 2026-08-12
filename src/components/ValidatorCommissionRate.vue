<script setup lang="ts">
/**
 * Shazoes commission capacity meter — replaces the ping.pub donut gauge.
 *
 * Reads the same CommissionRate payload but renders it as a linear "capacity"
 * track: the full track is the validator's max_rate, the filled portion is the
 * current rate, the amber band is the ±max_change_rate window the rate can move
 * in 24h, and the remaining space is headroom (how much the validator could
 * still raise commission). Pure CSS/SVG — no ApexCharts donut.
 */
import { computed, onMounted, ref, type PropType } from 'vue';
import { useFormatter } from '@/stores';
import type { CommissionRate } from '@/types';

const props = defineProps({
  commission: { type: Object as PropType<CommissionRate> },
  /** Kept for API compatibility with the old component (parent passes embedded). */
  embedded: { type: Boolean, default: false },
});

const format = useFormatter();

const rate = computed(() => Number(props.commission?.commission_rates?.rate || 0) * 100);
const change = computed(() => Number(props.commission?.commission_rates?.max_change_rate || 0) * 100);
const max = computed(() => Number(props.commission?.commission_rates?.max_rate || 1) * 100);

const headroom = computed(() => Math.max(0, max.value - rate.value));

// Track geometry — full track width represents max_rate.
const fillPct = computed(() => (max.value > 0 ? Math.min(100, (rate.value / max.value) * 100) : 0));
const bandLeftPct = computed(() =>
  max.value > 0 ? Math.max(0, ((rate.value - change.value) / max.value) * 100) : 0,
);
const bandWidthPct = computed(() => {
  if (max.value <= 0) return 0;
  const lo = Math.max(0, rate.value - change.value);
  const hi = Math.min(max.value, rate.value + change.value);
  return Math.max(0, ((hi - lo) / max.value) * 100);
});

// Animate the fill in on mount.
const mounted = ref(false);
onMounted(() => {
  requestAnimationFrame(() => {
    mounted.value = true;
  });
});
</script>

<template>
  <div class="sz-comm">
    <!-- header: big rate + updated chip -->
    <div class="sz-comm-top">
      <div>
        <div class="sz-comm-kicker">Commission rate</div>
        <div class="sz-comm-rate">
          {{ rate.toFixed(1) }}<span class="sz-comm-pct">%</span>
        </div>
        <div class="sz-comm-of">of rewards</div>
      </div>
      <div class="sz-comm-updated" :title="`Last commission update ${props.commission?.update_time || ''}`">
        <span class="sz-comm-pulse"></span>
        <span>upd {{ format.toDay(props.commission?.update_time, 'short') }}</span>
      </div>
    </div>

    <!-- capacity meter -->
    <div class="sz-comm-meter">
      <div class="sz-comm-track">
        <div
          class="sz-comm-band"
          :style="{ left: bandLeftPct + '%', width: bandWidthPct + '%' }"
        ></div>
        <div class="sz-comm-fill" :style="{ width: mounted ? fillPct + '%' : '0%' }"></div>
        <div class="sz-comm-marker" :style="{ left: fillPct + '%' }">
          <span class="sz-comm-marker-dot"></span>
        </div>
      </div>
      <div class="sz-comm-scale">
        <span>0%</span>
        <span class="sz-comm-scale-max">
          ceiling {{ max.toFixed(0) }}%
          <span class="sz-comm-tip" tabindex="0">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 8h.01M12 12v4.5"></path>
            </svg>
            <span class="sz-comm-tip-text">The hard cap on commission — <em>max_rate</em>. Set once at validator creation and locked forever; the rate can move below it, never above.</span>
          </span>
        </span>
      </div>
    </div>

    <!-- stats -->
    <div class="sz-comm-stats">
      <div class="sz-comm-stat">
        <div class="sz-comm-stat-label"><i class="dot dot-rate"></i>Rate</div>
        <div class="sz-comm-stat-value">{{ rate.toFixed(1) }}%</div>
      </div>
      <div class="sz-comm-stat">
        <div class="sz-comm-stat-label"><i class="dot dot-band"></i>24h swing</div>
        <div class="sz-comm-stat-value">±{{ change.toFixed(1) }}%</div>
      </div>
      <div class="sz-comm-stat">
        <div class="sz-comm-stat-label">
          <i class="dot dot-head"></i>Headroom
          <span class="sz-comm-tip" tabindex="0">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 8h.01M12 12v4.5"></path>
            </svg>
            <span class="sz-comm-tip-text">Room left to raise commission — <em>ceiling − rate</em>. Small headroom = commission is near its cap, unlikely to climb.</span>
          </span>
        </div>
        <div class="sz-comm-stat-value sz-comm-ok">{{ headroom.toFixed(1) }}%</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sz-comm {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 0.35rem 0.25rem 0.15rem;
}

/* header */
.sz-comm-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.sz-comm-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.sz-comm-rate {
  margin-top: 0.2rem;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 2.35rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
  color: var(--text-main);
}
.sz-comm-pct {
  font-size: 1.15rem;
  font-weight: 600;
  margin-left: 2px;
  color: var(--sz-accent);
}
.sz-comm-of {
  margin-top: 0.3rem;
  font-size: 11px;
  color: var(--text-secondary);
}
.sz-comm-updated {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  color: var(--text-secondary);
  border: 1px solid var(--sz-border);
  border-radius: 999px;
  padding: 4px 9px;
  background: hsl(var(--b1));
  white-space: nowrap;
}
.sz-comm-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sz-success);
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5);
  animation: szCommPulse 2.4s ease-out infinite;
}
@keyframes szCommPulse {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.45); }
  70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

/* meter */
.sz-comm-meter {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sz-comm-track {
  position: relative;
  height: 12px;
  border-radius: 999px;
  background: color-mix(in srgb, hsl(var(--bc)) 8%, transparent);
  overflow: visible;
}
/* amber 24h swing window straddling the current rate (above fill, below marker) */
.sz-comm-band {
  position: absolute;
  top: -3px;
  bottom: -3px;
  border-radius: 6px;
  background: rgba(245, 158, 11, 0.16);
  border: 1px dashed rgba(245, 158, 11, 0.55);
  z-index: 3;
}
.sz-comm-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: linear-gradient(90deg, #005fcc 0%, #2f9df4 60%, #38bdf8 100%);
  box-shadow: 0 2px 10px -2px rgba(0, 95, 204, 0.55);
  transition: width 1s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 2;
  overflow: hidden;
}
/* shimmer sweep across the fill */
.sz-comm-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 30%, rgba(255, 255, 255, 0.35) 50%, transparent 70%);
  transform: translateX(-120%);
  animation: szCommShimmer 3.2s ease-in-out infinite;
}
@keyframes szCommShimmer {
  0% { transform: translateX(-120%); }
  55% { transform: translateX(120%); }
  100% { transform: translateX(120%); }
}
.sz-comm-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 4;
  transition: left 1s cubic-bezier(0.22, 1, 0.36, 1);
}
.sz-comm-marker-dot {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: hsl(var(--b1));
  border: 3px solid var(--sz-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sz-accent) 22%, transparent);
}
.sz-comm-scale {
  display: flex;
  justify-content: space-between;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  color: var(--text-secondary);
}
.sz-comm-scale-max {
  opacity: 0.85;
}

/* stats */
.sz-comm-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.sz-comm-stat {
  border: 1px solid var(--sz-border);
  border-radius: 12px;
  padding: 8px 10px;
  background: color-mix(in srgb, hsl(var(--b1)) 70%, transparent);
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.sz-comm-stat:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--sz-accent) 35%, var(--sz-border));
  box-shadow: 0 8px 20px -12px var(--sz-glow);
}
.sz-comm-stat-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.sz-comm-stat-value {
  margin-top: 3px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-main);
}
.sz-comm-ok {
  color: var(--sz-success);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  display: inline-block;
}
.dot-rate { background: linear-gradient(90deg, #005fcc, #38bdf8); }
.dot-band { background: rgba(245, 158, 11, 0.75); }
.dot-head { background: color-mix(in srgb, hsl(var(--bc)) 25%, transparent); }

/* headroom tooltip — inverted chip, extends left so it never clips the card */
.sz-comm-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
  color: var(--text-secondary);
  cursor: help;
  outline: none;
  transition: color 0.16s ease;
}
.sz-comm-tip:hover,
.sz-comm-tip:focus-visible { color: var(--sz-accent); }
.sz-comm-tip svg { display: block; }
.sz-comm-tip-text {
  position: absolute;
  bottom: calc(100% + 9px);
  right: -6px;
  width: max-content;
  max-width: 230px;
  padding: 8px 11px;
  border-radius: 9px;
  background: color-mix(in srgb, hsl(var(--bc)) 90%, hsl(var(--b1)));
  color: hsl(var(--b1));
  font-family: 'DM Sans', sans-serif;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1.5;
  text-transform: none;
  text-align: left;
  box-shadow: 0 10px 28px -10px rgba(2, 6, 23, 0.5);
  opacity: 0;
  transform: translateY(5px);
  pointer-events: none;
  transition: opacity 0.16s ease, transform 0.16s ease;
  z-index: 30;
}
/* Mobile: keep the Headroom explanation below its label so it cannot cover the meter. */
@media (max-width: 640px) {
  .sz-comm-stats {
    position: relative;
    z-index: 1;
  }

  .sz-comm-stat:last-child .sz-comm-tip-text {
    top: calc(100% + 8px);
    bottom: auto;
    right: 0;
    left: auto;
    width: min(230px, calc(100vw - 48px));
    max-width: calc(100vw - 48px);
    z-index: 40;
  }

  .sz-comm-stat:last-child .sz-comm-tip-text::after {
    top: auto;
    bottom: 100%;
    right: 10px;
    border-top-color: transparent;
    border-bottom-color: color-mix(in srgb, hsl(var(--bc)) 90%, hsl(var(--b1)));
  }
}

.sz-comm-tip-text em {
  font-style: normal;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-weight: 700;
  color: var(--sz-success);
}
.sz-comm-tip-text::after {
  content: '';
  position: absolute;
  top: 100%;
  right: 10px;
  border: 5px solid transparent;
  border-top-color: color-mix(in srgb, hsl(var(--bc)) 90%, hsl(var(--b1)));
}
.sz-comm-tip:hover .sz-comm-tip-text,
.sz-comm-tip:focus-visible .sz-comm-tip-text {
  opacity: 1;
  transform: translateY(0);
}
</style>
