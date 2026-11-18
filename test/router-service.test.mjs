import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { EventBus } from '../server/services/events.js'
import { bootstrap } from '../server/bootstrap.js'
import { loadConfig } from '../server/config.js'
import { RouterService } from '../server/router/service.js'
import { RouterStore } from '../server/router/store.js'
import { normalizeRouterConfig } from '../server/router/app-server.js'
import { routerNamespace } from '../server/router/tools.js'

async function fixture(t, { discover = false, wakePolicy = { mergeMs: 60000, gapMs: 0 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'router-service-'))
  const cwd = join(root, 'worker')
  await mkdir(cwd)
  const bus = new EventBus()
  const stateDir = join(root, 'state')
  const threads = new Map(['worker-a','worker-b'].map((id, index) => [id, {
    thread: { id, cwd, name: index ? '同名测试乙' : '同名测试甲', status: { type: 'idle' } }, turns: [],
  }]))
  const submitted = []
  const interrupts = []
  const retained = new Set()
  const routerHistory = []
  const sent = []
  let wakeBehavior = 'hold'
  let nativeStatus
  let policy = 'on-request'
  let sandbox = { type: 'readOnly', networkAccess: false }
  let loseReply = false
  const hub = {
    status: () => ({ phase: 'ready', codexVersion: '0.169.1' }),
    projects: async () => discover ? [{ cwd, name: 'Alpha', threadCount: 2 }] : [],
    listThreads: async () => ({ data: [...threads.values()].map(value => value.thread) }),
    routerReadWorker: async id => threads.get(id) ?? { thread: null, turns: [] },
    newThread: async (params, options) => {
      assert.equal(params.cwd, cwd)
      assert.equal(params.approvalPolicy, 'on-request')
      assert.equal(options.routerWorker, true)
      const thread = { id: 'created-worker', cwd, name: '新会话', status: { type: 'idle' } }
      threads.set(thread.id, { thread, turns: [] })
      return thread
    },
    renameThread: async () => {},
    routerWorkerSettings: async () => ({ cwd, approvalPolicy: policy, approvalsReviewer: 'user', sandbox }),
    routerAddWorkerMessage: async (threadId, clientUserMessageId, text) => {
      const queued = { id: 'queued-' + clientUserMessageId, clientUserMessageId }
      submitted.push({ threadId, text, ...queued })
      if (loseReply) throw new Error('fixture acknowledgement lost')
      return queued
    },
    routerFindWorkerMessage: async (id, clientId) => submitted.find(item => item.threadId === id && item.clientUserMessageId === clientId),
    routerStartWorkerMessage: async () => { throw new Error('fixture still busy') },
    openThread: async id => { retained.add(id) },
    closeThread: async id => { retained.delete(id) },
    pendingApprovals: () => [],
    interruptTurn: async params => { interrupts.push(params) },
  }
  let hooks
  let router
  let runtime
  let starts = 0
  let resumes = 0
  let turnNumber = 0
  let callNumber = 0
  const connect = async options => {
    hooks = options
    const routerCwd = join(options.directory, 'workspace')
    return {
      cwd: routerCwd,
      selected: { model: 'offline-fixture' },
      close() {},
      start: async () => { starts++; return { thread: { id: 'router-only', cwd: routerCwd } } },
      resume: async id => { resumes++; return { thread: { id, cwd: routerCwd } } },
      request: async (method, { threadId }) => {
        if (method === 'thread/read') return { thread: { id: threadId, status: {
          type: nativeStatus ?? (routerHistory[0]?.status === 'inProgress' ? 'active' : 'idle'),
        } } }
        assert.equal(method, 'thread/turns/list')
        return { data: structuredClone(routerHistory) }
      },
      send: async (threadId, text, requestId, { workerReceipt = false } = {}) => {
        sent.push({ threadId, text, requestId, workerReceipt })
        if (workerReceipt && wakeBehavior === 'rejected') throw Object.assign(Error('invalid params'), { code: -32602 })
        if (workerReceipt && wakeBehavior === 'unknown') throw new Error('lost reply')
        runtime = { threadId, turnId: 'router-turn-' + ++turnNumber }
        const user = { type: 'userMessage', clientId: requestId }
        const turn = { id: runtime.turnId, status: 'inProgress', items: [user] }
        routerHistory.unshift(turn)
        if (workerReceipt && wakeBehavior === 'lost-after-accept') {
          turn.status = 'completed'
          turn.items.push({ type: 'agentMessage', phase: 'final_answer', text: '历史恢复的回执' })
          throw new Error('lost reply after native completion')
        }
        options.onEvent('turn/started', { threadId, turn: { id: runtime.turnId } })
        if (workerReceipt && wakeBehavior === 'ended-before-ack') {
          turn.status = 'completed'
          const reply = { type: 'agentMessage', id: 'early-answer', phase: 'final_answer', text: '提前完成的回执' }
          turn.items.push(reply)
          options.onEvent('item/completed', { ...runtime, item: reply })
          options.onEvent('turn/completed', { threadId, turn: { id: turn.id, status: turn.status } })
        }
        options.onEvent('item/started', { ...runtime, item: user })
        return { turn: { id: runtime.turnId } }
      },
    }
  }
  const config = { enabled: true, projects: discover ? [] : [{ id: 'alpha-project', name: 'Alpha', cwd }] }
  async function boot() {
    router = new RouterService({ config, stateDir, hub, bus, connect, wakePolicy })
    router.start()
    await router.opening
    assert.equal(router.status().phase, 'ready')
  }
  t.after(async () => {
    await router?.close()
    bus.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await boot()
  return {
    get router() { return router }, stateDir, cwd, threads, submitted, interrupts, bus, retained, sent, routerHistory,
    set wakeBehavior(value) { wakeBehavior = value },
    set nativeStatus(value) { nativeStatus = value },
    get starts() { return starts }, get resumes() { return resumes },
    set policy(value) { policy = value },
    set sandbox(value) { sandbox = value },
    set loseReply(value) { loseReply = value },
    tool: async (tool, args, overrides = {}) => {
      const result = await hooks.onTool({ ...runtime, namespace: routerNamespace, callId: 'call-' + ++callNumber,
        tool, arguments: args, ...overrides })
      return { success: result.success, value: JSON.parse(result.contentItems[0].text) }
    },
    finish: (text = 'Router fixture', status = 'completed') => {
      const item = { type: 'agentMessage', id: runtime.turnId, text }
      routerHistory[0].status = status
      routerHistory[0].items.push(item)
      hooks.onEvent('item/completed', { ...runtime, item })
      hooks.onEvent('turn/completed', { threadId: runtime.threadId, turn: { id: runtime.turnId, status } })
    },
    restart: async () => { await router.close(); await boot() },
  }
}

function args(requestId, threadId = 'worker-a') {
  return { projectId: 'alpha-project', threadId, mode: 'resume', instruction: 'untrusted replacement', requestId }
}

test('discovered projects require explicit access approval and remember it across restart', async t => {
  const fx = await fixture(t, { discover: true })
  const requestId = 'discover-project-01'
  await fx.router.send({ requestId, text: '在 Alpha 新建会话' })
  const listed = await fx.tool('list_projects', { query: 'Alpha' })
  assert.equal(listed.success, true)
  const [project] = listed.value
  assert.equal(project.requiresApproval, true)
  assert.equal(fx.router.projects.size, 0)
  const proposed = await fx.tool('create_session', { projectId: project.id })
  assert.equal(proposed.value.status, 'needs_confirmation')
  const [pending] = fx.router.read().clarifications
  assert.match(pending.candidates[0].name, /Alpha/)
  assert.equal(fx.threads.has('created-worker'), false)
  await fx.router.confirm({ id: pending.id, revision: pending.revision, candidateId: project.id })
  assert.equal(fx.threads.has('created-worker'), true)
  fx.finish()
  await fx.restart()
  assert.equal(fx.router.projects.get(project.id)?.sandbox, 'read-only')
  assert.equal((await fx.router.projectRows()).find(row => row.id === project.id)?.requiresApproval, undefined)
})

test('Router chats and restores the same session and transcript', async t => {
  const fx = await fixture(t)
  await fx.router.send({ requestId: 'plain-chat-0001', text: '你好' })
  fx.finish('你好！')
  assert.deepEqual(fx.router.read().messages.map(message => message.text), ['你好', '你好！'])
  assert.deepEqual(fx.router.read().tasks, [])
  await fx.restart()
  assert.equal(fx.starts, 1)
  assert.equal(fx.resumes, 1)
  assert.equal(fx.router.read().messages.at(-1).text, '你好！')
})

test('Router preserves original instructions and confirmation across restart, then uses selected Worker once', async t => {
  const fx = await fixture(t)
  const requestId = 'uncertain-0001'
  const text = '请派发给 Alpha 的同名测试，核对原始变更。'
  await fx.router.send({ requestId, text })
  const first = await fx.tool('dispatch_task', args(requestId))
  assert.equal(first.value.status, 'needs_confirmation')
  fx.finish()
  assert.deepEqual(fx.submitted, [])
  await fx.restart()

  const [pending] = fx.router.read().clarifications
  assert.equal(pending.kind, 'session')
  assert.deepEqual(pending.candidates.map(candidate => candidate.id), ['worker-a', 'worker-b'])
  const confirm = { id: pending.id, revision: pending.revision, candidateId: 'worker-b' }
  const [task, duplicate] = await Promise.all([fx.router.confirm(confirm), fx.router.confirm(confirm)])
  assert.equal(task.threadId, 'worker-b')
  assert.ok(duplicate.id === task.id || duplicate.status === 'confirmed')
  await fx.router.dispatcher.sweep()
  assert.deepEqual(fx.submitted.map(item => [item.threadId, item.text]), [['worker-b', text]])
  assert.equal(fx.router.getTask(task.id).status, 'submitted')

  const context = { threadId: task.threadId, turnId: 'worker-turn' }
  fx.bus.publish('item/upsert', { item: { type: 'userMessage', clientId: task.id } }, context)
  fx.bus.publish('approval/requested', {}, context)
  assert.equal(fx.router.getTask(task.id).status, 'awaiting_approval')
  fx.bus.publish('item/upsert', { completed: true, item: { type: 'agentMessage', text: '核对完成' } }, context)
  fx.bus.publish('turn/completed', { turn: { id: 'worker-turn', status: 'completed' } }, context)
  fx.bus.publish('approval/requested', {}, context)
  assert.equal(fx.router.getTask(task.id).summary, '核对完成')
  assert.equal(fx.router.getTask(task.id).status, 'completed')
})

test('Router keeps a submitted task during native queue handoff and reconciles its turn', async t => {
  const fx = await fixture(t)
  const requestId = 'queue-handoff-0001'
  await fx.router.send({ requestId, text: '请派发给 Alpha 的同名测试甲，核对修改。' })
  const task = (await fx.tool('dispatch_task', args(requestId))).value
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'submitted')

  fx.submitted.length = 0
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'submitted')

  fx.threads.get(task.threadId).turns.push({ id: 'handoff-turn', status: 'completed',
    items: [{ type: 'userMessage', clientId: task.id }] })
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'completed')
  assert.equal(fx.router.getTask(task.id).turnId, 'handoff-turn')
  assert.deepEqual(fx.submitted, [])
})

