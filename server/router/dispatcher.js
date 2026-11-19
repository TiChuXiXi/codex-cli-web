import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { HubError } from '../codex/hub.js'
import { checkProject, checkThread, shortText, workerDispatchIssue, workerIdentityIssue, workerPermissionMatches, workerSettingsStamp } from './projects.js'

const continuationPrompt = '请继续本会话刚才中断的原任务。先查看已有对话和当前工作区，核对已完成的步骤与未提交的改动，从未完成处继续。保留已有改动，避免重复执行。需要用户确认、审批或补充信息时，使用本会话的原生交互，完成后汇报结果。'
const turnTerminal = new Set(['completed', 'failed', 'interrupted'])
const terminal = new Set(['created', ...turnTerminal])
const waiting = new Set(['awaiting_approval', 'awaiting_input'])

export function finalAnswer(items = []) {
  const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim())
  return messages.findLast(item => item.phase === 'final_answer') ?? messages.findLast(item => !item.phase)
}

function restartedTurnMatches(task, detail) {
  const latest = detail.turns.at(-1)
  return Boolean(task.restartRequestedAt && latest?.id === task.expectedTurnId && latest.status === 'interrupted')
}

function workerChangeMatches(project, task, settings) {
  if (workerIdentityIssue(project, settings)) return false
  const { worker, approvedSettings } = task
  if (settings.model !== worker.model || settings.effort !== worker.effort || settings.executionMode !== worker.executionMode) return false
  return worker.permission ? workerPermissionMatches(project, settings, worker.permission) :
    settings.approvalPolicy === approvedSettings.approvalPolicy &&
    settings.approvalsReviewer === approvedSettings.approvalsReviewer &&
    isDeepStrictEqual(approvedSettings.sandbox, settings.sandbox)
}

function waitStatus(requests, flags = []) {
  if (flags.includes('waitingOnUserInput') || requests.some(request => request.method === 'item/tool/requestUserInput')) {
    return 'awaiting_input'
  }
  return flags.includes('waitingOnApproval') || requests.length ? 'awaiting_approval' : 'running'
}
const verifiedWorkerVersions = new Set(['0.169.1', '0.170.0'])
const workerVisibilityGraceMs = 30000
const taskEvents = {
  queued: 'task.queued', running: 'task.started', completed: 'task.completed',
  created: 'session.created', failed: 'task.failed', interrupted: 'task.interrupted', awaiting_approval: 'task.awaiting_approval',
  awaiting_input: 'task.awaiting_input',
}

