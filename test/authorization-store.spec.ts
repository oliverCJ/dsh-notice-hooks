import { mkdir, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openAuthorizationStore,
  resolveAuthorizationPath,
} from '../src/authorization-store.ts'
import type { AuthorizationStore } from '../src/authorization-store.ts'
import type { AuthorizationFingerprint } from '../src/authorization.ts'

const homes: string[] = []
const fingerprintA = `sha256:${'a'.repeat(64)}` as AuthorizationFingerprint
const fingerprintB = `sha256:${'b'.repeat(64)}` as AuthorizationFingerprint
const fingerprintC = `sha256:${'c'.repeat(64)}` as AuthorizationFingerprint

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-auth-'))
  homes.push(path)
  return path
}

async function save(path: string, value: unknown): Promise<void> {
  const target = resolveAuthorizationPath(path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('AuthorizationStore loading', () => {
  it('starts empty without migrating enabled declarations from hook.json', async () => {
    const testHome = await home()
    await mkdir(join(testHome, '.dsh'), { recursive: true })
    await writeFile(join(testHome, '.dsh', 'hook.json'), JSON.stringify({
      version: 1,
      hooks: {
        Stop: [{ hooks: [{ id: 'notify', type: 'command', command: '/bin/notify', enabled: true }] }],
      },
    }))

    const store = await openAuthorizationStore({ home: testHome })

    expect(store.get('user', 'notify')).toBeUndefined()
    await expect(lstat(resolveAuthorizationPath(testHome))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['unknown version', JSON.stringify({ version: 2, scopes: {} })],
    ['malformed scopes', JSON.stringify({ version: 1, scopes: { user: { notify: 'bad' } } })],
  ])('fails closed for %s', async (_label, raw) => {
    const testHome = await home()
    const target = resolveAuthorizationPath(testHome)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, raw, { mode: 0o600 })
    const warn = vi.fn()

    const store = await openAuthorizationStore({ home: testHome, logger: { warn } })

    expect(store.get('user', 'notify')).toBeUndefined()
    await expect(store.grant('user', 'notify', fingerprintA)).rejects.toThrow()
    expect(warn).toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')('fails closed for symbolic links and non-regular files', async () => {
    const testHome = await home()
    const target = resolveAuthorizationPath(testHome)
    await mkdir(dirname(target), { recursive: true })
    const outside = join(testHome, 'outside.json')
    await writeFile(outside, JSON.stringify({ version: 1, scopes: { user: { notify: fingerprintA } } }), { mode: 0o600 })
    await symlink(outside, target)

    const linked = await openAuthorizationStore({ home: testHome, logger: { warn: vi.fn() } })
    expect(linked.get('user', 'notify')).toBeUndefined()
    await expect(linked.grant('user', 'notify', fingerprintA)).rejects.toThrow(/symbolic link|regular file/i)

    await rm(target)
    await mkdir(target)
    const directory = await openAuthorizationStore({ home: testHome, logger: { warn: vi.fn() } })
    expect(directory.get('user', 'notify')).toBeUndefined()
    await expect(directory.grant('user', 'notify', fingerprintA)).rejects.toThrow(/regular file/i)
  })

  it.runIf(process.platform !== 'win32')('fails closed when the owner configuration directory is a symbolic link', async () => {
    const testHome = await home()
    const outside = join(testHome, 'outside')
    await mkdir(outside)
    await symlink(outside, join(testHome, '.dsh'))
    const store = await openAuthorizationStore({ home: testHome, logger: { warn: vi.fn() } })

    await expect(store.grant('user', 'notify', fingerprintA)).rejects.toThrow(/symbolic link|regular directory/i)
    await expect(lstat(join(outside, 'dsh-notice-hooks', 'authorizations.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('AuthorizationStore mutations', () => {
  it('keeps prepared grants non-executable across restart until committed', async () => {
    const testHome = await home()
    const store = await openAuthorizationStore({ home: testHome })
    const prepared = store as AuthorizationStore & {
      prepareGrant(scopeId: string, hookId: string, fingerprint: AuthorizationFingerprint): Promise<void>
      commitGrant(scopeId: string, hookId: string, fingerprint: AuthorizationFingerprint): Promise<void>
    }

    await prepared.prepareGrant('user', 'notify', fingerprintA)
    expect(store.get('user', 'notify')).toBeUndefined()
    expect(JSON.parse(await readFile(resolveAuthorizationPath(testHome), 'utf8'))).toEqual({
      version: 1,
      scopes: {},
      pending: { user: { notify: fingerprintA } },
    })

    const reopened = await openAuthorizationStore({ home: testHome })
    expect(reopened.get('user', 'notify')).toBeUndefined()
    await (reopened as typeof prepared).commitGrant('user', 'notify', fingerprintA)
    expect(reopened.get('user', 'notify')).toBe(fingerprintA)
  })

  it('stores user and project approvals only in the owner authorization file with restrictive permissions', async () => {
    const testHome = await home()
    const store = await openAuthorizationStore({ home: testHome })

    await store.grant('user', 'notify', fingerprintA)
    await store.grant('workspace:alpha', 'audit', fingerprintB)

    const target = resolveAuthorizationPath(testHome)
    expect(target).toBe(join(testHome, '.dsh', 'dsh-notice-hooks', 'authorizations.json'))
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      version: 1,
      scopes: {
        user: { notify: fingerprintA },
        'workspace:alpha': { audit: fingerprintB },
      },
    })
    expect((await lstat(dirname(target))).mode & 0o777).toBe(0o700)
    expect((await lstat(target)).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent grants and idempotent revokes without losing other records', async () => {
    const testHome = await home()
    const store = await openAuthorizationStore({ home: testHome })

    await Promise.all([
      store.grant('user', 'notify', fingerprintA),
      store.grant('workspace:alpha', 'audit', fingerprintB),
      store.revoke('user', 'notify'),
      store.grant('user', 'other', fingerprintC),
      store.revoke('user', 'missing'),
    ])

    expect(store.get('user', 'notify')).toBeUndefined()
    expect(store.get('user', 'other')).toBe(fingerprintC)
    expect(store.get('workspace:alpha', 'audit')).toBe(fingerprintB)
    const disk = JSON.parse(await readFile(resolveAuthorizationPath(testHome), 'utf8'))
    expect(disk.scopes).toEqual({
      user: { other: fingerprintC },
      'workspace:alpha': { audit: fingerprintB },
    })
  })

  it('cleans a same-directory temporary file when atomic rename fails', async () => {
    const testHome = await home()
    const rename = vi.fn(async () => {
      throw new Error('rename failed')
    })
    const openWithDependencies = openAuthorizationStore as unknown as (
      options: Parameters<typeof openAuthorizationStore>[0],
      dependencies: { rename: typeof rename },
    ) => Promise<AuthorizationStore>
    const store = await openWithDependencies({ home: testHome, logger: { warn: vi.fn() } }, { rename })

    await expect(store.grant('user', 'notify', fingerprintA)).rejects.toThrow('rename failed')

    const entries = await readdir(dirname(resolveAuthorizationPath(testHome)))
    expect(entries.filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
