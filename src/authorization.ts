import { createHash } from 'node:crypto'
import type { ResolvedHook } from './config.js'

const FINGERPRINT_VERSION = 1

export type AuthorizationFingerprint = `sha256:${string}`
export type AuthorizationReason = 'approved' | 'not-approved' | 'fingerprint-changed'

export interface HookAuthorizationState {
  readonly configuredEnabled: boolean
  readonly authorized: boolean
  readonly enabled: boolean
  readonly authorizationReason: AuthorizationReason
}

type FingerprintedHook = Pick<
  ResolvedHook,
  'id' | 'event' | 'matcherSource' | 'command' | 'timeoutMs' | 'maxConcurrent'
>

export function fingerprintHook(scope: string, hook: FingerprintedHook): AuthorizationFingerprint {
  const encoded = JSON.stringify([
    FINGERPRINT_VERSION,
    scope,
    hook.id,
    hook.event,
    hook.matcherSource,
    hook.command,
    hook.timeoutMs,
    hook.maxConcurrent,
  ])
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`
}

export function authorizationState(
  configuredEnabled: boolean,
  currentFingerprint: AuthorizationFingerprint,
  approvedFingerprint?: string,
): HookAuthorizationState {
  const authorized = approvedFingerprint === currentFingerprint
  const authorizationReason: AuthorizationReason = authorized
    ? 'approved'
    : approvedFingerprint === undefined
      ? 'not-approved'
      : 'fingerprint-changed'

  return {
    configuredEnabled,
    authorized,
    enabled: configuredEnabled && authorized,
    authorizationReason,
  }
}
