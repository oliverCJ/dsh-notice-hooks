// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/client/index.js'
import { en, zh } from '../src/client/i18n.js'

interface Registration {
  readonly options: Record<string, unknown>
  readonly component: unknown
  readonly dispose: ReturnType<typeof vi.fn>
}

function context() {
  const effects: Array<() => void> = []
  const registrations: Registration[] = []
  const slotControllers: Array<() => void> = []
  const localeDispose = vi.fn()
  const locale = {
    register: vi.fn(() => localeDispose),
    bind: vi.fn(() => (key: string) => key),
  }
  const definitionDispose = vi.fn()
  const uiConversation = {
    events: {
      register: vi.fn(() => definitionDispose),
    },
  }
  const slots = {
    register: vi.fn((options: Record<string, unknown>, component: unknown) => {
      const dispose = vi.fn()
      registrations.push({ options, component, dispose })
      return dispose
    }),
    inject: vi.fn((_name: string, callback: () => () => void) => {
      const dispose = callback()
      slotControllers.push(dispose)
      return dispose
    }),
  }
  const eventDisposers: Array<ReturnType<typeof vi.fn>> = []
  const on = vi.fn(() => {
    const dispose = vi.fn()
    eventDisposers.push(dispose)
    return dispose
  })
  const ctx = {
    locale,
    slots,
    uiConversation,
    on,
    effect: vi.fn((setup: () => void | (() => void)) => {
      const dispose = setup() ?? (() => undefined)
      effects.push(dispose)
      return dispose
    }),
  }
  return { ctx, definitionDispose, effects, eventDisposers, locale, localeDispose, on, registrations, slotControllers, slots, uiConversation }
}

afterEach(() => {
  document.head.querySelectorAll('#dsh-notice-hooks-style').forEach(element => element.remove())
})

describe('Settings client plugin', () => {
  it('declares the expected client identity and dependencies', () => {
    expect(name).toBe('dsh-notice-hooks')
    expect(inject).toEqual(['slots', 'locale', 'uiConversation'])
  })

  it('uses the exact product title in both Bundle locale manifests', () => {
    const readTitle = (name: string): unknown => JSON.parse(readFileSync(resolve('locale', `${name}.json`), 'utf8')).meta?.title
    expect(readTitle('en')).toBe('dsh-notice-hooks')
    expect(readTitle('zh')).toBe('dsh-notice-hooks')
  })

  it('registers localized copy and one Settings section with the exact slot id', () => {
    const fixture = context()
    apply(fixture.ctx as never)

    expect(fixture.locale.register).toHaveBeenCalledWith('dsh-notice-hooks', expect.objectContaining({ en: expect.any(Object), zh: expect.any(Object) }))
    expect(fixture.slots.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(fixture.slots.inject).toHaveBeenCalledWith('conversation.chat.node', expect.any(Function))
    expect(fixture.slots.inject).toHaveBeenCalledWith('conversation.input.left', expect.any(Function))
    expect(fixture.slots.inject).toHaveBeenCalledWith('shell.overlay', expect.any(Function))
    expect(fixture.uiConversation.events.register).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'dsh-notice-hooks.dispatch', target: 'chat',
    }))
    expect(fixture.registrations).toHaveLength(4)
    expect(fixture.registrations[0]?.options).toMatchObject({
      name: 'settings.section', id: 'dsh-notice-hooks', order: 30, locale: 'dsh-notice-hooks',
    })
    expect(typeof fixture.registrations[0]?.options.label).toBe('function')
    expect(fixture.registrations[1]?.options).toMatchObject({
      name: 'conversation.chat.node', key: 'dsh-notice-hooks.dispatch', locale: 'dsh-notice-hooks',
    })
    expect(fixture.registrations[2]?.options).toMatchObject({
      name: 'conversation.input.left', id: 'dsh-notice-hooks-review', order: 20, locale: 'dsh-notice-hooks',
    })
    expect(fixture.registrations[3]?.options).toMatchObject({
      name: 'shell.overlay', id: 'dsh-notice-hooks-review', order: 30, locale: 'dsh-notice-hooks',
    })
    const buttonFace = (fixture.registrations[2]?.options.inject as (sessionId: string) => { hooks: { hookReview: unknown } })('session-1')
    const dialogFace = (fixture.registrations[3]?.options.inject as () => { hooks: { hookReview: unknown } })()
    expect(buttonFace.hooks.hookReview).toBe(dialogFace.hooks.hookReview)
    expect(fixture.on).toHaveBeenCalledWith('connection/reset', expect.any(Function))
    expect(en.sectionLabel).toBe('Hooks setting')
    expect(zh.sectionLabel).toBe('Hooks 设置')
    expect(en.title).toBe('Hooks setting')
    expect(zh.title).toBe('Hooks 设置')
  })

  it('keeps one current stylesheet and removes registrations and styles on disposal', () => {
    const first = context()
    apply(first.ctx as never)
    const firstStyle = document.getElementById('dsh-notice-hooks-style')
    expect(firstStyle).toBeInstanceOf(HTMLStyleElement)

    const second = context()
    apply(second.ctx as never)
    const secondStyle = document.getElementById('dsh-notice-hooks-style')
    expect(secondStyle).not.toBe(firstStyle)
    expect(document.head.querySelectorAll('#dsh-notice-hooks-style')).toHaveLength(1)

    first.effects.reverse().forEach(dispose => dispose())
    first.slotControllers.reverse().forEach(dispose => dispose())
    expect(document.getElementById('dsh-notice-hooks-style')).toBe(secondStyle)
    expect(first.registrations[0]?.dispose).toHaveBeenCalledOnce()
    expect(first.registrations[1]?.dispose).toHaveBeenCalledOnce()
    expect(first.registrations[2]?.dispose).toHaveBeenCalledOnce()
    expect(first.registrations[3]?.dispose).toHaveBeenCalledOnce()
    expect(first.definitionDispose).toHaveBeenCalledOnce()
    expect(first.localeDispose).toHaveBeenCalledOnce()

    second.effects.reverse().forEach(dispose => dispose())
    second.slotControllers.reverse().forEach(dispose => dispose())
    expect(document.getElementById('dsh-notice-hooks-style')).toBeNull()
    expect(second.registrations[0]?.dispose).toHaveBeenCalledOnce()
    expect(second.registrations[1]?.dispose).toHaveBeenCalledOnce()
    expect(second.registrations[2]?.dispose).toHaveBeenCalledOnce()
    expect(second.registrations[3]?.dispose).toHaveBeenCalledOnce()
    expect(second.definitionDispose).toHaveBeenCalledOnce()
  })
})
