import { afterEach, describe, expect, it, vi } from 'vitest'
import { HookApiError, createHookApi } from '../src/client/api.js'

const userScope = { kind: 'user', id: 'user', title: 'User config', path: '/home/test/.dsh/hook.json' } as const
const workspaceScope = {
  kind: 'workspace', id: 'workspace:alpha / beta', workspaceId: 'alpha / beta',
  title: 'Project Alpha', path: '/work/alpha/.dsh/hook.json',
} as const
const status = {
  scope: userScope,
  path: userScope.path,
  exists: true,
  revision: 4,
  loadError: null,
  hooks: [{
    id: 'notify done', event: 'Stop', matcher: '', command: 'notify --done',
    configuredEnabled: true, authorized: true, enabled: true, authorizationReason: 'approved',
    timeoutMs: 10000, maxConcurrent: 1,
    stats: { running: 0, skipped: 2, errors: 1, lastStatus: 'failed' },
  }],
} as const
const workspaceStatus = { ...status, scope: workspaceScope, path: workspaceScope.path } as const

const response = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
  ...init,
})

afterEach(() => vi.restoreAllMocks())

describe('Hook Settings client API', () => {
  it('loads and strictly validates trusted scopes and scoped status', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, value: { scopes: [userScope, workspaceScope] } }))
      .mockResolvedValueOnce(response({ ok: true, value: workspaceStatus }))
    const api = createHookApi(fetcher)

    await expect(api.scopes()).resolves.toEqual([userScope, workspaceScope])
    await expect(api.status('workspace:alpha / beta')).resolves.toEqual(workspaceStatus)
    expect(fetcher).toHaveBeenNthCalledWith(1, '/dsh-notice-hooks/scopes', { headers: { accept: 'application/json' } })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/dsh-notice-hooks/status?scope=workspace%3Aalpha+%2F+beta', {
      headers: { accept: 'application/json' },
    })
  })

  it('reloads and independently writes encoded configuration and authorization operations', async () => {
    const fetcher = vi.fn(async () => response({ ok: true, value: workspaceStatus }))
    const api = createHookApi(fetcher)

    await api.reload('workspace:alpha / beta')
    await api.setConfiguredEnabled('workspace:alpha / beta', 'notify / done', false, 4)
    await api.setAuthorized('workspace:alpha / beta', 'notify / done', false, 4)

    expect(fetcher).toHaveBeenNthCalledWith(1, '/dsh-notice-hooks/reload', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'workspace:alpha / beta' }),
    })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/dsh-notice-hooks/scopes/workspace%3Aalpha%20%2F%20beta/hooks/notify%20%2F%20done/configured-enabled', {
      method: 'PUT', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, revision: 4 }),
    })
    expect(fetcher).toHaveBeenNthCalledWith(3, '/dsh-notice-hooks/scopes/workspace%3Aalpha%20%2F%20beta/hooks/notify%20%2F%20done/authorization', {
      method: 'PUT', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ authorized: false, revision: 4 }),
    })
    const calls = fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>
    expect(calls.flatMap(call => [String(call[0]), call[1]?.body]).join('\n')).not.toContain('/work/alpha')
    expect(calls.flatMap(call => [String(call[0]), call[1]?.body]).join('\n')).not.toContain('runtimeId')
  })

  it('rejects malformed envelopes, scopes, status fields, events and config ranges', async () => {
    const invalidScopeValues: unknown[] = [
      { scopes: 'bad' },
      { scopes: [{ ...userScope, kind: 'workspace' }] },
      { scopes: [{ ...workspaceScope, workspaceId: 3 }] },
      { scopes: [{ ...workspaceScope, id: 'user' }] },
      { scopes: [workspaceScope, userScope] },
      { scopes: [userScope, { ...userScope }] },
      { scopes: [userScope, { ...workspaceScope, id: 'workspace:other' }] },
      { scopes: [userScope, workspaceScope, { ...workspaceScope }] },
    ]
    for (const value of invalidScopeValues) {
      await expect(createHookApi(vi.fn(async () => response({ ok: true, value }))).scopes())
        .rejects.toMatchObject({ code: 'invalid_schema', stage: 'schema' })
    }

    const invalidStatuses: unknown[] = [
      { ...status, exists: 'yes' },
      { ...status, path: '/different/path' },
      { ...status, scope: { ...userScope, title: 1 } },
      { ...status, scope: workspaceScope, path: workspaceScope.path },
      { ...status, hooks: [{ ...status.hooks[0], id: '' }] },
      { ...status, hooks: [{ ...status.hooks[0], configuredEnabled: 'yes' }] },
      { ...status, hooks: [{ ...status.hooks[0], authorized: 'yes' }] },
      { ...status, hooks: [{ ...status.hooks[0], authorizationReason: 'unknown' }] },
      { ...status, hooks: [{ ...status.hooks[0], configuredEnabled: false, authorized: true, enabled: true }] },
      { ...status, hooks: [{ ...status.hooks[0], command: '   ' }] },
      { ...status, hooks: [{ ...status.hooks[0], event: 'UnknownEvent' }] },
      { ...status, hooks: [{ ...status.hooks[0], timeoutMs: 99 }] },
      { ...status, hooks: [{ ...status.hooks[0], timeoutMs: 60001 }] },
      { ...status, hooks: [{ ...status.hooks[0], maxConcurrent: 0 }] },
      { ...status, hooks: [{ ...status.hooks[0], maxConcurrent: 5 }] },
      { ...status, hooks: [{ ...status.hooks[0], stats: { ...status.hooks[0].stats, running: -1 } }] },
    ]
    for (const value of invalidStatuses) {
      await expect(createHookApi(vi.fn(async () => response({ ok: true, value }))).status('user'))
        .rejects.toMatchObject({ code: 'invalid_schema', stage: 'schema' })
    }
    await expect(createHookApi(vi.fn(async () => response({ value: status }))).status('user'))
      .rejects.toMatchObject({ code: 'invalid_envelope', stage: 'envelope' })
  })

  it('preserves fetch, JSON, envelope, schema, HTTP, and business error stages', async () => {
    const business = createHookApi(vi.fn(async () => response({
      ok: false,
      error: { code: 'revision_conflict', message: 'Configuration changed. Reload and try again.' },
    }, { status: 409 })))
    await expect(business.reload('user')).rejects.toMatchObject({
      status: 409, code: 'revision_conflict', stage: 'business',
    })

    await expect(createHookApi(vi.fn(async () => { throw new Error('network secret') })).status('user'))
      .rejects.toMatchObject({ code: 'request_failed', stage: 'fetch', status: 0 })
    await expect(createHookApi(vi.fn(async () => new Response('<html>', { status: 502 }))).status('user'))
      .rejects.toMatchObject({ code: 'invalid_json', stage: 'json', status: 502 })
    await expect(createHookApi(vi.fn(async () => response({ value: status }))).status('user'))
      .rejects.toMatchObject({ code: 'invalid_envelope', stage: 'envelope', status: 200 })
    await expect(createHookApi(vi.fn(async () => response({ ok: true, value: { ...status, hooks: 'bad' } }))).status('user'))
      .rejects.toMatchObject({ code: 'invalid_schema', stage: 'schema', status: 200 })
    await expect(createHookApi(vi.fn(async () => response({ ok: true, value: status }, { status: 503 }))).status('user'))
      .rejects.toMatchObject({ code: 'http_error', stage: 'http', status: 503 })
  })
})
