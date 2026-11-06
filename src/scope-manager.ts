import { join } from 'node:path'
import type { ResolvedHook } from './config.js'
import { HookConfigConflictError, openHookConfigStore } from './config-store.js'
import type { HookConfigState, HookConfigStore, OpenHookConfigStoreOptions } from './config-store.js'
import { openAuthorizationStore } from './authorization-store.js'
import type { AuthorizationStore, OpenAuthorizationStoreOptions } from './authorization-store.js'
import { resolveHookStatus } from './hook-status.js'
import type { ResolvedHookStatus } from './hook-status.js'

export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
}

export interface WorkspaceRegistryLike {
  get(id: string): WorkspaceLike | undefined
  list(): readonly WorkspaceLike[]
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
}

export type HookScopeView = UserHookScopeView | WorkspaceHookScopeView

export interface UserHookScopeView {
  readonly kind: 'user'
  readonly id: 'user'
  readonly title: 'User config'
  readonly path: string
}

export interface WorkspaceHookScopeView {
  readonly kind: 'workspace'
  readonly id: `workspace:${string}`
  readonly workspaceId: string
  readonly title: string
  readonly path: string
}

export interface HookScopeBinding {
  readonly scope: HookScopeView
  readonly store: HookConfigStore
}

export interface ScopedHook extends ResolvedHookStatus {
  readonly scope: HookScopeView
  readonly hook: ResolvedHook
  readonly runtimeId: string
}

export interface HookScopeManager {
  listScopes(): readonly HookScopeView[]
  accessScope(scopeId: string): Promise<HookScopeBinding>
  bindSession(sessionId: string, cwd: string | null | undefined): Promise<readonly HookScopeBinding[]>
  releaseSession(sessionId: string): Promise<void>
  currentScopes(): readonly HookScopeBinding[]
  subscribe(listener: () => void): () => void
  scopeHook(binding: HookScopeBinding, hook: ResolvedHook): ScopedHook
  updateHookEnabled(binding: HookScopeBinding, hookId: string, enabled: boolean, expectedRevision: number): Promise<HookConfigState>
  dispose(): Promise<void>
}

export interface CreateHookScopeManagerOptions {
  readonly workspaceRegistry?: WorkspaceRegistryLike
  readonly userConfigPath?: string
  readonly authorizationPath?: string
}

interface ScopeManagerDependencies {
  readonly openStore: (options?: OpenHookConfigStoreOptions) => Promise<HookConfigStore>
  readonly openAuthorizationStore: (options?: OpenAuthorizationStoreOptions) => Promise<AuthorizationStore>
}

interface WorkspaceEntry extends HookScopeBinding {
  readonly workspace: WorkspaceLike
  references: number
  unsubscribe: () => void
  removal: Promise<void> | undefined
}

interface SessionRecord {
  released: boolean
  entry: WorkspaceEntry | undefined
  promise: Promise<readonly HookScopeBinding[]>
  releasePromise: Promise<void> | undefined
}

const DEFAULT_DEPENDENCIES: ScopeManagerDependencies = {
  openStore: openHookConfigStore,
  openAuthorizationStore,
}

export function encodeHookRuntimeId(scopeId: string, hookId: string): string {
  return JSON.stringify([scopeId, hookId])
}

function isWorkspaceLike(value: unknown): value is WorkspaceLike {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    && value.id.length > 0
    && 'path' in value
    && typeof value.path === 'string'
    && value.path.length > 0
    && 'title' in value
    && typeof value.title === 'string'
    && value.title.length > 0
}

function workspaceIdentity(value: WorkspaceLike): string {
  return JSON.stringify([value.id, value.path])
}

function workspaceScope(value: WorkspaceLike): WorkspaceHookScopeView {
  return Object.freeze({
    kind: 'workspace',
    id: `workspace:${value.id}`,
    workspaceId: value.id,
    title: value.title,
    path: join(value.path, '.dsh', 'hook.json'),
  })
}

