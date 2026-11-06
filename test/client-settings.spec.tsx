// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HookApiError, type HookApi, type HookStatus } from '../src/client/api.js'
import { en, zh, type MessageKey } from '../src/client/i18n.js'
import { HookSettingsSection } from '../src/client/settings-section.js'

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'PostCompactFailure', 'SessionEnd'] as const
const userScope = { kind: 'user', id: 'user', title: 'User config', path: '/Users/test/.dsh/hook.json' } as const
const projectScope = { kind: 'workspace', id: 'workspace:alpha', workspaceId: 'alpha', title: 'Alpha', path: '/work/alpha/.dsh/hook.json' } as const
const initial: HookStatus = {
  scope: userScope, path: userScope.path, exists: true, revision: 7, loadError: null,
  hooks: [{
    id: 'notify', event: 'Stop', matcher: '', command: 'notify --done',
    configuredEnabled: true, authorized: true, enabled: true, authorizationReason: 'approved',
    timeoutMs: 10000, maxConcurrent: 1,
    stats: { running: 0, skipped: 2, errors: 0, lastStatus: 'completed' },
  }, {
    id: 'tool-failure', event: 'PostToolUseFailure', matcher: 'bash|edit', command: 'notify --failed',
    configuredEnabled: false, authorized: false, enabled: false, authorizationReason: 'not-approved',
    timeoutMs: 5000, maxConcurrent: 2,
    stats: { running: 1, skipped: 0, errors: 1, lastStatus: 'failed' },
  }],
}