test('Router denies wrong scope and overrides, waits while busy, then refuses an elevated Worker', async t => {
  const fx = await fixture(t)
  fx.threads.get('worker-a').thread.status = { type: 'active' }
  const requestId = 'strict-task-0001'
  await fx.router.send({ requestId, text: '请派发给 Alpha 的同名测试甲，核对修改。' })
  assert.equal((await fx.tool('list_projects', {}, { threadId: 'worker-a' })).success, false)
  assert.equal((await fx.tool('dispatch_task', { ...args(requestId), approvalPolicy: 'never' })).success, false)
  assert.equal((await fx.tool('dispatch_task', args('other-request'))).success, false)
  assert.equal((await fx.tool('dispatch_task', args(requestId, 'router-only'))).success, false)
  const task = (await fx.tool('dispatch_task', args(requestId))).value
  assert.equal(task.status, 'queued')
  fx.finish()
  await fx.router.dispatcher.sweep()
  assert.equal(fx.submitted.length, 0)
  fx.threads.get('worker-a').thread.status = { type: 'idle' }
  fx.policy = 'never'
  fx.sandbox = { type: 'dangerFullAccess' }
  await fx.router.dispatcher.sweep()
  const rejected = fx.router.getTask(task.id)
  assert.equal(rejected.status, 'failed')
  assert.match(rejected.error, /必须启用按需审批/)
  assert.match(rejected.error, /沙箱不受 Router 支持/)
  assert.equal(fx.submitted.length, 0)
})

