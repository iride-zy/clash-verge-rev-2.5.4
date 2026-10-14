import { createElement, useEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { unstable_serialize } from 'swr'
import { cache, revalidateEvents, SWRGlobalState } from 'swr/_internal'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useUpdate } from '@/hooks/use-update'
import { checkUpdateSafe } from '@/services/update'

const lifecycle = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module')
  const dependencyRequire = createRequire(import.meta.resolve('swr'))
  return {
    effects: [] as Array<() => void | (() => void)>,
    cleanups: [] as Array<() => void>,
    changed: vi.fn(),
    shim: dependencyRequire.resolve('use-sync-external-store/shim'),
  }
})

// Run hook lifecycles without a DOM while retaining the real SWR cache and events.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const scheduleEffect = (effect: () => void | (() => void)) => {
    lifecycle.effects.push(effect)
  }
  return {
    ...actual,
    useEffect: scheduleEffect,
    useLayoutEffect: scheduleEffect,
  }
})
// SWR imports the external-store shim directly. Keep its real subscriptions,
// but read the client snapshot when rendering in this Node test environment.
vi.mock(lifecycle.shim, () => ({
  useSyncExternalStore: (
    subscribe: (changed: () => void) => () => void,
    snapshot: () => unknown,
  ) => {
    lifecycle.effects.push(() => subscribe(lifecycle.changed))
    return snapshot()
  },
}))
vi.mock('@/services/update', () => ({ checkUpdateSafe: vi.fn() }))

const renderUpdate = () => {
  let value!: ReturnType<typeof useUpdate>
  const Probe = () => {
    const update = useUpdate()
    useEffect(() => {
      value = update
    }, [update])
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  for (const effect of lifecycle.effects.splice(0)) {
    const cleanup = effect()
    if (cleanup) lifecycle.cleanups.push(cleanup)
  }
  return value
}

beforeEach(() => {
  vi.useFakeTimers()
  lifecycle.changed.mockClear()
  for (const key of cache.keys()) cache.delete(key)
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  vi.mocked(checkUpdateSafe).mockReset().mockResolvedValue(null)
})

afterEach(() => {
  lifecycle.cleanups.splice(0).forEach((cleanup) => cleanup())
  lifecycle.effects.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('never checks application updates on mount, focus, reconnect or elapsed time', async () => {
  renderUpdate()
  const key = unstable_serialize(['checkUpdate'])
  const listeners = SWRGlobalState.get(cache)?.[0][key] ?? []
  expect(listeners.length).toBeGreaterThan(0)
  for (const listener of listeners) {
    listener(revalidateEvents.FOCUS_EVENT)
    listener(revalidateEvents.RECONNECT_EVENT)
  }
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
  expect(checkUpdateSafe).not.toHaveBeenCalled()
})

it('publishes a manual result and check time to other update consumers', async () => {
  const update = {
    available: true,
    version: '99.0.0',
    body: 'New version',
  } as NonNullable<Awaited<ReturnType<typeof checkUpdateSafe>>>
  vi.mocked(checkUpdateSafe).mockResolvedValue(update)
  const caller = renderUpdate()
  renderUpdate()
  await Promise.resolve()
  lifecycle.changed.mockClear()

  expect(await caller.checkUpdate()).toEqual({ data: update })
  const observer = renderUpdate()

  expect(checkUpdateSafe).toHaveBeenCalledOnce()
  expect(observer.updateInfo).toBe(update)
  expect(observer.lastCheckUpdate).toBe(Date.now())
  expect(lifecycle.changed).toHaveBeenCalled()
})

it('reports a failed manual check without recording success or retrying', async () => {
  const error = new Error('Update server unavailable')
  vi.mocked(checkUpdateSafe).mockRejectedValue(error)
  const caller = renderUpdate()

  await expect(caller.checkUpdate()).rejects.toThrow(error)
  await vi.advanceTimersByTimeAsync(60 * 1000)

  expect(checkUpdateSafe).toHaveBeenCalledOnce()
  expect(localStorage.getItem('last_check_update')).toBeNull()
  expect(renderUpdate().updateInfo).toBeUndefined()
})
