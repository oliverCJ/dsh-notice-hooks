import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runnerState = vi.hoisted(() => ({ calls: [] as string[], rejected: new Set<string>() }))
vi.mock('../src/runner.js', () => ({
  createHookRunner: () => ({
    run: vi.fn(async (runtimeId: string, hook: { id: string }) => {
      runnerState.calls.push(runtimeId)
      if (runnerState.rejected.has(runtimeId)) throw new Error('runner rejected')
      return { runtimeId, hookId: hook.id, status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '' }
    }),
    cancel: vi.fn(), reconcile: vi.fn(), stats: vi.fn(() => ({})), dispose: vi.fn(async () => undefined),
  }),
}))
import { fingerprintHook } from '../src/authorization.js'
import { openAuthorizationStore } from '../src/authorization-store.js'
import { parseHookConfig } from '../src/config.js'
import * as NoticeHooks from '../src/index.js'

const roots: string[] = []
const contexts: Context[] = []
async function saveConfig(root: string, hooks: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, '.dsh'), { recursive: true })
  await writeFile(join(root, '.dsh', 'hook.json'), JSON.stringify({ version: 1, hooks }))
}
async function save(root: string, id: string): Promise<void> {
  await saveConfig(root, { Stop: [{ hooks: [{ id, type: 'command', command: 'true', enabled: true }] }] })
}
async function grantConfiguredHooks(root: string, workspace: { id: string, path: string }): Promise<void> {
  const store = await openAuthorizationStore({ home: root })
  for (const scope of [
    { id: 'user', path: join(root, '.dsh', 'hook.json') },
    { id: `workspace:${workspace.id}`, path: join(workspace.path, '.dsh', 'hook.json') },
  ]) {
    const config = parseHookConfig(JSON.parse(await readFile(scope.path, 'utf8')))
    for (const hook of config.hooks) {
      if (hook.enabled) await store.grant(scope.id, hook.id, fingerprintHook(scope.id, hook))
    }
  }
}
function emit(ctx: Context, name: string, ...args: readonly unknown[]): void { Reflect.apply(ctx.emit, ctx, [name, ...args]) }
async function eventually(check: () => boolean): Promise<void> {
  await expect.poll(check, { timeout: 3000 }).toBe(true)
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  runnerState.calls.length = 0
  runnerState.rejected.clear()
  vi.unstubAllEnvs()
})

describe('runtime scope dispatch order', () => {
  it('dispatches user then fixed workspace scope and leaves unregistered sessions user-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-order-'))
    const project = join(root, 'project-a')
    roots.push(root)
    await save(root, 'same-id'); await save(project, 'same-id')
    vi.stubEnv('HOME', root)
    const workspace = { id: 'project-a', path: project, title: 'Project A' }
    await grantConfiguredHooks(root, workspace)
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('workspaceRegistry', {
      get: (id: string) => id === workspace.id ? workspace : undefined,
      list: () => [workspace],
      resolveByPath: async (path: string) => path === project ? workspace : undefined,
    } as never)
    const fiber = ctx.plugin(NoticeHooks); await fiber.await()
    const stop = { type: 'turn/end', data: { reason: { kind: 'complete' } } }

    emit(ctx, 'session/event', { id: 'fixed', header: { cwd: project } }, stop)
    await eventually(() => runnerState.calls.length === 2)
    expect(runnerState.calls[0]).toBe(JSON.stringify(['user', 'same-id']))
    expect(JSON.parse(runnerState.calls[1]!).at(-1)).toBe('same-id')
    const workspaceRuntimeId = runnerState.calls[1]

    emit(ctx, 'session/event', { id: 'fixed', header: { cwd: join(root, 'other') } }, stop)
    await eventually(() => runnerState.calls.length === 4)
    expect(runnerState.calls.slice(2)).toEqual([JSON.stringify(['user', 'same-id']), workspaceRuntimeId])

    emit(ctx, 'session/event', { id: 'new', header: { cwd: join(root, 'other') } }, stop)
    await eventually(() => runnerState.calls.length === 5)
    expect(runnerState.calls.at(-1)).toBe(JSON.stringify(['user', 'same-id']))
  })

  it('matcher throw 与 Runner reject 均不阻塞后续 scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-isolation-'))
    const project = join(root, 'project-a')
    roots.push(root)
    await saveConfig(root, {
      Stop: [
        { matcher: 'explode', hooks: [{ id: 'matcher-error', type: 'command', command: 'true', enabled: true }] },
        { hooks: [{ id: 'runner-error', type: 'command', command: 'true', enabled: true }] },
      ],
    })
    await save(project, 'project-success')
    vi.stubEnv('HOME', root)
    const workspace = { id: 'project-a', path: project, title: 'Project A' }
    await grantConfiguredHooks(root, workspace)
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('workspaceRegistry', {
      get: (id: string) => id === workspace.id ? workspace : undefined,
      list: () => [workspace],
      resolveByPath: async () => workspace,
    } as never)
    const fiber = ctx.plugin(NoticeHooks); await fiber.await()
    runnerState.rejected.add(JSON.stringify(['user', 'runner-error']))
    const originalTest = RegExp.prototype.test
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, value: string) {
      if (this.source === 'explode') throw new Error('matcher exploded')
      return originalTest.call(this, value)
    })

    emit(ctx, 'session/event', { id: 'isolated', header: { cwd: project } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await eventually(() => runnerState.calls.length === 2)
    expect(runnerState.calls[0]).toBe(JSON.stringify(['user', 'runner-error']))
    expect(JSON.parse(runnerState.calls[1]!).at(-1)).toBe('project-success')
  })
})
