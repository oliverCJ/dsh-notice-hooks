import { describe, expect, it } from 'vitest'
import {
  classifySessionEvent,
  cleanupSessionEventState,
  matchInvocation,
  sessionCreatedInvocation,
  sessionDisposedInvocation,
} from '../src/events.ts'
import type { SessionLike } from '../src/types.ts'

function rootSession(overrides: Partial<SessionLike> = {}): SessionLike {
  return {
    id: 'session-1',
    header: {
      cwd: '/workspace',
      origin: 'web',
      agentId: 'agent-1',
      agentPreset: 'main',
      createdAt: 1_762_229_600_000,
    },
    ...overrides,
  }
}

function event(type: string, data: Record<string, unknown>, time = 1_762_229_600_000) {
  return { type, time, data }
}

describe('session lifecycle classification', () => {
  it('splits root and child session creation and disposal', () => {
    const root = rootSession({ disposalReason: 'closed' })
    const child = rootSession({
      id: 'session-2',
      header: {
        cwd: '/workspace',
        origin: 'subagent',
        parentSession: 'session-1',
        agentId: 'agent-2',
        agentPreset: 'researcher',
      },
    })

    expect(sessionCreatedInvocation(root)).toMatchObject({ event: 'SessionStart', matcherValue: 'web' })
    expect(sessionCreatedInvocation(child)).toMatchObject({ event: 'SubagentStart', matcherValue: 'researcher' })
    expect(sessionDisposedInvocation(root)).toMatchObject({
      event: 'SessionEnd',
      matcherValue: 'closed',
      payload: { reason: 'closed' },
    })
    expect(sessionDisposedInvocation(child)).toMatchObject({ event: 'SubagentStop', matcherValue: 'researcher' })
  })
})

