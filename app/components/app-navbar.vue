<script setup lang="ts">
defineProps<{ title?: string }>()
</script>

<template>
  <NuxtDashboardNavbar :title="title">
    <template #leading>
      <span class="text-muted ms-1 hidden text-sm lg:inline"> MinIO 批量运维平台 </span>
    </template>
    <template #right>
      <NuxtColorModeButton />
    </template>
  </NuxtDashboardNavbar>
</template>
