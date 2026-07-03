<script setup lang="ts">
// 侧边栏导航项（与 DESIGN.md 一致：总览 / 实例 / 运维 > 文件分发）
const navItems = [
  { label: '总览', to: '/', icon: 'i-lucide-layout-dashboard' },
  { label: '实例', to: '/groups', icon: 'i-lucide-server' },
  {
    label: '运维',
    icon: 'i-lucide-wrench',
    defaultOpen: true,
    children: [
      { label: '文件分发', to: '/ops/dispatch', icon: 'i-lucide-send' },
    ],
  },
]
</script>

<template>
  <NuxtDashboardGroup class="bg-default">
    <!-- 侧边栏 -->
    <NuxtDashboardSidebar
      collapsible
      resizable
      :min-size="12"
      :default-size="16"
    >
      <template #header="{ collapsed }">
        <div class="flex items-center gap-2 overflow-hidden">
          <NuxtIcon
            name="i-lucide-boxes"
            class="size-6 shrink-0 text-primary"
          />
          <span
            v-if="!collapsed"
            class="truncate text-lg font-bold text-highlighted"
          >
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

      <template #footer="{ collapsed }">
        <NuxtDashboardSidebarCollapse v-if="!collapsed" />
        <NuxtDashboardSidebarCollapse v-else />
      </template>
    </NuxtDashboardSidebar>

    <!-- 主面板：顶部导航栏 + 内容区 -->
    <NuxtDashboardPanel id="main">
      <template #header>
        <NuxtDashboardNavbar title="miniops" :ui="{ title: 'text-base' }">
          <template #leading>
            <span class="ms-1 hidden text-sm text-muted lg:inline">
              MinIO 批量运维平台
            </span>
          </template>

          <template #right>
            <!-- 暗色模式切换 -->
            <NuxtColorModeButton />
          </template>
        </NuxtDashboardNavbar>
      </template>

      <template #body>
        <slot />
      </template>
    </NuxtDashboardPanel>
  </NuxtDashboardGroup>
</template>