test('a second Router process cannot use the same SQLite state while its owner is active', async t => {
  const fx = await fixture(t)
  assert.throws(() => new RouterStore(join(fx.stateDir, 'router', 'router.sqlite')), /locked/)
  assert.throws(() => normalizeRouterConfig({ enabled: true, launcher: 'codex' }), /SHA-256/)
})

test('new Worker dispatch survives a lost queue acknowledgement without a duplicate native add', async t => {
  const fx = await fixture(t)
  const requestId = 'create-worker-0001'
  const text = '请在 Alpha 项目新建会话，然后派发这项检查。'
  await fx.router.send({ requestId, text })
  const task = (await fx.tool('dispatch_task', { projectId: 'alpha-project', mode: 'new', instruction: 'wrong', requestId })).value
  assert.equal(task.status, 'queued')
  fx.finish()
  fx.loseReply = true
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'unknown')
  assert.equal(fx.submitted.length, 1)
  assert.equal(fx.submitted[0].threadId, 'created-worker')
  await fx.restart()
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'submitted')
  assert.equal(fx.submitted.length, 1)
})

test('only explicit confirmation can interrupt the task’s currently associated Worker turn', async t => {
  const fx = await fixture(t)
  const requestId = 'interrupt-source-001'
  await fx.router.send({ requestId, text: '请派发给 Alpha 的同名测试甲，复查输出。' })
  const task = (await fx.tool('dispatch_task', args(requestId))).value
  fx.finish()
  await fx.router.dispatcher.sweep()
  const associated = { threadId: 'worker-a', turnId: 'associated-turn' }
  fx.threads.get('worker-a').turns.push({ id: associated.turnId, status: 'inProgress' })
  fx.bus.publish('item/upsert', { item: { type: 'userMessage', clientId: task.id } }, associated)
  await fx.router.send({ requestId: 'interrupt-confirm-001', text: '中断刚才那个任务。' })
  const offered = (await fx.tool('interrupt_task', { dispatchId: task.id })).value
  assert.equal(offered.status, 'needs_confirmation')
  assert.deepEqual(fx.interrupts, [])
  const [pending] = fx.router.read().clarifications
  await assert.rejects(fx.router.confirm({ id: pending.id, revision: pending.revision, candidateId: 'worker-b' }), /不在待确认/)
  await fx.router.confirm({ id: pending.id, revision: pending.revision, candidateId: task.id })
  assert.deepEqual(fx.interrupts, [associated])
})

