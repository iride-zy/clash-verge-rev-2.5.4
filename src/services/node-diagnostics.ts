import { invoke } from '@tauri-apps/api/core'

export interface NetworkEndpoint {
  ip: string | null
  location: string | null
  error: string | null
}

export interface NodeDiagnostics {
  entry: NetworkEndpoint
  exit: NetworkEndpoint
  nat: {
    kind:
      | 'unknown'
      | 'unsupported'
      | 'full-cone'
      | 'restricted-cone'
      | 'port-restricted-cone'
      | 'symmetric'
    mappedAddress: string | null
    detail: string | null
  }
}

export type DiagnosticsState =
  | { status: 'testing' }
  | { status: 'done'; result: NodeDiagnostics }
  | { status: 'error'; detail: string }

export const checkNodeDiagnostics = (
  name: string,
  provider: string | undefined,
  timeout: number,
  udp: boolean,
) =>
  invoke<NodeDiagnostics>('check_node_diagnostics', {
    name,
    provider,
    timeout,
    udp,
  })
