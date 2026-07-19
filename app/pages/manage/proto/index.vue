<script setup lang="ts">
import type { TableColumn, FormError } from '@nuxt/ui'
import { mockGroups, type MockInstance, type MockGroup } from './mock-data'

definePageMeta({ layout: 'default' })

// ==================== 数据 ====================
const groups = ref<MockGroup[]>(structuredClone(mockGroups))
const selectedGroupId = ref('grp-1')
const selectedGroup = computed(
  () => groups.value.find((g) => g.id === selectedGroupId.value) || null,
)

// 连通性测试状态
const testingInstances = ref<Set<string>>(new Set())
const testingGroups = ref<Set<string>>(new Set())
const groupSummaries = ref<Record<string, { online: number; offline: number; authError: number }>>(
  {},
)

// Toast
const toast = useToast()

// ==================== 表格列定义 ====================
const columns: TableColumn<MockInstance>[] = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'endpoint', header: 'Endpoint' },
  { accessorKey: 'enabled', header: '状态', meta: { class: { th: 'w-20', td: 'w-20' } } },
  { id: 'connectivity', header: '连通性', meta: { class: { th: 'w-40', td: 'w-40' } } },
  { id: 'actions', header: '操作', meta: { class: { th: 'w-80', td: 'w-80' } } },
]

// ==================== 分组表单 ====================
const groupModalOpen = ref(false)
const groupModalMode = ref<'create' | 'edit'>('create')
const groupEditingId = ref<string | null>(null)
const groupForm = reactive({ name: '', description: '' })
const groupFormRef = ref()
const groupSubmitting = ref(false)

function groupValidate(state: { name: string; description: string }): FormError<string>[] {
  const errors: FormError<string>[] = []
  if (!state.name.trim()) errors.push({ name: 'name', message: '名称不能为空' })
  return errors
}

function openGroupCreate() {
  groupModalMode.value = 'create'
  groupEditingId.value = null
  groupForm.name = ''
  groupForm.description = ''
  groupModalOpen.value = true
}

function openGroupEdit(group: MockGroup) {
  groupModalMode.value = 'edit'
  groupEditingId.value = group.id
  groupForm.name = group.name
  groupForm.description = group.description ?? ''
  groupModalOpen.value = true
}

async function onGroupSubmit() {
  groupSubmitting.value = true
  await new Promise((r) => setTimeout(r, 500))

  if (groupModalMode.value === 'create') {
    const newGroup: MockGroup = {
      id: `grp-${Date.now()}`,
      name: groupForm.name,
      description: groupForm.description || undefined,
      instances: [],
    }
    groups.value.push(newGroup)
    selectedGroupId.value = newGroup.id
    toast.add({
      title: '创建成功',
      description: `分组「${newGroup.name}」已创建`,
      color: 'success',
    })
  } else {
    const group = groups.value.find((g) => g.id === groupEditingId.value)
    if (group) {
      group.name = groupForm.name
      group.description = groupForm.description || undefined
      toast.add({ title: '修改成功', description: `分组「${group.name}」已更新`, color: 'success' })
    }
  }

  groupSubmitting.value = false
  groupModalOpen.value = false
}

// ==================== 实例表单 ====================
const instanceModalOpen = ref(false)
const instanceModalMode = ref<'create' | 'edit'>('create')
const instanceEditingGroupId = ref<string | null>(null)
const instanceEditingId = ref<string | null>(null)
const instanceForm = reactive({
  name: '',
  endpoint: '',
  accessKey: '',
  secretKey: '',
  enabled: true,
})
const instanceFormRef = ref()
const instanceSubmitting = ref(false)

function instanceValidate(state: {
  name: string
  endpoint: string
  accessKey: string
  secretKey: string
  enabled: boolean
}): FormError<string>[] {
  const errors: FormError<string>[] = []
  if (!state.name.trim()) errors.push({ name: 'name', message: '名称不能为空' })
  if (!state.endpoint.trim()) {
    errors.push({ name: 'endpoint', message: 'endpoint 不能为空' })
  } else {
    try {
      new URL(state.endpoint)
    } catch {
      errors.push({ name: 'endpoint', message: 'endpoint 必须是合法的 http(s):// 地址' })
    }
  }
  if (!state.accessKey.trim()) errors.push({ name: 'accessKey', message: 'accessKey 不能为空' })
  if (instanceModalMode.value === 'create' && !state.secretKey.trim()) {
    errors.push({ name: 'secretKey', message: 'secretKey 不能为空' })
  }
  return errors
}

