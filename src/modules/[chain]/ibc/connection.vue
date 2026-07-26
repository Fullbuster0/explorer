<script lang="ts" setup>
// Layout shell for /ibc/connection and /ibc/connection/:connection_id
// List UI lives in connection/index.vue; detail in connection/[connection_id].vue
</script>
<template>
  <div>
    <router-view :key="$route.fullPath" />
  </div>
</template>
