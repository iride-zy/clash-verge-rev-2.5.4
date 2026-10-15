import {
  delayProxyByName,
  healthcheckNodeInProvider,
  type ProxyDelay,
} from 'tauri-plugin-mihomo-api'

import { NodeDiagnosticsCache } from '@/store/node-diagnostics-cache'
import {
  memberDetails,
  providerNameOf,
  type InteractableProxyMember,
  type ResolvedProxyMember,
} from '@/types/proxy-view'
import { debugLog } from '@/utils/debug'
import { classifyDelay, DEFAULT_DELAY_TIMEOUT } from '@/utils/delay'
import { isValidLatencyTestUrl } from '@/utils/network'

import { checkNodeDiagnostics, type DiagnosticsState } from './node-diagnostics'

export type ProxyTestType = 'delay' | 'status'

export type DelaySnapshot = {
  of: (member: ResolvedProxyMember) => number
}

const hashKey = (member: ResolvedProxyMember, group: string) => {
  if (member.kind !== 'node')
    return JSON.stringify([
      group,
      member.kind,
      member.ref.name,
      member.kind === 'group' ? member.group.now : null,
    ])
  const source = member.node.source
  return JSON.stringify([
    group,
    source.kind,
    source.kind === 'provider' ? source.providerName : null,
    source.proxyName,
  ])
}

export interface DelayUpdate {
  delay: number
  elapsed?: number
  updatedAt: number
  diagnostics?: DiagnosticsState
}

const CACHE_TTL = 30 * 60 * 1000

class DelayManager {
  private diagnosticsGeneration: string | null = null
  private measurements = new Map<string, Promise<DelayUpdate>>()
  private diagnosticsCache = new NodeDiagnosticsCache()

  setDiagnosticsGeneration(generation: string | null) {
    this.diagnosticsCache.setGeneration(generation)
    if (generation === this.diagnosticsGeneration) return
    this.diagnosticsGeneration = generation
    this.measurements.clear()
    for (const [key, value] of this.cache) {
      const update = {
        ...value,
        ...(value.delay === -2 ? { delay: -1, updatedAt: 0 } : {}),
        diagnostics: undefined,
      }
      this.cache.set(key, update)
      this.pendingItemUpdates.set(key, [update])
    }
    this.scheduleItemFlush()
    // Restored status results also need to reach views whose latency cache is empty.
    for (const group of this.groupListenerMap.keys()) {
      this.queueGroupNotification(group, true)
    }
  }
  private cache = new Map<string, DelayUpdate & { url: string }>()
  private urlMap = new Map<string, string>()
  private urlRevisions = new Map<string, number>()

  private listenerMap = new Map<string, Set<(update: DelayUpdate) => void>>()

  private groupListenerMap = new Map<string, Set<() => void>>()
  // Consumers compare snapshot identity; replace it only when the group settles.
  private groupSnapshots = new Map<string, DelaySnapshot>()
  private groupSetSnapshots = new Map<
    string,
    ReadonlyMap<string, DelaySnapshot>
  >()
  // Suppress sort notifications until every measurement in a group batch settles.
  private activeBatches = new Map<string, number>()

  private pendingItemUpdates = new Map<string, DelayUpdate[]>()
  private pendingGroupUpdates = new Set<string>()
  private itemFlushScheduled = false
  private groupFlushScheduled = false