test('authenticated RPC reaches the private Router service through the workbench envelope', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'router-http-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const accessToken = 'offline-router-workbench-fixture'
  const config = await loadConfig({
    port: 0, stateDir, accessToken, logLevel: 'silent',
    router: {
      enabled: true, launcher: '/opt/test/codex-router', launcherSha256: 'a'.repeat(64),
      models: [{ model: 'offline-fixture', effort: 'low' }],
    },
  }, {})
  const app = await bootstrap(config, {
    openTransport: async () => {
      let onMessage
      const transport = {
        onMessage(handler) { onMessage = handler; return () => {} },
        onClose: () => () => {},
        close() {},
        send(message) {
          if (message.method === 'initialize') queueMicrotask(() => onMessage({ id: message.id, result: { userAgent: 'fixture/0.169.1' } }))
        },
      }
      return { transport, kind: 'stdio', socketPath: null }
    },
    async openRouterApp({ directory, onEvent }) {
      const cwd = join(directory, 'workspace')
      const threadId = 'private-router'
      return {
        cwd, selected: { model: 'offline-fixture' }, close() {},
        start: async () => ({ thread: { id: threadId, cwd } }),
        send: async (_threadId, _text, requestId) => {
          const turn = { id: 'hello-turn', status: 'completed' }
          onEvent('turn/started', { threadId, turn })
          onEvent('item/started', { threadId, turnId: turn.id, item: { type: 'userMessage', clientId: requestId } })
          onEvent('item/completed', { threadId, turnId: turn.id, item: { id: 'reply', type: 'agentMessage', text: '你好！' } })
          onEvent('turn/completed', { threadId, turn })
          return { turn }
        },
      }
    },
  })
  t.after(() => app.close())
  await app.router.opening
  function rpc(method, payload, cookie = '') {
    return fetch(app.origin + '/codex-cli/' + method, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-codex-request': '1' },
      body: JSON.stringify({ type: 'client-request', method, payload, rpcId: 'test-router' }),
    })
  }
  assert.equal((await rpc('router/read', {})).status, 401)
  const login = await fetch(app.origin + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-request': '1' },
    body: JSON.stringify({ token: accessToken }),
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const request = { requestId: 'http-router-test-01', text: '你好' }
  const sent = await (await rpc('router/send', request, cookie)).json()
  assert.equal(sent.rpcId, 'test-router')
  assert.equal(sent.result.value.status, 'completed')
  const read = await (await rpc('router/read', {}, cookie)).json()
  assert.deepEqual(read.result.value.messages.map(message => message.text), ['你好', '你好！'])
  assert.deepEqual(read.result.value.tasks, [])
})

