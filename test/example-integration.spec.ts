import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_EVENTS, parseHookConfig, type ResolvedHook } from '../src/config.ts'
import { createHookRunner } from '../src/runner.ts'
import type { HookPayload } from '../src/types.ts'

const captureScript = fileURLToPath(new URL('../examples/capture-hook.mjs', import.meta.url))
const exampleConfig = fileURLToPath(new URL('../examples/hook.json', import.meta.url))
const temporaryDirectories: string[] = []
const runners: Array<ReturnType<typeof createHookRunner>> = []

const payload: HookPayload = {
  schema_version: 1,
  source: 'deepseek-harness',
  hook_event_name: 'Stop',
  session_id: 'session-example',
  cwd: process.cwd(),
  timestamp: '2026-11-04T06:00:00.000Z',
  turn_id: 'turn-example',
  agent_id: 'agent-example',
  agent_type: 'main',
  tool_name: null,
  tool_use_id: null,
  tool_input: null,
  tool_response: null,
  prompt: null,
  last_assistant_message: 'Finished.',
  reason: 'completed',
  error: null,
  compaction_id: null,
  source_command_id: null,
}

function quote(value: string): string {
  return JSON.stringify(value)
}

async function outputPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-notice-hooks-example-'))
  temporaryDirectories.push(directory)
  return join(directory, 'capture.json')
}

async function runDirect(path: string): Promise<void> {
  const child = spawn(process.execPath, [captureScript, path], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(`${JSON.stringify(payload)}\n`)
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`capture exited ${String(code)}`)))
  })
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('capture Hook example', () => {
  it('ships disabled examples for every supported event', async () => {
    const document = JSON.parse(await readFile(exampleConfig, 'utf8')) as { hooks: Record<string, unknown> }
    const parsed = parseHookConfig(document)

    expect(Object.keys(document.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    expect(parsed.hooks).toHaveLength(HOOK_EVENTS.length)
    expect(parsed.hooks.every(hook => !hook.enabled)).toBe(true)
  })

  it('atomically captures the exact stdin JSON when launched directly', async () => {
    const path = await outputPath()
    await runDirect(path)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(payload)
  })

  it('works through the real command parser and Hook runner', async () => {
    const path = await outputPath()
    const runner = createHookRunner()
    runners.push(runner)
    const hook: ResolvedHook = {
      event: 'Stop',
      matcherSource: '',
      matcher: /(?:)/i,
      id: 'capture-example',
      type: 'command',
      command: `${quote(process.execPath)} ${quote(captureScript)} ${quote(path)}`,
      enabled: true,
      timeoutMs: 5_000,
      maxConcurrent: 1,
    }

    const result = await runner.run('capture-example', hook, payload)

    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ status: 'completed' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(payload)
  })
})
