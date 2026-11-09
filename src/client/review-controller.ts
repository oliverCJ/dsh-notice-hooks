import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { HookApiError, type HookApi, type HookStatus, type HookView } from './api.js'

export interface HookReviewItem {
  readonly key: string
  readonly scopeId: string
  readonly scopeTitle: string
  readonly hook: HookView
  readonly reason: 'not-approved' | 'fingerprint-changed'
}

export interface HookReviewDialogSnapshot {
  readonly scopeIds: readonly string[]
  readonly selected: readonly string[]
  readonly submitting: boolean
  readonly failures: Readonly<Record<string, string>>
}

export interface HookReviewSnapshot {
  readonly byScope: Readonly<Record<string, HookStatus>>
  readonly loadingScopes: readonly string[]
  readonly errors: Readonly<Record<string, string>>
  readonly dialog: HookReviewDialogSnapshot | null
}

export interface HookReviewSource extends HostObservable<HookReviewSnapshot> {
  getSnapshot(): HookReviewSnapshot
  subscribe(listener: () => void): () => void
}

type Schedule = (callback: () => void, delay: number) => () => void
type StatusListener = (status: HookStatus) => void

export interface HookReviewControllerOptions {
  readonly api: HookApi
  readonly schedule?: Schedule
}

function reviewKey(scopeId: string, hookId: string): string {
  return `${scopeId}\0${hookId}`
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))]
}

function errorCode(error: unknown): string {
  return error instanceof HookApiError ? error.code : 'update_failed'
}

export function pendingFor(snapshot: HookReviewSnapshot, scopeIds: readonly string[]): readonly HookReviewItem[] {
  const result: HookReviewItem[] = []
  for (const scopeId of unique(scopeIds)) {
    const status = snapshot.byScope[scopeId]
    if (status === undefined) continue
    for (const hook of status.hooks) {
      if (!hook.configuredEnabled || hook.authorized) continue
      if (hook.authorizationReason !== 'not-approved' && hook.authorizationReason !== 'fingerprint-changed') continue
      result.push({
        key: reviewKey(scopeId, hook.id),
        scopeId,
        scopeTitle: status.scope.title,
        hook,
        reason: hook.authorizationReason,
      })
    }
  }
  return result
}

function defaultSchedule(callback: () => void, delay: number): () => void {
  const timer = globalThis.setInterval(callback, delay)
  return () => globalThis.clearInterval(timer)
}

export class HookReviewController {
  readonly source: HookReviewSource
  readonly clientApi: HookApi
  private readonly listeners = new Set<() => void>()
  private readonly byScope: Record<string, HookStatus> = {}
  private readonly loading = new Set<string>()
  private readonly errors: Record<string, string> = {}
  private readonly generations = new Map<string, number>()
  private readonly retained = new Map<string, readonly string[]>()
  private readonly updateSerial = new Map<string, Promise<void>>()
  private readonly remoteApi: HookApi
  private readonly schedule: Schedule
  private snapshot: HookReviewSnapshot
  private dialog: HookReviewDialogSnapshot | null = null
  private statusListener: StatusListener | undefined
  private cancelPoll: (() => void) | undefined
  private disposed = false

