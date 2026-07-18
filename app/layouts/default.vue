<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const navItems = computed<NavigationMenuItem[]>(() => [
  { label: '实例管理', icon: 'i-lucide-server', to: '/manage' },
  { label: '实例访问', icon: 'i-lucide-folder-open', to: '/browse' },
])
</script>

<template>
  <NuxtDashboardGroup>
    <NuxtDashboardSidebar collapsible resizable :min-size="12" :default-size="16">
      <template #header="{ collapsed }">
        <div class="flex items-center gap-2 overflow-hidden">
          <NuxtIcon name="i-lucide-boxes" class="text-primary size-6 shrink-0" />
          <span v-if="!collapsed" class="text-highlighted truncate text-lg font-bold">
            miniops
          </span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <NuxtNavigationMenu
          :items="navItems"
          orientation="vertical"
          :collapsed="collapsed"
          popover
          :tooltip="{ delayDuration: 0, content: { side: 'right' } }"
          class="w-full"
        />
      </template>

      <template #footer>
        <NuxtDashboardSidebarCollapse />
      </template>
    </NuxtDashboardSidebar>

    <slot />
  </NuxtDashboardGroup>
</template>
