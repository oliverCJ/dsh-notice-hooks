import { HOOK_EVENTS, type HookEvent } from '../config.js'

const API_PATH = '/dsh-notice-hooks'
const EVENT_SET = new Set<string>(HOOK_EVENTS)

export type HookRunStatus = 'completed' | 'failed' | 'skipped' | 'timed-out' | 'cancelled' | 'spawn-error'
export type AuthorizationReason = 'approved' | 'not-approved' | 'fingerprint-changed'
export type HookApiErrorStage = 'fetch' | 'json' | 'envelope' | 'schema' | 'http' | 'business'

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
export interface HookStatsView {
  readonly running: number
  readonly skipped: number
  readonly errors: number
  readonly lastStatus: HookRunStatus | null
}
export interface HookView {
  readonly id: string
  readonly event: HookEvent
  readonly matcher: string
  readonly command: string
  readonly configuredEnabled: boolean
  readonly authorized: boolean
  readonly enabled: boolean
  readonly authorizationReason: AuthorizationReason
  readonly timeoutMs: number
  readonly maxConcurrent: number
  readonly stats: HookStatsView
}
export interface HookStatus {
  readonly scope: HookScopeView
  readonly path: string
  readonly exists: boolean
  readonly revision: number
  readonly loadError: string | null
  readonly hooks: readonly HookView[]
}
export interface HookApi {
  scopes(): Promise<readonly HookScopeView[]>
  status(scopeId: string): Promise<HookStatus>
  reload(scopeId: string): Promise<HookStatus>
  setConfiguredEnabled(scopeId: string, id: string, enabled: boolean, revision: number): Promise<HookStatus>
  setAuthorized(scopeId: string, id: string, authorized: boolean, revision: number): Promise<HookStatus>
  openConfig?(scopeId: string): Promise<void>
}

