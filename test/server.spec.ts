import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHookApi } from '../src/client/api.js'
import type { HookConfigState, HookConfigStore } from '../src/config-store.js'
import type { HookScopeManager, HookScopeView } from '../src/scope-manager.js'
import type { HookRunner } from '../src/runner.js'
import { createHookRequestHandler } from '../src/server.js'

const initialState: HookConfigState = {
  path: '/tmp/hook.json',
  exists: true,
  revision: 3,
  hooks: [{
    id: 'notify',
    type: 'command',
    event: 'Stop',
    matcherSource: '',
    matcher: /(?:)/i,
    command: 'notify --done',
    enabled: true,
    timeoutMs: 10000,
    maxConcurrent: 1,
  }],
  loadError: null,
}

function createStore(state: HookConfigState = initialState): HookConfigStore {
  return {
    state: vi.fn(() => state),
    subscribe: vi.fn(() => () => undefined),
    reload: vi.fn(async () => state),
    setEnabled: vi.fn(async (id, enabled, revision) => ({
      ...state,
      revision: revision + 1,
      hooks: state.hooks.map(hook => hook.id === id ? { ...hook, enabled } : hook),
    })),
    dispose: vi.fn(async () => undefined),
  }
}

function createRunner(): HookRunner {
  return {
    run: vi.fn(),
    cancel: vi.fn(),
    reconcile: vi.fn(),
    stats: vi.fn(() => ({
      [JSON.stringify(['user', 'notify'])]: { running: 1, skipped: 2, errors: 3, lastStatus: 'failed' as const },
      [JSON.stringify(['workspace:project-a', 'notify'])]: { running: 4, skipped: 5, errors: 6, lastStatus: 'completed' as const },
    })),
    dispose: vi.fn(async () => undefined),
  }
}

function createManager(store: HookConfigStore, scopeId = 'user'): HookScopeManager {
  const state = store.state()
  const scope: HookScopeView = scopeId === 'user'
    ? { kind: 'user' as const, id: 'user' as const, title: 'User config' as const, path: state.path }
    : { kind: 'workspace' as const, id: scopeId as `workspace:${string}`, workspaceId: scopeId.slice('workspace:'.length), title: scopeId, path: state.path }
  return {
    listScopes: vi.fn(() => [scope]),
    accessScope: vi.fn(async () => ({ scope, store })),
    bindSession: vi.fn(async () => [{ scope, store }]),
    releaseSession: vi.fn(async () => undefined),
    currentScopes: vi.fn(() => [{ scope, store }]),
    subscribe: vi.fn(() => () => undefined),
    scopeHook: vi.fn((binding, hook) => ({
      scope: binding.scope,
      hook,
      runtimeId: JSON.stringify([binding.scope.id, hook.id]),
      fingerprint: `sha256:${'a'.repeat(64)}` as const,
      configuredEnabled: hook.enabled,
      authorized: false,
      enabled: false,
      authorizationReason: 'not-approved' as const,
    })),
    updateHookConfiguredEnabled: vi.fn(async (binding, id, enabled, revision) => binding.store.setEnabled(id, enabled, revision)),
    updateHookAuthorization: vi.fn(async (binding) => binding.store.reload()),
    dispose: vi.fn(async () => undefined),
  }
}

async function listen(
  target: HookConfigStore | HookScopeManager = createStore(),
  runner = createRunner(),
  origin?: string,
): Promise<{
  base: string
  server: Server
  store: HookConfigStore
}> {
  let base = ''
  const manager = 'listScopes' in target ? target : createManager(target)
  const store = 'state' in target ? target : (await target.accessScope('user')).store
  const server = createServer(createHookRequestHandler(manager, runner, () => origin ?? base))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  return { base, server, store }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function statusWithHost(url: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    req.once('error', reject)
    req.end()
  })
}