function openInstanceCreate(groupId: string) {
  instanceModalMode.value = 'create'
  instanceEditingGroupId.value = groupId
  instanceEditingId.value = null
  instanceForm.name = ''
  instanceForm.endpoint = ''
  instanceForm.accessKey = ''
  instanceForm.secretKey = ''
  instanceForm.enabled = true
  instanceModalOpen.value = true
}

function openInstanceEdit(groupId: string, instance: MockInstance) {
  instanceModalMode.value = 'edit'
  instanceEditingGroupId.value = groupId
  instanceEditingId.value = instance.id
  instanceForm.name = instance.name
  instanceForm.endpoint = instance.endpoint
  instanceForm.accessKey = instance.accessKey || ''
  instanceForm.secretKey = ''
  instanceForm.enabled = instance.enabled
  instanceModalOpen.value = true
}

async function onInstanceSubmit() {
  instanceSubmitting.value = true
  await new Promise((r) => setTimeout(r, 500))

  const group = groups.value.find((g) => g.id === instanceEditingGroupId.value)
  if (!group) return

  if (instanceModalMode.value === 'create') {
    const newInstance: MockInstance = {
      id: `inst-${Date.now()}`,
      name: instanceForm.name,
      endpoint: instanceForm.endpoint,
      accessKey: instanceForm.accessKey,
      secretKey: instanceForm.secretKey,
      enabled: instanceForm.enabled,
      connectivity: null,
    }
    group.instances.push(newInstance)
    toast.add({
      title: '创建成功',
      description: `实例「${newInstance.name}」已添加`,
      color: 'success',
    })
  } else {
    const inst = group.instances.find((i) => i.id === instanceEditingId.value)
    if (inst) {
      inst.name = instanceForm.name
      inst.endpoint = instanceForm.endpoint
      inst.accessKey = instanceForm.accessKey || inst.accessKey
      if (instanceForm.secretKey) inst.secretKey = instanceForm.secretKey
      inst.enabled = instanceForm.enabled
      toast.add({ title: '修改成功', description: `实例「${inst.name}」已更新`, color: 'success' })
    }
  }

  instanceSubmitting.value = false
  instanceModalOpen.value = false
}

// ==================== 确认弹窗（删除） ====================
const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmDescription = ref('')
const confirmLoading = ref(false)
const confirmAction = ref<() => Promise<void>>(async () => {})

function openConfirm(title: string, description: string, action: () => Promise<void>) {
  confirmTitle.value = title
  confirmDescription.value = description
  confirmAction.value = action
  confirmOpen.value = true
}

async function onConfirm() {
  confirmLoading.value = true
  await confirmAction.value()
  confirmLoading.value = false
  confirmOpen.value = false
}

function deleteGroup(group: MockGroup) {
  openConfirm(
    '删除分组',
    `确定删除分组「${group.name}」？该分组下的 ${group.instances.length} 个实例将一并删除。`,
    async () => {
      const idx = groups.value.findIndex((g) => g.id === group.id)
      groups.value = groups.value.filter((g) => g.id !== group.id)
      // 如果删除的是选中的分组，自动选中第一个
      if (selectedGroupId.value === group.id) {
        selectedGroupId.value = groups.value[Math.min(idx, groups.value.length - 1)]?.id || ''
      }
      toast.add({ title: '删除成功', description: `分组「${group.name}」已删除`, color: 'success' })
    },
  )
}

function deleteInstance(group: MockGroup, instance: MockInstance) {
  openConfirm('删除实例', `确定删除实例「${instance.name}」？`, async () => {
    group.instances = group.instances.filter((i) => i.id !== instance.id)
    toast.add({
      title: '删除成功',
      description: `实例「${instance.name}」已删除`,
      color: 'success',
    })
  })
}

