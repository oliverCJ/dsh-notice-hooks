import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.js'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.js'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.js'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { HOOK_EVENTS, type HookEvent } from '../config.js'
import { HookApiError, type HookApi, type HookScopeView, type HookStatus, type HookView } from './api.js'
import type { MessageKey } from './i18n.js'
import type { HookReviewSnapshot } from './review-controller.js'

const css = {
  actionError: 'dnh-action-error', authorizationAction: 'dnh-authorization-action', command: 'dnh-command', controls: 'dnh-controls', count: 'dnh-count',
  description: 'dnh-description', details: 'dnh-details', detailGrid: 'dnh-detail-grid', error: 'dnh-error',
  eventBody: 'dnh-event-body', eventDescription: 'dnh-event-description', eventGroup: 'dnh-event-group',
  eventHeader: 'dnh-event-header', eventName: 'dnh-event-name', groupToggle: 'dnh-group-toggle', header: 'dnh-header',
  heading: 'dnh-heading', hookHeader: 'dnh-hook-header', hookId: 'dnh-hook-id', hookIdentity: 'dnh-hook-identity', hookRow: 'dnh-hook-row',
  list: 'dnh-list', meta: 'dnh-meta', notice: 'dnh-notice', path: 'dnh-path', reload: 'dnh-reload',
  reviewAction: 'dnh-review-action', reviewBanner: 'dnh-review-banner', reviewState: 'dnh-review-state-chip', reviewStatePending: 'dnh-review-state-pending',
  scope: 'dnh-scope', scopeHelp: 'dnh-scope-help', scopeSelect: 'dnh-scope-select', section: 'dnh-section',
  switch: 'dnh-switch', track: 'dnh-track',
} as const

const EVENT_DESCRIPTIONS: Record<HookEvent, MessageKey> = {
  SessionStart: 'eventSessionStart', UserPromptSubmit: 'eventUserPromptSubmit', PreToolUse: 'eventPreToolUse',
  PostToolUse: 'eventPostToolUse', PostToolUseFailure: 'eventPostToolUseFailure', PermissionRequest: 'eventPermissionRequest',
  SubagentStart: 'eventSubagentStart', SubagentStop: 'eventSubagentStop', Stop: 'eventStop',
  StopFailure: 'eventStopFailure', PreCompact: 'eventPreCompact', PostCompact: 'eventPostCompact',
  PostCompactFailure: 'eventPostCompactFailure', SessionEnd: 'eventSessionEnd',
}

export interface HookSettingsSectionProps {
  readonly api: HookApi
  readonly useHookReview: SnapshotSelectorHook<HookReviewSnapshot>
  readonly openReview: (scopeIds: readonly string[], onStatus?: (status: HookStatus) => void) => Promise<void>
  readonly acceptReviewStatus: (status: HookStatus) => void
  readonly t: (key: MessageKey, params?: Record<string, unknown>) => string
}

function metric(value: number, label: string): string { return `${value} ${label}` }

