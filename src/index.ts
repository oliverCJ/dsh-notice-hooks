import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { appendHookDispatchNotice, collectHookDispatch, type AppendPluginRecord } from './dispatch-notice.js'
import { classifySessionEvent, cleanupSessionEventState, sessionCreatedInvocation, sessionDisposedInvocation } from './events.js'
import { createHookRunner } from './runner.js'
import { createHookScopeManager } from './scope-manager.js'
import type { HookScopeBinding, ScopedHook, WorkspaceRegistryLike } from './scope-manager.js'
import { registerHookServer } from './server.js'
import type { HookWebServer } from './server.js'
import type { HookInvocation, SessionLike } from './types.js'

export const name = 'dsh-notice-hooks'
export const inject: string[] = []

type SessionRuntimeImporter = () => Promise<unknown>

export async function loadAppendPluginRecord(
  importer: SessionRuntimeImporter = () => import('@deepseek-ai/dsh-session'),
  warn: (message: string) => void = message => console.warn(message),
): Promise<AppendPluginRecord | undefined> {
  try {
    const runtime = await importer()
    if (typeof runtime !== 'object' || runtime === null || !('appendPluginRecord' in runtime)
      || typeof runtime.appendPluginRecord !== 'function') throw new Error('appendPluginRecord export is unavailable')
    return runtime.appendPluginRecord as AppendPluginRecord
  } catch {
    warn('[dsh-notice-hooks] Session plugin-record runtime is unavailable; Chat activity rows are disabled.')
    return undefined
  }
}
function isWorkspaceRegistryLike(value: unknown): value is WorkspaceRegistryLike { return typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function' && 'list' in value && typeof value.list === 'function' && 'resolveByPath' in value && typeof value.resolveByPath === 'function' }
function isHookWebServer(value: unknown): value is HookWebServer { return typeof value === 'object' && value !== null && 'register' in value && typeof value.register === 'function' && 'getOrigin' in value && typeof value.getOrigin === 'function' }
function keyOf(session: SessionLike): string { return String(session.id) }
function cwdOf(session: SessionLike): string | undefined { return typeof session.header?.cwd === 'string' ? session.header.cwd : undefined }

/** Activates command Hooks for Harness session lifecycle events. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const logger = ctx.logger(name)
  const appendRecord = await loadAppendPluginRecord(undefined, message => { try { logger.warn(message) } catch { /* isolated */ } })
  const workspaceRegistry: unknown = ctx.get('workspaceRegistry')
  const manager = await createHookScopeManager(isWorkspaceRegistryLike(workspaceRegistry) ? { workspaceRegistry } : {})
  const runner = createHookRunner({ logger: { warn(message, error) { try { logger.warn(message, error) } catch { /* isolated */ } } } })
  const sessions = new Map<string, SessionLike>()
  const bindings = new Map<string, Promise<readonly HookScopeBinding[]>>()
  function warn(message: string, error: unknown): void { try { logger.warn(message, error) } catch { /* isolated */ } }
  async function bind(key: string, cwd: string | undefined): Promise<readonly HookScopeBinding[]> {
    try { return await manager.bindSession(key, cwd) }
    catch (error) { warn('[dsh-notice-hooks] failed to bind Session scope', error); try { return [await manager.accessScope('user')] } catch { return [] } }
  }
  function remember(session: Session): Session {
    const key = keyOf(session)
    sessions.set(key, session)
    if (!bindings.has(key)) bindings.set(key, bind(key, cwdOf(session)))
    return session
  }
  function reconcile(): void {
    const enabled = new Set<string>()
    try {
      for (const binding of manager.currentScopes()) {
        try {
          for (const hook of binding.store.state().hooks) {
            const scoped = manager.scopeHook(binding, hook)
            if (scoped.enabled) enabled.add(scoped.runtimeId)
          }
        } catch (error) { warn(`[dsh-notice-hooks] failed to read ${binding.scope.id} Hook state`, error) }
      }
      runner.reconcile(enabled)
    } catch (error) { warn('[dsh-notice-hooks] failed to reconcile Hook processes', error); try { runner.reconcile(new Set()) } catch { /* isolated */ } }
  }
  async function dispatch(invocation: HookInvocation, session: Session): Promise<void> {
    let scopes: readonly HookScopeBinding[]
    try { scopes = await (bindings.get(keyOf(session)) ?? bind(keyOf(session), cwdOf(session))) }
    catch (error) { warn('[dsh-notice-hooks] failed to resolve Session scopes', error); return }
    const candidates: ScopedHook[] = []
    for (const binding of scopes) {
      let hooks
      try { hooks = binding.store.state().hooks } catch (error) { warn(`[dsh-notice-hooks] failed to read ${binding.scope.id} configuration`, error); continue }
      for (const hook of hooks) {
        if (hook.event !== invocation.event) continue
        try { candidates.push(manager.scopeHook(binding, hook)) }
        catch (error) { warn(`[dsh-notice-hooks] ${binding.scope.id}/${hook.id} authorization state failed`, error) }
      }
    }
    const decision = collectHookDispatch(invocation, candidates, (scoped, error) => {
      warn(`[dsh-notice-hooks] ${scoped.scope.id}/${scoped.hook.id} matcher failed`, error)
    })
    for (const scoped of decision.admitted) {
      try { void runner.run(scoped.runtimeId, scoped.hook, invocation.payload).catch(error => warn(`[dsh-notice-hooks] ${scoped.runtimeId} execution failed`, error)) }
      catch (error) { warn(`[dsh-notice-hooks] ${scoped.runtimeId} execution failed`, error) }
    }
    try { appendHookDispatchNotice(session, decision.notice, appendRecord) }
    catch (error) { warn('[dsh-notice-hooks] failed to append Hook dispatch notice', error) }
  }
  async function release(session: SessionLike): Promise<void> {
    const key = keyOf(session); cleanupSessionEventState(session); sessions.delete(key); bindings.delete(key)
    try { await manager.releaseSession(key) } catch (error) { warn('[dsh-notice-hooks] failed to release Session scope', error) }
  }
  try {
    reconcile(); ctx.effect(() => manager.subscribe(reconcile), 'subscribe Hook scopes')
    ctx.on('session/created', session => { const value = remember(session); void dispatch(sessionCreatedInvocation(value), value).catch(error => warn('[dsh-notice-hooks] SessionStart dispatch failed', error)) })
    ctx.on('session/event', (session: Session, event: SessionEvent) => { const value = remember(session); try { const invocation = classifySessionEvent(value, event); if (invocation !== undefined) void dispatch(invocation, value).catch(error => warn('[dsh-notice-hooks] session event dispatch failed', error)) } catch (error) { warn('[dsh-notice-hooks] session event dispatch failed', error) } })
    ctx.on('session/disposed', session => { const value = remember(session); const invocation = sessionDisposedInvocation(value); cleanupSessionEventState(value); void dispatch(invocation, value).catch(error => warn('[dsh-notice-hooks] SessionEnd dispatch failed', error)).finally(() => release(value)) })
    const webServer: unknown = ctx.get('webServer')
    if (isHookWebServer(webServer)) ctx.effect(() => registerHookServer(webServer, manager, runner), 'register Hook Settings API')
  } catch (error) { for (const session of sessions.values()) cleanupSessionEventState(session); await runner.dispose(); await manager.dispose(); throw error }
  return async () => { for (const session of sessions.values()) cleanupSessionEventState(session); sessions.clear(); bindings.clear(); await runner.dispose(); await manager.dispose() }
}
