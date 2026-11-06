import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedHook } from '../src/config.ts'
import { createHookRunner } from '../src/runner.ts'
import { encodeHookRuntimeId } from '../src/scope-manager.ts'
import type { HookPayload } from '../src/types.ts'

const fixture = fileURLToPath(new URL('./fixtures/child-process.mjs', import.meta.url))
const runners: Array<ReturnType<typeof createHookRunner>> = []

function quote(value: string): string {
  return JSON.stringify(value)
}

function hook(id: string, mode: string, overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return {
    event: 'PreToolUse',
    matcherSource: '',
    matcher: /(?:)/i,
    id,
    type: 'command',
    command: `${quote(process.execPath)} ${quote(fixture)} ${mode}`,
    enabled: true,
    timeoutMs: 5_000,
    maxConcurrent: 1,
    ...overrides,
  }
}

function payload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    schema_version: 1,
    source: 'deepseek-harness',
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    cwd: process.cwd(),
    timestamp: '2026-11-04T04:00:00.000Z',
    turn_id: '1',
    agent_id: 'agent-1',
    agent_type: 'main',
    tool_name: 'bash',
    tool_use_id: 'call-1',
    tool_input: { command: 'pwd' },
    tool_response: null,
    prompt: null,
    last_assistant_message: null,
    reason: null,
    error: null,
    compaction_id: null,
    source_command_id: null,
    ...overrides,
  }
}

function runner(options: Parameters<typeof createHookRunner>[0] = {}) {
  const value = createHookRunner(options)
  runners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
  vi.restoreAllMocks()
})

