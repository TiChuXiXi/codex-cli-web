import { terminalFact, renderExpression } from '../../shared/router-expression.js'
import { defaultProfile } from '../../shared/router-presentation.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { HubError } from '../codex/hub.js'
import { baselineProtocol } from '../codex/worker-protocol.js'
import { checkProject, checkThread, shortText, workerDispatchIssue, workerIdentityIssue, workerPermissionMatches, workerSettingsStamp } from './projects.js'

const continuationPrompt = '请继续本会话刚才中断的原任务。先查看已有对话和当前工作区，核对已完成的步骤与未提交的改动，从未完成处继续。保留已有改动，避免重复执行。需要用户确认、审批或补充信息时，使用本会话的原生交互，完成后汇报结果。'
const turnTerminal = new Set(['completed', 'failed', 'interrupted'])
const terminal = new Set(['created', 'attached', 'cancelled', ...turnTerminal])
const waiting = new Set(['awaiting_approval', 'awaiting_input'])

export function finalAnswer(items = []) {
  const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim())
  return messages.findLast(item => item.phase === 'final_answer') ?? messages.findLast(item => !item.phase)
}

// Web and WeChat submit structured questions as "title\nanswer" blocks.
function publicQuestionChoices(questions, text) {
  const blocks = text.split('\n\n')
  return questions.flatMap(({ title, options, isSecret }, index) => {
    if (isSecret || !Array.isArray(options) || typeof title !== 'string') return []
    const prefix = title + '\n'
    const block = blocks.length === questions.length ? blocks[index] : null
    const selected = block?.startsWith(prefix) ? block.slice(prefix.length) : questions.length === 1 ? text : null
    if (!options.includes(selected) || typeof selected !== 'string') return []
    return [{ question: title.slice(0, 240), selected: selected.slice(0, 120) }]
  }).slice(0, 8)
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
const steerWaitMethods = new Map([['waitingOnApproval', 'item/commandExecution/requestApproval'],
  ['waitingOnUserInput', 'item/tool/requestUserInput']])
function methodMissing(error, method) {
  return error.code === -32601 || (error.code === -32600 &&
    error.message.startsWith('Invalid request: unknown variant `' + method + '`,'))
}

const workerVisibilityGraceMs = 30000
const taskEvents = {
  queued: 'task.queued', running: 'task.started', completed: 'task.completed',
  created: 'session.created', failed: 'task.failed', interrupted: 'task.interrupted', awaiting_approval: 'task.awaiting_approval',
  awaiting_input: 'task.awaiting_input',
}

export class RouterDispatcher {
  constructor({ expressionProfile = defaultProfile, hub, followups, bus, store, project, routerThreadId, isReady, onReceipt, onTerminal, onControlAlert, onStop, onThreadCreated, targetIssue }) {
    Object.assign(this, { expressionProfile, hub, followups, bus, store, project, routerThreadId, isReady, onReceipt, onTerminal, onControlAlert, onStop, onThreadCreated, targetIssue })
    this.off = bus.subscribe(event => this.onEvent(event))
    this.retained = new Set()
    this.lanes = new Map()
    this.stopping = new Map()
    this.timer = setInterval(() => this.schedule(), 12000)
    this.timer.unref()
  }

  protocol(worker) {
    return worker.workerProtocol ?? baselineProtocol(worker.codexVersion, worker.kind)
  }

  unavailable(worker) {
    return 'Worker ' + (worker.codexVersion ?? '未知版本') + ' 的原生队列未经验证。请运行隔离 Worker 协议检查并配置 workerProtocolReport，重连后重新提交。'
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
      id, requestId: intent.requestId, ...(intent.parentRequestId && {parentRequestId:intent.parentRequestId}),
      ...(intent.psmProjectUid && {psmProjectUid:intent.psmProjectUid}), routerThreadId: this.routerThreadId(),
      sourceRouterTurnId: intent.sourceRouterTurnId ?? null,
      projectId: intent.projectId, threadId: intent.threadId ?? null, turnId: null,
      instruction: intent.instruction, mode: intent.mode, status: 'queued', createdAt: now, updatedAt: now,
      ...(intent.worker ? {worker:intent.worker} : {}),
      ...(intent.workerAction && { workerAction: intent.workerAction, expectedTurnId: intent.expectedTurnId, approvedSettings: intent.approvedSettings }),
    }
    const event = this.store.transaction(() => {
      this.store.put('dispatch-key', intent.requestId, { id, fingerprint })
      const source = this.store.get('message', 'user:' + (intent.parentRequestId ?? intent.requestId))
      const origin = source?.origin ?? intent.origin
      this.store.patchCommand(id, {
        state: 'queued', queuedAt: now, admittedAt: source?.admittedAt ?? now,
        channel: origin ? 'wechat' : 'web', generation: origin?.generation,
        kind: intent.workerAction ?? intent.mode, allowSteer: intent.mode === 'resume' &&
          !intent.workerAction && !intent.workerPermission && !intent.workerModel && !intent.workerEffort && !intent.executionMode,
        questionTurnId: intent.questionTurnId,
      })
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
    const stop = this.store.get('stop', id)
    if (stop?.state === 'unknown' && !stop.reviewedAt && task.updatedAt === updatedAt) {
      return this.store.transaction(() => {
        this.store.put('stop', id, { ...stop, reviewedAt: Date.now(), message: '停止结果已经人工核对并关闭。' })
        // A queued native item may still exist. Never restart it on manual closure.
        const closed = ['submitted', 'submitting', 'unknown', 'creating'].includes(task.status)
          ? this.update(id, { status: 'failed', error: '已由用户核对并关闭' }, false,
            { state: this.store.command(id)?.state ?? 'unknown', closedAt: Date.now() })
          : task
        this.schedule()
        this.publish({ id })
        return closed
      })
    }
    if (task.status !== 'unknown' || task.updatedAt !== updatedAt) {
      throw new HubError('codex-cli/router-stale', '任务状态已经变化，请重新核对')
    }
    const closed = this.update(id, { status: 'failed', error: '已由用户核对并关闭，未重发任务' }, false, { state: 'unknown', closedAt: Date.now() })
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

  update(id, patch, workerTerminal = false, delivery) {
    const current = this.get(id)
    if (terminal.has(current.status)) return current
    if (!delivery && Object.entries(patch).every(([key, value]) => current[key] === value)) return current
    const next = { ...current, ...patch, updatedAt: Date.now() }
    const eligible = workerTerminal && next.routerThreadId === this.routerThreadId() &&
      next.routerThreadId && next.threadId && next.threadId !== next.routerThreadId && next.turnId
    let receiptAdded = false
    const event = this.store.transaction(() => {
      if (patch.status === 'submitting' && !current.workerAction) {
        const notes = this.store.list('correction').filter(note => note.threadId === current.threadId && !note.commandId)
        if (notes.length) next.corrections = [...(current.corrections ?? []),...notes.map(n=>n.id)]
        for (const note of notes) this.store.put('correction',note.id,{...note,commandId:id})
      }
      if (['failed','cancelled'].includes(patch.status) && current.status === 'queued') {
        for (const noteId of current.corrections ?? []) {
          const note = this.store.get('correction',noteId)
          if (note?.commandId === id) this.store.put('correction',noteId,{...note,commandId:null})
        }
      }
      if (delivery || patch.status === 'unknown' || patch.status === 'failed') {
        const facts = this.store.command(id)
        if (facts) {
          const state = patch.status === 'unknown' ? { state: 'unknown', unknownSince: facts.unknownSince ?? Date.now() } :
            patch.status === 'failed' && !facts.ackAt && facts.state !== 'delivered' ? { state: 'failed' } : {}
          this.store.patchCommand(id, { ...state, ...delivery })
        }
      }
      if (eligible) {
        receiptAdded = this.store.addWorkerReceipt(next)
        if (!receiptAdded) {
          next.receiptConflict = true
          this.store.event({
            type: 'task.receipt_conflict', id, threadId: next.threadId, turnId: next.turnId, at: next.updatedAt,
          })
        }
      }
      if (receiptAdded || (!workerTerminal && !delivery?.closedAt && next.status === 'failed' && next.routerThreadId === this.routerThreadId())) {
        this.onTerminal?.(next, receiptAdded)
        const messageId = 'worker-result:' + id
        const fact = terminalFact(this.workerLabel(next),next)
        const text = next.status === 'completed' && next.finalReply ? next.finalReply :
          renderExpression(fact,this.expressionProfile())
        this.store.put('message', messageId, { id: messageId, role: 'assistant', status: 'completed', routerThreadId:next.routerThreadId,
          label: (receiptAdded ? 'Worker · ' : 'Router · ') + this.workerLabel(next), text })
        if (receiptAdded && next.status === 'completed' && !next.finalReply && !patch.historyRead) next.needsFinalReply = true
        delete next.finalReply
      }
      delete next.historyRead
      if (workerTerminal && this.store.unobservedSteer.get(next.turnId)) next.checkSteerHistory = true
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
      ? { turnId: task.turnId ?? this.store.command(task.id)?.expectedTurnId, clientId: task.id, since: task.createdAt }
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
    for (const item of items.slice(items.findLastIndex(item => item.type === 'userMessage' && this.store.command(item.clientId ?? '')?.method !== 'steer') + 1)) {
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
        !items.slice(items.findLastIndex(item => item.type === 'userMessage' && this.store.command(item.clientId ?? '')?.method !== 'steer') + 1).some(item => item.id === question.itemId && item.questions?.length)) {
      this.store.put('message', id, { ...question, status: 'closed' })
      this.publish({ id: task.id })
      throw stale()
    }
    return { question, task, turn }
  }

  async answerQuestion({ id, text } = {}, origin) {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new HubError('codex-cli/bad-request', '回答为空或过长')
    const { question, task, turn } = await this.currentQuestion(id)
    if (this.closed || this.store.get('message', id)?.status !== 'pending') throw new HubError('codex-cli/router-stale', '问题已失效')
    const command = this.enqueue({ projectId: task.projectId, threadId: task.threadId, requestId: id,
      instruction: text, mode: 'resume', questionTurnId: turn.id, origin }, value => {
      this.store.put('message', id, { ...question, status: 'answered', commandId: value.id,
        receiptEvidence: { choices: publicQuestionChoices(question.questions, text) } })
    })
    return { id, answered: true, commandId: command.id, deliveryStatus: 'queued' }
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
    const worker = this.hub.status()
    if (!this.isReady() || worker.phase !== 'ready') return
    if (!this.protocol(worker).queue) return this.update(task.id, { status: 'failed', error: this.unavailable(worker) })
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
    if (this.closed || !this.isReady() || worker.connectedAt !== this.hub.status().connectedAt) return
    this.update(task.id, { restartRequestedAt: Date.now(), restartAttempts: (task.restartAttempts ?? 0) + 1, error: null })
    try {
      await this.hub.interruptTurn({ threadId: task.threadId, turnId: task.expectedTurnId })
    } catch {
      this.update(task.id, { error: '正在核对原 Worker 回合的中断结果' })
    }
    this.schedule()
  }

  async submit(task) {
    if (this.get(task.id).status !== 'queued' || this.store.get('stop',task.id)) return
    const worker = this.hub.status()
    if (worker.phase !== 'ready') return
    if (!this.protocol(worker).queue && !this.protocol(worker).steer) {
      this.update(task.id, { status: 'failed', error: this.unavailable(worker) })
      return
    }
    try {
      let threadId = task.threadId
      if (!threadId) {
        if (!this.protocol(worker).queue) return this.update(task.id, { status: 'failed', error: this.unavailable(worker) })
        this.update(task.id, { status: 'creating' }, false, { state: 'delivering', method: 'create', attemptedAt: Date.now() })
        const thread = await this.createWorker(this.project(task.projectId), undefined, task.worker?.permission)
        threadId = thread.id
        task = this.update(task.id, { threadId, status: 'queued' }, false, { state: 'queued' })
        this.store.put('binding', 'last', { projectId: task.projectId, threadId, at: Date.now() })
        this.onThreadCreated?.(task)
        if (this.followups?.withWorkerDelivery) return this.followups.withWorkerDelivery(threadId, () => this.submit(task))
      }
      if (!this.isReady() || this.closed) return
      const { project, detail } = await this.inspect(task)
      const active = detail.turns.findLast(turn => turn.status === 'inProgress')
      const questionTurnId = this.store.command(task.id)?.questionTurnId
      if (questionTurnId && detail.turns.at(-1)?.id !== questionTurnId) {
        return this.update(task.id, { status: 'failed', error: '问题所属回合已改变，请核对原回答' })
      }
      if (detail.thread.status?.type === 'active' || active || this.followups?.list(threadId).entries.length) {
        if (active && !this.followups?.list(threadId).entries.length) {
          await this.trySteer(task, project, detail, active)
        }
        if (task.workerAction === 'settings') await this.retain(threadId)
        if (this.get(task.id).status === 'queued' && this.store.command(task.id)?.state !== 'deferred') {
          this.update(task.id, {}, false, { state: 'deferred' })
        }
        return
      }
      if (!this.protocol(worker).queue) return this.update(task.id, { status: 'failed', error: this.unavailable(worker) })
      if (this.list(-1).some(other => other.id !== task.id && other.threadId === threadId &&
          other.turnId && !terminal.has(other.status))) return
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
      if (!this.isReady() || this.closed || this.get(task.id).status !== 'queued' || this.store.get('stop',task.id)) return
      if (task.workerAction === 'settings') {
        this.update(task.id, { status: 'completed', error: null, summary: 'Worker 会话设置已更新' }, false,
          { state: 'delivered', method: 'settings', settingsVerifiedAt: Date.now() })
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
      if (this.get(task.id).status !== 'queued' || this.store.get('stop',task.id) ||
          this.hub.status().phase !== 'ready' || worker.connectedAt !== this.hub.status().connectedAt) return
      task = this.update(task.id, { status: 'submitting', error: null, threadName: shortText(detail.thread.name, 120) }, false,
        { state: 'delivering', method: 'queue', ownerId: undefined, expectedTurnId: undefined, attemptedAt: Date.now() })
      const text = task.workerAction === 'restart' ? continuationPrompt : task.instruction
      const correction = task.corrections?.length ? this.correctionText(task) : undefined
      const queued = await this.hub.routerAddWorkerMessage(threadId, task.id, text, correction)
      if (!queued?.id || queued.clientUserMessageId !== task.id) throw new Error('缺少原生队列确认')
      const current = this.get(task.id)
      this.update(task.id, {
        queueId: queued.id,
        ...(current.status === 'submitting' ? { status: 'submitted' } : {}),
      }, false, { state: 'delivered', ackAt: Date.now(), queueId: queued.id })
      if (terminal.has(current.status)) this.store.patchCommand(task.id, { state: 'delivered', ackAt: Date.now(), queueId: queued.id })
    } catch (error) {
      const current = this.get(task.id)
      if (error.code === 'codex-cli/router-worker-settings') {
        this.update(task.id, { status: 'failed', error: error.message })
      } else if (current.status === 'submitting' && methodMissing(error, 'thread/queue/add')) {
        this.update(task.id, { status: 'failed', error: 'Worker 明确拒绝原生队列方法。请重新核验 Worker 协议后提交。' })
      } else if (current.status === 'creating' || current.status === 'submitting') {
        this.update(task.id, { status: 'unknown', error: '提交结果待核对，已暂停自动重试' })
      } else if (current.status === 'queued' && (error.code === -32601 || error.code === -32602 ||
          (error.code === -32600 && error.message.startsWith('Invalid request: unknown variant')))) {
        this.update(task.id, { status: 'failed', error: 'Worker ' + worker.codexVersion +
          ' 的派发前协议核验失败。请运行 zcodex verify-worker。' + shortText(error.message, 160) })
      } else if (error.code === 'codex-cli/router-thread' || error.code === 'codex-cli/router-project') {
        this.update(task.id, { status: 'failed', error: error.message })
      }
    }
  }

  async trySteer(task, project, detail, turn) {
    const facts = this.store.command(task.id)
    const worker = this.hub.status()
    if (!facts?.allowSteer || facts.waitForIdle || !this.protocol(worker).steer) return
    const pending = this.pendingFor(task.threadId, turn.id)
    const flags = detail.thread.status?.activeFlags ?? []
    if (pending.some(request => request.params.threadId !== task.threadId ||
        ![...steerWaitMethods.values()].includes(request.method)) ||
        flags.some(flag => !pending.some(request => request.method === steerWaitMethods.get(flag)))) return
    const invalid = await this.targetIssue?.(project, task.threadId) ||
      this.settingsIssue(task, project, await this.hub.routerWorkerSettings(task.threadId))
    if (invalid) return this.update(task.id, { status: 'failed', error: invalid })
    const owner = this.list(-1).find(row => row.threadId === task.threadId && row.turnId === turn.id &&
      !terminal.has(row.status))
    if (spawnedWorkers(turn.items ?? [], task.threadId).length || owner?.children?.length || await this.hub.routerQueueHead(task.threadId)) return
    if (facts.expectedTurnId && facts.expectedTurnId !== turn.id) return
    await this.retain(task.threadId)
    await checkProject(project)
    if (!this.isReady() || this.closed || this.get(task.id).status !== 'queued' || this.store.get('stop',task.id)) return
    if (this.hub.status().phase !== 'ready' || worker.connectedAt !== this.hub.status().connectedAt) return
    task = this.update(task.id, { status: 'submitting', error: null, threadName: shortText(detail.thread.name, 120) }, false, {
      method: 'steer', state: 'delivering', expectedTurnId: turn.id, ownerId: owner?.id, attemptedAt: Date.now(),
    })
    let result
    try {
      result = await this.hub.steerTurn({ threadId: task.threadId, turnId: turn.id,
        clientUserMessageId: task.id, text: task.instruction, ...(task.corrections?.length && { selectionContext:this.correctionText(task) }) })
    } catch (error) {
      const inactive = error.code === -32600 && /no active turn to steer/i.test(error.message)
      if (!inactive && !methodMissing(error, 'turn/steer')) throw error
      this.update(task.id, { status: 'queued' }, false, { state: 'deferred', waitForIdle: true })
      this.schedule()
      return
    }
    if (result?.turnId !== turn.id) throw new Error('缺少对应回合的 Steer 确认')
    this.acceptSteer(task, turn.id, { ackAt: Date.now() })
    this.schedule()
  }

  acceptSteer(task, turnId, evidence) {
    const facts = this.store.command(task.id)
    const status = facts.ownerId ? 'attached' : 'running'
    this.update(task.id, { status, turnId, error: null }, false, { state: 'delivered', ...evidence })
  }

  async reconcile(task) {
    if (!task.threadId) {
      if (task.status === 'creating') this.update(task.id, { status: 'unknown', error: '会话创建结果待核对' })
      return
    }
    const worker = this.hub.status()
    if (worker.phase !== 'ready') return
    const { project, detail } = await this.inspect(task, true)
    const facts = this.store.command(task.id)
    if (this.get(task.id).status !== task.status || this.closed) return
    if (facts?.method === 'steer' && !task.turnId) {
      const turn = detail.turns.find(turn => turn.id === facts.expectedTurnId)
      if (turn?.items?.filter(i => i.type === 'userMessage' && i.clientId === task.id).length === 1) {
        this.acceptSteer(task, turn.id, { historyAt: Date.now() })
        if (!facts.ownerId) this.applyTurn(this.get(task.id), turn)
      } else if (task.status !== 'unknown') {
        this.update(task.id, { status: 'unknown', error: '正在核对插话的接收情况' })
      }
      return
    }
    const hits = detail.turns.filter(turn => turn.id === task.turnId ||
      turn.items?.some(item => item.type === 'userMessage' && item.clientId === task.id))
    if (hits.length > 1 || hits.some(t => t.items?.filter(i => i.type === 'userMessage' && i.clientId === task.id).length > 1)) {
      this.update(task.id, { status: 'unknown', error: 'Worker 历史中的派发身份不唯一，需核对' })
      return
    }
    if (hits.length === 1) {
      const turn = hits[0]
      this.observeHistory(task.threadId, turn)
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
        ...(current.status === 'submitted' ? {} : { error: null }) }, false,
        facts?.state === 'delivered' ? undefined : { state: 'delivered', queueObservedAt: Date.now() })
      await this.retain(task.threadId)
      if (detail.thread.status?.type === 'active' || detail.turns.some(turn => turn.status === 'inProgress') ||
          this.followups?.list(task.threadId).entries.length || !this.isReady() || this.closed) return
      if (task.worker && (await this.hub.routerQueueHead(task.threadId))?.id !== queued.id) return
      if (task.workerAction === 'restart' && !restartedTurnMatches(task, detail)) {
        this.update(task.id, { error: '续执行消息仍在原生队列，原回合状态已变化，请检查队列' })
        return
      }
      const issue = await this.targetIssue?.(project, task.threadId) || await this.prepareWorker(task, project)
      if (issue) {
        this.update(task.id, { error: issue })
        return
      }
      const start = async () => {
        if (!this.isReady() || this.closed || this.store.get('stop',task.id) || this.get(task.id).status !== 'submitted') return
        if (!this.protocol(worker).queue || worker.connectedAt !== this.hub.status().connectedAt) {
          this.update(task.id, { error: '原生队列已有此指令，请核对原 Worker 队列及协议能力。' })
          return
        }
        const turn = await this.hub.routerStartWorkerMessage(task.threadId, queued.id)
        if (turn?.id) this.applyTurn(this.get(task.id), turn)
      }
      try {
        if (this.followups?.withWorkerDelivery) await this.followups.withWorkerDelivery(task.threadId, start)
        else await start()
      } catch { /* Reconcile the same native queue ID after conflicts or a lost response. */ }
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

  observeHistory(threadId, turn) {
    for (const item of turn.items ?? []) {
      if (item.type !== 'userMessage' || !item.clientId) continue
      const facts = this.store.command(item.clientId)
      if (!facts || facts.historyAt || facts.closedAt || this.get(item.clientId).threadId !== threadId ||
          (facts.method === 'steer' && facts.expectedTurnId !== turn.id)) continue
      if (turn.items.filter(i => i.type === 'userMessage' && i.clientId === item.clientId).length === 1) {
        this.store.patchCommand(item.clientId, { historyAt: Date.now(), state: 'delivered' })
      }
    }
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
      if (event.type === 'approval/resolved' && event.turnId && event.payload?.reason === 'answered' && event.payload.submitted) {
        const owners = this.list(-1).filter(task => task.routerThreadId === this.routerThreadId() && !terminal.has(task.status) &&
          ((task.threadId === event.threadId && task.turnId === event.turnId) || task.children?.some(c => c.id === event.threadId)))
        if (owners.length === 1) {
          const [owner] = owners
          const {instanceId,submitted} = event.payload
          this.store.put('task',owner.id,{...owner,nativeAnswers:[...(owner.nativeAnswers ?? []).filter(a => a.instanceId !== instanceId),
            {instanceId,...submitted}].slice(-16)})
        }
      }
      if (event.type === 'item/upsert' && event.payload?.item?.type === 'userMessage' &&
          this.store.command(event.payload.item.clientId ?? '')?.method !== 'steer') {
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
                   event.turnId && !task.turnId && this.store.command(task.id)?.method !== 'steer' && !['queued', 'creating'].includes(task.status)) {
          const status = waitStatus(this.pendingFor(task.threadId, event.turnId))
          this.update(task.id, { turnId: event.turnId, status }, false, { state: 'delivered', observedAt: Date.now() })
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
    this.scheduled = setTimeout(() => {
      this.scheduled = null
      this.sweep().catch(() => {})
    }, 40)
    this.scheduled.unref()
  }

  async sweep() {
    if (this.closed) return
    const stops = this.store.list('stop').filter(row => !row.finishedAt)
    for (const row of stops) this.driveStop(row.id).catch(() => {})
    const groups = new Map()
    for (const task of this.list(-1).reverse()) {
      if (terminal.has(task.status) && !task.needsFinalReply && !task.checkSteerHistory) continue
      if (task.status === 'unknown') {
        const facts = this.store.command(task.id)
        if (facts?.unknownSince && Date.now() - facts.unknownSince >= 120000 && !facts.alertAt) this.alertUnknown(task, facts)
      }
      const key = task.threadId ?? task.projectId
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(task)
    }
    const work = []
    for (const [key, tasks] of groups) {
      // A newly created Thread can change keys while its creating lane still owns the command.
      const existing = this.lanes.get(key) ?? [...this.lanes.values()].find(lane => tasks.some(t => lane.ids.has(t.id)))
      if (existing) {
        existing.dirty = true
        work.push(existing.promise)
        continue
      }
      const lane = { ids: new Set(tasks.map(task => task.id)), dirty: false }
      this.lanes.set(key, lane)
      lane.promise = this.sweepWorker(tasks).finally(() => {
        this.lanes.delete(key)
        if (lane.dirty) this.schedule()
      })
      work.push(lane.promise)
    }
    await Promise.all(work)
    if (this.closed) return
    const retained = new Set(this.list(-1).filter(t => !terminal.has(t.status))
      .flatMap(t => [t.threadId, ...(t.children ?? []).map(c => c.id)]))
    for (const id of this.retained) {
      if (retained.has(id)) continue
      this.retained.delete(id)
      await this.hub.closeThread(id, { routerWorker: true }).catch(() => {})
    }
  }

  async sweepWorker(tasks) {
    const serialized = (task, action) => task.threadId && this.followups?.withWorkerDelivery
      ? this.followups.withWorkerDelivery(task.threadId, action) : action()
    for (const task of tasks) {
      if (task.status === 'queued' && task.workerAction === 'restart') {
        try { await this.requestRestart(task, tasks) } catch (error) {
          if (['codex-cli/router-thread', 'codex-cli/router-project'].includes(error.code)) {
            this.update(task.id, { status: 'failed', error: error.message })
          }
        }
      }
    }
    for (const row of tasks) {
      if (this.closed) return
      let task = this.get(row.id)
      if (terminal.has(task.status)) {
        if ((task.needsFinalReply || task.checkSteerHistory) && this.hub.status().phase === 'ready') {
          try { await this.recoverFinalReply(task) } catch { /* Later history scan. */ }
        }
        continue
      }
      if (task.status === 'queued') {
        if (this.store.list('stop').some(stop => stop.threadId && stop.threadId === task.threadId && (!stop.finishedAt || (stop.state === 'unknown' && !stop.reviewedAt)))) break
        if (this.isReady()) await serialized(task, () => this.submit(task))
      } else if (['unknown','creating','submitting'].includes(task.status)) {
        await this.checkUncertain(task)
      } else {
        try { await this.reconcile(task) } catch { /* Later history scan. */ }
      }
      task = this.get(task.id)
      if (!terminal.has(task.status) && !['running','awaiting_input','awaiting_approval'].includes(task.status)) break
    }
  }

  async checkUncertain(task) {
    if (task.status !== 'unknown') task = this.update(task.id, { status: 'unknown', error: '正在核对未确认的 Worker 请求' })
    const facts = this.store.command(task.id)
    if (!facts || facts.alertAt) return
    const now = Date.now()
    if ((facts.checks ?? 0) < 5 && now - (facts.unknownSince ?? now) < 120000) {
      if (facts.lastCheckAt && now - facts.lastCheckAt < 12000) return
      this.store.patchCommand(task.id, { checks: (facts.checks ?? 0) + 1, lastCheckAt: now, unknownSince: facts.unknownSince ?? now })
      try { await this.reconcile(task) } catch { /* An unreadable history is inconclusive. */ }
      if (this.get(task.id).status !== 'unknown' || (facts.checks ?? 0) + 1 < 5) return
    }
    this.alertUnknown(task, this.store.command(task.id))
  }

  alertUnknown(task, facts) {
    if (facts.alertAt || this.get(task.id).status !== 'unknown') return
    const message = this.workerLabel(task) + ' 的指令 #' + (facts.seq ?? task.id) + ' 交付仍待核对。后续普通指令已暂停，请在 Router 任务中核对并关闭此记录。'
    this.store.transaction(() => {
      this.store.patchCommand(task.id, { alertAt: Date.now() })
      this.store.put('message', 'control-alert:' + task.id, { id: 'control-alert:' + task.id,
        routerThreadId: task.routerThreadId, dispatchId: task.id, role: 'assistant', text: message, status: 'completed' })
      this.onControlAlert?.(task, message)
      this.store.event({ type: 'command.review_required', id: task.id, at: Date.now() })
    })
    this.publish({ id: task.id })
  }

  async recoverFinalReply(task) {
    const { detail } = await this.inspect(task, true)
    const turn = detail.turns.find(entry => entry.id === task.turnId && turnTerminal.has(entry.status))
    if (!turn || this.closed || !Array.isArray(turn.items)) return
    this.observeHistory(task.threadId, turn)
    task = this.get(task.id)
    delete task.checkSteerHistory
    if (!task.needsFinalReply) {
      this.store.put('task', task.id, task)
      this.publish({ id: task.id })
      return
    }
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

  correctionText(task) {
    return '用户已纠正以下误派指令，请停止沿用这些要求，以本次原文为准：' +
      task.corrections.map(id => '#' + this.store.command(id).seq + ' ' + shortText(this.get(id).instruction,160)).join('；')
  }

  stopCommand({ id, turnId, correction, origin }) {
    const task = this.get(id)
    const previous = this.store.get('stop',id)
    if (!previous) {
      this.store.transaction(() => {
        this.store.put('stop',id,{ id,threadId:task.threadId,turnId,origin,correction:!!correction,state:'pending',createdAt:Date.now() })
        if (task.status === 'queued') {
          this.update(id,{status:'cancelled',summary:'已取消，未提交 Worker。'},false,{state:'cancelled'})
          this.finishStop(id,'cancelled','已取消，未提交 Worker。')
        }
      })
    }
    return this.driveStop(id)
  }

  finishStop(id, state, message, finished = true) {
    const old = this.store.get('stop',id)
    if (old.finishedAt || (state === old.state && !finished)) return old
    const stop = { ...old,state,message,...(finished && { finishedAt:Date.now() }) }
    this.store.transaction(() => {
      this.store.put('stop',id,stop)
      const task = this.get(id)
      if (stop.correction && stop.threadId && finished && !['cancelled','withdrawn'].includes(state))
        this.store.put('correction',id,{id,threadId:stop.threadId})
      const mid = 'stop:'+id+':'+state
      this.store.put('message',mid,{id:mid,dispatchId:id,routerThreadId:task.routerThreadId,role:'assistant',status:'completed',text:message})
      this.onStop?.(stop,task)
      this.store.event({type:'control.'+state,id,at:Date.now()})
    })
    this.publish({id})
    return stop
  }

  driveStop(id) {
    if (this.stopping.has(id)) return this.stopping.get(id)
    const pending = this.checkStop(id).catch(() => {
      const stop = this.store.get('stop',id)
      return Date.now()-stop.createdAt >= 120000 ? this.finishStop(id,'unknown','停止结果待核对，请打开原 Worker 查看。') : stop
    }).finally(() => this.stopping.delete(id))
    this.stopping.set(id,pending)
    return pending
  }

  async checkStop(id) {
    const stop = this.store.get('stop',id)
    if (stop.finishedAt) return stop
    const task = this.get(id)
    const facts = this.store.command(id)
    if (task.status === 'queued') {
      this.update(id,{status:'cancelled',summary:'已取消，未提交 Worker。'},false,{state:'cancelled'})
      return this.finishStop(id,'cancelled','已取消，未提交 Worker。')
    }
    if (!task.threadId || this.hub.status().phase !== 'ready') throw new Error('Worker 暂不可用')
    const {project,detail} = await this.inspect(task,true)
    const issue = await this.targetIssue?.(project,task.threadId) || this.settingsIssue(task,project,await this.hub.routerWorkerSettings(task.threadId))
    if (issue) return this.finishStop(id,'unknown',issue+'。请核对停止结果。')
    const turnId = stop.turnId ?? task.turnId
    const turn = detail.turns.find(t => turnId ? t.id === turnId : t.items?.some(i => i.type === 'userMessage' && i.clientId === id))
    if (turnTerminal.has(turn?.status)) {
      const result = shortText(finalAnswer(turn.items)?.text,320)
      return this.finishStop(id,turn.status,turn.status === 'interrupted' ? '原 Worker 回合已中断。' :
        '原 Worker 回合已经结束。'+(result || '请查看原会话核对结果及已产生的改动。'))
    }
    if (turn?.status === 'inProgress' && !['requested','interrupting'].includes(stop.state)) {
      this.store.put('stop',id,{...stop,state:'interrupting',threadId:task.threadId,turnId:turn.id})
      await this.hub.interruptTurn({threadId:task.threadId,turnId:turn.id})
      this.finishStop(id,'requested','已向原 Worker 请求中断，正在等待回合终态。',false)
      this.schedule()
      return this.store.get('stop',id)
    }
    if (!turn && facts?.method === 'queue' && stop.state === 'pending') {
      const queued = await this.hub.routerFindWorkerMessage(task.threadId,id)
      if (queued && queued.clientUserMessageId === id) {
        this.store.put('stop',id,{...stop,state:'withdrawing',threadId:task.threadId})
        if (await this.hub.routerDeleteWorkerMessage(task.threadId,queued.id)) {
          this.update(id,{status:'cancelled',summary:'已从 Worker 原生队列撤回。'})
          return this.finishStop(id,'withdrawn','已从 Worker 原生队列撤回。')
        }
      }
    }
    if (Date.now()-stop.createdAt >= 120000) return this.finishStop(id,'unknown','停止结果待核对，请打开原 Worker 查看。')
    return this.store.get('stop',id)
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
    await Promise.allSettled([...this.stopping.values(), ...[...this.lanes.values()].map(lane => lane.promise)])
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
