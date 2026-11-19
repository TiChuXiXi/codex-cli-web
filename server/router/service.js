import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HubError } from '../codex/hub.js'
import { connectRouterApp } from './app-server.js'
import { redact } from './psm-index.js'
import { finalAnswer, RouterDispatcher } from './dispatcher.js'
import { recoverLegacyOutput, routerTurnAnswer, stageRouterAnswer, toolOutcome } from './transcript.js'
import { rankCandidates } from './matching.js'
import { checkProject, checkThread, describeWorkerSettings, loadRouterProjects, shortText, workerDispatchIssue, workerIdentityIssue, workerSettingsStamp } from './projects.js'
import { RouterSessionUpgrade } from './psm-migration.js'
import { ProjectSessionMemory } from './psm.js'
import { RouterStore } from './store.js'
import { makeProject, newProjectTarget, projectParent } from './new-project.js'
import { routerNamespace, toolNames, toolResult, validateTool } from './tools.js'
import { RouterWakeScheduler, turnDuration } from './wake.js'
import { permissionPayload } from '../../shared/worker-options.js'

import { defaultPresentation } from '../../shared/router-presentation.js'

const lifetime = 24 * 60 * 60 * 1000
const textLimit = 12000
function operationFingerprint(intent) {
  const fields = [intent.kind, intent.projectId ?? null, intent.threadId ?? null,
    intent.mode ?? null, intent.title ?? null, intent.id ?? null, intent.turnId ?? null,
    intent.instruction ?? null]
  const overrides = [intent.workerModel, intent.workerEffort, intent.workerPermission, intent.executionMode]
  if (overrides.some(Boolean)) fields.push(...overrides.map(value => value ?? null))
  if (intent.workerAction) fields.push(intent.workerAction, intent.expectedTurnId ?? null)
  return JSON.stringify(fields)
}

