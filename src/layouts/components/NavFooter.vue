<script setup lang="ts">
import { Icon } from '@iconify/vue';
</script>

<template>
  <footer class="sz-footer mt-8 mb-3 rounded-2xl border border-base-content/10 bg-base-100 px-5 py-4 text-sm">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="font-semibold tracking-tight text-base-content">Shazoes Explorer</span>
          <span class="opacity-30">·</span>
          <span class="text-secondary">© {{ new Date().getFullYear() }}</span>
        </div>
        <div class="mt-0.5 text-[11px] text-secondary/80">
          Open source fork of ping-pub · GPL-2.0
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
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
  </footer>
</template>
