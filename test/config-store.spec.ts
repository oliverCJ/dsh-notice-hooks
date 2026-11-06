import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HookConfigConflictError,
  openHookConfigStore,
  resolveHookConfigPath,
} from '../src/config-store.ts'
import type { HookConfigStore } from '../src/config-store.ts'

const homes: string[] = []
const stores: HookConfigStore[] = []

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-'))
  homes.push(path)
  return path
}

function document(id = 'notify', extras: Record<string, unknown> = {}) {
  return {
    version: 1,
    rootMetadata: { owner: 'test' },
    hooks: {
      PreToolUse: [{
        matcher: 'bash',
        groupMetadata: true,
        hooks: [{
          id,
          type: 'command',
          command: '/bin/echo hook',
          hookMetadata: 'preserve-me',
          ...extras,
        }],
      }],
    },
  }
}

async function open(testHome: string): Promise<HookConfigStore> {
  const store = await openHookConfigStore({ home: testHome })
  stores.push(store)
  return store
}

async function save(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '.dsh'), { recursive: true })
  await writeFile(resolveHookConfigPath(path), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

class ControlledWatcher extends EventEmitter {
  closed = false

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

type WatchListener = (eventType: string, filename: string | Buffer | null) => void
type WatchFactory = (path: string, listener: WatchListener) => FSWatcher

const openWithWatch = openHookConfigStore as unknown as (
  options: Parameters<typeof openHookConfigStore>[0],
  dependencies: { watch: WatchFactory },
) => Promise<HookConfigStore>

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()))
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('loading and fail-closed state', () => {
  it('creates a missing owner-only config and publishes an empty valid snapshot', async () => {
    const testHome = await home()
    const store = await open(testHome)
    const path = resolveHookConfigPath(testHome)
    const disk = JSON.parse(await readFile(path, 'utf8'))
    const mode = (await lstat(path)).mode & 0o777

    expect(path).toBe(join(testHome, '.dsh', 'hook.json'))
    expect(disk).toEqual({ version: 1, hooks: {} })
    expect(mode).toBe(0o600)
    expect(store.state()).toMatchObject({ path, exists: true, revision: 1, loadError: null, hooks: [] })
    expect(Object.isFrozen(store.state())).toBe(true)
    expect(Object.isFrozen(store.state().hooks)).toBe(true)
  })

  it('publishes an empty missing snapshot without creating a project config path', async () => {
    const testHome = await home()
    const path = resolveHookConfigPath(testHome)
    const store = await openHookConfigStore({ path, createIfMissing: false })
    stores.push(store)

    expect(store.state()).toMatchObject({ path, exists: false, revision: 1, loadError: null, hooks: [] })
    await expect(lstat(join(testHome, '.dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('loads valid config and fails closed for malformed JSON or schema', async () => {
    const testHome = await home()
    await save(testHome, document())
    const store = await open(testHome)

    expect(store.state()).toMatchObject({
      revision: 1,
      loadError: null,
      hooks: [{ id: 'notify', event: 'PreToolUse', enabled: false }],
    })

    await writeFile(resolveHookConfigPath(testHome), '{broken', 'utf8')
    await store.reload()
    expect(store.state().revision).toBe(2)
    expect(store.state().hooks).toEqual([])
    expect(store.state().loadError).toContain('JSON')

    await writeFile(resolveHookConfigPath(testHome), JSON.stringify({ version: 2, hooks: {} }), 'utf8')
    await store.reload()
    expect(store.state().revision).toBe(3)
    expect(store.state().hooks).toEqual([])
    expect(store.state().loadError).toContain('version')
  })

  it.runIf(process.platform !== 'win32')('rejects symlink and non-regular targets', async () => {
    const testHome = await home()
    await mkdir(join(testHome, '.dsh'), { recursive: true })
    const target = join(testHome, 'outside.json')
    await writeFile(target, JSON.stringify(document()), 'utf8')
    await symlink(target, resolveHookConfigPath(testHome))
    const store = await open(testHome)

    expect(store.state().hooks).toEqual([])
    expect(store.state().loadError).toMatch(/symbolic link|regular file/i)
    await store.dispose()
    stores.splice(stores.indexOf(store), 1)

    await rm(resolveHookConfigPath(testHome))
    await mkdir(resolveHookConfigPath(testHome))
    const directoryStore = await open(testHome)
    expect(directoryStore.state().hooks).toEqual([])
    expect(directoryStore.state().loadError).toMatch(/regular file/i)
  })
})

describe('parent-directory watching', () => {
  it('observes project config creation, edits, atomic replacement, and deletion', async () => {
    const testHome = await home()
    const path = resolveHookConfigPath(testHome)
    const store = await openHookConfigStore({ path, createIfMissing: false })
    stores.push(store)

    await save(testHome, document('created'))
    await expect.poll(() => store.state().hooks[0]?.id, { timeout: 2_000 }).toBe('created')
    expect(store.state()).toMatchObject({ exists: true, loadError: null })

    await writeFile(path, `${JSON.stringify(document('edited'))}\n`, { mode: 0o600 })
    await expect.poll(() => store.state().hooks[0]?.id, { timeout: 2_000 }).toBe('edited')

    const replacement = join(testHome, '.dsh', 'replacement.tmp')
    await writeFile(replacement, `${JSON.stringify(document('replaced'))}\n`, { mode: 0o600 })
    await rename(replacement, path)
    await expect.poll(() => store.state().hooks[0]?.id, { timeout: 2_000 }).toBe('replaced')

    await rm(path)
    await expect.poll(() => store.state().exists, { timeout: 2_000 }).toBe(false)
    expect(store.state()).toMatchObject({ hooks: [], loadError: null })
  })

  it('reloads atomic rename saves, ignores equal content, fails closed, and recovers', async () => {
    const testHome = await home()
    await save(testHome, document())
    const store = await open(testHome)
    const path = resolveHookConfigPath(testHome)
    const replacement = join(testHome, '.dsh', 'replacement.tmp')

    await writeFile(replacement, `${JSON.stringify(document('renamed'))}\n`, { mode: 0o600 })
    await rename(replacement, path)
    await expect.poll(() => store.state().hooks[0]?.id, { timeout: 2_000 }).toBe('renamed')
    const renamedRevision = store.state().revision

    await chmod(path, 0o600)
    await expect.poll(() => store.state().revision, { timeout: 500 }).toBe(renamedRevision)

    await writeFile(replacement, '{invalid', { mode: 0o600 })
    await rename(replacement, path)
    await expect.poll(() => store.state().loadError, { timeout: 2_000 }).not.toBeNull()
    expect(store.state().hooks).toEqual([])

    await writeFile(replacement, `${JSON.stringify(document('recovered'))}\n`, { mode: 0o600 })
    await rename(replacement, path)
    await expect.poll(() => store.state().hooks[0]?.id, { timeout: 2_000 }).toBe('recovered')
    expect(store.state().loadError).toBeNull()
  })

  it('rebuilds closed and errored watchers with bounded backoff and clears retries on disposal', async () => {
    vi.useFakeTimers()
    const testHome = await home()
    const watchers: ControlledWatcher[] = []
    let failures = 0
    let resolveNextAttempt: (() => void) | undefined
    const waitForNextAttempt = (): Promise<void> => new Promise(resolve => {
      resolveNextAttempt = resolve
    })
    const watchFactory: WatchFactory = (_path, _listener) => {
      // Synchronize with the real filesystem lookup that runs after each fake retry timer.
      const resolveAttempt = resolveNextAttempt
      resolveNextAttempt = undefined
      resolveAttempt?.()
      if (failures > 0) {
        failures -= 1
        throw new Error('watch unavailable')
      }
      const watcher = new ControlledWatcher()
      watchers.push(watcher)
      return watcher as unknown as FSWatcher
    }

    try {
      const store = await openWithWatch(
        { path: resolveHookConfigPath(testHome), createIfMissing: false },
        { watch: watchFactory },
      )
      stores.push(store)
      expect(watchers).toHaveLength(1)

      const reopened = waitForNextAttempt()
      watchers[0]!.emit('close')
      await vi.advanceTimersByTimeAsync(25)
      await reopened
      expect(watchers).toHaveLength(2)

      failures = 1
      const failedAttempt = waitForNextAttempt()
      watchers[1]!.emit('error', new Error('watch failed'))
      await vi.advanceTimersByTimeAsync(25)
      await failedAttempt
      expect(watchers).toHaveLength(2)

      const recovered = waitForNextAttempt()
      await vi.advanceTimersByTimeAsync(50)
      await recovered
      expect(watchers).toHaveLength(3)

      watchers[2]!.emit('close')
      await store.dispose()
      stores.splice(stores.indexOf(store), 1)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(watchers).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops observing changes after disposal', async () => {
    const testHome = await home()
    await save(testHome, document())
    const store = await open(testHome)
    const revision = store.state().revision
    await store.dispose()
    stores.splice(stores.indexOf(store), 1)

    await writeFile(resolveHookConfigPath(testHome), JSON.stringify(document('later')), 'utf8')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(store.state().revision).toBe(revision)
  })
})

describe('atomic enable mutation', () => {
  it('preserves unknown fields, uses mode 0600, and publishes one revision', async () => {
    const testHome = await home()
    await save(testHome, document())
    const store = await open(testHome)
    const notifications: number[] = []
    const unsubscribe = store.subscribe(state => notifications.push(state.revision))

    const next = await store.setEnabled('notify', true, store.state().revision)
    unsubscribe()
    const disk = JSON.parse(await readFile(resolveHookConfigPath(testHome), 'utf8'))
    const savedHook = disk.hooks.PreToolUse[0].hooks[0]

    expect(next).toMatchObject({ revision: 2, hooks: [{ id: 'notify', enabled: true }] })
    expect(disk.rootMetadata).toEqual({ owner: 'test' })
    expect(disk.hooks.PreToolUse[0].groupMetadata).toBe(true)
    expect(savedHook.hookMetadata).toBe('preserve-me')
    expect(savedHook.enabled).toBe(true)
    expect((await lstat(resolveHookConfigPath(testHome))).mode & 0o777).toBe(0o600)
    expect(notifications).toEqual([2])
    expect((await readdir(join(testHome, '.dsh'))).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('rejects stale revisions without overwriting the file', async () => {
    const testHome = await home()
    await save(testHome, document())
    const store = await open(testHome)
    const before = await readFile(resolveHookConfigPath(testHome), 'utf8')

    await expect(store.setEnabled('notify', true, 0)).rejects.toBeInstanceOf(HookConfigConflictError)
    expect(await readFile(resolveHookConfigPath(testHome), 'utf8')).toBe(before)
  })

  it('detects an external write before a pending watcher reload and never overwrites it', async () => {
    const testHome = await home()
    await save(testHome, document())
    const store = await open(testHome)
    const originalRevision = store.state().revision
    await writeFile(resolveHookConfigPath(testHome), `${JSON.stringify(document('external'))}\n`, { mode: 0o600 })

    await expect(store.setEnabled('notify', true, originalRevision)).rejects.toBeInstanceOf(HookConfigConflictError)
    expect(JSON.parse(await readFile(resolveHookConfigPath(testHome), 'utf8')).hooks.PreToolUse[0].hooks[0].id).toBe('external')
    expect(store.state()).toMatchObject({ revision: originalRevision + 1, hooks: [{ id: 'external' }] })
  })
})
