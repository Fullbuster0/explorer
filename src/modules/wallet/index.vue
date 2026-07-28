<script lang="ts" setup>
/**
 * Bare `/wallet` used to fall through with no page module and render a
 * broken chain-dashboard shell (audit WAL-01). Redirect to the accounts
 * helper — same destination as the header wallet dropdown.
 */
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
onMounted(() => {
  router.replace('/wallet/accounts');
});
</script>
<template>
  <div class="p-6 text-sm opacity-60">Redirecting to wallet accounts…</div>
</template>
