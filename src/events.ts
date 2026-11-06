import type { HookEvent } from './config.js'
import type { HookInvocation, HookPayload, SessionLike } from './types.js'

interface ToolCallState {
  readonly name: string
  readonly input: unknown
}

const toolCalls = new Map<string, ToolCallState>()
const lastAssistantMessages = new Map<string, string>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function identity(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return null
}

function sessionId(session: SessionLike): string {
  return String(session.id)
}

function isChildSession(session: SessionLike): boolean {
  return session.header?.origin === 'subagent' || session.header?.parentSession !== undefined
}

function timestamp(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

function payload(
  session: SessionLike,
  event: HookEvent,
  time: unknown,
  fields: Partial<Omit<HookPayload, 'schema_version' | 'source' | 'hook_event_name' | 'session_id' | 'cwd' | 'timestamp'>> = {},
): HookPayload {
  const child = isChildSession(session)
  return {
    schema_version: 1,
    source: 'deepseek-harness',
    hook_event_name: event,
    session_id: sessionId(session),
    cwd: text(session.header?.cwd),
    timestamp: timestamp(time),
    turn_id: null,
    agent_id: identity(session.header?.agentId),
    agent_type: text(session.header?.agentPreset) ?? (child ? 'subagent' : 'main'),
    tool_name: null,
    tool_use_id: null,
    tool_input: null,
    tool_response: null,
    prompt: null,
    last_assistant_message: lastAssistantMessages.get(sessionId(session)) ?? null,
    reason: null,
    error: null,
    compaction_id: null,
    source_command_id: null,
    ...fields,
  }
}

function invocation(
  session: SessionLike,
  event: HookEvent,
  matcherValue: string,
  time: unknown,
  fields?: Parameters<typeof payload>[3],
): HookInvocation {
  return { event, matcherValue, payload: payload(session, event, time, fields) }
}

function sourceKind(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (isRecord(value)) return text(value.kind)
  return null
}

function textBlocks(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const parts: string[] = []
  for (const block of value) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function callKey(session: SessionLike, callId: string): string {
  return `${sessionId(session)}\0${callId}`
}

function callIdFromResult(data: Record<string, unknown>): string | null {
  const direct = identity(data.callId)
  if (direct !== null) return direct
  if (!isRecord(data.message) || !isRecord(data.message.source)) return null
  return identity(data.message.source.callId)
}

function formatError(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return value === undefined || value === null ? null : String(value)
  const name = text(value.name)
  const code = identity(value.code)
  const reason = text(value.reason) ?? text(value.message)
  const parts = [name, code, reason].filter((part): part is string => part !== null && part.length > 0)
  return parts.length > 0 ? parts.join(': ') : JSON.stringify(value)
}

function reasonRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function compactionInvocation(session: SessionLike, type: 'start' | 'end', data: Record<string, unknown>, time: unknown): HookInvocation | undefined {
  if (type === 'start' && data.error !== undefined) return undefined
  const compactionId = text(data.compactionId)
  if (compactionId === null || compactionId.trim().length === 0) return undefined
  const turn = data.turn
  if (!(turn === null || (Number.isSafeInteger(turn) && Number(turn) >= 0))) return undefined
  const sourceCommandId = text(data.sourceCommandId)
  if (data.sourceCommandId !== undefined && sourceCommandId === null) return undefined
  if (sourceCommandId !== null && sourceCommandId.length > 0 && sourceCommandId.trim().length === 0) return undefined
  const manual = sourceCommandId !== null && sourceCommandId.length > 0
  const reason = manual ? 'manual' : 'automatic'
  const error = type === 'end' ? text(data.error) : null
  if (type === 'end' && data.error !== undefined && error === null) return undefined
  if (error !== null && error.length > 0 && error.trim().length === 0) return undefined
  const event: HookEvent = type === 'start'
    ? 'PreCompact'
    : error !== null && error.length > 0 ? 'PostCompactFailure' : 'PostCompact'
  return invocation(session, event, reason, time, {
    turn_id: turn === null ? null : String(turn),
    reason,
    error: error !== null && error.length > 0 ? error : null,
    compaction_id: compactionId,
    source_command_id: manual ? sourceCommandId : null,
  })
}

export function sessionCreatedInvocation(session: SessionLike): HookInvocation {
  if (isChildSession(session)) {
    const preset = text(session.header?.agentPreset) ?? 'subagent'
    return invocation(session, 'SubagentStart', preset, session.header?.createdAt)
  }
  const origin = text(session.header?.origin) ?? ''
  return invocation(session, 'SessionStart', origin, session.header?.createdAt)
}

export function sessionDisposedInvocation(session: SessionLike): HookInvocation {
  if (isChildSession(session)) {
    const preset = text(session.header?.agentPreset) ?? 'subagent'
    return invocation(session, 'SubagentStop', preset, undefined, { reason: text(session.disposalReason) })
  }
  const reason = text(session.disposalReason)
  return invocation(session, 'SessionEnd', reason ?? '', undefined, { reason })
}

export function classifySessionEvent(session: SessionLike, eventValue: unknown): HookInvocation | undefined {
  if (!isRecord(eventValue) || typeof eventValue.type !== 'string' || !isRecord(eventValue.data)) return undefined
  const data = eventValue.data
  const time = eventValue.time

  switch (eventValue.type) {
    case 'assistant/message': {
      if (!isRecord(data.message)) return undefined
      const content = textBlocks(data.message.content)
      if (content !== null) lastAssistantMessages.set(sessionId(session), content)
      return undefined
    }
    case 'user/message': {
      const source = sourceKind(data.source)
      if (source !== 'user') return undefined
      return invocation(session, 'UserPromptSubmit', source, time, { prompt: textBlocks(data.content) })
    }
    case 'tool/call': {
      const callId = identity(data.callId)
      const name = text(data.name)
      if (callId === null || name === null) return undefined
      const input = parseToolInput(data.arguments)
      toolCalls.set(callKey(session, callId), { name, input })
      return invocation(session, 'PreToolUse', name, time, {
        turn_id: identity(data.turn),
        tool_name: name,
        tool_use_id: callId,
        tool_input: input,
      })
    }
    case 'tool/result': {
      const callId = callIdFromResult(data)
      if (callId === null) return undefined
      const remembered = toolCalls.get(callKey(session, callId))
      toolCalls.delete(callKey(session, callId))
      const name = remembered?.name ?? text(data.name)
      const failure = formatError(data.error)
      const message = isRecord(data.message) ? data.message : undefined
      const event: HookEvent = message?.isError === true || failure !== null ? 'PostToolUseFailure' : 'PostToolUse'
      return invocation(session, event, name ?? '', time, {
        turn_id: identity(data.turn),
        tool_name: name,
        tool_use_id: callId,
        tool_input: remembered?.input ?? null,
        tool_response: message?.content ?? data.response ?? null,
        error: failure,
      })
    }
    case 'approval/asked': {
      const name = text(data.toolName) ?? text(data.type)
      if (name === null) return undefined
      return invocation(session, 'PermissionRequest', name, time, {
        tool_name: name,
        tool_use_id: identity(data.callId),
        reason: text(data.reason),
      })
    }
    case 'compaction/start':
      return compactionInvocation(session, 'start', data, time)
    case 'compaction/end':
      return compactionInvocation(session, 'end', data, time)
    case 'turn/end': {
      const reason = reasonRecord(data.reason)
      const kind = text(reason?.kind)
      if (kind === null) return undefined
      const event: HookEvent = kind === 'error' ? 'StopFailure' : 'Stop'
      const turnError = reason !== undefined && isRecord(reason.error)
        ? text(reason.error.message) ?? formatError(reason.error)
        : formatError(reason?.error)
      return invocation(session, event, kind, time, {
        turn_id: identity(data.turn),
        reason: kind,
        error: kind === 'error' ? turnError : null,
      })
    }
    default:
      return undefined
  }
}

export function matchInvocation(invocationValue: HookInvocation, matcher: RegExp): boolean {
  matcher.lastIndex = 0
  return matcher.test(invocationValue.matcherValue)
}

export function cleanupSessionEventState(session: SessionLike): void {
  lastAssistantMessages.delete(sessionId(session))
  const prefix = `${sessionId(session)}\0`
  for (const key of toolCalls.keys()) {
    if (key.startsWith(prefix)) toolCalls.delete(key)
  }
}
