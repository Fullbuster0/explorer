<template>
  <!-- footer -->
  <footer class="flex items-center h-12 mt-5 text-sm bg-gray-100 dark:bg-[#171d30] py-2 z-10 w-full">
    <div class="flex flex-1">
      &copy;&nbsp;
      {{ new Date().getFullYear() }}&nbsp; Shazoes Explorer · Built on&nbsp;
      <a class="link link-primary no-underline" href="https://github.com/ping-pub/explorer" target="_blank" rel="noopener noreferrer"
        >ping-pub</a
      >
    </div>
    <div class="hidden md:!block">
      <a
        class="link link-primary no-underline mr-4"
        href="https://github.com/Fullbuster0/explorer"
        target="_blank"
        rel="noopener noreferrer"
        >Github</a
      >
      <a
        class="link link-primary no-underline"
        href="https://services.shazoes.xyz"
        target="_blank"
        rel="noopener noreferrer"
        >Services</a
      >
    </div>
  </footer>
</template>