export class RouterDispatcher {
  constructor({ hub, followups, bus, store, project, routerThreadId, isReady, onReceipt, onTerminal, targetIssue }) {
    Object.assign(this, { hub, followups, bus, store, project, routerThreadId, isReady, onReceipt, onTerminal, targetIssue })
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
    const fingerprint = JSON.stringify([intent.projectId, intent.threadId ?? null, intent.instruction, intent.mode,
      ...(intent.worker ? [intent.worker] : []),
      ...(intent.workerAction ? [intent.workerAction, intent.expectedTurnId ?? null] : [])])
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HubError('codex-cli/router-conflict', '请求 ID 已用于另一项任务')
      return this.get(existing.id)
    }
    const id = randomUUID()
    const now = Date.now()
    const task = {
      id, requestId: intent.requestId, ...(intent.psmProjectUid && {psmProjectUid:intent.psmProjectUid}), routerThreadId: this.routerThreadId(),
      sourceRouterTurnId: intent.sourceRouterTurnId ?? null,
      projectId: intent.projectId, threadId: intent.threadId ?? null, turnId: null,
      instruction: intent.instruction, mode: intent.mode, status: 'queued', createdAt: now, updatedAt: now,
      ...(intent.worker ? {worker:intent.worker} : {}),
      ...(intent.workerAction && { workerAction: intent.workerAction, expectedTurnId: intent.expectedTurnId, approvedSettings: intent.approvedSettings }),
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

  update(id, patch, workerTerminal = false) {
    const current = this.get(id)
    if (terminal.has(current.status)) return current
    if (Object.entries(patch).every(([key, value]) => current[key] === value)) return current
    const next = { ...current, ...patch, updatedAt: Date.now() }
    const eligible = workerTerminal && next.routerThreadId === this.routerThreadId() &&
      next.routerThreadId && next.threadId && next.threadId !== next.routerThreadId && next.turnId
    let receiptAdded = false
    const event = this.store.transaction(() => {
      if (eligible) {
        receiptAdded = this.store.addWorkerReceipt(next)
        if (!receiptAdded) {
          next.receiptConflict = true
          this.store.event({
            type: 'task.receipt_conflict', id, threadId: next.threadId, turnId: next.turnId, at: next.updatedAt,
          })
        }
      }
      if (receiptAdded || (!workerTerminal && next.status === 'failed' && next.routerThreadId === this.routerThreadId())) {
        this.onTerminal?.(next, receiptAdded)
        const messageId = 'worker-result:' + id
        const outcome = { completed: 'Worker 回合已结束，未返回最终文本。', interrupted: 'Worker 回合已中断。', failed: next.error || 'Worker 回合失败。' }
        const text = next.status === 'completed' && next.finalReply ? next.finalReply :
          [outcome[next.status], next.finalReply].filter(Boolean).join('\n\n')
        this.store.put('message', messageId, { id: messageId, role: 'assistant', status: 'completed', routerThreadId:next.routerThreadId,
          label: (receiptAdded ? 'Worker · ' : 'Router · ') + this.workerLabel(next), text })
        if (receiptAdded && next.status === 'completed' && !next.finalReply && !patch.historyRead) next.needsFinalReply = true
        delete next.finalReply
      }
      delete next.historyRead
      this.store.put('task', id, next)
      return this.recordEvent(next)
    })
    this.publish(event)
    if (receiptAdded) this.onReceipt?.()
    return next
  }

  async createWorker(project, title, permission) {
    await checkProject(project)
    const thread = await this.hub.newThread({
      cwd: project.cwd, sandbox: project.sandbox, approvalPolicy: 'on-request',
    }, { routerWorker: true, workerPermission: permission })
    await checkThread(project, thread, this.routerThreadId())
    if (permission && !workerPermissionMatches(project, await this.hub.routerWorkerSettings(thread.id), permission)) {
      throw new HubError('codex-cli/router-worker-settings', 'Worker 未应用指定权限')
    }
    if (title) await this.hub.renameThread({ threadId: thread.id, name: title }).catch(() => {})
    return thread
  }

  async inspect(task, reconcile = false) {
    const project = await checkProject(this.project(task.projectId))
    const detail = await this.hub.routerReadWorker(task.threadId, reconcile
      ? { turnId: task.turnId, clientId: task.id, since: task.createdAt }
      : undefined)
    await checkThread(project, detail.thread, this.routerThreadId())
    if (detail.thread.id !== task.threadId) throw new HubError('codex-cli/router-thread', 'Worker 会话身份不匹配')
    return { project, detail }
  }

  async result(id) {
    const task = this.get(id)
    const { detail } = await this.inspect(task, true)
    const turn = detail.turns.find(entry => entry.id === task.turnId)
    if (!turn || !turnTerminal.has(turn.status)) {
      return { resultAvailability: 'temporarily_unavailable', observedSummary: task.summary ?? null }
    }
    const answer = finalAnswer(turn.items)?.text
    return {
      resultAvailability: answer ? 'available' : 'no_final_answer',
      finalReply: answer?.slice(0, 8000) ?? null,
      truncated: (answer?.length ?? 0) > 8000,
      errorCode: shortText(turn.error?.codexErrorInfo, 100) || null,
    }
  }

  pendingFor(threadId, turnId) {
    return this.hub.pendingApprovals().filter(entry =>
      entry.params?.turnId === turnId && (!entry.params.threadId || entry.params.threadId === threadId))
  }

  interactions() {
    const requests = this.hub.pendingApprovals()
    if (!requests.length) return []
    const tasks = this.list(-1).filter(task => task.routerThreadId === this.routerThreadId() &&
      task.turnId && this.project(task.projectId) && !terminal.has(task.status))
    return requests.flatMap(request => {
      const origin = request.params?.threadId
      if (!origin || !request.params.turnId) return []
      const owners = tasks.filter(task => (task.threadId === origin && task.turnId === request.params.turnId) ||
        task.children?.some(child => child.id === origin))
      if (owners.length !== 1) return []
      const [task] = owners
      const child = task.children?.find(item => item.id === origin)
      const worker = [this.workerLabel(task), child?.name].filter(Boolean).join(' · ')
      return [{ ...request, dispatchId: task.id, worker, instruction: shortText(task.instruction, 160) }]
    })
  }

  workerLabel(task) {
    return [this.project(task.projectId)?.name ?? task.projectId, task.threadName || task.threadId?.slice(-8)].filter(Boolean).join(' · ')
  }

  respond({ dispatchId, instanceId, response } = {}) {
    const request = this.interactions().find(item => item.dispatchId === dispatchId && item.instanceId === instanceId)
    if (!request || !instanceId) throw new HubError('codex-cli/router-stale', '此 Worker 请求已处理或已失效')
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new HubError('codex-cli/bad-request', '缺少 Worker 请求的响应')
    }
    return this.hub.respondApproval(request.requestId, response, instanceId)
  }

