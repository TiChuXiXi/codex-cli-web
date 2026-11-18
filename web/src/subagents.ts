import type { CodexEvent, CodexItem, CodexThread, CodexTurn } from './types'
import { applyDetailEvent } from './utils'

export type SubscribeSubagentEvents = (id: string, listener: (event: CodexEvent) => void) => () => void

export type AgentStatus = 'unknown' | 'starting' | 'running' | 'idle' | 'completed' | 'interrupted' | 'failed' | 'closed'

export interface Subagent {
  id: string
  activityId: string
  name: string
  status: AgentStatus
  prompt?: string
  result?: string
}

export function isSubagentActivity(item: CodexItem): boolean {
  return item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall'
}

const legacyStatus = new Map<string, AgentStatus>([
  ['pendingInit', 'starting'], ['running', 'running'], ['completed', 'completed'],
  ['interrupted', 'interrupted'], ['errored', 'failed'], ['shutdown', 'closed'],
])

export function collectSubagents(items: CodexItem[], parentId: string, ancestorId?: string | null): Map<string, Subagent[]> {
  const anchors = new Map<string, Subagent[]>()
  const agents = new Map<string, Subagent>()
  for (const item of items) {
    if (!isSubagentActivity(item)) continue
    const native = item.type === 'subAgentActivity'
    if (!native && item.senderThreadId !== parentId) continue
    const startsAgent = native ? item.kind === 'started' : item.tool === 'spawnAgent'
    const targets = native ? [item.agentThreadId] : Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    for (const id of targets) {
      if (typeof id !== 'string' || !id || id === parentId || id === ancestorId) continue
      let agent = agents.get(id)
      if (!agent && startsAgent) {
        const pathName = typeof item.agentPath === 'string' ? item.agentPath.split('/').filter(Boolean).at(-1) : null
        agent = { id, activityId: item.id, name: pathName ?? id.slice(0, 8), status: 'starting' }
        agents.set(id, agent)
        anchors.set(item.id, [...(anchors.get(item.id) ?? []), agent])
      }
      if (!agent) continue
      agent.activityId = item.id
      if (native) {
        if (item.kind === 'started') agent.status = 'starting'
        if (item.kind === 'completed' || item.kind === 'interrupted') agent.status = item.kind
      } else {
        const states = item.agentsStates as Record<string, { status?: string, message?: string }> | undefined
        const state = states?.[id]
        const status = state?.status ? legacyStatus.get(state.status) : undefined
        if (status) agent.status = status
        if (state?.message && status === 'completed') agent.result = state.message
        if (startsAgent && typeof item.prompt === 'string') agent.prompt = item.prompt
      }
    }
  }
  return anchors
}

export interface LiveSubagent {
  thread: { id: string }
  turns: CodexTurn[]
}

export function applySubagentEvent(live: LiveSubagent, event: CodexEvent): LiveSubagent {
  if (event.threadId !== live.thread.id) return live
  if (event.type === 'turn/completed' && event.payload?.turn &&
      !live.turns.some(turn => turn.id === event.payload.turn.id)) {
    return { ...live, turns: [...live.turns, { ...event.payload.turn, items: [] }] }
  }
  return applyDetailEvent(live, event) ?? live
}

export function mergeHistoryTurns(older: CodexTurn[], newer: CodexTurn[]): CodexTurn[] {
  const turns = new Map(older.map(turn => [turn.id, turn]))
  for (const turn of newer) turns.set(turn.id, turn)
  return sortTurns([...turns.values()])
}

/** Keep the live delta accumulator separate from snapshots, which can already contain the same bytes. */
export function mergeSubagentTurns(history: CodexTurn[], live: CodexTurn[]): CodexTurn[] {
  const turns = new Map(history.map(turn => [turn.id, turn]))
  for (const update of live) {
    const previous = turns.get(update.id)
    if (!previous) {
      turns.set(update.id, update)
      continue
    }
    const settled = previous.status && previous.status !== 'inProgress'
    const items = new Map((previous.items ?? []).map(item => [item.id, item]))
    for (const incoming of update.items ?? []) {
      const existing = items.get(incoming.id)
      if (!existing || incoming.streaming === false) {
        items.set(incoming.id, { ...existing, ...incoming })
      } else if (!settled && !existing.completedAtMs && existing.streaming !== false) {
        const text = longerPrefix(existing.text, incoming.text)
        const output = longerPrefix(existing.aggregatedOutput, incoming.aggregatedOutput)
        items.set(incoming.id, { ...existing, ...incoming, text: text ?? undefined, aggregatedOutput: output })
      }
    }
    turns.set(update.id, {
      ...previous, ...update,
      status: settled ? previous.status : update.status ?? previous.status,
      startedAt: previous.startedAt ?? update.startedAt,
      items: [...items.values()],
    })
  }
  return sortTurns([...turns.values()])
}

function sortTurns(turns: CodexTurn[]): CodexTurn[] {
  return turns.sort((a, b) => (a.startedAt ?? a.completedAt ?? Infinity) - (b.startedAt ?? b.completedAt ?? Infinity))
}

function longerPrefix(snapshot: string | null | undefined, live: string | null | undefined): string | null | undefined {
  return snapshot && (!live || snapshot.startsWith(live)) ? snapshot : live ?? snapshot
}

export function subagentStatus(turnStatus: string | null, thread: CodexThread['status'], activity: AgentStatus): AgentStatus {
  if (thread?.type === 'systemError') return 'failed'
  if (turnStatus === 'inProgress') return 'running'
  if (activity === 'closed') return 'closed'
  if (turnStatus === 'completed' || turnStatus === 'interrupted' || turnStatus === 'failed') return turnStatus
  if (thread?.type === 'active') return 'running'
  if (thread?.type === 'idle' && (activity === 'starting' || activity === 'running')) return 'idle'
  return activity
}
