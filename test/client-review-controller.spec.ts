import { describe, expect, it, vi } from 'vitest'
import { HookApiError, type HookApi, type HookStatus, type HookView } from '../src/client/api.js'
import {
  HookReviewController,
  pendingFor,
  type HookReviewSnapshot,
} from '../src/client/review-controller.js'

const userScope = { kind: 'user', id: 'user', title: 'User config', path: '/home/.dsh/hook.json' } as const
const projectScope = { kind: 'workspace', id: 'workspace:project', workspaceId: 'project', title: 'Project', path: '/work/.dsh/hook.json' } as const

function hook(id: string, overrides: Partial<HookView> = {}): HookView {
  return {
    id, event: 'Stop', matcher: '', command: `notify ${id}`,
    configuredEnabled: true, authorized: false, enabled: false, authorizationReason: 'not-approved',
    timeoutMs: 10000, maxConcurrent: 1,
    stats: { running: 0, skipped: 0, errors: 0, lastStatus: null },
    ...overrides,
  }
}

function status(scope: typeof userScope | typeof projectScope, hooks: readonly HookView[], revision = 1): HookStatus {
  return { scope, path: scope.path, exists: true, revision, loadError: null, hooks }
}

function api(overrides: Partial<HookApi> = {}): HookApi {
  return {
    scopes: vi.fn(async () => [userScope, projectScope]),
    status: vi.fn(async scopeId => scopeId === 'user' ? status(userScope, []) : status(projectScope, [])),
    reload: vi.fn(async scopeId => scopeId === 'user' ? status(userScope, []) : status(projectScope, [])),
    setConfiguredEnabled: vi.fn(async () => { throw new Error('unexpected setConfiguredEnabled') }),
    setAuthorized: vi.fn(async () => { throw new Error('unexpected setAuthorized') }),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function emptySnapshot(byScope: HookReviewSnapshot['byScope']): HookReviewSnapshot {
  return { byScope, loadingScopes: [], errors: {}, dialog: null }
}

describe('HookReviewController', () => {
  it('collects only configured unauthorized Hooks in requested scope and document order', () => {
    const user = status(userScope, [
      hook('unapproved'),
      hook('disabled', { configuredEnabled: false }),
      hook('approved', { authorized: true, enabled: true, authorizationReason: 'approved' }),
      hook('changed', { authorizationReason: 'fingerprint-changed' }),
    ])
    const project = status(projectScope, [hook('project')])
    const snapshot = emptySnapshot({ user, 'workspace:project': project })

    expect(pendingFor(snapshot, ['user', 'workspace:project']).map(item => [item.key, item.reason])).toEqual([
      ['user\0unapproved', 'not-approved'],
      ['user\0changed', 'fingerprint-changed'],
      ['workspace:project\0project', 'not-approved'],
    ])
    expect(pendingFor(snapshot, ['user']).map(item => item.hook.id)).toEqual(['unapproved', 'changed'])
  })

  it('retains active session scopes, refreshes them, and owns one polling timer', async () => {
    const statusFn = vi.fn(async scopeId => scopeId === 'user' ? status(userScope, [hook('u')]) : status(projectScope, [hook('p')]))
    let poll: (() => void) | undefined
    const cancel = vi.fn()
    const schedule = vi.fn((callback: () => void, delay: number) => { poll = callback; expect(delay).toBe(15000); return cancel })
    const controller = new HookReviewController({ api: api({ status: statusFn }), schedule })

    const releaseA = controller.retain('session-a', ['user', 'workspace:project'])
    const releaseB = controller.retain('session-b', ['user'])
    await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(2))
    expect(schedule).toHaveBeenCalledOnce()
    expect(pendingFor(controller.source.getSnapshot(), ['user', 'workspace:project'])).toHaveLength(2)

    poll?.()
    await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(4))
    controller.focus()
    await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(6))
    controller.reconnect()
    await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(8))

    releaseA()
    expect(cancel).not.toHaveBeenCalled()
    releaseB()
    expect(cancel).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('serializes same-scope refreshes and removes a scope confirmed missing', async () => {
    const first = deferred<HookStatus>()
    const second = deferred<HookStatus>()
    const statusFn = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockRejectedValueOnce(new HookApiError('not_found', 'gone', 404))
    const controller = new HookReviewController({ api: api({ status: statusFn }) })

    const older = controller.refresh(['user'])
    const newer = controller.refresh(['user'])
    await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(1))
    first.resolve(status(userScope, [hook('old')], 1))
    await older
    await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(2))
    second.resolve(status(userScope, [hook('new')], 2))
    await newer
    expect(controller.source.getSnapshot().byScope.user?.hooks[0]?.id).toBe('new')

    await controller.refresh(['user'])
    expect(controller.source.getSnapshot().byScope.user).toBeUndefined()
    expect(controller.source.getSnapshot().errors.user).toBe('not_found')
    controller.dispose()
  })

  it('does not let an older refresh overwrite a newer accepted Host status', async () => {
    const pending = deferred<HookStatus>()
    const controller = new HookReviewController({ api: api({ status: vi.fn(() => pending.promise) }) })
    const refresh = controller.refresh(['user'])
    const approved = status(userScope, [hook('new', { authorized: true, enabled: true, authorizationReason: 'approved' })], 3)
    controller.accept(approved)
    pending.resolve(status(userScope, [hook('old')], 2))
    await refresh

    expect(controller.source.getSnapshot().byScope.user).toBe(approved)
    expect(controller.source.getSnapshot().loadingScopes).toEqual([])
    controller.dispose()
  })

  it('rejects a lower-revision status accepted from another UI path', () => {
    const controller = new HookReviewController({ api: api() })
    const newer = status(userScope, [hook('new')], 5)
    controller.accept(newer)
    controller.accept(status(userScope, [hook('old')], 4))
    expect(controller.source.getSnapshot().byScope.user).toBe(newer)
    controller.dispose()
  })

  it('serializes same-scope mutations so equal-revision responses cannot arrive out of order', async () => {
    const first = deferred<HookStatus>()
    const second = deferred<HookStatus>()
    const setAuthorized = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const controller = new HookReviewController({ api: api({ setAuthorized }) })
    const firstUpdate = controller.clientApi.setAuthorized('user', 'u1', false, 4)
    const secondUpdate = controller.clientApi.setAuthorized('user', 'u2', false, 4)

    await vi.waitFor(() => expect(setAuthorized).toHaveBeenCalledTimes(1))
    first.resolve(status(userScope, [hook('u1'), hook('u2', { authorized: true, enabled: true, authorizationReason: 'approved' })], 4))
    await firstUpdate
    await vi.waitFor(() => expect(setAuthorized).toHaveBeenCalledTimes(2))
    second.resolve(status(userScope, [hook('u1'), hook('u2')], 4))
    await secondUpdate

    expect(controller.source.getSnapshot().byScope.user?.hooks.every(hook => !hook.authorized)).toBe(true)
    controller.dispose()
  })

  it('authorizes selected Hooks with revision chaining and closes when none remain', async () => {
    const userInitial = status(userScope, [hook('u1'), hook('u2')], 4)
    const userAfterFirst = status(userScope, [
      hook('u1', { authorized: true, enabled: true, authorizationReason: 'approved' }), hook('u2'),
    ], 4)
    const userAfterSecond = status(userScope, [
      hook('u1', { authorized: true, enabled: true, authorizationReason: 'approved' }),
      hook('u2', { authorized: true, enabled: true, authorizationReason: 'approved' }),
    ], 4)
    const setAuthorized = vi.fn()
      .mockResolvedValueOnce(userAfterFirst)
      .mockResolvedValueOnce(userAfterSecond)
    const onStatus = vi.fn()
    const controller = new HookReviewController({ api: api({ status: vi.fn(async () => userInitial), setAuthorized }) })
    controller.accept(userInitial)
    await controller.open(['user'], onStatus)
    controller.toggle('user\0u1')
    controller.toggle('user\0u2')

    await controller.authorize('selected')

    expect(setAuthorized.mock.calls).toEqual([
      ['user', 'u1', true, 4],
      ['user', 'u2', true, 4],
    ])
    expect(onStatus).toHaveBeenLastCalledWith(userAfterSecond)
    expect(controller.source.getSnapshot().dialog).toBeNull()
    controller.dispose()
  })

  it('stops a failed scope, continues another scope, and keeps failures open', async () => {
    const user = status(userScope, [hook('u1'), hook('u2')], 3)
    const project = status(projectScope, [hook('p1')], 7)
    const projectDone = status(projectScope, [hook('p1', { authorized: true, enabled: true, authorizationReason: 'approved' })], 8)
    const setAuthorized = vi.fn(async (scopeId: string, id: string) => {
      if (scopeId === 'user' && id === 'u1') throw new HookApiError('revision_conflict', 'changed', 409)
      if (scopeId === 'workspace:project' && id === 'p1') return projectDone
      throw new Error('same-scope processing should have stopped')
    })
    const controller = new HookReviewController({ api: api({ status: vi.fn(async scopeId => scopeId === 'user' ? user : project), setAuthorized }) })
    controller.accept(user)
    controller.accept(project)
    await controller.open(['user', 'workspace:project'])

    await controller.authorize('all')

    expect(setAuthorized.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['user', 'u1'],
      ['workspace:project', 'p1'],
    ])
    expect(controller.source.getSnapshot().dialog).toMatchObject({
      failures: { 'user\0u1': 'revision_conflict' }, submitting: false,
    })
    expect(pendingFor(controller.source.getSnapshot(), ['user', 'workspace:project']).map(item => item.key)).toEqual([
      'user\0u1', 'user\0u2',
    ])
    controller.dispose()
  })
})
