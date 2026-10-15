import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

import type { ProxyGroupView, ResolvedProxyMember } from '@/types/proxy-view'

const state = vi.hoisted(() => ({ delay: 0 }))
vi.mock('@/hooks/use-proxy-delay-state', () => ({
  useProxyDelayState: () => ({
    delayState: { delay: state.delay, updatedAt: 1 },
    delayValue: state.delay,
    isPreset: false,
    timeout: 10000,
    onDelay: vi.fn(),
  }),
}))
vi.mock('@/components/base', () => ({ BaseLoading: () => null }))
vi.mock('@mui/icons-material', () => ({
  CheckCircleOutlineRounded: () =>
    createElement('i', { 'data-testid': 'CheckCircleOutlineRoundedIcon' }),
}))
vi.mock('./node-network-info', () => ({ NodeNetworkInfo: () => null }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { ProxyItem } from './proxy-item'
import { ProxyItemMini } from './proxy-item-mini'

const group = { name: 'GLOBAL' } as ProxyGroupView
const member = {
  kind: 'group',
  ref: { kind: 'group', name: 'Auto Select' },
  group: { now: 'node', type: 'Selector' },
} as ResolvedProxyMember

describe.each([
  ['single column', ProxyItem],
  ['multiple columns', ProxyItemMini],
] as const)('%s GLOBAL delay display', (_, Component) => {
  test('shows the core timeout sentinel as a result', () => {
    state.delay = 0
    const html = renderToStaticMarkup(
      createElement(Component, { group, member, selected: true }),
    )

    expect(html).toContain('Timeout')
    expect(html).not.toContain('data-testid="CheckCircleOutlineRoundedIcon"')
  })
})
