import type { ConnectivityResult, InstanceGroup, S3Instance } from '#shared/schemas/groups'

/** 展示状态类型 */
type ConnectivityDisplay = 'testing' | null | 'offline' | 'auth-error' | 'online'

export function useConnectivity() {
  // 按 instanceId 存储测试结果（Record，非 Map，保证响应式）
  const results = ref<Record<string, ConnectivityResult>>({})
  const testing = ref<Record<string, boolean>>({})
  const testingGroup = ref<Record<string, boolean>>({})

  const toast = useToast()

  async function testInstance(groupId: string, instanceId: string) {
    testing.value[instanceId] = true
    try {
      const res = await $fetch<ConnectivityResult[]>(
        `/api/manage/groups/${groupId}/test`,
        { method: 'POST', query: { instanceId } },
      )
      if (res[0]) {
        results.value[instanceId] = res[0]
      }
    } catch {
      toast.add({ title: '测试失败', color: 'error' })
    } finally {
      testing.value[instanceId] = false
    }
  }

  async function testGroup(groupId: string, instances: S3Instance[]) {
    const enabled = instances.filter((i) => i.enabled)
    if (!enabled.length) return

    testingGroup.value[groupId] = true
    try {
      const res = await $fetch<ConnectivityResult[]>(
        `/api/manage/groups/${groupId}/test`,
        { method: 'POST' },
      )
      for (const r of res) {
        results.value[r.instanceId] = r
      }
    } catch {
      toast.add({ title: '测试失败', color: 'error' })
    } finally {
      testingGroup.value[groupId] = false
    }
  }

  function getStatus(instanceId: string): ConnectivityDisplay {
    if (testing.value[instanceId]) return 'testing'
    const r = results.value[instanceId]
    if (!r) return null
    if (!r.online) return 'offline'
    if (r.authValid === false) return 'auth-error'
    return 'online'
  }

  function getGroupSummary(group: InstanceGroup): { label: string, color: string } | null {
    let online = 0, offline = 0, authError = 0
    for (const inst of group.instances) {
      const r = results.value[inst.id]
      if (!r) continue
      if (!r.online) offline++
      else if (r.authValid === false) authError++
      else online++
    }
    const total = online + offline + authError
    if (total === 0) return null

    const parts: string[] = []
    if (online) parts.push(`${online}在线`)
    if (offline) parts.push(`${offline}离线`)
    if (authError) parts.push(`${authError}凭据异常`)
    const label = parts.join('·')

    const color = offline > 0 ? 'error' : authError > 0 ? 'warning' : 'success'
    return { label, color }
  }

  return { results, testing, testingGroup, testInstance, testGroup, getStatus, getGroupSummary }
}
