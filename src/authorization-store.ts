import { constants } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename as fsRename,
  rm,
} from 'node:fs/promises'
import type { AuthorizationFingerprint } from './authorization.js'

const AUTHORIZATION_VERSION = 1
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/

type ApprovalMap = Map<string, Map<string, AuthorizationFingerprint>>

export interface AuthorizationStore {
  get(scopeId: string, hookId: string): AuthorizationFingerprint | undefined
  grant(scopeId: string, hookId: string, fingerprint: AuthorizationFingerprint): Promise<void>
  revoke(scopeId: string, hookId: string): Promise<void>
}

export interface AuthorizationLogger {
  warn(message: string, detail?: string): void
}

export interface OpenAuthorizationStoreOptions {
  readonly home?: string
  readonly path?: string
  readonly logger?: AuthorizationLogger
}

interface AuthorizationStoreDependencies {
  readonly rename: typeof fsRename
}

interface DiskContent {
  readonly raw: string
  readonly signature: string
}

const DEFAULT_DEPENDENCIES: AuthorizationStoreDependencies = { rename: fsRename }
const DEFAULT_LOGGER: AuthorizationLogger = {
  warn(message, detail) {
    console.warn(message, detail)
  },
}

export function resolveAuthorizationPath(home = homedir()): string {
  return join(home, '.dsh', 'dsh-notice-hooks', 'authorizations.json')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateIdentity(scopeId: string, hookId: string): void {
  if (scopeId.length === 0) throw new Error('authorization scope id must not be empty')
  if (hookId.length === 0) throw new Error('authorization hook id must not be empty')
}

function validateFingerprint(fingerprint: string): asserts fingerprint is AuthorizationFingerprint {
  if (!FINGERPRINT_PATTERN.test(fingerprint)) throw new Error('authorization fingerprint is invalid')
}

function parseApprovals(raw: string): ApprovalMap {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid authorization JSON: ${errorText(error)}`)
  }
  if (!isRecord(value) || value.version !== AUTHORIZATION_VERSION || !isRecord(value.scopes)) {
    throw new Error('authorization document version or scopes is invalid')
  }

  const approvals: ApprovalMap = new Map()
  for (const [scopeId, scopeValue] of Object.entries(value.scopes)) {
    if (scopeId.length === 0 || !isRecord(scopeValue)) throw new Error('authorization scope is invalid')
    const hooks = new Map<string, AuthorizationFingerprint>()
    for (const [hookId, fingerprint] of Object.entries(scopeValue)) {
      if (hookId.length === 0 || typeof fingerprint !== 'string') throw new Error('authorization entry is invalid')
      validateFingerprint(fingerprint)
      hooks.set(hookId, fingerprint)
    }
    approvals.set(scopeId, hooks)
  }
  return approvals
}

function serializeApprovals(approvals: ApprovalMap): string {
  const scopes: Record<string, Record<string, AuthorizationFingerprint>> = Object.create(null)
  for (const [scopeId, hooks] of approvals) {
    if (hooks.size === 0) continue
    const entries: Record<string, AuthorizationFingerprint> = Object.create(null)
    for (const [hookId, fingerprint] of hooks) entries[hookId] = fingerprint
    scopes[scopeId] = entries
  }
  return `${JSON.stringify({ version: AUTHORIZATION_VERSION, scopes }, null, 2)}\n`
}

function cloneApprovals(approvals: ApprovalMap): ApprovalMap {
  return new Map([...approvals].map(([scopeId, hooks]) => [scopeId, new Map(hooks)]))
}

function signature(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

async function readDisk(path: string): Promise<DiskContent | null> {
  let linkStat
  try {
    linkStat = await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
  if (linkStat.isSymbolicLink()) throw new Error('authorization target must not be a symbolic link')
  if (!linkStat.isFile()) throw new Error('authorization target must be a regular file')
  if ((linkStat.mode & 0o077) !== 0) throw new Error('authorization target permissions must be 0600')

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new Error('authorization target must be a regular file')
    const raw = await handle.readFile('utf8')
    return { raw, signature: signature(raw) }
  } finally {
    await handle.close()
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentStat = await lstat(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('authorization parent directory must be a regular directory')
  }

  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('authorization directory must be a regular directory')
  }
  await chmod(path, 0o700)
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    if (process.platform !== 'win32') throw error
  } finally {
    await handle?.close()
  }
}

async function atomicWrite(
  path: string,
  raw: string,
  expectedSignature: string | null,
  dependencies: AuthorizationStoreDependencies,
): Promise<string> {
  const directory = dirname(path)
  await ensureDirectory(directory)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let renamed = false
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(raw, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined

    const current = await readDisk(path)
    if ((current?.signature ?? null) !== expectedSignature) {
      throw new Error('authorization file changed during update')
    }
    await dependencies.rename(temporary, path)
    renamed = true
    await chmod(path, 0o600)
    await syncDirectory(directory)
    return signature(raw)
  } finally {
    await handle?.close()
    if (!renamed) await rm(temporary, { force: true })
  }
}

export function openAuthorizationStore(options?: OpenAuthorizationStoreOptions): Promise<AuthorizationStore>
export async function openAuthorizationStore(
  options: OpenAuthorizationStoreOptions = {},
  dependencyOverrides: Partial<AuthorizationStoreDependencies> = {},
): Promise<AuthorizationStore> {
  const path = options.path ?? resolveAuthorizationPath(options.home)
  const logger = options.logger ?? DEFAULT_LOGGER
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  let approvals: ApprovalMap = new Map()
  let diskSignature: string | null = null
  let loadError: Error | undefined
  let serial: Promise<unknown> = Promise.resolve()

  try {
    const disk = await readDisk(path)
    if (disk !== null) {
      approvals = parseApprovals(disk.raw)
      diskSignature = disk.signature
    }
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(errorText(error))
    logger.warn('Failed to load Hook authorizations; all Hooks are unauthorized.', loadError.message)
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(operation, operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }

  async function persist(next: ApprovalMap): Promise<void> {
    if (loadError !== undefined) throw loadError
    const raw = serializeApprovals(next)
    try {
      diskSignature = await atomicWrite(path, raw, diskSignature, dependencies)
      approvals = next
    } catch (error) {
      logger.warn('Failed to update Hook authorizations; authorization remains unchanged.', errorText(error))
      throw error
    }
  }

  return {
    get(scopeId, hookId) {
      return approvals.get(scopeId)?.get(hookId)
    },
    grant(scopeId, hookId, fingerprint) {
      return enqueue(async () => {
        validateIdentity(scopeId, hookId)
        validateFingerprint(fingerprint)
        const next = cloneApprovals(approvals)
        const hooks = next.get(scopeId) ?? new Map<string, AuthorizationFingerprint>()
        hooks.set(hookId, fingerprint)
        next.set(scopeId, hooks)
        await persist(next)
      })
    },
    revoke(scopeId, hookId) {
      return enqueue(async () => {
        validateIdentity(scopeId, hookId)
        if (!approvals.get(scopeId)?.has(hookId)) return
        const next = cloneApprovals(approvals)
        const hooks = next.get(scopeId)!
        hooks.delete(hookId)
        if (hooks.size === 0) next.delete(scopeId)
        await persist(next)
      })
    },
  }
}
