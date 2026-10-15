import { delayProxyByName } from 'tauri-plugin-mihomo-api'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('tauri-plugin-mihomo-api', () => ({
  delayProxyByName: vi.fn(async () => ({ delay: 120 })),
  healthcheckNodeInProvider: vi.fn(async () => ({ delay: 120 })),
}))

vi.mock('./node-diagnostics', () => ({
  checkNodeDiagnostics: vi.fn(async () => ({
    entry: { ip: '192.0.2.1', location: 'entry', error: null },
    exit: { ip: '198.51.100.1', location: 'exit', error: null },
    nat: { kind: 'unknown', mappedAddress: null, detail: null },
  })),
}))

import type { InteractableProxyMember } from '@/types/proxy-view'

import delayManager from './delay'
import { checkNodeDiagnostics, type DiagnosticsState } from './node-diagnostics'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const testNode = (name: string) =>
  ({
    kind: 'node' as const,
    ref: { kind: 'node' as const, name, recordId: name },
    node: {
      recordId: name,
      name,
      history: [],
      source: { kind: 'core' as const, proxyName: name },
    },
  }) as unknown as Extract<InteractableProxyMember, { kind: 'node' }>

test('status survives latency expiry and a later latency-only check', async () => {
  const member = {
    kind: 'node',
    ref: { kind: 'node', name: 'retained-status', recordId: 'retained-status' },
    node: {
      recordId: 'retained-status',
      name: 'retained-status',
      history: [],
      source: { kind: 'core', proxyName: 'retained-status' },
    },
  } as unknown as InteractableProxyMember
  const group = 'retained-status-group'
  delayManager.setDiagnosticsGeneration('retention-profile')
  vi.useFakeTimers()
  const pending = delayManager.checkListDelay(
    [member],
    group,
    5000,
    1,
    'status',
  )
  await vi.runAllTimersAsync()
  await pending
  const diagnostics = delayManager.getDelayUpdate(member, group)?.diagnostics
  expect(diagnostics?.status).toBe('done')

  await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
  expect(delayManager.getDelayUpdate(member, group)).toEqual({
    delay: -1,
    updatedAt: 0,
    diagnostics,
  })

  const latency = delayManager.checkDelay(member, group, 5000)
  await vi.runAllTimersAsync()
  await latency
  expect(delayManager.getDelayUpdate(member, group)).toEqual(
    expect.objectContaining({ delay: 120, diagnostics }),
  )

  delayManager.setUrl(group, 'http://different-test/204')
  expect(delayManager.getDelayUpdate(member, group)).toBeUndefined()
  delayManager.setDiagnosticsGeneration('another-profile')
  delayManager.setUrl(group, '')
  expect(
    delayManager.getDelayUpdate(member, group)?.diagnostics,
  ).toBeUndefined()
})

test('leaving and returning to a URL does not revive abandoned testing state', async () => {
  const member = {
    kind: 'node',
    ref: { kind: 'node', name: 'url-roundtrip', recordId: 'url-roundtrip' },
    node: {
      recordId: 'url-roundtrip',
      name: 'url-roundtrip',
      history: [],
      source: { kind: 'core', proxyName: 'url-roundtrip' },
    },
  } as unknown as InteractableProxyMember
  const group = 'url-roundtrip-group'
  const result = {
    entry: { ip: null, location: null, error: null },
    exit: { ip: null, location: null, error: null },
    nat: { kind: 'unknown' as const, mappedAddress: null, detail: null },
  }
  let finish!: (value: typeof result) => void
  vi.mocked(checkNodeDiagnostics).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  vi.useFakeTimers()
  delayManager.setUrl(group, 'http://test/a')
  const pending = delayManager.checkListDelay(
    [member],
    group,
    5000,
    1,
    'status',
  )
  delayManager.setUrl(group, 'http://test/b')
  delayManager.setUrl(group, 'http://test/a')
  finish(result)
  await vi.runAllTimersAsync()
  await pending
  expect(delayManager.getDelayUpdate(member, group)).toBeUndefined()
})

