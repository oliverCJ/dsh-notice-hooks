// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HookStatus, HookView } from '../src/client/api.js'
import { HookReviewButton } from '../src/client/review-button.js'
import { HookReviewDialog } from '../src/client/review-dialog.js'
import type { HookReviewSnapshot } from '../src/client/review-controller.js'
import { en, zh } from '../src/client/i18n.js'

afterEach(cleanup)

const userScope = { kind: 'user', id: 'user', title: 'User config', path: '/home/.dsh/hook.json' } as const
const projectScope = { kind: 'workspace', id: 'workspace:project', workspaceId: 'project', title: 'Project', path: '/work/.dsh/hook.json' } as const

function hook(id: string, overrides: Partial<HookView> = {}): HookView {
  return {
    id, event: 'PreToolUse', matcher: 'bash|edit', command: `/usr/local/bin/notify --hook ${id}`,
    configuredEnabled: true, authorized: false, enabled: false, authorizationReason: 'not-approved',
    timeoutMs: 10000, maxConcurrent: 2,
    stats: { running: 0, skipped: 0, errors: 0, lastStatus: null },
    ...overrides,
  }
}

function status(scope: typeof userScope | typeof projectScope, hooks: readonly HookView[]): HookStatus {
  return { scope, path: scope.path, exists: true, revision: 1, loadError: null, hooks }
}

function snapshot(overrides: Partial<HookReviewSnapshot> = {}): HookReviewSnapshot {
  return {
    byScope: { user: status(userScope, [hook('user-hook')]) },
    loadingScopes: [], errors: {}, dialog: null,
    ...overrides,
  }
}

function useSnapshot(value: HookReviewSnapshot) {
  return <T,>(selector: (snapshot: HookReviewSnapshot) => T): T => selector(value)
}

function translate(messages: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>) => {
    let value = messages[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
    return value
  }
}

function buttonProps(value: HookReviewSnapshot, workspaces: readonly unknown[] = []) {
  return {
    sessionId: 'session-1',
    useWorkspaces: (selector: (snapshot: { items: readonly unknown[] }) => unknown) => selector({ items: workspaces }),
    useHookReview: useSnapshot(value),
    retain: vi.fn(() => vi.fn()),
    open: vi.fn(async () => undefined),
    t: translate(en),
  }
}

function dialogProps(value: HookReviewSnapshot) {
  return {
    useHookReview: useSnapshot(value),
    close: vi.fn(), toggle: vi.fn(), authorize: vi.fn(async () => undefined),
    t: translate(en),
  }
}

describe('Hook review composer button', () => {
  it('renders nothing when current session scopes have no pending Hooks', () => {
    const props = buttonProps(snapshot({ byScope: { user: status(userScope, []) } }))
    const { container } = render(<HookReviewButton {...props as never} />)
    expect(container).toBeEmptyDOMElement()
    expect(props.retain).toHaveBeenCalledWith('session-1', ['user'])
  })

  it('shows current user and project pending count and opens only those scopes', async () => {
    const project = { workspaceId: 'project', sessionIds: ['session-1'] }
    const other = { workspaceId: 'other', sessionIds: ['other-session'] }
    const value = snapshot({
      byScope: {
        user: status(userScope, [hook('user-hook')]),
        'workspace:project': status(projectScope, [hook('project-hook')]),
        'workspace:other': status({ ...projectScope, id: 'workspace:other', workspaceId: 'other' }, [hook('other-hook')]),
      },
    })
    const props = buttonProps(value, [other, project])
    render(<HookReviewButton {...props as never} />)

    const button = screen.getByRole('button', { name: 'Review 2 Hook authorizations' })
    expect(button).toHaveAttribute('title', 'Review 2 Hook authorizations')
    expect(props.retain).toHaveBeenCalledWith('session-1', ['user', 'workspace:project'])
    fireEvent.click(button)
    await waitFor(() => expect(props.open).toHaveBeenCalledWith(['user', 'workspace:project']))
  })
})

describe('Hook review dialog', () => {
  const openSnapshot = snapshot({
    byScope: {
      user: status(userScope, [hook('user-hook')]),
      'workspace:project': status(projectScope, [hook('changed', { authorizationReason: 'fingerprint-changed', command: 'notify --changed' })]),
    },
    dialog: { scopeIds: ['user', 'workspace:project'], selected: [], submitting: false, failures: {} },
  })

  it('renders grouped execution details with nothing selected by default', () => {
    const props = dialogProps(openSnapshot)
    render(<HookReviewDialog {...props as never} />)

    const dialog = screen.getByRole('dialog', { name: 'Review Hook authorizations' })
    expect(within(dialog).getByText('Hook commands run outside the DSH sandbox. Review each command before authorizing.')).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: 'User config' })).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: 'Project' })).toBeTruthy()
    expect(within(dialog).getByText('/usr/local/bin/notify --hook user-hook')).toBeTruthy()
    expect(within(dialog).getByText('notify --changed')).toBeTruthy()
    expect(within(dialog).getByText('bash|edit')).toBeTruthy()
    expect(within(dialog).getByText('10000 ms')).toBeTruthy()
    expect(within(dialog).getByText('Configuration changed')).toBeTruthy()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
    within(dialog).getAllByRole('checkbox').forEach(checkbox => expect(checkbox).not.toBeChecked())
    expect(within(dialog).getByRole('button', { name: 'Authorize selected' })).toBeDisabled()
  })

  it('routes selection, authorize-all, selected authorization, and close actions', () => {
    const selected = { ...openSnapshot, dialog: { ...openSnapshot.dialog!, selected: ['user\0user-hook'] } }
    const props = dialogProps(selected)
    render(<HookReviewDialog {...props as never} />)
    const dialog = screen.getByRole('dialog')

    fireEvent.click(within(dialog).getAllByRole('checkbox')[1]!)
    expect(props.toggle).toHaveBeenCalledWith('workspace:project\0changed')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authorize selected' }))
    expect(props.authorize).toHaveBeenCalledWith('selected')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authorize all' }))
    expect(props.authorize).toHaveBeenCalledWith('all')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }))
    expect(props.close).toHaveBeenCalled()
  })

  it('closes on Escape or mask click and returns focus to the opener', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'opener'
    document.body.appendChild(opener)
    opener.focus()
    const props = dialogProps(openSnapshot)
    const mounted = render(<HookReviewDialog {...props as never} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.close).toHaveBeenCalledOnce()

    mounted.rerender(<HookReviewDialog {...dialogProps(snapshot()) as never} />)
    await waitFor(() => expect(opener).toHaveFocus())
    mounted.rerender(<HookReviewDialog {...props as never} />)
    fireEvent.click(screen.getByTestId('hook-review-mask'))
    expect(props.close).toHaveBeenCalledTimes(2)
    opener.remove()
  })

  it('renders localized Chinese action copy', () => {
    const props = { ...dialogProps(openSnapshot), t: translate(zh) }
    render(<HookReviewDialog {...props as never} />)
    expect(screen.getByRole('dialog', { name: '审核 Hook 授权' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '授权全部' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '暂不处理' })).toBeTruthy()
  })
})
