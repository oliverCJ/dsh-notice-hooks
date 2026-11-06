import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedHook } from '../src/config.ts'
import { HookConfigConflictError } from '../src/config-store.ts'
import type { HookConfigState, HookConfigStore, OpenHookConfigStoreOptions } from '../src/config-store.ts'
import type { AuthorizationStore } from '../src/authorization-store.ts'
import type { AuthorizationFingerprint } from '../src/authorization.ts'
import { fingerprintHook } from '../src/authorization.ts'
import { createHookRunner } from '../src/runner.ts'
import { createHookScopeManager, encodeHookRuntimeId } from '../src/scope-manager.ts'
import type { HookScopeManager, WorkspaceLike, WorkspaceRegistryLike } from '../src/scope-manager.ts'
import type { HookPayload } from '../src/types.ts'

const fixture = fileURLToPath(new URL('./fixtures/child-process.mjs', import.meta.url))
const roots: string[] = []
const managers: HookScopeManager[] = []

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

function workspace(id: string, path: string, title = id): WorkspaceLike {
  return { id, path, title }
}

function registry(initial: readonly WorkspaceLike[]) {
  let current = [...initial]
  const resolveByPath = vi.fn(async (path: string) => current.find(value => path === value.path || path.startsWith(`${value.path}/`)))
  const value: WorkspaceRegistryLike = {
    get: id => current.find(item => item.id === id),
    list: () => current,
    resolveByPath,
  }
  return {
    value,
    resolveByPath,
    replace(next: readonly WorkspaceLike[]) {
      current = [...next]
    },
  }
}

function fakeStore(path: string): HookConfigStore & {
  disposed: boolean
  publish(): void
  listenerCount(): number
} {
  const state: HookConfigState = Object.freeze({ path, exists: false, revision: 1, loadError: null, hooks: [] })
  const listeners = new Set<(state: HookConfigState) => void>()
  return {
    disposed: false,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reload: async () => state,
    setEnabled: async () => state,
    publish() {
      for (const listener of listeners) listener(state)
    },
    listenerCount: () => listeners.size,
    async dispose() {
      this.disposed = true
      listeners.clear()
    },
  }
}

type OpenStore = (options?: OpenHookConfigStoreOptions) => Promise<HookConfigStore>

function memoryAuthorizations(initial: Array<[string, string, AuthorizationFingerprint]> = []): AuthorizationStore {
  const values = new Map(initial.map(([scopeId, hookId, fingerprint]) => [JSON.stringify([scopeId, hookId]), fingerprint]))
  return {
    get: (scopeId, hookId) => values.get(JSON.stringify([scopeId, hookId])),
    grant: vi.fn(async (scopeId, hookId, fingerprint) => { values.set(JSON.stringify([scopeId, hookId]), fingerprint) }),
    revoke: vi.fn(async (scopeId, hookId) => { values.delete(JSON.stringify([scopeId, hookId])) }),
  }
}

const createWithStores = createHookScopeManager as unknown as (
  options: Parameters<typeof createHookScopeManager>[0],
  dependencies: {
    openStore: OpenStore
    openAuthorizationStore: () => Promise<AuthorizationStore>
  },
) => Promise<HookScopeManager>

