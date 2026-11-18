import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HubError } from '../codex/hub.js'
import { connectRouterApp } from './app-server.js'
import { RouterDispatcher } from './dispatcher.js'
import { rankCandidates, selectCandidate } from './matching.js'
import { checkProject, checkThread, loadRouterProjects, shortText } from './projects.js'
import { RouterStore } from './store.js'
import { routerNamespace, toolResult, validateTool } from './tools.js'

const lifetime = 24 * 60 * 60 * 1000
const textLimit = 12000
const mutation = /^(?:请\s*|帮我\s*)?(?:派发|交给|让|续接|继续|新建|创建|排队|在|把|将|dispatch\b|delegate\b|resume\b|enqueue\b|create\b)/i
const discussion = /不要|不用|不必|请勿|如何|怎么|解释|示例|举例|假如|假设|do not|don't|what if|explain|how (?:to|do)/i
const reference = /刚才那个|刚才的会话|继续上次|继续昨天|last (?:thread|task)|that session|yesterday/i
const yesterday = /昨天|yesterday/i
const risky = /删除|清空|强推|回滚|断开|中断|取消|提权|destroy|delete|force.push|rollback|interrupt|terminate|cancel/i

function operationFingerprint(intent) {
  return JSON.stringify([intent.kind, intent.projectId ?? null, intent.threadId ?? null,
    intent.mode ?? null, intent.title ?? null, intent.id ?? null, intent.turnId ?? null,
    intent.instruction ?? null])
}

function previousOperation(store, requestId, intent) {
  const existing = store.get('operation', requestId)
  if (!existing) return null
  if (existing.fingerprint !== operationFingerprint(intent)) {
    throw new HubError('codex-cli/router-conflict', '请求 ID 已用于另一项 Router 操作')
  }
  return existing.result ?? { status: 'unknown' }
}

export class RouterService {
  constructor({ config, stateDir, hub, followups, bus, logger, connect = connectRouterApp }) {
    Object.assign(this, { config, stateDir, hub, followups, bus, logger, connect })
    this.phase = 'idle'
    this.projects = new Map()
    this.confirming = new Map()
    this.deltas = new Map()
  }

  start() {
    if (!this.config.enabled || this.closed || this.app || this.opening) return
    this.phase = 'connecting'
    this.connectionAbort = new AbortController()
    this.opening = this.open().catch(error => {
      if (!this.closed) {
        this.phase = 'unavailable'
        this.error = 'Router 尚未通过启动校验'
        this.logger?.warn?.('Router startup validation failed: ' + (error.code ?? error.name))
        this.publish()
      }
    }).finally(() => { this.opening = null })
  }

  async open() {
    if (!this.store) {
      const root = join(this.stateDir, 'router')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const directory = await realpath(root)
      const info = await stat(directory)
      if (directory !== root || (info.mode & 0o077) !== 0) throw new Error('Router 状态目录必须是私有真实目录')
      this.directory = directory
      this.projects = await loadRouterProjects(this.config.projects, directory)
      this.store = new RouterStore(join(directory, 'router.sqlite'))
      this.dispatcher = new RouterDispatcher({
        hub: this.hub, bus: this.bus, followups: this.followups, store: this.store,
        project: id => this.projects.get(id), routerThreadId: () => this.session?.id,
        isReady: () => !this.closed && this.phase === 'ready',
      })
    }
    const epoch = Symbol('router-connection')
    this.epoch = epoch
    const app = await this.connect({
      config: this.config, directory: this.directory, signal: this.connectionAbort.signal,
      onEvent: (method, params) => { if (this.epoch === epoch) this.onEvent(method, params) },
      onTool: params => this.epoch === epoch ? this.onTool(params) : toolResult(false, { code: 'staleConnection' }),
      onClose: () => { if (this.epoch === epoch) this.disconnected() },
    })
    if (this.closed || this.epoch !== epoch) { app.close(); return }
    try {
      let session = this.store.get('session', 'active')
      if (session) {
        try {
          const resumed = await app.resume(session.id)
          if (resumed.thread?.id !== session.id || resumed.thread.cwd !== app.cwd) throw new Error('Router 会话身份不匹配')
        } catch (error) {
          if (session.materialized || this.store.list('message', 1).length ||
              !/no rollout found|thread not found/i.test(error.message)) throw error
          session = null
        }
      }
      if (!session) {
        const { thread } = await app.start()
        if (!thread?.id || thread.cwd !== app.cwd) throw new Error('Router 会话创建响应不匹配')
        session = this.store.put('session', 'active', { id: thread.id, materialized: false })
      }
      if (this.closed || this.epoch !== epoch) { app.close(); return }
      this.session = session
      this.app = app
      await this.recoverMessages()
      if (this.closed || this.epoch !== epoch) { app.close(); return }
      this.phase = 'ready'
      this.error = null
      this.logger?.info?.(`Router 已就绪（${app.selected.model}，${this.projects.size} 个登记项目）`)
      this.publish()
      this.dispatcher.schedule()
      for (const row of this.store.list('clarification').filter(item => item.status === 'confirming')) {
        this.completeConfirmation(row).catch(error => this.logger?.warn?.('Router confirmation: ' + error.code))
      }
    } catch (error) {
      if (this.app === app) this.app = null
      app.close()
      throw error
    }
  }

