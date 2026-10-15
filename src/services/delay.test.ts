import {
  delayProxyByName,
  healthcheckNodeInProvider,
} from 'tauri-plugin-mihomo-api'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('tauri-plugin-mihomo-api', () => ({
  delayProxyByName: vi.fn(async () => ({ delay: 120 })),
  healthcheckNodeInProvider: vi.fn(async () => ({ delay: 120 })),
}))

vi.mock('./node-diagnostics', () => ({
  checkNodeDiagnostics: vi.fn(async () => ({
    entry: { ip: null, location: null, error: null },
    exit: { ip: null, location: null, error: null },
    nat: { kind: 'unknown', mappedAddress: null, detail: null },
  })),
}))

import type {
  InteractableProxyMember,
  ProxyGroupView,
  ResolvedProxyMember,
} from '@/types/proxy-view'

import delayManager from './delay'
import { checkNodeDiagnostics } from './node-diagnostics'

const node = (name: string) =>
  ({
    kind: 'node',
    ref: { kind: 'node', name, recordId: `r:${name}` },
    node: {
      recordId: `r:${name}`,
      name,
      history: [],
      source: { kind: 'core', proxyName: name },
    },
  }) as unknown as ResolvedProxyMember

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let settles = 0
let unsubscribe: () => void

beforeEach(() => {
  vi.clearAllMocks()
  settles = 0
  unsubscribe = delayManager.addGroupListener('g', () => {
    settles += 1
  })
})

afterEach(() => unsubscribe())

describe('group delay completion', () => {
  test('notifies once after a batch settles', async () => {
    const proxies = Array.from({ length: 6 }, (_, index) => node(`n${index}`))

    await delayManager.checkListDelay(proxies as never, 'g', 5000, 2)
    await flush()

    expect(settles).toBe(1)
  })

  test('notifies only listeners for the completed group', async () => {
    let other = 0
    const stop = delayManager.addGroupListener('other', () => {
      other += 1
    })

    await delayManager.checkDelay(node('a') as never, 'g', 5000)
    await flush()

    expect(settles).toBe(1)
    expect(other).toBe(0)
    stop()
  })
})

describe('proxy test types', () => {
  test('single and batch delay checks do not run diagnostics', async () => {
    await delayManager.checkDelay(node('latency-single') as never, 'g', 5000)
    await delayManager.checkListDelay(
      [node('latency-batch')] as never,
      'g',
      5000,
    )

    expect(delayProxyByName).toHaveBeenCalledTimes(2)
    expect(checkNodeDiagnostics).not.toHaveBeenCalled()
  })

  test('status checks run latency and diagnostics and retain results on later delay checks', async () => {
    const member = node('status-node')
    await delayManager.checkListDelay([member] as never, 'g', 5000, 2, 'status')

    expect(delayProxyByName).toHaveBeenCalledTimes(1)
    expect(checkNodeDiagnostics).toHaveBeenCalledTimes(1)
    const update = delayManager.getDelayUpdate(member, 'g')
    expect(update?.delay).toBe(120)
    expect(update?.diagnostics?.status).toBe('done')

    await delayManager.checkDelay(member as never, 'g', 5000)
    expect(checkNodeDiagnostics).toHaveBeenCalledTimes(1)
    expect(delayManager.getDelayUpdate(member, 'g')?.diagnostics).toEqual(
      update?.diagnostics,
    )
  })

  test('newer core latency history retains network diagnostics', async () => {
    const member = node('status-history')
    if (member.kind !== 'node') throw new Error('Expected node')
    await delayManager.checkListDelay(
      [member],
      'status-history-group',
      5000,
      2,
      'status',
    )
    const update = delayManager.getDelayUpdate(member, 'status-history-group')
    expect(update?.diagnostics?.status).toBe('done')
    member.node.extra = {
      [delayManager.getUrl('status-history-group')]: {
        alive: true,
        history: [
          { time: new Date(update!.updatedAt + 1000).toISOString(), delay: 42 },
        ],
      },
    }

    expect(delayManager.getDelayUpdate(member, 'status-history-group')).toEqual(
      expect.objectContaining({ delay: 42, diagnostics: update?.diagnostics }),
    )
  })

  test('a generation change rejects old latency and diagnostics replies', async () => {
    const member = node('status-generation')
    const report = {
      entry: { ip: '192.0.2.1', location: 'entry', error: null },
      exit: { ip: '198.51.100.1', location: 'exit', error: null },
      nat: { kind: 'unknown' as const, mappedAddress: null, detail: null },
    }
    let finish!: (value: typeof report) => void
    vi.mocked(checkNodeDiagnostics).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    delayManager.setDiagnosticsGeneration('before-reload')
    const pending = delayManager.checkListDelay(
      [member] as never,
      'status-generation-group',
      5000,
      2,
      'status',
    )
    expect(checkNodeDiagnostics).toHaveBeenCalledOnce()
    delayManager.setDiagnosticsGeneration('after-reload')
    finish(report)
    await pending

    expect(delayManager.getDelayFix(member, 'status-generation-group')).toBe(-1)
    expect(
      delayManager.getDelayUpdate(member, 'status-generation-group')
        ?.diagnostics,
    ).toBeUndefined()
  })
})

