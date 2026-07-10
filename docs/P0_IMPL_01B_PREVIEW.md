# 对象预览实施计划

> **目标**：在对象浏览器中支持内容预览，包括图片/视频/音频/PDF 内联渲染和文本代码展示。
>
> 配套交互设计文档：`P0_DESIGN_01B_PREVIEW.md`

---

## 一、现状分析

### 1.1 已有可复用能力

```
server/api/instances/objects/download.get.ts
  └ getObjectStream() -> sendStream 转发
     ├ 当前固定 Content-Disposition: attachment（触发下载）
     └ 预览只需改为 inline（浏览器内联渲染）

server/utils/minio.ts
  └ getObjectStream() 已实现，签名/流式/超时清理都就绪，无需改动

app/pages/ops/browser/index.vue
  ├ fileIcon() 已按扩展名判断文件类型（图片/视频/音频/文本/代码/压缩包）
  ├ downloadObject() 已实现下载逻辑
  └ NuxtSlideover 可用（Nuxt UI 组件，无需额外安装）
```

### 1.2 缺失能力

- 后端：download 路由不支持 `inline` 参数
- 前端：无预览抽屉组件、无 `getPreviewType()` 判断函数、无各类型渲染逻辑

### 1.3 改动范围

**后端**：1 个文件改 1 行（download 路由加 `inline` 参数判断）
**前端**：1 个文件改（browser/index.vue 新增预览抽屉 + 渲染逻辑）

---

## 二、改动清单

### 2.1 后端

| 文件 | 操作 | 说明 |
|---|---|---|
| `server/api/instances/objects/download.get.ts` | 修改 | 新增 `?inline=1` 参数：为 true 时 `Content-Disposition: inline`，否则保持 `attachment` |

### 2.2 前端

| 文件 | 操作 | 说明 |
|---|---|---|
| `app/pages/ops/browser/index.vue` | 修改 | 新增 `getPreviewType()`、预览抽屉（NuxtSlideover）、各类型渲染逻辑、双击预览、行内预览按钮 |

**总计：1 改后端 + 1 改前端。零新增文件，零新增路由，零新增签名代码。**

---

## 三、详细实现

### 3.1 后端：download 路由支持 inline

`server/api/instances/objects/download.get.ts` 修改：

```typescript
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const instanceId = query.instanceId as string
  const bucket = query.bucket as string
  const key = query.key as string
  const inline = query.inline === '1' || query.inline === 'true'  // 新增

  // ... 现有查实例、getObjectStream 逻辑不变 ...

  // 文件名取 key 最后一段
  const filename = key.split('/').pop() || 'download'

  // Content-Disposition：inline=1 时内联渲染，否则 attachment 下载
  if (inline) {
    setResponseHeader(event, 'Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`)
  } else {
    setResponseHeader(event, 'Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
  }

  // ... 其余头透传 + sendStream 不变 ...
})
```

**改动量**：+5 行（读参数 + if 判断）。

### 3.2 前端：预览类型判断

```typescript
type PreviewType = 'image' | 'video' | 'audio' | 'pdf' | 'text' | null

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']
const VIDEO_EXTS = ['mp4', 'webm', 'ogg']
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'aac', 'flac']
const TEXT_EXTS = [
  'txt', 'json', 'csv', 'xml', 'log', 'md',
  'js', 'ts', 'mjs', 'css', 'html', 'htm',
  'yaml', 'yml', 'ini', 'conf', 'sh', 'bat',
  'sql', 'env', 'toml', 'properties', 'vue',
]

function getPreviewType(key: string): PreviewType {
  const ext = key.split('.').pop()?.toLowerCase() || ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXTS.includes(ext)) return 'text'
  return null
}
```

### 3.3 前端：预览 URL 构造

```typescript
function buildPreviewUrl(key: string): string {
  const params = new URLSearchParams({
    instanceId: selectedInstanceId.value,
    bucket: selectedBucket.value,
    key,
    inline: '1',
  })
  return `/api/instances/objects/download?${params.toString()}`
}
```

### 3.4 前端：预览抽屉状态

```typescript
// 预览抽屉状态
const previewOpen = ref(false)
const previewKey = ref<string>('')
const previewType = ref<PreviewType>(null)
const previewUrl = ref<string>('')