describe('session event classification', () => {
  it('maps a direct user prompt but ignores plugin-origin messages', () => {
    const session = rootSession()
    const direct = classifySessionEvent(session, event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Run tests' }],
    }))
    const plugin = classifySessionEvent(session, event('user/message', {
      source: { kind: 'plugin', plugin: 'fixture' },
      content: [{ type: 'text', text: 'internal' }],
    }))

    expect(direct).toMatchObject({
      event: 'UserPromptSubmit',
      matcherValue: 'user',
      payload: { prompt: 'Run tests' },
    })
    expect(plugin).toBeUndefined()
  })

  it('pairs tool calls with successful and failed results', () => {
    const session = rootSession()
    const before = classifySessionEvent(session, event('tool/call', {
      turn: 2,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"command":"pwd"}',
    }))
    const success = classifySessionEvent(session, event('tool/result', {
      turn: 2,
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: '/workspace' }],
      },
    }))

    classifySessionEvent(session, event('tool/call', {
      turn: 2,
      callId: 'call-2',
      name: 'write',
      arguments: '{"path":"x"}',
    }))
    const failure = classifySessionEvent(session, event('tool/result', {
      turn: 2,
      error: { name: 'Error', code: 'EACCES', reason: 'denied' },
      message: {
        source: { kind: 'tool', callId: 'call-2' },
        content: [{ type: 'text', text: 'failed' }],
        isError: true,
      },
    }))

    expect(before).toMatchObject({
      event: 'PreToolUse',
      matcherValue: 'bash',
      payload: { turn_id: '2', tool_name: 'bash', tool_use_id: 'call-1', tool_input: { command: 'pwd' } },
    })
    expect(success).toMatchObject({
      event: 'PostToolUse',
      matcherValue: 'bash',
      payload: { tool_name: 'bash', tool_use_id: 'call-1', tool_response: [{ type: 'text', text: '/workspace' }] },
    })
    expect(failure).toMatchObject({
      event: 'PostToolUseFailure',
      matcherValue: 'write',
      payload: { tool_name: 'write', error: 'Error: EACCES: denied' },
    })
  })

  it('uses the tool result error flag when no error detail is available', () => {
    const session = rootSession()
    classifySessionEvent(session, event('tool/call', {
      turn: 2,
      callId: 'call-failed',
      name: 'read',
      arguments: '{}',
    }))

    const result = classifySessionEvent(session, event('tool/result', {
      turn: 2,
      message: {
        source: { kind: 'tool', callId: 'call-failed' },
        content: [{ type: 'text', text: 'failed without details' }],
        isError: true,
      },
    }))

    expect(result).toMatchObject({
      event: 'PostToolUseFailure',
      matcherValue: 'read',
      payload: { tool_name: 'read', error: null },
    })
  })

  it('maps permission and turn completion events with the latest assistant text', () => {
    const session = rootSession()
    expect(classifySessionEvent(session, event('assistant/message', {
      turn: 3,
      message: { content: [{ type: 'text', text: 'Finished.' }] },
    }))).toBeUndefined()
    const permission = classifySessionEvent(session, event('approval/asked', {
      id: 'approval-1',
      toolName: 'bash',
      callId: 'call-1',
      reason: 'requires permission',
    }))
    const stop = classifySessionEvent(session, event('turn/end', {
      turn: 3,
      reason: { kind: 'completed' },
    }))
    const failed = classifySessionEvent(session, event('turn/end', {
      turn: 4,
      reason: { kind: 'error', error: { message: 'provider unavailable', code: 'UPSTREAM' } },
    }))

    expect(permission).toMatchObject({
      event: 'PermissionRequest',
      matcherValue: 'bash',
      payload: { tool_name: 'bash', tool_use_id: 'call-1', reason: 'requires permission' },
    })
    expect(stop).toMatchObject({
      event: 'Stop',
      matcherValue: 'completed',
      payload: { turn_id: '3', last_assistant_message: 'Finished.', reason: 'completed' },
    })
    expect(failed).toMatchObject({
      event: 'StopFailure',
      matcherValue: 'error',
      payload: { turn_id: '4', reason: 'error', error: 'provider unavailable' },
    })
  })

  it('maps automatic and manual compaction lifecycle events', () => {
    const session = rootSession()
    expect(classifySessionEvent(session, event('compaction/start', { compactionId: 'auto-1', turn: 3 }))).toMatchObject({
      event: 'PreCompact', matcherValue: 'automatic',
      payload: { compaction_id: 'auto-1', source_command_id: null, turn_id: '3', reason: 'automatic', error: null },
    })
    expect(classifySessionEvent(session, event('compaction/start', { compactionId: 'manual-1', turn: null, sourceCommandId: 'compact-command' }))).toMatchObject({
      event: 'PreCompact', matcherValue: 'manual',
      payload: { compaction_id: 'manual-1', source_command_id: 'compact-command', turn_id: null, reason: 'manual', error: null },
    })
    expect(classifySessionEvent(session, event('compaction/end', { compactionId: 'auto-1', turn: 3 }))).toMatchObject({
      event: 'PostCompact', matcherValue: 'automatic', payload: { compaction_id: 'auto-1', error: null },
    })
    expect(classifySessionEvent(session, event('compaction/end', { compactionId: 'manual-1', turn: null, sourceCommandId: 'compact-command', error: 'summary failed' }))).toMatchObject({
      event: 'PostCompactFailure', matcherValue: 'manual', payload: { compaction_id: 'manual-1', source_command_id: 'compact-command', error: 'summary failed' },
    })
  })

  it('rejects malformed and intermediate compaction events', () => {
    const session = rootSession()
    for (const value of [
      event('compaction/start', { turn: 1 }),
      event('compaction/start', { compactionId: '', turn: 1 }),
      event('compaction/start', { compactionId: '   ', turn: 1 }),
      event('compaction/start', { compactionId: 'c', turn: 1, sourceCommandId: '   ' }),
      event('compaction/start', { compactionId: 'c', turn: 1, error: 'unexpected' }),
      event('compaction/start', { compactionId: 'c', turn: 1, error: 123 }),
      event('compaction/end', { compactionId: 'c', turn: 1, error: '   ' }),
      event('compaction/start', { compactionId: 'c', turn: -1 }),
      event('compaction/start', { compactionId: 'c', turn: '1' }),
      event('compaction/summary', { compactionId: 'c' }),
      event('compaction/prune', { shadowedTokenCount: 1 }),
    ]) expect(classifySessionEvent(session, value)).toBeUndefined()
    expect(classifySessionEvent(session, event('compaction/end', { compactionId: 'c', turn: 1, sourceCommandId: '', error: '' }))).toMatchObject({
      event: 'PostCompact', matcherValue: 'automatic', payload: { source_command_id: null, error: null },
    })
  })

  it('ignores unknown or malformed event data', () => {
    expect(classifySessionEvent(rootSession(), event('step/start', { turn: 1 }))).toBeUndefined()
    expect(classifySessionEvent(rootSession(), { type: 'tool/call', data: null })).toBeUndefined()
    expect(classifySessionEvent(rootSession(), null)).toBeUndefined()
  })
})

describe('matching and cleanup', () => {
  it('matches exactly the invocation matcher value case-insensitively', () => {
    const invocation = sessionCreatedInvocation(rootSession())
    expect(matchInvocation(invocation, /^WEB$/i)).toBe(true)
    expect(matchInvocation(invocation, /^we$/i)).toBe(false)
  })

  it('drops remembered tool calls and assistant text when a session is cleaned up', () => {
    const session = rootSession()
    classifySessionEvent(session, event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'stale response' }] },
    }))
    classifySessionEvent(session, event('tool/call', {
      turn: 1,
      callId: 'call-1',
      name: 'bash',
      arguments: '{}',
    }))
    cleanupSessionEventState(session)

    const result = classifySessionEvent(session, event('tool/result', {
      turn: 1,
      message: { source: { kind: 'tool', callId: 'call-1' }, content: [] },
    }))
    const stop = classifySessionEvent(session, event('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    }))
    expect(result).toMatchObject({ matcherValue: '', payload: { tool_name: null } })
    expect(stop).toMatchObject({ payload: { last_assistant_message: null } })
  })
})
