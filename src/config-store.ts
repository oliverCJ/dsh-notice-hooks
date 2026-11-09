import { constants, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import type { HookDocument, ParsedHookConfig, ResolvedHook } from './config.js'
import { parseHookConfig, setHookEnabled } from './config.js'

const DEFAULT_DOCUMENT = '{\n  "version": 1,\n  "hooks": {}\n}\n'
const WATCH_DELAY_MS = 100
const WATCH_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

export interface HookConfigState {
  readonly path: string
  readonly exists: boolean
  readonly revision: number
  readonly loadError: string | null
  readonly hooks: readonly ResolvedHook[]
}

export interface HookConfigStore {
  state(): HookConfigState
  subscribe(listener: (state: HookConfigState) => void): () => void
  reload(): Promise<HookConfigState>
  setEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<HookConfigState>
  dispose(): Promise<void>
}

export interface OpenHookConfigStoreOptions {
  readonly home?: string
  readonly path?: string
  readonly createIfMissing?: boolean
}

export class HookConfigConflictError extends Error {
  readonly code = 'REVISION_CONFLICT'
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(expectedRevision: number, actualRevision: number) {
    super(`hook config revision conflict: expected ${expectedRevision}, actual ${actualRevision}`)
    this.name = 'HookConfigConflictError'
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

interface DiskContent {
  readonly raw: string
  readonly hash: string
}

interface ConfigStoreDependencies {
  readonly watch: (
    path: string,
    listener: (eventType: 'rename' | 'change', filename: string | null) => void,
  ) => FSWatcher
}

const DEFAULT_DEPENDENCIES: ConfigStoreDependencies = { watch }

export function resolveHookConfigPath(home = homedir()): string {
  return join(home, '.dsh', 'hook.json')
}

function digest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function frozenState(
  path: string,
  exists: boolean,
  revision: number,
  loadError: string | null,
  hooks: readonly ResolvedHook[],
): HookConfigState {
  const frozenHooks = Object.freeze(hooks.map(hook => Object.freeze({ ...hook })))
  return Object.freeze({ path, exists, revision, loadError, hooks: frozenHooks })
}

async function ensureConfigFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
    await handle.writeFile(DEFAULT_DOCUMENT, 'utf8')
    await handle.sync()
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  } finally {
    await handle?.close()
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = dirname(path)
  while (true) {
    try {
      if ((await lstat(candidate)).isDirectory()) return candidate
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
    const parent = dirname(candidate)
    if (parent === candidate) return candidate
    candidate = parent
  }
}

async function readDisk(path: string): Promise<DiskContent> {
  const linkStat = await lstat(path)
  if (linkStat.isSymbolicLink()) throw new Error('hook config target must not be a symbolic link')
  if (!linkStat.isFile()) throw new Error('hook config target must be a regular file')

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new Error('hook config target must be a regular file')
    const raw = await handle.readFile('utf8')
    return { raw, hash: digest(raw) }
  } finally {
    await handle.close()
  }
}

function parseRaw(raw: string): ParsedHookConfig {
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid JSON: ${errorText(error)}`)
  }
  return parseHookConfig(document)
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

async function atomicWrite(path: string, raw: string, expectedHash: string): Promise<void> {
  const directory = dirname(path)
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
    if (current.hash !== expectedHash) throw new HookConfigConflictError(-1, -1)
    await rename(temporary, path)
    renamed = true
    await chmod(path, 0o600)
    await syncDirectory(directory)
  } finally {
    await handle?.close()
    if (!renamed) await rm(temporary, { force: true })
  }
}

export function openHookConfigStore(options?: OpenHookConfigStoreOptions): Promise<HookConfigStore>
export async function openHookConfigStore(
  options: OpenHookConfigStoreOptions = {},
  dependencies: ConfigStoreDependencies = DEFAULT_DEPENDENCIES,
): Promise<HookConfigStore> {
  const path = options.path ?? resolveHookConfigPath(options.home)
  const createIfMissing = options.createIfMissing ?? true

  let snapshot = frozenState(path, false, 0, 'not loaded', [])
  let signature: string | null = null
  let document: HookDocument | null = null
  let disposed = false
  let watcher: FSWatcher | undefined
  let watchedDirectory: string | undefined
  let watchTimer: NodeJS.Timeout | undefined
  let watchRetryTimer: NodeJS.Timeout | undefined
  let watchRetryAttempt = 0
  let serial: Promise<unknown> = Promise.resolve()
  const listeners = new Set<(state: HookConfigState) => void>()

  function publish(
    nextSignature: string,
    exists: boolean,
    parsed: ParsedHookConfig | null,
    loadError: string | null,
  ): HookConfigState {
    if (signature === nextSignature) return snapshot
    signature = nextSignature
    document = parsed?.document ?? null
    snapshot = frozenState(path, exists, snapshot.revision + 1, loadError, parsed?.hooks ?? [])
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch {
        // Subscriber failures cannot interrupt configuration publication.
      }
    }
    return snapshot
  }

  function applyDisk(disk: DiskContent): HookConfigState {
    try {
      return publish(`file:${disk.hash}`, true, parseRaw(disk.raw), null)
    } catch (error) {
      return publish(`file:${disk.hash}`, true, null, errorText(error))
    }
  }

  async function load(): Promise<HookConfigState> {
    let next: HookConfigState
    try {
      if (createIfMissing) await ensureConfigFile(path)
      next = applyDisk(await readDisk(path))
    } catch (error) {
      if (!createIfMissing && isNodeError(error) && error.code === 'ENOENT') {
        next = publish('missing', false, null, null)
      } else {
        const message = errorText(error)
        next = publish(`error:${message}`, true, null, message)
      }
    }
    await refreshWatcher()
    return next
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(operation, operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }

  function reload(): Promise<HookConfigState> {
    if (disposed) return Promise.resolve(snapshot)
    return enqueue(load)
  }

  function scheduleReload(): void {
    if (disposed) return
    if (watchTimer !== undefined) clearTimeout(watchTimer)
    watchTimer = setTimeout(() => {
      watchTimer = undefined
      void reload()
    }, WATCH_DELAY_MS)
    watchTimer.unref?.()
  }

  function scheduleWatcherRetry(): void {
    if (disposed || watchRetryTimer !== undefined) return
    const delay = WATCH_RETRY_DELAYS_MS[Math.min(watchRetryAttempt, WATCH_RETRY_DELAYS_MS.length - 1)]
    watchRetryAttempt += 1
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = undefined
      void refreshWatcher()
    }, delay)
    watchRetryTimer.unref?.()
  }

  function handleWatcherFailure(current: FSWatcher): void {
    if (disposed || watcher !== current) return
    watcher = undefined
    watchedDirectory = undefined
    current.close()
    scheduleReload()
    scheduleWatcherRetry()
  }

  async function refreshWatcher(): Promise<void> {
    if (disposed) return
    let directory: string
    try {
      directory = await nearestExistingDirectory(path)
    } catch {
      scheduleWatcherRetry()
      return
    }
    if (disposed) return
    if (watcher !== undefined && watchedDirectory === directory) {
      if (directory === dirname(path)) {
        watchRetryAttempt = 0
      } else {
        scheduleWatcherRetry()
      }
      return
    }

    const previous = watcher
    watcher = undefined
    watchedDirectory = undefined
    previous?.close()

    try {
      const current = dependencies.watch(directory, (eventType, filename) => {
        if (directory !== dirname(path) || filename === null || String(filename) === basename(path)) scheduleReload()
      })
      watcher = current
      watchedDirectory = directory
      watchRetryAttempt = 0
      if (watchRetryTimer !== undefined) clearTimeout(watchRetryTimer)
      watchRetryTimer = undefined
      current.on('error', () => handleWatcherFailure(current))
      current.on('close', () => handleWatcherFailure(current))
      scheduleReload()
      if (directory !== dirname(path)) scheduleWatcherRetry()
    } catch {
      scheduleReload()
      scheduleWatcherRetry()
    }
  }

  await load()

  async function setEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<HookConfigState> {
    if (disposed) throw new Error('hook config store is disposed')
    return enqueue(async () => {
      if (snapshot.revision !== expectedRevision) {
        throw new HookConfigConflictError(expectedRevision, snapshot.revision)
      }

      let currentDisk: DiskContent
      try {
        currentDisk = await readDisk(path)
      } catch (error) {
        await load()
        throw new HookConfigConflictError(expectedRevision, snapshot.revision)
      }
      if (signature !== `file:${currentDisk.hash}`) {
        applyDisk(currentDisk)
        throw new HookConfigConflictError(expectedRevision, snapshot.revision)
      }
      if (document === null || snapshot.loadError !== null) {
        throw new Error(`hook config is invalid: ${snapshot.loadError ?? 'unknown error'}`)
      }

      const updated = setHookEnabled(document, id, enabled)
      const parsed = parseHookConfig(updated)
      const raw = `${JSON.stringify(updated, null, 2)}\n`
      try {
        await atomicWrite(path, raw, currentDisk.hash)
      } catch (error) {
        if (error instanceof HookConfigConflictError) {
          await load()
          throw new HookConfigConflictError(expectedRevision, snapshot.revision)
        }
        throw error
      }
      return publish(`file:${digest(raw)}`, true, parsed, null)
    })
  }

  function subscribe(listener: (state: HookConfigState) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (watchTimer !== undefined) clearTimeout(watchTimer)
    watchTimer = undefined
    if (watchRetryTimer !== undefined) clearTimeout(watchRetryTimer)
    watchRetryTimer = undefined
    const current = watcher
    watcher = undefined
    watchedDirectory = undefined
    current?.close()
    await serial
    listeners.clear()
  }

  return {
    state: () => snapshot,
    subscribe,
    reload,
    setEnabled,
    dispose,
  }
}