// ==================== 复制实例 ====================
async function duplicateInstance(group: MockGroup, instance: MockInstance) {
  const copy: MockInstance = {
    ...instance,
    id: `inst-${Date.now()}`,
    name: `${instance.name}(副本)`,
    connectivity: null,
    latency: undefined,
  }
  const idx = group.instances.findIndex((i) => i.id === instance.id)
  group.instances.splice(idx + 1, 0, copy)
  toast.add({ title: '复制成功', description: `实例「${instance.name}」已复制`, color: 'success' })
}

// ==================== 启用/禁用 ====================
function toggleEnabled(group: MockGroup, instance: MockInstance) {
  instance.enabled = !instance.enabled
  if (!instance.enabled) {
    instance.connectivity = null
  }
  toast.add({
    title: instance.enabled ? '已启用' : '已禁用',
    description: `实例「${instance.name}」${instance.enabled ? '已启用' : '已禁用'}`,
    color: 'success',
  })
}

// ==================== 连通性测试 ====================
function mockTestResult(instance: MockInstance): Pick<MockInstance, 'connectivity' | 'latency'> {
  if (instance.endpoint.includes('0.1'))
    return { connectivity: 'online', latency: Math.floor(Math.random() * 30) + 5 }
  if (instance.endpoint.includes('0.2')) return { connectivity: 'offline' }
  return { connectivity: 'auth-error' }
}

async function testInstance(group: MockGroup, instance: MockInstance) {
  testingInstances.value.add(instance.id)
  instance.connectivity = 'testing'
  await new Promise((r) => setTimeout(r, 1000))
  const result = mockTestResult(instance)
  instance.connectivity = result.connectivity
  instance.latency = result.latency
  testingInstances.value.delete(instance.id)
}

async function testGroup(group: MockGroup) {
  const enabledInstances = group.instances.filter((i) => i.enabled)
  if (!enabledInstances.length) return

  testingGroups.value.add(group.id)
  for (const inst of enabledInstances) {
    await testInstance(group, inst)
  }

  const summary = { online: 0, offline: 0, authError: 0 }
  for (const inst of group.instances) {
    if (inst.connectivity === 'online') summary.online++
    else if (inst.connectivity === 'offline') summary.offline++
    else if (inst.connectivity === 'auth-error') summary.authError++
  }
  groupSummaries.value[group.id] = summary
  testingGroups.value.delete(group.id)
}

function summaryLabel(s?: { online: number; offline: number; authError: number }): string {
  if (!s) return ''
  const parts: string[] = []
  if (s.online) parts.push(`${s.online}在线`)
  if (s.offline) parts.push(`${s.offline}离线`)
  if (s.authError) parts.push(`${s.authError}凭据异常`)
  return parts.join('·')
}

// ==================== 导入/导出/模板 ====================
function exportConfig() {
  const data = JSON.stringify(groups.value, null, 2)
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'miniops-groups-export.json'
  a.click()
  URL.revokeObjectURL(url)
  toast.add({ title: '导出成功', description: '配置已下载', color: 'success' })
}

function downloadTemplate() {
  const template = [
    {
      id: 'grp-example',
      name: '示例分组',
      description: '这是一个示例分组',
      isDefault: false,
      instances: [
        {
          id: 'inst-example',
          name: '示例实例',
          endpoint: 'http://127.0.0.1:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          enabled: true,
        },
      ],
    },
  ]
  const data = JSON.stringify(template, null, 2)
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'miniops-groups-template.json'
  a.click()
  URL.revokeObjectURL(url)
  toast.add({ title: '模板已下载', color: 'success' })
}

const importInput = ref<HTMLInputElement>()
const importLoading = ref(false)