  recordQuestions(task, turnId, items) {
    for (const item of items.slice(items.findLastIndex(item => item.type === 'userMessage') + 1)) {
      if (item.type !== 'agentMessage' || !item.id || !item.questions?.length) continue
      const id = 'worker-question:' + task.id + ':' + item.id
      if (this.store.get('message', id)) continue
      this.store.put('message', id, { id, dispatchId: task.id, threadId: task.threadId, turnId, itemId: item.id,
        label: 'Worker · ' + this.workerLabel(task), role: 'assistant', text: item.text || '请回答 Worker 的问题',
        questions: item.questions, status: 'pending' })
      this.publish({ id: task.id })
    }
  }

  async currentQuestion(id) {
    const question = typeof id === 'string' && this.store.get('message', id)
    const stale = () => new HubError('codex-cli/router-stale', '此 Worker 问题已处理或已失效')
    if (!question?.questions || question.status !== 'pending') throw stale()
    const task = this.get(question.dispatchId)
    if (task.routerThreadId !== this.routerThreadId() || task.turnId !== question.turnId) throw stale()
    const { detail } = await this.inspect(task, true)
    const turn = detail.turns.at(-1)
    if (this.closed || this.store.get('message', id)?.status !== 'pending') throw stale()
    const items = turn?.items ?? []
    if (turn?.id !== question.turnId || !['completed', 'inProgress'].includes(turn.status) ||
        !items.slice(items.findLastIndex(item => item.type === 'userMessage') + 1).some(item => item.id === question.itemId && item.questions?.length)) {
      this.store.put('message', id, { ...question, status: 'closed' })
      this.publish({ id: task.id })
      throw stale()
    }
    return { question, task, turn }
  }

  async answerQuestion({ id, text } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new HubError('codex-cli/bad-request', '回答为空或过长')
    const { question, task, turn } = await this.currentQuestion(id)
    if (this.closed || this.store.get('message', id)?.status !== 'pending') throw new HubError('codex-cli/router-stale', '问题已失效')
    const save = status => this.store.put('message', id, { ...question, status })
    if (turn.status === 'inProgress') {
      // Persist before steering. A lost native acknowledgement must not send the same answer twice.
      save('unknown')
      try {
        await this.hub.steerTurn({ threadId: task.threadId, turnId: question.turnId, text })
        save('answered')
      } finally { this.publish({ id: task.id }) }
    } else {
      this.enqueue({ projectId: task.projectId, threadId: task.threadId, requestId: id, instruction: text, mode: 'resume' },
        () => save('answered'))
    }
    return { id, answered: true }
  }

  async retain(threadId) {
    if (this.retained.has(threadId)) return this.hub.ensureThreadSubscription?.(threadId)
    await this.hub.openThread(threadId, { routerWorker: true })
    if (this.closed) {
      await this.hub.closeThread(threadId, { routerWorker: true })
      return
    }
    this.retained.add(threadId)
  }