test('a late status reply cannot leave a different URL testing', async () => {
  const member = node('status-url-change')
  const group = 'status-url-change-group'
  const report = {
    entry: { ip: '192.0.2.1', location: 'entry', error: null },
    exit: { ip: '198.51.100.1', location: 'exit', error: null },
    nat: { kind: 'unknown' as const, mappedAddress: null, detail: null },
  }
  let finish!: (value: typeof report) => void
  vi.mocked(checkNodeDiagnostics).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  delayManager.setUrl(group, 'http://localhost/a')
  const pending = delayManager.checkListDelay(
    [member] as never,
    group,
    5000,
    2,
    'status',
  )
  delayManager.setUrl(group, 'http://localhost/b')
  finish(report)
  await pending

  expect(delayManager.getDelayFix(member, group)).toBe(-1)
  expect(delayManager.getDelayUpdate(member, group)).toBeUndefined()
})

test('a new URL runs its own status measurement while the old URL is pending', async () => {
  const member = node('status-url-concurrency')
  const group = 'status-url-concurrency-group'
  const report = {
    entry: { ip: null, location: null, error: null },
    exit: { ip: null, location: null, error: null },
    nat: { kind: 'unknown' as const, mappedAddress: null, detail: null },
  }
  let finish!: (value: typeof report) => void
  vi.mocked(checkNodeDiagnostics).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  delayManager.setUrl(group, 'http://localhost/a')
  const old = delayManager.checkListDelay(
    [member] as never,
    group,
    5000,
    2,
    'status',
  )
  delayManager.setUrl(group, 'http://localhost/b')
  await delayManager.checkListDelay([member] as never, group, 5000, 2, 'status')
  expect(delayProxyByName).toHaveBeenCalledTimes(2)
  expect(checkNodeDiagnostics).toHaveBeenCalledTimes(2)
  const current = delayManager.getDelayUpdate(member, group)
  expect(current?.delay).toBe(120)
  expect(current?.diagnostics?.status).toBe('done')

  finish(report)
  await old
  expect(delayManager.getDelayUpdate(member, group)).toEqual(current)
})

test('a delay-only check for a new URL cannot inherit an old pending diagnostic', async () => {
  const member = node('status-url-delay-only')
  const group = 'status-url-delay-only-group'
  const report = {
    entry: { ip: null, location: null, error: null },
    exit: { ip: null, location: null, error: null },
    nat: { kind: 'unknown' as const, mappedAddress: null, detail: null },
  }
  let finish!: (value: typeof report) => void
  vi.mocked(checkNodeDiagnostics).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  delayManager.setUrl(group, 'http://localhost/a')
  const old = delayManager.checkListDelay(
    [member] as never,
    group,
    5000,
    2,
    'status',
  )
  delayManager.setUrl(group, 'http://localhost/b')
  await delayManager.checkDelay(member as never, group, 5000)
  expect(checkNodeDiagnostics).toHaveBeenCalledOnce()
  const current = delayManager.getDelayUpdate(member, group)
  expect(current?.delay).toBe(120)
  expect(current?.diagnostics).toBeUndefined()

  finish(report)
  await old
  expect(delayManager.getDelayUpdate(member, group)).toEqual(current)
})