async function dispatch(fx, requestId, threadId = 'worker-a') {
  const name = threadId === 'worker-a' ? '同名测试甲' : '同名测试乙'
  await fx.router.send({ requestId, text: '请派发给 Alpha 的' + name + '，核对修改。' })
  const call = await fx.tool('dispatch_task', args(requestId, threadId))
  assert.equal(call.success, true)
  fx.finish()
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(call.value.id).status, 'submitted')
  return call.value
}

function completeWorker(fx, task, { status = 'completed', notify = true, itemFirst = true } = {}) {
  const turnId = 'turn-' + task.id
  const user = { type: 'userMessage', clientId: task.id }
  const answer = { type: 'agentMessage', phase: 'final_answer', text: '关联 Worker 的最终答复' }
  fx.threads.get(task.threadId).turns.push({
    id: turnId, status, items: [user, answer, { type: 'agentMessage', phase: 'commentary', text: '后到的进度' }],
  })
  const scope = { threadId: task.threadId, turnId }
  const completed = () => fx.bus.publish('turn/completed', { turn: { id: turnId, status } }, scope)
  if (notify) {
    if (!itemFirst) completed()
    fx.bus.publish('item/upsert', { item: user }, scope)
    if (itemFirst) completed()
  }
  return completed
}

test('Worker receipts are persisted without a browser, merged while busy and read only by their Router batch', async t => {
  const fx = await fixture(t)
  const first = await dispatch(fx, 'receipt-dispatch-01')
  const second = await dispatch(fx, 'receipt-dispatch-02', 'worker-b')
  assert.deepEqual([...fx.retained].sort(), ['worker-a', 'worker-b'])

  await fx.router.send({ requestId: 'receipt-user-busy', text: '正在处理另一条用户消息' })
  fx.bus.publish('turn/completed', { turn: { id: 'ordinary', status: 'completed' } }, { threadId: 'worker-b', turnId: 'ordinary' })
  assert.equal(fx.router.getTask(second.id).receiptStatus, null)
  const duplicate = completeWorker(fx, first)
  completeWorker(fx, second, { status: 'interrupted' })
  duplicate()
  assert.equal(fx.router.store.events(30).filter(row => row.type === 'task.completed').length, 1)
  await fx.router.wake.run()
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 0)
  assert.equal(fx.router.getTask(first.id).receiptStatus, 'pending')

  fx.finish()
  await fx.router.wake.run()
  const wakes = fx.sent.filter(send => send.workerReceipt)
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].threadId, 'router-only')
  assert.match(wakes[0].text, new RegExp(first.id))
  assert.match(wakes[0].text, new RegExp(second.id))
  assert.equal(fx.router.getTask(second.id).receiptStatus, 'claimed')
  assert.equal((await fx.tool('dispatch_task', args(wakes[0].requestId))).value.code, 'codex-cli/router-receipt-scope')
  assert.equal((await fx.tool('get_task_status', { dispatchId: 'another-id' })).success, false)
  const result = await fx.tool('get_task_status', { dispatchId: first.id })
  assert.equal(result.value.finalReply, '关联 Worker 的最终答复')
  assert.equal(result.value.executionStatus, 'completed')
  assert.equal((await fx.tool('get_task_status', { dispatchId: second.id })).value.executionStatus, 'interrupted')
  fx.finish('收到两项 Worker 回执')
  duplicate()
  await fx.router.wake.run()
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 1)
  assert.equal(fx.router.getTask(first.id).receiptStatus, 'delivered')
  assert.equal(fx.router.getTask(second.id).receiptStatus, 'delivered')
  assert.equal(fx.router.read().messages.filter(message => message.text === '收到两项 Worker 回执').length, 1)
  assert.equal(fx.router.read().messages.some(message => message.text.includes('这是工作台发送')), false)
})