export function createHookScopeManager(options: CreateHookScopeManagerOptions): Promise<HookScopeManager>
export async function createHookScopeManager(
  options: CreateHookScopeManagerOptions,
  dependencyOverrides: Partial<ScopeManagerDependencies> = {},
): Promise<HookScopeManager> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const userStore = options.userConfigPath === undefined
    ? await dependencies.openStore()
    : await dependencies.openStore({ path: options.userConfigPath })
  const authorizationStore = options.authorizationPath === undefined
    ? await dependencies.openAuthorizationStore()
    : await dependencies.openAuthorizationStore({ path: options.authorizationPath })
  const userScope: UserHookScopeView = Object.freeze({
    kind: 'user',
    id: 'user',
    title: 'User config',
    path: userStore.state().path,
  })
  const userBinding: HookScopeBinding = Object.freeze({ scope: userScope, store: userStore })
  const runtimeScopeIds = new WeakMap<HookScopeBinding, string>([[userBinding, userScope.id]])
  const workspaceEntries = new Map<string, WorkspaceEntry>()
  const workspaceOpenings = new Map<string, Promise<WorkspaceEntry>>()
  const sessions = new Map<string, SessionRecord>()
  const listeners = new Set<() => void>()
  let disposed = false
  let nextWorkspaceRuntimeScopeId = 0
  let updateSerial: Promise<unknown> = Promise.resolve()

  function emit(): void {
    if (disposed) return
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Scope observers must not affect Store updates or other observers.
      }
    }
  }

  const unsubscribeUser = userStore.subscribe(emit)

  function assertActive(): void {
    if (disposed) throw new Error('hook scope manager is disposed')
  }

  function listedWorkspaces(): readonly WorkspaceLike[] {
    const registry = options.workspaceRegistry
    if (registry === undefined) return []
    try {
      const listed: unknown = registry.list()
      return Array.isArray(listed) && listed.every(isWorkspaceLike) ? listed : []
    } catch {
      return []
    }
  }

  function registeredWorkspace(id: string): WorkspaceLike | undefined {
    const registry = options.workspaceRegistry
    if (registry === undefined) return undefined
    const listed = listedWorkspaces().find(value => value.id === id)
    let direct: unknown
    try { direct = registry.get(id) } catch { return undefined }
    if (listed === undefined || !isWorkspaceLike(direct)) return undefined
    if (listed.path !== direct.path || listed.title !== direct.title) return undefined
    return listed
  }

  function matchesCurrentRegistry(value: WorkspaceLike): WorkspaceLike | undefined {
    const current = registeredWorkspace(value.id)
    if (current === undefined || current.path !== value.path) return undefined
    return current
  }

  function removeEntry(entry: WorkspaceEntry): Promise<void> {
    if (entry.removal !== undefined) return entry.removal
    entry.removal = (async () => {
      const key = workspaceIdentity(entry.workspace)
      entry.unsubscribe()
      if (workspaceEntries.get(key) === entry) {
        workspaceEntries.delete(key)
        emit()
      }
      await entry.store.dispose()
    })()
    return entry.removal
  }

  async function pruneUnregistered(): Promise<void> {
    const removals: Promise<void>[] = []
    for (const entry of workspaceEntries.values()) {
      if (entry.references === 0 && matchesCurrentRegistry(entry.workspace) === undefined) {
        removals.push(removeEntry(entry))
      }
    }
    await Promise.all(removals)
  }

  async function openWorkspace(value: WorkspaceLike): Promise<WorkspaceEntry> {
    const key = workspaceIdentity(value)
    const cached = workspaceEntries.get(key)
    if (cached !== undefined) return cached
    const opening = workspaceOpenings.get(key)
    if (opening !== undefined) return opening

    const promise = (async () => {
      const scope = workspaceScope(value)
      const store = await dependencies.openStore({ path: scope.path, createIfMissing: false })
      if (disposed) {
        await store.dispose()
        throw new Error('hook scope manager is disposed')
      }
      const entry: WorkspaceEntry = {
        scope,
        store,
        workspace: value,
        references: 0,
        unsubscribe: () => undefined,
        removal: undefined,
      }
      runtimeScopeIds.set(entry, `workspace-entry:${++nextWorkspaceRuntimeScopeId}`)
      workspaceEntries.set(key, entry)
      entry.unsubscribe = store.subscribe(emit)
      emit()
      return entry
    })()
    workspaceOpenings.set(key, promise)
    try {
      return await promise
    } finally {
      if (workspaceOpenings.get(key) === promise) workspaceOpenings.delete(key)
    }
  }

  function listScopes(): readonly HookScopeView[] {
    void pruneUnregistered().catch(() => undefined)
    return Object.freeze([
      userScope,
      ...listedWorkspaces().map(workspaceScope),
    ])
  }

  async function accessScope(scopeId: string): Promise<HookScopeBinding> {
    assertActive()
    await pruneUnregistered()
    assertActive()
    if (scopeId === 'user') return userBinding
    if (!scopeId.startsWith('workspace:')) throw new Error(`unknown hook scope: ${scopeId}`)
    const workspaceId = scopeId.slice('workspace:'.length)
    const value = registeredWorkspace(workspaceId)
    if (value === undefined) throw new Error(`unknown hook scope: ${scopeId}`)
    const entry = await openWorkspace(value)
    assertActive()
    if (matchesCurrentRegistry(entry.workspace) === undefined) {
      if (entry.references === 0) await removeEntry(entry)
      throw new Error(`unknown hook scope: ${scopeId}`)
    }
    return entry
  }

  async function resolveSession(record: SessionRecord, cwd: string | null | undefined): Promise<readonly HookScopeBinding[]> {
    const registry = options.workspaceRegistry
    if (registry === undefined || cwd === null || cwd === undefined || cwd.length === 0) return Object.freeze([userBinding])
    let resolved: WorkspaceLike | undefined
    try {
      const candidate: unknown = await registry.resolveByPath(cwd)
      resolved = isWorkspaceLike(candidate) ? candidate : undefined
    } catch {
      return Object.freeze([userBinding])
    }
    if (record.released || resolved === undefined) return Object.freeze([userBinding])
    const trusted = matchesCurrentRegistry(resolved)
    if (trusted === undefined) return Object.freeze([userBinding])

    let entry: WorkspaceEntry
    try {
      entry = await openWorkspace(trusted)
    } catch (error) {
      if (disposed || record.released) return Object.freeze([userBinding])
      throw error
    }
    if (record.released || matchesCurrentRegistry(entry.workspace) === undefined) {
      if (entry.references === 0) await removeEntry(entry)
      return Object.freeze([userBinding])
    }
    entry.references += 1
    record.entry = entry
    return Object.freeze([userBinding, entry])
  }

  function bindSession(sessionId: string, cwd: string | null | undefined): Promise<readonly HookScopeBinding[]> {
    if (disposed) return Promise.reject(new Error('hook scope manager is disposed'))
    const current = sessions.get(sessionId)
    if (current?.released) {
      return current.releasePromise!.then(
        () => bindSession(sessionId, cwd),
        () => bindSession(sessionId, cwd),
      )
    }
    if (current !== undefined) return current.promise

    const record: SessionRecord = {
      released: false,
      entry: undefined,
      promise: undefined as unknown as Promise<readonly HookScopeBinding[]>,
      releasePromise: undefined,
    }
    record.promise = resolveSession(record, cwd)
    sessions.set(sessionId, record)
    return record.promise
  }

  function releaseSession(sessionId: string): Promise<void> {
    const record = sessions.get(sessionId)
    if (record === undefined) return Promise.resolve()
    if (record.releasePromise !== undefined) return record.releasePromise
    record.released = true
    record.releasePromise = (async () => {
      try {
        try {
          await record.promise
        } catch {
          // A failed initial binding still needs to release its Session record.
        }
        if (record.entry !== undefined) {
          record.entry.references -= 1
          if (record.entry.references === 0 && matchesCurrentRegistry(record.entry.workspace) === undefined) {
            await removeEntry(record.entry)
          }
        }
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
      }
    })()
    return record.releasePromise
  }

  function currentScopes(): readonly HookScopeBinding[] {
    return disposed ? Object.freeze([]) : Object.freeze([userBinding, ...workspaceEntries.values()])
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return () => undefined
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function scopeHook(binding: HookScopeBinding, hook: ResolvedHook): ScopedHook {
    const runtimeScopeId = runtimeScopeIds.get(binding)
    if (runtimeScopeId === undefined) throw new Error('unknown hook scope binding')
    const status = resolveHookStatus(binding.scope.id, hook, authorizationStore.get(binding.scope.id, hook.id))
    return Object.freeze({
      scope: binding.scope,
      hook,
      runtimeId: encodeHookRuntimeId(runtimeScopeId, hook.id),
      ...status,
    })
  }

  function hookFrom(state: HookConfigState, hookId: string): ResolvedHook {
    const hook = state.hooks.find(value => value.id === hookId)
    if (hook === undefined) throw new Error(`hook id not found: ${hookId}`)
    return hook
  }

  function enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = updateSerial.then(operation, operation)
    updateSerial = result.then(() => undefined, () => undefined)
    return result
  }

  function conflict(expectedRevision: number, actualRevision: number): HookConfigConflictError {
    return new HookConfigConflictError(expectedRevision, actualRevision)
  }

  function updateHookEnabled(
    binding: HookScopeBinding,
    hookId: string,
    enabled: boolean,
    expectedRevision: number,
  ): Promise<HookConfigState> {
    return enqueueUpdate(async () => {
      assertActive()
      if (runtimeScopeIds.get(binding) === undefined) throw new Error('unknown hook scope binding')

      if (!enabled) {
        const checked = await binding.store.reload()
        if (checked.revision !== expectedRevision) throw conflict(expectedRevision, checked.revision)
        hookFrom(checked, hookId)
        await authorizationStore.revoke(binding.scope.id, hookId)
        emit()
        return binding.store.setEnabled(hookId, false, expectedRevision)
      }

      const configured = await binding.store.setEnabled(hookId, true, expectedRevision)
      const configuredHook = hookFrom(configured, hookId)
      const expectedFingerprint = resolveHookStatus(binding.scope.id, configuredHook).fingerprint
      const confirmed = await binding.store.reload()
      const confirmedHook = confirmed.hooks.find(value => value.id === hookId)
      const confirmedFingerprint = confirmedHook === undefined
        ? undefined
        : resolveHookStatus(binding.scope.id, confirmedHook).fingerprint
      if (confirmed.revision !== configured.revision || confirmedFingerprint !== expectedFingerprint) {
        throw conflict(configured.revision, confirmed.revision)
      }

      await authorizationStore.grant(binding.scope.id, hookId, expectedFingerprint)
      emit()
      try {
        const finalState = await binding.store.reload()
        const finalHook = finalState.hooks.find(value => value.id === hookId)
        const finalFingerprint = finalHook === undefined
          ? undefined
          : resolveHookStatus(binding.scope.id, finalHook).fingerprint
        if (finalState.revision !== configured.revision || finalFingerprint !== expectedFingerprint) {
          throw conflict(configured.revision, finalState.revision)
        }
        return finalState
      } catch (error) {
        await authorizationStore.revoke(binding.scope.id, hookId)
        emit()
        throw error
      }
    })
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    for (const record of sessions.values()) record.released = true
    await Promise.allSettled([...sessions.keys()].map(releaseSession))
    await Promise.allSettled(workspaceOpenings.values())
    await updateSerial
    unsubscribeUser()
    const entries = [...workspaceEntries.values()]
    workspaceEntries.clear()
    for (const entry of entries) entry.unsubscribe()
    listeners.clear()
    await Promise.all([userStore.dispose(), ...entries.map(entry => entry.store.dispose())])
  }

  return {
    listScopes,
    accessScope,
    bindSession,
    releaseSession,
    currentScopes,
    subscribe,
    scopeHook,
    updateHookEnabled,
    dispose,
  }
}