test('uses newer core history after a tray test without hiding an active page test', () => {
  const member = node('tray-refresh')
  if (member.kind !== 'node') throw new Error('Expected node')
  const cached = delayManager.setDelay(member, 'tray-group', 50)
  member.node.extra = {
    [delayManager.getUrl('tray-group')]: {
      alive: true,
      history: [
        { time: new Date(cached.updatedAt + 1000).toISOString(), delay: 300 },
      ],
    },
  }

  expect(delayManager.getDelayFix(member, 'tray-group')).toBe(300)
  expect(delayManager.getDelayUpdate(member, 'tray-group')?.delay).toBe(300)

  delayManager.setDelay(member, 'tray-group', -2)
  expect(delayManager.getDelayFix(member, 'tray-group')).toBe(-2)
})

test('latency URL validation rejects malformed hosts and ports and trims valid URLs', () => {
  for (const url of [
    'http://?',
    'http://host:invalid',
    'http://bad host/',
    'ftp://localhost',
    'http:localhost',
  ]) {
    delayManager.setUrl('url-validation', url)
    expect(delayManager.getUrl('url-validation')).toBe(
      'http://cp.cloudflare.com/generate_204',
    )
  }
  delayManager.setUrl('url-validation', ' HTTP://localhost:8080/ ')
  expect(delayManager.getUrl('url-validation')).toBe('HTTP://localhost:8080/')
})

test('another URL cannot replace a group measurement, but a newer matching URL can', () => {
  const member = node('url-isolation')
  if (member.kind !== 'node') throw new Error('Expected node')
  delayManager.setUrl('url-a', 'http://localhost/a')
  const cached = delayManager.setDelay(member, 'url-a', 50)
  const newer = new Date(cached.updatedAt + 1000).toISOString()
  Object.assign(member.node, {
    history: [{ time: newer, delay: 126 }],
    extra: {
      'http://localhost/a': {
        alive: true,
        history: [
          { time: new Date(cached.updatedAt - 1000).toISOString(), delay: 49 },
        ],
      },
      'http://localhost/b': {
        alive: true,
        history: [{ time: newer, delay: 126 }],
      },
    },
  })
  expect(delayManager.getDelayFix(member, 'url-a')).toBe(50)
  Object.assign(member.node, {
    extra: {
      'http://localhost/a': {
        alive: true,
        history: [{ time: newer, delay: 75 }],
      },
    },
  })
  expect(delayManager.getDelayFix(member, 'url-a')).toBe(75)
})

test('same-named provider members keep separate measurements and listeners', async () => {
  const first = node('same-provider-name')
  const second = node('same-provider-name')
  if (first.kind !== 'node' || second.kind !== 'node')
    throw new Error('Expected nodes')
  first.node.recordId = 'provider-a:N'
  first.node.source = { kind: 'provider', providerName: 'a', proxyName: 'N' }
  second.node.recordId = 'provider-b:N'
  second.node.source = { kind: 'provider', providerName: 'b', proxyName: 'N' }
  const { healthcheckNodeInProvider } = await import('tauri-plugin-mihomo-api')
  vi.mocked(healthcheckNodeInProvider)
    .mockResolvedValueOnce({ delay: 40 })
    .mockResolvedValueOnce({ delay: 125 })
  const firstListener = vi.fn()
  const secondListener = vi.fn()
  delayManager.setListener(first, 'provider-collision', firstListener)
  delayManager.setListener(second, 'provider-collision', secondListener)
  await delayManager.checkListDelay([first, second], 'provider-collision', 5000)
  await flush()
  expect(firstListener).toHaveBeenLastCalledWith(
    expect.objectContaining({ delay: 40 }),
  )
  expect(secondListener).toHaveBeenLastCalledWith(
    expect.objectContaining({ delay: 125 }),
  )
  delayManager.removeListener(first, 'provider-collision')
  delayManager.removeListener(second, 'provider-collision')
  expect(delayManager.getDelayFix(first, 'provider-collision')).toBe(40)
  expect(delayManager.getDelayFix(second, 'provider-collision')).toBe(125)
})

