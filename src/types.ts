import type { HookEvent } from './config.js'

export interface HookPayload {
  readonly schema_version: 1
  readonly source: 'deepseek-harness'
  readonly hook_event_name: HookEvent
  readonly session_id: string
  readonly cwd: string | null
  readonly timestamp: string
  readonly turn_id: string | null
  readonly agent_id: string | null
  readonly agent_type: string | null
  readonly tool_name: string | null
  readonly tool_use_id: string | null
  readonly tool_input: unknown
  readonly tool_response: unknown
  readonly prompt: string | null
  readonly last_assistant_message: string | null
  readonly reason: string | null
  readonly error: string | null
  readonly compaction_id: string | null
  readonly source_command_id: string | null
}

export interface HookInvocation {
  readonly event: HookEvent
  readonly matcherValue: string
  readonly payload: HookPayload
}

export interface SessionHeaderLike {
  readonly cwd?: unknown
  readonly origin?: unknown
  readonly parentSession?: unknown
  readonly agentId?: unknown
  readonly agentPreset?: unknown
  readonly createdAt?: unknown
}

export interface SessionLike {
  readonly id: unknown
  readonly header?: SessionHeaderLike
  readonly disposalReason?: unknown
}
