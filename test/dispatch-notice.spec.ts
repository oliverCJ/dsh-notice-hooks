import { appendPluginRecord, Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { parseHookConfig } from '../src/config.js'
import {
  appendHookDispatchNotice,
  collectHookDispatch,
  HOOK_DISPATCH_RECORD,
} from '../src/dispatch-notice.js'
import type { AuthorizationReason } from '../src/authorization.js'
import type { ResolvedHook } from '../src/config.js'
import type { ScopedHook } from '../src/scope-manager.js'
import type { HookInvocation } from '../src/types.js'

const FINGERPRINT = `sha256:${'0'.repeat(64)}` as const

function resolvedHook(id: string, event = 'Stop', matcher = '.*'): ResolvedHook {
  return parseHookConfig({
    version: 1,
    hooks: {
      [event]: [{ matcher, hooks: [{ id, type: 'command', command: 'true', enabled: true }] }],
    },
  }).hooks[0]!
}

function scopedHook(
  scopeId: 'user' | `workspace:${string}`,
  hook: ResolvedHook,
  options: {
    configuredEnabled?: boolean
    authorized?: boolean
    authorizationReason?: AuthorizationReason
  } = {},
): ScopedHook {
  const configuredEnabled = options.configuredEnabled ?? true
  const authorized = options.authorized ?? true
  const authorizationReason = options.authorizationReason ?? (authorized ? 'approved' : 'not-approved')
  return {
    scope: scopeId === 'user'
      ? { kind: 'user', id: 'user', title: 'User config', path: '/home/.dsh/hook.json' }
      : { kind: 'workspace', id: scopeId, workspaceId: scopeId.slice('workspace:'.length), title: 'Project', path: '/project/.dsh/hook.json' },
    hook,
    runtimeId: JSON.stringify([scopeId, hook.id]),
    fingerprint: FINGERPRINT,
    configuredEnabled,
    authorized,
    enabled: configuredEnabled && authorized,
    authorizationReason,
  }
}

function invocation(): HookInvocation {
  return {
    event: 'Stop',
    matcherValue: 'complete',
    payload: {
      schema_version: 1,
      source: 'deepseek-harness',
      hook_event_name: 'Stop',
      session_id: 'session-1',
      cwd: '/project',
      timestamp: '2026-11-05T00:00:00.000Z',
      turn_id: '1',
      agent_id: null,
      agent_type: 'main',
      tool_name: null,
      tool_use_id: null,
      tool_input: null,
      tool_response: null,
      prompt: null,
      last_assistant_message: null,
      reason: 'complete',
      error: null,
      compaction_id: null,
      source_command_id: null,
    },
  }
}

describe('Hook dispatch aggregation', () => {
  it('keeps scope order and reports matching disabled or unauthorized Hooks', () => {
    const hooks = [
      scopedHook('user', resolvedHook('notify')),
      scopedHook('user', resolvedHook('disabled'), { configuredEnabled: false }),
      scopedHook('workspace:project', resolvedHook('audit')),
      scopedHook('workspace:project', resolvedHook('unapproved'), { authorized: false }),
      scopedHook('workspace:project', resolvedHook('changed'), { authorized: false, authorizationReason: 'fingerprint-changed' }),
      scopedHook('workspace:project', resolvedHook('matcher-miss', 'Stop', '^error$')),
      scopedHook('workspace:project', resolvedHook('other-event', 'SessionStart')),
    ]

    const decision = collectHookDispatch(invocation(), hooks)

    expect(decision.admitted.map(item => `${item.scope.id}/${item.hook.id}`)).toEqual([
      'user/notify',
      'workspace:project/audit',
    ])
    expect(decision.notice).toEqual({
      event: 'Stop',
      triggered: [
        { scope: 'user', id: 'notify' },
        { scope: 'workspace:project', id: 'audit' },
      ],
      blocked: [
        { scope: 'user', id: 'disabled', reason: 'configured-disabled' },
        { scope: 'workspace:project', id: 'unapproved', reason: 'not-approved' },
        { scope: 'workspace:project', id: 'changed', reason: 'fingerprint-changed' },
      ],
    })
  })

  it('omits a notice when no Hook matches the event and matcher', () => {
    const hooks = [
      scopedHook('user', resolvedHook('matcher-miss', 'Stop', '^error$')),
      scopedHook('workspace:project', resolvedHook('other-event', 'SessionStart')),
    ]

    expect(collectHookDispatch(invocation(), hooks)).toEqual({ admitted: [], notice: undefined })
  })
})

describe('official Session plugin record', () => {
  it('is ignorable, survives restore, and stays outside the model surface', () => {
    const session = Session.create(SessionId('session-1'))
    const decision = collectHookDispatch(invocation(), [scopedHook('user', resolvedHook('notify'))])

    expect(appendHookDispatchNotice(session, decision.notice, appendPluginRecord)).toBe(0)
    const events = session.snapshotEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: HOOK_DISPATCH_RECORD, ignorable: true, data: decision.notice })
    expect(pluginRecordOf(events[0]!)).toMatchObject({ type: HOOK_DISPATCH_RECORD, data: decision.notice })
    expect(session.surface.nodes).toEqual([])

    const restored = Session.create(SessionId('restored'), events)
    expect(pluginRecordOf(restored.snapshotEvents()[0]!)).toMatchObject({ type: HOOK_DISPATCH_RECORD, data: decision.notice })
    expect(restored.surface.nodes).toEqual([])
  })

  it('does not append without runtime capability or for empty and SessionEnd notices', () => {
    const session = Session.create(SessionId('session-1'))
    const notice = { event: 'Stop' as const, triggered: [{ scope: 'user', id: 'notify' }], blocked: [] }
    expect(appendHookDispatchNotice(session, notice)).toBeUndefined()
    expect(appendHookDispatchNotice(session, undefined, appendPluginRecord)).toBeUndefined()
    expect(appendHookDispatchNotice(session, { event: 'SessionEnd', triggered: [{ scope: 'user', id: 'cleanup' }], blocked: [] }, appendPluginRecord)).toBeUndefined()
    expect(session.snapshotEvents()).toEqual([])
  })
})
