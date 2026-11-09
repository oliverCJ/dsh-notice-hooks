import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  HOOK_DISPATCH_RECORD,
  type HookDispatchBlocked,
  type HookDispatchBlockedReason,
  type HookDispatchNotice,
  type HookDispatchReference,
} from './dispatch-contract.js'
import { matchInvocation } from './events.js'
import type { ScopedHook } from './scope-manager.js'
import type { HookInvocation } from './types.js'

export { HOOK_DISPATCH_RECORD } from './dispatch-contract.js'
export type {
  HookDispatchBlocked,
  HookDispatchBlockedReason,
  HookDispatchNotice,
  HookDispatchReference,
} from './dispatch-contract.js'

export type AppendPluginRecord = (
  session: Session,
  type: typeof HOOK_DISPATCH_RECORD,
  data: HookDispatchNotice,
) => SessionSeq

export interface HookDispatchDecision {
  readonly admitted: readonly ScopedHook[]
  readonly notice: HookDispatchNotice | undefined
}

// Extends the Session-owned catalog without adding this record to model events.
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    [HOOK_DISPATCH_RECORD]: HookDispatchNotice
  }
}

function blockedReason(hook: ScopedHook): HookDispatchBlockedReason {
  if (!hook.configuredEnabled) return 'configured-disabled'
  return hook.authorizationReason === 'fingerprint-changed' ? 'fingerprint-changed' : 'not-approved'
}

export function collectHookDispatch(
  invocation: HookInvocation,
  hooks: readonly ScopedHook[],
  onMatchError?: (hook: ScopedHook, error: unknown) => void,
): HookDispatchDecision {
  const admitted: ScopedHook[] = []
  const triggered: HookDispatchReference[] = []
  const blocked: HookDispatchBlocked[] = []

  for (const scoped of hooks) {
    if (scoped.hook.event !== invocation.event) continue
    let matches: boolean
    try { matches = matchInvocation(invocation, scoped.hook.matcher) }
    catch (error) { onMatchError?.(scoped, error); continue }
    if (!matches) continue
    const reference = { scope: scoped.scope.id, id: scoped.hook.id }
    if (scoped.enabled) {
      admitted.push(scoped)
      triggered.push(reference)
    } else {
      blocked.push({ ...reference, reason: blockedReason(scoped) })
    }
  }

  const notice = triggered.length === 0 && blocked.length === 0
    ? undefined
    : { event: invocation.event, triggered, blocked }
  return { admitted, notice }
}

export function appendHookDispatchNotice(
  session: Session,
  notice: HookDispatchNotice | undefined,
  appendRecord?: AppendPluginRecord,
): SessionSeq | undefined {
  if (notice === undefined || notice.event === 'SessionEnd' || appendRecord === undefined) return undefined
  return appendRecord(session, HOOK_DISPATCH_RECORD, notice)
}
