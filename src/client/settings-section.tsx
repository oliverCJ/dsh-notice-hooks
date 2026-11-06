import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.js'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.js'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { HOOK_EVENTS, type HookEvent } from '../config.js'
import { HookApiError, type HookApi, type HookScopeView, type HookStatus, type HookView } from './api.js'
import type { MessageKey } from './i18n.js'

const css = {
  actionError: 'dnh-action-error', command: 'dnh-command', controls: 'dnh-controls', count: 'dnh-count',
  description: 'dnh-description', details: 'dnh-details', detailGrid: 'dnh-detail-grid', error: 'dnh-error',
  eventBody: 'dnh-event-body', eventDescription: 'dnh-event-description', eventGroup: 'dnh-event-group',
  eventHeader: 'dnh-event-header', eventName: 'dnh-event-name', groupToggle: 'dnh-group-toggle', header: 'dnh-header',
  heading: 'dnh-heading', hookHeader: 'dnh-hook-header', hookId: 'dnh-hook-id', hookRow: 'dnh-hook-row',
  list: 'dnh-list', meta: 'dnh-meta', notice: 'dnh-notice', path: 'dnh-path', reload: 'dnh-reload',
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
  readonly t: (key: MessageKey) => string
}

function metric(value: number, label: string): string { return `${value} ${label}` }

function HookRow({ hook, scopeId, revision, requestToken, loading, api, t, onStatus, onError }: {
  readonly hook: HookView
  readonly scopeId: string
  readonly revision: number
  readonly loading: boolean
  readonly api: HookApi
  readonly t: HookSettingsSectionProps['t']
  readonly requestToken: number
  readonly onStatus: (scopeId: string, status: HookStatus, token: number) => void
  readonly onError: (scopeId: string, error: unknown, token: number) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const change = async (enabled: boolean) => {
    setBusy(true)
    try { onStatus(scopeId, await api.setEnabled(scopeId, hook.id, enabled, revision), requestToken) }
    catch (error) { await onError(scopeId, error, requestToken) }
    finally { setBusy(false) }
  }
  const enableLabel = `${t('enable')} ${hook.id}`
  const detailsLabel = `${t(expanded ? 'hideDetails' : 'showDetails')} ${hook.id}`
  return <div className={css.hookRow} aria-busy={busy}>
    <div className={css.hookHeader}>
      <span className={css.hookId}>{hook.id}</span>
      <div className={css.controls}>
        <label className={css.switch} title={enableLabel}>
          <input type="checkbox" checked={hook.enabled} disabled={busy || loading} aria-label={enableLabel}
            onChange={(event) => { void change(event.currentTarget.checked) }} />
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

export function HookSettingsSection({ api, t }: HookSettingsSectionProps) {
  const [scopes, setScopes] = useState<readonly HookScopeView[]>([])
  const [selectedScopeId, setSelectedScopeId] = useState('user')
  const [status, setStatus] = useState<HookStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<MessageKey | null>(null)
  const [expandedByScope, setExpandedByScope] = useState<ReadonlyMap<string, ReadonlySet<HookEvent>>>(() => new Map())
  const generation = useRef(0)
  const selectedRef = useRef(selectedScopeId)
  selectedRef.current = selectedScopeId

  const acceptStatus = useCallback((scopeId: string, value: HookStatus, token = generation.current) => {
    if (token !== generation.current || selectedRef.current !== scopeId || value.scope.id !== scopeId) return
    setStatus(value)
    setActionError(null)
    setExpandedByScope(previous => {
      if (previous.has(scopeId)) return previous
      const next = new Map(previous)
      next.set(scopeId, new Set(value.hooks.map(hook => hook.event)))
      return next
    })
  }, [])

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

    {status !== null && <div className={css.meta}><span>{t('configPath')}</span><code className={css.path}>{status.path}</code></div>}
    {loading && status === null && <div className={css.notice} role="status">{t('loading')}</div>}
    {actionError !== null && <div className={css.actionError} role="alert">{t(actionError)}</div>}
    {status !== null && !status.exists && status.scope.kind === 'workspace' && <div className={css.notice}>{t('missingProject')}</div>}
    {status?.loadError !== null && status?.loadError !== undefined && <div className={css.error} role="alert">{t('loadError')} {status.loadError}</div>}

    <div className={css.list}>
      {HOOK_EVENTS.map(event => {
        const hooks = status?.hooks.filter(hook => hook.event === event) ?? []
        const scopeId = status?.scope.id ?? selectedScopeId
        const expanded = expandedByScope.get(scopeId)?.has(event) === true
        const toggleLabel = `${t(expanded ? 'collapse' : 'expand')} ${event}`
        return <section key={event} className={css.eventGroup} data-testid={`hook-event-${event}`} id={`dnh-event-${event}`} data-event={event}>
          <div data-testid="hook-event-group">
          <div className={css.eventHeader}>
            <button className={css.groupToggle} type="button" title={toggleLabel} aria-label={toggleLabel}
              aria-expanded={expanded} disabled={status === null || loading} onClick={() => toggleEvent(event)}>
              {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>
            <div><h3 className={css.eventName}>{event}</h3><p className={css.eventDescription} data-testid="event-description">{t(EVENT_DESCRIPTIONS[event])}</p></div>
            {hooks.length > 0 && <span className={css.count}>{hooks.length}</span>}
          </div>
          {expanded && <div className={css.eventBody}>
            {hooks.length === 0 ? <div className={css.notice}>{t('emptyEvent')}</div> : status !== null && hooks.map(hook =>
              <HookRow key={`${status.scope.id}:${hook.id}`} hook={hook} scopeId={status.scope.id} revision={status.revision}
                requestToken={generation.current} loading={loading} api={api} t={t} onStatus={updateStatus} onError={handleUpdateError} />)}
          </div>}
          </div>
        </section>
      })}
    </div>
  </section>
}