function translator(dictionary: Record<MessageKey, string>) { return (key: MessageKey): string => dictionary[key] }
function api(overrides: Partial<HookApi> = {}): HookApi {
  return {
    scopes: vi.fn(async () => [userScope, projectScope]),
    status: vi.fn(async () => initial),
    reload: vi.fn(async () => initial),
    setEnabled: vi.fn(async (_scopeId, id, enabled) => ({
      ...initial, revision: initial.revision + 1,
      hooks: initial.hooks.map(hook => hook.id === id ? { ...hook, enabled } : hook),
    })),
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(cleanup)

describe('Hook Settings section', () => {
  function expectAllEventGroups(): void {
    const groups = screen.getAllByTestId('hook-event-group')
    expect(groups.map(group => within(group).getByRole('heading').textContent)).toEqual(events)
  }

  it('always renders all 14 event groups while scopes are loading', async () => {
    const scopes = deferred<readonly [typeof userScope, typeof projectScope]>()
    render(<HookSettingsSection api={api({ scopes: vi.fn(() => scopes.promise) })} t={translator(en)} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading Hook configuration')
    expectAllEventGroups()
    screen.getAllByRole('button', { name: /^Expand / }).forEach(button => expect(button).toBeDisabled())

    scopes.resolve([userScope, projectScope])
    await screen.findByText(userScope.path)
    expect(screen.getByRole('button', { name: 'Expand SessionStart' })).toBeEnabled()
  })

  it('keeps all 14 event groups when the scope service is unavailable', async () => {
    render(<HookSettingsSection api={api({ scopes: vi.fn(async () => { throw new Error('offline') }) })} t={translator(en)} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Hook status is unavailable.')
    expectAllEventGroups()
    screen.getAllByRole('button', { name: /^Expand / }).forEach(button => expect(button).toBeDisabled())
  })

  it('renders the exact localized settings label and all 14 event groups in fixed order when empty', async () => {
    expect(en.sectionLabel).toBe('Hooks setting')
    expect(zh.sectionLabel).toBe('Hooks 设置')
    const empty = { ...initial, hooks: [] }
    const mounted = render(<HookSettingsSection api={api({ status: vi.fn(async () => empty) })} t={translator(en)} />)

    expect(await screen.findByRole('heading', { name: 'Hooks setting' })).toBeTruthy()
    const groups = screen.getAllByTestId('hook-event-group')
    expect(groups.map(group => within(group).getByRole('heading').textContent)).toEqual(events)
    expect(screen.getAllByTestId('event-description')).toHaveLength(14)
    expect(screen.getByText('Runs when a new session starts.')).toBeTruthy()
    expect(screen.getByText('Runs before context compaction starts.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload configuration' })).toHaveAttribute('title', 'Reload configuration')

    mounted.unmount()
    render(<HookSettingsSection api={api({ status: vi.fn(async () => empty) })} t={translator(zh)} />)
    expect(await screen.findByRole('heading', { name: 'Hooks 设置' })).toBeTruthy()
    expect(screen.getAllByTestId('event-description')).toHaveLength(14)
    expect(screen.getByText('会话启动时触发。')).toBeTruthy()
    expect(screen.getByText('上下文压缩开始前触发。')).toBeTruthy()
  })

  it('groups hooks, expands configured groups, and independently toggles empty groups and hook details', async () => {
    render(<HookSettingsSection api={api()} t={translator(en)} />)
    await screen.findByRole('heading', { name: 'Hooks setting' })

    const stop = screen.getByTestId('hook-event-Stop')
    const failure = screen.getByTestId('hook-event-PostToolUseFailure')
    expect(within(stop).getByText('notify')).toBeTruthy()
    expect(within(failure).getByText('tool-failure')).toBeTruthy()
    expect(within(stop).queryByText('notify --done')).toBeNull()

    fireEvent.click(within(stop).getByRole('button', { name: 'Show details for notify' }))
    expect(within(stop).getByText('notify --done')).toBeTruthy()
    expect(within(stop).getByText('All values')).toBeTruthy()
    expect(within(stop).getByText('2 skipped')).toBeTruthy()
    expect(within(stop).getByText('Last status: completed')).toBeTruthy()
    expect(within(stop).getByText('Scope: user')).toBeTruthy()

    const empty = screen.getByTestId('hook-event-SessionStart')
    expect(within(empty).queryByText('No Hooks configured for this event.')).toBeNull()
    fireEvent.click(within(empty).getByRole('button', { name: 'Expand SessionStart' }))
    expect(within(empty).getByText('No Hooks configured for this event.')).toBeTruthy()
  })

  it('localizes the public scope id in Hook details', async () => {
    const projectStatus: HookStatus = { ...initial, scope: projectScope, path: projectScope.path }
    render(<HookSettingsSection api={api({ status: vi.fn(async scopeId => scopeId === 'user' ? initial : projectStatus) })} t={translator(zh)} />)
    await screen.findByText(userScope.path)
    fireEvent.change(screen.getByRole('combobox', { name: '配置作用域' }), { target: { value: projectScope.id } })

    const stop = await screen.findByTestId('hook-event-Stop')
    fireEvent.click(within(stop).getByRole('button', { name: '显示详情： notify' }))
    expect(within(stop).getByText(`作用域: ${projectScope.id}`)).toBeTruthy()
    expect(within(stop).queryByText(/runtime/i)).toBeNull()
  })

  it('loads scopes before user status, switches scopes, and shows missing project state', async () => {
    const calls: string[] = []
    const missing: HookStatus = { scope: projectScope, path: projectScope.path, exists: false, revision: 1, loadError: null, hooks: [] }
    const client = api({
      scopes: vi.fn(async () => { calls.push('scopes'); return [userScope, projectScope] }),
      status: vi.fn(async (scopeId) => { calls.push(`status:${scopeId}`); return scopeId === 'user' ? initial : missing }),
    })
    render(<HookSettingsSection api={client} t={translator(en)} />)
    await screen.findByText(userScope.path)

    expect(calls).toEqual(['scopes', 'status:user'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Configuration scope' }), { target: { value: projectScope.id } })
    expect(await screen.findByText('This project configuration file does not exist.')).toBeTruthy()
    expect(screen.getByText(projectScope.path)).toBeTruthy()
    expect(client.status).toHaveBeenLastCalledWith(projectScope.id)
  })

  it('ignores late status responses after switching scopes', async () => {
    const lateUser = deferred<HookStatus>()
    const projectStatus: HookStatus = { ...initial, scope: projectScope, path: projectScope.path, hooks: [] }
    const client = api({ status: vi.fn((scopeId) => scopeId === 'user' ? lateUser.promise : Promise.resolve(projectStatus)) })
    render(<HookSettingsSection api={client} t={translator(en)} />)
    const selector = await screen.findByRole('combobox', { name: 'Configuration scope' })

    fireEvent.change(selector, { target: { value: projectScope.id } })
    expect(await screen.findByText(projectScope.path)).toBeTruthy()
    lateUser.resolve(initial)
    await waitFor(() => expect(screen.queryByText(userScope.path)).toBeNull())
    expect(screen.getByText(projectScope.path)).toBeTruthy()
  })

  it('keeps the selected scope and current status when the parent supplies a new API identity', async () => {
    const projectStatus: HookStatus = { ...initial, scope: projectScope, path: projectScope.path, hooks: [] }
    const first = api({ status: vi.fn(async scopeId => scopeId === 'user' ? initial : projectStatus) })
    const nextProject = deferred<HookStatus>()
    const second = api({ status: vi.fn(scopeId => scopeId === 'user' ? Promise.resolve(initial) : nextProject.promise) })
    const mounted = render(<HookSettingsSection api={first} t={translator(en)} />)
    const selector = await screen.findByRole('combobox', { name: 'Configuration scope' })
    fireEvent.change(selector, { target: { value: projectScope.id } })
    expect(await screen.findByText(projectScope.path)).toBeTruthy()

    mounted.rerender(<HookSettingsSection api={second} t={translator(en)} />)
    await waitFor(() => expect(second.status).toHaveBeenCalledWith(projectScope.id))
    expect(selector).toHaveValue(projectScope.id)
    expect(screen.getByText(projectScope.path)).toBeTruthy()

    nextProject.resolve({ ...projectStatus, revision: 8 })
    await waitFor(() => expect(screen.getByText(projectScope.path)).toBeTruthy())
  })

  it('falls back to user when a selected workspace disappears from refreshed scopes', async () => {
    const client = api()
    vi.mocked(client.scopes).mockResolvedValueOnce([userScope, projectScope]).mockResolvedValueOnce([userScope])
    render(<HookSettingsSection api={client} t={translator(en)} />)
    const selector = await screen.findByRole('combobox', { name: 'Configuration scope' })
    fireEvent.change(selector, { target: { value: projectScope.id } })
    await waitFor(() => expect(client.status).toHaveBeenCalledWith(projectScope.id))

    fireEvent.click(screen.getByRole('button', { name: 'Reload configuration' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The selected project was removed. Showing User config.')
    expect(selector).toHaveValue('user')
    expect(client.reload).not.toHaveBeenCalledWith(projectScope.id)
    expect(client.status).toHaveBeenLastCalledWith('user')
  })

  it('updates a switch only after Host confirmation and keeps pending state identifiable', async () => {
    const write = deferred<HookStatus>()
    const client = api({ setEnabled: vi.fn(() => write.promise) })
    render(<HookSettingsSection api={client} t={translator(en)} />)
    const control = await screen.findByRole('checkbox', { name: 'Enable notify' })

    fireEvent.click(control)
    expect(control).toBeChecked()
    expect(control).toBeDisabled()
    expect(control.closest('.dnh-hook-row')).toHaveAttribute('aria-busy', 'true')
    expect(client.setEnabled).toHaveBeenCalledWith('user', 'notify', false, 7)
    write.resolve({ ...initial, revision: 8, hooks: initial.hooks.map(hook => hook.id === 'notify' ? { ...hook, enabled: false } : hook) })
    await waitFor(() => expect(control).not.toBeChecked())
    expect(control).not.toBeDisabled()
  })

  it('disables event and Hook controls while reload is pending', async () => {
    const reloadRequest = deferred<HookStatus>()
    const client = api({ reload: vi.fn(() => reloadRequest.promise) })
    render(<HookSettingsSection api={client} t={translator(en)} />)
    await screen.findByRole('checkbox', { name: 'Enable notify' })

    fireEvent.click(screen.getByRole('button', { name: 'Reload configuration' }))

    screen.getAllByRole('button', { name: /^(Expand|Collapse) / }).forEach(button => expect(button).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Show details for notify' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Enable notify' })).toBeDisabled()

    reloadRequest.resolve(initial)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload configuration' })).toBeEnabled())
    screen.getAllByRole('button', { name: /^(Expand|Collapse) / }).forEach(button => expect(button).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Show details for notify' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Enable notify' })).toBeEnabled()
  })

  it('preserves expanded empty groups and collapsed configured groups across reloads', async () => {
    const client = api()
    render(<HookSettingsSection api={client} t={translator(en)} />)
    const empty = await screen.findByTestId('hook-event-SessionStart')
    const stop = screen.getByTestId('hook-event-Stop')
    fireEvent.click(within(empty).getByRole('button', { name: 'Expand SessionStart' }))
    fireEvent.click(within(stop).getByRole('button', { name: 'Collapse Stop' }))
    expect(within(empty).getByText('No Hooks configured for this event.')).toBeTruthy()
    expect(within(stop).queryByText('notify')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Reload configuration' }))
    await waitFor(() => expect(client.reload).toHaveBeenCalledWith('user'))
    expect(within(empty).getByText('No Hooks configured for this event.')).toBeTruthy()
    expect(within(stop).getByRole('button', { name: 'Expand Stop' })).toBeTruthy()
    expect(within(stop).queryByText('notify')).toBeNull()
  })

  it('distinguishes invalid configuration and unavailable service states', async () => {
    const invalid = api({ status: vi.fn(async () => ({ ...initial, hooks: [], loadError: 'invalid regex' })) })
    const mounted = render(<HookSettingsSection api={invalid} t={translator(en)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Configuration could not be loaded: invalid regex')

    mounted.unmount()
    render(<HookSettingsSection api={api({ scopes: vi.fn(async () => { throw new Error('offline detail') }) })} t={translator(en)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Hook status is unavailable.')
    expect(screen.queryByText('offline detail')).toBeNull()
  })

  it('distinguishes incompatible responses without exposing response details', async () => {
    const incompatible = new HookApiError('invalid_schema', 'response contains secret detail', 200, 'schema')
    render(<HookSettingsSection api={api({ status: vi.fn(async () => { throw incompatible }) })} t={translator(en)} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Hook service returned an incompatible response.')
    expect(screen.queryByText(/secret detail/)).toBeNull()
  })

  it('keeps the prior switch state and hides details when a write fails', async () => {
    const client = api({ setEnabled: vi.fn(async () => { throw new Error('network secret') }) })
    render(<HookSettingsSection api={client} t={translator(en)} />)
    const control = await screen.findByRole('checkbox', { name: 'Enable notify' })
    fireEvent.click(control)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update this Hook. Reload and try again.')
    expect(control).toBeChecked()
    expect(screen.queryByText('network secret')).toBeNull()
  })

  it('reloads only the current scope on revision conflict and ignores its late result after a switch', async () => {
    const conflictReload = deferred<HookStatus>()
    const projectStatus: HookStatus = { ...initial, scope: projectScope, path: projectScope.path, hooks: [] }
    const client = api({
      status: vi.fn(async (scopeId) => scopeId === 'user' ? initial : projectStatus),
      reload: vi.fn(() => conflictReload.promise),
      setEnabled: vi.fn(async () => { throw new HookApiError('revision_conflict', 'changed', 409) }),
    })
    render(<HookSettingsSection api={client} t={translator(en)} />)
    const control = await screen.findByRole('checkbox', { name: 'Enable notify' })
    fireEvent.click(control)
    await waitFor(() => expect(client.reload).toHaveBeenCalledWith('user'))

    fireEvent.change(screen.getByRole('combobox', { name: 'Configuration scope' }), { target: { value: projectScope.id } })
    expect(await screen.findByText(projectScope.path)).toBeTruthy()
    conflictReload.resolve({ ...initial, revision: 8 })
    await waitFor(() => expect(screen.queryByText(userScope.path)).toBeNull())
    expect(screen.getByText(projectScope.path)).toBeTruthy()
  })
})