// 文本预览专用状态
const textContent = ref<string>('')
const textLoading = ref(false)
const textError = ref<string>('')
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024 // 2MB

// 打开预览
async function openPreview(key: string) {
  const type = getPreviewType(key)
  if (!type) return

  previewKey.value = key
  previewType.value = type
  previewUrl.value = buildPreviewUrl(key)
  previewOpen.value = true

  // 文本类型：fetch 内容
  if (type === 'text') {
    await fetchTextContent(key)
  } else {
    // 非文本类型：重置文本状态
    textContent.value = ''
    textError.value = ''
  }
}

// 关闭预览
function closePreview() {
  previewOpen.value = false
  previewKey.value = ''
  previewType.value = null
  previewUrl.value = ''
  textContent.value = ''
  textError.value = ''
}

// fetch 文本内容
async function fetchTextContent(key: string) {
  // 检查大小（从 objects 列表查）
  const obj = objects.value.find(o => o.key === key)
  if (obj && obj.size > TEXT_PREVIEW_LIMIT) {
    textError.value = `文件过大（${formatSize(obj.size)} > 2MB），请下载后查看`
    return
  }

  textLoading.value = true
  textError.value = ''
  textContent.value = ''

  try {
    const res = await fetch(buildPreviewUrl(key))
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const text = await res.text()

    // 二进制误判兜底：检测 replacement character 占比
    const replacementCount = (text.match(/\uFFFD/g) || []).length
    if (replacementCount / text.length > 0.1) {
      textError.value = '该文件可能不是文本文件，请下载后查看'
      return
    }

    textContent.value = text
  }
  catch (e: any) {
    textError.value = e?.message || '加载失败'
  }
  finally {
    textLoading.value = false
  }
}
```

### 3.5 前端：预览抽屉模板

```vue
<!-- 预览抽屉 -->
<NuxtSlideover v-model:open="previewOpen" title="对象预览" :overlay="true" class="max-w-[900px]">
  <template #body>
    <div class="flex h-full flex-col gap-3">
      <!-- 顶部信息栏 -->
      <div class="flex items-start justify-between gap-4 border-b border-default pb-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <NuxtIcon :name="fileIcon(previewKey)" class="size-4 shrink-0 text-muted" />
            <span class="truncate font-mono font-medium text-highlighted">
              {{ previewKey.split('/').pop() }}
            </span>
          </div>
          <div class="mt-1 flex items-center gap-2 text-xs text-muted">
            <span v-if="objects.find(o => o.key === previewKey)">
              {{ formatSize(objects.find(o => o.key === previewKey)!.size) }}
              · {{ formatDate(objects.find(o => o.key === previewKey)!.lastModified) }}
            </span>
          </div>
          <div class="mt-0.5 text-xs text-muted">
            {{ selectedInstance?.name }} / {{ selectedBucket }}
          </div>
        </div>
        <NuxtButton
          size="sm"
          color="primary"
          variant="outline"
          icon="i-lucide-download"
          label="下载"
          @click="downloadObject(previewKey)"
        />
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-auto">
        <!-- 图片 -->
        <div v-if="previewType === 'image'" class="flex items-center justify-center min-h-[300px]">
          <img
            :src="previewUrl"
            :alt="previewKey"
            class="max-h-[70vh] max-w-full object-contain"
            @error="onPreviewError"
          >
        </div>

        <!-- 视频 -->
        <div v-else-if="previewType === 'video'" class="flex items-center justify-center min-h-[300px]">
          <video
            :src="previewUrl"
            controls
            class="max-h-[70vh] max-w-full"
            @error="onPreviewError"
          >
            您的浏览器不支持视频播放
          </video>
        </div>

        <!-- 音频 -->
        <div v-else-if="previewType === 'audio'" class="flex flex-col items-center justify-center gap-4 py-12">
          <NuxtIcon name="i-lucide-music" class="size-16 text-primary" />
          <span class="text-sm text-muted">{{ previewKey.split('/').pop() }}</span>
          <audio :src="previewUrl" controls @error="onPreviewError">
            您的浏览器不支持音频播放
          </audio>
        </div>

        <!-- PDF -->
        <div v-else-if="previewType === 'pdf'">
          <iframe
            :src="previewUrl"
            class="h-[75vh] w-full border-0"
            :title="previewKey"
          >
            <p class="p-4 text-muted">PDF 预览不可用，请下载后查看</p>
          </iframe>
        </div>

        <!-- 文本 -->
        <div v-else-if="previewType === 'text'">
          <!-- 加载中 -->
          <div v-if="textLoading" class="flex items-center justify-center py-12 text-muted">
            <NuxtIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
            <span class="ml-2">加载中…</span>
          </div>
          <!-- 错误 -->
          <div v-else-if="textError" class="flex flex-col items-center gap-2 py-12">
            <NuxtIcon name="i-lucide-file-warning" class="size-8 text-warning" />
            <span class="text-warning">{{ textError }}</span>
            <NuxtButton
              v-if="objects.find(o => o.key === previewKey) && objects.find(o => o.key === previewKey)!.size <= TEXT_PREVIEW_LIMIT"
              size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw"
              label="重试" @click="fetchTextContent(previewKey)"
            />
          </div>
          <!-- 文本内容（带行号） -->
          <pre v-else class="text-xs font-mono whitespace-pre-wrap break-all bg-elevated rounded-md p-4 overflow-auto max-h-[70vh]"><code>{{ textContent }}</code></pre>
        </div>

        <!-- 通用错误 -->
        <div v-if="previewError" class="flex flex-col items-center gap-2 py-12">
          <NuxtIcon name="i-lucide-cloud-off" class="size-8 text-error" />
          <span class="text-error">{{ previewError }}</span>
          <NuxtButton size="sm" color="neutral" variant="outline" label="关闭" @click="closePreview" />
        </div>
      </div>
    </div>
  </template>
