<script setup lang="ts">
import * as v from 'valibot'
import type { TableColumn } from '@nuxt/ui'
import ConfirmDialog from '~/components/ConfirmDialog.vue'

interface MinioInstance {
  id: string
  groupId: string
  name: string
  endpoint: string
  accessKey: string
  secretKey: string
  bucket?: string
  enabled: boolean
}
interface InstanceGroup {
  id: string
  name: string
  description?: string
  instances: MinioInstance[]
  isDefault?: boolean
  createdAt: string
  updatedAt: string
}
interface ConnectivityResult {
  instanceId: string
  instanceName: string
  endpoint: string
  online: boolean
  latency?: number
  error?: string
}

// ---------- 数据获取 ----------
const { data: groups, refresh, pending } = await useFetch<InstanceGroup[]>('/api/groups', {
  default: () => [],
})

// 每个组是否展开（展示组内实例）
const expanded = ref<Record<string, boolean>>({})

// ---------- 连通性测试 ----------
// 按 instanceId 存储测试结果
const connectivity = ref<Record<string, ConnectivityResult>>({})
const testing = ref<Record<string, boolean>>({}) // 单实例测试中
const testingGroup = ref<Record<string, boolean>>({}) // 全组测试中

async function testOne(groupId: string, inst: MinioInstance) {
  testing.value[inst.id] = true
  try {
    const results = await $fetch<ConnectivityResult[]>(`/api/groups/${groupId}/test`, {
      method: 'POST',
      query: { instanceId: inst.id },
    })
    if (results[0]) connectivity.value[inst.id] = results[0]
  }
  catch (e: any) {
    const toast = useToast()
    toast.add({ title: '测试失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
  finally {
    testing.value[inst.id] = false
  }
}

async function testAll(g: InstanceGroup) {
  if (!g.instances.length) return
  testingGroup.value[g.id] = true
  try {
    const results = await $fetch<ConnectivityResult[]>(`/api/groups/${g.id}/test`, {
      method: 'POST',
    })
    for (const r of results) connectivity.value[r.instanceId] = r
  }
  catch (e: any) {
    const toast = useToast()
    toast.add({ title: '测试失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
  finally {
    testingGroup.value[g.id] = false
  }
}

// ---------- 导入 / 导出 ----------
const importInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)

function triggerImport() {
  importInput.value?.click()
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importing.value = true
  const toast = useToast()
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    const result = await $fetch<{ added: number; updated: number }>('/api/groups/import', {
      method: 'POST', body: data,
    })
    await refresh()
    toast.add({
      title: '导入成功',
      description: `新增 ${result.added} 条，更新 ${result.updated} 条`,
      color: 'success',
    })
  }
  catch (e: any) {
    toast.add({ title: '导入失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
  finally {
    importing.value = false
    // 重置 input，允许重复选同一文件
    input.value = ''
  }
}

async function onExport() {
  const toast = useToast()
  try {
    const blob = await $fetch<Blob>('/api/groups/export', { responseType: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'miniops-groups-export.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  catch (e: any) {
    toast.add({ title: '导出失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}

async function onDownloadTemplate() {
  const toast = useToast()
  try {
    const blob = await $fetch<Blob>('/api/groups/template', { responseType: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'miniops-groups-template.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  catch (e: any) {
    toast.add({ title: '下载失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}

// ---------- 组表单 ----------
const groupModalOpen = ref(false)
const editingGroup = ref<InstanceGroup | null>(null)
const groupState = reactive<{ name: string; description?: string }>({ name: '', description: '' })
const groupSaving = ref(false)

const groupSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, '组名称不能为空')),
})

function openCreateGroup() {
  editingGroup.value = null
  groupState.name = ''
  groupState.description = ''
  groupModalOpen.value = true
}
function openEditGroup(g: InstanceGroup) {
  editingGroup.value = g
  groupState.name = g.name
  groupState.description = g.description ?? ''
  groupModalOpen.value = true
}

async function onSubmitGroup() {
  groupSaving.value = true
  try {
    if (editingGroup.value) {
      await $fetch(`/api/groups/${editingGroup.value.id}`, {
        method: 'PUT',
        body: { name: groupState.name, description: groupState.description },
      })
    }
    else {
      await $fetch('/api/groups', {
        method: 'POST',
        body: { name: groupState.name, description: groupState.description },
      })
    }
    groupModalOpen.value = false
    await refresh()
  }
  catch (e: any) {
    const msg = e?.data?.statusMessage || e?.statusMessage || '保存失败'
    const toast = useToast()
    toast.add({ title: '错误', description: msg, color: 'error' })
  }
  finally {
    groupSaving.value = false
  }
}

async function onDeleteGroup(g: InstanceGroup) {
  const toast = useToast()
  const overlay = useOverlay()
  const modal = overlay.create(ConfirmDialog, { destroyOnClose: true })
  const confirm = await modal.open({
    title: '删除实例组',
    description: `确定删除「${g.name}」？组内 ${g.instances.length} 个实例将一并删除，此操作不可恢复。`,
    confirmText: '删除',
    confirmColor: 'error',
    confirmIcon: 'i-lucide-trash-2',
  })
  if (!confirm) return
  try {
    await $fetch(`/api/groups/${g.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: '已删除', description: g.name, color: 'success' })
  }
  catch (e: any) {
    toast.add({ title: '删除失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}

// ---------- 实例表单 ----------
const instanceModalOpen = ref(false)
const instanceGroupId = ref<string>('')
const editingInstance = ref<MinioInstance | null>(null)
const instanceState = reactive<{
  name: string
  endpoint: string
  accessKey: string
  secretKey: string
  bucket?: string
  enabled: boolean
}>({
  name: '', endpoint: '', accessKey: '', secretKey: '', bucket: '', enabled: true,
})
// Secret Key 可见性切换
const secretVisible = ref(false)
const instanceSaving = ref(false)

const instanceSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, '实例名称不能为空')),
  endpoint: v.pipe(
    v.string(),
    v.minLength(1, 'endpoint 不能为空'),
    v.url('endpoint 必须是合法 URL'),
    v.regex(/^https?:\/\//, 'endpoint 必须以 http:// 或 https:// 开头'),
  ),
  accessKey: v.pipe(v.string(), v.minLength(1, 'accessKey 不能为空')),
  secretKey: v.pipe(v.string(), v.minLength(1, 'secretKey 不能为空')),
})

function openCreateInstance(groupId: string) {
  instanceGroupId.value = groupId
  editingInstance.value = null
  Object.assign(instanceState, {
    name: '', endpoint: '', accessKey: '', secretKey: '', bucket: '', enabled: true,
  })
  instanceModalOpen.value = true
}
function openEditInstance(groupId: string, inst: MinioInstance) {
  instanceGroupId.value = groupId
  editingInstance.value = inst
  Object.assign(instanceState, {
    name: inst.name,
    endpoint: inst.endpoint,
    accessKey: inst.accessKey,
    secretKey: inst.secretKey,
    bucket: inst.bucket ?? '',
    enabled: inst.enabled,
  })
  instanceModalOpen.value = true
}

async function onSubmitInstance() {
  instanceSaving.value = true
  const toast = useToast()
  try {
    const payload = {
      name: instanceState.name,
      endpoint: instanceState.endpoint,
      accessKey: instanceState.accessKey,
      secretKey: instanceState.secretKey,
      bucket: instanceState.bucket || undefined,
      enabled: instanceState.enabled,
    }
    if (editingInstance.value) {
      await $fetch(`/api/groups/${instanceGroupId.value}/instances/${editingInstance.value.id}`, {
        method: 'PUT', body: payload,
      })
    }
    else {
      await $fetch(`/api/groups/${instanceGroupId.value}/instances`, {
        method: 'POST', body: payload,
      })
    }
    instanceModalOpen.value = false
    await refresh()
  }
  catch (e: any) {
    toast.add({ title: '错误', description: e?.data?.statusMessage || e?.statusMessage || '保存失败', color: 'error' })
  }
  finally {
    instanceSaving.value = false
  }
}

async function onDeleteInstance(groupId: string, inst: MinioInstance) {
  const toast = useToast()
  const overlay = useOverlay()
  const modal = overlay.create(ConfirmDialog, { destroyOnClose: true })
  const confirm = await modal.open({
    title: '删除实例',
    description: `确定删除实例「${inst.name}」？此操作不可恢复。`,
    confirmText: '删除',
    confirmColor: 'error',
    confirmIcon: 'i-lucide-trash-2',
  })
  if (!confirm) return
  try {
    await $fetch(`/api/groups/${groupId}/instances/${inst.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: '已删除', description: inst.name, color: 'success' })
  }
  catch (e: any) {
    toast.add({ title: '删除失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}

async function onDuplicateInstance(groupId: string, inst: MinioInstance) {
  const toast = useToast()
  try {
    await $fetch(`/api/groups/${groupId}/instances/${inst.id}/duplicate`, { method: 'POST' })
    await refresh()
    toast.add({ title: '已复制', description: `${inst.name} → 副本`, color: 'success' })
  }
  catch (e: any) {
    toast.add({ title: '复制失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}

async function onToggleEnabled(g: InstanceGroup, inst: MinioInstance) {
  try {
    await $fetch(`/api/groups/${g.id}/instances/${inst.id}`, {
      method: 'PUT',
      body: { enabled: !inst.enabled },
    })
    await refresh()
  }
  catch (e: any) {
    const toast = useToast()
    toast.add({ title: '操作失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}

// ---------- 表格列定义 ----------
// expand 列：展开/收起按钮
const groupColumns: TableColumn<InstanceGroup>[] = [
  {
    id: 'expand',
    header: '',
    cell: ({ row }) => {
      const g = row.original as InstanceGroup
      return h('button', {
        class: 'flex size-6 items-center justify-center rounded text-muted hover:bg-accented',
        onClick: () => { expanded.value[g.id] = !expanded.value[g.id] },
        'aria-label': '展开/收起',
      }, [
        h(resolveComponent('NuxtIcon'), {
          name: expanded.value[g.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right',
          class: 'size-4',
        }),
      ])
    },
    meta: { class: { th: 'w-8', td: 'w-8' } },
  },
  { accessorKey: 'name', header: '组名称', cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, (row.original as InstanceGroup).name) },
  { accessorKey: 'description', header: '描述', cell: ({ row }) => h('span', { class: 'text-muted' }, (row.original as InstanceGroup).description || '—') },
  {
    id: 'count',
    header: '实例数',
    cell: ({ row }) => h(NuxtBadge, { color: 'neutral', variant: 'subtle' }, () => String((row.original as InstanceGroup).instances.length)),
    meta: { class: { th: 'w-24', td: 'w-24' } },
  },
  {
    id: 'actions',
    header: '操作',
    cell: ({ row }) => {
      const g = row.original as InstanceGroup
      return h('div', { class: 'flex items-center gap-1' }, [
        h(NuxtButton, {
          size: 'xs', color: 'neutral', variant: 'ghost', icon: 'i-lucide-plus',
          label: '加实例',
          onClick: (e: Event) => { e.stopPropagation(); openCreateInstance(g.id) },
        }),
        h(NuxtButton, {
          size: 'xs', color: 'neutral', variant: 'ghost', icon: 'i-lucide-pencil',
          onClick: (e: Event) => { e.stopPropagation(); openEditGroup(g) },
        }),
        g.isDefault
          ? h('span', { class: 'text-xs text-muted px-1' }, '内置')
          : h(NuxtButton, {
              size: 'xs', color: 'error', variant: 'ghost', icon: 'i-lucide-trash-2',
              onClick: (e: Event) => { e.stopPropagation(); onDeleteGroup(g) },
            }),
      ])
    },
    meta: { class: { th: 'w-56', td: 'w-56' } },
  },
]

const instanceColumns: TableColumn<MinioInstance>[] = [
  { accessorKey: 'name', header: '名称', cell: ({ row }) => h('span', { class: 'font-medium' }, (row.original as MinioInstance).name) },
  { accessorKey: 'endpoint', header: 'Endpoint', cell: ({ row }) => h('span', { class: 'font-mono text-xs text-muted' }, (row.original as MinioInstance).endpoint) },
  { accessorKey: 'bucket', header: 'Bucket', cell: ({ row }) => h('span', { class: 'text-muted' }, (row.original as MinioInstance).bucket || '—') },
  {
    id: 'enabled',
    header: '状态',
    cell: ({ row }) => {
      const inst = row.original as MinioInstance
      return h(NuxtBadge, {
        color: inst.enabled ? 'success' : 'neutral',
        variant: inst.enabled ? 'soft' : 'outline',
      }, () => inst.enabled ? '启用' : '禁用')
    },
    meta: { class: { th: 'w-20', td: 'w-20' } },
  },
  {
    id: 'connectivity',
    header: '连通性',
    cell: ({ row }) => {
      const inst = row.original as MinioInstance
      const r = connectivity.value[inst.id]
      const isLoading = testing.value[inst.id]
      if (isLoading) {
        return h(NuxtIcon, { name: 'i-lucide-loader-circle', class: 'size-4 animate-spin text-muted' })
      }
      if (!r) return h('span', { class: 'text-muted text-xs' }, '—')
      return h('div', { class: 'flex items-center gap-1' }, [
        h(NuxtBadge, {
          color: r.online ? 'success' : 'error',
          variant: r.online ? 'soft' : 'outline',
          size: 'sm',
        }, () => r.online ? '在线' : '离线'),
        r.online && r.latency != null
          ? h('span', { class: 'text-xs text-muted' }, `${r.latency}ms`)
          : r.error ? h('span', { class: 'text-xs text-muted truncate max-w-32', title: r.error }, r.error) : null,
      ])
    },
    meta: { class: { th: 'w-40', td: 'w-40' } },
  },
  {
    id: 'actions',
    header: '操作',
    cell: ({ row }) => {
      const inst = row.original as MinioInstance
      const groupId = inst.groupId
      return h('div', { class: 'flex items-center gap-1' }, [
        h(NuxtButton, {
          size: 'xs', color: 'neutral', variant: 'ghost', icon: 'i-lucide-activity',
          loading: testing.value[inst.id],
          label: '测试',
          onClick: () => testOne(groupId, inst),
        }),
        h(NuxtButton, {
          size: 'xs', color: 'neutral', variant: 'ghost',
          label: inst.enabled ? '禁用' : '启用',
          icon: inst.enabled ? 'i-lucide-circle-off' : 'i-lucide-circle-check',
          onClick: () => onToggleEnabled({ id: groupId } as InstanceGroup, inst),
        }),
        h(NuxtButton, {
          size: 'xs', color: 'neutral', variant: 'ghost', icon: 'i-lucide-pencil',
          onClick: () => openEditInstance(groupId, inst),
        }),
        h(NuxtButton, {
          size: 'xs', color: 'neutral', variant: 'ghost', icon: 'i-lucide-copy',
          onClick: () => onDuplicateInstance(groupId, inst),
        }),
        h(NuxtButton, {
          size: 'xs', color: 'error', variant: 'ghost', icon: 'i-lucide-trash-2',
          onClick: () => onDeleteInstance(groupId, inst),
        }),
      ])
    },
    meta: { class: { th: 'w-72', td: 'w-72' } },
  },
]
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 页头 -->
    <div class="flex items-center justify-between gap-4">
      <div class="flex flex-col gap-1">
        <h1 class="text-2xl font-bold text-highlighted">实例</h1>
        <p class="text-muted">管理实例组与组内 MinIO 实例</p>
      </div>
      <div class="flex items-center gap-2">
        <NuxtTooltip text="下载配置模板，了解 JSON 格式或作为批量创建起点">
          <NuxtButton color="neutral" variant="ghost" icon="i-lucide-file-down" @click="onDownloadTemplate">
            模板
          </NuxtButton>
        </NuxtTooltip>
        <NuxtButton color="neutral" variant="outline" icon="i-lucide-download" :loading="importing" @click="triggerImport">
          导入
        </NuxtButton>
        <NuxtButton color="neutral" variant="outline" icon="i-lucide-upload" @click="onExport">
          导出
        </NuxtButton>
        <NuxtButton color="primary" icon="i-lucide-plus" @click="openCreateGroup">
          新建组
        </NuxtButton>
      </div>
      <input
        ref="importInput"
        type="file"
        accept=".json"
        class="hidden"
        @change="onImportFile"
      />
    </div>

    <!-- 组列表（可展开） -->
    <div class="flex flex-col gap-3">
      <div v-if="pending && !groups?.length" class="text-muted">加载中…</div>

      <template v-for="g in groups" :key="g.id">
        <!-- 组行：卡片化，避免 Table 嵌套展开的复杂度 -->
        <div class="rounded-lg border border-default bg-default">
          <div class="flex items-center gap-3 p-3">
            <button
              class="flex size-7 items-center justify-center rounded text-muted hover:bg-accented"
              :aria-label="expanded[g.id] ? '收起' : '展开'"
              @click="expanded[g.id] = !expanded[g.id]"
            >
              <NuxtIcon
                :name="expanded[g.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="size-4"
              />
            </button>
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <NuxtIcon name="i-lucide-folder" class="size-4 shrink-0 text-primary" />
              <span class="truncate font-semibold text-highlighted">{{ g.name }}</span>
              <NuxtBadge v-if="g.isDefault" color="neutral" variant="outline" size="sm">内置</NuxtBadge>
              <NuxtBadge color="neutral" variant="subtle" size="sm">{{ g.instances.length }} 个实例</NuxtBadge>
            </div>
            <div class="flex items-center gap-1">
              <NuxtButton
                v-if="g.instances.length"
                size="xs" color="neutral" variant="ghost"
                icon="i-lucide-activity"
                label="测试全部"
                :loading="testingGroup[g.id]"
                @click="testAll(g)"
              />
              <NuxtButton size="xs" color="neutral" variant="ghost" icon="i-lucide-plus" label="加实例" @click="openCreateInstance(g.id)" />
              <NuxtButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" @click="openEditGroup(g)" />
              <NuxtButton
                v-if="!g.isDefault"
                size="xs" color="error" variant="ghost" icon="i-lucide-trash-2"
                @click="onDeleteGroup(g)"
              />
            </div>
          </div>

          <!-- 展开后的实例表 -->
          <div v-if="expanded[g.id]" class="border-t border-default p-3">
            <NuxtTable
              v-if="g.instances.length"
              :data="g.instances"
              :columns="instanceColumns"
            />
            <div v-else class="flex items-center gap-2 py-6 text-muted">
              <NuxtIcon name="i-lucide-inbox" class="size-5" />
              <span>该组暂无实例，点击右上角"加实例"开始添加。</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 组表单 Modal -->
    <NuxtModal v-model:open="groupModalOpen" :title="editingGroup ? '编辑组' : '新建组'" :description="editingGroup ? editingGroup.name : '创建一个新的实例组'">
      <template #body>
        <NuxtForm :schema="groupSchema" :state="groupState" class="flex flex-col gap-4" @submit="onSubmitGroup">
          <NuxtFormField label="组名称" name="name" required>
            <NuxtInput v-model="groupState.name" placeholder="如：1号线、核心机房" class="w-full" />
          </NuxtFormField>
          <NuxtFormField label="描述" name="description">
            <NuxtTextarea v-model="groupState.description" placeholder="可选" :rows="2" class="w-full" />
          </NuxtFormField>
          <div class="flex justify-end gap-2 pt-2">
            <NuxtButton variant="ghost" color="neutral" label="取消" @click="groupModalOpen = false" />
            <NuxtButton type="submit" color="primary" :loading="groupSaving" label="保存" />
          </div>
        </NuxtForm>
      </template>
    </NuxtModal>

    <!-- 实例表单 Modal -->
    <NuxtModal v-model:open="instanceModalOpen" :title="editingInstance ? '编辑实例' : '新增实例'" :description="editingInstance?.name">
      <template #body>
        <NuxtForm :schema="instanceSchema" :state="instanceState" class="flex flex-col gap-4" @submit="onSubmitInstance">
          <NuxtFormField label="实例名称" name="name" required>
            <NuxtInput v-model="instanceState.name" placeholder="如：人民广场站" class="w-full" />
          </NuxtFormField>
          <NuxtFormField label="Endpoint" name="endpoint" required>
            <NuxtInput v-model="instanceState.endpoint" placeholder="http://10.24.0.10:9000" class="w-full font-mono text-sm" />
          </NuxtFormField>
          <div class="grid grid-cols-2 gap-3">
            <NuxtFormField label="Access Key" name="accessKey" required>
              <NuxtInput v-model="instanceState.accessKey" class="w-full" />
            </NuxtFormField>
            <NuxtFormField label="Secret Key" name="secretKey" required>
              <NuxtInput
                v-model="instanceState.secretKey"
                :type="secretVisible ? 'text' : 'password'"
                class="w-full"
                :ui="{ trailing: 'pe-1' }"
              >
                <template #trailing>
                  <NuxtButton
                    color="neutral"
                    variant="link"
                    size="sm"
                    :icon="secretVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="secretVisible ? '隐藏' : '显示'"
                    tabindex="-1"
                    @click="secretVisible = !secretVisible"
                  />
                </template>
              </NuxtInput>
            </NuxtFormField>
          </div>
          <NuxtFormField label="默认 Bucket" name="bucket">
            <NuxtInput v-model="instanceState.bucket" placeholder="可选，如 ndm" class="w-full" />
          </NuxtFormField>
          <NuxtFormField name="enabled">
            <NuxtSwitch v-model="instanceState.enabled" label="启用" />
          </NuxtFormField>
          <div class="flex justify-end gap-2 pt-2">
            <NuxtButton variant="ghost" color="neutral" label="取消" @click="instanceModalOpen = false" />
            <NuxtButton type="submit" color="primary" :loading="instanceSaving" label="保存" />
          </div>
        </NuxtForm>
      </template>
    </NuxtModal>
  </div>
</template>
