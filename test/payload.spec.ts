import { describe, expect, it } from 'vitest'
import { serializePayload } from '../src/payload.ts'
import type { HookPayload } from '../src/types.ts'

const completePayload: HookPayload = {
  schema_version: 1,
  source: 'deepseek-harness',
  hook_event_name: 'PreToolUse',
  session_id: 'session-1',
  cwd: '/workspace',
  timestamp: '2026-11-04T04:00:00.000Z',
  turn_id: '1',
  agent_id: 'agent-1',
  agent_type: 'main',
  tool_name: 'bash',
  tool_use_id: 'call-1',
  tool_input: { command: 'pwd', flags: ['-P'] },
  tool_response: null,
  prompt: null,
  last_assistant_message: null,
  reason: null,
  error: null,
  compaction_id: null,
  source_command_id: null,
}

describe('serializePayload', () => {
  it('emits the complete stable snake_case object and one trailing newline', () => {
    const serialized = serializePayload(completePayload)

    expect(serialized.endsWith('\n')).toBe(true)
    expect(serialized.endsWith('\n\n')).toBe(false)
    const parsed = JSON.parse(serialized)
    expect(parsed).toEqual(completePayload)
    expect(Object.keys(parsed)).toEqual([
      'schema_version', 'source', 'hook_event_name', 'session_id', 'cwd', 'timestamp', 'turn_id', 'agent_id', 'agent_type',
      'tool_name', 'tool_use_id', 'tool_input', 'tool_response', 'prompt', 'last_assistant_message', 'reason', 'error',
      'compaction_id', 'source_command_id',
    ])
  })

  it('preserves structured tool input and response', () => {
    const serialized = serializePayload({
      ...completePayload,
      tool_response: { ok: true, content: [{ type: 'text', text: 'done' }] },
    })

    expect(JSON.parse(serialized)).toMatchObject({
      tool_input: { command: 'pwd', flags: ['-P'] },
      tool_response: { ok: true, content: [{ type: 'text', text: 'done' }] },
    })
  })

  it('normalizes circular values without throwing', () => {
    const circular: Record<string, unknown> = { label: 'root' }
    circular.self = circular

    const parsed = JSON.parse(serializePayload({ ...completePayload, tool_input: circular }))
    expect(parsed.tool_input).toEqual({ label: 'root', self: '[Circular]' })
  })

  it('bounds oversized multibyte text and the complete UTF-8 payload', () => {
    const huge = '界'.repeat(200_000)
    const serialized = serializePayload({
      ...completePayload,
      prompt: huge,
      last_assistant_message: huge,
      tool_input: { huge },
      tool_response: { huge },
      error: huge,
    })

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(128 * 1024)
    expect(() => JSON.parse(serialized)).not.toThrow()
    expect(serialized.endsWith('\n')).toBe(true)
  })
})
