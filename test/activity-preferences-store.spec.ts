import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openActivityPreferencesStore, resolveActivityPreferencesPath } from '../src/activity-preferences-store.js'

describe('activity preferences store', () => {
  it('defaults to showing session activity when the file is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-activity-preferences-'))
    const store = await openActivityPreferencesStore({ home })

    expect(store.state()).toEqual({ showSessionActivity: true, revision: 0 })
    await store.dispose()
  })

  it('loads a valid preference and persists revisioned updates atomically', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-activity-preferences-'))
    const path = resolveActivityPreferencesPath(home)
    await mkdir(join(home, '.dsh', 'dsh-notice-hooks'), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, showSessionActivity: false }), { mode: 0o600 })
    const store = await openActivityPreferencesStore({ home })

    expect(store.state()).toEqual({ showSessionActivity: false, revision: 0 })
    await expect(store.setShowSessionActivity(true, 0)).resolves.toEqual({ showSessionActivity: true, revision: 1 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, showSessionActivity: true })
    await store.dispose()
  })

  it('fails open for malformed or unsafe preference files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-activity-preferences-'))
    const path = resolveActivityPreferencesPath(home)
    await mkdir(join(home, '.dsh', 'dsh-notice-hooks'), { recursive: true })
    await writeFile(path, '{bad', { mode: 0o600 })
    const malformed = await openActivityPreferencesStore({ home })
    expect(malformed.state()).toEqual({ showSessionActivity: true, revision: 0 })
    await malformed.dispose()

    await writeFile(path, JSON.stringify({ version: 1, showSessionActivity: false }), { mode: 0o644 })
    await chmod(path, 0o644)
    const unsafe = await openActivityPreferencesStore({ home })
    expect(unsafe.state()).toEqual({ showSessionActivity: true, revision: 0 })
    await unsafe.dispose()
  })

  it('rejects stale revisions without changing the preference', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-activity-preferences-'))
    const store = await openActivityPreferencesStore({ home })

    await expect(store.setShowSessionActivity(false, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(store.state()).toEqual({ showSessionActivity: true, revision: 0 })
    await store.dispose()
  })
})
