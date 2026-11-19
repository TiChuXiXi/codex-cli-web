import { routerNamespace, toolNames } from './tools.js'

const terminal = new Set(['completed', 'failed', 'interrupted'])
const privateItems = new Set(['reasoning', 'plan', 'contextCompaction', 'sleep', 'hookPrompt'])

function body(item) {
  return item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim() ? item : undefined
}

export function stageRouterAnswer(source, item) {
  if (item?.type === 'userMessage' || privateItems.has(item?.type)) return
  const message = body(item)
  if (message?.phase === 'final_answer' || source.answer?.phase !== 'final_answer') {
    source.answer = message && (!message.phase || message.phase === 'final_answer')
      ? { type: 'agentMessage', phase: message.phase, text: message.text.slice(0, 24000) }
      : null
  }
}

export function routerTurnAnswer(items = [], staged) {
  const explicit = items.findLast(item => item.phase === 'final_answer' && body(item))
  if (explicit) return explicit
  if (staged?.phase === 'final_answer') return staged
  const last = items.findLast(item => item.type !== 'userMessage' && !privateItems.has(item.type))
  if (staged === null && !items.some(item => item.type === 'dynamicToolCall')) return undefined
  return last ? (!last.phase ? body(last) : undefined) : staged ?? undefined
}

export function toolOutcome(response) {
  let value
  try { value = JSON.parse(response.contentItems?.[0]?.text) } catch {}
  const safe = text => typeof text === 'string' && /^[a-z][\w:/.-]{0,79}$/i.test(text) ? text : undefined
  return { success: response.success, code: safe(value?.code), status: safe(value?.status) }
}

function archivedTool(turn, item) {
  if (item.type !== 'dynamicToolCall' || (item.namespace != null && item.namespace !== routerNamespace) ||
      !toolNames.includes(item.tool)) return null
  return {
    id: 'history-tool:' + turn.id + ':' + item.id, turnId: turn.id, role: 'assistant', text: '', status: 'completed',
    tool: { name: item.tool, status: item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'completed' : 'interrupted',
      ...(typeof item.success === 'boolean' && { outcome: { success: item.success } }) },
  }
}

export async function recoverLegacyOutput(store, app, threadId, isCurrent) {
  const rows = store.list('message', 80).reverse().filter(row => !row.turnId && row.role === 'assistant' &&
    (!row.routerThreadId || row.routerThreadId === threadId) && !store.get('legacy-output', row.id))
  const agents = new Map(rows.filter(row => row.id.startsWith('agent:')).map(row => [row.id, row]))
  const receipts = new Map()
  for (const row of rows) {
    if (!row.id.startsWith('receipt:')) continue
    const batch = store.get('wake', row.id.slice('receipt:'.length))
    if (batch?.routerThreadId === threadId && batch.turnId) receipts.set(batch.turnId, row)
  }
  if (!agents.size && !receipts.size) return

  let cursor
  for (let page = 0; page < 6; page++) {
    const history = await app.request('thread/turns/list', {
      threadId, limit: 30, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}),
    })
    if (!isCurrent()) return
    for (const turn of history.data ?? []) {
      if (!terminal.has(turn.status)) continue
      const items = turn.items ?? []
      const receipt = receipts.get(turn.id)
      const anchors = receipt ? [receipt] : items.map(item => agents.get('agent:' + item.id)).filter(Boolean)
      if (!anchors.length) continue
      const durationMs = turn.durationMs ?? (Number.isFinite(turn.startedAt) && Number.isFinite(turn.completedAt)
        ? Math.max(0, turn.completedAt - turn.startedAt) * 1000 : undefined)
      const output = items.flatMap(item => {
        const tool = archivedTool(turn, item)
        if (tool) return [tool]
        if (!body(item) || (receipt && item.phase !== 'commentary')) return []
        const id = 'agent:' + item.id
        return [{ ...agents.get(id), id, role: 'assistant', text: item.text.slice(0, 24000), status: 'completed',
          phase: item.phase, turnId: turn.id, durationMs }]
      })
      if (receipt) output.push({ ...receipt, turnId: turn.id, phase: 'final_answer', durationMs })
      store.transaction(() => {
        anchors.forEach((anchor, index) => store.put('legacy-output', anchor.id, { messages: index === 0 ? output : [] }))
      })
      for (const anchor of anchors) agents.delete(anchor.id)
      receipts.delete(turn.id)
    }
    if ((!agents.size && !receipts.size) || !history.nextCursor || cursor === history.nextCursor) return
    cursor = history.nextCursor
  }
}
