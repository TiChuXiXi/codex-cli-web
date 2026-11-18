import { randomUUID } from 'node:crypto'
import { HubError } from '../codex/hub.js'
import { canDispatch, checkProject, checkThread, shortText } from './projects.js'

const terminal = new Set(['created', 'completed', 'failed', 'interrupted'])
const verifiedWorkerVersions = new Set(['0.169.1', '0.170.0'])
const workerVisibilityGraceMs = 30000
const taskEvents = {
  queued: 'task.queued', running: 'task.started', completed: 'task.completed',
  created: 'session.created', failed: 'task.failed', interrupted: 'task.interrupted', awaiting_approval: 'task.awaiting_approval',
}

export class RouterDispatcher {
  constructor({ hub, followups, bus, store, project, routerThreadId, isReady }) {
    Object.assign(this, { hub, followups, bus, store, project, routerThreadId, isReady })
    this.off = bus.subscribe(event => this.onEvent(event))
    this.retained = new Set()
    this.timer = setInterval(() => this.schedule(), 12000)
    this.timer.unref()
  }

  get(id) {
    const task = this.store.get('task', id)
    if (!task) throw new HubError('codex-cli/router-task', '找不到此 Router 任务')
    return task
  }

  list(limit = 50) {
    return this.store.list('task', limit)
  }

