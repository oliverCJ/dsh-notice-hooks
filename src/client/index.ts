import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
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
import { HookReviewButton } from './review-button.js'
import { HookReviewController } from './review-controller.js'
import { HookReviewDialog } from './review-dialog.js'
import reviewCssText from './review.module.css?inline'
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
  style.textContent = `${cssText}\n${dispatchCssText}\n${reviewCssText}`
  prior?.replaceWith(style)
  if (prior === null) document.head.appendChild(style)
  return () => {
    if (document.getElementById(styleId) === style) style.remove()
  }
}

export function apply(ctx: Context): void {
  const api = createHookApi()
  const review = new HookReviewController({ api })
  const reviewHooks = { hookReview: review.source } as const
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
  ctx.effect(() => ctx.uiConversation.events.register(createHookDispatchDefinition()))
  ctx.effect(installStyle)
  ctx.effect(() => {
    const focus = () => review.focus()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  })
  ctx.effect(() => () => review.dispose())
  ctx.on('connection/reset', () => review.reconnect())
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: name,
    order: 30,
    label: () => t('sectionLabel'),
    locale: namespace,
    inject: () => ({
      api: review.clientApi,
      hooks: reviewHooks,
      openReview: (scopeIds: readonly string[], onStatus?: Parameters<typeof review.open>[1]) => review.open(scopeIds, onStatus),
      acceptReviewStatus: (status: Parameters<typeof review.accept>[0]) => review.accept(status),
    }),
  }, HookSettingsSection))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: HOOK_DISPATCH_NODE,
    locale: namespace,
  }, HookDispatchRow))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-notice-hooks-review',
    order: 20,
    locale: namespace,
    inject: () => ({
      hooks: reviewHooks,
      retain: (sessionKey: string, scopeIds: readonly string[]) => review.retain(sessionKey, scopeIds),
      open: (scopeIds: readonly string[]) => review.open(scopeIds),
    }),
  }, HookReviewButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-notice-hooks-review',
    order: 30,
    locale: namespace,
    inject: () => ({
      hooks: reviewHooks,
      close: () => review.close(),
      toggle: (itemKey: string) => review.toggle(itemKey),
      authorize: (mode: 'selected' | 'all') => review.authorize(mode),
    }),
  }, HookReviewDialog))
}