test.each(['core', 'provider'] as const)(
  'cached %s delays follow source identity after record IDs move',
  (kind) => {
    const original = node(`stable-${kind}`)
    const replacement = node(`replacement-${kind}`)
    if (original.kind !== 'node' || replacement.kind !== 'node')
      throw new Error('Expected nodes')
    const source = (proxyName: string) =>
      kind === 'core'
        ? { kind, proxyName }
        : { kind, providerName: 'subscription', proxyName }
    original.node.source = source(original.ref.name)
    replacement.node.source = source(replacement.ref.name)
    original.node.recordId = 'position:0'
    replacement.node.recordId = 'position:0'
    delayManager.setDelay(original, `reorder-${kind}`, 40)
    expect(delayManager.getDelayFix(replacement, `reorder-${kind}`)).toBe(-1)
    original.node.recordId = 'position:1'
    expect(delayManager.getDelayFix(original, `reorder-${kind}`)).toBe(40)
  },
)

test('unmeasured selectors show automatic history without replacing a manual URL result', () => {
  const member = node('selector-member')
  if (member.kind !== 'node') throw new Error('Expected node')
  member.node.history = [
    { time: new Date(Date.now() + 1000).toISOString(), delay: 126 },
  ]
  member.node.extra = {
    'http://localhost/automatic': { alive: true, history: member.node.history },
  }
  expect(delayManager.getDelayFix(member, 'selector')).toBe(126)
  delayManager.setDelay(member, 'selector', 50)
  expect(delayManager.getDelayFix(member, 'selector')).toBe(50)
})

test('GLOBAL measures group routes and provider nodes through their own APIs', async () => {
  const group: InteractableProxyMember = {
    kind: 'group',
    ref: { kind: 'group', name: 'Auto Select' },
    group: {
      name: 'Auto Select',
      now: 'first',
      history: [],
    } as unknown as ProxyGroupView,
  }
  const provider = node('display-name')
  if (provider.kind !== 'node') throw new Error('Expected node')
  provider.node.source = {
    kind: 'provider',
    providerName: 'subscription',
    proxyName: 'provider-node',
  }
  delayManager.setUrl('GLOBAL', 'http://localhost/global-test')
  try {
    await delayManager.checkListDelay([group, provider], 'GLOBAL', 5000)

    expect(delayProxyByName).toHaveBeenCalledWith(
      'Auto Select',
      'http://localhost/global-test',
      5000,
    )
    expect(healthcheckNodeInProvider).toHaveBeenCalledWith(
      'subscription',
      'provider-node',
      'http://localhost/global-test',
      5000,
    )
    expect(delayManager.getDelayFix(group, 'GLOBAL')).toBe(120)
    expect(delayManager.getDelayFix(provider, 'GLOBAL')).toBe(120)
  } finally {
    delayManager.setUrl('GLOBAL', '')
  }
})

test('GLOBAL manual group latency stays bound to its selected node', () => {
  const member: InteractableProxyMember = {
    kind: 'group',
    ref: { kind: 'group', name: 'global-selector' },
    group: { now: 'first', history: [] } as unknown as ProxyGroupView,
  }
  delayManager.setDelay(member, 'GLOBAL', 50)
  const changed: InteractableProxyMember = {
    ...member,
    group: { ...member.group, now: 'second' },
  }

  expect(delayManager.getDelayFix(changed, 'GLOBAL')).toBe(-1)
  expect(delayManager.getDelayFix(member, 'GLOBAL')).toBe(50)
})