describe('hook settings HTTP API', () => {
  it('returns sanitized config status and aggregate counters', async () => {
    const fixture = await listen()
    servers.push(fixture.server)

    const response = await fetch(`${fixture.base}/dsh-notice-hooks/status`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      ok: true,
      value: {
        scope: { kind: 'user', id: 'user', title: 'User config', path: '/tmp/hook.json' },
        path: '/tmp/hook.json',
        exists: true,
        revision: 3,
        loadError: null,
        hooks: [{
          id: 'notify', event: 'Stop', matcher: '', command: 'notify --done',
          configuredEnabled: true, authorized: false, enabled: false, authorizationReason: 'not-approved',
          timeoutMs: 10000, maxConcurrent: 1,
          stats: { running: 1, skipped: 2, errors: 3, lastStatus: 'failed' },
        }],
      },
    })
    expect(JSON.stringify(await (await fetch(`${fixture.base}/dsh-notice-hooks/status`)).json())).not.toMatch(/stdout|stderr/)

    const client = createHookApi((input, init) => fetch(new URL(String(input), fixture.base), init))
    await expect(client.status('user')).resolves.toMatchObject({
      scope: { id: 'user' },
      hooks: [{
        configuredEnabled: true, authorized: false, enabled: false, authorizationReason: 'not-approved',
      }],
    })
  })

  it('reloads and independently updates Hook configuration and authorization', async () => {
    const store = createStore()
    const manager = createManager(store)
    const fixture = await listen(manager)
    servers.push(fixture.server)

    const reloaded = await fetch(`${fixture.base}/dsh-notice-hooks/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'user' }),
    })
    expect(reloaded.status).toBe(200)
    expect(store.reload).toHaveBeenCalledOnce()

    const configured = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/notify/configured-enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, revision: 3 }),
    })
    expect(configured.status).toBe(200)
    expect(manager.updateHookConfiguredEnabled).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ id: 'user' }) }), 'notify', false, 3)

    const authorized = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/notify/authorization`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorized: false, revision: 3 }),
    })
    expect(authorized.status).toBe(200)
    expect(manager.updateHookAuthorization).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ id: 'user' }) }), 'notify', false, 3)
  })

  it('maps malformed input, unknown hooks, and stale revisions to stable errors', async () => {
    const store = createStore()
    const manager = createManager(store)
    vi.mocked(manager.updateHookConfiguredEnabled).mockRejectedValueOnce(Object.assign(new Error('changed'), { name: 'HookConfigConflictError' }))
    const fixture = await listen(manager)
    servers.push(fixture.server)

    const malformed = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/notify/configured-enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ ok: false, error: { code: 'invalid_request', message: 'Invalid request.' } })

    const invalidAuthorization = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/notify/authorization`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, revision: 3 }),
    })
    expect(invalidAuthorization.status).toBe(400)

    const unknown = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/missing/authorization`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorized: true, revision: 3 }),
    })
    expect(unknown.status).toBe(404)

    vi.mocked(manager.updateHookAuthorization).mockRejectedValueOnce(Object.assign(new Error('disabled'), { name: 'HookNotConfiguredEnabledError' }))
    const disabled = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/notify/authorization`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorized: true, revision: 3 }),
    })
    expect(disabled.status).toBe(409)
    expect(await disabled.json()).toEqual({ ok: false, error: { code: 'hook_not_configured_enabled', message: 'Enable the Hook configuration before authorizing it.' } })

    const stale = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/notify/configured-enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, revision: 3 }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ ok: false, error: { code: 'revision_conflict', message: 'Configuration changed. Reload and try again.' } })
  })

  it('rejects non-JSON, oversized, cross-origin, and unsupported requests', async () => {
    const fixture = await listen(createStore(), createRunner())
    servers.push(fixture.server)

    expect((await fetch(`${fixture.base}/dsh-notice-hooks/reload`, { method: 'POST', body: '{}' })).status).toBe(415)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(5000) }),
    })).status).toBe(413)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/missing/authorization`, {
      method: 'PUT', body: '{}',
    })).status).toBe(415)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/scopes/workspace%3Amissing/hooks/missing/configured-enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(5000) }),
    })).status).toBe(413)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/status`, { headers: { origin: 'https://example.com' } })).status).toBe(403)
    expect(await statusWithHost(`${fixture.base}/dsh-notice-hooks/status`, 'example.com')).toBe(403)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/status`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/missing`)).status).toBe(404)
  })

  it('serves explicit scopes and keeps same hook IDs isolated by runtime scope', async () => {
    const userStore = createStore({ ...initialState, path: '/user/hook.json' })
    const projectStore = createStore({ ...initialState, path: '/project/hook.json', revision: 7 })
    const userManager = createManager(userStore)
    const projectManager = createManager(projectStore, 'workspace:project-a')
    const manager: HookScopeManager = {
      ...userManager,
      listScopes: vi.fn((): readonly HookScopeView[] => [
        { kind: 'user', id: 'user', title: 'User config', path: '/user/hook.json' },
        { kind: 'workspace', id: 'workspace:project-a', workspaceId: 'project-a', title: 'Project A', path: '/project/hook.json' },
      ]),
      accessScope: vi.fn(async (scopeId: string) => scopeId === 'user'
        ? (await userManager.accessScope('user'))
        : (await projectManager.accessScope('workspace:project-a'))),
    }
    const runner = createRunner()
    const fixture = await listen(manager, runner)
    servers.push(fixture.server)

    const scopes = await fetch(`${fixture.base}/dsh-notice-hooks/scopes`)
    expect(scopes.status).toBe(200)
    expect(await scopes.json()).toEqual({ ok: true, value: { scopes: await manager.listScopes() } })

    const status = await fetch(`${fixture.base}/dsh-notice-hooks/status?scope=workspace%3Aproject-a`)
    expect(status.status).toBe(200)
    const statusValue = (await status.json()).value
    expect(statusValue).toMatchObject({
      scope: { id: 'workspace:project-a' }, path: '/project/hook.json', exists: true, revision: 7,
    })

    const reloaded = await fetch(`${fixture.base}/dsh-notice-hooks/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'workspace:project-a' }),
    })
    expect(reloaded.status).toBe(200)
    expect(projectStore.reload).toHaveBeenCalledOnce()
    expect(userStore.reload).not.toHaveBeenCalled()

    const updated = await fetch(`${fixture.base}/dsh-notice-hooks/scopes/workspace%3Aproject-a/hooks/notify/configured-enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, revision: 7 }),
    })
    expect(updated.status).toBe(200)
    expect(manager.updateHookConfiguredEnabled).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ id: 'workspace:project-a' }) }), 'notify', false, 7)
    expect(projectStore.setEnabled).toHaveBeenCalledWith('notify', false, 7)
    expect(userStore.setEnabled).not.toHaveBeenCalled()
    expect(statusValue.hooks[0].stats).toEqual({ running: 4, skipped: 5, errors: 6, lastStatus: 'completed' })
  })

  it('requires explicit mutable scopes and rejects unknown or legacy routes', async () => {
    const manager = createManager(createStore())
    vi.mocked(manager.accessScope).mockImplementation(async (scopeId) => {
      if (scopeId !== 'user') throw new Error(`unknown hook scope: ${scopeId}`)
      return { scope: manager.listScopes()[0]!, store: createStore() }
    })
    const fixture = await listen(manager)
    servers.push(fixture.server)

    expect((await fetch(`${fixture.base}/dsh-notice-hooks/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(400)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/hooks/notify/configured-enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, revision: 3 }),
    })).status).toBe(404)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/scopes/user/hooks/notify/enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, revision: 3 }),
    })).status).toBe(404)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/status?scope=workspace%3Amissing`)).status).toBe(404)
    expect((await fetch(`${fixture.base}/dsh-notice-hooks/status?scope=%E0%A4%A`)).status).toBe(400)
  })

  it('sanitizes unexpected failures', async () => {
    const store = createStore()
    vi.mocked(store.reload).mockRejectedValueOnce(new Error('secret path and stack'))
    const fixture = await listen(store)
    servers.push(fixture.server)

    const response = await fetch(`${fixture.base}/dsh-notice-hooks/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'user' }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: { code: 'internal_error', message: 'Hook configuration operation failed.' } })
  })
})
