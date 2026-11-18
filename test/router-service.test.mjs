import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventBus } from '../server/services/events.js'
import { bootstrap } from '../server/bootstrap.js'
import { loadConfig } from '../server/config.js'
import { RouterService } from '../server/router/service.js'
import { RouterStore } from '../server/router/store.js'
import { normalizeRouterConfig } from '../server/router/app-server.js'
import { routerNamespace } from '../server/router/tools.js'

async function fixture(t) {
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
  let policy = 'on-request'
  let loseReply = false
  const hub = {
    status: () => ({ phase: 'ready', codexVersion: '0.169.1' }),
    projects: async () => [],
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
    routerWorkerSettings: async () => ({ cwd, approvalPolicy: policy, approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } }),
    routerAddWorkerMessage: async (threadId, clientUserMessageId, text) => {
      const queued = { id: 'queued-' + clientUserMessageId, clientUserMessageId }
      submitted.push({ threadId, text, ...queued })
      if (loseReply) throw new Error('fixture acknowledgement lost')
      return queued
    },
    routerFindWorkerMessage: async (id, clientId) => submitted.find(item => item.threadId === id && item.clientUserMessageId === clientId),
    routerStartWorkerMessage: async () => { throw new Error('fixture still busy') },
    openThread: async () => {},
    closeThread: async () => {},
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
      send: async (threadId, _text, requestId) => {
        runtime = { threadId, turnId: 'router-turn-' + ++turnNumber }
        options.onEvent('turn/started', { threadId, turn: { id: runtime.turnId } })
        options.onEvent('item/started', { ...runtime, item: { type: 'userMessage', clientId: requestId } })
        return { turn: { id: runtime.turnId } }
      },
    }
  }
  const config = { enabled: true, projects: [{ id: 'alpha-project', name: 'Alpha', cwd }] }
  async function boot() {
    router = new RouterService({ config, stateDir, hub, bus, connect })
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
    get router() { return router }, stateDir, cwd, threads, submitted, interrupts, bus,
    get starts() { return starts }, get resumes() { return resumes },
    set policy(value) { policy = value },
    set loseReply(value) { loseReply = value },
    tool: async (tool, args, overrides = {}) => {
      const result = await hooks.onTool({ ...runtime, namespace: routerNamespace, callId: 'call-' + ++callNumber,
        tool, arguments: args, ...overrides })
      return { success: result.success, value: JSON.parse(result.contentItems[0].text) }
    },
    finish: (text = 'Router fixture') => {
      hooks.onEvent('item/completed', { ...runtime, item: { type: 'agentMessage', id: runtime.turnId, text } })
      hooks.onEvent('turn/completed', { threadId: runtime.threadId, turn: { id: runtime.turnId, status: 'completed' } })
    },
    restart: async () => { await router.close(); await boot() },
  }
}

function args(requestId, threadId = 'worker-a') {
  return { projectId: 'alpha-project', threadId, mode: 'resume', instruction: 'untrusted replacement', requestId }
}

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
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(task.id).status, 'failed')
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
