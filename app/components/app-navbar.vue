<script setup lang="ts">
defineProps<{ title?: string }>()
</script>

<template>
  <NuxtDashboardNavbar :title="title">
    <template #leading>
      <span class="text-muted ms-1 hidden text-sm lg:inline">S3 对象存储运维平台</span>
    </template>
    <template #right>
      <StagingManagerButton />
      <TaskViewerButton />
      <NuxtColorModeButton />
    </template>
  </NuxtDashboardNavbar>
</template>
