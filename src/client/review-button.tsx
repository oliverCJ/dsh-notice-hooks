import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import ShieldAlert from 'lucide-react/dist/esm/icons/shield-alert.js'
import { memo, useEffect, useMemo } from 'react'
import { pendingFor, type HookReviewSnapshot } from './review-controller.js'
import type { HookReviewButtonProps } from './review-slots.js'

export const HookReviewButton = memo(function HookReviewButton({
  sessionId,
  useWorkspaces,
  useHookReview,
  retain,
  open,
  t,
}: HookReviewButtonProps) {
  const workspaceId = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot.items.find(workspace =>
    workspace.sessionIds.some(value => String(value) === String(sessionId)))?.workspaceId)
  const scopeIds = useMemo(() => [
    'user',
    ...(workspaceId === undefined ? [] : [`workspace:${String(workspaceId)}`]),
  ], [workspaceId])
  const pending = useHookReview((snapshot: HookReviewSnapshot) => pendingFor(snapshot, scopeIds))
  const scopeKey = scopeIds.join('\0')

  useEffect(() => retain(String(sessionId), scopeIds), [retain, scopeKey, sessionId])

  if (pending.length === 0) return null
  const label = t('reviewButton', { count: pending.length })
  return (
    <button
      type="button"
      className="dnh-review-trigger"
      aria-label={label}
      title={label}
      onClick={() => { void open(scopeIds) }}
    >
      <ShieldAlert aria-hidden="true" />
      <span className="dnh-review-trigger-dot" aria-hidden="true" />
    </button>
  )
})
