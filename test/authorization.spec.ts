import { describe, expect, it } from 'vitest'
import {
  authorizationState,
  fingerprintHook,
} from '../src/authorization.ts'
import type { ResolvedHook } from '../src/config.ts'

const hook: ResolvedHook = {
  event: 'PreToolUse',
  matcherSource: 'bash|write',
  matcher: /bash|write/i,
  id: 'notify',
  type: 'command',
  command: '/bin/notify',
  enabled: true,
  timeoutMs: 10_000,
  maxConcurrent: 1,
}

const expectedFingerprint = 'sha256:cf07738dd34c20e0717cdd522c6e897f782db186cdb47c263c115e52fa998f8d'

describe('fingerprintHook', () => {
  it('uses a deterministic versioned encoding for the complete execution identity', () => {
    expect(fingerprintHook('user', hook)).toBe(expectedFingerprint)
    expect(fingerprintHook('user', { ...hook })).toBe(expectedFingerprint)
  })

  it.each([
    ['scope', 'workspace:alpha', hook],
    ['id', 'user', { ...hook, id: 'audit' }],
    ['event', 'user', { ...hook, event: 'PostToolUse' as const }],
    ['matcherSource', 'user', { ...hook, matcherSource: 'read|write' }],
    ['command', 'user', { ...hook, command: '/bin/audit' }],
    ['timeoutMs', 'user', { ...hook, timeoutMs: 20_000 }],
    ['maxConcurrent', 'user', { ...hook, maxConcurrent: 2 }],
  ])('changes when %s changes', (_field, scope, changedHook) => {
    expect(fingerprintHook(scope, changedHook)).not.toBe(expectedFingerprint)
  })

  it('ignores declaration state, matcher instances and runtime statistics', () => {
    const runtimeVariant = {
      ...hook,
      enabled: false,
      matcher: /different/,
      stats: { running: 2, skipped: 3, errors: 1, lastStatus: 'failed' },
    }

    expect(fingerprintHook('user', runtimeVariant)).toBe(expectedFingerprint)
  })
})

describe('authorizationState', () => {
  it('distinguishes missing approval, changed identity and matching approval', () => {
    expect(authorizationState(true, expectedFingerprint)).toEqual({
      configuredEnabled: true,
      authorized: false,
      enabled: false,
      authorizationReason: 'not-approved',
    })
    expect(authorizationState(true, expectedFingerprint, 'sha256:stale')).toEqual({
      configuredEnabled: true,
      authorized: false,
      enabled: false,
      authorizationReason: 'fingerprint-changed',
    })
    expect(authorizationState(true, expectedFingerprint, expectedFingerprint)).toEqual({
      configuredEnabled: true,
      authorized: true,
      enabled: true,
      authorizationReason: 'approved',
    })
    expect(authorizationState(false, expectedFingerprint, expectedFingerprint)).toEqual({
      configuredEnabled: false,
      authorized: true,
      enabled: false,
      authorizationReason: 'approved',
    })
  })
})
