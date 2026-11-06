import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ResolvedHook } from './config.js'
import { parseCommandLine } from './command.js'
import { serializePayload } from './payload.js'
import type { HookPayload } from './types.js'

const MAX_CAPTURE_BYTES = 64 * 1024
const FORCE_KILL_DELAY_MS = 250

type RunStatus = 'completed' | 'failed' | 'skipped' | 'timed-out' | 'cancelled' | 'spawn-error'

export interface HookRunResult {
  readonly runtimeId: string
  readonly hookId: string
  readonly status: RunStatus
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

export interface HookStats {
  readonly running: number
  readonly skipped: number
  readonly errors: number
  readonly lastStatus: RunStatus | null
}

export interface HookRunnerOptions {
  readonly spawn?: typeof nodeSpawn
  readonly logger?: {
    warn(message: string, error?: unknown): void
  }
  readonly platform?: NodeJS.Platform
}

export interface HookRunner {
  run(runtimeId: string, hook: ResolvedHook, payload: HookPayload): Promise<HookRunResult>
  cancel(id: string): void
  reconcile(enabledIds: ReadonlySet<string>): void
  stats(): Readonly<Record<string, HookStats>>
  dispose(): Promise<void>
}

interface MutableStats {
  running: number
  skipped: number
  errors: number
  lastStatus: RunStatus | null
}

interface ActiveRun {
  readonly runtimeId: string
  readonly hookId: string
  readonly child: ChildProcessWithoutNullStreams
  readonly promise: Promise<HookRunResult>
  timeout: NodeJS.Timeout | undefined
  forceKill: NodeJS.Timeout | undefined
  requestedStatus: 'timed-out' | 'cancelled' | undefined
}

function capturedText(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8')
}

function capture(chunks: Buffer[], chunk: Buffer | string): void {
  const currentBytes = chunks.reduce((total, value) => total + value.byteLength, 0)
  const remaining = MAX_CAPTURE_BYTES - currentBytes
  if (remaining <= 0) return
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  chunks.push(buffer.subarray(0, remaining))
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

export function createHookRunner(options: HookRunnerOptions = {}): HookRunner {
  const spawn = options.spawn ?? nodeSpawn
  const logger = options.logger ?? { warn: () => undefined }
  const platform = options.platform ?? process.platform
  const activeByHook = new Map<string, Set<ActiveRun>>()
  const statsByHook = new Map<string, MutableStats>()
  let disposed = false

  function state(id: string): MutableStats {
    let value = statsByHook.get(id)
    if (value === undefined) {
      value = { running: 0, skipped: 0, errors: 0, lastStatus: null }
      statsByHook.set(id, value)
    }
    return value
  }

  function runs(id: string): Set<ActiveRun> {
    let value = activeByHook.get(id)
    if (value === undefined) {
      value = new Set()
      activeByHook.set(id, value)
    }
    return value
  }

  function kill(active: ActiveRun, signal: NodeJS.Signals): void {
    const pid = active.child.pid
    if (pid === undefined) return
    if (platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
        })
        killer.on('error', error => logger.warn(`[dsh-notice-hooks] [${active.runtimeId}] ${active.hookId} taskkill failed`, error))
      } catch (error) {
        logger.warn(`[dsh-notice-hooks] [${active.runtimeId}] ${active.hookId} taskkill failed`, error)
      }
      return
    }

