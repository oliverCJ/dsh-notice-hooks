import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'

const VERSION = 1
const DEFAULT_STATE = Object.freeze({ showSessionActivity: true, revision: 0 })

export interface ActivityPreferencesState {
  readonly showSessionActivity: boolean
  readonly revision: number
}

export interface ActivityPreferencesStore {
  state(): ActivityPreferencesState
  setShowSessionActivity(value: boolean, expectedRevision: number): Promise<ActivityPreferencesState>
  dispose(): Promise<void>
}

export interface OpenActivityPreferencesStoreOptions {
  readonly home?: string
  readonly path?: string
}

interface RevisionConflict extends Error { readonly code: 'REVISION_CONFLICT' }

export function resolveActivityPreferencesPath(home = homedir()): string {
  return join(home, '.dsh', 'dsh-notice-hooks', 'preferences.json')
}

function defaultState(): ActivityPreferencesState {
  return { ...DEFAULT_STATE }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseState(raw: string): boolean {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value) || value.version !== VERSION || typeof value.showSessionActivity !== 'boolean') {
    throw new Error('activity preferences document is invalid')
  }
  return value.showSessionActivity
}

async function isSafeFile(path: string): Promise<boolean> {
  const stat = await lstat(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) return false
  return true
}

async function readPreference(path: string): Promise<boolean> {
  try {
    if (!(await isSafeFile(path))) return true
    return parseState(await readFile(path, 'utf8'))
  } catch {
    return true
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory()) throw new Error('activity preferences directory is unsafe')
  await chmod(directory, 0o700)
  const secured = await lstat(directory)
  if ((secured.mode & 0o077) !== 0) throw new Error('activity preferences directory is unsafe')
}

async function writePreference(path: string, showSessionActivity: boolean): Promise<void> {
  await ensureDirectory(path)
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ version: VERSION, showSessionActivity }) + '\n', { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    try { await import('node:fs/promises').then(fs => fs.rm(temporary, { force: true })) } catch { /* best effort */ }
    throw error
  }
}

export async function openActivityPreferencesStore(options: OpenActivityPreferencesStoreOptions = {}): Promise<ActivityPreferencesStore> {
  const path = options.path ?? resolveActivityPreferencesPath(options.home)
  let current: ActivityPreferencesState = { ...defaultState(), showSessionActivity: await readPreference(path) }
  let serial = Promise.resolve()
  let disposed = false

  return {
    state: () => current,
    setShowSessionActivity(value, expectedRevision) {
      const operation = serial.then(async () => {
        if (disposed) throw new Error('activity preferences store is disposed')
        if (expectedRevision !== current.revision) {
          const error = new Error('activity preferences revision conflict') as RevisionConflict
          Object.assign(error, { code: 'REVISION_CONFLICT' })
          throw error
        }
        await writePreference(path, value)
        current = Object.freeze({ showSessionActivity: value, revision: current.revision + 1 })
        return current
      })
      serial = operation.then(() => undefined, () => undefined)
      return operation
    },
    async dispose() {
      disposed = true
      await serial
    },
  }
}