test('a missed Worker event is reconciled after restart and a lost Router acknowledgement uses native history', async t => {
  const fx = await fixture(t)
  const task = await dispatch(fx, 'receipt-restart-01')
  completeWorker(fx, task, { notify: false, status: 'failed' })
  assert.equal(fx.router.getTask(task.id).receiptStatus, null)
  await fx.restart()
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'failed')
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'pending')

  fx.wakeBehavior = 'lost-after-accept'
  await fx.router.wake.run()
  assert.equal(fx.router.status().phase, 'unavailable')
  await fx.restart()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'delivered')
  await fx.router.wake.run()
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 1)
  assert.equal(fx.router.read().messages.filter(message => message.text === '历史恢复的回执').length, 1)
})

test('an ambiguous wake stays visible across restart and waits for native idle before accepting more input', async t => {
  const fx = await fixture(t)
  const task = await dispatch(fx, 'receipt-ambiguous-01')
  completeWorker(fx, task)
  fx.wakeBehavior = 'unknown'
  await fx.router.wake.run()
  fx.nativeStatus = 'active'
  await fx.restart()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'unknown')
  await assert.rejects(fx.router.send({ requestId: 'receipt-busy-after-01', text: '另一个用户问题' }), /正在回复/)
  fx.nativeStatus = 'idle'
  await fx.router.wake.run()
  assert.equal(fx.router.read().busy, false)
  await fx.restart()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'unknown')
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 1)
})

test('with no attached pages the scheduler starts a round and handles terminal notification before acknowledgement', async t => {
  const fx = await fixture(t, { wakePolicy: { mergeMs: 5, gapMs: 0 } })
  const task = await dispatch(fx, 'receipt-early-end-01')
  fx.wakeBehavior = 'ended-before-ack'
  completeWorker(fx, task, { itemFirst: false })
  for (let i = 0; i < 100 && fx.router.getTask(task.id).receiptStatus !== 'delivered'; i++) await delay(10)
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'delivered')
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 1)
  assert.equal(fx.router.read().messages.filter(message => message.text === '提前完成的回执').length, 1)
})

test('failed wake attempts back off and preserve older tasks while the rolling budget is exhausted', async t => {
  const fx = await fixture(t, { wakePolicy: { mergeMs: 60000, gapMs: 0, daily: 2, attempts: 2 } })
  const task = await dispatch(fx, 'receipt-retry-01')
  completeWorker(fx, task)
  fx.wakeBehavior = 'rejected'
  await fx.router.wake.run()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'pending')
  await fx.router.wake.run()
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 1)
  const [batch] = fx.router.store.list('wake')
  fx.router.store.updateReceipts.run('pending', 0, batch.id)
  await fx.router.wake.run()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'failed')
  const secondTask = await dispatch(fx, 'receipt-retry-02', 'worker-b')
  completeWorker(fx, secondTask)
  await fx.restart()
  await fx.router.wake.run()
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 2)
  assert.equal(fx.router.getTask(secondTask.id).receiptStatus, 'pending')
  assert.equal(fx.router.read().receiptLimited, true)
})

