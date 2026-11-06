export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'PostCompactFailure',
  'SessionEnd',
] as const

export type HookEvent = typeof HOOK_EVENTS[number]

export interface CommandHookDocument {
  id: string
  type: 'command'
  command: string
  enabled?: boolean
  timeoutMs?: number
  maxConcurrent?: number
  [key: string]: unknown
}

export interface MatcherGroupDocument {
  matcher?: string
  hooks: CommandHookDocument[]
  [key: string]: unknown
}

export interface HookDocument {
  version: 1
  hooks: Partial<Record<HookEvent, MatcherGroupDocument[]>>
  [key: string]: unknown
}

export interface ResolvedHook {
  readonly event: HookEvent
  readonly matcherSource: string
  readonly matcher: RegExp
  readonly id: string
  readonly type: 'command'
  readonly command: string
  /** Untrusted configuration declaration; runtime execution also requires authorization. */
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly maxConcurrent: number
}

export interface ParsedHookConfig {
  readonly document: HookDocument
  readonly hooks: readonly ResolvedHook[]
}

const EVENT_SET = new Set<string>(HOOK_EVENTS)
const DEFAULT_TIMEOUT_MS = 10_000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_CONCURRENT = 1
const MIN_MAX_CONCURRENT = 1
const MAX_MAX_CONCURRENT = 4
const MAX_COMMAND_LENGTH = 8192

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireIntegerInRange(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function parseCommandHook(value: unknown, event: HookEvent, matcherSource: string, ids: Set<string>): ResolvedHook {
  if (!isRecord(value)) throw new Error(`${event} hook must be an object`)
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new Error(`${event} hook id must be a non-empty string`)
  }
  if (ids.has(value.id)) throw new Error(`duplicate hook id: ${value.id}`)
  ids.add(value.id)
  if (value.type !== 'command') throw new Error(`${value.id} type must equal command`)
  if (typeof value.command !== 'string' || value.command.trim().length === 0) {
    throw new Error(`${value.id} command must be a non-empty string`)
  }
  if (value.command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`${value.id} command must not exceed ${MAX_COMMAND_LENGTH} characters`)
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`${value.id} enabled must be a boolean`)
  }

  return {
    event,
    matcherSource,
    matcher: new RegExp(matcherSource, 'i'),
    id: value.id,
    type: 'command',
    command: value.command,
    enabled: value.enabled === true,
    timeoutMs: requireIntegerInRange(
      value.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      `${value.id} timeoutMs`,
    ),
    maxConcurrent: requireIntegerInRange(
      value.maxConcurrent,
      DEFAULT_MAX_CONCURRENT,
      MIN_MAX_CONCURRENT,
      MAX_MAX_CONCURRENT,
      `${value.id} maxConcurrent`,
    ),
  }
}

export function parseHookConfig(input: unknown): ParsedHookConfig {
  if (!isRecord(input)) throw new Error('hook config must be an object')
  if (input.version !== 1) throw new Error('hook config version must equal 1')
  if (!isRecord(input.hooks)) throw new Error('hook config hooks must be an object')

  const ids = new Set<string>()
  const resolved: ResolvedHook[] = []
  for (const [eventName, groupsValue] of Object.entries(input.hooks)) {
    if (!EVENT_SET.has(eventName)) throw new Error(`unsupported hook event: ${eventName}`)
    if (!Array.isArray(groupsValue)) throw new Error(`${eventName} must contain matcher groups`)
    const event = eventName as HookEvent
    for (const groupValue of groupsValue) {
      if (!isRecord(groupValue)) throw new Error(`${event} matcher group must be an object`)
      if (groupValue.matcher !== undefined && typeof groupValue.matcher !== 'string') {
        throw new Error(`${event} matcher must be a string`)
      }
      const matcherSource = groupValue.matcher ?? ''
      try {
        new RegExp(matcherSource, 'i')
      } catch (error) {
        throw new Error(`${event} matcher is not a valid regular expression`, { cause: error })
      }
      if (!Array.isArray(groupValue.hooks) || groupValue.hooks.length === 0) {
        throw new Error(`${event} matcher group hooks must be a non-empty array`)
      }
      for (const hookValue of groupValue.hooks) {
        resolved.push(parseCommandHook(hookValue, event, matcherSource, ids))
      }
    }
  }

  return {
    document: input as HookDocument,
    hooks: resolved,
  }
}

export function setHookEnabled(input: unknown, id: string, enabled: boolean): unknown {
  parseHookConfig(input)
  const changed = structuredClone(input)
  if (!isRecord(changed) || !isRecord(changed.hooks)) throw new Error('hook config clone is invalid')

  for (const groups of Object.values(changed.hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue
      for (const hook of group.hooks) {
        if (isRecord(hook) && hook.id === id) {
          hook.enabled = enabled
          return changed
        }
      }
    }
  }
  throw new Error(`hook id not found: ${id}`)
}
