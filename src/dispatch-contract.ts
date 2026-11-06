import type { AuthorizationReason } from './authorization.js'
import type { HookEvent } from './config.js'

export const HOOK_DISPATCH_RECORD = 'plugin:dsh-notice-hooks/dispatch' as const

export type HookDispatchBlockedReason = 'configured-disabled' | Exclude<AuthorizationReason, 'approved'>

export interface HookDispatchReference {
  readonly scope: string
  readonly id: string
}

export interface HookDispatchBlocked extends HookDispatchReference {
  readonly reason: HookDispatchBlockedReason
}

export interface HookDispatchNotice {
  readonly event: HookEvent
  readonly triggered: readonly HookDispatchReference[]
  readonly blocked: readonly HookDispatchBlocked[]
}
