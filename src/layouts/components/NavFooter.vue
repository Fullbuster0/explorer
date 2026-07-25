<template>
  <footer class="sz-footer mt-8 mb-2 rounded-xl border border-base-content/10 bg-base-100 px-4 py-4 text-sm">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-secondary">
        <span class="font-semibold text-base-content">Shazoes Explorer</span>
        <span class="opacity-40">·</span>
        <span>© {{ new Date().getFullYear() }}</span>
        <span class="opacity-40 hidden sm:inline">·</span>
        <span class="text-xs opacity-70">
          Open source fork of
          <a
            class="link link-hover text-primary"
            href="https://github.com/ping-pub/explorer"
            target="_blank"
            rel="noopener noreferrer"
            >ping-pub</a
          >
          (GPL-2.0)
        </span>
      </div>

      <div class="flex items-center gap-4 text-[13px] font-medium">
        <a
          class="text-secondary hover:text-primary transition"
          href="https://github.com/Fullbuster0/explorer"
          target="_blank"
          rel="noopener noreferrer"
          >GitHub</a
        >
        <a
          class="text-secondary hover:text-primary transition"
          href="https://services.shazoes.xyz"
          target="_blank"
          rel="noopener noreferrer"
          >Services</a
        >
      </div>
    </div>
  </footer>
</template>