</NuxtSlideover>
```

### 3.6 前端：行内预览按钮 + 双击

对象行操作区新增「预览」按钮（在下载按钮前），仅可预览类型显示：

```vue
<NuxtTooltip v-if="getPreviewType(obj.key)" text="预览">
  <NuxtButton
    size="xs"
    color="info"
    variant="ghost"
    icon="i-lucide-eye"
    @click="openPreview(obj.key)"
  />
</NuxtTooltip>
```

对象行绑定双击事件：

```vue
<div
  v-for="obj in objects"
  :key="`obj-${obj.key}`"
  class="group flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-elevated"
  @dblclick="getPreviewType(obj.key) && openPreview(obj.key)"
>
```

### 3.7 前端：预览错误状态

```typescript
const previewError = ref<string>('')

function onPreviewError() {
  previewError.value = '加载失败，对象可能不存在或格式不支持'
}
```

在 `openPreview()` 中重置：

```typescript
async function openPreview(key: string) {
  previewError.value = ''  // 重置错误
  // ... 其余逻辑 ...
}
```

---

## 四、实施步骤

| 步骤 | 内容 | 验证方式 |
|---|---|---|
| 1 | 后端：download.get.ts 加 `inline` 参数判断 | curl `?inline=1` 验证返回 `Content-Disposition: inline` |
| 2 | 前端：新增 `getPreviewType()` + `buildPreviewUrl()` + 预览状态变量 | TypeScript 编译通过 |
| 3 | 前端：行内预览按钮 + 双击事件 | hover 对象行看到预览按钮，不可预览类型无按钮 |
| 4 | 前端：预览抽屉骨架（NuxtSlideover + 顶部信息栏 + 下载按钮） | 点击预览按钮弹出抽屉 |
| 5 | 前端：图片/视频/音频/PDF 渲染 | 各类型文件预览正常 |
| 6 | 前端：文本预览（fetch + `<pre>` + 行号 + 大小限制 + 二进制兜底） | 文本文件预览正常，大文件提示下载 |
| 7 | 前端：加载态 + 错误处理 | 断网/删文件场景错误提示正常 |
| 8 | 端到端验证 | dev server + 本地 MinIO 完整走通 |

---

## 五、验证矩阵

| 场景 | 预期结果 |
|---|---|
| 点击图片对象的「预览」 | 抽屉弹出，图片内联渲染 |
| 点击视频对象的「预览」 | 抽屉弹出，视频播放器就绪 |
| 点击音频对象的「预览」 | 抽屉弹出，音频播放器就绪 |
| 点击 PDF 对象的「预览」 | 抽屉弹出，PDF 内嵌渲染 |
| 点击文本对象（<2MB）的「预览」 | 抽屉弹出，fetch 文本后 `<pre>` 展示 |
| 点击文本对象（>2MB）的「预览」 | 抽屉弹出，提示"文件过大，请下载后查看" |
| 双击可预览对象行 | 等同点击预览按钮 |
| 不可预览格式（.zip） | 行内无预览按钮，双击无反应 |
| 预览抽屉点击「下载」 | 触发下载（attachment 模式） |
| 预览中对象被删除（404） | 提示"对象不存在"，关闭抽屉刷新列表 |
| 实例不可达 | 预览加载失败，提示错误 |
| 文本文件含大量乱码 | 提示"该文件可能不是文本文件" |
| `?inline=1` 请求返回头 | `Content-Disposition: inline` |
| 不带 `inline` 的下载请求 | `Content-Disposition: attachment`（现有行为不变） |

---

## 六、技术风险与对策

### 6.1 浏览器格式兼容性

**风险**：`<video>` 不支持 mkv/avi，`<audio>` 部分浏览器不支持 flac。

**对策**：`getPreviewType()` 的扩展名表只包含浏览器原生支持的格式。mkv/avi/flac 等不在列表中，不显示预览按钮。

### 6.2 PDF 插件缺失

**风险**：部分企业内网浏览器禁用 PDF 插件，`<iframe>` 显示空白。

**对策**：iframe 内放兜底文字"PDF 预览不可用，请下载后查看"。不主动检测插件（检测复杂且不可靠）。

### 6.3 文本大文件内存

**风险**：fetch 超大文本文件（如 100MB 日志）到浏览器会卡顿。

**对策**：2MB 上限，超限不 fetch 直接提示。从 `objects` 列表的对象 `size` 字段判断，不发请求。

### 6.4 二进制文件误判为文本

**风险**：无扩展名或 .log 扩展名的二进制文件被 `getPreviewType()` 判为文本，fetch 后展示乱码。

**对策**：fetch 后检测 `\uFFFD`（replacement character）占比 >10% 时提示"该文件可能不是文本文件"。

### 6.5 CORS 与认证

**风险**：`<img>`/`<video>` 的 `src` 指向后端路由，需确保同源。

**对策**：预览 URL 是 `/api/instances/objects/download?...&inline=1`，与前端同源，无 CORS 问题。后端路由无需鉴权（实例凭据在后端从 store 读取，不依赖浏览器 cookie）。

---

## 七、不涉及的范围

- 不做语法高亮（第一期纯 `<pre>`，后续可用 Shiki 按需加载）
- 不做图片缩放/旋转（第一期仅展示，后续可加）
- 不做视频快进/倍速（用浏览器原生播放器）
- 不做文本搜索（后续可加 Ctrl+F）
- 不做预览历史/分页（单文件预览）
- 不修改 `getObjectStream()` 函数本身（只改 download 路由的响应头）
- 不新增 API 路由（复用 download）
- 不引入第三方预览库（纯浏览器原生渲染）