  constructor(options: HookReviewControllerOptions) {
    this.remoteApi = options.api
    this.schedule = options.schedule ?? defaultSchedule
    this.snapshot = this.buildSnapshot()
    const accepted = (operation: () => Promise<HookStatus>, scopeId: string) => this.enqueueScope(scopeId, async () => {
      const status = await operation()
      this.accept(status)
      return status
    })
    this.clientApi = {
      scopes: () => this.remoteApi.scopes(),
      status: scopeId => accepted(() => this.remoteApi.status(scopeId), scopeId),
      reload: scopeId => accepted(() => this.remoteApi.reload(scopeId), scopeId),
      setConfiguredEnabled: (scopeId, id, enabled, revision) => accepted(
        () => this.remoteApi.setConfiguredEnabled(scopeId, id, enabled, revision), scopeId),
      setAuthorized: (scopeId, id, authorized, revision) => accepted(
        () => this.remoteApi.setAuthorized(scopeId, id, authorized, revision), scopeId),
    }
    this.source = {
      getSnapshot: () => this.snapshot,
      subscribe: (listener: () => void) => {
        if (this.disposed) return () => undefined
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }
  }

  retain(sessionKey: string, scopeIds: readonly string[]): () => void {
    if (this.disposed) return () => undefined
    const previouslyActive = new Set(this.activeScopes())
    const retainedScopes = unique(scopeIds)
    this.retained.set(sessionKey, retainedScopes)
    if (this.cancelPoll === undefined) {
      this.cancelPoll = this.schedule(() => { void this.refresh(this.activeScopes()) }, 15_000)
    }
    void this.refresh(retainedScopes.filter(scopeId => !previouslyActive.has(scopeId)))
    let active = true
    return () => {
      if (!active) return
      active = false
      this.retained.delete(sessionKey)
      if (this.retained.size === 0) {
        this.cancelPoll?.()
        this.cancelPoll = undefined
      }
    }
  }

  async refresh(scopeIds: readonly string[]): Promise<void> {
    if (this.disposed) return
    await Promise.all(unique(scopeIds).map(async (scopeId) => {
      const generation = (this.generations.get(scopeId) ?? 0) + 1
      this.generations.set(scopeId, generation)
      this.loading.add(scopeId)
      delete this.errors[scopeId]
      this.publish()
      try {
        const status = await this.enqueueScope(scopeId, () => this.remoteApi.status(scopeId))
        if (!this.current(scopeId, generation)) return
        this.byScope[scopeId] = status
        delete this.errors[scopeId]
      } catch (error) {
        if (!this.current(scopeId, generation)) return
        const code = errorCode(error)
        this.errors[scopeId] = code
        if (error instanceof HookApiError && error.status === 404) delete this.byScope[scopeId]
      } finally {
        if (this.current(scopeId, generation)) {
          this.loading.delete(scopeId)
          this.publish()
        }
      }
    }))
  }

  accept(status: HookStatus): void {
    if (this.disposed) return
    const scopeId = status.scope.id
    const current = this.byScope[scopeId]
    if (current !== undefined && status.revision < current.revision) return
    this.generations.set(scopeId, (this.generations.get(scopeId) ?? 0) + 1)
    this.loading.delete(scopeId)
    this.byScope[scopeId] = status
    delete this.errors[scopeId]
    this.publish()
  }

  async open(scopeIds: readonly string[], onStatus?: StatusListener): Promise<void> {
    if (this.disposed) return
    this.statusListener = onStatus
    this.dialog = {
      scopeIds: unique(scopeIds),
      selected: [],
      submitting: false,
      failures: {},
    }
    this.publish()
    await this.refresh(scopeIds)
  }

  close(): void {
    if (this.dialog === null) return
    this.dialog = null
    this.statusListener = undefined
    this.publish()
  }

  toggle(itemKey: string): void {
    const dialog = this.dialog
    if (dialog === null || dialog.submitting) return
    const selected = new Set(dialog.selected)
    if (selected.has(itemKey)) selected.delete(itemKey)
    else selected.add(itemKey)
    this.dialog = { ...dialog, selected: [...selected], failures: {} }
    this.publish()
  }

  async authorize(mode: 'selected' | 'all'): Promise<void> {
    const dialog = this.dialog
    if (dialog === null || dialog.submitting) return
    const all = pendingFor(this.snapshot, dialog.scopeIds)
    const selected = new Set(dialog.selected)
    const requested = mode === 'all' ? all : all.filter(item => selected.has(item.key))
    if (requested.length === 0) return

    this.dialog = { ...dialog, submitting: true, failures: {} }
    this.publish()
    const failures: Record<string, string> = {}
    for (const scopeId of dialog.scopeIds) {
      const scopeItems = requested.filter(item => item.scopeId === scopeId)
      for (const item of scopeItems) {
        const currentStatus = this.byScope[scopeId]
        if (currentStatus === undefined) {
          failures[item.key] = 'status_unavailable'
          break
        }
        try {
          const next = await this.clientApi.setAuthorized(scopeId, item.hook.id, true, currentStatus.revision)
          this.accept(next)
          this.statusListener?.(next)
        } catch (error) {
          failures[item.key] = errorCode(error)
          break
        }
      }
    }

    if (this.dialog === null) return
    const remaining = pendingFor(this.snapshot, dialog.scopeIds)
    if (remaining.length === 0 && Object.keys(failures).length === 0) {
      this.close()
      return
    }
    const remainingKeys = new Set(remaining.map(item => item.key))
    this.dialog = {
      ...this.dialog,
      selected: this.dialog.selected.filter(key => remainingKeys.has(key)),
      submitting: false,
      failures,
    }
    this.publish()
  }

  focus(): void {
    if (!this.disposed) void this.refresh(this.activeScopes())
  }

  reconnect(): void {
    if (!this.disposed) void this.refresh(this.activeScopes())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPoll?.()
    this.cancelPoll = undefined
    this.retained.clear()
    this.updateSerial.clear()
    this.statusListener = undefined
    for (const scopeId of this.generations.keys()) this.generations.set(scopeId, (this.generations.get(scopeId) ?? 0) + 1)
    this.listeners.clear()
  }

  private enqueueScope<T>(scopeId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.updateSerial.get(scopeId) ?? Promise.resolve()
    const result = prior.then(operation, operation)
    const settled = result.then(() => undefined, () => undefined)
    this.updateSerial.set(scopeId, settled)
    void settled.then(() => {
      if (this.updateSerial.get(scopeId) === settled) this.updateSerial.delete(scopeId)
    })
    return result
  }

  private activeScopes(): readonly string[] {
    return unique([...this.retained.values()].flat())
  }

  private current(scopeId: string, generation: number): boolean {
    return !this.disposed && this.generations.get(scopeId) === generation
  }

  private buildSnapshot(): HookReviewSnapshot {
    return Object.freeze({
      byScope: Object.freeze({ ...this.byScope }),
      loadingScopes: Object.freeze([...this.loading]),
      errors: Object.freeze({ ...this.errors }),
      dialog: this.dialog === null ? null : Object.freeze({
        ...this.dialog,
        scopeIds: Object.freeze([...this.dialog.scopeIds]),
        selected: Object.freeze([...this.dialog.selected]),
        failures: Object.freeze({ ...this.dialog.failures }),
      }),
    })
  }

  private publish(): void {
    if (this.disposed) return
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }
}
