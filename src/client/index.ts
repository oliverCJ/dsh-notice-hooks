import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createHookApi } from './api.js'
import {
  createHookDispatchDefinition,
  HOOK_DISPATCH_NODE,
  HookDispatchRow,
} from './dispatch-notice.js'
import dispatchCssText from './dispatch-notice.module.css?inline'
import { en, zh } from './i18n.js'
import { HookSettingsSection } from './settings-section.js'
import cssText from './settings-section.module.css?inline'

export const name = 'dsh-notice-hooks'
export const inject = ['slots', 'locale', 'uiConversation'] as const

const namespace = 'dsh-notice-hooks'
const styleId = 'dsh-notice-hooks-style'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-notice-hooks': keyof typeof en
  }
}

function installStyle(): () => void {
  const prior = document.getElementById(styleId)
  const style = document.createElement('style')
  style.id = styleId
  style.textContent = `${cssText}\n${dispatchCssText}`
  prior?.replaceWith(style)
  if (prior === null) document.head.appendChild(style)
  return () => {
    if (document.getElementById(styleId) === style) style.remove()
  }
}

export function apply(ctx: Context): void {
  const api = createHookApi()
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
  ctx.effect(() => ctx.uiConversation.events.register(createHookDispatchDefinition()))
  ctx.effect(installStyle)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: name,
    order: 30,
    label: () => t('sectionLabel'),
    locale: namespace,
    inject: () => ({ api }),
  }, HookSettingsSection))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: HOOK_DISPATCH_NODE,
    locale: namespace,
  }, HookDispatchRow))
}
