<script setup lang="ts">
definePageMeta({ layout: 'default' })
</script>

<template>
  <NuxtDashboardPanel id="manage">
    <template #header>
      <AppNavbar title="实例管理" />
    </template>

    <template #body>
      <div class="flex h-full items-center justify-center">
        <div class="flex flex-col items-center gap-3 text-center">
          <NuxtIcon name="i-lucide-server" class="text-dimmed size-12" />
          <p class="text-muted">实例管理（待实现）</p>
        </div>
      </div>
    </template>
  </NuxtDashboardPanel>
</template>
