import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { pluginRecordOf, Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintHook } from '../src/authorization.js'
import { openAuthorizationStore } from '../src/authorization-store.js'
import { parseHookConfig } from '../src/config.js'
import * as NoticeHooks from '../src/index.js'

const fixture = fileURLToPath(new URL('./fixtures/child-process.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []

function quote(value: string): string {
  return JSON.stringify(value)
}

async function eventually(check: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (true) {
    try {
      if (await check()) return
    } catch {
      // The observed file or process may not exist until the child starts.
    }
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function save(root: string, hooks: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, '.dsh'), { recursive: true })
  await writeFile(join(root, '.dsh', 'hook.json'), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`)
}

async function grantConfiguredHooks(root: string, workspaceRegistry: object): Promise<void> {
  const store = await openAuthorizationStore({ home: root })
  const scopes = [
    { id: 'user', path: join(root, '.dsh', 'hook.json') },
    ...((workspaceRegistry as { list?: () => Array<{ id: string, path: string }> }).list?.() ?? [])
      .map(workspace => ({ id: `workspace:${workspace.id}`, path: join(workspace.path, '.dsh', 'hook.json') })),
  ]
  for (const scope of scopes) {
    let raw: string
    try { raw = await readFile(scope.path, 'utf8') } catch { continue }
    for (const hook of parseHookConfig(JSON.parse(raw)).hooks) {
      if (hook.enabled) await store.grant(scope.id, hook.id, fingerprintHook(scope.id, hook))
    }
  }
}

async function boot(
  root: string,
  webServer?: object,
  workspaceRegistry: object | null = { get: () => undefined, list: () => [], resolveByPath: async () => undefined },
  seedAuthorization = true,
): Promise<{ ctx: Context, fiber: ReturnType<Context['plugin']> }> {
  vi.stubEnv('HOME', root)
  if (seedAuthorization) await grantConfiguredHooks(root, workspaceRegistry ?? {})
  const ctx = new Context()
  contexts.push(ctx)
  if (workspaceRegistry !== null) ctx.provide('workspaceRegistry', workspaceRegistry as never)
  if (webServer !== undefined) ctx.provide('webServer', webServer as never)
  const fiber = ctx.plugin(NoticeHooks)
  await fiber.await()
  return { ctx, fiber }
}

function emit(ctx: Context, name: string, ...args: readonly unknown[]): void {
  Reflect.apply(ctx.emit, ctx, [name, ...args])
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

describe('Cordis host composition', () => {
  it('does not execute enabled declarations without a matching user authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'unauthorized.log')
    await save(root, {
      Stop: [{ hooks: [{ id: 'unapproved', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`, enabled: true }] }],
    })
    const { ctx } = await boot(root, undefined, undefined, false)

    emit(ctx, 'session/event', { id: 'unapproved-session', header: { cwd: root } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await new Promise(resolve => setTimeout(resolve, 150))

    await expect(access(output)).rejects.toThrow()
  })

  it('fails closed when the authorization document cannot be trusted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'unsafe-authorization.log')
    await save(root, {
      Stop: [{ hooks: [{ id: 'unsafe', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`, enabled: true }] }],
    })
    const authorizationDirectory = join(root, '.dsh', 'dsh-notice-hooks')
    await mkdir(authorizationDirectory, { recursive: true })
    await writeFile(join(authorizationDirectory, 'authorizations.json'), '{invalid')
    const { ctx } = await boot(root, undefined, undefined, false)

    emit(ctx, 'session/event', { id: 'unsafe-authorization-session', header: { cwd: root } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await new Promise(resolve => setTimeout(resolve, 150))

    await expect(access(output)).rejects.toThrow()
  })

  it('cancels and rejects a previously authorized hook after its execution semantics change', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const pidFile = join(root, 'authorized.pid')
    const changedOutput = join(root, 'changed.log')
    await save(root, {
      Stop: [{ hooks: [{ id: 'mutable', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(pidFile)}`, enabled: true }] }],
    })
    const { ctx } = await boot(root)
    const session = { id: 'changed-semantics', header: { cwd: root } }

    emit(ctx, 'session/event', session, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await eventually(async () => Number.isInteger(Number((await readFile(pidFile, 'utf8')).trim())))
    const pid = Number((await readFile(pidFile, 'utf8')).trim())

    await save(root, {
      Stop: [{ hooks: [{ id: 'mutable', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(changedOutput)}`, enabled: true }] }],
    })
    await eventually(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
    emit(ctx, 'session/event', session, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await new Promise(resolve => setTimeout(resolve, 150))

    await expect(access(changedOutput)).rejects.toThrow()
  })

  it('dispatches canonical session events once and ignores unrelated signals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'events.log')
    const command = `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`
    await save(root, {
      SessionStart: [{ hooks: [{ id: 'start', type: 'command', command, enabled: true }] }],
      Stop: [
        { hooks: [{ id: 'stop', type: 'command', command, enabled: true }] },
        { matcher: 'never-match', hooks: [{ id: 'unmatched', type: 'command', command, enabled: true }] },
        { hooks: [{ id: 'disabled', type: 'command', command, enabled: false }] },
      ],
    })
    const { ctx } = await boot(root)
    const session = { id: 'session-1', header: { origin: 'user', cwd: root } }

    emit(ctx, 'session/created', session)
    emit(ctx, 'agent/status', { id: 'session-1' }, 'idle')
    emit(ctx, 'session/event', session, {
      type: 'turn/end', time: Date.now(), data: { turn: 'turn-1', reason: { kind: 'complete' } },
    })

    await eventually(async () => (await readFile(output, 'utf8')).split('\n').filter(Boolean).length === 2)
    expect((await readFile(output, 'utf8')).trim().split('\n').sort()).toEqual(['SessionStart', 'Stop'])
  })

  it('dispatches automatic and manual compaction lifecycle Hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'compaction.log')
    const command = `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`
    await save(root, {
      PreCompact: [{ matcher: '^automatic$', hooks: [{ id: 'before-compact', type: 'command', command, enabled: true }] }],
      PostCompact: [{ matcher: '^automatic$', hooks: [{ id: 'after-compact', type: 'command', command, enabled: true }] }],
      PostCompactFailure: [{ matcher: '^manual$', hooks: [{ id: 'failed-compact', type: 'command', command, enabled: true }] }],
    })
    const { ctx } = await boot(root)
    const session = Session.create(SessionId('compaction-session'))

    emit(ctx, 'session/event', session, { type: 'compaction/start', data: { compactionId: 'auto', turn: 1 } })
    emit(ctx, 'session/event', session, { type: 'compaction/end', data: { compactionId: 'auto', turn: 1 } })
    emit(ctx, 'session/event', session, { type: 'compaction/end', data: { compactionId: 'manual', turn: null, sourceCommandId: 'compact-command', error: 'failed' } })

    await eventually(async () => (await readFile(output, 'utf8')).trim().split('\n').length === 3)
    expect((await readFile(output, 'utf8')).trim().split('\n').sort()).toEqual(['PostCompact', 'PostCompactFailure', 'PreCompact'])
    const records = session.snapshotEvents().map(pluginRecordOf).filter(record => record !== undefined)
    expect(records.map(record => record.data)).toEqual([
      { event: 'PreCompact', triggered: [{ scope: 'user', id: 'before-compact' }], blocked: [] },
      { event: 'PostCompact', triggered: [{ scope: 'user', id: 'after-compact' }], blocked: [] },
      { event: 'PostCompactFailure', triggered: [{ scope: 'user', id: 'failed-compact' }], blocked: [] },
    ])
  })

  it('appends one durable notice for admitted and matching blocked Hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'notice.log')
    const command = `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`
    await save(root, {
      Stop: [{ hooks: [
        { id: 'admitted', type: 'command', command, enabled: true },
        { id: 'disabled', type: 'command', command, enabled: false },
      ] }],
    })
    const { ctx } = await boot(root)
    const session = Session.create(SessionId('notice-session'))

    emit(ctx, 'session/event', session, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })

    await eventually(async () => (await readFile(output, 'utf8')).trim() === 'Stop')
    const records = session.snapshotEvents().map(pluginRecordOf).filter(record => record !== undefined)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      type: 'plugin:dsh-notice-hooks/dispatch',
      data: {
        event: 'Stop',
        triggered: [{ scope: 'user', id: 'admitted' }],
        blocked: [{ scope: 'user', id: 'disabled', reason: 'configured-disabled' }],
      },
    })
    expect(session.surface.nodes).toEqual([])
  })

  it('executes SessionEnd Hooks without appending a notice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'session-end.log')
    await save(root, {
      SessionEnd: [{ hooks: [{
        id: 'cleanup',
        type: 'command',
        command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`,
        enabled: true,
      }] }],
    })
    const { ctx } = await boot(root)
    const session = Session.create(SessionId('session-end-notice'))

    emit(ctx, 'session/disposed', session)

    await eventually(async () => (await readFile(output, 'utf8')).trim() === 'SessionEnd')
    expect(session.snapshotEvents().map(pluginRecordOf).filter(record => record !== undefined)).toEqual([])
  })

  it('contains one hook failure and continues dispatching later hooks and events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'events.log')
    const append = `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`
    await save(root, {
      Stop: [{ hooks: [
        { id: 'bad', type: 'command', command: `${quote(join(root, 'missing-command'))}`, enabled: true },
        { id: 'good', type: 'command', command: append, enabled: true, maxConcurrent: 2 },
      ] }],
    })
    const { ctx } = await boot(root)
    ctx.logger.exporter({ export: () => { throw new Error('logger sink failed') } })
    const session = { id: 'session-2', header: { cwd: root } }

    emit(ctx, 'session/event', session, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await eventually(async () => (await readFile(output, 'utf8')).trim() === 'Stop')
    emit(ctx, 'session/event', session, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await eventually(async () => (await readFile(output, 'utf8')).trim().split('\n').length === 2)
  })

  it('fails closed and cancels an active Hook when the watched config becomes invalid', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const pidFile = join(root, 'invalid-config-pid')
    const command = `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(pidFile)}`
    await save(root, { Stop: [{ hooks: [{ id: 'linger-invalid', type: 'command', command, enabled: true }] }] })
    const { ctx } = await boot(root)

    emit(ctx, 'session/event', { id: 'session-invalid', header: { cwd: root } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await eventually(async () => Number.isInteger(Number((await readFile(pidFile, 'utf8')).trim())))
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    await writeFile(join(root, '.dsh', 'hook.json'), '{"version":1,"hooks":{"Stop":"invalid"}}\n')

    await eventually(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it('invalid user config 仅取消 user scope，后续 project hook 仍可运行', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-user-isolation-'))
    const project = join(root, 'project-a')
    roots.push(root)
    const pidFile = join(root, 'user.pid')
    const output = join(root, 'project.log')
    await save(root, { Stop: [{ hooks: [{ id: 'user-linger', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(pidFile)}`, enabled: true }] }] })
    await save(project, { Stop: [{ hooks: [{ id: 'project-append', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`, enabled: true }] }] })
    const workspace = { id: 'project-a', path: project, title: 'Project A' }
    const { ctx } = await boot(root, undefined, {
      get: () => workspace, list: () => [workspace], resolveByPath: async () => workspace,
    })
    const stop = { type: 'turn/end', data: { reason: { kind: 'complete' } } }
    emit(ctx, 'session/event', { id: 'before-invalid', header: { cwd: project } }, stop)
    await eventually(async () => Number.isInteger(Number((await readFile(pidFile, 'utf8')).trim())) && (await readFile(output, 'utf8')).trim() === 'Stop')
    const pid = Number((await readFile(pidFile, 'utf8')).trim())

    await writeFile(join(root, '.dsh', 'hook.json'), '{invalid')
    await eventually(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
    emit(ctx, 'session/event', { id: 'after-invalid', header: { cwd: project } }, stop)
    await eventually(async () => (await readFile(output, 'utf8')).trim().split('\n').length === 2)
  })

  it('clears remembered tool input when a session is disposed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'payload.json')
    const command = `${quote(process.execPath)} ${quote(fixture)} append-json ${quote(output)}`
    await save(root, { PostToolUse: [{ hooks: [{ id: 'result', type: 'command', command, enabled: true }] }] })
    const { ctx } = await boot(root)
    const session = { id: 'session-pairing', header: { cwd: root } }

    emit(ctx, 'session/event', session, {
      type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: '{"secret":true}' },
    })
    emit(ctx, 'session/disposed', session)
    emit(ctx, 'session/event', session, {
      type: 'tool/result', data: { callId: 'call-1', name: 'bash', message: { content: 'done' } },
    })

    await eventually(async () => (await readFile(output, 'utf8')).length > 0)
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: null,
    })
  })

  it('clears remembered tool input when the plugin unloads with a live session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    const output = join(root, 'reloaded-payload.json')
    const command = `${quote(process.execPath)} ${quote(fixture)} append-json ${quote(output)}`
    await save(root, { PostToolUse: [{ hooks: [{ id: 'reload-result', type: 'command', command, enabled: true }] }] })
    const first = await boot(root)
    const session = { id: 'session-reload-pairing', header: { cwd: root } }

    emit(first.ctx, 'session/event', session, {
      type: 'tool/call', data: { callId: 'call-reload', name: 'bash', arguments: '{"stale":true}' },
    })
    await first.fiber.dispose()

    const second = await boot(root)
    emit(second.ctx, 'session/event', session, {
      type: 'tool/result', data: { callId: 'call-reload', name: 'bash', message: { content: 'done' } },
    })
    await eventually(async () => (await readFile(output, 'utf8')).length > 0)
    expect(JSON.parse(await readFile(output, 'utf8')).tool_input).toBeNull()
  })

  it('layers registered workspace hooks and keeps first-observed ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    const project = join(root, 'project-a')
    const other = join(root, 'other')
    roots.push(root)
    await mkdir(other, { recursive: true })
    const userOutput = join(root, 'user-events.log')
    const projectOutput = join(root, 'project-events.log')
    const userCommand = `${quote(process.execPath)} ${quote(fixture)} append ${quote(userOutput)}`
    const projectCommand = `${quote(process.execPath)} ${quote(fixture)} append ${quote(projectOutput)}`
    await save(root, {
      SessionStart: [{ hooks: [{ id: 'user-start', type: 'command', command: userCommand, enabled: true }] }],
      Stop: [{ hooks: [{ id: 'user-stop', type: 'command', command: userCommand, enabled: true }] }],
    })
    await save(project, {
      SessionStart: [{ hooks: [{ id: 'project-start', type: 'command', command: projectCommand, enabled: true }] }],
      Stop: [{ hooks: [{ id: 'project-stop', type: 'command', command: projectCommand, enabled: true }] }],
    })
    const workspace = { id: 'project-a', path: project, title: 'Project A' }
    const { ctx } = await boot(root, undefined, {
      get: () => workspace, list: () => [workspace], resolveByPath: async (path: string) => path === project ? workspace : undefined,
    })

    emit(ctx, 'session/created', { id: 'registered', header: { cwd: project } })
    await eventually(async () => (await readFile(userOutput, 'utf8')).trim() === 'SessionStart' && (await readFile(projectOutput, 'utf8')).trim() === 'SessionStart')
    emit(ctx, 'session/event', { id: 'registered', header: { cwd: other } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await eventually(async () => (await readFile(userOutput, 'utf8')).trim().split('\n').length === 2 && (await readFile(projectOutput, 'utf8')).trim().split('\n').length === 2)
  })

  it('runs only user hooks for a registered workspace without project config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    const project = join(root, 'project-b')
    const output = join(root, 'user-events.log')
    roots.push(root)
    await mkdir(project, { recursive: true })
    await save(root, { Stop: [{ hooks: [{ id: 'user', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`, enabled: true }] }] })
    const workspace = { id: 'project-b', path: project, title: 'Project B' }
    const { ctx } = await boot(root, undefined, {
      get: () => workspace, list: () => [workspace], resolveByPath: async () => workspace,
    })

    emit(ctx, 'session/event', { id: 'empty-project', header: { cwd: project } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await eventually(async () => (await readFile(output, 'utf8')).trim() === 'Stop')
    await expect(access(join(project, '.dsh', 'hook.json'))).rejects.toThrow()
  })

  it.each([
    ['missing', null],
    ['malformed', {}],
  ] as const)('runs user Hooks when the Workspace Registry is %s', async (_name, workspaceRegistry) => {
    expect(NoticeHooks.inject).toEqual([])
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    const output = join(root, 'user-only.log')
    const cwd = join(root, 'unregistered-project')
    roots.push(root)
    await mkdir(cwd, { recursive: true })
    await save(root, { Stop: [{ hooks: [{ id: 'user', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`, enabled: true }] }] })
    const register = vi.fn((_registration: { handler: (req: object, res: object) => void }) => vi.fn())
    const { ctx } = await boot(root, { register, getOrigin: () => 'http://127.0.0.1:63736' }, workspaceRegistry)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ path: '/dsh-notice-hooks' }))
    const registration = register.mock.calls[0]?.[0] as unknown as { handler: (req: object, res: object) => void }
    const readStatus = async (): Promise<Record<string, unknown>> => new Promise((resolve) => {
      registration.handler({ method: 'GET', url: '/dsh-notice-hooks/status?scope=user', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:63736' } }, {
        writeHead: () => undefined,
        end: (body: string) => { resolve(JSON.parse(body) as Record<string, unknown>) },
      })
    })
    expect(await readStatus()).toMatchObject({ ok: true, value: { hooks: [{ id: 'user', enabled: true, authorized: true }] } })

    emit(ctx, 'session/event', { id: `user-only-${_name}`, header: { cwd } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await readStatus()).toMatchObject({ ok: true, value: { hooks: [{ stats: { lastStatus: 'completed' } }] } })
    await eventually(async () => (await readFile(output, 'utf8')).trim() === 'Stop')
  })

  it('runs only user hooks for an unregistered cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    const other = join(root, 'other')
    const output = join(root, 'user-events.log')
    roots.push(root)
    await mkdir(other, { recursive: true })
    await save(root, { Stop: [{ hooks: [{ id: 'user', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`, enabled: true }] }] })
    const { ctx } = await boot(root)

    emit(ctx, 'session/event', { id: 'unregistered', header: { cwd: other } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await eventually(async () => (await readFile(output, 'utf8')).trim() === 'Stop')
  })

  it('cancels only an invalid project scope and continues user hooks', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    const project = join(root, 'project-a')
    roots.push(root)
    const output = join(root, 'user-events.log')
    const pidFile = join(root, 'project.pid')
    const userCommand = `${quote(process.execPath)} ${quote(fixture)} append ${quote(output)}`
    await save(root, {
      Stop: [{ hooks: [{ id: 'user-stop', type: 'command', command: userCommand, enabled: true }] }],
      SessionStart: [{ hooks: [{ id: 'user-start', type: 'command', command: userCommand, enabled: true }] }],
    })
    await save(project, { Stop: [{ hooks: [{ id: 'project', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(pidFile)}`, enabled: true }] }] })
    const workspace = { id: 'project-a', path: project, title: 'Project A' }
    const { ctx } = await boot(root, undefined, {
      get: () => workspace, list: () => [workspace], resolveByPath: async () => workspace,
    })
    const session = { id: 'invalid-project', header: { cwd: project } }
    const stop = { type: 'turn/end', data: { reason: { kind: 'complete' } } }

    emit(ctx, 'session/event', session, stop)
    await eventually(async () => (await readFile(output, 'utf8')).trim() === 'Stop')
    await eventually(async () => Number.isInteger(Number((await readFile(pidFile, 'utf8')).trim())))
    const pid = Number((await readFile(pidFile, 'utf8')).trim())

    await writeFile(join(project, '.dsh', 'hook.json'), '{invalid')
    await eventually(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })

    emit(ctx, 'session/created', session)
    await eventually(async () => (await readFile(output, 'utf8')).trim().split('\n').sort().join(',') === 'SessionStart,Stop')
    expect(Number((await readFile(pidFile, 'utf8')).trim())).toBe(pid)
  })

  it('releases a workspace scope and cancels its process when the session is disposed', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    const project = join(root, 'project-a')
    roots.push(root)
    const pidFile = join(root, 'workspace.pid')
    await save(root, {})
    await save(project, { Stop: [{ hooks: [{ id: 'linger', type: 'command', command: `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(pidFile)}`, enabled: true }] }] })
    const workspace = { id: 'project-a', path: project, title: 'Project A' }
    let registered = true
    const { ctx } = await boot(root, undefined, {
      get: (id: string) => registered && id === workspace.id ? workspace : undefined,
      list: () => registered ? [workspace] : [],
      resolveByPath: async (path: string) => registered && path === project ? workspace : undefined,
    })
    const session = { id: 'workspace-session', header: { cwd: project } }
    emit(ctx, 'session/event', session, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await eventually(async () => Number.isInteger(Number((await readFile(pidFile, 'utf8')).trim())))
    const pid = Number((await readFile(pidFile, 'utf8')).trim())

    registered = false
    emit(ctx, 'session/disposed', session)
    await eventually(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
  })

  it('registers the optional web API as a disposable Cordis effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    roots.push(root)
    await save(root, {})
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const { fiber } = await boot(root, { register, getOrigin: () => 'http://127.0.0.1:63736' })

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'prefix', path: '/dsh-notice-hooks', handler: expect.any(Function),
    }))
    await fiber.dispose()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('cancels active hooks and releases resources on teardown', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-host-'))
    const project = join(root, 'project-a')
    roots.push(root)
    const pidFile = join(root, 'pid')
    const command = `${quote(process.execPath)} ${quote(fixture)} linger-file ${quote(pidFile)}`
    await save(root, {})
    await save(project, { Stop: [{ hooks: [{ id: 'linger', type: 'command', command, enabled: true }] }] })
    const workspace = { id: 'project-a', path: project, title: 'Project A' }
    const { ctx, fiber } = await boot(root, undefined, {
      get: () => workspace, list: () => [workspace], resolveByPath: async () => workspace,
    })

    emit(ctx, 'session/event', { id: 'session-3', header: { cwd: project } }, {
      type: 'turn/end', data: { reason: { kind: 'complete' } },
    })
    await eventually(async () => Number.isInteger(Number((await readFile(pidFile, 'utf8')).trim())))
    const pid = Number((await readFile(pidFile, 'utf8')).trim())

    await fiber.dispose()
    await eventually(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
  })
})
