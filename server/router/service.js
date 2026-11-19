import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HubError } from '../codex/hub.js'
import { connectRouterApp } from './app-server.js'
import { finalAnswer, RouterDispatcher } from './dispatcher.js'
import { rankCandidates } from './matching.js'
import { checkProject, checkThread, describeWorkerSettings, loadRouterProjects, shortText, workerDispatchIssue, workerIdentityIssue } from './projects.js'
import { RouterSessionUpgrade } from './psm-migration.js'
import { ProjectSessionMemory } from './psm.js'
import { RouterStore } from './store.js'
import { makeProject, newProjectTarget, projectParent } from './new-project.js'
import { routerNamespace, toolResult, validateTool } from './tools.js'
import { RouterWakeScheduler } from './wake.js'
import { permissionPayload } from '../../shared/worker-options.js'

const lifetime = 24 * 60 * 60 * 1000
const textLimit = 12000
function operationFingerprint(intent) {
  const fields = [intent.kind, intent.projectId ?? null, intent.threadId ?? null,
    intent.mode ?? null, intent.title ?? null, intent.id ?? null, intent.turnId ?? null,
    intent.instruction ?? null]
  const overrides = [intent.workerModel, intent.workerEffort, intent.workerPermission, intent.executionMode]
  if (overrides.some(Boolean)) fields.push(...overrides.map(value => value ?? null))
  return JSON.stringify(fields)
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
  constructor({ config, stateDir, hub, followups, bus, logger, connect = connectRouterApp, wakePolicy, createChannel }) {
    Object.assign(this, { config, stateDir, hub, followups, bus, logger, connect, wakePolicy, createChannel })
    this.phase = 'idle'
    this.nativeBusy = false
    this.projects = new Map()
    this.confirming = new Map()
    this.creatingProjects = new Map()
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
      for (const project of this.store.list('approved-project')) {
        if (this.projects.has(project.id) || [...this.projects.values()].some(entry => entry.cwd === project.cwd)) continue
        if (await checkProject(project).catch(() => null)) this.projects.set(project.id, project)
      }
      this.dispatcher = new RouterDispatcher({
        hub: this.hub, bus: this.bus, followups: this.followups, store: this.store,
        project: id => this.projects.get(id),
        routerThreadId: () => this.session?.id ?? this.store.get('session', 'active')?.id,
        isReady: () => !this.closed && this.phase === 'ready',
        targetIssue:(project,id)=>this.psm.targetIssue(project,id),
        onReceipt: () => this.wake.kick(),
        onTerminal: (task, receipt) => this.wechat?.terminal(task, receipt),
      })
      this.psm = new ProjectSessionMemory(this)
      this.wake = new RouterWakeScheduler(this, this.wakePolicy)
      this.wechat = this.createChannel?.(this)
      this.upgrade = new RouterSessionUpgrade(this)
      this.publish()
    }
    const epoch = Symbol('router-connection')
    this.epoch = epoch
    const defaults = this.store.get('settings', 'defaults')
    const app = await this.connect({
      config: defaults?.model ? { ...this.config, models: [defaults.model, ...(this.config.models ?? [])] } : this.config,
      directory: this.directory, signal: this.connectionAbort.signal,
      onEvent: (method, params) => { if (this.epoch === epoch) this.onEvent(method, params) },
      onTool: params => this.epoch === epoch ? this.onTool(params) : toolResult(false, { code: 'staleConnection' }),
      onClose: () => { if (this.epoch === epoch) this.disconnected() },
    })
    if (this.closed || this.epoch !== epoch) { app.close(); return }
    try {
      let session = this.store.get('session', 'active')
      if (session) {
        try {
          if (session.modelSelection) app.select(app.resolveSelection(session.modelSelection))
          const resumed = await app.resume(session.id)
          if (resumed.thread?.id !== session.id || resumed.thread.cwd !== app.cwd) throw new Error('Router 会话身份不匹配')
        } catch (error) {
          const hasInputs=this.store.list('router-history',1).length
            ? this.store.db.prepare("SELECT 1 FROM router_records WHERE kind='message' AND json_extract(value,'$.routerThreadId')=? LIMIT 1").get(session.id)
            : this.store.list('message',1).length
          if (session.materialized || hasInputs ||
              !/no rollout found|thread not found/i.test(error.message)) throw error
          session = null
        }
      }
      if (!session) {
        app.select?.(null)
        const { thread } = await app.start()
        if (!thread?.id || thread.cwd !== app.cwd) throw new Error('Router 会话创建响应不匹配')
        session = this.store.put('session', 'active', { id: thread.id, materialized: false, policyVersion:app.policyVersion ?? 1 })
      }
      if (this.closed || this.epoch !== epoch) { app.close(); return }
      this.session = session
      this.app = app
      await this.recoverMessages(app)
      if (this.closed || this.epoch !== epoch) { app.close(); return }
      await this.wake.recover(app)
      if (this.closed || this.epoch !== epoch) { app.close(); return }
      this.phase = 'ready'
      this.error = null
      this.logger?.info?.(`Router 已就绪（${app.selected.model}，${this.projects.size} 个登记项目）`)
      this.publish()
      this.dispatcher.schedule()
      this.kickInputs()
      this.wake.kick()
      this.resumeRootRequests()
      for (const row of this.store.list('clarification').filter(item => item.status === 'confirming')) {
        this.completeConfirmation(row).catch(error => this.logger?.warn?.('Router confirmation: ' + error.code))
      }
    } catch (error) {
      if (this.app === app) {
        this.app = null
        this.active = null
        this.clearDeltas()
      }
      app.close()
      throw error
    }
  }

  async readThreadStatus(app, threadId) {
    const { thread } = await app.request('thread/read', { threadId, includeTurns: false })
    return thread?.id === threadId ? thread.status?.type ?? null : null
  }

  async recoverMessages(app) {
    const pending = this.store.messagesWithStatus('sending','accepted','unknown').filter(message => message.role === 'user' &&
      (!message.routerThreadId || message.routerThreadId===this.session.id))
    if (!pending.length) return
    let nativeStatus
    for (const message of pending) {
      const turn = await this.wake.findTurn(app, { ...message, routerThreadId: this.session.id, startedAt: message.startedAt ?? 0 })
      if (this.app !== app || this.closed) return
      if (turn?.status === 'inProgress') {
        nativeStatus ??= await this.readThreadStatus(app, this.session.id)
        if (this.app !== app || this.closed) return
        if (nativeStatus === 'active' && !this.active) {
          const answer = finalAnswer(turn.items)
          this.active = { ...message, turnId: turn.id, finalText: answer?.text, finalPhase: answer?.phase }
          continue
        }
        if (!this.active) this.nativeBusy = nativeStatus !== 'idle'
        this.recordMessage({ ...message, turnId: turn.id, status: 'unknown' })
        continue
      }
      if (!turn) {
        nativeStatus ??= await this.readThreadStatus(app, this.session.id)
        if (this.app !== app || this.closed) return
        this.nativeBusy = nativeStatus !== 'idle'
      }
      this.finishMessage({ ...message, turnId: turn?.id ?? message.turnId, status: turn?.status ?? 'unknown' }, finalAnswer(turn?.items)?.text)
      for (const item of turn?.items ?? []) {
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          this.recordMessage({ id: 'agent:' + item.id, role: 'assistant', text: item.text.slice(0, 24000), status: 'completed' })
        }
      }
    }
  }

  resetApp(app) {
    if (this.app !== app) return
    this.disconnected()
    app.close()
  }

  disconnected() {
    this.clearDeltas()
    this.epoch = null
    this.app = null
    const active = this.active
    this.active = null
    if (active && active.source !== 'worker_receipt') this.recordMessage({ ...active, status: 'unknown' })
    if (!this.closed) {
      this.phase = 'unavailable'
      this.error = 'Router 连接已断开'
      this.publish()
      this.reconnectTimer = setTimeout(() => this.start(), 2000)
      this.reconnectTimer.unref()
    }
  }

  publish() {
    this.bus.publish('router/changed', this.status())
  }

  status() {
    return { enabled: this.config.enabled, phase: this.phase,
      promptProjectRoot: !!this.store && !this.closed && !this.settings().projectRoot && !this.store.get('settings', 'root-prompt-deferred') }
  }

  read() {
    const now = Date.now()
    const previousThreads=this.store?.list('router-history').map(s=>s.id) ?? []
    const recentTasks = this.dispatcher ? this.dispatcher.list().map(task => this.task(task)) : []
    return {
      ...this.status(), error: this.error ?? null, model: this.app?.selected?.model ?? null,
      effort: this.app?.selected?.effort ?? null, models: this.app?.models ?? [],
      usingDefaultModel: !this.session?.modelSelection || !this.app?.resolveSelection?.(this.session.modelSelection),
      busy: Boolean(this.active) || this.nativeBusy,
      receiptLimited: this.wake?.limited() ?? false,
      primaryThreadId:this.session?.id, previousThreads,
      queuedCount: this.store?.queuedInputCount.get().count ?? 0,
      messages: [
        ...(this.store?.list('message', 80).filter(m=>!previousThreads.length || m.routerThreadId===this.session?.id || (m.dispatchId && this.store.get('task',m.dispatchId)?.routerThreadId===this.session?.id)).reverse().map(message =>
          ({ id: message.id, role: message.role, label: message.label, text: message.text, status: message.status,
            questions: message.questions, dispatchId: message.dispatchId, interactionMethod: message.interactionMethod })) ?? []),
        ...this.deltas.values(),
      ],
      clarifications: this.store?.list('clarification').filter(item => item.status === 'pending' && item.expiresAt > now)
        .map(({ id, revision, kind, label, candidates, original }) => ({
          id, revision, kind, label, candidates: candidates.map(({ pendingProject, grant, ...candidate }) => candidate), original,
        })) ?? [],
      tasks: recentTasks,
      interactions: this.dispatcher?.interactions() ?? [],
      latestEventId: this.store?.events(1)[0]?.eventId ?? 0,
    }
  }

  async history({threadId,cursor}={}) {
    if(!this.store?.get('router-history',threadId) || !this.app || (cursor!=null && typeof cursor!=='string')) throw new HubError('codex-cli/router-history','旧中枢会话不可用')
    const page=await this.app.request('thread/turns/list',{threadId,cursor,limit:10,sortDirection:'desc',itemsView:'full'})
    return {nextCursor:page.nextCursor ?? null,messages:page.data.flatMap(turn=>(turn.items ?? []).filter(i=>i.type==='userMessage'||i.type==='agentMessage').map(i=>({
      id:i.id,role:i.type==='userMessage'?'user':'assistant',text:i.type==='userMessage'?(i.content ?? []).filter(p=>p.type==='text').map(p=>p.text).join(' '):i.text,
    })))}
  }

  task(task) {
    const { id, projectId, threadId, turnId, status, createdAt, updatedAt, summary, error } = task
    const project = this.projects.get(projectId)
    return { id, projectId, project: project?.name ?? projectId, threadId, turnId,
      ...(task.worker ? {worker:task.worker} : {}),
      ...(project?.createdAt ? { cwd: project.cwd } : {}),
      status, createdAt, updatedAt, summary: summary ?? null, error: error ?? null,
      receiptStatus: task.receiptConflict ? 'unknown' : this.store.receiptState(id) }
  }

  respond(payload) {
    if (!this.dispatcher || this.closed) throw new HubError('codex-cli/router-unavailable', 'Worker 调度器未就绪')
    return this.dispatcher.respond(payload)
  }

  answerQuestion(payload) {
    if (!this.dispatcher || this.closed) throw new HubError('codex-cli/router-unavailable', 'Worker 调度器未就绪')
    return this.dispatcher.answerQuestion(payload)
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

  setModel(payload) {
    this.requireReady()
    const reset = payload?.model === null && payload?.effort === null
    const selection = reset ? null : this.app.resolveSelection(payload)
    if (!reset && !selection) throw new HubError('codex-cli/bad-request', '此 Router 模型或思考强度不可用')
    this.session = this.store.put('session', 'active', { ...this.session, modelSelection: selection })
    this.app.select(selection)
    this.publish()
    return this.app.selected
  }

  settings() {
    const saved = this.store?.get('settings', 'defaults')
    return { models: this.app?.models ?? [], model: this.app?.defaultSelection ?? saved?.model ?? this.config.models?.[0],
      projectRoot: saved?.projectRoot ?? this.config.projectRoot ?? '', revision: saved?.revision ?? 0 }
  }

  async setupProjectRoot({ projectRoot, defer } = {}) {
    if (!this.store || this.closed) throw new HubError('codex-cli/router-unavailable', '工作台正在启动')
    if (defer === true) {
      this.store.put('settings', 'root-prompt-deferred', { deferred: true })
    } else {
      const root = await projectParent(projectRoot, this.stateDir)
      if (this.closed) throw new HubError('codex-cli/router-unavailable', '工作台正在关闭')
      const current = this.settings()
      if (current.projectRoot && current.projectRoot !== root) throw new HubError('codex-cli/router-stale', '父目录已设置，请在设置面板修改')
      if (!current.projectRoot) this.store.put('settings', 'defaults', {
        ...this.store.get('settings', 'defaults'), projectRoot: root, revision: current.revision + 1,
      })
      this.resumeRootRequests()
    }
    this.publish()
    return this.settings()
  }

  resumeRootRequests() {
    if (this.phase !== 'ready' || !this.settings().projectRoot) return
    for (const row of this.store.list('clarification')) {
      if (row.kind !== 'projectRoot' || row.status !== 'pending' || row.expiresAt <= Date.now()) continue
      const next = this.store.put('clarification', row.id, { ...row, status: 'confirming' })
      this.completeConfirmation(next).catch(error => this.logger?.warn?.('Router project setup: ' + error.code))
    }
  }

  async saveSettings({ model, projectRoot, revision } = {}) {
    this.requireReady()
    const root = projectRoot === '' ? '' : await projectParent(projectRoot, this.stateDir)
    this.requireReady()
    const selected = this.app.resolveSelection(model)
    if (!selected) throw new HubError('codex-cli/bad-request', '请选择账号支持的 Router 模型与思考强度')
    if (revision !== this.settings().revision) throw new HubError('codex-cli/router-stale', '设置已更新，请重新加载')
    this.store.put('settings', 'defaults', { model: selected, projectRoot: root, revision: revision + 1 })
    this.app.setDefault(selected)
    if (!this.app.resolveSelection(this.session?.modelSelection)) this.app.select(null)
    this.resumeRootRequests()
    this.publish()
    return this.settings()
  }

  async provision(requestId, target) {
    const previous = this.store.get('new-project', requestId)
    if (previous) {
      if (previous.target !== target) throw new HubError('codex-cli/router-conflict', '该请求已用于另一个项目')
      return previous.id
    }
    if (this.store.get('operation', requestId)) throw new HubError('codex-cli/router-conflict', '该请求已执行')
    const running = this.creatingProjects.get(requestId)
    if (running) {
      if (running.target !== target) throw new HubError('codex-cli/router-conflict', '正在创建另一个项目')
      return running.promise
    }
    const promise = this.createProject(requestId, target).finally(() => this.creatingProjects.delete(requestId))
    this.creatingProjects.set(requestId, { target, promise })
    return promise
  }

  async createProject(requestId, target) {
    const spec = newProjectTarget(target)
    const root = this.settings().projectRoot
    if (!root) throw new HubError('codex-cli/router-root-required', '请先设置默认新项目父目录')
    const cwd = await makeProject(root, spec, this.stateDir)
    const id = 'project-' + randomUUID()
    const project = (await loadRouterProjects([{ id, cwd, name: spec.name }], this.directory)).get(id)
    project.createdAt = Date.now()
    this.store.transaction(() => {
      this.store.put('approved-project', id, project)
      this.store.put('new-project', requestId, { id, target })
    })
    this.projects.set(id, project)
    this.bus.publish('projects/changed', { cwd })
    return id
  }

  includeNewProjects(rows) {
    const known = new Set(rows.map(row => row.cwd))
    return [...rows, ...[...this.projects.values()].filter(p => p.createdAt && !known.has(p.cwd)).map(p => ({
      cwd: p.cwd, name: p.name, lastUpdatedAt: Math.floor(p.createdAt / 1000), threadCount: 0, activeCount: 0,
      models: [], git: null, latest: null,
    }))]
  }

  async openNewProject({ requestId, name, repository } = {}) {
    this.requireReady()
    if (typeof requestId !== 'string' || !/^[\w-]{12,128}$/.test(requestId) ||
        (repository ? typeof repository !== 'string' || !repository.startsWith('https://') || repository.length > 2048 :
          typeof name !== 'string' || !name.trim())) throw new HubError('codex-cli/bad-request', '请填写项目名或 HTTPS 仓库地址')
    const key = 'web-project-' + requestId
    const projectId = await this.provision(key, repository || 'new:' + name.trim())
    const task = await this.execute(key, { kind: 'create', projectId })
    if (!task.threadId) throw new HubError('codex-cli/router-task', '项目已登记，初始会话状态待核对，可从项目列表进入')
    return { cwd: this.projects.get(projectId).cwd, threadId: task.threadId }
  }

  recordMessage(message) {
    this.store.put('message', message.id, {routerThreadId:this.session?.id,...message})
    this.publish()
  }

  admit({ requestId, text } = {}, origin) {
    this.requireReady()
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{12,128}$/.test(requestId) ||
        typeof text !== 'string' || !text.trim() || text.length > textLimit) {
      throw new HubError('codex-cli/bad-request', '请输入有效的 Router 消息')
    }
    const id = 'user:' + requestId
    const previous = this.store.get('message', id)
    if (previous) {
      if (previous.text !== text || previous.origin?.generation !== origin?.generation) throw new HubError('codex-cli/router-conflict', '消息请求 ID 与原消息冲突')
      return { id, status: previous.status }
    }
    const message = { id, requestId, text, role: 'user', status: 'queued', turnId: null, routerThreadId: this.session.id,
      ...(origin && { origin, label: '你 · 微信' }) }
    this.recordMessage(message)
    return { id, status: message.status }
  }

  async send(payload) {
    await this.upgrade?.running
    const accepted = this.admit(payload)
    await this.drainInput()
    if (this.closed) throw new HubError('codex-cli/router-unavailable', '工作台正在关闭')
    return { id: accepted.id, status: this.store.get('message', accepted.id).status }
  }

  kickInputs() {
    queueMicrotask(() => this.drainInput().catch(() => this.logger?.warn?.('Router 输入队列暂时不可用')))
  }

  async drainInput() {
    if (this.upgrade?.running || this.closed || this.phase !== 'ready' || !this.app || this.active || this.nativeBusy) return
    const row = this.store.nextInput.get()
    if (!row) return
    const message = JSON.parse(row.value)
    if (message.routerThreadId !== this.session.id || (message.origin && !this.wechat?.owns(message.origin.generation))) {
      this.recordMessage({ ...message, status: 'cancelled' })
      this.kickInputs()
      return
    }
    const { text, requestId } = message
    const app = this.app
    message.status = 'sending'
    this.active = message
    this.earlyEvents = []
    message.startedAt = Date.now()
    this.recordMessage(message)
    try {
      const worker = this.hub.config
      const { turn } = await app.send(this.session.id, text, requestId, { relatedTasks: message.origin?.relatedTasks, workerDefaults: {
        model: worker.defaultModel, effort: worker.defaultEffort,
        permission: worker.defaultPermission, executionMode: worker.defaultExecutionMode,
      } })
      if (!turn?.id) throw new Error('Router 回合未确认')
      if (this.active === message) {
        if (message.turnId && message.turnId !== turn.id) throw new Error('Router 回合身份不匹配')
        this.bindTurn(message, turn.id)
        if (this.active === message) {
          message.status = 'accepted'
          this.recordMessage(message)
          if (['completed','failed','interrupted'].includes(turn.status)) this.onEvent('turn/completed', { threadId: this.session.id, turn })
        }
      }
    } catch (error) {
      if (this.active === message) {
        const rejected = [-32600, -32601, -32602].includes(error.code)
        message.status = rejected ? 'failed' : 'unknown'
        this.active = null
        this.finishMessage(message)
        if (rejected) { this.kickInputs(); this.wake.kick() }
        else this.resetApp(app)
      }
    }
  }

  bindTurn(message, turnId) {
    message.turnId = turnId
    const early = this.earlyEvents ?? []
    this.earlyEvents = []
    for (const [method, params] of early) {
      if (this.active === message && (params.turnId ?? params.turn?.id) === turnId) this.onEvent(method, params)
    }
  }

  finishMessage(message, answer) {
    this.store.transaction(() => {
      this.store.put('message', message.id, message)
      if (message.origin) this.wechat?.reply(message, answer)
    })
    this.publish()
  }

  onEvent(method, params) {
    if (!this.active || !this.session || params?.threadId !== this.session.id) return
    const active = this.active
    if (active.source === 'worker_receipt') {
      this.wake.onEvent(active, method, params)
      return
    }
    if (!active.turnId) {
      if (params.turnId && params.item?.type === 'userMessage' && params.item.clientId === active.requestId) {
        this.bindTurn(active, params.turnId)
      } else {
        // A late final item from another turn must never acquire this input's reply address.
        if ((method === 'turn/completed' || (method === 'item/completed' && finalAnswer([params.item].filter(Boolean)))) &&
            this.earlyEvents.length < 32) this.earlyEvents.push([method, params])
        return
      }
    }
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
      if (finalAnswer([params.item]) && (params.item.phase === 'final_answer' || !active.finalPhase)) {
        active.finalText = params.item.text.slice(0, 24000)
        active.finalPhase = params.item.phase
      }
      this.recordMessage({
        id: 'agent:' + params.item.id, role: 'assistant', text: String(params.item.text ?? '').slice(0, 24000),
        status: 'completed',
      })
    }
    if (method === 'turn/completed' && params.turn?.id === active.turnId) {
      active.status = params.turn.status
      this.clearDeltas()
      this.active = null
      const item = finalAnswer(params.turn.items)
      const answer = active.finalPhase === 'final_answer' && item?.phase !== 'final_answer' ? active.finalText : item?.text ?? active.finalText
      delete active.finalText
      delete active.finalPhase
      this.finishMessage(active, answer)
      this.kickInputs()
      this.wake.kick()
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
    const registeredByPath = new Map([...this.projects.values()].map(project => [project.cwd, project]))
    const candidates = new Map()
    const inventory=new Map(discovered.slice(0,100).map(row=>[row.cwd,row]))
    if(this.psm?.preference.enabled) for(const project of this.store.list('psm-project')) {
      if(!inventory.has(project.cwd)) inventory.set(project.cwd,{cwd:project.cwd})
    }
    for (const item of inventory.values()) {
      if (typeof item.cwd !== 'string') continue
      try {
        const cwd = await realpath(item.cwd)
        const registered = registeredByPath.get(cwd)
        if (registered && await checkProject(registered).catch(() => null)) continue
        const name = shortText(item.name || basename(cwd), 120)
        const projects = await loadRouterProjects([{ id: 'discovered', name, cwd }], this.directory)
        const project = projects.get('discovered')
        const id = 'auto-' + createHash('sha256').update(cwd + '\u0000' + project.identity).digest('hex').slice(0, 32)
        if (this.projects.has(id) || candidates.has(id)) continue
        candidates.set(id, { ...project, id })
        byCwd.set(cwd, item)
      } catch { /* Ignore missing or ineligible discovered directories. */ }
    }
    return [...this.projects.values(), ...candidates.values()].map(project => {
      const meta = byCwd.get(project.cwd)
      const updatedAt = meta?.lastUpdatedAt
      return {
        id: project.id, name: project.name, aliases: [...project.aliases, project.cwd], projectId: project.id,
        ...(candidates.has(project.id) ? { requiresApproval: true, pendingProject: project } : {}),
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
    const key = JSON.stringify(source.source === 'worker_receipt'
      ? [this.session.id, source.turnId, source.batch.requestId, params.callId]
      : [this.session.id, source.turnId, params.callId])
    const existing = this.store.get('tool-call', key)
    if (existing?.refresh && existing.tool===params.tool && existing.inputHash===createHash('sha256').update(JSON.stringify(params.arguments) ?? '').digest('hex')) {
      try {
        const args=validateTool(params.tool,params.arguments)
        return toolResult(true,params.tool==='psm_search'?await this.psm.search(args):await this.psm.get(args.ref))
      }
      catch {return toolResult(false,{code:'sourceUnavailable'})}
    }
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
    if (!this.closed) {
      const readOnly=response.success && ['psm_search','psm_get'].includes(params.tool) &&
        JSON.parse(response.contentItems[0].text)?.status!=='needs_confirmation'
      this.store.put('tool-call',key,{tool:params.tool,at:Date.now(),...(readOnly ? {refresh:true,
        inputHash:createHash('sha256').update(JSON.stringify(params.arguments)).digest('hex')} : {response})})
    }
    return response
  }

  async handleTool(name, args, source) {
    if (source.source === 'worker_receipt') {
      if (name !== 'get_task_status' || !source.batch.dispatchIds.includes(args.dispatchId)) {
        throw new HubError('codex-cli/router-receipt-scope', '自动回执只能读取本批次的任务')
      }
      const task = this.dispatcher.get(args.dispatchId)
      const result = await this.dispatcher.result(task.id).catch(() => ({ resultAvailability: 'temporarily_unavailable' }))
      return {
        id: task.id, project: this.projects.get(task.projectId)?.name ?? task.projectId,
        threadId: task.threadId, turnId: task.turnId, executionStatus: task.executionStatus,
        ...result,
      }
    }
    const limit = args.limit ?? 12
    switch (name) {
      case 'psm_search': return this.psm.search(args)
      case 'psm_get': {
        this.psm.requireEnabled()
        if(args.ref.startsWith('project:') && !(await this.psm.allowed(args.ref.slice(8))).size) {
          const candidate=(await this.projectRows()).find(row=>row.id===args.ref.slice(8) && row.pendingProject)
          if(!candidate) throw new HubError('codex-cli/router-project','未发现此项目')
          return this.clarify(source,{kind:'psmAccess',label:'允许 Router 阅读此项目的会话历史？',
            candidates:[{id:candidate.id,projectId:candidate.id,name:candidate.name,pendingProject:candidate.pendingProject}]})
        }
        return this.psm.get(args.ref)
      }
      case 'psm_save':
      case 'psm_update':
      case 'psm_remove': {
        const proposal=await this.psm.proposal(name,args,source)
        if(this.active!==source) throw new HubError('codex-cli/router-stale','回合已结束')
        if(args.confirmation==='request' || proposal.previous) {
          const session=proposal.threadId && await this.psm.sync.db.call('source',proposal.threadId)
          if(this.active!==source) throw new HubError('codex-cli/router-stale','回合已结束')
          const project=this.projects.get(proposal.projectId) ?? this.store.get('psm-read-grant',proposal.projectId)
          return this.clarify(source,{
            kind:'psmMemory',proposal,label:proposal.state==='revoked'?'撤销这条项目记忆？':'确认这条记忆及其目标？',
            candidates:[{id:proposal.id,name:proposal.value,projectId:proposal.projectId,threadId:proposal.threadId,
              project:project.name,summary:session ? [session.title,session.id].filter(Boolean).join(' · ') : project.cwd}],
          })
        }
        return this.psm.apply(proposal,'model_inferred')
      }
      case 'list_projects':
        return rankCandidates(await this.projectRows(), args.query, { original: source.text }).slice(0, limit)
          .map(({ aliases, pendingProject, ...row }) => row)
      case 'list_sessions': {
        const projects = args.projectId ? [this.projects.get(args.projectId)] : [...this.projects.values()]
        const lists = []
        for (let offset = 0; offset < projects.length; offset += 10) {
          const page = await Promise.allSettled(projects.slice(offset, offset + 10).map(project => this.sessions(project)))
          for (const result of page) {
            if (result.status === 'fulfilled') lists.push(result.value)
            else if (args.projectId) throw result.reason
          }
        }
        const last = this.store.get('binding', 'last')
        return rankCandidates(lists.flat(), args.query, { original: source.text }).slice(0, limit)
          .map(row => row.id === last?.threadId ? { ...row, lastDispatchedAt: last.at } : row)
      }
      case 'get_session': {
        const { project, detail } = await this.resolveThread(args.threadId)
        const recent = detail.turns.slice(-4).map(turn => ({
          startedAt: turn.startedAt,
          user: shortText(turn.items?.find(item => item.type === 'userMessage')?.content
            ?.filter(part => part.type === 'text').map(part => part.text).join(' ')),
          reply: shortText(turn.items?.findLast(item => item.type === 'agentMessage')?.text),
        }))
        source.inspected ??= []
        if (!source.inspected.includes(detail.thread.id)) source.inspected.push(detail.thread.id)
        return { ...this.sessionRow(project, detail.thread), recent }
      }
      case 'get_task_status': return this.getTask(args.dispatchId)
      case 'interrupt_task': {
        const task = this.dispatcher.get(args.dispatchId)
        if (!task.turnId || !['running', 'awaiting_approval', 'awaiting_input'].includes(task.status)) {
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
        if (args.requestId !== source.requestId) {
          const pending = this.store.get('clarification', args.requestId + ':session')
          const choice = pending?.candidates.find(row => row.id === args.threadId && row.projectId === args.projectId)
          const selection = { kind: 'choice', id: pending?.id, threadId: args.threadId, projectId: args.projectId }
          const old = previousOperation(this.store, source.requestId, selection)
          if (old?.id) return old
          if (!pending?.semanticChoice || (!old && pending.status !== 'pending') || !choice || choice.grant ||
              !pending.sourceRouterTurnId || pending.sourceRouterTurnId === source.turnId) {
            throw new HubError('codex-cli/router-conflict', '该消息不能确认此任务或代替用户授权')
          }
          this.saveOperation(source.requestId, selection, null)
          const result = await this.confirm({ id: pending.id, revision: pending.revision, candidateId: choice.id }, false, false)
          this.saveOperation(source.requestId, selection, result)
          return result
        }
        return this.prepare(source, { kind: 'dispatch', ...args, instruction: source.text })
    }
  }

  async prepare(source, intent) {
    intent = { ...intent, sourceRouterTurnId: source.turnId }
    if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前 Router 回合已结束')
    const waiting = this.store.get('clarification', source.requestId + ':projectRoot')
    if (waiting) {
      if (waiting.status === 'pending') return { status: 'needs_confirmation', id: waiting.id, requires: '设置默认新项目父目录' }
      return waiting.result ?? { status: waiting.status, id: waiting.id }
    }
    const permissionQuestion = this.store.get('clarification', source.requestId + ':workerPermission')
    if (permissionQuestion?.status === 'cancelled') return {status:'cancelled', id:permissionQuestion.id}
    if ((intent.kind === 'create' || intent.mode === 'new') && /^(?:new:|https:\/\/)/.test(intent.projectId)) {
      if (!this.settings().projectRoot && !this.store.get('new-project', source.requestId)) {
        newProjectTarget(intent.projectId)
        return { ...this.clarify(source, { kind: 'projectRoot', intent, candidates: [],
          label: '新项目要放在哪个父目录？' }), requires: '设置默认新项目父目录' }
      }
      intent.projectId = await this.provision(source.requestId, intent.projectId)
      if (this.closed || this.active !== source) throw new HubError('codex-cli/router-stale', '项目已登记，原调度回合已结束')
    }
    const existing = previousOperation(this.store, source.requestId, intent)
    if (existing) return existing
    const pending = this.store.list('clarification').find(item => item.requestId === source.requestId &&
      item.status === 'pending' && item.expiresAt > Date.now())
    if (pending) return { status: 'needs_confirmation', id: pending.id }
    if (intent.kind === 'dispatch' && intent.mode !== 'new' && !intent.threadId) {
      // Older Router threads retain their original tool schema. They can nominate inspected sessions too.
      const ids = intent.candidateThreadIds ?? source.inspected ?? []
      if (ids.length < 2 || ids.length > 4) throw new HubError('codex-cli/router-target', '请选择 2 至 4 个真实候选会话')
      const candidates = await Promise.all(ids.map(async id => {
        const { project, detail } = await this.resolveThread(id)
        return this.workerCandidate(project, detail.thread, intent.workerPermission)
      }))
      if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前回合已结束')
      return this.clarify(source, { kind: 'session', semanticChoice: true,
        label: intent.reason || '你想继续哪个任务？', intent, candidates })
    }

    const registered = this.projects.get(intent.projectId)
    const project = await checkProject(registered ?? (await this.projectRows()).find(row => row.id === intent.projectId)?.pendingProject)
    let candidate
    if (intent.threadId) {
      const issue=await this.psm.targetIssue(project,intent.threadId)
      if(issue) throw new HubError('codex-cli/router-thread',issue)
      const { thread } = await this.hub.routerReadWorker(intent.threadId)
      await checkThread(project, thread, this.session.id)
      if (thread.id !== intent.threadId) throw new HubError('codex-cli/router-thread', 'Worker 会话身份不匹配')
      candidate = await this.workerCandidate(project, thread, intent.workerPermission)
    }
    if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前回合已结束')
    if (!registered) return this.clarify(source, {
      kind: 'project', label: '允许 Router 使用此项目并继续当前任务？', intent,
      candidates: [{ ...candidate, id: project.id, projectId: project.id, pendingProject: project,
        name: project.name + '（' + project.cwd + '）' + (candidate ? ' · ' + candidate.name : ' · 新建只读会话') }],
    })
    if (candidate?.grant) return this.clarify(source, {
      kind: 'session', label: '允许 Router 按这个会话的现有权限续接？', intent, candidates: [candidate],
    })
    return this.execute(source.requestId, intent)
  }

  async workerCandidate(project, thread, requestedPermission) {
    const row = this.sessionRow(project, thread)
    const settings = await this.hub.routerWorkerSettings(thread.id)
    const invalid = workerIdentityIssue(project, settings)
    if (invalid) throw new HubError('codex-cli/router-worker-settings', invalid)
    if (requestedPermission) return row // The requested policy is checked against the selected project before enqueue.
    if (!workerDispatchIssue(project, settings, { existing: true, grant: this.store.get('worker-grant', thread.id) })) return row
    const grant = { identity: project.identity, settings }
    return { ...row, grant, summary: [row.summary, '选择即授权此会话沿用现有设置（' +
      describeWorkerSettings(settings) + '）。后续相同设置可直接续接。'].filter(Boolean).join(' · ') }
  }

  clarify(source, value) {
    const memory = value.kind === 'psmMemory' || value.kind === 'psmAccess'
    const id = source.requestId + ':' + value.kind + (memory ? ':' + value.candidates[0].id : '')
    if (!memory && this.store.get('operation', source.requestId)) return { status: 'alreadyHandled' }
    const existing = this.store.get('clarification', id)
    if (existing?.status === 'pending' && existing.expiresAt > Date.now()) return { status: 'needs_confirmation', id }
    const row = {
      ...value, id, requestId: source.requestId, original: source.text,
      sourceRouterTurnId: source.turnId ?? null,
      revision: (existing?.revision ?? 0) + 1, status: 'pending',
      expiresAt: value.kind === 'projectRoot' ? Number.MAX_SAFE_INTEGER : Date.now() + lifetime,
    }
    this.store.put('clarification', id, row)
    this.publish()
    return { status: 'needs_confirmation', id }
  }

  async confirm({ id, revision, candidateId } = {}, cancel = false, explicit = true) {
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
      ...row, status: cancel ? 'cancelled' : 'confirming', candidateId, explicit,
    })
    this.publish()
    if (cancel) return { status: 'cancelled' }
    return this.completeConfirmation(next)
  }

  completeConfirmation(row) {
    const running = this.confirming.get(row.id)
    if (running) return running
    const pending = this.applyConfirmation(row).then(result => {
      this.store.transaction(() => {
        if(row.semanticChoice && row.explicit && this.psm.preference.enabled && row.kind==='session') {
          const target=row.candidates.find(c=>c.id===row.candidateId)
          const project=this.projects.get(target?.projectId)
          const uid=project && this.psm.identity(project)
          if(uid && target.id!=='create') this.psm.recordChoice({uid,projectId:project.id,threadId:target.id,row})
        }
        this.store.put('clarification', row.id, { ...row, status: 'confirmed', result })
        if (row.kind === 'projectRoot' && result.status !== 'needs_confirmation') this.store.put('message', 'root-result:' + row.id, {
          id: 'root-result:' + row.id, role: 'assistant', status: 'completed',
          text: result.cwd ? ('项目目录：' + result.cwd + (row.intent.kind === 'create' ? '，已创建会话。' : '，任务已排队。')) : '项目操作结果待核对，请查看任务。',
        })
      })
      this.publish()
      return result
    }).catch(error => {
      const status = error.code === 'codex-cli/router-unavailable' ? 'confirming' : 'expired'
      this.store.transaction(() => {
        this.store.put('clarification', row.id, { ...row, status })
        if (row.kind === 'projectRoot' && status === 'expired') this.store.put('message', 'root-result:' + row.id, {
          id: 'root-result:' + row.id, role: 'assistant', status: 'completed', text: '新建项目未完成：' + error.message,
        })
      })
      this.publish()
      throw error
    }).finally(() => this.confirming.delete(row.id))
    this.confirming.set(row.id, pending)
    return pending
  }

  async applyConfirmation(row) {
    this.requireReady()
    if (row.kind === 'psmMemory') {
      this.psm.requireEnabled()
      const draft=row.proposal
      const result=this.store.get('psm-entry',draft.id)
      if(result?.confirmation===row.id && result.revision===draft.previous+1) return {ref:'entry:'+draft.id,revision:result.revision}
      const allowed=await this.psm.allowed(draft.projectId)
      if(!allowed.has(draft.uid) || (draft.state!=='revoked' && draft.threadId && (await this.psm.source(draft.threadId,allowed)).state!=='active')) {
        throw new HubError('codex-cli/router-stale','来源已失效')
      }
      if(draft.evidenceRef!==('user:'+draft.requestId)) await this.psm.get(draft.evidenceRef)
      return this.psm.apply(draft,'user_confirmed',row.id)
    }
    if (row.kind === 'psmAccess') {
      const project=await checkProject(row.candidates[0].pendingProject)
      this.psm.requireEnabled()
      this.store.put('psm-read-grant',project.id,project)
      return {projectId:project.id,status:'authorized'}
    }
    if (row.kind === 'workerPermission') {
      const project = await checkProject(this.projects.get(row.intent.projectId))
      if (row.projectIdentity !== project.identity) throw new HubError('codex-cli/router-stale', '项目身份已变化')
      return this.execute(row.requestId, row.intent, row.worker)
    }
    if (row.kind === 'projectRoot') {
      const projectId = await this.provision(row.requestId, row.intent.projectId)
      return this.execute(row.requestId, { ...row.intent, projectId })
    }
    const candidate = row.candidates.find(item => item.id === row.candidateId)
    if (row.kind === 'interrupt') return this.execute(row.requestId, { kind: 'interrupt', ...row.intent })
    let project = this.projects.get(candidate.projectId)
    if (row.kind === 'project' && candidate.pendingProject) {
      const pending = await checkProject(candidate.pendingProject)
      if (!project) {
        this.store.put('approved-project', pending.id, pending)
        this.projects.set(pending.id, pending)
        project = pending
      } else if (project.cwd !== pending.cwd || project.identity !== pending.identity) {
        throw new HubError('codex-cli/router-project', '项目目录已改变，需要重新确认')
      }
    }
    await checkProject(project)
    const threadId = row.kind === 'project' ? row.intent.threadId : candidate.id
    if (candidate.grant) {
      await this.resolveThread(threadId, project.id)
      const effective = await this.hub.routerWorkerSettings(threadId)
      if (candidate.grant.identity !== project.identity || !isDeepStrictEqual(effective, candidate.grant.settings)) {
        throw new HubError('codex-cli/router-stale', 'Worker 执行配置已变化，请重新选择')
      }
      this.store.put('worker-grant', threadId, candidate.grant)
    }
    if (row.kind === 'project') {
      if (threadId) await this.resolveThread(threadId, project.id)
      return this.execute(row.requestId, { ...row.intent, projectId: project.id })
    }
    if (candidate.id === 'create') {
      return this.execute(row.requestId, { ...row.intent, projectId: project.id, threadId: undefined, mode: 'new' })
    }
    await this.resolveThread(candidate.id, project.id)
    return this.execute(row.requestId, { ...row.intent, projectId: project.id, threadId: candidate.id })
  }

  async execute(requestId, intent, approvedWorker) {
    this.requireReady()
    const old = previousOperation(this.store, requestId, intent)
    if (old) return old
    if (intent.kind === 'dispatch') {
      const project = this.projects.get(intent.projectId)
      const worker = approvedWorker ?? await this.workerOptions(intent)
      if (worker?.permission && !approvedWorker) {
        const access = permissionPayload(worker.permission, true)
        const desired = { cwd: project.cwd, approvalPolicy: access.approvalPolicy,
          approvalsReviewer: access.approvalsReviewer, sandbox: access.sandboxPolicy }
        const issue = workerDispatchIssue(project, desired)
        const current = issue && intent.threadId ? await this.hub.routerWorkerSettings(intent.threadId) : null
        const currentAuthorized = current && isDeepStrictEqual(current, desired) && !workerDispatchIssue(project, current,
          {existing:true,grant:this.store.get('worker-grant', intent.threadId)})
        if (issue && !currentAuthorized) return this.clarify({requestId, text:intent.instruction, turnId:intent.sourceRouterTurnId}, {
          kind:'workerPermission', label:'允许此任务使用指定的 Worker 权限？', intent, worker, projectIdentity:project.identity,
          candidates:[{id:'allow',name:project.name + ' · ' + describeWorkerSettings(desired),
            summary:(intent.threadId ? '会话 ' + intent.threadId : '新建会话') + ' 将使用此权限执行任务。'}],
        })
      }
      const psmProjectUid=this.psm?.preference.enabled ? this.psm.identity(project) : null
      const task = this.dispatcher.enqueue({ ...intent, requestId, worker, psmProjectUid }, value => {
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

  async workerOptions(intent) {
    const config = this.hub.config
    const model = intent.workerModel ?? config.defaultModel
    let effort = intent.workerEffort ?? config.defaultEffort
    if (intent.workerModel || intent.workerEffort) {
      const catalog = await this.hub.models()
      const entry = catalog.find(row => row.id === model)
      if (!entry) throw new HubError('codex-cli/router-worker-model','可用的 Worker 模型：' + catalog.map(row=>row.id).join('、'))
      if (!entry.supportedReasoningEfforts.some(level => level.reasoningEffort === effort)) {
        if (intent.workerEffort) throw new HubError('codex-cli/router-worker-model',model + ' 支持的思考强度：' + entry.supportedReasoningEfforts.map(level=>level.reasoningEffort).join('、'))
        effort = entry.defaultReasoningEffort
      }
    }
    const permission = intent.workerPermission ?? (intent.mode === 'new' ? config.defaultPermission : null)
    return {model, effort, executionMode:intent.executionMode ?? config.defaultExecutionMode,
      ...(permission && permission !== 'inherit' ? {permission} : {})}
  }

  saveOperation(requestId, intent, result) {
    this.store.put('operation', requestId, { kind: intent.kind, fingerprint: operationFingerprint(intent), result, at: Date.now() })
    if (result?.projectId && result.threadId) {
      this.store.put('binding', 'last', { projectId: result.projectId, threadId: result.threadId, at: Date.now() })
    }
  }

  async close() {
    this.closed = true
    this.active = null
    this.clearDeltas()
    this.epoch = null
    this.connectionAbort?.abort()
    this.app?.close()
    clearTimeout(this.reconnectTimer)
    await this.opening
    await Promise.allSettled(this.confirming.values())
    await Promise.allSettled([...this.creatingProjects.values()].map(row => row.promise))
    await this.upgrade?.close()
    await this.psm?.close()
    await this.wechat?.close()
    await this.wake?.close()
    await this.dispatcher?.close()
    this.store?.close()
  }
}
