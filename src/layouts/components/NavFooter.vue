<script setup lang="ts">
import { Icon } from '@iconify/vue';
</script>

<template>
  <footer class="sz-footer mt-8 mb-2 rounded-xl border border-base-content/10 bg-base-100 px-5 py-5 text-sm">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-secondary">
        <span class="font-semibold text-base-content">Shazoes Explorer</span>
        <span class="opacity-40">·</span>
        <span>© {{ new Date().getFullYear() }}</span>
        <span class="opacity-40 hidden sm:inline">·</span>
        <span class="text-xs opacity-70">Open source fork of ping-pub (GPL-2.0)</span>
      </div>

      <!-- Connect -->
      <div class="flex items-center gap-2.5">
        <span class="mr-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-secondary">Connect</span>
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
          href="mailto:hello@shazoes.xyz"
          aria-label="Email"
          title="Email"
          class="sz-social"
        >
          <Icon icon="mdi:email-outline" />
        </a>
        <span class="mx-1 h-5 w-px bg-base-content/10"></span>
        <a
          class="text-[13px] font-medium text-secondary transition hover:text-primary"
          href="https://services.shazoes.xyz"
          target="_blank"
          rel="noopener noreferrer"
          >Services</a
        >
      </div>
    </div>
  </footer>
</template>
