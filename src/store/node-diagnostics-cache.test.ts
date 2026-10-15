import { describe, expect, test } from 'vitest'

import type { DiagnosticsState } from '@/services/node-diagnostics'

import { NodeDiagnosticsCache } from './node-diagnostics-cache'

const result: DiagnosticsState = {
  status: 'done',
  result: {
    entry: { ip: '192.0.2.1', location: 'entry', error: null },
    exit: { ip: '198.51.100.1', location: 'exit', error: null },
    nat: {
      kind: 'full-cone',
      mappedAddress: '198.51.100.1:1234',
      detail: null,
    },
  },
}

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe('node diagnostics lifetime', () => {
  test('restores completed results after a WebView recreation in the same generation', () => {
    const storage = memoryStorage()
    const first = new NodeDiagnosticsCache(() => storage)
    first.setGeneration('profile-a')
    first.set('node-a', 'http://test/a', result)

    const reopened = new NodeDiagnosticsCache(() => storage)
    reopened.setGeneration('profile-a')
    expect(reopened.get('node-a', 'http://test/a')).toEqual(result)
    expect(reopened.get('node-b', 'http://test/a')).toBeUndefined()
    expect(reopened.get('node-a', 'http://test/b')).toBeUndefined()
  })

  test('a different profile generation cannot restore or retain old results', () => {
    const storage = memoryStorage()
    const first = new NodeDiagnosticsCache(() => storage)
    first.setGeneration('profile-a')
    first.set('node-a', 'http://test/a', result)

    const changed = new NodeDiagnosticsCache(() => storage)
    changed.setGeneration('profile-b')
    expect(changed.get('node-a', 'http://test/a')).toBeUndefined()

    first.setGeneration('profile-b')
    expect(first.get('node-a', 'http://test/a')).toBeUndefined()
  })

  test('never restores an interrupted check as permanently testing', () => {
    const storage = memoryStorage()
    const first = new NodeDiagnosticsCache(() => storage)
    first.setGeneration('profile-a')
    first.set('completed', 'http://test/a', result)
    first.set('completed', 'http://test/a', { status: 'testing' })
    first.set('unfinished', 'http://test/a', { status: 'testing' })

    const reopened = new NodeDiagnosticsCache(() => storage)
    reopened.setGeneration('profile-a')
    expect(reopened.get('completed', 'http://test/a')).toEqual(result)
    expect(reopened.get('unfinished', 'http://test/a')).toBeUndefined()
  })

  test('unavailable storage still retains live results', () => {
    const cache = new NodeDiagnosticsCache(() => {
      throw new Error('storage unavailable')
    })
    cache.setGeneration('profile-a')
    cache.set('node-a', 'http://test/a', result)
    expect(cache.get('node-a', 'http://test/a')).toEqual(result)
  })

  test('ignores malformed persisted reports', () => {
    const storage = memoryStorage()
    storage.setItem(
      'node-diagnostics-v1',
      JSON.stringify({
        generation: 'profile-a',
        entries: [['node-a', { status: 'done', result: {} }]],
      }),
    )
    const cache = new NodeDiagnosticsCache(() => storage)
    cache.setGeneration('profile-a')
    expect(cache.get('node-a', 'http://test/a')).toBeUndefined()
  })
})
