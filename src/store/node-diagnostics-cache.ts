import type { DiagnosticsState } from '@/services/node-diagnostics'

const STORAGE_KEY = 'node-diagnostics-v1'

type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type CompletedDiagnostics = Exclude<DiagnosticsState, { status: 'testing' }>

const getStorage = (): StorageAccess | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const nullableString = (value: unknown) =>
  value === null || typeof value === 'string'

const isEndpoint = (value: unknown) =>
  isRecord(value) &&
  nullableString(value.ip) &&
  nullableString(value.location) &&
  nullableString(value.error)

const isCompleted = (value: unknown): value is CompletedDiagnostics => {
  if (!isRecord(value)) return false
  if (value.status === 'error') return typeof value.detail === 'string'
  if (value.status !== 'done' || !isRecord(value.result)) return false
  const { entry, exit, nat } = value.result
  return (
    isEndpoint(entry) &&
    isEndpoint(exit) &&
    isRecord(nat) &&
    typeof nat.kind === 'string' &&
    [
      'unknown',
      'unsupported',
      'full-cone',
      'restricted-cone',
      'port-restricted-cone',
      'symmetric',
    ].includes(nat.kind) &&
    nullableString(nat.mappedAddress) &&
    nullableString(nat.detail) &&
    (nat.estimated === undefined || typeof nat.estimated === 'boolean')
  )
}

/** Status results outlive latency TTLs and a lightweight-mode WebView recreation. */
export class NodeDiagnosticsCache {
  private generation: string | null | undefined
  private states = new Map<string, DiagnosticsState>()
  private completed = new Map<string, CompletedDiagnostics>()

  constructor(private readonly storage = getStorage) {}

  setGeneration(generation: string | null) {
    if (generation === this.generation) return
    const firstRead = this.generation === undefined
    this.generation = generation
    this.states.clear()
    this.completed.clear()

    if (firstRead && generation !== null) {
      try {
        const saved: unknown = JSON.parse(
          this.storage()?.getItem(STORAGE_KEY) ?? 'null',
        )
        if (
          isRecord(saved) &&
          saved.generation === generation &&
          Array.isArray(saved.entries)
        ) {
          for (const entry of saved.entries) {
            if (
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              isCompleted(entry[1])
            ) {
              this.states.set(entry[0], entry[1])
              this.completed.set(entry[0], entry[1])
            }
          }
        }
      } catch {
        // An unavailable or obsolete cache must not prevent live status checks.
      }
    }
    this.persist()
  }

  get(key: string, url: string): DiagnosticsState | undefined {
    return this.states.get(JSON.stringify([key, url]))
  }

  set(key: string, url: string, state: DiagnosticsState) {
    const scopedKey = JSON.stringify([key, url])
    this.states.set(scopedKey, state)
    if (state.status !== 'testing') {
      this.completed.set(scopedKey, state)
      this.persist()
    }
  }

  cancelTesting(key: string, url: string, testing?: DiagnosticsState) {
    const scopedKey = JSON.stringify([key, url])
    const current = this.states.get(scopedKey)
    if (current?.status !== 'testing' || (testing && current !== testing))
      return
    const previous = this.completed.get(scopedKey)
    if (previous) this.states.set(scopedKey, previous)
    else this.states.delete(scopedKey)
  }

  private persist() {
    try {
      const storage = this.storage()
      if (this.generation == null || this.completed.size === 0) {
        storage?.removeItem(STORAGE_KEY)
      } else {
        storage?.setItem(
          STORAGE_KEY,
          JSON.stringify({
            generation: this.generation,
            entries: [...this.completed],
          }),
        )
      }
    } catch {
      // Retain in-memory results even when browser storage is unavailable/full.
    }
  }
}
