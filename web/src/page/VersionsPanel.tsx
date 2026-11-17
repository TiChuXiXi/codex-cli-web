/** 设置页的版本面板：版本探测、升级/回滚、守护进程动作和体检。 */

import * as React from 'react'
import { Icon } from '../components/Icon'
import { VERSIONS_CSS } from './versionsStyles'
import { useT } from '../i18n'
import type { Api } from '../rpc'

interface VersionCheck {
  cli: { version: string | null, raw: string }
  daemon: { status?: string, cliVersion?: string, appServerVersion?: string, socketPath?: string, managedCodexPath?: string } | null
  latest: { version: string, source: string } | null
  updateAvailable: boolean
  install: { context: string | null, executable: string | null, updateAction: string | null, cachedLatest: string | null } | null
  doctor: {
    overallStatus: string
    codexVersion: string | null
    checks: Array<{ id: string, category: string, status: string, summary: string, remediation: string | null }>
    updates: Record<string, string> | null
  } | null
  checkedAt: number
}

interface JobState {
  jobId: string
  kind: string
  status: 'running' | 'done' | 'error'
  command: string
  exitCode: number | null
  lines: string[]
}

export interface VersionsPanelProps { api: Api }

export function VersionsPanel({ api }: VersionsPanelProps) {
  const t = useT()
  const [check, setCheck] = React.useState<VersionCheck | null>(null)
  const titleId = React.useId()
  const rollbackId = React.useId()
  const [submitting, setSubmitting] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activeTurns, setActiveTurns] = React.useState<Array<{ id: string, name: string | null, cwd: string }>>([])
  const [job, setJob] = React.useState<JobState | null>(null)
  const [rollbackVersion, setRollbackVersion] = React.useState('')
  const [pendingDaemon, setPendingDaemon] = React.useState<string | null>(null)
  const [lastAction, setLastAction] = React.useState<{ endpoint: string, payload: Record<string, unknown> } | null>(null)
  const pollRef = React.useRef<number | null>(null)
  const pollGeneration = React.useRef(0)
  const pollFailed = React.useRef(false)
  const logRef = React.useRef<HTMLPreElement | null>(null)

  const load = React.useCallback(
    async (refresh = false) => {
      setLoading(true)
      setError(null)
      try {
        const value = await api<VersionCheck>('versions/check', { refresh })
        setCheck(value)
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setLoading(false)
      }
    },
    [api],
  )

  React.useEffect(() => {
    void load(false)
  }, [load])

  React.useEffect(
    () => () => {
      pollGeneration.current += 1
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    },
    [],
  )

  const pollJob = React.useCallback(
    (jobId: string) => {
      const generation = ++pollGeneration.current
      let inFlight = false
      pollFailed.current = false
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        if (inFlight || generation !== pollGeneration.current) return
        inFlight = true
        try {
          const state = await api<JobState>('versions/job', { jobId })
          if (generation !== pollGeneration.current) return
          if (pollFailed.current) { pollFailed.current = false; setError(null) }
          setJob(state)
          if (state.status !== 'running') {
            if (pollRef.current !== null) window.clearInterval(pollRef.current)
            pollRef.current = null
            void load(true)
          }
        } catch (cause) {
          if (generation !== pollGeneration.current) return
          pollFailed.current = true
          setError('任务状态读取失败，正在重试。状态尚未确认，请勿重复执行更新。' + messageOf(cause))
        } finally { inFlight = false }
      }, 1000)
    },
    [api, load],
  )

  const startJob = React.useCallback(
    async (endpoint: string, payload: Record<string, unknown>) => {
      setSubmitting(true)
      setPendingDaemon(null)
      setError(null)
      setActiveTurns([])
      setLastAction({ endpoint, payload })
      try {
        const result = await api<{ jobId: string }>(endpoint, payload)
        setJob({ jobId: result.jobId, kind: endpoint === 'daemon/action' ? `daemon-${payload.action}` : endpoint.split('/')[1], status: 'running', command: '', exitCode: null, lines: [] })
        pollJob(result.jobId)
      } catch (cause) {
        const failure = cause as Error & { code?: string, details?: any }
        if (failure.code === 'codex-cli/active-turns') {
          setActiveTurns(failure.details?.threads ?? [])
        }
        setError(messageOf(cause))
      } finally {
        setSubmitting(false)
      }
    },
    [api, pollJob],
  )

  React.useEffect(() => {
    const element = logRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [job?.lines.length])

  const doctor = check?.doctor ?? null
  const problems = doctor?.checks.filter((entry) => entry.status !== 'ok') ?? []
  const daemonVersion = check?.daemon?.appServerVersion ?? check?.daemon?.cliVersion ?? null
  const busy = submitting || job?.status === 'running'
  const knownVersion = check?.latest != null && check?.cli.version != null
  const updateState = check?.updateAvailable ? 'available' : knownVersion ? 'current' : 'unknown'
  const daemonMismatch = daemonVersion !== null && check?.cli.version != null && daemonVersion !== check.cli.version
  const doctorState = doctor === null ? 'unknown' : doctor.overallStatus === 'ok' ? 'ok' : doctor.overallStatus === 'warning' ? 'warn' : 'error'
  const jobLabel = job?.kind === 'update' ? t('versions.update')
    : job?.kind === 'rollback' ? t('versions.rollback')
      : job?.kind === 'daemon-update' ? t('versions.daemonUpdate')
        : job?.kind === 'daemon-restart' ? t('versions.restart')
          : job?.kind === 'daemon-stop' ? t('versions.stop') : t('versions.job')

  return (
    <section className="dsh-codex-versions settings-versions" aria-labelledby={titleId}>
      <style>{VERSIONS_CSS}</style>
        <header className="versions-header">
          <div><h2 id={titleId}>版本与更新</h2><p>{t('versions.subtitle')}</p></div>
        </header>

        <div className="versions-body">
          {error !== null ? <div className="versions-error" role="alert">
            <Icon name="circleAlert" size={18} /><div>{error}
              {activeTurns.length > 0 ? <div className="versions-force">
                <span>{t('versions.activeTurns', { count: activeTurns.length })}</span>
                <button type="button" className="dsh-codex-button danger" disabled={busy} onClick={() => {
                  if (lastAction !== null) void startJob(lastAction.endpoint, { ...lastAction.payload, force: true })
                }}>{t('versions.force')}</button>
              </div> : null}
              {check === null ? <button type="button" className="dsh-codex-button" disabled={loading} onClick={() => void load(true)}>{t('versions.check')}</button> : null}
            </div>
          </div> : null}

          {check === null && loading ? <div className="versions-loading" role="status"><Icon name="loader" className="versions-spinner" size={22} /><div><span>{t('versions.checking')}</span><p>{t('versions.checkingHint')}</p></div></div> : null}
          {check !== null ? <>
            <section className={`versions-update is-${updateState}`} aria-busy={loading}>
              <div className="versions-update-heading">
                <span className="versions-state-icon"><Icon name={updateState === 'available' ? 'download' : updateState === 'current' ? 'circleCheck' : 'info'} size={24} /></span>
                <div>
                  <h3>{updateState === 'available' ? t('versions.updateAvailable', { version: check.latest?.version ?? '—' })
                    : updateState === 'current' ? t('versions.upToDate') : t('versions.unknownLatest')}</h3>
                  <p>{t('versions.currentVersion', { version: check.cli.version ?? '—' })}</p>
                </div>
              </div>
              <div className="versions-update-actions">
                {check.updateAvailable ? <button type="button" className="dsh-codex-button primary" disabled={busy || loading}
                  onClick={() => void startJob('versions/update', {})}><Icon name="download" size={16} />{t('versions.updateNow')}</button> : null}
                <button type="button" className="dsh-codex-button" disabled={loading || busy} onClick={() => void load(true)}>
                  <Icon name={loading ? 'loader' : 'refresh'} className={loading ? 'versions-spinner' : undefined} size={15} />{loading ? t('versions.checking') : t('versions.check')}
                </button>
              </div>
            </section>

            {job !== null ? <section className={`versions-task is-${job.status}`} aria-label={t('versions.job')}>
              <div className="versions-section-heading" role="status">
                <h3><Icon name={job.status === 'running' ? 'loader' : job.status === 'done' ? 'circleCheck' : 'circleAlert'} className={job.status === 'running' ? 'versions-spinner' : undefined} size={17} />{jobLabel}</h3>
                <span>{job.status === 'running' ? (pollFailed.current ? '状态待确认' : t('versions.running')) : job.status === 'done' ? t('versions.done') : t('versions.failed', { code: job.exitCode ?? '?' })}</span>
              </div>
              {job.status === 'done' && (job.kind === 'update' || job.kind === 'rollback') ? <p className="versions-task-hint">{t('versions.updatedHint')}</p> : null}
              <details className="versions-log" open={job.status !== 'done'}>
                <summary>{t('versions.job')}</summary>
                <pre ref={logRef} tabIndex={0}>{job.lines.length > 0 ? job.lines.join('\n') : t('versions.waitingOutput')}</pre>
              </details>
            </section> : null}

            <section className="versions-environment">
              <div className="versions-section-heading"><h3>{t('versions.environment')}</h3></div>
              <dl className="versions-facts">
                <div><dt>{t('versions.cli')}</dt><dd>{check.cli.version ?? '—'}</dd></div>
                <div><dt>{t('versions.latest')}</dt><dd>{check.latest?.version ?? '—'}</dd></div>
                <div><dt>{t('versions.channel')}</dt><dd title={check.install?.context ?? undefined}>{installLabel(check.install?.context)}</dd></div>
              </dl>
              <div className="versions-daemon">
                <div><span>{t('versions.daemon')}</span><strong>{daemonVersion ?? '—'}</strong>
                  {daemonMismatch ? <small>{t('versions.daemonMismatch')}</small> : null}
                </div>
                <div className="versions-daemon-actions">
                  <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => setPendingDaemon('restart')}><Icon name="refresh" size={14} />{t('versions.restart')}</button>
                  <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => setPendingDaemon('update')}>{t('versions.daemonUpdate')}</button>
                  <button type="button" className="dsh-codex-button danger" disabled={busy} onClick={() => setPendingDaemon('stop')}>{t('versions.stop')}</button>
                </div>
              </div>
              {pendingDaemon !== null ? <div className="versions-confirm" role="alert">
                <p>{pendingDaemon === 'restart' ? t('versions.confirmRestart') : pendingDaemon === 'update' ? t('versions.confirmUpdate') : t('versions.confirmStop')}</p>
                <div>
                  <button type="button" className="dsh-codex-button" onClick={() => setPendingDaemon(null)}>{t('versions.cancel')}</button>
                  <button type="button" className="dsh-codex-button primary" disabled={busy} onClick={() => {
                    const action = pendingDaemon
                    setPendingDaemon(null)
                    void startJob('daemon/action', { action })
                  }}>{t('versions.confirm')}</button>
                </div>
              </div> : null}
            </section>

            <section className="versions-health">
              <div className="versions-section-heading"><h3><Icon name="shield" size={17} />{t('versions.doctor')}</h3>
                <span className={`versions-badge is-${doctorState}`}>{doctorState === 'unknown' ? t('versions.notAvailable') : doctorState === 'ok' ? t('versions.doctorOk') : doctorState === 'warn' ? t('versions.doctorWarn') : t('versions.doctorError')}</span>
              </div>
              {problems.map((entry) => <div key={entry.id} className="versions-check">
                <Icon name={entry.status === 'error' ? 'circleAlert' : 'info'} size={16} className={entry.status === 'error' ? 'versions-error-text' : 'versions-warning-text'} />
                <div><code>{entry.id}</code><p>{entry.summary}</p>{entry.remediation ? <p className="versions-remediation">{entry.remediation}</p> : null}</div>
              </div>)}
              {doctor !== null && problems.length === 0 ? <p className="versions-muted">{t('versions.checksOk', { count: doctor.checks.length })}</p> : null}
            </section>

            <details className="versions-advanced">
              <summary><Icon name="history" size={17} /><span>{t('versions.advanced')}</span><Icon name="chevronDown" size={16} /></summary>
              <div className="versions-rollback">
                <p>{t('versions.rollbackHint')}</p>
                <label htmlFor={rollbackId}>{t('versions.targetVersion')}</label>
                <form onSubmit={(event) => { event.preventDefault(); if (rollbackVersion.trim() !== '' && !busy) void startJob('versions/rollback', { version: rollbackVersion.trim() }) }}>
                  <input id={rollbackId} className="dsh-codex-search" value={rollbackVersion} placeholder={t('versions.rollbackPlaceholder')} onChange={(event) => setRollbackVersion(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} />
                  <button type="submit" className="dsh-codex-button" disabled={rollbackVersion.trim() === '' || busy}>{t('versions.rollback')}</button>
                </form>
              </div>
            </details>
          </> : null}
        </div>

        <footer className="versions-footer">
          <span className="versions-muted">{check !== null ? t('versions.checkedAt', { time: new Date(check.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('versions.checking')}</span>
        </footer>
    </section>
  )
}

function installLabel(context: string | null | undefined): string {
  if (typeof context !== 'string' || context === '') return '—'
  return context.split(' ')[0]
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
