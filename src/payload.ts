import type { HookPayload } from './types.js'

const MAX_PAYLOAD_BYTES = 128 * 1024
const MAX_VALUE_STRING_BYTES = 16 * 1024
const MAX_DEPTH = 16
const MAX_COLLECTION_ITEMS = 100
const PAYLOAD_REDUCE_FIELDS = [
  'tool_input',
  'tool_response',
  'prompt',
  'last_assistant_message',
  'error',
] as const

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  const suffix = '...[truncated]'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  let bytes = 0
  let result = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes + suffixBytes > maximumBytes) break
    result += character
    bytes += characterBytes
  }
  return result + suffix
}

function normalizeValue(value: unknown, seen: Set<object>, depth: number): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return truncateUtf8(value, MAX_VALUE_STRING_BYTES)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value)
  if (depth >= MAX_DEPTH) return '[Maximum depth exceeded]'
  if (seen.has(value)) return '[Circular]'

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const normalized = value.slice(0, MAX_COLLECTION_ITEMS).map(item => normalizeValue(item, seen, depth + 1))
      if (value.length > MAX_COLLECTION_ITEMS) normalized.push(`[${value.length - MAX_COLLECTION_ITEMS} items truncated]`)
      return normalized
    }

    const result: Record<string, unknown> = {}
    const keys = Object.keys(value).sort()
    for (const key of keys.slice(0, MAX_COLLECTION_ITEMS)) {
      try {
        result[truncateUtf8(key, 512)] = normalizeValue(value[key as keyof typeof value], seen, depth + 1)
      } catch (error) {
        result[truncateUtf8(key, 512)] = `[Unreadable: ${errorText(error)}]`
      }
    }
    if (keys.length > MAX_COLLECTION_ITEMS) result['[truncated_keys]'] = keys.length - MAX_COLLECTION_ITEMS
    return result
  } catch (error) {
    return `[Unserializable: ${errorText(error)}]`
  } finally {
    seen.delete(value)
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

function stablePayload(payload: HookPayload): Record<keyof HookPayload, unknown> {
  const seen = new Set<object>()
  return {
    schema_version: 1,
    source: 'deepseek-harness',
    hook_event_name: payload.hook_event_name,
    session_id: normalizeValue(payload.session_id, seen, 0),
    cwd: normalizeValue(payload.cwd, seen, 0),
    timestamp: normalizeValue(payload.timestamp, seen, 0),
    turn_id: normalizeValue(payload.turn_id, seen, 0),
    agent_id: normalizeValue(payload.agent_id, seen, 0),
    agent_type: normalizeValue(payload.agent_type, seen, 0),
    tool_name: normalizeValue(payload.tool_name, seen, 0),
    tool_use_id: normalizeValue(payload.tool_use_id, seen, 0),
    tool_input: normalizeValue(payload.tool_input, seen, 0),
    tool_response: normalizeValue(payload.tool_response, seen, 0),
    prompt: normalizeValue(payload.prompt, seen, 0),
    last_assistant_message: normalizeValue(payload.last_assistant_message, seen, 0),
    reason: normalizeValue(payload.reason, seen, 0),
    error: normalizeValue(payload.error, seen, 0),
    compaction_id: normalizeValue(payload.compaction_id, seen, 0),
    source_command_id: normalizeValue(payload.source_command_id, seen, 0),
  }
}

function encode(value: Record<keyof HookPayload, unknown>): string {
  return `${JSON.stringify(value)}\n`
}

export function serializePayload(payload: HookPayload): string {
  const normalized = stablePayload(payload)
  let serialized = encode(normalized)
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) return serialized

  for (const field of PAYLOAD_REDUCE_FIELDS) normalized[field] = '[Truncated: payload size limit]'
  for (const [field, value] of Object.entries(normalized)) {
    if (typeof value === 'string') normalized[field as keyof HookPayload] = truncateUtf8(value, 1024)
  }
  serialized = encode(normalized)
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) return serialized

  throw new Error('normalized hook payload exceeds the fixed size limit')
}