function triggerImport() {
  importInput.value?.click()
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  importLoading.value = true
  await new Promise((r) => setTimeout(r, 800))

  try {
    const text = await file.text()
    const data = JSON.parse(text) as MockGroup[]

    if (!Array.isArray(data)) throw new Error('导入数据必须是数组')

    let added = 0
    let updated = 0
    for (const impGroup of data) {
      const existing = groups.value.find((g) => g.id === impGroup.id)
      if (existing) {
        existing.name = impGroup.name
        existing.description = impGroup.description
        existing.instances = impGroup.instances
        updated++
      } else {
        groups.value.push({ ...impGroup, instances: impGroup.instances || [] })
        added++
      }
    }

    toast.add({
      title: '导入成功',
      description: `新增 ${added} 个，更新 ${updated} 个`,
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: '导入失败',
      description: e instanceof Error ? e.message : '文件格式错误',
      color: 'error',
    })
  }

  importLoading.value = false
  input.value = ''
}
</script>

<template>
  <NuxtDashboardPanel id="manage-proto">
    <template #header>
      <AppNavbar title="实例管理（原型）" />
    </template>

    <template #body>
      <!-- 页头 -->
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="text-highlighted text-2xl font-bold">实例管理</h1>
          <p class="text-muted">管理实例组与组内 MinIO 实例</p>
        </div>
        <div class="flex items-center gap-2">
          <NuxtButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-file-down"
            @click="downloadTemplate"
          >
            模板
          </NuxtButton>
          <NuxtButton
            color="neutral"
            variant="outline"
            icon="i-lucide-download"
            :loading="importLoading"
            @click="triggerImport"
          >
            导入
          </NuxtButton>
          <NuxtButton
            color="neutral"
            variant="outline"
            icon="i-lucide-upload"
            @click="exportConfig"
          >
            导出
          </NuxtButton>
          <NuxtButton color="primary" icon="i-lucide-plus" @click="openGroupCreate">
            新建组
          </NuxtButton>
        </div>
      </div>

      <!-- 两栏布局 -->
      <div class="flex gap-3 flex-1 min-h-0">
        <!-- 左侧：分组列表 -->
        <div class="border-default bg-default flex w-56 shrink-0 flex-col overflow-y-auto rounded-lg border">
          <div class="flex flex-col gap-0.5 p-2">
            <div
              v-for="group in groups"
              :key="group.id"
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5"
              :class="selectedGroupId === group.id ? 'bg-elevated' : 'hover:bg-elevated/50'"
              @click="selectedGroupId = group.id"
            >
              <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
              <span class="truncate text-sm font-medium">{{ group.name }}</span>
              <NuxtBadge v-if="group.isDefault" color="neutral" variant="outline" size="sm">
                内置
              </NuxtBadge>
              <NuxtBadge color="neutral" variant="subtle" size="sm" class="ml-auto">
                {{ group.instances.length }}
              </NuxtBadge>
            </div>
          </div>
        </div>

        <!-- 右侧：选中分组详情 -->
        <div v-if="selectedGroup" class="border-default bg-default flex-1 overflow-y-auto rounded-lg border">
          <!-- 分组标题行 -->
          <div class="flex items-center gap-3 p-3">
            <NuxtIcon name="i-lucide-folder" class="text-primary size-5 shrink-0" />
            <span class="text-highlighted font-semibold">{{ selectedGroup.name }}</span>
            <NuxtBadge v-if="selectedGroup.isDefault" color="neutral" variant="outline" size="sm">
              内置
            </NuxtBadge>
            <NuxtBadge color="neutral" variant="subtle" size="sm">
              {{ selectedGroup.instances.length }} 个实例
            </NuxtBadge>
            <NuxtBadge
              v-if="groupSummaries[selectedGroup.id]"
              color="neutral"
              variant="subtle"
              size="sm"
            >
              {{ summaryLabel(groupSummaries[selectedGroup.id]) }}
            </NuxtBadge>

            <div class="ml-auto flex items-center gap-1">
              <NuxtButton
                v-if="selectedGroup.instances.length"
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-activity"
                :label="testingGroups.has(selectedGroup.id) ? '测试中...' : '测试全部'"
                :loading="testingGroups.has(selectedGroup.id)"
                @click="testGroup(selectedGroup)"
              />
              <NuxtButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-plus"
                label="添加实例"
                @click="openInstanceCreate(selectedGroup.id)"
              />
              <NuxtButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                @click="openGroupEdit(selectedGroup)"
              />
              <NuxtButton
                v-if="!selectedGroup.isDefault"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                @click="deleteGroup(selectedGroup)"
              />
            </div>
          </div>

          <!-- 实例表格 -->
          <div class="border-default border-t p-3">
            <NuxtTable
              v-if="selectedGroup.instances.length"
              :data="selectedGroup.instances"
              :columns="columns"
            >
              <template #name-cell="{ row }">
                <span class="font-medium" :class="{ 'text-dimmed': !row.original.enabled }">
                  {{ row.original.name }}
                </span>
              </template>

              <template #endpoint-cell="{ row }">
                <span class="text-muted font-mono text-xs">{{ row.original.endpoint }}</span>
              </template>

              <template #enabled-cell="{ row }">
                <NuxtBadge
                  :color="row.original.enabled ? 'success' : 'neutral'"
                  :variant="row.original.enabled ? 'soft' : 'outline'"
                >
                  {{ row.original.enabled ? '启用' : '禁用' }}
                </NuxtBadge>
              </template>

              <template #connectivity-cell="{ row }">
                <NuxtIcon
                  v-if="row.original.connectivity === 'testing'"
                  name="i-lucide-loader-circle"
                  class="text-muted size-4 animate-spin"
                />
                <span v-else-if="!row.original.connectivity" class="text-muted text-xs">-</span>
                <NuxtTooltip v-else-if="row.original.connectivity === 'offline'" text="连接超时">
                  <NuxtBadge color="error" variant="outline">不可达</NuxtBadge>
                </NuxtTooltip>
                <NuxtTooltip
                  v-else-if="row.original.connectivity === 'auth-error'"
                  text="403 Access Denied"
                >
                  <div class="flex items-center gap-1">
                    <NuxtBadge color="warning" variant="soft">在线</NuxtBadge>
                    <NuxtIcon
                      name="i-lucide-triangle-alert"
                      class="text-warning size-3.5 shrink-0"
                    />
                  </div>
                </NuxtTooltip>
                <div v-else class="flex items-center gap-1">
                  <NuxtBadge color="success" variant="soft">在线</NuxtBadge>
                  <span v-if="row.original.latency" class="text-muted text-xs"
                    >{{ row.original.latency }}ms</span
                  >
                </div>
              </template>

              <template #actions-cell="{ row }">
                <div class="flex items-center gap-1">
                  <NuxtTooltip text="测试连通性">
                    <NuxtButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-activity"
                      :loading="testingInstances.has(row.original.id)"
                      @click="testInstance(selectedGroup, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip :text="row.original.enabled ? '浏览对象' : '请先启用实例'">
                    <NuxtButton
                      size="xs"
                      color="info"
                      variant="soft"
                      icon="i-lucide-folder-search"
                      :disabled="!row.original.enabled"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip text="编辑">
                    <NuxtButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-pencil"
                      @click="openInstanceEdit(selectedGroup.id, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip text="复制">
                    <NuxtButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-copy"
                      @click="duplicateInstance(selectedGroup, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip :text="row.original.enabled ? '禁用' : '启用'">
                    <NuxtButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :icon="row.original.enabled ? 'i-lucide-power-off' : 'i-lucide-circle-check'"
                      @click="toggleEnabled(selectedGroup, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip text="删除">
                    <NuxtButton
                      size="xs"
                      color="error"
                      variant="ghost"
                      icon="i-lucide-trash-2"
                      @click="deleteInstance(selectedGroup, row.original)"
                    />
                  </NuxtTooltip>
                </div>
              </template>
            </NuxtTable>

            <div v-else class="text-muted flex items-center gap-2 py-6">
              <NuxtIcon name="i-lucide-inbox" class="size-5" />
              <span>该组暂无实例，点击右上角"添加实例"开始添加。</span>
            </div>
          </div>
        </div>

        <!-- 无选中分组占位 -->
        <div v-else class="flex flex-1 items-center justify-center">
          <p class="text-muted">请在左侧选择分组</p>
        </div>
      </div>

      <!-- 隐藏的导入文件选择 -->
      <input ref="importInput" type="file" accept=".json" class="hidden" @change="onImportFile" />

      <!-- 分组表单弹窗 -->
      <NuxtModal v-model:open="groupModalOpen" title="分组" :dismissible="!groupSubmitting">
        <template #body>
          <NuxtForm
            ref="groupFormRef"
            :state="groupForm"
            :validate="groupValidate"
            @submit="onGroupSubmit"
          >
            <NuxtFormField label="名称" name="name" required>
              <NuxtInput v-model="groupForm.name" placeholder="分组名称" class="w-full" />
            </NuxtFormField>
            <NuxtFormField label="描述" name="description" class="mt-4">
              <NuxtTextarea
                v-model="groupForm.description"
                placeholder="分组描述（可选）"
                class="w-full"
              />
            </NuxtFormField>
          </NuxtForm>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2">
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              :disabled="groupSubmitting"
              @click="
                () => {
                  groupModalOpen = false
                }
              "
            />
            <NuxtButton
              color="primary"
              label="确定"
              :loading="groupSubmitting"
              @click="groupFormRef?.submit()"
            />
          </div>
        </template>
      </NuxtModal>

      <!-- 实例表单弹窗 -->
      <NuxtModal v-model:open="instanceModalOpen" title="实例" :dismissible="!instanceSubmitting">
        <template #body>
          <NuxtForm
            ref="instanceFormRef"
            :state="instanceForm"
            :validate="instanceValidate"
            @submit="onInstanceSubmit"
          >
            <NuxtFormField label="名称" name="name" required>
              <NuxtInput v-model="instanceForm.name" placeholder="实例名称" class="w-full" />
            </NuxtFormField>
            <NuxtFormField label="Endpoint" name="endpoint" required class="mt-4">
              <NuxtInput
                v-model="instanceForm.endpoint"
                placeholder="http://127.0.0.1:9000"
                class="w-full"
              />
            </NuxtFormField>
            <NuxtFormField label="Access Key" name="accessKey" required class="mt-4">
              <NuxtInput v-model="instanceForm.accessKey" placeholder="accessKey" class="w-full" />
            </NuxtFormField>
            <NuxtFormField
              :label="instanceModalMode === 'edit' ? 'Secret Key（留空不修改）' : 'Secret Key'"
              name="secretKey"
              :required="instanceModalMode === 'create'"
              class="mt-4"
            >
              <NuxtInput
                v-model="instanceForm.secretKey"
                type="password"
                :placeholder="instanceModalMode === 'edit' ? '••••••••' : 'secretKey'"
                class="w-full"
              />
            </NuxtFormField>
            <NuxtFormField label="启用" name="enabled" class="mt-4">
              <NuxtSwitch v-model="instanceForm.enabled" />
            </NuxtFormField>
          </NuxtForm>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2">
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              :disabled="instanceSubmitting"
              @click="
                () => {
                  instanceModalOpen = false
                }
              "
            />
            <NuxtButton
              color="primary"
              label="确定"
              :loading="instanceSubmitting"
              @click="instanceFormRef?.submit()"
            />
          </div>
        </template>
      </NuxtModal>

      <!-- 确认弹窗 -->
      <NuxtModal v-model:open="confirmOpen" :dismissible="!confirmLoading">
        <template #header>
          <div class="flex items-center gap-2">
            <NuxtIcon name="i-lucide-triangle-alert" class="text-error size-5" />
            <span class="text-highlighted font-semibold">{{ confirmTitle }}</span>
          </div>
        </template>
        <template #body>
          <p class="text-muted">{{ confirmDescription }}</p>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2">
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              :disabled="confirmLoading"
              @click="
                () => {
                  confirmOpen = false
                }
              "
            />
            <NuxtButton
              color="error"
              label="确认删除"
              :loading="confirmLoading"
              @click="onConfirm"
            />
          </div>
        </template>
      </NuxtModal>
    </template>
  </NuxtDashboardPanel>
</template>