export class HookApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly stage: HookApiErrorStage = 'business',
  ) {
    super(message)
    this.name = 'HookApiError'
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}
function isNonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function isRunStatus(value: unknown): value is HookRunStatus {
  return value === 'completed' || value === 'failed' || value === 'skipped' || value === 'timed-out'
    || value === 'cancelled' || value === 'spawn-error'
}
function parseScope(value: unknown): HookScopeView | null {
  if (!isRecord(value) || !isNonEmpty(value.path) || !isNonEmpty(value.title)) return null
  if (value.kind === 'user') {
    if (value.id !== 'user' || value.title !== 'User config' || 'workspaceId' in value) return null
    return { kind: 'user', id: 'user', title: 'User config', path: value.path }
  }
  if (value.kind !== 'workspace' || !isNonEmpty(value.workspaceId) || value.id !== `workspace:${value.workspaceId}`) return null
  return { kind: 'workspace', id: value.id as `workspace:${string}`, workspaceId: value.workspaceId, title: value.title, path: value.path }
}
function parseStats(value: unknown): HookStatsView | null {
  if (!isRecord(value) || !isIntegerInRange(value.running, 0, Number.MAX_SAFE_INTEGER)
    || !isIntegerInRange(value.skipped, 0, Number.MAX_SAFE_INTEGER)
    || !isIntegerInRange(value.errors, 0, Number.MAX_SAFE_INTEGER)
    || !(value.lastStatus === null || isRunStatus(value.lastStatus))) return null
  return { running: value.running, skipped: value.skipped, errors: value.errors, lastStatus: value.lastStatus }
}
function parseHook(value: unknown): HookView | null {
  if (!isRecord(value) || !isNonEmpty(value.id) || !EVENT_SET.has(String(value.event))
    || typeof value.matcher !== 'string' || !isNonEmpty(value.command)
    || typeof value.configuredEnabled !== 'boolean' || typeof value.authorized !== 'boolean'
    || typeof value.enabled !== 'boolean'
    || !(value.authorizationReason === 'approved' || value.authorizationReason === 'not-approved' || value.authorizationReason === 'fingerprint-changed')
    || value.authorized !== (value.authorizationReason === 'approved')
    || value.enabled !== (value.configuredEnabled && value.authorized)
    || !isIntegerInRange(value.timeoutMs, 100, 60_000) || !isIntegerInRange(value.maxConcurrent, 1, 4)) return null
  const stats = parseStats(value.stats)
  if (stats === null) return null
  return {
    id: value.id, event: value.event as HookEvent, matcher: value.matcher, command: value.command,
    configuredEnabled: value.configuredEnabled, authorized: value.authorized, enabled: value.enabled,
    authorizationReason: value.authorizationReason,
    timeoutMs: value.timeoutMs, maxConcurrent: value.maxConcurrent, stats,
  }
}
function parseStatus(value: unknown, expectedScopeId: string): HookStatus | null {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.exists !== 'boolean'
    || !isIntegerInRange(value.revision, 1, Number.MAX_SAFE_INTEGER)
    || !(value.loadError === null || typeof value.loadError === 'string') || !Array.isArray(value.hooks)) return null
  const scope = parseScope(value.scope)
  if (scope === null || scope.id !== expectedScopeId || value.path !== scope.path) return null
  const hooks: HookView[] = []
  for (const candidate of value.hooks) {
    const hook = parseHook(candidate)
    if (hook === null) return null
    hooks.push(hook)
  }
  return { scope, path: value.path, exists: value.exists, revision: value.revision, loadError: value.loadError, hooks }
}
function parseScopes(value: unknown): readonly HookScopeView[] | null {
  if (!isRecord(value) || !Array.isArray(value.scopes) || value.scopes.length === 0) return null
  const scopes: HookScopeView[] = []
  const ids = new Set<string>()
  for (const candidate of value.scopes) {
    const scope = parseScope(candidate)
    if (scope === null || ids.has(scope.id)) return null
    ids.add(scope.id)
    scopes.push(scope)
  }
  if (scopes[0]?.kind !== 'user' || scopes.slice(1).some(scope => scope.kind !== 'workspace')) return null
  return scopes
}
async function request(fetcher: Fetcher, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try { return await fetcher(input, init) }
  catch { throw new HookApiError('request_failed', 'Hook service request failed.', 0, 'fetch') }
}
async function body(response: Response): Promise<unknown> {
  try { return await response.json() }
  catch { throw new HookApiError('invalid_json', 'Hook service returned invalid JSON.', response.status, 'json') }
}
function serverError(value: unknown, response: Response): never | void {
  if (isRecord(value) && value.ok === false && isRecord(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string') {
    throw new HookApiError(value.error.code, value.error.message, response.status, 'business')
  }
}
async function decode<T>(response: Response, parse: (value: unknown) => T | null): Promise<T> {
  const value = await body(response)
  serverError(value, response)
  if (!response.ok) throw new HookApiError('http_error', 'Hook service request failed.', response.status, 'http')
  if (!isRecord(value) || value.ok !== true || !('value' in value)) {
    throw new HookApiError('invalid_envelope', 'Hook service returned an invalid envelope.', response.status, 'envelope')
  }
  const parsed = parse(value.value)
  if (parsed === null) throw new HookApiError('invalid_schema', 'Hook service returned an incompatible response.', response.status, 'schema')
  return parsed
}

export function createHookApi(fetcher: Fetcher = globalThis.fetch.bind(globalThis)): HookApi {
  const readHeaders = { accept: 'application/json' }
  const jsonHeaders = { ...readHeaders, 'content-type': 'application/json' }
  return {
    async scopes() {
      return decode(await request(fetcher, `${API_PATH}/scopes`, { headers: readHeaders }), parseScopes)
    },
    async status(scopeId) {
      const query = new URLSearchParams({ scope: scopeId })
      return decode(await request(fetcher, `${API_PATH}/status?${query.toString()}`, { headers: readHeaders }), value => parseStatus(value, scopeId))
    },
    async reload(scopeId) {
      return decode(await request(fetcher, `${API_PATH}/reload`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ scope: scopeId }),
      }), value => parseStatus(value, scopeId))
    },
    async setConfiguredEnabled(scopeId, id, enabled, revision) {
      return decode(await request(fetcher, `${API_PATH}/scopes/${encodeURIComponent(scopeId)}/hooks/${encodeURIComponent(id)}/configured-enabled`, {
        method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ enabled, revision }),
      }), value => parseStatus(value, scopeId))
    },
    async setAuthorized(scopeId, id, authorized, revision) {
      return decode(await request(fetcher, `${API_PATH}/scopes/${encodeURIComponent(scopeId)}/hooks/${encodeURIComponent(id)}/authorization`, {
        method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ authorized, revision }),
      }), value => parseStatus(value, scopeId))
    },
    async openConfig(scopeId) {
      await request(fetcher, `${API_PATH}/scopes/${encodeURIComponent(scopeId)}/open-config`, {
        method: 'POST', headers: jsonHeaders,
      })
    },
  }
}
