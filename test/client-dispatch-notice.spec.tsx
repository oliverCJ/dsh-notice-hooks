// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { appendPluginRecord, Session, SessionId } from '@deepseek-ai/dsh-session'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
  createHookDispatchDefinition,
  HOOK_DISPATCH_NODE,
  HookDispatchRow,
} from '../src/client/dispatch-notice.js'
import { HOOK_DISPATCH_RECORD } from '../src/dispatch-notice.js'
import { en, zh } from '../src/client/i18n.js'
import type { HookDispatchNotice } from '../src/dispatch-notice.js'

afterEach(cleanup)

const notice: HookDispatchNotice = {
  event: 'Stop',
  triggered: [
    { scope: 'user', id: 'notify' },
    { scope: 'workspace:project', id: 'audit' },
  ],
  blocked: [
    { scope: 'user', id: 'disabled', reason: 'configured-disabled' },
    { scope: 'workspace:project', id: 'unapproved', reason: 'not-approved' },
    { scope: 'workspace:project', id: 'changed', reason: 'fingerprint-changed' },
  ],
}

function pluginEvent(data: unknown = notice) {
  const session = Session.create(SessionId('client-dispatch-test'))
  appendPluginRecord(session, HOOK_DISPATCH_RECORD, data as never)
  return session.snapshotEvents()[0]!
}

function translate(messages: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>) => {
    let value = messages[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replaceAll(`{${name}}`, String(replacement))
    }
    return value
  }
}

function nodeFrom(data: HookDispatchNotice = notice) {
  const definition = createHookDispatchDefinition()
  const event = pluginEvent(data)
  const result = definition.match(event as never)
  expect(result).toEqual({ id: `dispatch:${event.seq}`, role: 'start', exclusive: true })

  const match = { event, role: 'start' as const, location: { kind: 'session' as const } }
  const baseContext = {
    key: `${HOOK_DISPATCH_NODE}:dispatch:${event.seq}`,
    kind: HOOK_DISPATCH_NODE,
    id: `dispatch:${event.seq}`,
    matches: [match],
    start: match,
    current: new Map(),
  }
  const state = definition.start(baseContext as never, match as never, { previous: () => undefined })
  return definition.buildViewNode?.({ ...baseContext, state } as never)
}

describe('Hook dispatch Conversation Definition', () => {
  it('creates one stable Chat activity node for each valid plugin record', () => {
    const node = nodeFrom()

    expect(node).toMatchObject({
      key: `${HOOK_DISPATCH_NODE}:dispatch:0`,
      kind: HOOK_DISPATCH_NODE,
      id: 'dispatch:0',
      target: 'chat',
      anchorSeq: 0,
      location: { kind: 'session' },
      visibility: 'visible',
      data: notice,
    })
  })

  it.each([
    null,
    {},
    { ...notice, event: 'FutureEvent' },
    { ...notice, triggered: [{ scope: 'user', id: '' }] },
    { ...notice, blocked: [{ scope: 'user', id: 'x', reason: 'future-reason' }] },
    { ...notice, future: true },
  ])('ignores empty, malformed, or future payload %#', (data) => {
    const definition = createHookDispatchDefinition()
    expect(definition.match(pluginEvent(data) as never)).toBeNull()
  })

  it('renders a valid compaction dispatch record as one Chat node', () => {
    const compact = { event: 'PreCompact', triggered: [{ scope: 'user', id: 'compact' }], blocked: [] } as const
    expect(nodeFrom(compact)).toMatchObject({ kind: HOOK_DISPATCH_NODE, data: compact })
  })

  it('does not claim other plugin records', () => {
    const definition = createHookDispatchDefinition()
    const session = Session.create(SessionId('other-plugin-event'))
    appendPluginRecord(session, 'plugin:other/activity' as never, notice as never)
    expect(definition.match(session.snapshotEvents()[0]! as never)).toBeNull()
  })
})

describe('Hook dispatch activity row', () => {
  it('renders one compact Chinese row in dispatch order with distinct blocked reasons', () => {
    const node = nodeFrom()
    render(<HookDispatchRow node={node as never} t={translate(zh) as never} />)

    const row = screen.getByRole('status')
    expect(row).toHaveClass('dnh-dispatch-row')
    expect(row.querySelector('svg')?.closest('span')).toHaveClass('dnh-dispatch-icon')
    expect(row).toHaveTextContent('Hook · Stop')
    expect(row).toHaveTextContent('user/notify 已触发')
    expect(row).toHaveTextContent('workspace:project/audit 已触发')
    expect(row).toHaveTextContent('user/disabled 已禁用')
    expect(row).toHaveTextContent('workspace:project/unapproved 未授权')
    expect(row).toHaveTextContent('workspace:project/changed 配置已变更，需授权')
    expect(row).not.toHaveTextContent('Hook 事件')
    expect(row).not.toHaveTextContent('触发失败')
    expect(row.textContent?.indexOf('user/notify')).toBeLessThan(row.textContent?.indexOf('workspace:project/audit') ?? -1)
    expect(row.textContent?.indexOf('workspace:project/audit')).toBeLessThan(row.textContent?.indexOf('user/disabled') ?? -1)
  })

  it('uses the current locale at render time without changing node data', () => {
    const node = nodeFrom()
    const original = structuredClone(node?.data)
    const { rerender } = render(<HookDispatchRow node={node as never} t={translate(zh) as never} />)
    expect(screen.getByRole('status')).toHaveTextContent('user/notify 已触发')

    rerender(<HookDispatchRow node={node as never} t={translate(en) as never} />)
    expect(screen.getByRole('status')).toHaveTextContent('Hook · Stop')
    expect(screen.getByRole('status')).toHaveTextContent('user/notify triggered')
    expect(screen.getByRole('status')).toHaveTextContent('workspace:project/unapproved unauthorized')
    expect(screen.getByRole('status')).not.toHaveTextContent('was not authorized and did not run')
    expect(node?.data).toEqual(original)
  })

  it('accepts exactly the keyed Chat renderer props used by the activity flow', () => {
    type RowProps = ComponentProps<typeof HookDispatchRow>
    expectTypeOf<RowProps['node']['kind']>().toEqualTypeOf<typeof HOOK_DISPATCH_NODE>()
  })
})