  private scheduleOnNextFrame(run: () => void): void {
    if (typeof window !== 'undefined') {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run)
        return
      }
      if (typeof window.setTimeout === 'function') {
        window.setTimeout(run, 0)
        return
      }
    }

    Promise.resolve().then(run)
  }

  private scheduleItemFlush() {
    if (this.itemFlushScheduled) return
    this.itemFlushScheduled = true

    this.scheduleOnNextFrame(() => {
      this.itemFlushScheduled = false
      const updates = this.pendingItemUpdates
      this.pendingItemUpdates = new Map()

      updates.forEach((queue, key) => {
        const listeners = this.listenerMap.get(key)
        if (!listeners) return

        queue.forEach((update) => {
          for (const listener of [...listeners]) {
            try {
              listener(update)
            } catch (error) {
              console.error(
                `[DelayManager] 通知节点延迟监听器失败: ${key}`,
                error,
              )
            }
          }
        })
      })
    })
  }

  private scheduleGroupFlush() {
    if (this.groupFlushScheduled) return
    this.groupFlushScheduled = true

    this.scheduleOnNextFrame(() => {
      this.groupFlushScheduled = false
      const groups = this.pendingGroupUpdates
      this.pendingGroupUpdates = new Set()

      groups.forEach((group) => {
        const listeners = this.groupListenerMap.get(group)
        if (!listeners) return
        // Copied before iterating: a listener is free to unsubscribe as it runs.
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error(
              `[DelayManager] 通知分组延迟监听器失败: ${group}`,
              error,
            )
          }
        }
      })
    })
  }

  private queueGroupNotification(group: string, contextChanged = false) {
    if (!contextChanged && (this.activeBatches.get(group) ?? 0) > 0) return
    // Invalidate the set wrapper while retaining unaffected per-group identities.
    this.groupSnapshots.delete(group)
    this.groupSetSnapshots.clear()
    this.pendingGroupUpdates.add(group)
    this.scheduleGroupFlush()
  }

  /** Cached set snapshot for `useSyncExternalStore` identity comparisons. */
  groupsDelays(groupKey: string): ReadonlyMap<string, DelaySnapshot> {
    const cached = this.groupSetSnapshots.get(groupKey)
    if (cached) return cached

    const names = JSON.parse(groupKey) as string[]
    const snapshots = new Map(
      names.map((name) => [name, this.groupDelays(name)]),
    )
    this.groupSetSnapshots.set(groupKey, snapshots)
    return snapshots
  }

  /** Cached group snapshot whose identity changes only when that group settles. */
  groupDelays(group: string): DelaySnapshot {
    const existing = this.groupSnapshots.get(group)
    if (existing) return existing

    const snapshot: DelaySnapshot = {
      of: (member) => this.getDelayFix(member, group),
    }
    this.groupSnapshots.set(group, snapshot)
    return snapshot
  }

  setUrl(group: string, url: string) {
    const previous = this.getUrl(group)
    if (isValidLatencyTestUrl(url)) {
      this.urlMap.set(group, url.trim())
    } else {
      this.urlMap.delete(group)
    }
    if (previous !== this.getUrl(group)) {
      this.urlRevisions.set(group, (this.urlRevisions.get(group) ?? 0) + 1)
      for (const key of this.cache.keys()) {
        if ((JSON.parse(key) as unknown[])[0] !== group) continue
        this.diagnosticsCache.cancelTesting(key, previous)
        this.cache.delete(key)
        this.pendingItemUpdates.delete(key)
      }
      this.queueGroupNotification(group, true)
    }
  }

  getUrl(group: string) {
    const url = this.urlMap.get(group)
    debugLog(
      `[DelayManager] 获取测试URL，组: ${group}, URL: ${url || '未设置'}`,
    )
    return url || 'http://cp.cloudflare.com/generate_204'
  }

  setListener(
    member: ResolvedProxyMember,
    group: string,
    listener: (update: DelayUpdate) => void,
  ) {
    const key = hashKey(member, group)
    const listeners = this.listenerMap.get(key) ?? new Set()
    listeners.add(listener)
    this.listenerMap.set(key, listeners)
    return () => this.removeItemListener(key, listener)
  }

  removeListener(
    member: ResolvedProxyMember,
    group: string,
    listener?: (update: DelayUpdate) => void,
  ) {
    this.removeItemListener(hashKey(member, group), listener)
  }

  private removeItemListener(
    key: string,
    listener?: (update: DelayUpdate) => void,
  ) {
    const listeners = this.listenerMap.get(key)
    if (listener) listeners?.delete(listener)
    if (!listener || listeners?.size === 0) this.listenerMap.delete(key)
  }

  /** Multiple views may subscribe independently; notifications occur only after settle. */
  addGroupListener(group: string, listener: () => void): () => void {
    const listeners = this.groupListenerMap.get(group) ?? new Set()
    listeners.add(listener)
    this.groupListenerMap.set(group, listeners)

    return () => {
      const current = this.groupListenerMap.get(group)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.groupListenerMap.delete(group)
    }
  }

  setDelay(
    member: ResolvedProxyMember,
    group: string,
    delay: number,
    meta?: { elapsed?: number; url?: string; diagnostics?: DiagnosticsState },
  ): DelayUpdate {
    const key = hashKey(member, group)
    debugLog(
      `[DelayManager] 设置延迟，代理: ${member.ref.name}, 组: ${group}, 延迟: ${delay}`,
    )
    const url = meta?.url ?? this.getUrl(group)
    const update: DelayUpdate = {
      delay,
      elapsed: meta?.elapsed,
      updatedAt: Date.now(),
      diagnostics: meta?.diagnostics ?? this.diagnosticsCache.get(key, url),
    }

    if (url !== this.getUrl(group)) return update
    if (meta?.diagnostics) {
      this.diagnosticsCache.set(key, url, meta.diagnostics)
    }
    this.cache.set(key, { ...update, url })

    const queue = this.pendingItemUpdates.get(key)
    if (queue) {
      queue.push(update)
    } else {
      this.pendingItemUpdates.set(key, [update])
    }
    this.scheduleItemFlush()

    return update
  }

  getDelayUpdate(
    member: ResolvedProxyMember,
    group: string,
  ): DelayUpdate | undefined {
    const history = this.getHistory(member, group)
    const key = hashKey(member, group)
    const cached = this.cache.get(key)
    const entry = cached?.url === this.getUrl(group) ? cached : undefined
    const diagnostics = this.diagnosticsCache.get(key, this.getUrl(group))
    const latest = history?.at(-1)
    const updatedAt = latest ? Date.parse(latest.time) : 0
    if (latest && entry?.delay !== -2 && updatedAt > (entry?.updatedAt ?? 0)) {
      return {
        delay: latest.delay || 1e6,
        updatedAt,
        diagnostics,
      }
    }
    if (entry && Date.now() - entry.updatedAt <= CACHE_TTL) {
      return { ...entry, diagnostics }
    }

    if (entry) this.cache.delete(key)
    if (!diagnostics) return undefined
    const fallback = memberDetails(member)?.history.at(-1)
    return {
      delay: fallback ? fallback.delay || 1e6 : -1,
      updatedAt: fallback ? Date.parse(fallback.time) || 0 : 0,
      diagnostics,
    }
  }

  getDelay(member: ResolvedProxyMember, group: string) {
    const update = this.getDelayUpdate(member, group)
    return update ? update.delay : -1
  }

  getHistory(member: ResolvedProxyMember, group: string) {
    return memberDetails(member)?.extra?.[this.getUrl(group)]?.history
  }

  getDelayFix(member: ResolvedProxyMember, group: string) {
    if (member.kind === 'unresolved') return -1
    const history =
      this.getHistory(member, group) ?? memberDetails(member)?.history
    const update = this.getDelayUpdate(member, group)
    if (update && (update.delay >= 0 || update.delay === -2)) {
      return update.delay
    }

    if (history?.length) return history[history.length - 1].delay || 1e6
    return -1
  }

  async unifiedDelayCheck(
    name: string,
    url: string,
    timeout: number,
    providerName?: string,
  ) {
    if (providerName)
      return healthcheckNodeInProvider(providerName, name, url, timeout)
    return delayProxyByName(name, url, timeout)
  }

  /** A single test may notify immediately; a batch defers notification until it settles. */
  async checkDelay(
    member: InteractableProxyMember,
    group: string,
    timeout: number,
  ): Promise<DelayUpdate> {
    const update = await this.measureDelay(member, group, timeout)
    this.queueGroupNotification(group)
    return update
  }

  private async measureDelay(
    member: InteractableProxyMember,
    group: string,
    timeout: number,
    testType: ProxyTestType = 'delay',
  ): Promise<DelayUpdate> {
    if (testType === 'delay') return this.measureLatency(member, group, timeout)

    const key = JSON.stringify([
      this.diagnosticsGeneration,
      group,
      this.getUrl(group),
      this.urlRevisions.get(group),
      member.ref.name,
      member.kind === 'node' ? member.node.source : 'group',
    ])
    const pending = this.measurements.get(key)
    if (pending) return pending
    const generation = this.diagnosticsGeneration
    const run = async () => {
      const diagnostics =
        member.kind === 'node'
          ? this.measureDiagnostics(member, group, timeout, generation)
          : Promise.resolve()
      await Promise.all([
        this.measureLatency(member, group, timeout),
        diagnostics,
      ])
      return (
        this.getDelayUpdate(member, group) ?? {
          delay: -1,
          updatedAt: 0,
        }
      )
    }
    const measurement = run().finally(() => {
      if (this.measurements.get(key) === measurement)
        this.measurements.delete(key)
    })
    this.measurements.set(key, measurement)
    return measurement
  }

  private async measureDiagnostics(
    member: Extract<InteractableProxyMember, { kind: 'node' }>,
    group: string,
    timeout: number,
    generation: string | null,
  ) {
    const url = this.getUrl(group)
    const revision = this.urlRevisions.get(group)
    const key = hashKey(member, group)
    const testing: DiagnosticsState = { status: 'testing' }
    const publish = (diagnostics: DiagnosticsState) => {
      if (
        generation !== this.diagnosticsGeneration ||
        revision !== this.urlRevisions.get(group) ||
        url !== this.getUrl(group)
      )
        return
      const previous = this.getDelayUpdate(member, group)
      this.setDelay(member, group, previous?.delay ?? -2, {
        elapsed: previous?.elapsed,
        url,
        diagnostics,
      })
    }
    publish(testing)
    try {
      const result = await checkNodeDiagnostics(
        member.node.source.proxyName,
        providerNameOf(member.node),
        timeout,
        member.node.udp,
      )
      publish({ status: 'done', result })
    } catch (error) {
      const detail =
        error && typeof error === 'object' && 'detail' in error
          ? String(error.detail)
          : String(error)
      publish({ status: 'error', detail })
    } finally {
      this.diagnosticsCache.cancelTesting(key, url, testing)
    }
  }

  private async measureLatency(
    member: InteractableProxyMember,
    group: string,
    timeout: number,
  ): Promise<DelayUpdate> {
    const name = member.ref.name
    const providerName =
      member.kind === 'node' ? providerNameOf(member.node) : undefined
    const apiName =
      member.kind === 'node' && member.node.source.kind === 'provider'
        ? member.node.source.proxyName
        : name
    debugLog(
      `[DelayManager] 开始测试延迟，代理: ${name}, 组: ${group}, 超时: ${timeout}ms`,
    )

    const url = this.getUrl(group)
    const revision = this.urlRevisions.get(group)
    const generation = this.diagnosticsGeneration
    const publish = (delay: number, elapsed: number) =>
      revision === this.urlRevisions.get(group) &&
      generation === this.diagnosticsGeneration
        ? this.setDelay(member, group, delay, { elapsed, url })
        : { delay, elapsed, updatedAt: Date.now() }
    this.setDelay(member, group, -2, { url })

    const startTime = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      debugLog(`[DelayManager] 调用API测试延迟，代理: ${name}, URL: ${url}`)

      const timeoutPromise = new Promise<ProxyDelay>((resolve) => {
        timer = setTimeout(() => resolve({ delay: 0 }), timeout)
      })

      const result = await Promise.race([
        this.unifiedDelayCheck(apiName, url, timeout, providerName),
        timeoutPromise,
      ])

      const elapsedTime = Date.now() - startTime
      if (elapsedTime < 500) {
        await new Promise((resolve) => setTimeout(resolve, 500 - elapsedTime))
      }

      const delay = result.delay
      const elapsed = elapsedTime
      debugLog(`[DelayManager] 延迟测试完成，代理: ${name}, 结果: ${delay}ms`)

      return publish(delay, elapsed)
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      console.error(`[DelayManager] 延迟测试出错，代理: ${name}`, error)
      const delay = 1e6 // error
      const elapsed = Date.now() - startTime

      return publish(delay, elapsed)
    } finally {
      clearTimeout(timer)
    }
  }

  async checkListDelay(
    proxies: InteractableProxyMember[],
    group: string,
    timeout: number,
    concurrency = 36,
    testType: ProxyTestType = 'delay',
  ) {
    debugLog(
      `[DelayManager] 批量测试延迟开始，组: ${group}, 数量: ${proxies.length}, 并发数: ${concurrency}`,
    )
    this.activeBatches.set(group, (this.activeBatches.get(group) ?? 0) + 1)
    const generation = this.diagnosticsGeneration
    const url = this.getUrl(group)
    const revision = this.urlRevisions.get(group)
    const isCurrent = () =>
      generation === this.diagnosticsGeneration &&
      url === this.getUrl(group) &&
      revision === this.urlRevisions.get(group)

    let index = 0
    const startTime = Date.now()

    const help = async (): Promise<void> => {
      if (!isCurrent()) return
      const currMember = proxies[index++]
      if (!currMember) return
      const currName = currMember.ref.name

      try {
        // Stagger requests so a batch does not hit the core at once.
        if (index > 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 200),
          )
        }

        if (!isCurrent()) return
        // Only active work enters the testing state; canceled queued members keep
        // their previous result rather than remaining in a loading state.
        // Do not reorder a list around the pointer while batch results are arriving.
        await this.measureDelay(currMember, group, timeout, testType)
      } catch (error) {
        console.error(
          `[DelayManager] 批量测试单个代理出错，代理: ${currName}`,
          error,
        )
        this.setDelay(currMember, group, 1e6)
      }

      return help()
    }

    const actualConcurrency = Math.min(concurrency, proxies.length, 10)
    debugLog(`[DelayManager] 实际并发数: ${actualConcurrency}`)

    const promiseList: Promise<void>[] = []
    for (let i = 0; i < actualConcurrency; i++) {
      promiseList.push(help())
    }

    try {
      await Promise.all(promiseList)
    } finally {
      // Always release the batch and notify; otherwise failures leave stale sort state.
      const remaining = (this.activeBatches.get(group) ?? 1) - 1
      if (remaining > 0) {
        this.activeBatches.set(group, remaining)
      } else {
        this.activeBatches.delete(group)
        this.queueGroupNotification(group)
      }
    }
    const totalTime = Date.now() - startTime
    debugLog(
      `[DelayManager] 批量测试延迟完成，组: ${group}, 总耗时: ${totalTime}ms`,
    )
  }

  formatDelay(delay: number, timeout = DEFAULT_DELAY_TIMEOUT) {
    switch (classifyDelay(delay, timeout)) {
      case 'untested':
        return '-'
      case 'testing':
        return 'testing'
      case 'timeout':
        return 'Timeout'
      case 'error':
        return 'Error'
      case 'measured':
        return `${delay}`
    }
  }

  formatDelayColor(delay: number, timeout = DEFAULT_DELAY_TIMEOUT) {
    switch (classifyDelay(delay, timeout)) {
      case 'untested':
      case 'testing':
        return ''
      case 'timeout':
      case 'error':
        return 'error.main'
      case 'measured':
        // Colour and signal bars intentionally use different grading thresholds.
        if (delay >= 400) return 'warning.main'
        if (delay >= 250) return 'primary.main'
        return 'success.main'
    }
  }
}

export default new DelayManager()
