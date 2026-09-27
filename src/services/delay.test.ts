import { delayProxyByName } from 'tauri-plugin-mihomo-api'
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

import type { ResolvedProxyMember } from '@/types/proxy-view'

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
    const update = delayManager.getDelayUpdate('status-node', 'g')
    expect(update?.delay).toBe(120)
    expect(update?.diagnostics?.status).toBe('done')

    await delayManager.checkDelay(member as never, 'g', 5000)
    expect(checkNodeDiagnostics).toHaveBeenCalledTimes(1)
    expect(
      delayManager.getDelayUpdate('status-node', 'g')?.diagnostics,
    ).toEqual(update?.diagnostics)
  })
})