function HookRow({ hook, scopeId, revision, requestToken, loading, api, t, onStatus, onError, focusTargetKey, focusRequest, rowKey }: {
  readonly hook: HookView
  readonly scopeId: string
  readonly revision: number
  readonly loading: boolean
  readonly api: HookApi
  readonly t: HookSettingsSectionProps['t']
  readonly requestToken: number
  readonly onStatus: (scopeId: string, status: HookStatus, token: number) => void
  readonly onError: (scopeId: string, error: unknown, token: number) => Promise<void>
  readonly focusTargetKey: string | undefined
  readonly focusRequest: number
  readonly rowKey: string
}) {
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const actionElement = useRef<HTMLButtonElement | null>(null)
  const isFocusTarget = focusTargetKey === rowKey
  useLayoutEffect(() => {
    if (!isFocusTarget) return
    setExpanded(true)
    queueMicrotask(() => {
      if (typeof actionElement.current?.scrollIntoView === 'function') actionElement.current.scrollIntoView({ block: 'center' })
      actionElement.current?.focus()
    })
  }, [focusRequest, isFocusTarget, rowKey])
  const update = async (operation: () => Promise<HookStatus>) => {
    setBusy(true)
    try { onStatus(scopeId, await operation(), requestToken) }
    catch (error) { await onError(scopeId, error, requestToken) }
    finally { setBusy(false) }
  }
  const enableLabel = `${t('enable')} ${hook.id}`
  const detailsLabel = `${t(expanded ? 'hideDetails' : 'showDetails')} ${hook.id}`
  const authorizationLabel = `${t(hook.authorized ? 'revokeAuthorization' : 'reviewAuthorization')} ${hook.id}`
  const reviewKey: MessageKey = !hook.configuredEnabled
    ? 'configurationDisabled'
    : hook.authorized
      ? 'reviewAuthorized'
      : hook.authorizationReason === 'fingerprint-changed' ? 'reviewChanged' : 'reviewUnauthorized'
  return <div className={css.hookRow} aria-busy={busy}>
    <div className={css.hookHeader}>
      <div className={css.hookIdentity}>
        <span className={css.hookId}>{hook.id}</span>
        <span className={`${css.reviewState}${hook.configuredEnabled && !hook.authorized ? ` ${css.reviewStatePending}` : ''}`}>{t(reviewKey)}</span>
      </div>
      <div className={css.controls}>
        {hook.configuredEnabled && <button ref={element => { actionElement.current = element }} className={css.authorizationAction} type="button" title={authorizationLabel}
          data-dnh-review-key={rowKey} aria-label={authorizationLabel} disabled={busy || loading}
          onClick={() => void update(() => api.setAuthorized(scopeId, hook.id, !hook.authorized, revision))}>
          {t(hook.authorized ? 'revokeAuthorizationAction' : 'reviewAuthorizationAction')}
        </button>}
        <label className={css.switch} title={enableLabel}>
          <input type="checkbox" checked={hook.configuredEnabled} disabled={busy || loading} aria-label={enableLabel}
            onChange={(event) => { void update(() => api.setConfiguredEnabled(scopeId, hook.id, event.currentTarget.checked, revision)) }} />
          <span className={css.track} aria-hidden="true" />
        </label>
        <button className={css.groupToggle} type="button" title={detailsLabel} aria-label={detailsLabel}
          aria-expanded={expanded} disabled={loading} onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
    {expanded && <div className={css.details}>
      <code className={css.command}>{hook.command}</code>
      <div className={css.detailGrid}>
        <span>{t('matcher')}: <span>{hook.matcher || t('allValues')}</span></span>
        <span>{t('timeout')}: {hook.timeoutMs} ms</span>
        <span>{t('concurrency')}: {hook.maxConcurrent}</span>
        <span>{metric(hook.stats.running, t('running'))}</span>
        <span>{metric(hook.stats.skipped, t('skipped'))}</span>
        <span>{metric(hook.stats.errors, t('errors'))}</span>
        <span>{t('lastStatus')}: {hook.stats.lastStatus ?? t('neverRun')}</span>
        <span>{t('scopeDetail')}: {scopeId}</span>
      </div>
    </div>}
  </div>
}

function scopeOption(scope: HookScopeView, allProjects: string): string {
  return `${scope.title} — ${scope.kind === 'user' ? allProjects : scope.path}`
}

function requestErrorKey(error: unknown, fallback: MessageKey): MessageKey {
  if (error instanceof HookApiError && (error.stage === 'json' || error.stage === 'envelope' || error.stage === 'schema')) {
    return 'incompatibleResponse'
  }
  return fallback
}