  enqueue(intent, onCommit) {
    const existing = this.store.get('dispatch-key', intent.requestId)
    const fingerprint = JSON.stringify([intent.projectId, intent.threadId ?? null, intent.instruction, intent.mode])
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HubError('codex-cli/router-conflict', '请求 ID 已用于另一项任务')
      return this.get(existing.id)
    }
    const id = randomUUID()
    const now = Date.now()
    const task = {
      id, requestId: intent.requestId, routerThreadId: this.routerThreadId(),
      projectId: intent.projectId, threadId: intent.threadId ?? null, turnId: null,
      instruction: intent.instruction, mode: intent.mode, status: 'queued', createdAt: now, updatedAt: now,
    }
    const event = this.store.transaction(() => {
      this.store.put('dispatch-key', intent.requestId, { id, fingerprint })
      this.store.put('task', id, task)
      onCommit?.(task)
      return this.recordEvent(task)
    })
    this.publish(event)
    this.schedule()
    return task
  }

  recordCreation({ requestId, projectId, threadId }) {
    const id = randomUUID()
    const now = Date.now()
    const task = { id, requestId, projectId, threadId, turnId: null, status: 'created', createdAt: now, updatedAt: now }
    const event = this.store.transaction(() => {
      this.store.put('task', id, task)
      return this.recordEvent(task)
    })
    this.publish(event)
    return task
  }

  dismissUnknown(id, updatedAt) {
    const task = this.get(id)
    if (task.status !== 'unknown' || task.updatedAt !== updatedAt) {
      throw new HubError('codex-cli/router-stale', '任务状态已经变化，请重新核对')
    }
    const closed = this.update(id, { status: 'failed', error: '已由用户核对并关闭，未重发任务' })
    this.schedule()
    return closed
  }

  recordEvent(task) {
    return this.store.event({
      type: taskEvents[task.status] ?? 'task.updated', id: task.id,
      status: task.status, threadId: task.threadId, turnId: task.turnId, at: task.updatedAt,
    })
  }

  publish(event) {
    this.bus.publish('router/changed', event)
  }

  update(id, patch) {
    const current = this.get(id)
    if (terminal.has(current.status)) return current
    if (Object.entries(patch).every(([key, value]) => current[key] === value)) return current
    const next = { ...current, ...patch, updatedAt: Date.now() }
    const event = this.store.transaction(() => {
      this.store.put('task', id, next)
      return this.recordEvent(next)
    })
    this.publish(event)
    return next
  }

  async createWorker(project, title) {
    await checkProject(project)
    const thread = await this.hub.newThread({
      cwd: project.cwd, sandbox: project.sandbox, approvalPolicy: 'on-request',
    }, { routerWorker: true })
    await checkThread(project, thread, this.routerThreadId())
    if (title) await this.hub.renameThread({ threadId: thread.id, name: title }).catch(() => {})
    return thread
  }

  async inspect(task) {
    const project = await checkProject(this.project(task.projectId))
    const detail = await this.hub.routerReadWorker(task.threadId)
    await checkThread(project, detail.thread, this.routerThreadId())
    return { project, detail }
  }

  async retain(threadId) {
    if (this.retained.has(threadId)) return
    await this.hub.openThread(threadId)
    if (this.closed) {
      await this.hub.closeThread(threadId)
      return
    }
    this.retained.add(threadId)
  }

  async submit(task) {
    const worker = this.hub.status()
    if (worker.phase !== 'ready') return
    if (!verifiedWorkerVersions.has(worker.codexVersion)) {
      this.update(task.id, { error: 'Worker App Server 版本尚未通过 Router 队列验收' })
      return
    }
    try {
      let threadId = task.threadId
      if (!threadId) {
        this.update(task.id, { status: 'creating' })
        const thread = await this.createWorker(this.project(task.projectId))
        threadId = thread.id
        task = this.update(task.id, { threadId, status: 'queued' })
        this.store.put('binding', 'last', { projectId: task.projectId, threadId, at: Date.now() })
      }
      if (!this.isReady() || this.closed) return
      const { project, detail } = await this.inspect(task)
      if (detail.thread.status?.type === 'active' || detail.turns.some(turn => turn.status === 'inProgress') ||
          this.followups?.list(threadId).entries.length) return
      await this.retain(threadId)
      const effective = await this.hub.routerWorkerSettings(threadId)
      if (!canDispatch(project, effective)) {
        this.update(task.id, { status: 'failed', error: 'Worker 审批或沙箱权限超出已验证的项目范围' })
        return
      }
      await checkProject(project)
      if (!this.isReady() || this.closed) return
      this.update(task.id, { status: 'submitting', error: null })
      const queued = await this.hub.routerAddWorkerMessage(threadId, task.id, task.instruction)
      if (!queued?.id || queued.clientUserMessageId !== task.id) throw new Error('缺少原生队列确认')
      const current = this.get(task.id)
      this.update(task.id, {
        queueId: queued.id,
        ...(current.status === 'submitting' ? { status: 'submitted' } : {}),
      })
    } catch (error) {
      const current = this.get(task.id)
      if (current.status === 'creating' || current.status === 'submitting') {
        this.update(task.id, { status: 'unknown', error: '提交结果待核对，已暂停自动重试' })
      } else if (error.code === 'codex-cli/router-thread' || error.code === 'codex-cli/router-project') {
        this.update(task.id, { status: 'failed', error: error.message })
      }
    }
  }

  async reconcile(task) {
    if (!task.threadId) {
      if (task.status === 'creating') this.update(task.id, { status: 'unknown', error: '会话创建结果待核对' })
      return
    }
    const { project, detail } = await this.inspect(task)
    const hits = detail.turns.filter(turn => turn.id === task.turnId ||
      turn.items?.some(item => item.type === 'userMessage' && item.clientId === task.id))
    if (hits.length === 1) {
      const turn = hits[0]
      if (turn.status === 'inProgress') {
        await this.retain(task.threadId)
        if (task.status === 'awaiting_approval' || this.hub.pendingApprovals().some(entry => entry.params?.turnId === turn.id)) {
          this.update(task.id, { turnId: turn.id, status: 'awaiting_approval', error: null })
          return
        }
      }
      this.applyTurn(task, turn)
      return
    }
    const queued = await this.hub.routerFindWorkerMessage(task.threadId, task.id)
    const current = this.get(task.id)
    if (terminal.has(current.status) || current.turnId !== task.turnId || current.status !== task.status) return
    if (queued) {
      this.update(task.id, { status: 'submitted', queueId: queued.id, error: null })
      if (detail.thread.status?.type === 'active' || detail.turns.some(turn => turn.status === 'inProgress') ||
          this.followups?.list(task.threadId).entries.length || !this.isReady() || this.closed) return
      await this.retain(task.threadId)
      if (canDispatch(project, await this.hub.routerWorkerSettings(task.threadId)) && this.isReady() && !this.closed) {
        try {
          const turn = await this.hub.routerStartWorkerMessage(task.threadId, queued.id)
          if (turn?.id) this.applyTurn(this.get(task.id), turn)
        } catch {
          // 冲突或丢失回包后继续按相同队列 ID 和历史对账。
        }
      }
    } else if (task.status !== 'unknown' && Date.now() - current.updatedAt >= workerVisibilityGraceMs) {
      // Native queue ownership can transfer before the corresponding turn is readable.
      this.update(task.id, { status: 'unknown', error: '暂时无法从队列或历史确认任务状态' })
    }
  }

  applyTurn(task, turn) {
    const status = terminal.has(turn.status) ? turn.status :
      turn.status === 'inProgress' && task.status === 'awaiting_approval' ? 'awaiting_approval' :
      turn.status === 'inProgress' ? 'running' : null
    if (!status) return
    const summary = turn.items?.findLast(item => item.type === 'agentMessage')?.text
    this.update(task.id, {
      turnId: turn.id, status,
      ...(summary ? { summary: shortText(summary, 600) } : {}),
      error: status === 'failed' ? 'Worker 回合失败，请打开会话查看详情' : null,
    })
  }

  onEvent(event) {
    if (this.closed || !['turn/started', 'turn/completed', 'item/upsert', 'approval/requested',
      'approval/resolved', 'followups/changed', 'connection', 'thread/status', 'thread/archived', 'thread/deleted'].includes(event.type)) return
    if (event.threadId) {
      for (const task of this.list(-1)) {
        if (task.threadId !== event.threadId || terminal.has(task.status)) continue
        const item = event.payload?.item
        if (['thread/archived', 'thread/deleted'].includes(event.type) && task.status === 'queued') {
          this.update(task.id, { status: 'failed', error: 'Worker 会话已归档或删除' })
        } else if (event.type === 'item/upsert' && item?.type === 'userMessage' && item.clientId === task.id) {
          this.update(task.id, { turnId: event.turnId, status: 'running' })
        } else if (task.turnId && task.turnId === event.turnId) {
          if (event.type === 'item/upsert' && event.payload.completed && item?.type === 'agentMessage') {
            this.update(task.id, { summary: shortText(item.text, 600) })
          }
          if (event.type === 'turn/completed' && event.payload?.turn) this.applyTurn(task, event.payload.turn)
          if (event.type === 'approval/requested') this.update(task.id, { status: 'awaiting_approval' })
          if (event.type === 'approval/resolved' && task.status === 'awaiting_approval' &&
              !this.hub.pendingApprovals().some(entry => entry.params?.turnId === task.turnId)) {
            this.update(task.id, { status: 'running' })
          }
        }
      }
    }
    if (event.type !== 'item/upsert') this.schedule()
  }

  schedule() {
    if (this.closed || this.scheduled) return
    this.scheduled = setTimeout(() => {
      this.scheduled = null
      if (this.closed || this.sweeping) return
      this.sweeping = this.sweep().catch(() => {}).finally(() => { this.sweeping = null })
    }, 40)
    this.scheduled.unref()
  }

  async sweep() {
    const blocked = new Set()
    const related = new Set()
    for (const task of this.list(-1).reverse()) {
      if (this.closed) break
      if (terminal.has(task.status)) continue
      if (task.threadId) related.add(task.threadId)
      const key = task.threadId ?? task.projectId
      if (blocked.has(key)) continue
      blocked.add(key)
      if (task.status === 'queued') {
        if (this.isReady()) await this.submit(task)
        const latest = this.get(task.id)
        if (latest.threadId && !terminal.has(latest.status)) related.add(latest.threadId)
      } else {
        try { await this.reconcile(task) } catch {}
      }
    }
    for (const threadId of this.retained) {
      if (related.has(threadId)) continue
      this.retained.delete(threadId)
      await this.hub.closeThread(threadId).catch(() => {})
    }
  }

  async interrupt(id, expectedTurnId) {
    const task = this.get(id)
    if (!task.turnId || task.turnId !== expectedTurnId || !['running', 'awaiting_approval'].includes(task.status)) {
      throw new HubError('codex-cli/router-task', '待中断回合已经变化')
    }
    const { detail } = await this.inspect(task)
    if (!detail.turns.some(turn => turn.id === expectedTurnId && turn.status === 'inProgress')) {
      throw new HubError('codex-cli/router-task', '目标回合已结束或不再关联')
    }
    await this.hub.interruptTurn({ threadId: task.threadId, turnId: expectedTurnId })
    return this.get(id)
  }

  async close() {
    this.closed = true
    this.off()
    clearInterval(this.timer)
    clearTimeout(this.scheduled)
    await this.sweeping
    await Promise.allSettled([...this.retained].map(threadId => this.hub.closeThread(threadId)))
  }
}
