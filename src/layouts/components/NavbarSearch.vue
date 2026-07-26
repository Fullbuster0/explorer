<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useBlockchain } from '@/stores';
const vueRouters = useRouter();
const blockStore = useBlockchain();
let searchModalShow = ref(false);
let searchQuery = ref('');
let errorMessage = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

function closeSearchModal() {
  searchModalShow.value = false;
  errorMessage.value = '';
}
function openSearchModal() {
  searchModalShow.value = true;
  errorMessage.value = '';
  setTimeout(() => inputRef.value?.focus(), 30);
}

function preventClick(event: any) {
  event.preventDefault();
  event.stopPropagation();
}

function normalizeQuery(raw: string) {
  return String(raw || '').trim();
}

function confirm() {
  errorMessage.value = '';
  const key = normalizeQuery(searchQuery.value);
  if (!key) {
    errorMessage.value = 'Please enter a value!';
    return;
  }

  // height: pure digits
  const height = /^\d+$/;
  // tx hash: 64 hex chars (case-insensitive) — was broken on lowercase
  const txhash = /^[A-Fa-f0-9]{64}$/;
  // bech32 account / valoper / valcons: prefix + '1' + data
  const addr = /^[a-z0-9]{2,32}1[a-z0-9]{38,90}$/i;

  const current = blockStore?.current?.chainName || '';
  if (!current) {
    errorMessage.value = 'Select a chain first';
    return;
  }

  if (height.test(key)) {
    vueRouters.push({ path: `/${current}/block/${key}` });
    closeSearchModal();
    searchQuery.value = '';
  } else if (txhash.test(key)) {
    vueRouters.push({ path: `/${current}/tx/${key.toUpperCase()}` });
    closeSearchModal();
    searchQuery.value = '';
  } else if (addr.test(key)) {
    vueRouters.push({ path: `/${current}/account/${key}` });
    closeSearchModal();
    searchQuery.value = '';
  } else {
    errorMessage.value = 'Unrecognized input. Use address, tx hash, or block height.';
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearchModal();
  }
  if (e.key === 'Escape' && searchModalShow.value) {
    closeSearchModal();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>
<template>
  <div class="sz-navbar-search">
    <!-- Desktop: expanded search trigger -->
    <button
      type="button"
      class="sz-search-trigger hidden md:!inline-flex"
      @click="openSearchModal"
      aria-label="Search by address, tx hash, or height"
    >
      <Icon icon="mdi:magnify" class="text-lg text-secondary shrink-0" />
      <span class="sz-search-placeholder">Search by address, tx hash…</span>
      <kbd class="sz-search-kbd">⌘K</kbd>
    </button>

    <!-- Mobile: icon only -->
    <button
      type="button"
      class="btn btn-ghost btn-circle btn-sm mx-1 md:!hidden"
      @click="openSearchModal"
      aria-label="Search"
    >
      <Icon icon="mdi:magnify" class="text-2xl text-gray-500 dark:text-gray-400" />
    </button>

    <!-- modal -->
    <div
      v-if="searchModalShow"
      class="cursor-pointer modal !pointer-events-auto !opacity-100 !visible"
      @click="closeSearchModal"
    >
      <div class="relative modal-box cursor-default max-w-xl w-[min(92vw,36rem)]" @click="(event) => preventClick(event)">
        <div class="flex items-center justify-between gap-3">
          <div class="text-lg font-bold">Search</div>
          <label class="cursor-pointer" @click="closeSearchModal">
            <Icon icon="zondicons:close-outline" class="text-2xl text-gray-500 dark:text-gray-400" />
          </label>
        </div>
        <div class="mt-4">
          <input
            ref="inputRef"
            class="input input-bordered w-full h-12 text-base"
            v-model="searchQuery"
            placeholder="Search by address, tx hash..."
            @keyup.enter="confirm"
          />
          <div class="mt-2 text-right text-sm text-error" v-show="errorMessage">
            {{ errorMessage }}
          </div>
        </div>
        <div class="mt-6">
          <button class="w-full btn btn-primary" @click="confirm">Search</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sz-search-trigger {
  align-items: center;
  gap: 0.6rem;
  min-width: 17rem;
  max-width: 24rem;
  height: 2.35rem;
  padding: 0 0.85rem;
  border-radius: 999px;
  border: 1px solid var(--sz-border);
  background: color-mix(in srgb, hsl(var(--b1)) 94%, transparent);
  color: hsl(var(--bc));
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.sz-search-trigger:hover {
  border-color: color-mix(in srgb, hsl(var(--p)) 40%, transparent);
  box-shadow: 0 0 0 3px var(--sz-glow);
}
.sz-search-placeholder {
  flex: 1;
  text-align: left;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sz-search-kbd {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  line-height: 1;
  padding: 0.2rem 0.4rem;
  border-radius: 0.35rem;
  border: 1px solid var(--sz-border);
  color: var(--text-secondary);
  background: color-mix(in srgb, hsl(var(--b2)) 70%, transparent);
}
</style>