async function managed(workspaceRegistry: WorkspaceRegistryLike, openStore: OpenStore): Promise<HookScopeManager> {
  const manager = await createWithStores(
    { workspaceRegistry, userConfigPath: '/user/.dsh/hook.json' },
    { openStore, openAuthorizationStore: async () => memoryAuthorizations() },
  )
  managers.push(manager)
  return manager
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function payload(cwd: string): HookPayload {
  return {
    schema_version: 1, source: 'deepseek-harness', hook_event_name: 'PreToolUse', session_id: 'session', cwd,
    timestamp: '2026-11-04T00:00:00.000Z', turn_id: null, agent_id: null, agent_type: 'main', tool_name: null,
    tool_use_id: null, tool_input: null, tool_response: null, prompt: null, last_assistant_message: null, reason: null, error: null,
    compaction_id: null, source_command_id: null,
  }
}

function hook(id: string, overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return {
    event: 'PreToolUse',
    matcherSource: '',
    matcher: /(?:)/i,
    id,
    type: 'command',
    command: '/bin/true',
    enabled: true,
    timeoutMs: 1_000,
    maxConcurrent: 1,
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('可信作用域与 Store 生命周期', () => {
  it('没有 Workspace Registry 时只公开并绑定用户作用域', async () => {
    const manager = await createWithStores(
      { userConfigPath: '/user/.dsh/hook.json' } as Parameters<typeof createHookScopeManager>[0],
      { openStore: async options => fakeStore(options?.path ?? '/default'), openAuthorizationStore: async () => memoryAuthorizations() },
    )
    managers.push(manager)

    expect(manager.listScopes()).toEqual([
      { kind: 'user', id: 'user', title: 'User config', path: '/user/.dsh/hook.json' },
    ])
    await expect(manager.bindSession('session', '/untrusted/project')).resolves.toMatchObject([
      { scope: { id: 'user' } },
    ])
    await expect(manager.accessScope('workspace:project')).rejects.toThrow(/unknown hook scope/i)
    expect(manager.currentScopes()).toMatchObject([{ scope: { id: 'user' } }])
  })

  it('无效 Workspace Registry 返回或抛错时 fail closed 到用户作用域', async () => {
    const malformed: WorkspaceRegistryLike = {
      get: () => { throw new Error('get failed') },
      list: () => null as never,
      resolveByPath: async () => ({ id: 1, path: null, title: [] } as never),
    }
    const manager = await createWithStores(
      { workspaceRegistry: malformed, userConfigPath: '/user/.dsh/hook.json' },
      { openStore: async options => fakeStore(options?.path ?? '/default'), openAuthorizationStore: async () => memoryAuthorizations() },
    )
    managers.push(manager)

    expect(manager.listScopes()).toEqual([
      { kind: 'user', id: 'user', title: 'User config', path: '/user/.dsh/hook.json' },
    ])
    await expect(manager.bindSession('session', '/untrusted/project')).resolves.toMatchObject([
      { scope: { id: 'user' } },
    ])
    await expect(manager.accessScope('workspace:project')).rejects.toThrow(/unknown hook scope/i)
  })

  it('始终先列出用户作用域，并仅按 registry 顺序构造工作区路径', async () => {
    const source = registry([
      workspace('alpha', '/work/alpha', 'Alpha'),
      workspace('../beta', '/trusted/beta', 'Beta'),
    ])
    const manager = await managed(source.value, async options => fakeStore(options?.path ?? '/default'))

    expect(manager.listScopes()).toEqual([
      { kind: 'user', id: 'user', title: 'User config', path: '/user/.dsh/hook.json' },
      { kind: 'workspace', id: 'workspace:alpha', workspaceId: 'alpha', title: 'Alpha', path: '/work/alpha/.dsh/hook.json' },
      { kind: 'workspace', id: 'workspace:../beta', workspaceId: '../beta', title: 'Beta', path: '/trusted/beta/.dsh/hook.json' },
    ])
  })

  it('惰性打开并复用项目 Store，且查看缺失项目配置不创建目录', async () => {
    const userRoot = await temporaryRoot('hook-user')
    const projectRoot = await temporaryRoot('hook-project')
    const source = registry([workspace('project', projectRoot, 'Project')])
    const manager = await createHookScopeManager({
      workspaceRegistry: source.value,
      userConfigPath: join(userRoot, '.dsh', 'hook.json'),
      authorizationPath: join(userRoot, '.dsh', 'dsh-notice-hooks', 'authorizations.json'),
    })
    managers.push(manager)

    await expect(lstat(join(projectRoot, '.dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
    const first = await manager.accessScope('workspace:project')
    const second = await manager.accessScope('workspace:project')

    expect(second.store).toBe(first.store)
    expect(first.store.state()).toMatchObject({ exists: false, path: join(projectRoot, '.dsh', 'hook.json') })
    await expect(lstat(join(projectRoot, '.dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('拒绝未知、伪造和已删除的 workspace scope，并在 dispose 时释放缓存', async () => {
    const source = registry([workspace('known', '/work/known')])
    const stores: Array<ReturnType<typeof fakeStore>> = []
    const manager = await managed(source.value, async options => {
      const store = fakeStore(options?.path ?? '/default')
      stores.push(store)
      return store
    })

    await expect(manager.accessScope('workspace:unknown')).rejects.toThrow(/unknown hook scope/i)
    await expect(manager.accessScope('workspace:known/../../outside')).rejects.toThrow(/unknown hook scope/i)
    await manager.accessScope('workspace:known')
    source.replace([])
    await expect(manager.accessScope('workspace:known')).rejects.toThrow(/unknown hook scope/i)
    expect(stores[1]?.disposed).toBe(true)

    await manager.dispose()
    expect(stores.every(store => store.disposed)).toBe(true)
  })

  it('项目 Store 打开期间被删除时最终拒绝普通访问并释放刚打开的 Store', async () => {
    const source = registry([workspace('project', '/work/project')])
    let finishOpen!: (store: HookConfigStore) => void
    const projectStore = fakeStore('/work/project/.dsh/hook.json')
    const openStore = vi.fn(async options => {
      if (options?.path === '/user/.dsh/hook.json') return fakeStore(options.path)
      return new Promise<HookConfigStore>(resolve => { finishOpen = resolve })
    })
    const manager = await managed(source.value, openStore)

    const access = manager.accessScope('workspace:project')
    await vi.waitFor(() => expect(openStore).toHaveBeenCalledTimes(2))
    source.replace([])
    finishOpen(projectStore)

    await expect(access).rejects.toThrow(/unknown hook scope/i)
    expect(projectStore.disposed).toBe(true)
    expect(manager.currentScopes()).toHaveLength(1)
  })

  it('同 ID 路径替换时保留活动 Session 的旧 Store，并在最后 release 独立清理', async () => {
    const source = registry([workspace('project', '/work/old')])
    const stores = new Map<string, ReturnType<typeof fakeStore>>()
    const manager = await managed(source.value, async options => {
      const path = options?.path ?? '/default'
      const store = fakeStore(path)
      stores.set(path, store)
      return store
    })

    const oldBinding = await manager.bindSession('old-session', '/work/old/subdir')
    const oldStore = oldBinding[1]!.store as ReturnType<typeof fakeStore>
    source.replace([workspace('project', '/work/new')])
    const newBinding = await manager.accessScope('workspace:project')
    const newStore = newBinding.store as ReturnType<typeof fakeStore>

    expect(oldStore).not.toBe(newStore)
    expect(manager.currentScopes().map(binding => binding.store.state().path)).toEqual([
      '/user/.dsh/hook.json',
      '/work/old/.dsh/hook.json',
      '/work/new/.dsh/hook.json',
    ])
    await manager.releaseSession('old-session')
    expect(oldStore.disposed).toBe(true)
    expect(oldStore.listenerCount()).toBe(0)
    expect(newStore.disposed).toBe(false)
    expect(manager.currentScopes().map(binding => binding.store.state().path)).toEqual([
      '/user/.dsh/hook.json',
      '/work/new/.dsh/hook.json',
    ])
    expect(stores.size).toBe(3)
  })

  it('同 ID 旧路径 opening 未完成时为新路径启动独立 opening', async () => {
    const source = registry([workspace('project', '/work/old')])
    let finishOld!: (store: HookConfigStore) => void
    const oldStore = fakeStore('/work/old/.dsh/hook.json')
    const newStore = fakeStore('/work/new/.dsh/hook.json')
    const openStore = vi.fn(async options => {
      if (options?.path === '/user/.dsh/hook.json') return fakeStore(options.path)
      if (options?.path === '/work/old/.dsh/hook.json') {
        return new Promise<HookConfigStore>(resolve => { finishOld = resolve })
      }
      return newStore
    })
    const manager = await managed(source.value, openStore)

    const oldAccess = manager.accessScope('workspace:project')
    await vi.waitFor(() => expect(openStore).toHaveBeenCalledTimes(2))
    source.replace([workspace('project', '/work/new')])
    const newAccess = manager.accessScope('workspace:project')
    await new Promise<void>(resolve => setImmediate(resolve))
    const callsAfterReplacement = openStore.mock.calls.length
    finishOld(oldStore)
    const [oldResult, newResult] = await Promise.allSettled([oldAccess, newAccess])

    expect(callsAfterReplacement).toBe(3)
    expect(oldResult.status).toBe('rejected')
    expect(newResult).toMatchObject({
      status: 'fulfilled',
      value: { store: { disposed: false } },
    })
    expect(newStore.state().path).toBe('/work/new/.dsh/hook.json')
    expect(oldStore.disposed).toBe(true)
  })

  it('dispose 开始即拒绝新访问，并清理此前尚未完成的 Store opening', async () => {
    const source = registry([workspace('project', '/work/project')])
    let finishOpen!: (store: HookConfigStore) => void
    const projectStore = fakeStore('/work/project/.dsh/hook.json')
    const openStore = vi.fn(async options => {
      if (options?.path === '/user/.dsh/hook.json') return fakeStore(options.path)
      return new Promise<HookConfigStore>(resolve => { finishOpen = resolve })
    })
    const manager = await managed(source.value, openStore)
    const opening = manager.accessScope('workspace:project')
    await vi.waitFor(() => expect(openStore).toHaveBeenCalledTimes(2))

    const disposing = manager.dispose()
    const lateBinding = manager.bindSession('late', '/work/project')
    const lateAccess = manager.accessScope('user')
    finishOpen(projectStore)

    await expect(opening).rejects.toThrow(/disposed/i)
    await expect(lateBinding).rejects.toThrow(/disposed/i)
    await expect(lateAccess).rejects.toThrow(/disposed/i)
    await disposing
    expect(projectStore.disposed).toBe(true)
  })

  it('已进入且阻塞于清理的普通访问在 dispose 后不得返回 Store', async () => {
    const source = registry([workspace('project', '/work/project')])
    let finishDispose!: () => void
    const projectStore = fakeStore('/work/project/.dsh/hook.json')
    const projectDispose = vi.fn(() => new Promise<void>(resolve => {
      finishDispose = () => {
        projectStore.disposed = true
        resolve()
      }
    }))
    projectStore.dispose = projectDispose
    const manager = await managed(source.value, async options => (
      options?.path === '/user/.dsh/hook.json' ? fakeStore(options.path) : projectStore
    ))
    await manager.accessScope('workspace:project')
    source.replace([])

    const access = manager.accessScope('user')
    await vi.waitFor(() => expect(projectDispose).toHaveBeenCalledOnce())
    const disposing = manager.dispose()
    finishDispose()

    await expect(access).rejects.toThrow(/disposed/i)
    await disposing
  })

  it('聚合订阅可观察惰性 Store 变化，并在 Store 释放后清理内部订阅', async () => {
    const source = registry([workspace('project', '/work/project')])
    const stores: Array<ReturnType<typeof fakeStore>> = []
    const manager = await managed(source.value, async options => {
      const store = fakeStore(options?.path ?? '/default')
      stores.push(store)
      return store
    })
    const listener = vi.fn()
    const unsubscribe = manager.subscribe(listener)

    expect(manager.currentScopes()).toHaveLength(1)
    const project = await manager.accessScope('workspace:project')
    expect(manager.currentScopes()).toMatchObject([{ scope: { id: 'user' } }, { scope: { id: 'workspace:project' } }])
    expect(listener).toHaveBeenCalledTimes(1)
    stores[1]!.publish()
    expect(listener).toHaveBeenCalledTimes(2)

    source.replace([])
    await expect(manager.accessScope('workspace:project')).rejects.toThrow(/unknown hook scope/i)
    expect(manager.currentScopes()).toMatchObject([{ scope: { id: 'user' } }])
    expect(stores[1]!.listenerCount()).toBe(0)
    stores[1]!.publish()
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    await manager.dispose()
    stores[0]!.publish()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(project.store).toBe(stores[1])
  })
})

describe('Session 固定关联', () => {
  it('并发首次观察复用同一关联 Promise，且后续 cwd 不改变归属', async () => {
    const source = registry([workspace('project', '/work/project')])
    let resolve!: (value: WorkspaceLike | undefined) => void
    const pending = new Promise<WorkspaceLike | undefined>(done => { resolve = done })
    source.resolveByPath.mockReturnValueOnce(pending)
    const manager = await managed(source.value, async options => fakeStore(options?.path ?? '/default'))

    const first = manager.bindSession('session-1', '/work/project/subdir')
    const second = manager.bindSession('session-1', '/other/project')

    expect(second).toBe(first)
    expect(source.resolveByPath).toHaveBeenCalledTimes(1)
    resolve(workspace('project', '/work/project'))
    await expect(first).resolves.toMatchObject([{ scope: { id: 'user' } }, { scope: { id: 'workspace:project' } }])
    await expect(manager.bindSession('session-1', '/other/project')).resolves.toMatchObject([
      { scope: { id: 'user' } },
      { scope: { id: 'workspace:project' } },
    ])
    expect(source.resolveByPath).toHaveBeenCalledTimes(1)
  })

  it('cwd 缺失、解析失败、无法解析或解析到非当前注册实体时仅关联用户作用域', async () => {
    const source = registry([workspace('project', '/work/project')])
    source.resolveByPath
      .mockRejectedValueOnce(new Error('realpath failed'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(workspace('forged', '/outside'))
    const manager = await managed(source.value, async options => fakeStore(options?.path ?? '/default'))

    await expect(manager.bindSession('missing-cwd', null)).resolves.toMatchObject([{ scope: { id: 'user' } }])
    await expect(manager.bindSession('rejected', '/missing')).resolves.toMatchObject([{ scope: { id: 'user' } }])
    await expect(manager.bindSession('unresolved', '/unknown')).resolves.toMatchObject([{ scope: { id: 'user' } }])
    await expect(manager.bindSession('forged', '/outside')).resolves.toMatchObject([{ scope: { id: 'user' } }])
    expect(source.resolveByPath).toHaveBeenCalledTimes(3)
  })

  it('工作区删除后保留活动 Session Store，并在最后 release 后释放', async () => {
    const source = registry([workspace('project', '/work/project')])
    const manager = await managed(source.value, async options => fakeStore(options?.path ?? '/default'))

    const first = await manager.bindSession('session-1', '/work/project/a')
    const second = await manager.bindSession('session-2', '/work/project/b')
    const projectStore = first[1]!.store as ReturnType<typeof fakeStore>
    expect(second[1]!.store).toBe(projectStore)

    source.replace([])
    await expect(manager.accessScope('workspace:project')).rejects.toThrow(/unknown hook scope/i)
    expect(projectStore.disposed).toBe(false)
    await manager.releaseSession('session-1')
    expect(projectStore.disposed).toBe(false)
    await manager.releaseSession('session-2')
    expect(projectStore.disposed).toBe(true)
    expect(manager.currentScopes()).toMatchObject([{ scope: { id: 'user' } }])
  })

  it('项目 Store 打开失败后仍可 release，且同 Session ID 可重试', async () => {
    const source = registry([workspace('project', '/work/project')])
    let projectAttempts = 0
    const manager = await managed(source.value, async options => {
      if (options?.path === '/work/project/.dsh/hook.json' && projectAttempts++ === 0) throw new Error('open failed')
      return fakeStore(options?.path ?? '/default')
    })

    await expect(manager.bindSession('session-1', '/work/project')).rejects.toThrow('open failed')
    await expect(manager.releaseSession('session-1')).resolves.toBeUndefined()
    await expect(manager.bindSession('session-1', '/work/project')).resolves.toMatchObject([
      { scope: { id: 'user' } },
      { scope: { id: 'workspace:project' } },
    ])
    expect(source.resolveByPath).toHaveBeenCalledTimes(2)
  })

  it('release 与未完成解析竞态不会创建或泄漏项目 Store/refcount', async () => {
    const source = registry([workspace('project', '/work/project')])
    let resolve!: (value: WorkspaceLike | undefined) => void
    source.resolveByPath.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const openStore = vi.fn(async options => fakeStore(options?.path ?? '/default'))
    const manager = await managed(source.value, openStore)

    const binding = manager.bindSession('session-1', '/work/project')
    const released = manager.releaseSession('session-1')
    resolve(workspace('project', '/work/project'))

    await expect(binding).resolves.toMatchObject([{ scope: { id: 'user' } }])
    await released
    expect(openStore).toHaveBeenCalledTimes(1)
    expect(manager.currentScopes()).toHaveLength(1)
  })

  it('Store dispose 失败仍清理 Session record，并允许同 ID 绑定当前工作区', async () => {
    const source = registry([workspace('project', '/work/old')])
    const oldStore = fakeStore('/work/old/.dsh/hook.json')
    oldStore.dispose = vi.fn(async () => {
      oldStore.disposed = true
      throw new Error('dispose failed')
    })
    const newStore = fakeStore('/work/new/.dsh/hook.json')
    const manager = await managed(source.value, async options => {
      if (options?.path === oldStore.state().path) return oldStore
      if (options?.path === newStore.state().path) return newStore
      return fakeStore(options?.path ?? '/default')
    })
    await manager.bindSession('session-1', '/work/old')
    source.replace([workspace('project', '/work/new')])

    await expect(manager.releaseSession('session-1')).rejects.toThrow('dispose failed')
    expect(oldStore.listenerCount()).toBe(0)
    expect(manager.currentScopes()).toMatchObject([{ scope: { id: 'user' } }])
    await expect(manager.bindSession('session-1', '/work/new')).resolves.toMatchObject([
      { scope: { id: 'user' } },
      { scope: { id: 'workspace:project' }, store: newStore },
    ])
    expect(source.resolveByPath).toHaveBeenCalledTimes(2)
  })

  it('release 进行中并发 rebind 等待清理并汇聚到当前工作区', async () => {
    const source = registry([workspace('project', '/work/old')])
    let finishDispose!: () => void
    const oldStore = fakeStore('/work/old/.dsh/hook.json')
    oldStore.dispose = vi.fn(() => new Promise<void>(resolve => { finishDispose = resolve }))
    const newStore = fakeStore('/work/new/.dsh/hook.json')
    const manager = await managed(source.value, async options => {
      if (options?.path === oldStore.state().path) return oldStore
      if (options?.path === newStore.state().path) return newStore
      return fakeStore(options?.path ?? '/default')
    })
    await manager.bindSession('session-1', '/work/old')
    source.replace([workspace('project', '/work/new')])

    const releasing = manager.releaseSession('session-1')
    await vi.waitFor(() => expect(oldStore.dispose).toHaveBeenCalledOnce())
    const first = manager.bindSession('session-1', '/work/new')
    const second = manager.bindSession('session-1', '/work/new/subdir')
    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    const settledBeforeDispose = settled
    finishDispose()
    await releasing
    expect(settledBeforeDispose).toBe(false)
    const [firstBindings, secondBindings] = await Promise.all([first, second])
    expect(firstBindings[1]!.store).toBe(newStore)
    expect(secondBindings[1]!.store).toBe(newStore)
    expect(source.resolveByPath).toHaveBeenCalledTimes(2)
  })
})

describe('runtime ID', () => {
  it('对可歧义的 scope/hook 组合生成不同 ID，并保留展示 Hook', async () => {
    const first = encodeHookRuntimeId('workspace:a', 'b:c')
    const second = encodeHookRuntimeId('workspace:a:b', 'c')
    const source = registry([workspace('a', '/work/a')])
    const manager = await managed(source.value, async options => fakeStore(options?.path ?? '/default'))
    const binding = await manager.accessScope('workspace:a')
    const scoped = manager.scopeHook(binding, hook('notify'))

    expect(first).not.toBe(second)
    expect(scoped).toMatchObject({
      scope: { id: 'workspace:a' },
      hook: { id: 'notify' },
    })
    expect(JSON.parse(scoped.runtimeId).at(-1)).toBe('notify')
  })

  it('同一 workspace ID 换可信路径时隔离真实 Runner 进程、统计与取消', async () => {
    if (process.platform === 'win32') return
    const root = await temporaryRoot('dsh-runtime-identity')
    const oldPath = join(root, 'old')
    const newPath = join(root, 'new')
    const oldPidFile = join(root, 'old.pid')
    const newPidFile = join(root, 'new.pid')
    await Promise.all([mkdir(oldPath), mkdir(newPath)])
    const source = registry([workspace('project', oldPath)])
    const manager = await managed(source.value, async options => fakeStore(options?.path ?? '/default'))
    const oldBinding = await manager.bindSession('old-session', oldPath)
    source.replace([workspace('project', newPath)])
    const newBinding = await manager.bindSession('new-session', newPath)
    const oldHook = hook('linger', {
      command: `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(oldPidFile)}`,
      timeoutMs: 30_000,
    })
    const newHook = hook('linger', {
      command: `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(newPidFile)}`,
      timeoutMs: 30_000,
    })
    const oldScoped = manager.scopeHook(oldBinding[1]!, oldHook)
    const newScoped = manager.scopeHook(newBinding[1]!, newHook)
    const runner = createHookRunner()
    const oldRun = runner.run(oldScoped.runtimeId, oldHook, payload(oldPath))
    const newRun = runner.run(newScoped.runtimeId, newHook, payload(newPath))
    let restartedOldRun: Promise<unknown> | undefined

    try {
      expect(oldScoped.scope.id).toBe('workspace:project')
      expect(newScoped.scope.id).toBe('workspace:project')
      expect(oldScoped.runtimeId).not.toContain(oldPath)
      expect(newScoped.runtimeId).not.toContain(newPath)
      expect(runner.stats()[oldScoped.runtimeId]).toMatchObject({ running: 1, skipped: 0 })
      expect(runner.stats()[newScoped.runtimeId]).toMatchObject({ running: 1, skipped: 0 })
      expect(oldScoped.runtimeId).not.toBe(newScoped.runtimeId)
      await vi.waitFor(async () => {
        expect(Number((await readFile(oldPidFile, 'utf8')).trim())).toBeGreaterThan(0)
        expect(Number((await readFile(newPidFile, 'utf8')).trim())).toBeGreaterThan(0)
      })
      expect(runner.stats()[oldScoped.runtimeId]).toMatchObject({ running: 1, skipped: 0 })
      expect(runner.stats()[newScoped.runtimeId]).toMatchObject({ running: 1, skipped: 0 })

      const oldPid = Number((await readFile(oldPidFile, 'utf8')).trim())
      const newPid = Number((await readFile(newPidFile, 'utf8')).trim())
      runner.cancel(oldScoped.runtimeId)
      await vi.waitFor(() => expect(() => process.kill(oldPid, 0)).toThrow())
      await oldRun
      expect(() => process.kill(newPid, 0)).not.toThrow()
      expect(runner.stats()[oldScoped.runtimeId]).toMatchObject({ running: 0, lastStatus: 'cancelled' })
      expect(runner.stats()[newScoped.runtimeId]).toMatchObject({ running: 1, lastStatus: null })

      restartedOldRun = runner.run(oldScoped.runtimeId, oldHook, payload(oldPath))
      await vi.waitFor(async () => {
        expect(Number((await readFile(oldPidFile, 'utf8')).trim())).not.toBe(oldPid)
      })
      await manager.releaseSession('old-session')
      runner.reconcile(new Set([newScoped.runtimeId]))
      const restartedOldPid = Number((await readFile(oldPidFile, 'utf8')).trim())
      await vi.waitFor(() => expect(() => process.kill(restartedOldPid, 0)).toThrow())
      expect(() => process.kill(newPid, 0)).not.toThrow()
      expect(runner.stats()[oldScoped.runtimeId]).toMatchObject({ running: 0, lastStatus: 'cancelled' })
      expect(runner.stats()[newScoped.runtimeId]).toMatchObject({ running: 1, lastStatus: null })
    } finally {
      await runner.dispose()
      await Promise.allSettled([oldRun, newRun, restartedOldRun])
    }
  })
})

describe('授权组合与 Settings 事务', () => {
  function mutableStore(initialHook: ResolvedHook): HookConfigStore & { replace(hook: ResolvedHook, revision?: number): void } {
    let state: HookConfigState = Object.freeze({
      path: '/user/.dsh/hook.json', exists: true, revision: 3, loadError: null, hooks: [initialHook],
    })
    return {
      state: () => state,
      subscribe: () => () => undefined,
      reload: vi.fn(async () => state),
      setEnabled: vi.fn(async (id, enabled, expectedRevision) => {
        if (state.revision !== expectedRevision) throw new HookConfigConflictError(expectedRevision, state.revision)
        state = Object.freeze({
          ...state,
          revision: state.revision + 1,
          hooks: state.hooks.map(value => value.id === id ? { ...value, enabled } : value),
        })
        return state
      }),
      replace(nextHook, revision = state.revision + 1) {
        state = Object.freeze({ ...state, revision, hooks: [nextHook] })
      },
      dispose: vi.fn(async () => undefined),
    }
  }

  async function managerWith(store: HookConfigStore, authorizations: AuthorizationStore): Promise<HookScopeManager> {
    const source = registry([])
    const manager = await createWithStores(
      { workspaceRegistry: source.value, userConfigPath: '/user/.dsh/hook.json' },
      { openStore: async () => store, openAuthorizationStore: async () => authorizations },
    )
    managers.push(manager)
    return manager
  }

  it('手工 enabled 声明保持未授权，匹配指纹后批准，语义变化后自动失效', async () => {
    const configured = hook('notify', { enabled: true })
    const store = mutableStore(configured)
    const authorizations = memoryAuthorizations()
    const manager = await managerWith(store, authorizations)
    const binding = await manager.accessScope('user')

    expect(manager.scopeHook(binding, configured)).toMatchObject({
      configuredEnabled: true,
      authorized: false,
      enabled: false,
      authorizationReason: 'not-approved',
    })

    await authorizations.grant('user', configured.id, fingerprintHook('user', configured))
    expect(manager.scopeHook(binding, configured)).toMatchObject({
      configuredEnabled: true,
      authorized: true,
      enabled: true,
      authorizationReason: 'approved',
    })

    const changed = { ...configured, command: '/bin/changed' }
    store.replace(changed)
    expect(manager.scopeHook(binding, changed)).toMatchObject({
      configuredEnabled: true,
      authorized: false,
      enabled: false,
      authorizationReason: 'fingerprint-changed',
    })
  })

  it('启用授权写失败时只留下已声明但未授权的安全状态', async () => {
    const configured = hook('notify', { enabled: false })
    const store = mutableStore(configured)
    const authorizations = memoryAuthorizations()
    vi.mocked(authorizations.grant).mockRejectedValueOnce(new Error('authorization write failed'))
    const manager = await managerWith(store, authorizations)
    const binding = await manager.accessScope('user')

    await expect(manager.updateHookEnabled(binding, 'notify', true, 3)).rejects.toThrow('authorization write failed')

    const current = store.state().hooks[0]!
    expect(current.enabled).toBe(true)
    expect(manager.scopeHook(binding, current)).toMatchObject({ configuredEnabled: true, authorized: false, enabled: false })
    expect(vi.mocked(store.setEnabled).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(authorizations.grant).mock.invocationCallOrder[0]!)
  })

  it('授权写入后的最终配置重读失败时撤销刚授予的权限', async () => {
    const configured = hook('notify', { enabled: false })
    const store = mutableStore(configured)
    vi.mocked(store.reload)
      .mockImplementationOnce(async () => store.state())
      .mockRejectedValueOnce(new Error('final reload failed'))
    const authorizations = memoryAuthorizations()
    const manager = await managerWith(store, authorizations)
    const binding = await manager.accessScope('user')

    await expect(manager.updateHookEnabled(binding, 'notify', true, 3)).rejects.toThrow('final reload failed')

    expect(authorizations.get('user', 'notify')).toBeUndefined()
    expect(authorizations.revoke).toHaveBeenCalledWith('user', 'notify')
    expect(vi.mocked(authorizations.grant).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(authorizations.revoke).mock.invocationCallOrder[0]!)
  })

  it('禁用先撤销授权，配置写失败也不会保留有效权限', async () => {
    const configured = hook('notify', { enabled: true })
    const fingerprint = fingerprintHook('user', configured)
    const store = mutableStore(configured)
    vi.mocked(store.setEnabled).mockRejectedValueOnce(new Error('config write failed'))
    const authorizations = memoryAuthorizations([['user', 'notify', fingerprint]])
    const manager = await managerWith(store, authorizations)
    const binding = await manager.accessScope('user')

    await expect(manager.updateHookEnabled(binding, 'notify', false, 3)).rejects.toThrow('config write failed')

    expect(authorizations.get('user', 'notify')).toBeUndefined()
    expect(manager.scopeHook(binding, configured)).toMatchObject({ configuredEnabled: true, authorized: false, enabled: false })
    expect(vi.mocked(authorizations.revoke).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(store.setEnabled).mock.invocationCallOrder[0]!)
  })

  it('配置在授权前变化时返回冲突且不授权旧指纹或新定义', async () => {
    const configured = hook('notify', { enabled: false })
    const store = mutableStore(configured)
    const originalSetEnabled = store.setEnabled
    vi.mocked(store.reload).mockImplementationOnce(async () => {
      store.replace({ ...store.state().hooks[0]!, command: '/bin/external' })
      return store.state()
    })
    const authorizations = memoryAuthorizations()
    const manager = await managerWith(store, authorizations)
    const binding = await manager.accessScope('user')

    await expect(manager.updateHookEnabled(binding, 'notify', true, 3)).rejects.toBeInstanceOf(HookConfigConflictError)

    expect(originalSetEnabled).toHaveBeenCalledWith('notify', true, 3)
    expect(authorizations.grant).not.toHaveBeenCalled()
    expect(authorizations.get('user', 'notify')).toBeUndefined()
  })
})
