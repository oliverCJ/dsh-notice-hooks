import ShieldAlert from 'lucide-react/dist/esm/icons/shield-alert.js'
import X from 'lucide-react/dist/esm/icons/x.js'
import { memo, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { pendingFor, type HookReviewSnapshot } from './review-controller.js'
import type { HookReviewDialogProps } from './review-slots.js'

function focusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.hidden)
}

export const HookReviewDialog = memo(function HookReviewDialog({
  useHookReview,
  close,
  toggle,
  authorize,
  t,
}: HookReviewDialogProps) {
  const snapshot: HookReviewSnapshot = useHookReview((value: HookReviewSnapshot) => value)
  const dialogState = snapshot.dialog
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  const open = dialogState !== null

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const target = dialogRef.current
      queueMicrotask(() => (target === null ? undefined : (focusable(target)[0] ?? target).focus()))
    } else if (!open && wasOpen.current) {
      const target = returnFocus.current
      queueMicrotask(() => target?.focus())
      returnFocus.current = null
    }
    wasOpen.current = open
  }, [open])

  if (dialogState === null) return null
  const requestClose = () => { if (!dialogState.submitting) close() }
  const items = pendingFor(snapshot, dialogState.scopeIds)
  const selected = new Set(dialogState.selected)
  const groups = dialogState.scopeIds.flatMap(scopeId => {
    const status = snapshot.byScope[scopeId]
    if (status === undefined) return []
    const scoped = items.filter(item => item.scopeId === scopeId)
    return scoped.length === 0 ? [] : [{ status, items: scoped }]
  })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const controls = focusable(dialogRef.current)
    if (controls.length === 0) { event.preventDefault(); dialogRef.current.focus(); return }
    const first = controls[0]!
    const last = controls[controls.length - 1]!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return (
    <div className="dnh-review-layer" role="presentation">
      <div className="dnh-review-mask" data-testid="hook-review-mask" aria-hidden="true" onClick={requestClose} />
      <div
        ref={dialogRef}
        className="dnh-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('reviewTitle')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dnh-review-dialog-header">
          <h2>{t('reviewTitle')}</h2>
          <button type="button" className="dnh-review-close" aria-label={t('reviewClose')} disabled={dialogState.submitting} onClick={requestClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="dnh-review-warning" role="note">
          <ShieldAlert aria-hidden="true" />
          <span>{t('reviewWarning')}</span>
        </div>
        <div className="dnh-review-body">
          {groups.map(group => (
            <section className="dnh-review-scope" key={group.status.scope.id}>
              <h3>{group.status.scope.title}</h3>
              <div className="dnh-review-list">
                {group.items.map(item => (
                  <label className="dnh-review-item" key={item.key}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.key)}
                      disabled={dialogState.submitting}
                      onChange={() => toggle(item.key)}
                    />
                    <span className="dnh-review-item-content">
                      <span className="dnh-review-item-heading">
                        <strong>{item.hook.id}</strong>
                        <span>{item.hook.event}</span>
                        <span className="dnh-review-state">{t(item.reason === 'fingerprint-changed' ? 'reviewChanged' : 'reviewUnauthorized')}</span>
                      </span>
                      <code>{item.hook.command}</code>
                      <span className="dnh-review-meta">
                        <span>{t('matcher')}: {item.hook.matcher || t('allValues')}</span>
                        <span>{t('timeout')}: {item.hook.timeoutMs} ms</span>
                        <span>{t('concurrency')}: {item.hook.maxConcurrent}</span>
                      </span>
                      {dialogState.failures[item.key] !== undefined && (
                        <span className="dnh-review-error" role="alert">{t('reviewFailed')}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ))}
        </div>
        <footer className="dnh-review-footer">
          <button type="button" disabled={dialogState.submitting} onClick={requestClose}>{t('reviewNotNow')}</button>
          <button type="button" disabled={dialogState.submitting || items.length === 0} onClick={() => { void authorize('all') }}>{t('reviewAuthorizeAll')}</button>
          <button className="dnh-review-primary" type="button" disabled={dialogState.submitting || selected.size === 0} onClick={() => { void authorize('selected') }}>{t('reviewAuthorizeSelected')}</button>
        </footer>
      </div>
    </div>
  )
})