describe('process spawning and bounded I/O', () => {
  it('spawns without a shell and writes exactly one newline-terminated payload', async () => {
    const spawnSpy = vi.fn(spawn)
    const value = runner({ spawn: spawnSpy as unknown as typeof spawn })
    const result = await value.run('stdin', hook('stdin', 'stdin'), payload())

    expect(spawnSpy).toHaveBeenCalledOnce()
    expect(spawnSpy).toHaveBeenCalledWith(process.execPath, [fixture, 'stdin'], {
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })
    expect(result.status).toBe('completed')
    expect(JSON.parse(result.stdout)).toMatchObject({ hook_event_name: 'PreToolUse', session_id: 'session-1' })
    expect(result.stdout.endsWith('\n')).toBe(true)
    expect(result.stdout.endsWith('\n\n')).toBe(false)
  })

  it('retains at most 64 KiB from each stream while draining the rest', async () => {
    const result = await runner().run('output', hook('output', 'output'), payload())

    expect(result.status).toBe('completed')
    expect(Buffer.byteLength(result.stdout)).toBe(64 * 1024)
    expect(Buffer.byteLength(result.stderr)).toBe(64 * 1024)
  })

  it('contains spawn and non-zero exit failures and logs diagnostics', async () => {
    const logger = { warn: vi.fn() }
    const failedSpawn = runner({
      logger,
      spawn: (() => { throw new Error('spawn denied') }) as typeof spawn,
    })
    const spawnResult = await failedSpawn.run('spawn-error', hook('spawn-error', 'stdin'), payload())
    const exitResult = await runner({ logger }).run('exit', hook('exit', 'exit'), payload())

    expect(spawnResult.status).toBe('spawn-error')
    expect(exitResult).toMatchObject({ status: 'failed', exitCode: 7, stderr: 'intentional failure' })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('contains stream errors without rejecting the run', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.pid = 12345
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const logger = { warn: vi.fn() }
    const value = runner({ logger, spawn: (() => child) as unknown as typeof spawn })
    const pending = value.run('stream', hook('stream', 'stdin'), payload())

    child.stdout.emit('error', new Error('read failed'))
    child.emit('close', 0, null)

    await expect(pending).resolves.toMatchObject({ status: 'completed' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stream'), expect.anything())
  })
})

describe('concurrency and lifecycle', () => {
  it('isolates same display ID concurrency and stats by runtime ID', async () => {
    const value = runner()
    const userRuntimeId = encodeHookRuntimeId('user', 'shared')
    const projectRuntimeId = encodeHookRuntimeId('workspace:project', 'shared')
    const user = value.run(userRuntimeId, hook('shared', 'linger'), payload())
    const project = value.run(projectRuntimeId, hook('shared', 'linger'), payload())
    const skipped = await value.run(userRuntimeId, hook('shared', 'linger'), payload())

    expect(skipped).toMatchObject({ hookId: 'shared', runtimeId: userRuntimeId, status: 'skipped' })
    expect(value.stats()).toMatchObject({
      [userRuntimeId]: { running: 1, skipped: 1 },
      [projectRuntimeId]: { running: 1, skipped: 0 },
    })

    value.cancel(userRuntimeId)
    await expect(user).resolves.toMatchObject({ runtimeId: userRuntimeId, status: 'cancelled' })
    expect(value.stats()[projectRuntimeId]?.running).toBe(1)
    value.cancel(projectRuntimeId)
    await project
  })

  it('reconcile cancels only a disabled runtime ID for same display IDs', async () => {
    const value = runner()
    const userRuntimeId = encodeHookRuntimeId('user', 'shared')
    const projectRuntimeId = encodeHookRuntimeId('workspace:project', 'shared')
    const user = value.run(userRuntimeId, hook('shared', 'linger'), payload())
    const project = value.run(projectRuntimeId, hook('shared', 'linger'), payload())

    value.reconcile(new Set([projectRuntimeId]))

    await expect(user).resolves.toMatchObject({ runtimeId: userRuntimeId, status: 'cancelled' })
    expect(value.stats()[projectRuntimeId]?.running).toBe(1)
    value.cancel(projectRuntimeId)
    await project
  })

  it('skips above maxConcurrent and releases the slot after cancellation', async () => {
    const value = runner()
    const first = value.run('limited', hook('limited', 'linger'), payload())
    const skipped = await value.run('limited', hook('limited', 'linger'), payload())

    expect(skipped.status).toBe('skipped')
    expect(value.stats().limited?.running).toBe(1)
    value.cancel('limited')
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(value.stats().limited?.running).toBe(0)
  })

  it('tracks independent stable IDs and reconcile cancels only disabled IDs', async () => {
    const value = runner()
    const first = value.run('first', hook('first', 'linger'), payload())
    const second = value.run('second', hook('second', 'linger'), payload())

    expect(value.stats()).toMatchObject({ first: { running: 1 }, second: { running: 1 } })
    value.reconcile(new Set(['second']))
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(value.stats().second?.running).toBe(1)
    value.cancel('second')
    await second
  })

  it('times out a hook, terminates it, and releases its slot', async () => {
    const value = runner()
    const result = await value.run('timeout', hook('timeout', 'linger', { timeoutMs: 100 }), payload())

    expect(result.status).toBe('timed-out')
    expect(value.stats().timeout?.running).toBe(0)
  })

  it('dispose terminates every active hook and clears state', async () => {
    const value = runner()
    const first = value.run('first', hook('first', 'linger'), payload())
    const second = value.run('second', hook('second', 'linger'), payload())

    await value.dispose()
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    await expect(second).resolves.toMatchObject({ status: 'cancelled' })
    expect(value.stats()).toEqual({})
  })
})

describe('process-tree termination', () => {
  it.runIf(process.platform !== 'win32')('kills a POSIX process group on timeout', async () => {
    const result = await runner().run('tree', hook('tree', 'tree', { timeoutMs: 200 }), payload())
    const descendantPid = Number.parseInt(result.stdout.trim(), 10)

    expect(result.status).toBe('timed-out')
    expect(descendantPid).toBeGreaterThan(0)
    await expect.poll(() => {
      try {
        process.kill(descendantPid, 0)
        return false
      } catch {
        return true
      }
    }, { timeout: 3_000 }).toBe(true)
  })
})
