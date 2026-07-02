<script setup lang="ts">
import { ref } from 'vue'

const colorMode = useColorMode()
const isDark = computed({
  get: () => colorMode.value === 'dark',
  set: (v: boolean) => { colorMode.preference = v ? 'dark' : 'light' },
})

// 色盲友好模式：切换为高对比度的橙色/蓝色主色（通过 CSS 变量覆盖）
const cbFriendly = ref(false)
const cbStyle = ref<Record<string, string>>({})
watchEffect(() => {
  if (cbFriendly.value) {
    // 用橙(yellow→改为 amber) + 蓝(blue) 作为可区分的主/次色，提升色盲友好度
    cbStyle.value = {
      '--ui-color-primary-50': 'oklch(97% 0.04 75)',
      '--ui-color-primary-100': 'oklch(93% 0.06 75)',
      '--ui-color-primary-200': 'oklch(88% 0.09 75)',
      '--ui-color-primary-300': 'oklch(82% 0.12 75)',
      '--ui-color-primary-400': 'oklch(76% 0.15 75)',
      '--ui-color-primary-500': 'oklch(70% 0.17 75)',
      '--ui-color-primary-600': 'oklch(62% 0.16 75)',
      '--ui-color-primary-700': 'oklch(54% 0.14 75)',
      '--ui-color-primary-800': 'oklch(46% 0.11 75)',
      '--ui-color-primary-900': 'oklch(38% 0.09 75)',
      '--ui-color-primary-950': 'oklch(30% 0.07 75)',
    }
  } else {
    cbStyle.value = {}
  }
})

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
  <NuxtDashboardGroup :style="cbStyle" class="bg-default">
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
            <!-- 色盲友好切换 -->
            <NuxtTooltip :text="cbFriendly ? '关闭色盲友好模式' : '开启色盲友好模式'">
              <NuxtButton
                :icon="cbFriendly ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                :color="cbFriendly ? 'primary' : 'neutral'"
                :variant="cbFriendly ? 'soft' : 'ghost'"
                square
                aria-label="色盲友好模式"
                @click="cbFriendly = !cbFriendly"
              />
            </NuxtTooltip>

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