test('group snapshots keep complete names containing spaces', () => {
  const names = ['Auto Select', 'Hong Kong 01', 'GLOBAL']
  const key = JSON.stringify(names)
  const snapshots = delayManager.groupsDelays(key)

  expect([...snapshots.keys()]).toEqual(names)
  expect(delayManager.groupsDelays(key)).toBe(snapshots)
  delayManager.setUrl('Auto Select', 'http://localhost/snapshot-test')
  const changed = delayManager.groupsDelays(key)
  expect(changed).not.toBe(snapshots)
  expect(changed.get('Auto Select')).not.toBe(snapshots.get('Auto Select'))
  expect(changed.get('GLOBAL')).toBe(snapshots.get('GLOBAL'))
})

test('duplicate occurrences receive updates and unsubscribe independently', async () => {
  const member = node('duplicate-occurrence')
  const first = vi.fn()
  const second = vi.fn()
  const stopFirst = delayManager.setListener(member, 'duplicates', first)
  const stopSecond = delayManager.setListener(member, 'duplicates', second)
  try {
    delayManager.setDelay(member, 'duplicates', 50)
    await flush()
    expect(first).toHaveBeenLastCalledWith(
      expect.objectContaining({ delay: 50 }),
    )
    expect(second).toHaveBeenLastCalledWith(
      expect.objectContaining({ delay: 50 }),
    )

    stopFirst()
    delayManager.setDelay(member, 'duplicates', 75)
    await flush()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith(
      expect.objectContaining({ delay: 75 }),
    )
  } finally {
    stopFirst()
    stopSecond()
  }
})

test.each([
  ['profile', 1],
  ['profile', 2],
  ['URL', 1],
  ['URL', 2],
] as const)(
  'cancels queued status work after a %s change with %i workers',
  async (change, concurrency) => {
    const group = `queued-${change}-${concurrency}`
    const first = node(`${group}-active`)
    const queued = node(`${group}-queued`)
    const report = {
      entry: { ip: null, location: null, error: null },
      exit: { ip: null, location: null, error: null },
      nat: { kind: 'unknown' as const, mappedAddress: null, detail: null },
    }
    let finish!: (value: typeof report) => void
    vi.spyOn(Math, 'random').mockReturnValue(1)
    vi.mocked(checkNodeDiagnostics).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    delayManager.setDiagnosticsGeneration(`${group}-before`)
    delayManager.setUrl(group, 'http://localhost/queued-a')
    delayManager.setDelay(queued, group, 75)
    const pending = delayManager.checkListDelay(
      [first, queued] as never,
      group,
      5000,
      concurrency,
      'status',
    )

    if (change === 'profile') {
      delayManager.setDiagnosticsGeneration(`${group}-after`)
    } else {
      delayManager.setUrl(group, 'http://localhost/queued-b')
      delayManager.setUrl(group, 'http://localhost/queued-a')
    }
    finish(report)
    await pending

    expect(checkNodeDiagnostics).toHaveBeenCalledOnce()
    expect(delayProxyByName).toHaveBeenCalledOnce()
    expect(delayManager.getDelayFix(queued, group)).not.toBe(-2)
    expect(
      delayManager.getDelayUpdate(queued, group)?.diagnostics,
    ).toBeUndefined()
  },
)

test('listener cleanup retains its original group route after a selection changes', async () => {
  const member: InteractableProxyMember = {
    kind: 'group',
    ref: { kind: 'group', name: 'mutable-selection' },
    group: { now: 'first', history: [] } as unknown as ProxyGroupView,
  }
  const originalRoute = { ...member, group: { ...member.group } }
  const listener = vi.fn()
  const stop = delayManager.setListener(member, 'GLOBAL', listener)
  member.group.now = 'second'
  stop()
  delayManager.setDelay(originalRoute, 'GLOBAL', 75)
  await flush()

  expect(listener).not.toHaveBeenCalled()
})
