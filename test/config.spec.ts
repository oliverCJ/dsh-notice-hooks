import { describe, expect, it } from 'vitest'
import { parseHookConfig, setHookEnabled } from '../src/config.ts'

const example = {
  version: 1,
  owner: 'external-producer',
  hooks: {
    PreToolUse: [{
      matcher: 'bash|write',
      groupMetadata: { color: 'green' },
      hooks: [{
        id: 'notify-tool-use',
        type: 'command',
        command: '/usr/local/bin/my-hook --event PreToolUse',
        enabled: true,
        customMetadata: { channel: 'desktop' },
      }],
    }],
  },
}

describe('parseHookConfig', () => {
  it('flattens matcher groups with defaults and a case-insensitive matcher', () => {
    const parsed = parseHookConfig(example)

    expect(parsed.hooks).toHaveLength(1)
    expect(parsed.hooks[0]).toMatchObject({
      event: 'PreToolUse',
      id: 'notify-tool-use',
      type: 'command',
      command: '/usr/local/bin/my-hook --event PreToolUse',
      enabled: true,
      timeoutMs: 10_000,
      maxConcurrent: 1,
      matcherSource: 'bash|write',
    })
    expect(parsed.hooks[0]?.matcher.test('WRITE')).toBe(true)
    expect(parsed.document).toEqual(example)
  })

  it.each(['PreCompact', 'PostCompact', 'PostCompactFailure'] as const)('accepts the %s lifecycle event', (event) => {
    const hook = example.hooks.PreToolUse[0]!.hooks[0]!
    const parsed = parseHookConfig({ version: 1, hooks: { [event]: [{ matcher: 'manual|automatic', hooks: [{ ...hook, id: event }] }] } })
    expect(parsed.hooks[0]).toMatchObject({ event, id: event, matcherSource: 'manual|automatic' })
  })

  it('treats a missing enabled field as disabled', () => {
    const { enabled: _enabled, ...hookWithoutEnabled } = example.hooks.PreToolUse[0]!.hooks[0]!
    const input = {
      ...example,
      hooks: {
        PreToolUse: [{ ...example.hooks.PreToolUse[0], hooks: [hookWithoutEnabled] }],
      },
    }

    expect(parseHookConfig(input).hooks[0]?.enabled).toBe(false)
  })

  it.each([
    ['version mismatch', { ...example, version: 2 }],
    ['unknown event', { version: 1, hooks: { BeforeLaunch: [] } }],
    ['malformed matcher', { version: 1, hooks: { PreToolUse: [{ matcher: '[', hooks: example.hooks.PreToolUse[0]!.hooks }] } }],
    ['empty command', { version: 1, hooks: { PreToolUse: [{ hooks: [{ ...example.hooks.PreToolUse[0]!.hooks[0], command: '   ' }] }] } }],
    ['too long command', { version: 1, hooks: { PreToolUse: [{ hooks: [{ ...example.hooks.PreToolUse[0]!.hooks[0], command: 'x'.repeat(8193) }] }] } }],
    ['timeout below bound', { version: 1, hooks: { PreToolUse: [{ hooks: [{ ...example.hooks.PreToolUse[0]!.hooks[0], timeoutMs: 99 }] }] } }],
    ['timeout above bound', { version: 1, hooks: { PreToolUse: [{ hooks: [{ ...example.hooks.PreToolUse[0]!.hooks[0], timeoutMs: 60_001 }] }] } }],
    ['concurrency below bound', { version: 1, hooks: { PreToolUse: [{ hooks: [{ ...example.hooks.PreToolUse[0]!.hooks[0], maxConcurrent: 0 }] }] } }],
    ['concurrency above bound', { version: 1, hooks: { PreToolUse: [{ hooks: [{ ...example.hooks.PreToolUse[0]!.hooks[0], maxConcurrent: 5 }] }] } }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseHookConfig(input)).toThrow()
  })

  it('rejects duplicate IDs across events', () => {
    const hook = example.hooks.PreToolUse[0]!.hooks[0]
    const input = {
      version: 1,
      hooks: {
        PreToolUse: [{ hooks: [hook] }],
        Stop: [{ hooks: [{ ...hook, command: '/bin/true' }] }],
      },
    }

    expect(() => parseHookConfig(input)).toThrow(/duplicate/i)
  })
})

describe('setHookEnabled', () => {
  it('changes only the matching enabled field and preserves unknown metadata', () => {
    const changed = setHookEnabled(example, 'notify-tool-use', false)

    expect(changed).toEqual({
      ...example,
      hooks: {
        PreToolUse: [{
          ...example.hooks.PreToolUse[0],
          hooks: [{ ...example.hooks.PreToolUse[0]!.hooks[0], enabled: false }],
        }],
      },
    })
    expect(example.hooks.PreToolUse[0]!.hooks[0]!.enabled).toBe(true)
  })

  it('rejects an unknown hook ID', () => {
    expect(() => setHookEnabled(example, 'missing', true)).toThrow(/missing/)
  })
})