export function HookSettingsSection({ api, useHookReview, openReview, acceptReviewStatus, t }: HookSettingsSectionProps) {
  const [scopes, setScopes] = useState<readonly HookScopeView[]>([])
  const [selectedScopeId, setSelectedScopeId] = useState('user')
  const [status, setStatus] = useState<HookStatus | null>(null)
  const statusRef = useRef<HookStatus | null>(null)
  statusRef.current = status
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<MessageKey | null>(null)
  const [expandedByScope, setExpandedByScope] = useState<ReadonlyMap<string, ReadonlySet<HookEvent>>>(() => new Map())
  const [focusTargetKey, setFocusTargetKey] = useState<string | undefined>()
  const [focusRequest, setFocusRequest] = useState(0)
  const eventRefs = useRef(new Map<HookEvent, HTMLDivElement | null>())
  const generation = useRef(0)
  const selectedRef = useRef(selectedScopeId)
  selectedRef.current = selectedScopeId
  const sharedStatus: HookStatus | undefined = useHookReview((snapshot: HookReviewSnapshot) => snapshot.byScope[selectedScopeId])
  const currentStatus = sharedStatus ?? status

  const acceptStatus = useCallback((scopeId: string, value: HookStatus, token = generation.current) => {
    if (token !== generation.current || selectedRef.current !== scopeId || value.scope.id !== scopeId) return
    if (statusRef.current !== null && value.revision < statusRef.current.revision) return
    setStatus(value)
    acceptReviewStatus(value)
    setActionError(null)
    setExpandedByScope(previous => {
      if (previous.has(scopeId)) return previous
      const next = new Map(previous)
      next.set(scopeId, new Set(value.hooks.map(hook => hook.event)))
      return next
    })
  }, [acceptReviewStatus])

  const loadScope = useCallback(async (scopeId: string, reload: boolean, token: number) => {
    setLoading(true)
    setActionError(null)
    try { acceptStatus(scopeId, await (reload ? api.reload(scopeId) : api.status(scopeId)), token) }
    catch (error) {
      if (token === generation.current && selectedRef.current === scopeId) setActionError(requestErrorKey(error, 'unavailable'))
    }
    finally { if (token === generation.current && selectedRef.current === scopeId) setLoading(false) }
  }, [acceptStatus, api])

  useEffect(() => {
    const token = ++generation.current
    setLoading(true)
    void api.scopes().then(values => {
      if (token !== generation.current) return
      setScopes(values)
      const currentScopeId = selectedRef.current
      const nextScopeId = values.some(scope => scope.id === currentScopeId) ? currentScopeId : 'user'
      if (nextScopeId !== currentScopeId) {
        selectedRef.current = nextScopeId
        setSelectedScopeId(nextScopeId)
        setStatus(null)
      }
      return loadScope(nextScopeId, false, token)
    }, (error: unknown) => {
      if (token === generation.current) { setActionError(requestErrorKey(error, 'unavailable')); setLoading(false) }
    })
    return () => { generation.current += 1 }
  }, [api, loadScope])

  const selectScope = (scopeId: string) => {
    const token = ++generation.current
    selectedRef.current = scopeId
    setSelectedScopeId(scopeId)
    setStatus(null)
    void loadScope(scopeId, false, token)
  }

  const reload = async () => {
    const token = ++generation.current
    const scopeId = selectedRef.current
    setLoading(true)
    setActionError(null)
    try {
      const values = await api.scopes()
      if (token !== generation.current || selectedRef.current !== scopeId) return
      setScopes(values)
      if (!values.some(scope => scope.id === scopeId)) {
        selectedRef.current = 'user'
        setSelectedScopeId('user')
        setStatus(null)
        setActionError('scopeRemoved')
        const latest = await api.status('user')
        if (token === generation.current && selectedRef.current === 'user') {
          acceptStatus('user', latest, token)
          setActionError('scopeRemoved')
        }
        return
      }
      acceptStatus(scopeId, await api.reload(scopeId), token)
    } catch (error) {
      if (token === generation.current) setActionError(requestErrorKey(error, 'unavailable'))
    } finally {
      if (token === generation.current) setLoading(false)
    }
  }

  const updateStatus = (scopeId: string, value: HookStatus, token: number) => acceptStatus(scopeId, value, token)
  const handleUpdateError = async (scopeId: string, error: unknown, token: number) => {
    if (token !== generation.current || selectedRef.current !== scopeId) return
    if (error instanceof HookApiError && error.code === 'revision_conflict') {
      try {
        const latest = await api.reload(scopeId)
        if (token === generation.current && selectedRef.current === scopeId) {
          acceptStatus(scopeId, latest, token)
          setActionError('revisionConflict')
        }
      } catch (reloadError) {
        if (token === generation.current && selectedRef.current === scopeId) {
          setActionError(requestErrorKey(reloadError, 'unavailable'))
        }
      }
      return
    }
    setActionError(requestErrorKey(error, 'updateFailed'))
  }

  const pendingHooks = currentStatus?.hooks.filter(hook => hook.configuredEnabled && !hook.authorized) ?? []
  const reviewCurrentScope = () => {
    if (currentStatus === null) return
    const scopeId = currentStatus.scope.id
    const first = HOOK_EVENTS.flatMap(event => currentStatus.hooks
      .filter(hook => hook.event === event && hook.configuredEnabled && !hook.authorized)
      .map(hook => ({ event, key: `${scopeId}\0${hook.id}` }))) [0]
    if (first === undefined) return
    setExpandedByScope(previous => {
      const next = new Map(previous)
      const events = new Set(next.get(scopeId) ?? [])
      events.add(first.event)
      next.set(scopeId, events)
      return next
    })
    setFocusTargetKey(first.key)
    setFocusRequest(value => value + 1)
  }

  useLayoutEffect(() => {
    if (focusTargetKey === undefined) return
    const event = currentStatus?.hooks.find(hook => `${currentStatus.scope.id}\0${hook.id}` === focusTargetKey)?.event
    if (event === undefined) return
    const element = eventRefs.current.get(event)
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' })
  }, [currentStatus, focusRequest, focusTargetKey])

  const toggleEvent = (event: HookEvent) => setExpandedByScope(previous => {
    const next = new Map(previous)
    const events = new Set(next.get(selectedRef.current) ?? [])
    if (events.has(event)) events.delete(event); else events.add(event)
    next.set(selectedRef.current, events)
    return next
  })

  return <section className={css.section} aria-labelledby="dsh-notice-hooks-title">
    <header className={css.header}>
      <div><h2 id="dsh-notice-hooks-title" className={css.heading}>{t('title')}</h2><p className={css.description}>{t('description')}</p></div>
      <button className={css.reload} type="button" title={t('reload')} aria-label={t('reload')}
        disabled={loading || scopes.length === 0} onClick={() => { void reload() }}>
        <RefreshCw size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </header>

    {scopes.length > 0 && <div className={css.scope}>
      <label htmlFor="dnh-scope-select">{t('scope')}</label>
      <select id="dnh-scope-select" className={css.scopeSelect} aria-label={t('scope')} value={selectedScopeId}
        onChange={(event) => selectScope(event.currentTarget.value)}>
        {scopes.map(scope => <option key={scope.id} value={scope.id}>{scopeOption(scope, t('allProjects'))}</option>)}
      </select>
    </div>}

    {pendingHooks.length > 0 && <div className={css.reviewBanner} role="status">
      <span>{t(pendingHooks.length === 1 ? 'reviewCountOne' : 'reviewCountMany', { count: pendingHooks.length })}</span>
      <button className={css.reviewAction} type="button" disabled={loading} onClick={reviewCurrentScope}>{t('reviewAction')}</button>
    </div>}
    {currentStatus !== null && <div className={css.meta}><span>{t('configPath')}</span><code className={css.path}>{currentStatus.path}</code></div>}
    {loading && currentStatus === null && <div className={css.notice} role="status">{t('loading')}</div>}
    {actionError !== null && <div className={css.actionError} role="alert">{t(actionError)}</div>}
    {currentStatus !== null && !currentStatus.exists && currentStatus.scope.kind === 'workspace' && <div className={css.notice}>{t('missingProject')}</div>}
    {currentStatus?.loadError !== null && currentStatus?.loadError !== undefined && <div className={css.error} role="alert">{t('loadError')} {currentStatus.loadError}</div>}

    <div className={css.list}>
      {HOOK_EVENTS.map(event => {
        const hooks = currentStatus?.hooks.filter(hook => hook.event === event) ?? []
        const scopeId = currentStatus?.scope.id ?? selectedScopeId
        const expanded = expandedByScope.get(scopeId)?.has(event) === true
        const toggleLabel = `${t(expanded ? 'collapse' : 'expand')} ${event}`
        return <section key={event} ref={(element) => eventRefs.current.set(event, element as HTMLDivElement | null)} className={css.eventGroup} data-testid={`hook-event-${event}`} id={`dnh-event-${event}`} data-event={event}>
          <div data-testid="hook-event-group">
          <div className={css.eventHeader}>
            <button className={css.groupToggle} type="button" title={toggleLabel} aria-label={toggleLabel}
              aria-expanded={expanded} disabled={currentStatus === null || loading} onClick={() => toggleEvent(event)}>
              {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>
            <div><h3 className={css.eventName}>{event}</h3><p className={css.eventDescription} data-testid="event-description">{t(EVENT_DESCRIPTIONS[event])}</p></div>
            {hooks.length > 0 && <span className={css.count}>{hooks.length}</span>}
          </div>
          {expanded && <div className={css.eventBody}>
            {hooks.length === 0 ? <div className={css.notice}>{t('emptyEvent')}</div> : currentStatus !== null && hooks.map(hook =>
              <HookRow key={`${currentStatus.scope.id}:${hook.id}`} hook={hook} scopeId={currentStatus.scope.id} revision={currentStatus.revision}
                requestToken={generation.current} loading={loading} api={api} t={t} onStatus={updateStatus}
                onError={handleUpdateError} focusTargetKey={focusTargetKey} focusRequest={focusRequest}
                rowKey={`${currentStatus.scope.id}\0${hook.id}`} />)}
          </div>}
          </div>
        </section>
      })}
    </div>
  </section>
}
