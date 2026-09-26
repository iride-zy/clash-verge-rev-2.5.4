import { Box, Tooltip } from '@mui/material'
import { useTranslation } from 'react-i18next'

import type {
  DiagnosticsState,
  NetworkEndpoint,
} from '@/services/node-diagnostics'

const NAT_NAMES = {
  'full-cone': 'Full Cone',
  'restricted-cone': 'Restricted Cone',
  'port-restricted-cone': 'Port Restricted Cone',
  symmetric: 'Symmetric',
} as const

export function NodeNetworkInfo({ state }: { state?: DiagnosticsState }) {
  const { t } = useTranslation()
  const fallback = t(
    state?.status === 'testing'
      ? 'proxies.diagnostics.testing'
      : state?.status === 'error'
        ? 'proxies.diagnostics.failed'
        : 'proxies.diagnostics.untested',
  )
  const result = state?.status === 'done' ? state.result : undefined
  const unknown = t('proxies.diagnostics.unknown')
  const endpoint = (value?: NetworkEndpoint) =>
    value ? `${value.ip ?? unknown} · ${value.location ?? unknown}` : fallback
  const nat = result?.nat.kind
  const natText =
    nat === 'unsupported'
      ? t('proxies.diagnostics.unsupported')
      : nat === 'unknown'
        ? unknown
        : nat
          ? NAT_NAMES[nat]
          : fallback
  const lines = [
    `UDP NAT: ${natText}`,
    `${t('proxies.diagnostics.entry')}: ${endpoint(result?.entry)}`,
    `${t('proxies.diagnostics.exit')}: ${endpoint(result?.exit)}`,
  ]
  const details = [
    ...lines,
    result?.nat.mappedAddress ? `UDP: ${result.nat.mappedAddress}` : null,
    result?.nat.detail,
    result?.entry.error,
    result?.exit.error,
    state?.status === 'error' ? state.detail : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <Tooltip title={<Box sx={{ whiteSpace: 'pre-wrap' }}>{details}</Box>}>
      <Box
        component="span"
        sx={{
          display: 'block',
          mt: 0.5,
          fontSize: 11,
          lineHeight: '16px',
          color: 'text.secondary',
          minWidth: 0,
        }}
      >
        {lines.map((line) => (
          <Box
            component="span"
            key={line}
            sx={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {line}
          </Box>
        ))}
      </Box>
    </Tooltip>
  )
}
