import type { IncomingMessage, ServerResponse } from 'node:http'
import { HookConfigConflictError } from './config-store.js'
import type { HookConfigState } from './config-store.js'
import { HookNotConfiguredEnabledError, type HookScopeBinding, type HookScopeManager } from './scope-manager.js'
import type { HookRunner, HookStats } from './runner.js'

const API_PATH = '/dsh-notice-hooks'
const MAX_REQUEST_BYTES = 4 * 1024
const EMPTY_STATS: HookStats = Object.freeze({ running: 0, skipped: 0, errors: 0, lastStatus: null })

interface ApiError { readonly code: string; readonly message: string }
class RequestError extends Error {
  constructor(readonly status: number, readonly apiError: ApiError) { super(apiError.message) }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(body)
}
function fail(res: ServerResponse, status: number, code: string, message: string): void { send(res, status, { ok: false, error: { code, message } }) }
function isLoopback(address: string | undefined): boolean { return address !== undefined && (address === '127.0.0.1' || address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')) }
function trusted(req: IncomingMessage, origin: () => string): boolean {
  if (!isLoopback(req.socket.remoteAddress)) return false
  try {
    const expected = new URL(origin())
    const requestOrigin = req.headers.origin
    if (requestOrigin !== undefined) return new URL(requestOrigin).origin === expected.origin
    return req.headers.host?.toLowerCase() === expected.host.toLowerCase()
  } catch { return false }
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new RequestError(415, { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' })
  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new RequestError(413, { code: 'request_too_large', message: 'Request body is too large.' })
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.byteLength
    if (size > MAX_REQUEST_BYTES) throw new RequestError(413, { code: 'request_too_large', message: 'Request body is too large.' })
    chunks.push(buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object required')
    return value as Record<string, unknown>
  } catch { throw new RequestError(400, { code: 'invalid_request', message: 'Invalid request.' }) }
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function decodeSegment(value: string): string {
  try { return decodeURIComponent(value) } catch { throw new RequestError(400, { code: 'invalid_request', message: 'Invalid request.' }) }
}
function requestedScope(req: IncomingMessage): string | undefined {
  const query = (req.url ?? '').split('?', 2)[1]
  if (query === undefined) return undefined
  for (const part of query.split('&')) {
    const [key, value = ''] = part.split('=', 2)
    if (decodeSegment(key ?? '') === 'scope') return decodeSegment(value.replace(/\+/gu, ' '))
  }
  return undefined
}
function scopeStatus(
  binding: HookScopeBinding,
  manager: HookScopeManager,
  runner: HookRunner,
  state: HookConfigState = binding.store.state(),
): unknown {
  const stats = runner.stats()
  return {
    scope: binding.scope, path: state.path, exists: state.exists, revision: state.revision, loadError: state.loadError,
    hooks: state.hooks.map((hook) => {
      const scoped = manager.scopeHook(binding, hook)
      return {
        id: hook.id, event: hook.event, matcher: hook.matcherSource, command: hook.command,
        configuredEnabled: scoped.configuredEnabled, authorized: scoped.authorized,
        enabled: scoped.enabled, authorizationReason: scoped.authorizationReason,
        timeoutMs: hook.timeoutMs, maxConcurrent: hook.maxConcurrent,
        stats: stats[scoped.runtimeId] ?? EMPTY_STATS,
      }
    }),
  }
}
function methodNotAllowed(res: ServerResponse): void { fail(res, 405, 'method_not_allowed', 'Method not allowed.') }

export function createHookRequestHandler(manager: HookScopeManager, runner: HookRunner, origin: () => string): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      if (!trusted(req, origin)) { fail(res, 403, 'forbidden', 'Request is not allowed.'); return }
      let url: URL
      try { url = new URL(req.url ?? '/', origin()) } catch { throw new RequestError(400, { code: 'invalid_request', message: 'Invalid request.' }) }
      const path = url.pathname
      if (path === `${API_PATH}/scopes`) {
        if (req.method !== 'GET') return methodNotAllowed(res)
        send(res, 200, { ok: true, value: { scopes: manager.listScopes() } }); return
      }
      if (path === `${API_PATH}/status`) {
        if (req.method !== 'GET') return methodNotAllowed(res)
        const scopeId = requestedScope(req) ?? 'user'
        const binding = await manager.accessScope(scopeId)
        send(res, 200, { ok: true, value: scopeStatus(binding, manager, runner) }); return
      }
      if (path === `${API_PATH}/reload`) {
        if (req.method !== 'POST') return methodNotAllowed(res)
        const body = await jsonBody(req); const scopeValue = body.scope
        const scopeId = typeof scopeValue === 'string' ? scopeValue : (() => { throw new RequestError(400, { code: 'invalid_request', message: 'Invalid request.' }) })()
        const binding = await manager.accessScope(scopeId); const state = await binding.store.reload()
        send(res, 200, { ok: true, value: scopeStatus(binding, manager, runner, state) }); return
      }
      const match = path.match(/^\/dsh-notice-hooks\/scopes\/([^/]+)\/hooks\/([^/]+)\/(configured-enabled|authorization)$/u)
      if (match !== null) {
        if (req.method !== 'PUT') return methodNotAllowed(res)
        const scopeId = decodeSegment(match[1] ?? ''); const id = decodeSegment(match[2] ?? '')
        const operation = match[3]
        const body = await jsonBody(req)
        const valueKey = operation === 'configured-enabled' ? 'enabled' : 'authorized'
        if (!hasExactKeys(body, [valueKey, 'revision']) || typeof body[valueKey] !== 'boolean'
          || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1) {
          throw new RequestError(400, { code: 'invalid_request', message: 'Invalid request.' })
        }
        const binding = await manager.accessScope(scopeId)
        if (!binding.store.state().hooks.some(hook => hook.id === id)) { fail(res, 404, 'hook_not_found', 'Hook was not found.'); return }
        const state = operation === 'configured-enabled'
          ? await manager.updateHookConfiguredEnabled(binding, id, Boolean(body.enabled), Number(body.revision))
          : await manager.updateHookAuthorization(binding, id, Boolean(body.authorized), Number(body.revision))
        send(res, 200, { ok: true, value: scopeStatus(binding, manager, runner, state) }); return
      }
      fail(res, 404, 'not_found', 'Route was not found.')
    })().catch(error => {
      if (res.headersSent) return
      if (error instanceof RequestError) fail(res, error.status, error.apiError.code, error.apiError.message)
      else if (error instanceof HookConfigConflictError || (error instanceof Error && (error.name === 'HookConfigConflictError' || ('code' in error && error.code === 'REVISION_CONFLICT')))) fail(res, 409, 'revision_conflict', 'Configuration changed. Reload and try again.')
      else if (error instanceof HookNotConfiguredEnabledError || (error instanceof Error && error.name === 'HookNotConfiguredEnabledError')) fail(res, 409, 'hook_not_configured_enabled', 'Enable the Hook configuration before authorizing it.')
      else if (error instanceof Error && error.message.startsWith('unknown hook scope:')) fail(res, 404, 'not_found', 'Scope was not found.')
      else fail(res, 500, 'internal_error', 'Hook configuration operation failed.')
    })
  }
}

export interface HookWebServer { getOrigin(): string; register(route: { readonly kind: 'prefix'; readonly path: string; readonly handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void }
export function registerHookServer(webServer: HookWebServer, manager: HookScopeManager, runner: HookRunner): () => void {
  return webServer.register({ kind: 'prefix', path: API_PATH, handler: createHookRequestHandler(manager, runner, () => webServer.getOrigin()) })
}
