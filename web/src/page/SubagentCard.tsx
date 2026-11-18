import * as React from 'react'
import type { SubagentReadRequest } from '../../../shared/contracts'
import { useT } from '../i18n'
import type { Api } from '../rpc'
import {
  applySubagentEvent, mergeHistoryTurns, mergeSubagentTurns, subagentStatus,
  type LiveSubagent, type Subagent, type SubscribeSubagentEvents,
} from '../subagents'
import type { CodexItem, CodexThread, CodexTurn, SubagentDetail } from '../types'
import { itemText } from '../utils'
import { ItemCard, Message } from './ItemCard'
import { groupActivity, ToolGroup } from './ToolGroup'

const REFRESH_MS = 4000

export function SubagentCard({ agent, parentThreadId, parentRunning, api, subscribe, onExpand }: {
  agent: Subagent
  parentThreadId: string
  parentRunning: boolean
  api: Api
  subscribe: SubscribeSubagentEvents
  onExpand: () => void
}) {
  const t = useT()
  const bodyId = React.useId()
  const agentThreadId = agent.id
  const [open, setOpen] = React.useState(false)
  const [metadata, setMetadata] = React.useState<CodexThread | null>(null)
  const [lastKnownTurnStatus, setLastKnownTurnStatus] = React.useState<string | null>(null)
  const [liveStatus, setLiveStatus] = React.useState<CodexThread['status']>(null)
  const statusRevision = React.useRef(0)
  const [snapshot, setSnapshot] = React.useState<SubagentDetail | null>(null)
  const [older, setOlder] = React.useState<{ turns: CodexTurn[], nextCursor: string | null } | null>(null)
  const [live, setLive] = React.useState<LiveSubagent>(() => ({ thread: { id: agentThreadId }, turns: [] }))
  const [loading, setLoading] = React.useState(false)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [olderError, setOlderError] = React.useState(false)
  const currentRequest = React.useRef<AbortController | null>(null)
  const olderRequest = React.useRef<AbortController | null>(null)

  const read = React.useCallback((options: Pick<SubagentReadRequest, 'cursor' | 'metadataOnly'>, signal: AbortSignal) => {
    const request: SubagentReadRequest = { parentThreadId, agentThreadId, ...options }
    return api<SubagentDetail>('threads/subagent/get', request, { signal })
  }, [api, parentThreadId, agentThreadId])

  React.useEffect(() => {
    const controller = new AbortController()
    const revision = statusRevision.current
    void read({ metadataOnly: true }, controller.signal).then(next => {
      if (controller.signal.aborted) return
      setMetadata(next.thread)
      setLastKnownTurnStatus(next.latestTurnStatus ?? null)
      if (revision === statusRevision.current) setLiveStatus(null)
    }).catch(() => {})
    return () => controller.abort()
  }, [read, agent.activityId])

  const refresh = React.useCallback(async () => {
    if (currentRequest.current) return
    const controller = new AbortController()
    currentRequest.current = controller
    const revision = statusRevision.current
    setLoading(true)
    setError(false)
    try {
      const next = await read({}, controller.signal)
      if (controller.signal.aborted) return
      setSnapshot(previous => previous ? {
        ...next, turns: mergeHistoryTurns(previous.turns, next.turns),
        nextCursor: previous.turns.length > 0 ? previous.nextCursor : next.nextCursor,
      } : next)
      if (revision === statusRevision.current && next.thread.status?.type !== 'notLoaded') setLiveStatus(null)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (currentRequest.current === controller) {
        currentRequest.current = null
        setLoading(false)
      }
    }
  }, [read])

  const refreshNow = React.useCallback(() => {
    currentRequest.current?.abort()
    currentRequest.current = null
    void refresh()
  }, [refresh])

  React.useEffect(() => subscribe(agentThreadId, event => {
    if (event.type === 'resync') {
      if (open) {
        setLive(dropOpenItems)
        refreshNow()
      }
      return
    }
    if (event.type === 'thread/upsert') {
      statusRevision.current++
      setMetadata(event.payload.thread)
      setLiveStatus(event.payload.thread.status)
    } else if (event.type === 'thread/status') {
      statusRevision.current++
      setLiveStatus(event.payload?.status ?? null)
    }
    if (open || event.type.startsWith('turn/')) setLive(previous => applySubagentEvent(previous, event))
    if (open && event.type === 'turn/completed') refreshNow()
  }), [agentThreadId, open, refreshNow, subscribe])

  React.useEffect(() => {
    if (!open) {
      setLive(dropOpenItems)
      setLoading(false)
      setLoadingOlder(false)
      return
    }
    return () => {
      currentRequest.current?.abort()
      currentRequest.current = null
      olderRequest.current?.abort()
      olderRequest.current = null
    }
  }, [open, refresh])

  React.useEffect(() => {
    if (open) refreshNow()
  }, [open, refreshNow, agent.activityId, agent.status])

  const turns = React.useMemo(() => {
    const recent = mergeSubagentTurns(snapshot?.turns ?? [], live.turns)
    const recentIds = new Set(recent.map(turn => turn.id))
    return [...(older?.turns.filter(turn => !recentIds.has(turn.id)) ?? []), ...recent]
  }, [snapshot, live, older])
  const thread = snapshot?.thread ?? metadata
  const status = subagentStatus(turns.at(-1)?.status ?? lastKnownTurnStatus, liveStatus ?? thread?.status ?? null, agent.status)

  const shouldPoll = status === 'running' || parentRunning && (status === 'starting' || status === 'idle')
  React.useEffect(() => {
    if (!open || !shouldPoll) return
    const timer = window.setInterval(() => { void refresh() }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [open, refresh, shouldPoll])

  const cursor = older === null ? snapshot?.nextCursor : older.nextCursor
  const loadOlder = async () => {
    if (!cursor || olderRequest.current) return
    const controller = new AbortController()
    olderRequest.current = controller
    setLoadingOlder(true)
    setOlderError(false)
    try {
      const page = await read({ cursor }, controller.signal)
      if (!controller.signal.aborted) setOlder(previous => ({
        turns: mergeHistoryTurns(page.turns, previous?.turns ?? []),
        nextCursor: page.nextCursor,
      }))
    } catch {
      if (!controller.signal.aborted) setOlderError(true)
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = null
        setLoadingOlder(false)
      }
    }
  }

  const name = metadata?.agentNickname || thread?.agentNickname || agent.name
  const cwd = thread?.cwd ?? ''
  const hasVisibleItems = turns.some(turn => turn.items?.some(isVisible))
  const hasTask = turns.some(turn => turn.items?.some(item => item.type === 'userMessage' && itemText(item)))
  const hasResult = turns.some(turn => turn.items?.some(item => item.type === 'agentMessage' && item.phase !== 'commentary' && item.text))
  const labels = { user: t('subagent.task'), progress: t('subagent.progress'), answer: t('subagent.result') }
  return (
    <section className="dsh-codex-block dsh-codex-subagent" aria-label={t('subagent.label', { name })}>
      <button type="button" className="dsh-codex-block-head dsh-codex-subagent-head" aria-expanded={open} aria-controls={bodyId}
        onClick={() => {
          if (!open) onExpand()
          setOpen(!open)
        }}>
        <span className="dsh-codex-caret" aria-hidden="true" />
        <span className="dsh-codex-subagent-name" title={name}>{t('subagent.label', { name })}</span>
        <span className="dsh-codex-subagent-state">{t('subagent.status.' + status)}</span>
      </button>
      <div className="dsh-codex-block-body dsh-codex-subagent-body" id={bodyId} hidden={!open}>
        {open && <>
          {cursor && <button type="button" className="dsh-codex-load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {t(loadingOlder ? 'thread.loadingOlder' : olderError ? 'subagent.retryOlder' : 'thread.loadOlder')}
          </button>}
          {loading && !snapshot && !hasVisibleItems && <div role="status">{t('subagent.loading')}</div>}
          {error && <div role="alert" className="dsh-codex-subagent-error">
            <span>{t('subagent.error')}</span> <button type="button" onClick={() => void refresh()}>{t('error.retry')}</button>
          </div>}
          {snapshot?.historyAvailable === false && <div role="status">{t('subagent.historyUnavailable')}</div>}
          {snapshot?.historyAvailable && !hasVisibleItems && !agent.prompt && !agent.result && <div role="status">{t('subagent.empty')}</div>}
          {!hasTask && agent.prompt && <Message kind="user" label={labels.user} text={agent.prompt} api={api} cwd={cwd} />}
          {turns.flatMap(turn => groupActivity((turn.items ?? []).filter(isVisible)).map(entry =>
            entry.kind === 'group'
              ? <ToolGroup key={turn.id + ':' + entry.key} items={entry.items} api={api} />
              : <ItemCard key={turn.id + ':' + entry.item.id} item={entry.item} api={api} cwd={cwd} messageLabels={labels} />,
          ))}
          {!hasResult && agent.result && <Message kind="assistant" label={labels.answer} text={agent.result} api={api} cwd={cwd} />}
        </>}
      </div>
    </section>
  )
}

function dropOpenItems(live: LiveSubagent): LiveSubagent {
  return {
    ...live,
    turns: live.turns.map(turn => ({ ...turn, items: turn.items?.filter(item => item.streaming !== true) })),
  }
}

function isVisible(item: CodexItem): boolean {
  const { type } = item
  if (type === 'agentMessage') return Boolean(item.text?.trim() || item.questions?.length)
  if (type === 'userMessage') return Boolean(itemText(item).trim() || item.content?.some(part => part.path))
  return type === 'commandExecution' ||
    type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall' ||
    type === 'functionCallOutput' || type === 'webSearch' || type === 'plan' || type === 'imageView'
}
