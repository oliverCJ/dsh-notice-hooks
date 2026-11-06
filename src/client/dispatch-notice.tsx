import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import Webhook from 'lucide-react/dist/esm/icons/webhook.js'
import { memo, type ReactNode } from 'react'
import { HOOK_EVENTS } from '../config.js'
import {
  HOOK_DISPATCH_RECORD,
  type HookDispatchBlocked,
  type HookDispatchNotice,
  type HookDispatchReference,
} from '../dispatch-contract.js'

export const HOOK_DISPATCH_NODE = 'dsh-notice-hooks.dispatch' as const

interface HookDispatchState {
  readonly seq: number
  readonly notice: HookDispatchNotice
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    [HOOK_DISPATCH_NODE]: HookDispatchNotice
  }
}

const EVENT_NAMES = new Set<string>(HOOK_EVENTS)
const BLOCKED_REASONS = new Set<string>([
  'configured-disabled',
  'not-approved',
  'fingerprint-changed',
])

interface PluginRecordCandidate {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: boolean
}

function hookDispatchRecordOf(event: SessionEvent) {
  const candidate: PluginRecordCandidate = event
  if (candidate.ignorable !== true || candidate.type !== HOOK_DISPATCH_RECORD) return undefined
  return { type: candidate.type, seq: candidate.seq, time: candidate.time, data: candidate.data }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isReference(value: unknown): value is HookDispatchReference {
  return isObject(value)
    && hasExactKeys(value, ['scope', 'id'])
    && typeof value.scope === 'string'
    && value.scope.length > 0
    && typeof value.id === 'string'
    && value.id.length > 0
}

function isBlocked(value: unknown): value is HookDispatchBlocked {
  return isObject(value)
    && hasExactKeys(value, ['scope', 'id', 'reason'])
    && typeof value.scope === 'string'
    && value.scope.length > 0
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.reason === 'string'
    && BLOCKED_REASONS.has(value.reason)
}

export function isHookDispatchNotice(value: unknown): value is HookDispatchNotice {
  if (!isObject(value) || !hasExactKeys(value, ['event', 'triggered', 'blocked'])) return false
  if (typeof value.event !== 'string' || !EVENT_NAMES.has(value.event)) return false
  if (!Array.isArray(value.triggered) || !value.triggered.every(isReference)) return false
  if (!Array.isArray(value.blocked) || !value.blocked.every(isBlocked)) return false
  return value.triggered.length + value.blocked.length > 0
}

export function createHookDispatchDefinition(): ConversationNodeDefinition<HookDispatchState> {
  return {
    kind: HOOK_DISPATCH_NODE,
    target: 'chat',
    match: (event) => {
      const record = hookDispatchRecordOf(event as SessionEvent)
      if (record?.type !== HOOK_DISPATCH_RECORD || !isHookDispatchNotice(record.data)) return null
      return { id: `dispatch:${record.seq}`, role: 'start', exclusive: true }
    },
    start: (_context, match) => {
      const record = hookDispatchRecordOf(match.event as SessionEvent)
      if (record?.type !== HOOK_DISPATCH_RECORD || !isHookDispatchNotice(record.data)) {
        throw new TypeError('Hook dispatch record changed after matching')
      }
      return { seq: record.seq, notice: record.data }
    },
    update: context => context.state,
    buildViewNode: context => {
      if (context.state === undefined) return null
      return {
        key: context.key,
        kind: HOOK_DISPATCH_NODE,
        id: context.id,
        target: 'chat',
        anchorSeq: context.state.seq,
        location: context.start?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        data: context.state.notice,
      } satisfies ChatNode<typeof HOOK_DISPATCH_NODE>
    },
  }
}

function hookName(reference: HookDispatchReference): string {
  return `${reference.scope}/${reference.id}`
}

type HookDispatchRowProps = Pick<ChatNodeViewProps<typeof HOOK_DISPATCH_NODE>, 'node'>
  & PropsLocale<'dsh-notice-hooks'>

export const HookDispatchRow = memo(function HookDispatchRow({
  node,
  t,
}: HookDispatchRowProps) {
  const items: ReactNode[] = []
  const append = (className: string, text: string) => {
    if (items.length > 0) items.push(<span className="dnh-dispatch-separator" key={`separator:${items.length}`}>·</span>)
    items.push(<span className={className} key={`item:${items.length}`}>{text}</span>)
  }

  for (const reference of node.data.triggered) {
    append('dnh-dispatch-triggered', t('dispatchTriggered', { hook: hookName(reference) }))
  }
  for (const reference of node.data.blocked) {
    const key = reference.reason === 'configured-disabled'
      ? 'dispatchConfiguredDisabled'
      : reference.reason === 'not-approved'
        ? 'dispatchNotApproved'
        : 'dispatchFingerprintChanged'
    append('dnh-dispatch-blocked', t(key, { hook: hookName(reference) }))
  }

  return (
    <div className="dnh-dispatch-row" role="status">
      <span aria-hidden="true" className="dnh-dispatch-icon"><Webhook /></span>
      <div className="dnh-dispatch-content">
        <span className="dnh-dispatch-event">{t('dispatchEvent', { event: node.data.event })}</span>
        {items.length > 0 && <span className="dnh-dispatch-separator">·</span>}
        {items}
      </div>
    </div>
  )
})
