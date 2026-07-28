<script setup lang="ts">
import { useWalletStore } from '@/stores';
import { useQRCode } from '@vueuse/integrations/useQRCode';
import { computed } from 'vue';
import { useRouter } from 'vue-router';

const walletStore = useWalletStore();
const router = useRouter();
// useQRCode needs a reactive source; empty string → blank data-url when disconnected
const address = computed(() => walletStore.currentAddress || '');
const qrcode = useQRCode(address);

function goPay() {
  // No external pay rail wired yet — send user to portfolio / connect flow.
  if (walletStore.currentAddress) {
    router.push('/wallet/portfolio');
  } else {
    // Open the shared connect modal (label[for=PingConnectWallet] in NavBarWallet)
    const el = document.querySelector('label[for="PingConnectWallet"]') as HTMLLabelElement | null;
    el?.click();
  }
}
</script>

<template>
  <div class="bg-base-100 p-4 rounded text-center max-w-md mx-auto">
    <div class="text-xl font-semibold text-center">Pay Me</div>
    <div
      v-if="walletStore.currentAddress"
      class="flex items-center justify-center mt-8 mb-4"
    >
      <img :src="qrcode" alt="QR Code" class="rounded-sm overflow-hidden" />
    </div>
    <div v-else class="mt-8 mb-4 text-sm opacity-60">
      Connect a wallet to show your receive address &amp; QR.
    </div>
    <div class="text-main break-all px-2">
      {{ walletStore.currentAddress || '—' }}
    </div>
    <div class="mt-4 mb-4">
      <button
        type="button"
        class="btn !bg-yes !border-yes text-white px-10"
        @click="goPay"
      >
        {{ walletStore.currentAddress ? 'Go To Portfolio' : 'Connect Wallet' }}
      </button>
    </div>
  </div>
</template>