    try {
      process.kill(-pid, signal)
    } catch (groupError) {
      try {
        active.child.kill(signal)
      } catch (childError) {
        logger.warn(`[dsh-notice-hooks] [${active.runtimeId}] ${active.hookId} termination failed`, { groupError, childError })
      }
    }
  }

  function terminate(active: ActiveRun, status: 'timed-out' | 'cancelled'): void {
    if (active.requestedStatus !== undefined) return
    active.requestedStatus = status
    kill(active, 'SIGTERM')
    active.forceKill = setTimeout(() => kill(active, 'SIGKILL'), FORCE_KILL_DELAY_MS)
    active.forceKill.unref?.()
  }

  async function run(runtimeId: string, hook: ResolvedHook, payload: HookPayload): Promise<HookRunResult> {
    const currentStats = state(runtimeId)
    const currentRuns = runs(runtimeId)
    if (disposed || !hook.enabled || currentRuns.size >= hook.maxConcurrent) {
      currentStats.skipped += 1
      currentStats.lastStatus = 'skipped'
      return {
        runtimeId,
        hookId: hook.id,
        status: 'skipped',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
      }
    }

    let argv: readonly [string, ...string[]]
    let input: string
    try {
      argv = parseCommandLine(hook.command)
      input = serializePayload(payload)
    } catch (error) {
      currentStats.errors += 1
      currentStats.lastStatus = 'spawn-error'
      logger.warn(`[dsh-notice-hooks] [${runtimeId}] ${hook.id} command preparation failed`, error)
      return {
        runtimeId,
        hookId: hook.id,
        status: 'spawn-error',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: errorText(error),
      }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(argv[0], argv.slice(1), {
        shell: false,
        detached: platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(payload.cwd === null ? {} : { cwd: payload.cwd }),
      })
    } catch (error) {
      currentStats.errors += 1
      currentStats.lastStatus = 'spawn-error'
      logger.warn(`[dsh-notice-hooks] [${runtimeId}] ${hook.id} spawn failed`, error)
      return {
        runtimeId,
        hookId: hook.id,
        status: 'spawn-error',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: errorText(error),
      }
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let resolveResult!: (value: HookRunResult) => void
    const promise = new Promise<HookRunResult>(resolve => { resolveResult = resolve })
    const active: ActiveRun = {
      runtimeId,
      hookId: hook.id,
      child,
      promise,
      timeout: undefined,
      forceKill: undefined,
      requestedStatus: undefined,
    }
    currentRuns.add(active)
    currentStats.running = currentRuns.size
    let finalized = false

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: unknown): void => {
      if (finalized) return
      finalized = true
      if (active.timeout !== undefined) clearTimeout(active.timeout)
      if (active.forceKill !== undefined) clearTimeout(active.forceKill)
      currentRuns.delete(active)
      if (currentRuns.size === 0) activeByHook.delete(runtimeId)
      currentStats.running = currentRuns.size

      let status: RunStatus
      if (active.requestedStatus !== undefined) status = active.requestedStatus
      else if (spawnError !== undefined) status = 'spawn-error'
      else status = exitCode === 0 ? 'completed' : 'failed'
      currentStats.lastStatus = status
      if (status === 'failed' || status === 'spawn-error' || status === 'timed-out') currentStats.errors += 1

      const result: HookRunResult = {
        runtimeId,
        hookId: hook.id,
        status,
        exitCode,
        signal,
        stdout: capturedText(stdout),
        stderr: capturedText(stderr),
        ...(spawnError === undefined ? {} : { error: errorText(spawnError) }),
      }
      if (status === 'failed' || status === 'spawn-error' || status === 'timed-out') {
        logger.warn(`[dsh-notice-hooks] [${runtimeId}] ${hook.id} finished with ${status}`, result)
      }
      resolveResult(result)
    }

    child.stdout.on('data', chunk => capture(stdout, chunk))
    child.stderr.on('data', chunk => capture(stderr, chunk))
    child.stdout.on('error', error => logger.warn(`[dsh-notice-hooks] [${runtimeId}] ${hook.id} stdout stream error`, error))
    child.stderr.on('error', error => logger.warn(`[dsh-notice-hooks] [${runtimeId}] ${hook.id} stderr stream error`, error))
    child.stdin.on('error', error => logger.warn(`[dsh-notice-hooks] [${runtimeId}] ${hook.id} stdin stream error`, error))
    child.once('error', error => finalize(null, null, error))
    child.once('close', (exitCode, signal) => finalize(exitCode, signal))

    active.timeout = setTimeout(() => terminate(active, 'timed-out'), hook.timeoutMs)
    active.timeout.unref?.()
    try {
      child.stdin.end(input)
    } catch (error) {
      logger.warn(`[dsh-notice-hooks] [${runtimeId}] ${hook.id} stdin write failed`, error)
    }
    return promise
  }

  function cancel(id: string): void {
    const current = activeByHook.get(id)
    if (current === undefined) return
    for (const active of [...current]) terminate(active, 'cancelled')
  }

  function reconcile(enabledIds: ReadonlySet<string>): void {
    for (const id of activeByHook.keys()) {
      if (!enabledIds.has(id)) cancel(id)
    }
  }

  function stats(): Readonly<Record<string, HookStats>> {
    const result: Record<string, HookStats> = {}
    for (const [id, value] of statsByHook) result[id] = { ...value }
    return result
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    const pending = [...activeByHook.values()].flatMap(value => [...value].map(active => active.promise))
    for (const id of [...activeByHook.keys()]) cancel(id)
    await Promise.all(pending)
    activeByHook.clear()
    statsByHook.clear()
  }

  return { run, cancel, reconcile, stats, dispose }
}