test('Worker input requests stay non-terminal and duplicate Turn ownership records only one receipt', async t => {
  const fx = await fixture(t)
  const task = await dispatch(fx, 'receipt-user-input-01')
  const meta = { threadId: task.threadId, turnId: 'shared-turn' }
  fx.bus.publish('item/upsert', { item: { type: 'userMessage', clientId: task.id } }, meta)
  fx.bus.publish('approval/requested', { method: 'item/tool/requestUserInput' }, meta)
  assert.equal(fx.router.getTask(task.id).status, 'awaiting_input')
  assert.equal(fx.router.getTask(task.id).receiptStatus, null)
  fx.bus.publish('approval/resolved', {}, meta)
  assert.equal(fx.router.getTask(task.id).status, 'running')

  fx.bus.publish('turn/completed', { turn: { id: meta.turnId, status: 'completed' } }, meta)
  const other = await dispatch(fx, 'receipt-user-input-02')
  fx.bus.publish('item/upsert', { item: { type: 'userMessage', clientId: other.id } }, meta)
  fx.bus.publish('turn/completed', { turn: { id: meta.turnId, status: 'completed' } }, meta)
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'pending')
  assert.equal(fx.router.getTask(other.id).receiptStatus, 'unknown')
  assert.equal(fx.router.store.events(40).filter(row => row.type === 'task.receipt_conflict').length, 1)
})

test('a resumed receipt stays read-only and a stale in-progress snapshot on an idle native thread becomes unknown', async t => {
  const fx = await fixture(t)
  const task = await dispatch(fx, 'receipt-stale-running-01')
  completeWorker(fx, task)
  await fx.router.wake.run()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'claimed')
  await fx.restart()
  assert.equal(fx.router.read().busy, true)
  assert.equal((await fx.tool('create_session', { projectId: 'alpha-project' })).value.code, 'codex-cli/router-receipt-scope')
  fx.nativeStatus = 'idle'
  await fx.router.wake.run()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'claimed')
  await fx.router.wake.run()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'unknown')
  assert.equal(fx.router.read().busy, false)
  assert.equal(fx.sent.filter(send => send.workerReceipt).length, 1)
})

test('a stale user turn in history does not block pending Worker receipts once the Router is natively idle', async t => {
  const fx = await fixture(t)
  const task = await dispatch(fx, 'receipt-stale-user-01')
  await fx.router.send({ requestId: 'lost-user-turn-01', text: '另一条用户消息' })
  completeWorker(fx, task)
  fx.nativeStatus = 'idle'
  await fx.restart()
  assert.equal(fx.router.read().busy, false)
  assert.equal(fx.router.read().messages.find(message => message.id === 'user:lost-user-turn-01').status, 'unknown')
  await fx.router.wake.run()
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'claimed')
})

test('v1 state migration preserves old terminal tasks without seeding receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'router.sqlite')
  const previous = new DatabaseSync(path)
  previous.exec(`
    CREATE TABLE router_records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind, id));
    CREATE TABLE router_events (seq INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_records VALUES ('task', 'old', '{"id":"old","status":"completed"}');
    PRAGMA user_version=1;
  `)
  previous.close()
  const migrated = new RouterStore(path)
  try {
    assert.equal(migrated.get('task', 'old').status, 'completed')
    assert.equal(migrated.receiptState('old'), null)
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 2)
  } finally { migrated.close() }
})

test('a failed receipt insert rolls back Worker terminal state before history retries the transaction', async t => {
  const fx = await fixture(t)
  const task = await dispatch(fx, 'receipt-rollback-01')
  fx.router.store.db.exec(`
    CREATE TEMP TRIGGER fail_receipt_insert BEFORE INSERT ON router_receipts
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
  `)
  completeWorker(fx, task)
  assert.equal(fx.router.getTask(task.id).status, 'running')
  assert.equal(fx.router.getTask(task.id).receiptStatus, null)
  assert.equal(fx.router.store.events(20).some(event => event.type === 'task.completed'), false)
  fx.router.store.db.exec('DROP TRIGGER fail_receipt_insert')
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'completed')
  assert.equal(fx.router.getTask(task.id).receiptStatus, 'pending')
})
