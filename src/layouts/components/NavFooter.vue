<script setup lang="ts">
import { Icon } from '@iconify/vue';
</script>

<template>
  <footer class="sz-footer mt-10 mb-4 overflow-hidden rounded-2xl border border-base-content/10">
    <div class="sz-footer-inner px-5 py-6 sm:px-7 sm:py-7">
      <div class="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <!-- brand -->
        <div class="min-w-0">
          <div class="flex items-center gap-3">
            <span class="sz-footer-mark">
              <img src="@/assets/logo.png" alt="Shazoes" class="h-7 w-7 object-contain" />
            </span>
            <div class="leading-tight">
              <div class="text-[15px] font-bold tracking-tight text-base-content">Shazoes Explorer</div>
              <div class="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-secondary">
                Cosmos multi-chain
              </div>
            </div>
          </div>
          <p class="mt-3 max-w-md text-[13px] leading-relaxed text-secondary">
            Clean multi-chain explorer for Cosmos networks — validators.
          </p>
        </div>

        <!-- connect -->
        <div class="flex flex-wrap items-center gap-2 sm:justify-end">
          <a
            href="https://x.com/shazoes"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X (Twitter)"
            title="X (Twitter)"
            class="sz-social"
          >
            <Icon icon="mdi:twitter" />
          </a>
          <a
            href="https://t.me/shazoes"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Telegram"
            title="Telegram"
            class="sz-social"
          >
            <Icon icon="mdi:telegram" />
          </a>
          <a
            href="http://discordapp.com/users/906483432811561000"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Discord"
            title="Discord"
            class="sz-social"
          >
            <Icon icon="mdi:discord" />
          </a>
          <a
            href="mailto:hello@shazoes.xyz"
            aria-label="Email"
            title="Email"
            class="sz-social"
          >
            <Icon icon="mdi:email-outline" />
          </a>
          <a
            href="https://services.shazoes.xyz"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 py-1.5 text-[12px] font-semibold text-primary transition hover:bg-primary/15"
          >
            <Icon icon="mdi:server" class="text-sm" />
            Services
          </a>
        </div>
      </div>

      <div class="sz-footer-bottom mt-6 flex flex-col gap-2 border-t border-base-content/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="text-[12px] text-secondary">
          © {{ new Date().getFullYear() }} Shazoes · Multi-chain Cosmos explorer
        </div>
        <div class="text-[11px] font-medium uppercase tracking-[0.14em] text-secondary/80">
          Built for validators
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.sz-footer {
  background:
    radial-gradient(700px 180px at 0% 0%, color-mix(in srgb, hsl(var(--p)) 12%, transparent), transparent 60%),
    color-mix(in srgb, hsl(var(--b1)) 92%, transparent);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset;
}
.sz-footer-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 6px 16px -8px rgba(0, 95, 204, 0.45);
  overflow: hidden;
  padding: 5px;
}
</style>