// Only an explicit list of independently targeted projects can share a user message.
function separateProjectNames(text) {
  const list = /^(?:任务[：:]\s*)?(?:请\s*)?(?:分别|同时|各自|依次)\s*(?:续接|继续|恢复)\s*([^。！？；\n]+?)\s*的[「“"\s]*(?:[^。！？；\n]*?)会话/u.exec(text.trim())?.[1]
  if (!list) return []
  const names = list.split(/\s*(?:以及|和|与|、|,|，)\s*/u).map(name => name.trim())
  return names.length > 1 && names.every(Boolean) && new Set(names).size === names.length ? names : []
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
      await recoverLegacyOutput(this.store, app, session.id, () => this.epoch === epoch && !this.closed)
        .catch(() => this.logger?.warn?.('Router 旧过程记录暂时无法恢复'))
      if (this.closed || this.epoch !== epoch) { app.close(); return }
      this.phase = 'ready'
      this.error = null
      this.logger?.info?.(`Router 已就绪（${app.selected.model}，${this.projects.size} 个登记项目）`)
      this.publish()
      this.dispatcher.schedule()
      this.kickInputs()
      this.wake.kick()
      this.resumeRootRequests()
      for (const row of this.store.list('clarification').filter(c => c.resumeAfterRead)) this.resumeAfterRead(row.requestId)
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
          this.active = { ...message, turnId: turn.id, answer: routerTurnAnswer(turn.items) }
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
      if (turn) this.restoreAgentItems(turn)
      this.finishMessage({
        ...message, turnId: turn?.id ?? message.turnId, status: turn?.status ?? 'unknown',
        durationMs: turn ? turnDuration(turn, message.startedAt) : undefined,
      }, turn?.status === 'completed' ? routerTurnAnswer(turn.items)?.text : undefined)
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
    if (active && active.source !== 'worker_receipt') {
      delete active.answer
      this.recordMessage({ ...active, status: 'unknown' })
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
    this.bus.publish('router/changed', this.status())
  }

  status() {
    return { enabled: this.config.enabled, phase: this.phase, displayName: this.presentation().displayName,
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
      activeTurnId: this.active?.turnId ?? undefined,
      pendingReceiptTurnIds: this.session && this.store.wakeRecovery(this.session.id).flatMap(batch => batch.turnId ? [batch.turnId] : []),
      receiptLimited: this.wake?.limited() ?? false,
      primaryThreadId:this.session?.id, previousThreads,
      queuedCount: this.store?.queuedInputCount.get().count ?? 0,
      messages: [
        ...(this.store?.list('message', 80).filter(m=>!previousThreads.length || m.routerThreadId===this.session?.id || (m.dispatchId && this.store.get('task',m.dispatchId)?.routerThreadId===this.session?.id)).reverse()
          .flatMap(message => message.turnId ? [message] : (this.store.get('legacy-output', message.id)?.messages ?? [message]))
          .map(message => ({ id: message.id, role: message.role, label: message.label, text: message.text, status: message.status,
            turnId: message.turnId, phase: message.phase, durationMs: message.durationMs, tool: message.tool,
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
      ...(task.workerAction ? { workerAction: task.workerAction } : {}),
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

  presentation() {
    return { ...defaultPresentation, ...this.store?.get('settings','defaults')?.presentation }
  }

  settings() {
    const saved = this.store?.get('settings', 'defaults')
    return { models: this.app?.models ?? [], model: this.app?.defaultSelection ?? saved?.model ?? this.config.models?.[0],
      projectRoot: saved?.projectRoot ?? this.config.projectRoot ?? '', revision: saved?.revision ?? 0,
      presentation: this.presentation() }
  }

  async setupProjectRoot({ projectRoot, defer, clarification, revision, waitingIds } = {}) {
    if (!this.store || this.closed) throw new HubError('codex-cli/router-unavailable', '工作台正在启动')
    if (defer === true) {
      this.store.put('settings', 'root-prompt-deferred', { deferred: true })
    } else {
      const root = await projectParent(projectRoot, this.stateDir)
      if (this.closed) throw new HubError('codex-cli/router-unavailable', '工作台正在关闭')
      if (clarification) {
        const row = this.store.get('clarification', clarification)
        const pending = this.store.list('clarification').filter(c => c.kind === 'projectRoot' && c.status === 'pending')
        if (!pending.some(c => c.id === clarification) || row.revision !== revision ||
            !isDeepStrictEqual(pending.map(c => c.id).sort(), waitingIds)) {
          throw new HubError('codex-cli/router-stale', '等待设置目录的项目已变化，请重新查看待办')
        }
      }
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

  async saveSettings({ model, projectRoot, revision, presentation } = {}) {
    this.requireReady()
    const current = this.settings()
    const root = projectRoot === current.projectRoot || projectRoot === '' ? projectRoot : await projectParent(projectRoot, this.stateDir)
    this.requireReady()
    const selected = this.app.resolveSelection(model)
    if (!selected) throw new HubError('codex-cli/bad-request', '请选择账号支持的 Router 模型与思考强度')
    if (revision !== this.settings().revision) throw new HubError('codex-cli/router-stale', '设置已更新，请重新加载')
    const next = { ...this.presentation(), ...presentation }
    for (const [field, limit] of Object.entries({displayName:32,selfName:32,personality:320,style:240,wechatStyle:320})) {
      if (typeof next[field] !== 'string' || !next[field].trim() || next[field].length > limit) {
        throw new HubError('codex-cli/bad-request', '名称或表达偏好为空或过长')
      }
      next[field] = next[field].trim()
    }
    if (Object.keys(next).some(k => !Object.hasOwn(defaultPresentation,k)) || !['简洁','适中','详细'].includes(next.brevity) ||
        typeof next.typing !== 'boolean' || !Number.isInteger(next.processingSeconds) || next.processingSeconds < 1 ||
        next.processingSeconds > 60 || !Number.isInteger(next.stageSeconds) || next.stageSeconds < next.processingSeconds ||
        next.stageSeconds > 600) throw new HubError('codex-cli/bad-request', '请检查回复风格和微信反馈时间')
    this.store.put('settings', 'defaults', { model: selected, projectRoot: root, revision: revision + 1, presentation: next })
    if (!isDeepStrictEqual(selected,current.model)) {
      this.app.setDefault(selected)
      if (!this.app.resolveSelection(this.session?.modelSelection)) this.app.select(null)
    }
    if (root !== current.projectRoot) this.resumeRootRequests()
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
    const cwd = this.projects.get(projectId).cwd
    if (task.status === 'needs_confirmation') return { cwd, status: 'needs_confirmation' }
    if (!task.threadId) throw new HubError('codex-cli/router-task', task.message ?? '项目已登记，初始会话状态待核对，可从项目列表进入')
    return { cwd, threadId: task.threadId }
  }

  recordMessage(message) {
    this.store.put('message', message.id, {routerThreadId:this.session?.id,...message})
    if (message.origin && message.status === 'queued') this.wechat?.progress?.queued(message)
    if (this.active?.origin && message.tool?.status === 'running') this.wechat?.progress?.tool(this.active,message)
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
      const { turn } = await app.send(this.session.id, text, requestId, { relatedTasks: message.origin?.relatedTasks,
        presentation:this.presentation(), channel:message.origin ? 'wechat' : 'web',
        choice: message.origin?.choice && this.semanticCandidates(message),
        continuedFrom: message.origin?.continuedFrom, workerDefaults: {
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
    if (message.origin && message.status === 'completed') this.resumeAfterRead(message.requestId)
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
        const terminal = method === 'turn/completed'
        const outputItem = method === 'item/completed' && ['agentMessage', 'dynamicToolCall'].includes(params.item?.type)
        if (terminal || outputItem) {
          if (this.earlyEvents.length >= 32 && (terminal || routerTurnAnswer([params.item]))) {
            this.earlyEvents.shift()
          }
          if (this.earlyEvents.length < 32) this.earlyEvents.push([method, params])
        }
        return
      }
    }
    if (method === 'item/started' && active.turnId === params.turnId &&
        params.item?.type === 'userMessage' && params.item.clientId === active.requestId && !this.session.materialized) {
      this.session = this.store.put('session', 'active', { ...this.session, materialized: true })
    }
    if (active.turnId === params.turnId) {
      this.trackAgentMessage(method, params)
      if (method === 'item/completed' && params.item) stageRouterAnswer(active, params.item)
    }
    if (method === 'turn/completed' && params.turn?.id === active.turnId) {
      active.status = params.turn.status
      active.durationMs = turnDuration(params.turn, active.startedAt)
      this.restoreAgentItems(params.turn)
      this.clearDeltas()
      this.active = null
      const answer = active.status === 'completed' ? routerTurnAnswer(params.turn.items, active.answer)?.text : undefined
      delete active.answer
      this.finishMessage(active, answer)
      this.kickInputs()
      this.wake.kick()
    }
  }

  agentMessage(turnId, item, text, status) {
    return {
      id: 'agent:' + item.id, turnId,
      phase: item.phase, role: 'assistant', text: text.slice(0, 24000), status,
    }
  }

  restoreAgentItems(turn, receipt = false) {
    for (const item of turn.items ?? []) {
      if (item.type !== 'agentMessage' || !item.id || typeof item.text !== 'string' ||
          (receipt && item.phase !== 'commentary')) continue
      const message = this.agentMessage(turn.id, item, item.text, 'completed')
      const existing = this.store.get('message', message.id)
      if (existing?.text !== message.text || existing.phase !== message.phase || existing.turnId !== turn.id) {
        this.store.put('message', message.id, { ...message, routerThreadId: this.session.id })
      }
    }
  }

  trackAgentMessage(method, { turnId, item, itemId, delta }, receipt = false) {
    if (method === 'item/started' && item?.type === 'agentMessage' && item.id) {
      const message = this.agentMessage(turnId, item, String(item.text ?? ''), 'streaming')
      this.deltas.set(message.id, message)
    } else if (method === 'item/agentMessage/delta' && typeof itemId === 'string' && typeof delta === 'string') {
      const id = 'agent:' + itemId
      const previous = this.deltas.get(id)
      this.deltas.set(id, this.agentMessage(turnId, { id: itemId, phase: previous?.phase }, (previous?.text ?? '') + delta, 'streaming'))
    } else if (method === 'item/completed' && item?.type === 'agentMessage' && item.id) {
      const message = this.agentMessage(turnId, item, String(item.text ?? ''), 'completed')
      if (receipt && item.phase !== 'commentary') {
        this.deltas.set(message.id, message)
        this.publish()
      } else {
        this.deltas.delete(message.id)
        this.recordMessage(message)
      }
      return
    } else return

    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => { this.deltaTimer = null; this.publish() }, 100)
      this.deltaTimer.unref()
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

  readableProjects() {
    const projects = new Map(this.projects)
    if (this.psm.preference.enabled) for (const grant of this.store.list('psm-read-grant')) {
      if (!projects.has(grant.id) && this.psm.identity(grant)) projects.set(grant.id, grant)
    }
    return projects
  }

  async resolveThread(id, projectId, includeReadable = false) {
    const detail = await this.hub.routerReadWorker(id)
    const projects = includeReadable ? this.readableProjects() : this.projects
    const project = projectId ? projects.get(projectId) : [...projects.values()].find(item => item.cwd === detail.thread?.cwd)
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
    stageRouterAnswer(source, { type: 'dynamicToolCall' })
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
    const activity = toolNames.includes(params.tool) ? {
      id: 'tool:' + key, routerThreadId: this.session.id, turnId: source.turnId,
      role: 'assistant', text: '', status: 'completed', tool: { name: params.tool, status: 'running' },
    } : null
    if (activity) this.recordMessage(activity)
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
      if (source.origin && response.success) {
        const result = JSON.parse(response.contentItems[0].text)
        if (result?.status === 'needs_confirmation' ||
            (params.tool === 'dispatch_task' && result?.id && this.store.get('task',result.id))) source.handedOff = true
      }
      if (activity) {
        activity.tool.status = response.success ? 'completed' : 'failed'
        activity.tool.outcome = toolOutcome(response)
        this.recordMessage(activity)
      }
    }
    return response
  }

  semanticCandidates(source) {
    const ref = source.origin.choice
    const row = this.store.get('clarification', ref.id)
    if (!row?.semanticChoice || row.status !== 'pending' || row.revision !== ref.revision ||
        row.expiresAt <= Date.now() || (row.routerThreadId && row.routerThreadId !== this.session.id)) return []
    return row.candidates.filter(c => !c.grant && !c.pendingProject && !c.settingsReview).map(c => ({
      projectId: c.projectId, threadId: c.id, title: c.phoneTitle || '历史会话', summary: c.phoneSummary || '',
      requestId: row.requestId }))
  }

  async handleTool(name, args, source) {
    if (source.origin?.choice) {
      const hits = this.semanticCandidates(source).filter(c => c.requestId === args.requestId &&
        c.projectId === args.projectId && c.threadId === args.threadId)
      if (name !== 'dispatch_task' || hits.length !== 1 || args.workerAction || args.workerPermission ||
          args.mode !== 'resume') throw new HubError('codex-cli/router-stale', '只能建议一个当前列表中的普通候选')
      if (source.suggestedCandidate && source.suggestedCandidate !== hits[0].threadId) source.ambiguousChoice = true
      source.suggestedCandidate = source.ambiguousChoice ? null : hits[0].threadId
      return { status:'needs_confirmation' }
    }
    if (source.source === 'worker_receipt') {
      if (name !== 'get_task_status' || !source.batch.dispatchIds.includes(args.dispatchId)) {
        throw new HubError('codex-cli/router-receipt-scope', '自动回执只能读取本批次的任务')
      }
      const task = this.dispatcher.get(args.dispatchId)
      const result = await this.dispatcher.result(task.id).catch(() => ({ resultAvailability: 'temporarily_unavailable' }))
      return {
        id: task.id, project: this.projects.get(task.projectId)?.name ?? task.projectId,
        threadId: task.threadId, turnId: task.turnId, executionStatus: task.executionStatus,
        answeredInteractions: this.store.answeredInteractions(task.id), ...result,
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
        const readable = this.readableProjects()
        const projects = args.projectId ? [readable.get(args.projectId)] : [...readable.values()]
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
        const { project, detail } = await this.resolveThread(args.threadId, undefined, true)
        const recent = detail.turns.slice(-4).map(turn => ({
          startedAt: turn.startedAt,
          user: shortText(turn.items?.find(item => item.type === 'userMessage')?.content
            ?.filter(part => part.type === 'text').map(part => part.text).join(' ')),
          reply: shortText(turn.items?.findLast(item => item.type === 'agentMessage')?.text),
        }))
        source.inspected ??= []
        if (!source.inspected.includes(detail.thread.id)) source.inspected.push(detail.thread.id)
        const settings = workerSettingsStamp(await this.hub.routerWorkerProfile(detail.thread.id))
        const invalid = workerIdentityIssue(project, settings)
        if (invalid) throw new HubError('codex-cli/router-worker-settings', invalid)
        return { ...this.sessionRow(project, detail.thread), recent, settings: {
          model: settings.model, effort: settings.effort, executionMode: settings.executionMode,
          permission: describeWorkerSettings(settings), sandbox: settings.sandbox.type,
          approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
        }, activeTurnId: detail.turns.findLast(turn => turn.status === 'inProgress')?.id ?? null }
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
          if (source.origin) throw new HubError('codex-cli/router-stale', '请通过原微信待办选择目标')
          const pending = this.store.get('clarification', args.requestId + ':session')
          const choice = pending?.candidates.find(row => row.id === args.threadId && row.projectId === args.projectId)
          const selection = { kind: 'choice', id: pending?.id, threadId: args.threadId, projectId: args.projectId }
          const old = previousOperation(this.store, source.requestId, selection)
          if (old?.id) return old
          if (!pending?.semanticChoice || (!old && pending.status !== 'pending') || !choice || choice.grant || choice.pendingProject || choice.settingsReview ||
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
    if (intent.kind === 'dispatch' && intent.threadId && intent.mode === 'resume' && !intent.workerAction) {
      const names = separateProjectNames(source.text)
      if (names.length) {
        const projects = await this.projectRows()
        if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前 Router 回合已结束')
        const matches = names.map(name => projects.filter(p => p.name === name))
        if (matches.some(rows => rows.length !== 1) || !matches.some(([project]) => project.id === intent.projectId)) {
          throw new HubError('codex-cli/router-target', '请先核对各个项目的唯一名称和目标会话')
        }
        const key = createHash('sha256').update(JSON.stringify([source.requestId, intent.projectId])).digest('hex')
        intent = { ...intent, requestId: 'target-' + key, parentRequestId: source.requestId }
      }
    }
    const requestId = intent.parentRequestId ? intent.requestId : source.requestId
    const waiting = this.store.get('clarification', requestId + ':projectRoot')
    if (waiting) {
      if (waiting.status === 'pending') return { status: 'needs_confirmation', id: waiting.id, requires: '设置默认新项目父目录' }
      return waiting.result ?? { status: waiting.status, id: waiting.id }
    }
    if (intent.parentRequestId) {
      const cancelled = this.store.list('clarification').find(c => c.requestId === requestId && c.status === 'cancelled')
      if (cancelled) return {status:'cancelled',id:cancelled.id}
    }
    const permissionQuestion = this.store.get('clarification', requestId + ':workerPermission')
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
    const existing = previousOperation(this.store, requestId, intent)
    if (existing) return existing
    const pending = this.store.list('clarification').find(item => item.requestId === requestId &&
      item.status === 'pending' && item.expiresAt > Date.now())
    if (pending) {
      if (pending.intent && operationFingerprint(pending.intent) !== operationFingerprint(intent)) {
        throw new HubError('codex-cli/router-conflict', '当前请求已在等待另一项操作的确认，此目标尚未派发')
      }
      return { status: 'needs_confirmation', id: pending.id }
    }
    if (intent.workerAction) return this.prepareWorkerChange(source, intent)
    if (intent.kind === 'dispatch' && intent.mode !== 'new' && !intent.threadId) {
      // Older Router threads retain their original tool schema. They can nominate inspected sessions too.
      const ids = intent.candidateThreadIds ?? source.inspected ?? []
      if (ids.length < 2 || ids.length > 4) throw new HubError('codex-cli/router-target', '请选择 2 至 4 个真实候选会话')
      // A candidate tool call can omit settings the user explicitly requested.
      // Stage the restricted profile for human review; selecting a target alone cannot apply it.
      const directives = source.text.split(/[。！？；\n]/u).filter(clause =>
        !/不要|不用|无需|别用|不使用|不采用|不指定|不设为|不改为|不是|不希望|不得|禁止|能否|是否|[？?]/u.test(clause))
      const manualRead = directives.some(clause =>
        /(?:指定|设为|改为|采用|使用|以)\s*只读[、，,\s]*按需(?:由我|由用户|由本人|人工)?审批/u.test(clause))
      const planRequested = directives.some(clause => /(?:使用|采用|设为|改为|指定)\s*计划模式/u.test(clause))
      if (manualRead) intent.workerPermission = 'read'
      if (manualRead && planRequested) intent.executionMode = 'plan'
      const review = intent.workerPermission === 'read' ? '会话将设置为只读、按需由你审批' +
        (intent.executionMode === 'plan' ? '，使用计划模式' : '') : null
      const candidates = await Promise.all(ids.map(async id => {
        const { project, detail } = await this.resolveThread(id, undefined, true)
        const row = await this.workerCandidate(project, detail.thread, intent.workerPermission, detail.turns)
        if (!this.projects.has(project.id)) {
          row.pendingProject = project
          row.accessNotice = '续接还需要授权使用项目 ' + project.cwd + '。' + (row.accessNotice || '')
          row.summary = row.accessNotice + ' ' + row.summary
        }
        if (review) {
          row.settingsReview = review
          row.summary = [review, row.summary].filter(Boolean).join(' · ')
        }
        return row
      }))
      if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前回合已结束')
      return this.clarify(source, { kind: 'session', semanticChoice: true,
        label: intent.reason || '你想继续哪个任务？', intent, candidates })
    }

    if (intent.candidateProjectIds) {
      const rows = await this.projectRows()
      const candidates = intent.candidateProjectIds.map(id => {
        const row = rows.find(project => project.id === id)
        if (!row) throw new HubError('codex-cli/router-project', '候选项目已变更')
        return { id, projectId:id, name:row.name, ...(row.pendingProject && {
          pendingProject: row.pendingProject, summary:'需授权项目：' + row.pendingProject.cwd }) }
      })
      if (this.active !== source) throw new HubError('codex-cli/router-stale', '原回合已结束')
      return this.clarify(source, { kind:'project', label:'在哪个项目开始这项工作？', intent, candidates })
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
        name: project.name + '（' + project.cwd + '）' + (candidate ? ' · ' + candidate.name : ' · 新建会话') }],
    })
    if (candidate?.grant) return this.clarify(source, {
      kind: 'session', label: '允许 Router 按这个会话的现有权限续接？', intent, candidates: [candidate],
    })
    return this.execute(requestId, intent)
  }

  async prepareWorkerChange(source, intent) {
    const { project, detail } = await this.resolveThread(intent.threadId, intent.projectId)
    const issue = await this.psm.targetIssue(project, intent.threadId)
    if (issue) throw new HubError('codex-cli/router-thread', issue)
    const settings = workerSettingsStamp(await this.hub.routerWorkerProfile(intent.threadId))
    const invalid = workerIdentityIssue(project, settings)
    if (invalid) throw new HubError('codex-cli/router-worker-settings', invalid)
    if (!settings.model || !settings.effort) throw new HubError('codex-cli/router-worker-settings', '无法核实当前模型或思考强度')
    const restart = intent.workerAction === 'restart'
    const turn = detail.turns.at(-1)
    if (restart && (turn?.status !== 'inProgress' || turn.id !== intent.expectedTurnId)) {
      throw new HubError('codex-cli/router-stale', '目标回合已变化，请重新查询 Worker')
    }
    const worker = await this.workerOptions(intent, settings)
    if (this.active !== source) throw new HubError('codex-cli/router-stale', '当前 Router 回合已结束')
    const desired = worker.permission ? permissionPayload(worker.permission, true) : null
    const access = desired ? { sandbox: desired.sandboxPolicy, approvalPolicy: desired.approvalPolicy,
      approvalsReviewer: desired.approvalsReviewer } : settings
    const name = shortText(detail.thread.name, 48) || '未命名会话'
    return this.clarify(source, {
      kind: 'workerSettings', label: restart ? '确认修改设置并继续当前 Worker 任务？' : '确认修改 Worker 会话设置？',
      intent, worker, settings, projectIdentity: project.identity,
      candidates: [{ id: 'allow', projectId: project.id, threadId: intent.threadId, name: project.name + ' · ' + name,
        summary: '当前：' + settings.model + ' / ' + settings.effort + ' / ' + describeWorkerSettings(settings) +
          '。更改后：' + worker.model + ' / ' + worker.effort + ' / ' + describeWorkerSettings(access) +
          (restart ? '。会中断当前回合，在同一会话中继续原任务。' : '。等待空闲后应用设置。') }],
    })
  }

  async workerCandidate(project, thread, requestedPermission, turns = []) {
    const row = this.sessionRow(project, thread)
    const brief = (value, max) => {
      const line = value?.trim().split(/\r?\n/)[0]
      if (!line || /\/[^\s/]+\/|[A-Za-z]:\\|```|[a-f\d]{8}-[a-f\d]{4}-/i.test(line)) return ''
      return shortText(redact(line), max)
    }
    const topic = brief(this.psm.confirmedTopic(project, thread.id), 36)
    const title = brief(thread.name, 36)
    const last = this.dispatcher.list().find(task => task.threadId === thread.id && task.projectId === project.id &&
      task.status === 'completed' && task.summary)
    const latest = turns.findLast(turn => turn.status === 'completed')
    const recent = [finalAnswer(latest?.items)?.text, last?.summary]
      .filter(value => typeof value === 'string' && value.trim().length <= 48 && !/^你选了[「“]/u.test(value))
      .map(value => brief(value,48)).find(Boolean)
    row.name = topic || title || project.name + '会话'
    row.summary = (topic && title !== topic ? title : '') || recent ||
      (row.updatedAt ? '最近活动 ' + new Date(row.updatedAt).toISOString().slice(0, 10) : '')
    row.phoneTitle = row.name
    row.phoneSummary = row.summary
    const settings = await this.hub.routerWorkerSettings(thread.id)
    const invalid = workerIdentityIssue(project, settings)
    if (invalid) throw new HubError('codex-cli/router-worker-settings', invalid)
    if (requestedPermission) return row // The requested policy is checked against the selected project before enqueue.
    if (!workerDispatchIssue(project, settings, { existing: true, grant: this.store.get('worker-grant', thread.id) })) return row
    const grant = { identity: project.identity, settings }
    return { ...row, grant, accessNotice: '选择将授权沿用现有设置：' + describeWorkerSettings(settings) + '。后续相同设置可直接续接。', summary: [row.summary, '选择即授权此会话沿用现有设置（' +
      describeWorkerSettings(settings) + '）。后续相同设置可直接续接。'].filter(Boolean).join(' · ') }
  }

  clarify(source, value) {
    const memory = value.kind === 'psmMemory' || value.kind === 'psmAccess'
    const parentRequestId = value.intent?.parentRequestId
    const requestId = parentRequestId ? value.intent.requestId : source.requestId
    const id = requestId + ':' + value.kind + (memory ? ':' + value.candidates[0].id : '')
    if (!memory && this.store.get('operation', requestId)) return { status: 'alreadyHandled' }
    const existing = this.store.get('clarification', id)
    if (existing?.status === 'pending' && existing.expiresAt > Date.now()) {
      if (existing.intent && value.intent && operationFingerprint(existing.intent) !== operationFingerprint(value.intent)) {
        throw new HubError('codex-cli/router-conflict', '此确认属于另一项操作')
      }
      return { status: 'needs_confirmation', id }
    }
    const row = {
      ...value, routerThreadId: this.session.id, id, requestId, ...(parentRequestId && { parentRequestId }), original: source.text,
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
    if (!cancel && candidate.settingsReview && !explicit) throw new HubError('codex-cli/router-stale', '会话设置需要用户明确确认')
    const next = this.store.put('clarification', id, {
      ...row, status: cancel ? 'cancelled' : 'confirming', candidateId, explicit,
    })
    this.publish()
    if (cancel) return { status: 'cancelled' }
    return this.completeConfirmation(next)
  }

  resumeAfterRead(requestId) {
    if (this.phase !== 'ready') return
    const original = this.store.get('message', 'user:' + requestId)
    if (original?.status !== 'completed' || !original.origin || !this.wechat?.owns(original.origin.generation) ||
        original.routerThreadId !== this.session.id) return
    const group = this.store.list('clarification').filter(c => c.requestId === requestId)
    const grants = group.filter(c => c.resumeAfterRead)
    if (!grants.length || group.some(c => c.status === 'pending' || c.status === 'confirming')) return
    this.store.transaction(() => {
      for (const grant of grants) this.store.put('clarification', grant.id, { ...grant, resumeAfterRead:false })
      if (group.some(c => c.kind !== 'psmAccess' || c.status !== 'confirmed') ||
          this.store.get('operation', requestId)) return
      const next = 'access-' + createHash('sha256').update(requestId).digest('hex')
      this.admit({ requestId:next, text:original.text }, { ...original.origin, continuedFrom:requestId })
    })
    this.kickInputs()
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
        this.store.put('clarification', row.id, { ...row, status: 'confirmed', result,
          ...(row.kind === 'psmAccess' && this.store.get('message', 'user:' + row.requestId)?.origin && { resumeAfterRead:true }) })
        if (row.kind === 'projectRoot' && result.status !== 'needs_confirmation') this.store.put('message', 'root-result:' + row.id, {
          id: 'root-result:' + row.id, role: 'assistant', status: 'completed',
          text: result.cwd ? ('项目目录：' + result.cwd + (row.intent.kind === 'create' ? '，已创建会话。' : '，任务已排队。')) : '项目操作结果待核对，请查看任务。',
        })
      })
      this.publish()
      if (row.kind === 'psmAccess') this.resumeAfterRead(row.requestId)
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
    if (row.kind === 'workerSettings') {
      const { project, detail } = await this.resolveThread(row.intent.threadId, row.intent.projectId)
      if (row.projectIdentity !== project.identity) throw new HubError('codex-cli/router-stale', '项目身份已变化')
      const task = previousOperation(this.store, row.requestId, row.intent)
      if (task) return task
      const current = workerSettingsStamp(await this.hub.routerWorkerProfile(row.intent.threadId))
      const turn = detail.turns.at(-1)
      if (!isDeepStrictEqual(row.settings, current) ||
          (row.intent.workerAction === 'restart' && (turn?.id !== row.intent.expectedTurnId || turn.status !== 'inProgress'))) {
        throw new HubError('codex-cli/router-stale', 'Worker 的设置或回合已变化，请重新确认')
      }
      return this.execute(row.requestId, row.intent, row.worker, row.settings)
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
    if (candidate.pendingProject && (row.kind === 'project' || row.kind === 'session')) {
      if (!row.explicit) throw new HubError('codex-cli/router-stale', '项目授权需要用户明确确认')
      if (row.kind === 'session' && !this.readableProjects().has(candidate.projectId)) {
        throw new HubError('codex-cli/router-stale', '读取项目历史的授权已变化')
      }
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
    return this.execute(row.requestId, { ...row.intent, projectId: project.id, threadId: candidate.id,
      ...(row.semanticChoice && { sessionSelected: true }) })
  }

  async execute(requestId, intent, approvedWorker, approvedSettings) {
    this.requireReady()
    const old = previousOperation(this.store, requestId, intent)
    if (old) return old
    const project = this.projects.get(intent.projectId)
    const worker = intent.kind === 'interrupt' ? null : approvedWorker ?? await this.workerOptions(intent)
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
    if (intent.kind === 'dispatch') {
      const psmProjectUid=this.psm?.preference.enabled ? this.psm.identity(project) : null
      const task = this.dispatcher.enqueue({ ...intent, requestId, worker, psmProjectUid, approvedSettings }, value => {
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
        const thread = await this.dispatcher.createWorker(project, intent.title, worker?.permission)
        result = this.task(this.dispatcher.recordCreation({ requestId, threadId: thread.id, projectId: intent.projectId }))
      }
    } catch (error) {
      result = error.code === 'codex-cli/router-worker-settings'
        ? { status: 'failed', message: error.message }
        : { status: 'unknown', message: '操作结果待核对' }
    }
    this.store.transaction(() => this.saveOperation(requestId, intent, result))
    this.publish()
    return result
  }

  async workerOptions(intent, current) {
    const config = this.hub.config
    const model = intent.workerModel ?? current?.model ?? config.defaultModel
    let effort = intent.workerEffort ?? current?.effort ?? config.defaultEffort
    if (intent.workerModel || intent.workerEffort) {
      const catalog = await this.hub.models()
      const entry = catalog.find(row => row.id === model)
      if (!entry) throw new HubError('codex-cli/router-worker-model','可用的 Worker 模型：' + catalog.map(row=>row.id).join('、'))
      if (!entry.supportedReasoningEfforts.some(level => level.reasoningEffort === effort)) {
        if (intent.workerEffort) throw new HubError('codex-cli/router-worker-model',model + ' 支持的思考强度：' + entry.supportedReasoningEfforts.map(level=>level.reasoningEffort).join('、'))
        effort = entry.defaultReasoningEffort
      }
    }
    const createsWorker = intent.kind === 'create' || intent.mode === 'new'
    const permission = intent.workerPermission ?? (createsWorker ? config.defaultPermission : null)
    return {model, effort, executionMode:intent.executionMode ?? current?.executionMode ?? config.defaultExecutionMode,
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