test('hydration notifies mounted views even when the latency cache is empty', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  })
  const member = {
    kind: 'node',
    ref: { kind: 'node', name: 'reopen', recordId: 'reopen' },
    node: {
      recordId: 'reopen',
      name: 'reopen',
      history: [],
      source: { kind: 'core', proxyName: 'reopen' },
    },
  } as unknown as InteractableProxyMember
  const group = 'reopen-group'
  delayManager.setDiagnosticsGeneration('profile-reopen')
  const diagnostics = { status: 'error' as const, detail: 'retained failure' }
  delayManager.setDelay(member, group, 100, { diagnostics })

  vi.resetModules()
  const { default: reopened } = await import('./delay')
  expect(reopened.getDelayUpdate(member, group)).toBeUndefined()
  const listener = vi.fn(() => reopened.getDelayUpdate(member, group))
  const unsubscribe = reopened.addGroupListener(group, listener)
  reopened.setDiagnosticsGeneration('profile-reopen')
  await Promise.resolve()

  expect(listener).toHaveReturnedWith({ delay: -1, updatedAt: 0, diagnostics })
  unsubscribe()
})

test('URL changes notify views before an obsolete status batch finishes', async () => {
  const member = testNode('immediate-url-reset')
  const group = 'immediate-url-reset-group'
  let finish!: (value: Awaited<ReturnType<typeof checkNodeDiagnostics>>) => void
  vi.mocked(checkNodeDiagnostics).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  vi.useFakeTimers()
  const pending = delayManager.checkListDelay(
    [member],
    group,
    5000,
    1,
    'status',
  )
  await vi.advanceTimersByTimeAsync(0)
  const listener = vi.fn(() => delayManager.getDelayUpdate(member, group))
  const unsubscribe = delayManager.addGroupListener(group, listener)
  delayManager.setUrl(group, 'http://new-url/204')
  await vi.advanceTimersByTimeAsync(0)
  expect(listener).toHaveReturnedWith(undefined)
  finish({
    entry: { ip: null, location: null, error: null },
    exit: { ip: null, location: null, error: null },
    nat: { kind: 'unknown', mappedAddress: null, detail: null },
  })
  await vi.runAllTimersAsync()
  await pending
  unsubscribe()
})

test('an active old-profile latency cannot overwrite a new-profile measurement', async () => {
  const member = testNode('latency-profile-race')
  const group = 'latency-profile-race-group'
  let finish!: (value: { delay: number }) => void
  vi.mocked(delayProxyByName).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  vi.useFakeTimers()
  delayManager.setDiagnosticsGeneration('latency-profile-before')
  const previous = delayManager.checkDelay(member, group, 5000)
  delayManager.setDiagnosticsGeneration('latency-profile-after')
  expect(delayManager.getDelayFix(member, group)).toBe(-1)
  delayManager.setDelay(member, group, 42)
  finish({ delay: 900 })
  await vi.runAllTimersAsync()
  await previous
  expect(delayManager.getDelayFix(member, group)).toBe(42)
})

test('retained diagnostics do not hide generic core history after latency expiry', () => {
  const member = testNode('retained-status-with-history')
  const group = 'retained-status-with-history-group'
  const diagnostics: DiagnosticsState = { status: 'error', detail: 'retained' }
  vi.useFakeTimers()
  delayManager.setDelay(member, group, 100, { diagnostics })
  vi.setSystemTime(Date.now() + 31 * 60 * 1000)
  member.node.history = [{ time: new Date().toISOString(), delay: 126 }]
  expect(delayManager.getDelayUpdate(member, group)).toEqual(
    expect.objectContaining({ delay: 126, diagnostics }),
  )
  expect(delayManager.getDelayFix(member, group)).toBe(126)
})
