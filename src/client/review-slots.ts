import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { MessageKey } from './i18n.js'
import type { HookReviewSource } from './review-controller.js'

interface HookReviewHooks {
  readonly hooks: { readonly hookReview: HookReviewSource }
}

export interface ReviewButtonInjected extends HookReviewHooks {
  readonly retain: (sessionKey: string, scopeIds: readonly string[]) => () => void
  readonly open: (scopeIds: readonly string[]) => Promise<void>
}

export interface ReviewDialogInjected extends HookReviewHooks {
  readonly close: () => void
  readonly toggle: (itemKey: string) => void
  readonly authorize: (mode: 'selected' | 'all') => Promise<void>
}

export type HookReviewButtonProps = PropsRuntime<'conversation.input.left'>
  & InjectFace<ReviewButtonInjected>
  & PropsLocale<'dsh-notice-hooks'>

export type HookReviewDialogProps = InjectFace<ReviewDialogInjected> & PropsLocale<'dsh-notice-hooks'>

export type HookReviewTranslate = (key: MessageKey, params?: Record<string, unknown>) => string