  async recoverMessages() {
    const pending = this.store.list('message', 80).filter(message =>
      message.role === 'user' && ['sending', 'accepted', 'unknown'].includes(message.status))
    if (!pending.length) return
    const history = await this.app.request('thread/turns/list', {
      threadId: this.session.id, limit: 30, sortDirection: 'desc', itemsView: 'full',
    })
    for (const message of pending) {
      const turn = history.data?.find(turn => turn.id === message.turnId ||
        turn.items?.some(item => item.type === 'userMessage' && item.clientId === message.requestId))
      if (turn?.status === 'inProgress') {
        this.active = { ...message, turnId: turn.id }
        continue
      }
      this.recordMessage({ ...message, turnId: turn?.id ?? message.turnId, status: turn?.status ?? 'unknown' })
      for (const item of turn?.items ?? []) {
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          this.recordMessage({ id: 'agent:' + item.id, role: 'assistant', text: item.text.slice(0, 24000), status: 'completed' })
        }
      }
    }
  }

  disconnected() {
    this.clearDeltas()
    this.epoch = null
    this.app = null
    if (this.active) {
      this.recordMessage({ ...this.active, status: 'unknown' })
      this.active = null
    }
    if (!this.closed) {
      this.phase = 'unavailable'
      this.error = 'Router 连接已断开'
      this.publish()
      this.reconnectTimer = setTimeout(() => this.start(), 2000)
      this.reconnectTimer.unref()
    }
  }

  publish() {
    this.bus.publish('router/changed', {})
  }

  status() {
    return { enabled: this.config.enabled, phase: this.phase }
  }

  read() {
    const now = Date.now()
    const recentTasks = this.dispatcher ? this.dispatcher.list().map(task => this.task(task)) : []
    return {
      ...this.status(), error: this.error ?? null, model: this.app?.selected?.model ?? null,
      busy: Boolean(this.active),
      messages: [
        ...(this.store?.list('message', 80).reverse().map(message =>
          ({ id: message.id, role: message.role, text: message.text, status: message.status })) ?? []),
        ...this.deltas.values(),
      ],
      clarifications: this.store?.list('clarification').filter(item => item.status === 'pending' && item.expiresAt > now)
        .map(({ id, revision, kind, label, candidates, original }) => ({ id, revision, kind, label, candidates, original })) ?? [],
      tasks: recentTasks,
      latestEventId: this.store?.events(1)[0]?.eventId ?? 0,
    }
  }

  task(task) {
    const { id, projectId, threadId, turnId, status, createdAt, updatedAt, summary, error } = task
    return { id, projectId, project: this.projects.get(projectId)?.name ?? projectId, threadId, turnId,
      status, createdAt, updatedAt, summary: summary ?? null, error: error ?? null }
  }

  listTasks({ offset = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HubError('codex-cli/bad-request', '任务分页参数无效')
    }
    const entries = this.dispatcher?.list(offset + limit + 1).slice(offset) ?? []
    return { data: entries.slice(0, limit).map(task => this.task(task)), nextOffset: entries.length > limit ? offset + limit : null }
  }

  getTask(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new HubError('codex-cli/bad-request', '任务 ID 无效')
    if (!this.dispatcher) throw new HubError('codex-cli/router-unavailable', 'Router 未就绪')
    return this.task(this.dispatcher.get(id))
  }

  dismissUnknown({ dispatchId, updatedAt, confirmed } = {}) {
    this.requireReady()
    if (typeof dispatchId !== 'string' || dispatchId.length > 128 || !Number.isSafeInteger(updatedAt) || confirmed !== true) {
      throw new HubError('codex-cli/bad-request', '需要明确确认关闭待核对任务')
    }
    return this.task(this.dispatcher.dismissUnknown(dispatchId, updatedAt))
  }

  requireReady() {
    if (this.closed || this.phase !== 'ready' || !this.app) throw new HubError('codex-cli/router-unavailable', 'Router 未就绪')
  }

  recordMessage(message) {
    this.store.put('message', message.id, message)
    this.publish()
  }

  async send({ requestId, text } = {}) {
    this.requireReady()
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{12,128}$/.test(requestId) ||
        typeof text !== 'string' || !text.trim() || text.length > textLimit) {
      throw new HubError('codex-cli/bad-request', '请输入有效的 Router 消息')
    }
    const id = 'user:' + requestId
    const previous = this.store.get('message', id)
    if (previous) {
      if (previous.text !== text) throw new HubError('codex-cli/router-conflict', '消息请求 ID 与原消息冲突')
      return { id, status: previous.status }
    }
    if (this.active) throw new HubError('codex-cli/router-busy', 'Router 正在回复，请等待当前回合结束')
    const message = { id, requestId, text, role: 'user', status: 'sending', turnId: null }
    this.active = message
    this.recordMessage(message)
    try {
      const { turn } = await this.app.send(this.session.id, text, requestId)
      if (!turn?.id) throw new Error('Router 回合未确认')
      if (this.active === message) {
        message.turnId = turn.id
        message.status = 'accepted'
        this.recordMessage(message)
      }
    } catch (error) {
      if (this.active === message) {
        const rejected = [-32600, -32601, -32602].includes(error.code)
        message.status = rejected ? 'failed' : 'unknown'
        this.active = null
        this.recordMessage(message)
        if (!rejected) {
          this.app.close()
          this.disconnected()
        }
      }
    }
    return { id, status: message.status }
  }

  onEvent(method, params) {
    if (!this.active || !this.session || params?.threadId !== this.session.id) return
    const active = this.active
    if (method === 'turn/started' && !active.turnId) active.turnId = params.turn?.id
    if (method === 'item/started' && active.turnId === params.turnId &&
        params.item?.type === 'userMessage' && params.item.clientId === active.requestId && !this.session.materialized) {
      this.session = this.store.put('session', 'active', { ...this.session, materialized: true })
    }
    if (active.turnId === params.turnId && method === 'item/agentMessage/delta' &&
        typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const id = 'agent:' + params.itemId
      const text = ((this.deltas.get(id)?.text ?? '') + params.delta).slice(0, 24000)
      this.deltas.set(id, { id, role: 'assistant', text, status: 'streaming' })
      if (!this.deltaTimer) {
        this.deltaTimer = setTimeout(() => { this.deltaTimer = null; this.publish() }, 100)
        this.deltaTimer.unref()
      }
    }
    if (active.turnId === params.turnId && method === 'item/completed' && params.item?.type === 'agentMessage') {
      this.deltas.delete('agent:' + params.item.id)
      this.recordMessage({
        id: 'agent:' + params.item.id, role: 'assistant', text: String(params.item.text ?? '').slice(0, 24000),
        status: 'completed',
      })
    }
    if (method === 'turn/completed' && params.turn?.id === active.turnId) {
      active.status = params.turn.status
      this.clearDeltas()
      this.active = null
      this.recordMessage(active)
    }
  }

  clearDeltas() {
    clearTimeout(this.deltaTimer)
    this.deltaTimer = null
    this.deltas.clear()
  }

  async sessions(project) {
    const list = []
    await checkProject(project)
    let cursor = null
    for (let index = 0; index < 3; index++) {
      const result = await this.hub.listThreads({ cwd: project.cwd, limit: 100, cursor })
      for (const thread of result.data) {
        if (thread.cwd !== project.cwd || !thread.id || thread.id === this.session?.id ||
            thread.ephemeral || thread.parentThreadId) continue
        list.push(this.sessionRow(project, thread))
      }
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    return list
  }

  sessionRow(project, thread) {
    const raw = thread.updatedAt ?? thread.createdAt ?? 0
    return { id: thread.id, projectId: project.id, project: project.name,
      name: shortText(thread.name || thread.preview, 120) || '未命名会话',
      summary: shortText(thread.preview), status: thread.status?.type ?? null,
      updatedAt: raw < 100000000000 ? raw * 1000 : raw }
  }

  async projectRows() {
    const discovered = await this.hub.projects().catch(() => [])
    const byCwd = new Map(discovered.map(item => [item.cwd, item]))
    return [...this.projects.values()].map(project => {
      const meta = byCwd.get(project.cwd)
      const updatedAt = meta?.lastUpdatedAt
      return {
        id: project.id, name: project.name, aliases: [...project.aliases, project.cwd], projectId: project.id,
        ...(typeof updatedAt === 'number' ? { updatedAt: updatedAt < 100000000000 ? updatedAt * 1000 : updatedAt } : {}),
        ...(meta ? { threadCount: meta.threadCount, activeCount: meta.activeCount } : {}),
      }
    })
  }

  async resolveThread(id, projectId) {
    const detail = await this.hub.routerReadWorker(id)
    const project = projectId ? this.projects.get(projectId) : [...this.projects.values()].find(item => item.cwd === detail.thread?.cwd)
    await checkProject(project)
    await checkThread(project, detail.thread, this.session?.id)
    if (detail.thread.id !== id) throw new HubError('codex-cli/router-thread', 'Worker 会话身份不匹配')
    return { project, detail }
  }

  async onTool(params) {
    const source = this.active
    if (!source || !source.turnId || params?.threadId !== this.session?.id || params.turnId !== source.turnId ||
        params.namespace !== routerNamespace || typeof params.callId !== 'string' || !params.callId || params.callId.length > 256) {
      return toolResult(false, { code: 'outsideRouterTurn' })
    }
    const key = JSON.stringify([this.session.id, source.turnId, params.callId])
    const existing = this.store.get('tool-call', key)
    if (existing) return existing.response ?? toolResult(false, { code: 'toolResultUnknown' })
    const count = source.calls ?? 0
    if (count >= 32) return toolResult(false, { code: 'toolLimit' })
    source.calls = count + 1
    this.store.put('tool-call', key, { tool: params.tool, at: Date.now() })
    let response
    try {
      const args = validateTool(params.tool, params.arguments)
      const value = await this.handleTool(params.tool, args, source)
      response = toolResult(true, value)
    } catch (error) {
      response = toolResult(false, {
        code: error instanceof HubError ? error.code : 'codex-cli/router-operation',
        message: error instanceof HubError ? error.message : '操作暂不可用，请检查工作台状态',
      })
    }
    this.store.put('tool-call', key, { tool: params.tool, at: Date.now(), response })
    return response
  }

  async handleTool(name, args, source) {
    const limit = args.limit ?? 12
    switch (name) {
      case 'list_projects':
        return rankCandidates(await this.projectRows(), args.query, { original: source.text }).slice(0, limit)
          .map(({ aliases, ...row }) => row)
      case 'list_sessions': {
        const projects = args.projectId ? [this.projects.get(args.projectId)] : [...this.projects.values()]
        const lists = await Promise.all(projects.slice(0, 20).map(project => this.sessions(project)))
        return rankCandidates(lists.flat(), args.query, { original: source.text }).slice(0, limit)
      }
      case 'get_session': {
        const { project, detail } = await this.resolveThread(args.threadId)
        const recent = detail.turns.slice(-2).flatMap(turn => turn.items ?? [])
          .filter(item => item.type === 'agentMessage').slice(-2).map(item => shortText(item.text))
        return { ...this.sessionRow(project, detail.thread), recent }
      }
      case 'get_task_status': return this.getTask(args.dispatchId)
      case 'interrupt_task': {
        const task = this.dispatcher.get(args.dispatchId)
        if (!task.turnId || !['running', 'awaiting_approval'].includes(task.status)) {
          throw new HubError('codex-cli/router-task', '没有可中断的关联回合')
        }
        return this.clarify(source, {
          kind: 'interrupt', label: shortText(args.reason || '确认中断此 Worker 回合'),
          intent: { id: task.id, turnId: task.turnId },
          candidates: [{ id: task.id, name: '中断当前回合', projectId: task.projectId, threadId: task.threadId }],
        })
      }
      case 'create_session':
        return this.prepare(source, { kind: 'create', ...args })
      case 'dispatch_task':
        if (args.requestId !== source.requestId) throw new HubError('codex-cli/router-conflict', '请求 ID 与当前用户消息不匹配')
        return this.prepare(source, { kind: 'dispatch', ...args, instruction: source.text })
    }
  }

  async prepare(source, intent) {
    if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前 Router 回合已结束')
    const existing = previousOperation(this.store, source.requestId, intent)
    if (existing) return existing
    const project = await checkProject(this.projects.get(intent.projectId))
    if (intent.threadId) await this.resolveThread(intent.threadId, project.id)
    const bindingTime = this.store.get('binding', 'last')
    const storedDate = bindingTime ? new Date(bindingTime.at) : null
    const previous = new Date()
    previous.setDate(previous.getDate() - 1)
    const binding = reference.test(source.text) && (!yesterday.test(source.text) ||
      storedDate?.toDateString() === previous.toDateString()) ? bindingTime : null
    const projects = rankCandidates(await this.projectRows(), '', { original: source.text, boundId: binding?.projectId })
    if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前 Router 回合已结束')
    const matchedProject = selectCandidate(projects)
    if (matchedProject?.id !== project.id) {
      return this.clarify(source, {
        kind: 'project', label: '选择目标项目', intent,
        candidates: projects.slice(0, 5).map(({ aliases, ...row }) => row),
      })
    }
    return this.prepareSession(source, intent, project, binding)
  }

  async prepareSession(source, intent, project, binding, projectConfirmed = false) {
    const userIntent = project.sandbox === 'read-only' && mutation.test(source.text.trim()) &&
      !discussion.test(source.text) && !risky.test(source.text)
    if (intent.kind === 'create' || intent.mode === 'new') {
      if (userIntent && /新建|创建|create|new session/i.test(source.text)) return this.execute(source.requestId, intent)
      return this.clarify(source, {
        kind: 'create', label: '确认创建 Worker 会话', intent,
        candidates: [{ id: 'create', name: '在 ' + project.name + ' 新建会话', projectId: project.id }],
      })
    }
    const rows = rankCandidates(await this.sessions(project), '', {
      original: source.text, boundId: binding?.projectId === project.id ? binding.threadId : null,
    })
    if (!projectConfirmed && this.active !== source) throw new HubError('codex-cli/router-stale', '当前 Router 回合已结束')
    const match = selectCandidate(rows)
    if (userIntent && match?.id === intent.threadId && !projectConfirmed) return this.execute(source.requestId, intent)
    return this.clarify(source, {
      kind: 'session', label: '选择要继续的 Worker 会话', intent,
      candidates: rows.length ? rows.slice(0, 5) : [
        { id: 'create', name: '没有匹配会话，在 ' + project.name + ' 新建', projectId: project.id },
      ],
    })
  }

  clarify(source, value) {
    const id = source.requestId + ':' + value.kind
    if (this.store.get('operation', source.requestId)) return { status: 'alreadyHandled' }
    const existing = this.store.get('clarification', id)
    if (existing?.status === 'pending' && existing.expiresAt > Date.now()) return { status: 'needs_confirmation', id }
    const row = {
      ...value, id, requestId: source.requestId, original: source.text,
      revision: (existing?.revision ?? 0) + 1, status: 'pending', expiresAt: Date.now() + lifetime,
    }
    this.store.put('clarification', id, row)
    this.publish()
    return { status: 'needs_confirmation', id }
  }

  async confirm({ id, revision, candidateId } = {}, cancel = false) {
    this.requireReady()
    if (typeof id !== 'string' || !Number.isSafeInteger(revision)) throw new HubError('codex-cli/bad-request', '确认请求无效')
    const row = this.store.get('clarification', id)
    if (row?.revision === revision && row.candidateId === candidateId && !cancel) {
      if (row.status === 'confirmed') return row.result
      if (row.status === 'confirming') return this.completeConfirmation(row)
    }
    if (!row || row.status !== 'pending' || row.revision !== revision || row.expiresAt <= Date.now()) {
      throw new HubError('codex-cli/router-stale', '确认已失效，请刷新 Router 状态')
    }
    const candidate = row.candidates.find(item => item.id === candidateId)
    if (!cancel && !candidate) throw new HubError('codex-cli/router-stale', '该目标不在待确认列表中')
    const next = this.store.put('clarification', id, {
      ...row, status: cancel ? 'cancelled' : 'confirming', candidateId,
    })
    this.publish()
    if (cancel) return { status: 'cancelled' }
    return this.completeConfirmation(next)
  }

  completeConfirmation(row) {
    const running = this.confirming.get(row.id)
    if (running) return running
    const pending = this.applyConfirmation(row).then(result => {
      this.store.put('clarification', row.id, { ...row, status: 'confirmed', result })
      this.publish()
      return result
    }).catch(error => {
      const status = error.code === 'codex-cli/router-unavailable' ? 'confirming' : 'expired'
      this.store.put('clarification', row.id, { ...row, status })
      this.publish()
      throw error
    }).finally(() => this.confirming.delete(row.id))
    this.confirming.set(row.id, pending)
    return pending
  }

  async applyConfirmation(row) {
    this.requireReady()
    const candidate = row.candidates.find(item => item.id === row.candidateId)
    if (row.kind === 'interrupt') return this.execute(row.requestId, { kind: 'interrupt', ...row.intent })
    const project = await checkProject(this.projects.get(candidate.projectId))
    if (row.kind === 'project') {
      const intent = { ...row.intent, projectId: project.id }
      return this.prepareSession({ requestId: row.requestId, text: row.original }, intent, project, null, true)
    }
    if (candidate.id === 'create') {
      return this.execute(row.requestId, { ...row.intent, projectId: project.id, threadId: undefined, mode: 'new' })
    }
    await this.resolveThread(candidate.id, project.id)
    return this.execute(row.requestId, { ...row.intent, projectId: project.id, threadId: candidate.id })
  }

  async execute(requestId, intent) {
    this.requireReady()
    const old = previousOperation(this.store, requestId, intent)
    if (old) return old
    if (intent.kind === 'dispatch') {
      const task = this.dispatcher.enqueue({ ...intent, requestId }, value => {
        this.saveOperation(requestId, intent, this.task(value))
      })
      return this.task(task)
    }
    this.saveOperation(requestId, intent, null)
    let result
    try {
      if (intent.kind === 'interrupt') {
        result = this.task(await this.dispatcher.interrupt(intent.id, intent.turnId))
      } else {
        const thread = await this.dispatcher.createWorker(this.projects.get(intent.projectId), intent.title)
        result = this.task(this.dispatcher.recordCreation({ requestId, threadId: thread.id, projectId: intent.projectId }))
      }
    } catch {
      result = { status: 'unknown', message: '操作结果待核对' }
    }
    this.store.transaction(() => this.saveOperation(requestId, intent, result))
    this.publish()
    return result
  }

  saveOperation(requestId, intent, result) {
    this.store.put('operation', requestId, { kind: intent.kind, fingerprint: operationFingerprint(intent), result, at: Date.now() })
    if (result?.projectId && result.threadId) {
      this.store.put('binding', 'last', { projectId: result.projectId, threadId: result.threadId, at: Date.now() })
    }
  }

  async close() {
    this.closed = true
    this.clearDeltas()
    this.epoch = null
    this.connectionAbort?.abort()
    this.app?.close()
    clearTimeout(this.reconnectTimer)
    await this.opening
    await Promise.allSettled(this.confirming.values())
    await this.dispatcher?.close()
    this.store?.close()
  }
}
