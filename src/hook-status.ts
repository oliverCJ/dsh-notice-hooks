import type { AuthorizationFingerprint, HookAuthorizationState } from './authorization.js'
import { authorizationState, fingerprintHook } from './authorization.js'
import type { ResolvedHook } from './config.js'

export interface ResolvedHookStatus extends HookAuthorizationState {
  readonly fingerprint: AuthorizationFingerprint
}

export function resolveHookStatus(
  scopeId: string,
  hook: ResolvedHook,
  approvedFingerprint?: AuthorizationFingerprint,
): ResolvedHookStatus {
  const fingerprint = fingerprintHook(scopeId, hook)
  return Object.freeze({
    fingerprint,
    ...authorizationState(hook.enabled, fingerprint, approvedFingerprint),
  })
}
