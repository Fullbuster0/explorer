<script lang="ts" setup>
import { useDashboard } from '@/stores';
import { computed } from 'vue';

const props = defineProps({
  name: {
    type: String,
    required: true,
  },
  featured: {
    type: Boolean,
    default: false,
  },
});

const dashboardStore = useDashboard();
const conf = computed(() => dashboardStore.chains[props.name] || {});

const displayName = computed(() => {
  const pretty = conf.value?.prettyName || props.name;
  return String(pretty).replace(/[-_](mainnet|testnet)$/i, '');
});

const chainId = computed(() => conf.value?.chainId || '');

const isTest = computed(() => {
  const nt = (conf.value?.networkType || '').toLowerCase();
  return nt.includes('test') || /[-_]?test/i.test(props.name);
});
</script>

<template>
  <RouterLink
    :to="`/${name}`"
    class="sz-chain-card group relative flex items-center gap-3.5 rounded-xl border px-3.5 py-3.5 transition"
  >
    <div class="sz-chain-logo relative flex-shrink-0">
      <img
        :src="conf.logo"
        class="h-11 w-11 rounded-full object-cover ring-1 ring-base-content/10"
        alt=""
        loading="lazy"
      />
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <div class="truncate text-[14.5px] font-semibold tracking-tight text-base-content capitalize">
          {{ displayName }}
        </div>
        <span class="sz-netbadge" :class="isTest ? 'sz-netbadge--test' : 'sz-netbadge--main'">
          {{ isTest ? 'TEST' : 'MAIN' }}
        </span>
      </div>
      <div
        v-if="chainId"
        class="mt-0.5 truncate font-mono text-[11px] font-medium tracking-tight text-secondary"
        :title="chainId"
      >
        {{ chainId }}
      </div>
      <div
        v-else
        class="mt-0.5 truncate text-[11px] font-medium uppercase tracking-[0.14em] text-secondary"
      >
        {{ conf?.chainName || props.name }}
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
/* Solid matte card — clean, no glassmorphism, no rail */
.sz-chain-card {
  background: hsl(var(--b1));
  border-color: var(--sz-border);
  box-shadow: 0 1px 2px color-mix(in srgb, hsl(var(--bc)) 5%, transparent);
}
.sz-chain-card:hover {
  border-color: color-mix(in srgb, hsl(var(--p)) 35%, var(--sz-border));
  box-shadow: 0 4px 12px -6px var(--sz-glow);
}

.sz-netbadge {
  flex-shrink: 0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 0.14rem 0.4rem;
  border-radius: 999px;
  border: 1px solid transparent;
}
.sz-netbadge--main {
  color: var(--sz-success);
  background: color-mix(in srgb, var(--sz-success) 12%, transparent);
  border-color: color-mix(in srgb, var(--sz-success) 28%, transparent);
}
.sz-netbadge--test {
  color: var(--sz-warn);
  background: color-mix(in srgb, var(--sz-warn) 12%, transparent);
  border-color: color-mix(in srgb, var(--sz-warn) 28%, transparent);
}
</style>