  async requestRestart(task, tasks) {
    if (!this.isReady() || this.hub.status().phase !== 'ready' || !verifiedWorkerVersions.has(this.hub.status().codexVersion)) return
    const { project, detail } = await this.inspect(task)
    const turn = detail.turns.at(-1)
    const fail = error => this.update(task.id, { status: 'failed', error })
    if (turn?.id !== task.expectedTurnId) return fail('原 Worker 回合已经变化，未中断或续执行其他回合')
    if (turn.status !== 'inProgress') return
    const competing = tasks.some(other => other.id !== task.id && other.threadId === task.threadId &&
      other.createdAt <= task.createdAt && !terminal.has(other.status) && other.turnId !== task.expectedTurnId)
    if (competing || this.followups?.list(task.threadId).entries.length || await this.hub.routerQueueHead(task.threadId)) {
      return fail('Worker 还有其他待执行消息，未中断当前回合')
    }
    const invalid = await this.targetIssue?.(project, task.threadId)
    if (invalid) return fail(invalid)
    const settings = workerSettingsStamp(await this.hub.routerWorkerProfile(task.threadId))
    if (!isDeepStrictEqual(settings, task.approvedSettings)) return fail('Worker 设置已变化，请重新确认')
    if (this.closed || !this.isReady() || Date.now() - (task.restartRequestedAt ?? 0) < 20000) return
    if ((task.restartAttempts ?? 0) >= 2) return fail('无法确认原 Worker 回合已停止，未发送续执行消息')
    await this.retain(task.threadId)
    if (this.closed || !this.isReady()) return
    this.update(task.id, { restartRequestedAt: Date.now(), restartAttempts: (task.restartAttempts ?? 0) + 1, error: null })
    try {
      await this.hub.interruptTurn({ threadId: task.threadId, turnId: task.expectedTurnId })
    } catch {
      this.update(task.id, { error: '正在核对原 Worker 回合的中断结果' })
    }
    this.schedule()
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
        const thread = await this.createWorker(this.project(task.projectId), undefined, task.worker?.permission)
        threadId = thread.id
        task = this.update(task.id, { threadId, status: 'queued' })
        this.store.put('binding', 'last', { projectId: task.projectId, threadId, at: Date.now() })
      }
      if (!this.isReady() || this.closed) return
      const { project, detail } = await this.inspect(task)
      if (detail.thread.status?.type === 'active' || detail.turns.some(turn => turn.status === 'inProgress') ||
          this.followups?.list(threadId).entries.length) {
        if (task.workerAction === 'settings') await this.retain(threadId)
        return
      }
      if (task.workerAction === 'restart' && !restartedTurnMatches(task, detail)) {
        this.update(task.id, { status: 'failed', error: '原回合未按本次请求中断，未发送续执行消息' })
        return
      }
      const invalid=await this.targetIssue?.(project,threadId)
      if(invalid) { this.update(task.id,{status:'failed',error:invalid});return }
      await this.retain(threadId)
      if (task.worker && await this.hub.routerQueueHead(threadId)) return
      const issue = await this.prepareWorker(task, project)
      if (issue) {
        this.update(task.id, { status: 'failed', error: issue })
        return
      }
      await checkProject(project)
      if (!this.isReady() || this.closed) return
      if (task.workerAction === 'settings') {
        this.update(task.id, { status: 'completed', error: null, summary: 'Worker 会话设置已更新' })
        return
      }
      if (task.workerAction === 'restart') {
        const current = (await this.inspect(task)).detail
        if (!restartedTurnMatches(task, current) || current.thread.status?.type === 'active' ||
            this.followups?.list(threadId).entries.length || await this.hub.routerQueueHead(threadId)) {
          this.update(task.id, { status: 'failed', error: '设置已更新。会话状态发生变化，未发送续执行消息' })
          return
        }
      }
      this.update(task.id, { status: 'submitting', error: null, threadName: shortText(detail.thread.name, 120) })
      const text = task.mode === 'new'
        ? '你就是用户指定的 Worker。原文中的新建、选择会话和派发步骤已由 Router 完成。请在当前会话亲自执行业务任务，向用户提问和申请审批均使用当前会话的原生工具。\n\n用户原文：\n' + task.instruction
        : task.workerAction === 'restart' ? continuationPrompt : task.instruction
      const queued = await this.hub.routerAddWorkerMessage(threadId, task.id, text)
      if (!queued?.id || queued.clientUserMessageId !== task.id) throw new Error('缺少原生队列确认')
      const current = this.get(task.id)
      this.update(task.id, {
        queueId: queued.id,
        ...(current.status === 'submitting' ? { status: 'submitted' } : {}),
      })
    } catch (error) {
      const current = this.get(task.id)
      if (error.code === 'codex-cli/router-worker-settings') {
        this.update(task.id, { status: 'failed', error: error.message })
      } else if (current.status === 'creating' || current.status === 'submitting') {
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
    if (this.hub.status().phase !== 'ready') return
    const { project, detail } = await this.inspect(task, true)
    const hits = detail.turns.filter(turn => turn.id === task.turnId ||
      turn.items?.some(item => item.type === 'userMessage' && item.clientId === task.id))
    if (hits.length > 1) {
      this.update(task.id, { status: 'unknown', error: '多个 Worker 回合与派发记录冲突，需核对' })
      return
    }
    if (hits.length === 1) {
      const turn = hits[0]
      if (turn.status === 'inProgress') {
        await this.retain(task.threadId)
        const children = spawnedWorkers(turn.items, task.threadId)
        if (JSON.stringify(children) !== JSON.stringify(task.children ?? [])) this.update(task.id, { children })
        for (const child of children) await this.retain(child.id).catch(() => {})
        const status = waitStatus(this.pendingFor(task.threadId, turn.id).concat(
          this.hub.pendingApprovals().filter(request => children.some(child => child.id === request.params?.threadId))
        ), detail.thread.status?.activeFlags)
        this.applyTurn(task, turn, status)
      } else this.applyTurn(task, turn)
      return
    }
    const queued = await this.hub.routerFindWorkerMessage(task.threadId, task.id)
    const current = this.get(task.id)
    if (terminal.has(current.status) || current.turnId !== task.turnId || current.status !== task.status) return
    if (queued) {
      this.update(task.id, { status: 'submitted', queueId: queued.id,
        ...(current.status === 'submitted' ? {} : { error: null }) })
      await this.retain(task.threadId)
      if (detail.thread.status?.type === 'active' || detail.turns.some(turn => turn.status === 'inProgress') ||
          this.followups?.list(task.threadId).entries.length || !this.isReady() || this.closed) return
      if (task.worker && (await this.hub.routerQueueHead(task.threadId))?.id !== queued.id) return
      if (task.workerAction === 'restart' && !restartedTurnMatches(task, detail)) {
        this.update(task.id, { error: '续执行消息仍在原生队列，原回合状态已变化，请检查队列' })
        return
      }
      const issue = await this.prepareWorker(task, project)
      if (issue) {
        this.update(task.id, { error: issue })
        return
      }
      if (this.isReady() && !this.closed) {
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

  settingsIssue(task, project, settings) {
    return workerDispatchIssue(project, settings, {
      existing: ['resume', 'enqueue'].includes(task.mode), grant: this.store.get('worker-grant', task.threadId),
    })
  }

  async prepareWorker(task, project) {
    if (task.workerAction) {
      const current = workerSettingsStamp(await this.hub.routerWorkerProfile(task.threadId))
      if (workerChangeMatches(project, task, current)) return null
      if (!isDeepStrictEqual(task.approvedSettings, current)) return 'Worker 设置已变化，请重新确认'
      try {
        await this.hub.configureWorker(task.threadId, task.worker, { verify: true })
        const effective = workerSettingsStamp(await this.hub.routerWorkerProfile(task.threadId))
        return workerChangeMatches(project, task, effective) ? null : 'Codex 未确认所请求的 Worker 设置'
      } catch (error) { return '无法应用 Worker 执行设置：' + error.message }
    }
    const current = await this.hub.routerWorkerSettings(task.threadId)
    const permission = task.worker?.permission
    const issue = permission ? workerIdentityIssue(project, current) : this.settingsIssue(task, project, current)
    if (issue || !task.worker) return issue
    try {
      const changePermission = permission && (task.mode !== 'new' || !workerPermissionMatches(project, current, permission))
      await this.hub.configureWorker(task.threadId, changePermission ? task.worker : {
        model: task.worker.model, effort: task.worker.effort, executionMode: task.worker.executionMode,
      })
      if (permission && !workerPermissionMatches(project, await this.hub.routerWorkerSettings(task.threadId), permission)) {
        return 'Worker 未应用指定权限'
      }
      return null
    } catch (error) { return '无法应用 Worker 执行设置：' + error.message }
  }

  applyTurn(task, turn, runningStatus) {
    const current = this.get(task.id)
    if (!turn.id || (current.turnId && current.turnId !== turn.id)) return
    const ended = turnTerminal.has(turn.status)
    const status = ended ? turn.status : turn.status === 'inProgress'
      ? runningStatus ?? (waiting.has(current.status) ? current.status : 'running')
      : null
    if (!status) return
    if (Array.isArray(turn.items)) this.recordQuestions(task, turn.id, turn.items)
    const summary = finalAnswer(turn.items)?.text
    this.update(task.id, {
      turnId: turn.id, status,
      ...(summary ? workerReply(summary) : {}),
      ...(ended ? { executionStatus: turn.status, historyRead: Array.isArray(turn.items) } : {}),
      error: status === 'failed' ? shortText(turn.error?.message, 1200) || 'Worker 回合失败' : null,
    }, ended)
  }

  onEvent(event) {
    if (this.closed || !['turn/started', 'turn/completed', 'item/upsert', 'approval/requested',
      'approval/resolved', 'followups/changed', 'connection', 'thread/status', 'thread/archived', 'thread/deleted'].includes(event.type)) return
    if (event.threadId) {
      if (event.type === 'item/upsert' && event.payload?.item?.type === 'userMessage') {
        for (const message of this.store.list('message', 80)) {
          if (message.questions && message.threadId === event.threadId && message.dispatchId !== event.payload.item.clientId &&
              ['unknown', 'pending'].includes(message.status)) {
            this.store.put('message', message.id, { ...message, status: 'closed' })
            this.publish({ id: message.dispatchId })
          }
        }
      }
      for (const task of this.list(-1)) {
        if (task.threadId !== event.threadId || terminal.has(task.status)) continue
        const item = event.payload?.item
        if (['thread/archived', 'thread/deleted'].includes(event.type) && task.status === 'queued') {
          this.update(task.id, { status: 'failed', error: 'Worker 会话已归档或删除' })
        } else if (event.type === 'item/upsert' && item?.type === 'userMessage' && item.clientId === task.id &&
                   event.turnId && !task.turnId && !['queued', 'creating'].includes(task.status)) {
          const status = waitStatus(this.pendingFor(task.threadId, event.turnId))
          this.update(task.id, { turnId: event.turnId, status })
          this.schedule()
        } else if (task.turnId && task.turnId === event.turnId) {
          if (event.type === 'item/upsert' && item) {
            if (event.payload.completed && item.questions?.length) this.recordQuestions(task, task.turnId, [item])
            if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') {
              const children = spawnedWorkers([item], task.threadId, task.children)
              if (JSON.stringify(children) !== JSON.stringify(task.children ?? [])) this.update(task.id, { children })
            }
          }
          if (event.type === 'item/upsert' && event.payload.completed && item?.type === 'agentMessage' &&
              (!item.phase || item.phase === 'final_answer')) {
            if (item.text?.trim()) this.update(task.id, workerReply(item.text))
          }
          if (event.type === 'turn/completed' && event.payload?.turn?.id === task.turnId) this.applyTurn(task, event.payload.turn)
          if (event.type === 'approval/requested') {
            const status = event.payload?.method === 'item/tool/requestUserInput' ? 'awaiting_input' : 'awaiting_approval'
            this.update(task.id, { status })
          }
          if (event.type === 'approval/resolved' && waiting.has(task.status)) {
            this.update(task.id, { status: waitStatus(this.pendingFor(task.threadId, task.turnId)) })
          }
        }
      }
    }
    if (event.type !== 'item/upsert') this.schedule()
  }

  schedule() {
    if (this.closed || this.scheduled) return
    if (this.sweeping) {
      this.rescan = true
      return
    }
    this.scheduled = setTimeout(() => {
      this.scheduled = null
      if (this.closed) return
      this.sweep().catch(() => {})
    }, 40)
    this.scheduled.unref()
  }

  sweep() {
    if (this.closed) return Promise.resolve()
    if (this.sweeping) return this.sweeping.then(() => this.sweep())
    this.sweeping = this.sweepTasks().finally(() => {
      this.sweeping = null
      if (this.rescan) {
        this.rescan = false
        this.schedule()
      }
    })
    return this.sweeping
  }

  async sweepTasks() {
    const blocked = new Set()
    const related = new Set()
    const tasks = this.list(-1).reverse()
    for (const task of tasks) {
      if (this.closed) return
      if (task.status === 'queued' && task.workerAction === 'restart') {
        try { await this.requestRestart(task, tasks) } catch (error) {
          if (['codex-cli/router-thread', 'codex-cli/router-project'].includes(error.code)) {
            this.update(task.id, { status: 'failed', error: error.message })
          }
        }
      }
    }
    for (const saved of tasks) {
      if (this.closed) break
      const task = saved.workerAction === 'restart' ? this.get(saved.id) : saved
      if (terminal.has(task.status)) {
        if (task.needsFinalReply && this.hub.status().phase === 'ready') {
          try { await this.recoverFinalReply(task) } catch { /* Retry from Worker history on the next sweep. */ }
        }
        continue
      }
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
      for (const child of this.get(task.id).children ?? []) related.add(child.id)
    }
    for (const threadId of this.retained) {
      if (related.has(threadId)) continue
      this.retained.delete(threadId)
      await this.hub.closeThread(threadId, { routerWorker: true }).catch(() => {})
    }
  }

  async recoverFinalReply(task) {
    const { detail } = await this.inspect(task, true)
    const turn = detail.turns.find(entry => entry.id === task.turnId && entry.status === 'completed')
    if (!turn || this.closed || !Array.isArray(turn.items)) return
    this.recordQuestions(task, turn.id, turn.items)
    const text = finalAnswer(turn.items)?.text
    const id = 'worker-result:' + task.id
    this.store.transaction(() => {
      if (text) {
        const reply = workerReply(text)
        this.store.put('message', id, { ...this.store.get('message', id), text: reply.finalReply })
        task.summary = reply.summary
      }
      delete task.needsFinalReply
      this.store.put('task', task.id, task)
    })
    if (text) this.publish({ id: task.id })
  }

  async interrupt(id, expectedTurnId) {
    const task = this.get(id)
    if (!task.turnId || task.turnId !== expectedTurnId || (task.status !== 'running' && !waiting.has(task.status))) {
      throw new HubError('codex-cli/router-task', '待中断回合已经变化')
    }
    const { detail } = await this.inspect(task, true)
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
    await Promise.allSettled([...this.retained].map(threadId => this.hub.closeThread(threadId, { routerWorker: true })))
  }
}

function workerReply(text) {
  return { summary: shortText(text, 600), finalReply: text.length > 24000 ? text.slice(0, 24000) + '\n\n（回复已截断）' : text }
}

function spawnedWorkers(items = [], parentId, previous = []) {
  const children = new Map(previous.map(child => [child.id, child.name]))
  for (const item of items) {
    if (item.type === 'subAgentActivity' && item.agentThreadId && item.agentThreadId !== parentId) {
      if (item.kind === 'started') children.set(item.agentThreadId, item.agentPath || item.agentThreadId)
      if (['completed', 'interrupted'].includes(item.kind)) children.delete(item.agentThreadId)
    }
    if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && item.senderThreadId === parentId) {
      for (const id of item.receiverThreadIds ?? []) if (id && id !== parentId) children.set(id, id)
    }
  }
  return Array.from(children, ([id, name]) => ({ id, name }))
}
