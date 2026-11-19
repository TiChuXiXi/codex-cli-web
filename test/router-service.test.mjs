import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { EventBus } from '../server/services/events.js'
import { SettingsService } from '../server/services/settings.js'
import { permissionPayload } from '../shared/worker-options.js'
import { bootstrap } from '../server/bootstrap.js'
import { loadConfig } from '../server/config.js'
import { RouterService } from '../server/router/service.js'
import { loadRouterProjects } from '../server/router/projects.js'
import { WeChatChannel } from '../server/channels/wechat/channel.js'
import { fakeClient, inbound, until } from './fixtures/wechat.mjs'
import { RouterStore } from '../server/router/store.js'
import { normalizeRouterConfig } from '../server/router/app-server.js'
import { routerNamespace } from '../server/router/tools.js'

async function fixture(t, { discover = false, resumeExistingPermissions = false, projectSandbox = 'read-only', createChannel, wakePolicy = { mergeMs: 60000, gapMs: 0 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'router-service-'))
  const cwd = join(root, 'worker')
  await mkdir(cwd)
  const bus = new EventBus()
  const stateDir = join(root, 'state')
  const threads = new Map(['worker-a','worker-b'].map((id, index) => [id, {
    thread: { id, cwd, name: index ? '同名测试乙' : '同名测试甲', status: { type: 'idle' } }, turns: [],
  }]))
  const submitted = []
  const creations = []
  const createdSettings = new Map()
  const consumed = new Set()
  bus.subscribe(event => {
    if (event.type === 'item/upsert' && event.payload?.item?.type === 'userMessage') consumed.add(event.payload.item.clientId)
  })
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
    config: {defaultModel:'worker-default',defaultEffort:'medium',defaultPermission:'inherit',defaultExecutionMode:'default'},
    models: async () => [{id:'worker-default',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],
    configureWorker: async () => {},
    routerQueueHead: async threadId => submitted.find(item => item.threadId === threadId && !consumed.has(item.clientUserMessageId) &&
      !threads.get(threadId)?.turns.some(turn => turn.items?.some(entry => entry.clientId === item.clientUserMessageId))) ?? null,
    status: () => ({ phase: 'ready', codexVersion: '0.169.1' }),
    psmThreads: async () => ({data: [], nextCursor: null}),
    projects: async () => discover ? [{ cwd, name: 'Alpha', threadCount: 2 }] : [],
    listThreads: async () => ({ data: [...threads.values()].map(value => value.thread) }),
    routerReadWorker: async id => threads.get(id) ?? { thread: null, turns: [] },
    newThread: async (params, options) => {
      assert.equal(params.cwd, cwd)
      assert.equal(params.approvalPolicy, 'on-request')
      assert.equal(options.routerWorker, true)
      creations.push({ params, options })
      if (options.workerPermission) {
        const access = permissionPayload(options.workerPermission, true)
        createdSettings.set('created-worker', { cwd, approvalPolicy: access.approvalPolicy,
          approvalsReviewer: access.approvalsReviewer, sandbox: access.sandboxPolicy })
      }
      const thread = { id: 'created-worker', cwd, name: '新会话', status: { type: 'idle' } }
      threads.set(thread.id, { thread, turns: [] })
      return thread
    },
    renameThread: async () => {},
    routerWorkerSettings: async id => createdSettings.get(id) ?? ({ cwd: threads.get(id)?.thread.cwd, approvalPolicy: policy, approvalsReviewer: 'user', sandbox }),
    routerWorkerProfile: async id => ({ ...await hub.routerWorkerSettings(id), model: 'worker-default', effort: 'medium', collaborationMode: { mode: 'default' } }),
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
    let defaultSelection = options.config.models?.[0] ?? { model: 'offline-fixture', effort: 'high' }
    let selection = defaultSelection
    return {
      cwd: routerCwd,
      get selected() { return selection },
      get defaultSelection() { return defaultSelection },
      setDefault: value => { defaultSelection = value },
      select: value => { selection = value ?? defaultSelection },
      resolveSelection: value => value?.model === 'alternate' && value.effort === 'medium' ||
        value?.model === 'offline-fixture' && value.effort === 'high' ? value : null,
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
        sent.push({ threadId, text, requestId, workerReceipt, selection })
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
  const config = { enabled: true, projects: discover ? [] : [{ id: 'alpha-project', name: 'Alpha', cwd, sandbox: projectSandbox, resumeExistingPermissions }] }
  async function boot() {
    router = new RouterService({ config, stateDir, hub, bus, connect, wakePolicy, createChannel })
    router.start()
    await router.opening
    assert.equal(router.status().phase, 'ready')
    await router.psm.sync?.running
  }
  t.after(async () => {
    await router?.close()
    bus.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await boot()
  return {
    get router() { return router }, hub, stateDir, cwd, threads, submitted, creations, interrupts, bus, retained, sent, routerHistory,
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

test('legacy dispatch options reach the chosen Worker without changing the original task or the workbench defaults', async t => {
  const fx = await fixture(t)
  const applied = []
  fx.hub.configureWorker = async (id, options) => applied.push({id, options})
  const requestId = 'legacy-options-request'
  await fx.router.send({requestId,text:'先用计划模式分析布局'})
  const instruction = '@worker ' + JSON.stringify({workerModel:'worker-default',workerEffort:'high',executionMode:'plan',workerPermission:'read'})
  const task = await fx.tool('dispatch_task',{...args(requestId),instruction})
  assert.equal(task.success,true)
  await fx.router.dispatcher.sweep()
  assert.deepEqual(applied[0], {id:'worker-a',options:{model:'worker-default',effort:'high',executionMode:'plan',permission:'read'}})
  assert.equal(fx.submitted[0].text,'先用计划模式分析布局')
  assert.equal(fx.hub.config.defaultExecutionMode,'default')
  assert.equal(fx.hub.config.defaultEffort,'medium')
})

test('a requested permission outside the project grant waits for the user and invalid Worker options never dispatch', async t => {
  const fx = await fixture(t)
  const requestId = 'explicit-worker-permission'
  await fx.router.send({requestId,text:'使用完全访问模式处理任务'})
  assert.equal((await fx.tool('dispatch_task',{...args(requestId),workerModel:'unlisted'})).success,false)
  assert.equal((await fx.tool('dispatch_task',{...args(requestId),workerEffort:'unknown'})).success,false)
  assert.equal((await fx.tool('dispatch_task',{...args(requestId),instruction:'@worker {"threadId":"foreign"}'})).success,false)
  const result = await fx.tool('dispatch_task',{...args(requestId),workerPermission:'full'})
  assert.equal(result.value.status,'needs_confirmation')
  assert.equal(fx.router.read().tasks.length,0)
  const [question] = fx.router.read().clarifications
  assert.equal(question.kind,'workerPermission')
  await fx.router.confirm(question,true)
  assert.equal(fx.submitted.length,0)
})

test('saved Worker permission applies to creation and new dispatch, including an explicit read-only override', async t => {
  const fx = await fixture(t, { projectSandbox: 'workspace-write' })
  const settings = new SettingsService({ config: { codex: fx.hub.config, stateDir: fx.stateDir }, firewall: {} })
  await settings.saveWorkerDefaults({ ...settings.workerDefaults(), defaultPermission: 'ask' }, fx.hub)
  await fx.router.send({ requestId: 'saved-worker-create', text: '创建工作会话' })
  const created = await fx.tool('create_session', { projectId: 'alpha-project' })
  assert.equal(created.value.status, 'created')
  assert.equal(fx.creations[0].options.workerPermission, 'ask')
  assert.equal((await fx.hub.routerWorkerSettings(created.value.threadId)).sandbox.type, 'workspaceWrite')
  fx.finish()

  for (const [requestId, override] of [['saved-worker-dispatch', undefined], ['readonly-worker-dispatch', 'read']]) {
    await fx.router.send({ requestId, text: '新建 Worker 并执行任务' })
    const result = await fx.tool('dispatch_task', {
      projectId: 'alpha-project', mode: 'new', instruction: '执行', requestId,
      ...(override && { workerPermission: override }),
    })
    await until(() => fx.submitted.some(row => row.clientUserMessageId === result.value.id))
    assert.equal(fx.creations.at(-1).options.workerPermission, override ?? 'ask')
    const effective = await fx.hub.routerWorkerSettings('created-worker')
    assert.equal(effective.sandbox.type, override ? 'readOnly' : 'workspaceWrite')
    fx.finish()
    // Mark the fixture's native queue entry as consumed before the next new dispatch.
    fx.bus.publish('item/upsert', { item: { type: 'userMessage', clientId: result.value.id } })
  }
})

test('Router refuses to enqueue a new Worker if Codex reports a different sandbox', async t => {
  const fx = await fixture(t, { projectSandbox: 'workspace-write' })
  fx.hub.config.defaultPermission = 'read'
  fx.hub.routerWorkerSettings = async () => ({
    cwd: fx.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandbox: permissionPayload('ask', true).sandboxPolicy,
  })
  const requestId = 'worker-sandbox-mismatch'
  await fx.router.send({ requestId, text: '新建只读 Worker' })
  const result = await fx.tool('dispatch_task', { projectId: 'alpha-project', mode: 'new', instruction: '执行', requestId })
  await until(() => fx.router.getTask(result.value.id).status === 'failed')
  assert.match(fx.router.getTask(result.value.id).error, /未应用指定权限/)
  assert.equal(fx.submitted.length, 0)
})

test('a saved write default requires project permission confirmation instead of creating a read-only Worker', async t => {
  const fx = await fixture(t)
  fx.hub.config.defaultPermission = 'ask'
  await fx.router.send({ requestId: 'worker-default-approval', text: '创建工作会话' })
  const requested = await fx.tool('create_session', { projectId: 'alpha-project' })
  assert.equal(requested.value.status, 'needs_confirmation')
  assert.equal(fx.creations.length, 0)
  const [question] = fx.router.read().clarifications
  assert.equal(question.kind, 'workerPermission')
  const result = await fx.router.confirm({ id: question.id, revision: question.revision, candidateId: 'allow' })
  assert.equal(result.status, 'created')
  assert.equal(fx.creations[0].options.workerPermission, 'ask')
})

test('first-run directory setup can be deferred and resumes the original new project request after restart', async t => {
  const fx = await fixture(t)
  assert.equal(fx.router.status().promptProjectRoot, true)
  assert.equal(fx.router.settings().projectRoot, '')
  await fx.router.saveSettings({ model: { model: 'alternate', effort: 'medium' }, projectRoot: '', revision: 0 })
  await fx.router.setupProjectRoot({ defer: true })
  await fx.restart()
  assert.equal(fx.router.status().promptProjectRoot, false)
  await fx.router.send({ requestId: 'deferred-project-1', text: '创建示例项目' })
  assert.equal((await fx.tool('list_projects', {})).success, true)
  assert.equal(fx.router.read().clarifications.length, 0)
  const create = () => fx.tool('create_session', { projectId: 'new:示例' })
  const first = await create()
  assert.equal(first.value.status, 'needs_confirmation')
  assert.equal((await create()).value.id, first.value.id)
  fx.finish()
  await fx.restart()
  const [question] = fx.router.read().clarifications
  assert.equal(question.kind, 'projectRoot')
  await assert.rejects(fx.router.setupProjectRoot({ projectRoot: 'relative' }), /绝对/)
  assert.equal(fx.router.read().clarifications.length, 1)
  let creates = 0
  fx.hub.newThread = async ({ cwd }) => ({ id: 'thread-' + ++creates, cwd })
  const root = join(fx.cwd, 'chosen')
  await fx.router.setupProjectRoot({ projectRoot: root })
  await fx.router.setupProjectRoot({ projectRoot: root })
  for (let i = 0; i < 100 && !fx.router.read().messages.some(m => m.id === 'root-result:' + question.id); i++) await delay(10)
  assert.equal(creates, 1)
  assert.equal(fx.router.read().tasks[0].cwd, join(root, '示例'))
  assert.equal(fx.router.read().clarifications.length, 0)
  await fx.restart()
  assert.equal(fx.router.status().promptProjectRoot, false)
  assert.equal(fx.router.settings().projectRoot, root)
  assert.equal(fx.router.settings().model.model, 'alternate')
  await assert.rejects(fx.router.setupProjectRoot({ projectRoot: fx.cwd }), /已设置/)
})

test('saving a root in settings continues queued project work once and respects cancelled requests', async t => {
  const fx = await fixture(t)
  await fx.router.send({ requestId: 'cancel-before-setup', text: '创建旧项目' })
  await fx.tool('create_session', { projectId: 'new:旧项目' })
  const [cancel] = fx.router.read().clarifications
  await fx.router.confirm(cancel, true)
  assert.equal((await fx.tool('create_session', { projectId: 'new:旧项目' })).value.status, 'cancelled')
  fx.finish()
  const text = '创建新项目并检查界面'
  const requestId = 'dispatch-after-setup'
  await fx.router.send({ requestId, text })
  await fx.tool('dispatch_task', { projectId: 'new:新项目', instruction: text, mode: 'new', requestId })
  fx.finish()
  fx.hub.newThread = async ({ cwd }) => {
    const thread = { id: 'new-project-worker', cwd, status: { type: 'idle' } }
    fx.threads.set(thread.id, { thread, turns: [] })
    return thread
  }
  const root = join(fx.cwd, 'chosen')
  await fx.router.saveSettings({ model: fx.router.settings().model, projectRoot: root, revision: 0 })
  for (let i = 0; i < 100 && !fx.submitted.length; i++) await delay(10)
  assert.equal(fx.submitted.length, 1)
  assert.equal(fx.submitted[0].threadId, 'new-project-worker')
  assert.ok(fx.submitted[0].text.endsWith(text))
  assert.equal(fx.router.read().tasks.length, 1)
  assert.equal(fx.router.read().tasks[0].cwd, join(root, '新项目'))
  assert.equal(fx.router.read().clarifications.length, 0)
})

test('saved Router defaults and newly provisioned projects survive restart, collisions preserve existing directories', async t => {
  const fx = await fixture(t)
  const root = join(fx.cwd, 'projects')
  const model = { model: 'alternate', effort: 'medium' }
  const saved = await fx.router.saveSettings({ model, projectRoot: root, revision: 0 })
  assert.deepEqual(fx.router.read().model, 'alternate')
  await assert.rejects(fx.router.saveSettings({ model, projectRoot: root, revision: 0 }), /重新加载/)
  fx.router.setModel({ model: 'offline-fixture', effort: 'high' })
  await fx.router.saveSettings({ model, projectRoot: root, revision: saved.revision })
  assert.equal(fx.router.read().model, 'offline-fixture')
  fx.hub.newThread = async ({ cwd }) => ({ id: 'provisioned-thread', cwd })
  await fx.router.send({ requestId: 'new-project-example', text: '新建项目 示例' })
  const created = await fx.tool('create_session', { projectId: 'new:示例' })
  assert.equal(created.success, true)
  const project = fx.router.projects.get(created.value.projectId)
  assert.equal(project.cwd, join(root, '示例'))
  assert.equal(created.value.cwd, project.cwd)
  assert.equal((await fx.tool('create_session', { projectId: 'new:示例' })).value.threadId, 'provisioned-thread')
  fx.finish()
  await fx.restart()
  assert.equal(fx.router.settings().projectRoot, root)
  assert.equal(fx.router.projects.get(project.id).cwd, project.cwd)
  assert.ok(fx.router.includeNewProjects([]).some(row => row.cwd === project.cwd))
  await assert.rejects(fx.router.openNewProject({ requestId: 'another-create-1', name: '示例' }), /已存在/)
  await assert.rejects(fx.router.openNewProject({ requestId: 'another-create-2', name: '../outside' }), /单个目录名/)
  await assert.rejects(fx.router.openNewProject({ requestId: 'another-create-3', repository: 'file:///etc' }), /HTTPS/)
  fx.hub.config.defaultPermission = 'ask'
  const waiting = await fx.router.openNewProject({ requestId: 'another-create-4', name: '需要授权的新项目' })
  assert.deepEqual(waiting, { cwd: join(root, '需要授权的新项目'), status: 'needs_confirmation' })
  assert.equal(fx.router.read().clarifications.at(-1).kind, 'workerPermission')
})

test('Router model changes during a turn persist across resume and default reset', async t => {
  const fx = await fixture(t)
  await fx.router.send({ requestId: 'model-before-change', text: 'hello' })
  const alternate = { model: 'alternate', effort: 'medium' }
  fx.router.setModel(alternate)
  assert.deepEqual(fx.sent.at(-1).selection, { model: 'offline-fixture', effort: 'high' })
  fx.finish()
  await fx.restart()
  assert.equal(fx.router.read().usingDefaultModel, false)
  await fx.router.send({ requestId: 'model-after-change', text: 'hello again' })
  assert.deepEqual(fx.sent.at(-1).selection, alternate)
  assert.throws(() => fx.router.setModel({ ...alternate, effort: 'invalid' }), /不可用/)
  fx.router.setModel({ model: null, effort: null })
  fx.finish()
  await fx.restart()
  assert.equal(fx.router.read().usingDefaultModel, true)
  assert.equal(fx.router.read().effort, 'high')
})

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

test('Router persists the turn phase and tool activity exposed in chat', async t => {
  const fx = await fixture(t)
  await fx.router.send({ requestId: 'process-chat-0001', text: '查看会话过程' })
  const routerThreadId = fx.router.read().primaryThreadId
  const turnId = fx.router.read().activeTurnId
  const scope = { threadId: routerThreadId, turnId }
  const item = { type: 'agentMessage', id: 'progress-item', phase: 'commentary' }
  fx.router.onEvent('item/started', { ...scope, item })
  fx.router.onEvent('item/agentMessage/delta', { ...scope, itemId: item.id, delta: '正在读取' })
  assert.equal(fx.router.read().messages.at(-1).phase, 'commentary')
  assert.equal(fx.router.read().messages.at(-1).text, '正在读取')
  fx.router.onEvent('item/completed', { ...scope, item: { ...item, text: '正在读取会话列表' } })
  const pending = fx.tool('list_sessions', { query: 'private-search-fixture' })
  assert.deepEqual(fx.router.read().messages.at(-1).tool, { name: 'list_sessions', status: 'running' })
  assert.ok((await pending).success)
  fx.finish('读取完成')
  const finished = fx.router.read()
  assert.equal(finished.activeTurnId, undefined)
  assert.ok(Number.isFinite(finished.messages[0].durationMs))
  assert.deepEqual(finished.messages.map(({ turnId, phase, text, tool }) => [turnId, phase, text, tool]), [
    [turnId, undefined, '查看会话过程', undefined],
    [turnId, 'commentary', '正在读取会话列表', undefined],
    [turnId, undefined, '', { name: 'list_sessions', status: 'completed', outcome: { success: true } }],
    [turnId, undefined, '读取完成', undefined],
  ])
  await fx.restart()
  assert.deepEqual(fx.router.read().messages, finished.messages)
})

test('legacy Router messages recover native commentary and tool order without exposing arguments', async t => {
  const fx = await fixture(t)
  const threadId = fx.router.read().primaryThreadId
  const turnId = 'legacy-router-turn'
  fx.routerHistory.unshift({ id: turnId, status: 'completed', durationMs: 1200, items: [
    { type: 'agentMessage', id: 'old-progress', phase: 'commentary', text: '历史过程' },
    { type: 'dynamicToolCall', id: 'old-call', namespace: routerNamespace,
      tool: 'list_sessions', status: 'completed', success: true, arguments: { query: 'private-fixture-query' } },
    { type: 'agentMessage', id: 'old-final', phase: 'final_answer', text: '历史最终回答' },
  ] })
  for (const [id, text] of [['old-progress', '历史过程'], ['old-final', '历史最终回答']]) {
    fx.router.store.put('message', 'agent:' + id, { id: 'agent:' + id, role: 'assistant', text, status: 'completed', routerThreadId: threadId })
  }
  await fx.restart()
  const { messages } = fx.router.read()
  assert.deepEqual(messages.map(({ turnId, text, phase, tool }) => [turnId, text, phase, tool?.name]), [
    [turnId, '历史过程', 'commentary', undefined],
    [turnId, '', undefined, 'list_sessions'],
    [turnId, '历史最终回答', 'final_answer', undefined],
  ])
  assert.equal(messages[2].durationMs, 1200)
  assert.doesNotMatch(JSON.stringify(messages), /private-fixture-query/)
  await fx.restart()
  assert.deepEqual(fx.router.read().messages, messages)
})

test('first use of a discovered project authorizes the named Worker in one choice', async t => {
  const fx = await fixture(t, { discover: true })
  fx.policy = 'never'
  fx.sandbox = { type: 'dangerFullAccess' }
  const requestId = 'discovered-full-worker'
  await fx.router.send({ requestId, text: '把验收发给 Alpha 的 worker-b' })
  const [project] = (await fx.tool('list_projects', {})).value
  await fx.tool('dispatch_task', { ...args(requestId, 'worker-b'), projectId: project.id })
  const [card] = fx.router.read().clarifications
  assert.match(card.candidates[0].name, /Alpha.*同名测试乙/)
  assert.match(card.candidates[0].summary, /完全访问，免审批/)
  assert.equal(fx.submitted.length, 0)
  const task = await fx.router.confirm({ id: card.id, revision: card.revision, candidateId: project.id })
  await fx.router.dispatcher.sweep()
  assert.equal(task.threadId, 'worker-b')
  assert.deepEqual(fx.router.read().clarifications, [])
  assert.equal(fx.submitted.length, 1)
  assert.equal(fx.router.store.get('worker-grant', 'worker-a'), null)
})

test('Router preserves original instructions and confirmation across restart, then uses selected Worker once', async t => {
  const fx = await fixture(t)
  const requestId = 'uncertain-0001'
  const text = '请派发给 Alpha 的同名测试，核对原始变更。'
  await fx.router.send({ requestId, text })
  const first = await fx.tool('dispatch_task', { requestId, instruction: text, mode: 'resume',
    candidateThreadIds: ['worker-a', 'worker-b'], reason: '是测试甲还是测试乙？' })
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

test('semantic evidence resumes the preauthorized full-access Worker with no confirmation or overrides', async t => {
  const fx = await fixture(t, { resumeExistingPermissions: true })
  const worker = fx.threads.get('worker-b')
  worker.thread.preview = '储位看板验收'
  worker.turns.push({ startedAt: 100, items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'Qt 离线储位颜色显示' }] },
    { type: 'agentMessage', text: '保留灰色状态，待确认文案' },
  ] })
  fx.policy = 'never'
  fx.sandbox = { type: 'dangerFullAccess' }
  const requestId = 'semantic-existing-task'
  const text = '昨天那个储位状态显示，再检查一次离线文案。'
  await fx.router.send({ requestId, text })
  assert.equal((await fx.tool('list_sessions', { query: '储位' })).value[0].id, 'worker-b')
  const session = (await fx.tool('get_session', { threadId: 'worker-b' })).value
  assert.match(session.recent[0].user, /Qt 离线储位/)
  assert.match(session.recent[0].reply, /灰色/)
  const result = await fx.tool('dispatch_task', args(requestId, session.id))
  assert.equal(result.value.status, 'queued')
  assert.deepEqual(fx.router.read().clarifications, [])
  await fx.router.dispatcher.sweep()
  assert.deepEqual(fx.submitted.map(row => [row.threadId, row.text]), [['worker-b', text]])
  assert.equal(fx.threads.size, 2)
})

test('one conversational choice across projects resumes the selected thread with the original instruction', async t => {
  const fx = await fixture(t)
  const otherCwd = join(fx.cwd, '..', 'handset')
  await mkdir(otherCwd)
  const other = await loadRouterProjects([{ id: 'handset', name: '手持终端', cwd: otherCwd }], fx.router.directory)
  fx.router.projects.set('handset', other.get('handset'))
  fx.threads.get('worker-b').thread.cwd = otherCwd
  const text = '接着改上次的 Qt 储位列表。'
  const requestId = 'two-projects-ambiguous'
  await fx.router.send({ requestId, text })
  const offered = await fx.tool('dispatch_task', { requestId, mode: 'resume', instruction: text,
    reason: '想改看板还是手持终端？', candidateThreadIds: ['worker-a', 'worker-b'] })
  assert.equal(offered.value.status, 'needs_confirmation')
  const [pending] = fx.router.read().clarifications
  assert.equal(pending.label, '想改看板还是手持终端？')
  assert.deepEqual(pending.candidates.map(row => row.project), ['Alpha', '手持终端'])
  assert.equal(fx.submitted.length, 0)
  fx.finish()
  await fx.router.send({ requestId: 'reply-choose-handset', text: '手持终端那个' })
  const choice = { ...args(requestId, 'worker-b'), projectId: 'handset' }
  const result = await fx.tool('dispatch_task', choice)
  assert.equal(result.value.status, 'queued')
  assert.equal((await fx.tool('dispatch_task', choice)).value.id, result.value.id)
  assert.deepEqual(fx.router.read().clarifications, [])
  assert.equal((await fx.tool('dispatch_task', args('reply-choose-handset'))).success, false)
  await fx.router.dispatcher.sweep()
  assert.deepEqual(fx.submitted.map(row => [row.threadId, row.text]), [['worker-b', text]])
})

test('a single explicit Worker grant survives restart and is restricted to the selected configuration', async t => {
  const fx = await fixture(t)
  fx.policy = 'never'
  fx.sandbox = { type: 'dangerFullAccess' }
  const requestId = 'grant-worker-first'
  await fx.router.send({ requestId, text: '继续储位验收' })
  const first = await fx.tool('dispatch_task', args(requestId))
  assert.equal(first.value.status, 'needs_confirmation')
  const [grant] = fx.router.read().clarifications
  assert.match(grant.candidates[0].summary, /完全访问，免审批/)
  assert.equal(fx.submitted.length, 0)
  const result = await fx.router.confirm({ id: grant.id, revision: grant.revision, candidateId: 'worker-a' })
  fx.finish()
  await fx.router.dispatcher.sweep()
  assert.equal(fx.submitted.length, 1)
  fx.threads.get('worker-a').turns.push({ id: 'worker-finished', status: 'completed',
    items: [{ type: 'userMessage', clientId: result.id }] })
  await fx.router.dispatcher.sweep()
  await fx.restart()
  await fx.router.send({ requestId: 'grant-worker-second', text: '继续核对离线文案' })
  assert.equal((await fx.tool('dispatch_task', args('grant-worker-second'))).value.status, 'queued')
  assert.deepEqual(fx.router.read().clarifications, [])
  await fx.router.dispatcher.sweep()
  assert.equal(fx.submitted.length, 2)
  fx.finish()
  fx.policy = 'on-request'
  await fx.router.send({ requestId: 'grant-worker-changed', text: '再核对一次' })
  assert.equal((await fx.tool('dispatch_task', args('grant-worker-changed'))).value.status, 'needs_confirmation')
  assert.equal(fx.submitted.length, 2)
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

function installWorkerSettingsFixture(fx) {
  const settings = { cwd: fx.cwd, model: 'worker-default', effort: 'medium', collaborationMode: { mode: 'plan' },
    approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } }
  const changes = []
  fx.hub.routerWorkerProfile = async () => structuredClone(settings)
  fx.hub.configureWorker = async (threadId, worker) => {
    changes.push({ threadId, ...worker })
    Object.assign(settings, { model: worker.model, effort: worker.effort, collaborationMode: { mode: worker.executionMode } })
    if (worker.permission) {
      const { sandboxPolicy, approvalPolicy, approvalsReviewer } = permissionPayload(worker.permission, true)
      Object.assign(settings, { sandbox: sandboxPolicy, approvalPolicy, approvalsReviewer })
    }
  }
  return { changes, settings }
}

test('Router reads the current Worker settings and applies a confirmed edit when the active turn ends', async t => {
  const fx = await fixture(t)
  const { settings, changes } = installWorkerSettingsFixture(fx)
  const target = fx.threads.get('worker-a')
  target.thread.status = { type: 'active' }
  const turn = { id: 'active-settings-turn', status: 'inProgress', items: [] }
  target.turns.push(turn)
  const requestId = 'settings-only-request'
  await fx.router.send({ requestId, text: '这个会话的思考强度改成 high' })
  const read = await fx.tool('get_session', { threadId: 'worker-a' })
  assert.equal(read.value.activeTurnId, turn.id)
  assert.deepEqual(read.value.settings, { model: 'worker-default', effort: 'medium', executionMode: 'plan',
    sandbox: 'readOnly', permission: '只读，按需审批', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  const proposal = await fx.tool('dispatch_task', { ...args(requestId), workerAction: 'settings', workerEffort: 'high' })
  assert.equal(proposal.value.status, 'needs_confirmation')
  const [card] = fx.router.read().clarifications
  assert.match(card.candidates[0].summary, /medium.*high/)
  const job = await fx.router.confirm({ ...card, candidateId: 'allow' })
  await fx.router.dispatcher.sweep()
  assert.deepEqual(changes, [])
  assert.equal(fx.router.getTask(job.id).status, 'queued')
  turn.status = 'completed'
  target.thread.status = { type: 'idle' }
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.getTask(job.id).status, 'completed')
  assert.deepEqual(changes, [{ threadId: 'worker-a', model: 'worker-default', effort: 'high', executionMode: 'plan' }])
  assert.equal(settings.sandbox.type, 'readOnly')
  assert.deepEqual(fx.interrupts, [])
  assert.deepEqual(fx.submitted, [])
})

test('an approved restart interrupts the exact Router-dispatched Worker turn, then continues it once with the new settings', async t => {
  const fx = await fixture(t)
  const original = await dispatch(fx, 'restart-active-original')
  const { changes } = installWorkerSettingsFixture(fx)
  const target = fx.threads.get('worker-a')
  const item = { type: 'userMessage', clientId: original.id }
  const turn = { id: 'original-worker-turn', status: 'inProgress', items: [item] }
  target.turns.push(turn)
  target.thread.status = { type: 'active' }
  fx.bus.publish('item/upsert', { item }, { threadId: 'worker-a', turnId: turn.id })
  assert.equal(fx.router.getTask(original.id).status, 'running')
  const requestId = 'restart-worker-request'
  await fx.router.send({ requestId, text: '改成需要审批和 high，停下并继续' })
  const restart = { workerAction: 'restart', expectedTurnId: turn.id, workerPermission: 'ask', workerEffort: 'high' }
  const proposal = await fx.tool('dispatch_task', { ...args(requestId), instruction: '@worker ' + JSON.stringify(restart) })
  assert.equal(proposal.value.status, 'needs_confirmation')
  assert.deepEqual(fx.interrupts, [])
  const [card] = fx.router.read().clarifications
  const job = await fx.router.confirm({ ...card, candidateId: 'allow' })
  await fx.router.dispatcher.sweep()
  assert.deepEqual(fx.interrupts, [{ threadId: 'worker-a', turnId: turn.id }])
  assert.deepEqual(changes, [])
  assert.equal(fx.submitted.length, 1)
  fx.finish()
  await fx.restart()
  await fx.router.dispatcher.sweep()
  assert.equal(fx.interrupts.length, 1)
  turn.status = 'interrupted'
  target.thread.status = { type: 'idle' }
  fx.bus.publish('turn/completed', { turn }, { threadId: 'worker-a', turnId: turn.id })
  await fx.router.dispatcher.sweep()
  assert.deepEqual(changes, [{ threadId: 'worker-a', model: 'worker-default', effort: 'high', executionMode: 'plan', permission: 'ask' }])
  assert.equal(fx.submitted[1].clientUserMessageId, job.id)
  assert.equal(fx.submitted[1].threadId, 'worker-a')
  assert.match(fx.submitted[1].text, /继续本会话刚才中断的原任务/)
  await fx.router.confirm({ ...card, candidateId: 'allow' })
  await fx.router.dispatcher.sweep()
  assert.equal(fx.submitted.length, 2)
  assert.equal(fx.interrupts.length, 1)
})

test('restart rejects a stale confirmation without interrupting a replacement Worker turn', async t => {
  const fx = await fixture(t)
  installWorkerSettingsFixture(fx)
  const target = fx.threads.get('worker-a')
  const original = { id: 'stale-worker-original', status: 'inProgress' }
  target.turns.push(original)
  const requestId = 'stale-worker-restart'
  await fx.router.send({ requestId, text: '修改权限并继续原任务' })
  const proposal = await fx.tool('dispatch_task', { ...args(requestId), workerAction: 'restart',
    expectedTurnId: original.id, workerPermission: 'ask' })
  assert.equal(proposal.value.status, 'needs_confirmation')
  const [card] = fx.router.read().clarifications
  original.status = 'completed'
  target.turns.push({ id: 'replacement-turn', status: 'inProgress' })
  await assert.rejects(fx.router.confirm({ ...card, candidateId: 'allow' }), /回合已变化/)
  assert.deepEqual(fx.interrupts, [])
  assert.deepEqual(fx.submitted, [])
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
  for (const operation of ['status','bind','pin','disconnect','unbind','resume','preferences']) {
    assert.equal((await rpc('wechat/' + operation, {})).status,401)
  }
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
  await fx.router.dispatcher.sweep()
  assert.equal(fx.router.read().messages.find(m => m.id === 'worker-result:' + first.id).text, '关联 Worker 的最终答复')

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

test('parallel native requests resolve only for their live instance, dispatch and worker turn', async t => {
  const fx = await fixture(t)
  const [a,b] = [await dispatch(fx, 'interaction-test-1'), await dispatch(fx, 'interaction-test-2', 'worker-b')]
  const requests = new Map()
  for (const [task, method] of [[a, 'item/commandExecution/requestApproval'], [b, 'item/tool/requestUserInput']]) {
    const params = { threadId: task.threadId, turnId: 'turn-' + task.id }
    fx.bus.publish('item/upsert', { item: { type: 'userMessage', clientId: task.id } }, params)
    requests.set(task.id, { requestId: task.id, instanceId: 'live-' + task.id, method, params })
  }
  requests.set('unrelated', { requestId: 3, instanceId: 'unrelated', params: { threadId: a.threadId, turnId: 'other' } })
  fx.hub.pendingApprovals = () => [...requests.values()]
  fx.hub.respondApproval = (id, response) => { assert.ok(requests.delete(id)); return { id, response } }
  const cards = fx.router.read().interactions
  assert.equal(cards.length, 2)
  const input = cards.find(card => card.dispatchId === b.id)
  const payload = { dispatchId: b.id, instanceId: input.instanceId, response: { answers: { color: { answers: ['靛蓝'] } } } }
  assert.throws(() => fx.router.respond({ ...payload, dispatchId: a.id }), /已失效/)
  assert.deepEqual(fx.router.respond(payload), { id: b.id, response: payload.response })
  requests.set(b.id, { ...input, instanceId: 'replacement' })
  assert.throws(() => fx.router.respond(payload), /已失效/)
  assert.ok(requests.has(a.id))
  const child = { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-a', agentPath: '/root/test' }
  fx.bus.publish('item/upsert', { item: child, completed: true }, { threadId: a.threadId, turnId: 'turn-' + a.id })
  requests.set(4, { requestId: 4, instanceId: 'child-request', params: { threadId: 'child-a', turnId: 'child-turn' } })
  assert.equal(fx.router.read().interactions.find(card => card.requestId === 4).dispatchId, a.id)
  assert.throws(() => fx.router.respond({ dispatchId: b.id, instanceId: 'child-request', response: {} }), /失效/)
  assert.deepEqual(fx.router.respond({ dispatchId: a.id, instanceId: 'child-request', response: { decision: 'decline' } }),
    { id: 4, response: { decision: 'decline' } })
})

test('structured Worker questions steer their live turn or queue exactly one follow-up in the original thread', async t => {
  const fx = await fixture(t)
  const a = await dispatch(fx, 'structured-live-1')
  const b = await dispatch(fx, 'structured-done-2', 'worker-b')
  for (const task of [a,b]) {
    const item = { id: 'question', type: 'agentMessage', questions: [{ title: '颜色', options: ['松绿', '靛蓝'] }] }
    const turn = { id: 'turn-' + task.id, items: [{ type: 'userMessage', clientId: task.id }, item],
      status: task.id === a.id ? 'inProgress' : 'completed' }
    fx.threads.get(task.threadId).turns = [turn]
    await fx.router.dispatcher.reconcile(fx.router.dispatcher.get(task.id))
  }
  await fx.restart()
  const replies = []
  fx.hub.steerTurn = async body => { replies.push(body) }
  for (const task of [a,b]) {
    const q = fx.router.read().messages.find(m => m.questions && m.id.includes(task.id))
    await fx.router.answerQuestion({ id: q.id, text: '靛蓝' })
    await assert.rejects(fx.router.answerQuestion({ id: q.id, text: '松绿' }), /失效/)
  }
  assert.deepEqual(replies, [{ threadId: a.threadId, turnId: 'turn-' + a.id, text: '靛蓝' }])
  assert.equal(fx.router.dispatcher.list().filter(task => task.instruction === '靛蓝' && task.threadId === b.threadId).length, 1)
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
  assert.equal((await fx.router.send({ requestId: 'receipt-busy-after-01', text: '另一个用户问题' })).status, 'queued')
  fx.nativeStatus = 'idle'
  await fx.router.wake.run()
  assert.equal(fx.sent.at(-1).requestId, 'receipt-busy-after-01')
  fx.finish()
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
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 3)
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

test('Web and WeChat share a durable FIFO and owner-only replies across restart with no browser', async t => {
  const client = fakeClient()
  const fx = await fixture(t,{createChannel: router => new WeChatChannel(router,client)})
  let channel = fx.router.wechat
  channel.bind()
  await until(() => channel.account)
  await fx.router.send({requestId:'web-private-turn',text:'private Web conversation'})
  channel.accept({msgs:[inbound('1','hello from phone')],get_updates_buf:'cursor'})
  await until(() => fx.router.read().messages.some(m => m.text==='hello from phone' && m.status==='queued'))
  await fx.router.send({requestId:'web-queued-turn',text:'next Web message'})
  assert.deepEqual(fx.sent.map(s => s.text),['private Web conversation'])
  await fx.restart()
  channel = fx.router.wechat
  fx.finish('private Web answer')
  await until(() => fx.sent.length === 2)
  assert.equal(fx.sent[1].text,'hello from phone')
  const scope = { threadId: fx.router.read().primaryThreadId, turnId: fx.router.read().activeTurnId }
  fx.router.onEvent('item/completed', { ...scope, item: { id: 'wechat-progress', type: 'agentMessage',
    phase: 'commentary', text: 'private progress retained in Web' } })
  assert.ok((await fx.tool('list_projects', {})).success)
  fx.finish('phone answer')
  await until(() => fx.sent.length === 3)
  fx.finish('another private Web answer')
  await until(() => client.sent.length === 1)
  assert.deepEqual(client.sent.map(m => [m.text,m.context]),[['phone answer','context-1']])
  assert.equal(new Set(fx.sent.map(s => s.threadId)).size,1)
  assert.equal(channel.account.cursor,'cursor')
  assert.ok(fx.router.read().messages.some(m => m.label==='你 · 微信'))
  channel.accept({msgs:[inbound('1','hello from phone')],get_updates_buf:'cursor2'})
  assert.equal(channel.store.wxRows('in').length,1)
})

test('WeChat sends no Router reply if a legacy turn ends after progress and a tool without final text', async t => {
  const client = fakeClient()
  const fx = await fixture(t, { createChannel: router => new WeChatChannel(router, client) })
  const channel = fx.router.wechat
  channel.bind()
  await until(() => channel.account)
  channel.accept({ msgs: [inbound('process-only', '只出现过程的回合')] })
  await until(() => fx.router.active?.turnId)
  const scope = { threadId: fx.router.read().primaryThreadId, turnId: fx.router.read().activeTurnId }
  fx.router.onEvent('item/completed', { ...scope, item: { id: 'legacy-progress', type: 'agentMessage', text: '此文本是过程' } })
  assert.ok((await fx.tool('list_projects', {})).success)
  fx.router.onEvent('turn/completed', { threadId: scope.threadId, turn: { id: scope.turnId, status: 'completed' } })
  assert.equal(channel.store.wxRows('out').some(row => row.id.startsWith('reply:')), false)
  assert.equal(client.sent.length, 0)
  assert.ok(fx.router.read().messages.some(row => row.text === '此文本是过程'))
})

test('a Web-dispatched Worker sends one committed Router receipt; a phone follow-up carries its dispatch reference', async t => {
  const client = fakeClient()
  const fx = await fixture(t, {createChannel: router => new WeChatChannel(router,client)})
  const channel = fx.router.wechat
  channel.bind()
  await until(() => channel.account)
  channel.accept({msgs:[inbound('init','你好')]})
  await until(() => fx.router.active?.text === '你好')
  fx.finish('你好！')
  await until(() => client.sent.length === 1)
  const task = await dispatch(fx,'web-dispatched-worker')
  const repeat = completeWorker(fx,task)
  repeat()
  fx.wakeBehavior = 'ended-before-ack'
  await fx.router.wake.run()
  await until(() => client.sent.length === 2)
  assert.match(client.sent[1].text,/提前完成的回执/)
  assert.doesNotMatch(client.sent[1].text,/关联 Worker 的最终答复/)
  channel.accept({msgs:[inbound('next','刚才那个任务再检查一下')]})
  await until(() => fx.router.active?.text === '刚才那个任务再检查一下')
  assert.deepEqual(fx.router.active.origin.relatedTasks,[task.id])
  assert.equal(fx.router.getTask(task.id).receiptStatus,'delivered')
})

test('a phone clarification is delivered once and its original instruction reaches only the chosen Worker', async t => {
  const client = fakeClient()
  const fx = await fixture(t, {createChannel: router => new WeChatChannel(router,client)})
  const channel = fx.router.wechat
  channel.bind()
  await until(() => channel.account)
  channel.accept({msgs:[inbound('choose','帮我继续 Alpha 的同名测试任务')]})
  await until(() => fx.router.active?.origin)
  const source = fx.router.active
  const call = await fx.tool('dispatch_task', {requestId:source.requestId,instruction:source.text,mode:'resume',
    candidateThreadIds:['worker-a','worker-b'],reason:'请选择同名会话'})
  assert.equal(call.value.status,'needs_confirmation')
  fx.finish('选中后将继续。')
  await until(() => client.sent.length === 1)
  assert.match(client.sent[0].text,/选中后将继续。.*同名测试甲/s)
  channel.accept({msgs:[inbound('selected','1')]})
  await until(() => fx.submitted.length === 1)
  assert.equal(fx.submitted[0].threadId,'worker-a')
  assert.equal(fx.submitted[0].text,source.text)
  assert.equal(fx.sent.length,1)
})

test('a phone approval answers the original child Worker while the shared Router is busy', async t => {
  const client = fakeClient()
  const fx = await fixture(t, {createChannel: router => new WeChatChannel(router,client)})
  const channel = fx.router.wechat
  channel.bind()
  await until(() => channel.account)
  const task = await dispatch(fx,'wechat-child-dispatch')
  const scope = { threadId:task.threadId, turnId:'turn-' + task.id }
  fx.bus.publish('item/upsert',{item:{type:'userMessage',clientId:task.id}},scope)
  fx.bus.publish('item/upsert',{item:{type:'subAgentActivity',kind:'started',agentThreadId:'child',agentPath:'/root/check'},completed:true},scope)
  const params = {threadId:'child',turnId:'child-turn',command:'npm run build',cwd:fx.cwd}
  const request = {requestId:14,instanceId:'original-child',method:'item/commandExecution/requestApproval',params}
  let choice
  fx.hub.pendingApprovals = () => choice ? [] : [request]
  fx.hub.respondApproval = (id,response,instanceId) => {
    assert.equal(id,14)
    assert.equal(instanceId,request.instanceId)
    choice = response
    fx.bus.publish('approval/resolved',{requestId:id},params)
  }
  await fx.router.send({requestId:'busy-web-request',text:'另一个 Web 任务'})
  fx.bus.publish('approval/requested',request,params)
  channel.accept({msgs:[inbound('first','稍后处理这项新任务')]})
  await until(() => client.sent.some(m => m.text.includes('npm run build')))
  assert.equal(fx.router.read().interactions[0].dispatchId,task.id)
  channel.accept({msgs:[inbound('reply','允许')]})
  await until(() => choice)
  assert.deepEqual(choice,{decision:'accept'})
  assert.equal(fx.router.active.requestId,'busy-web-request')
  assert.equal(fx.router.read().interactions.length,0)
  assert.throws(() => fx.router.respond({dispatchId:task.id,instanceId:request.instanceId,response:{decision:'accept'}}),/失效/)
})

test('a structured question answered in WeChat resumes its completed Worker exactly once', async t => {
  const client = fakeClient()
  const fx = await fixture(t, {createChannel: router => new WeChatChannel(router,client)})
  const channel = fx.router.wechat
  channel.bind()
  await until(() => channel.account)
  const task = await dispatch(fx,'wechat-business-question')
  const item = {id:'db-choice',type:'agentMessage',questions:[{title:'使用哪个数据库？',options:['SQLite','PostgreSQL']}]}
  fx.threads.get(task.threadId).turns = [{id:'turn-' + task.id,status:'completed',
    items:[{type:'userMessage',clientId:task.id},item]}]
  await fx.router.dispatcher.reconcile(fx.router.dispatcher.get(task.id))
  channel.accept({msgs:[inbound('first','你好')]})
  await until(() => client.sent.some(m => m.text.includes('使用哪个数据库？')))
  channel.accept({msgs:[inbound('answer','SQLite'),inbound('answer','SQLite')]})
  await until(() => fx.router.dispatcher.list().some(t => t.instruction.includes('使用哪个数据库？\nSQLite')))
  const followups = fx.router.dispatcher.list().filter(task => task.instruction.includes('\nSQLite'))
  assert.equal(followups.length,1)
  assert.equal(followups[0].threadId,task.threadId)
  assert.equal(fx.router.read().messages.find(m=>m.questions)?.status,'answered')
})

test('early foreign completion cannot inherit a phone reply address before the native turn is acknowledged', async t => {
  const client = fakeClient()
  const fx = await fixture(t,{createChannel: router => new WeChatChannel(router,client)})
  const channel = fx.router.wechat
  channel.bind()
  await until(() => channel.account)
  fx.router.app.send = async (threadId) => {
    for (const [id,text] of [['earlier-web','private Web answer'],['phone-turn','actual phone answer']]) {
      fx.router.onEvent('turn/started',{threadId,turn:{id}})
      fx.router.onEvent('item/completed',{threadId,turnId:id,item:{type:'agentMessage',id,text,phase:'final_answer'}})
      fx.router.onEvent('turn/completed',{threadId,turn:{id,status:'completed'}})
    }
    return {turn:{id:'phone-turn',status:'completed'}}
  }
  channel.accept({msgs:[inbound('ask','你好')]})
  await until(() => client.sent.length)
  assert.deepEqual(client.sent.map(message => message.text),['actual phone answer'])
})

test('PSM starts indexing by default and preserves pause and opt-out across restarts', async t => {
  const fx = await fixture(t)
  await fx.router.psm.sync.running
  let status = await fx.router.psm.status()
  assert.equal(status.enabled, true)
  assert.equal(status.phase, 'idle')
  await fx.router.psm.control({action: 'pause'})
  await fx.restart()
  status = await fx.router.psm.status()
  assert.equal(status.enabled, true)
  assert.equal(status.phase, 'paused')
  await fx.router.psm.control({action: 'disable'})
  await fx.restart()
  status = await fx.router.psm.status()
  assert.equal(status.enabled, false)
  assert.equal(status.phase, 'disabled')
})

test('Router PSM tools return visible evidence, retain confirmed semantics across L1 rebuild, and purge copies', async t=>{
  const fx=await fixture(t),router=fx.router,hub=fx.hub
  hub.psmThreads=({archived})=>({data:archived?[]:[...fx.threads.values()].map(v=>v.thread),nextCursor:null})
  hub.psmMetadata=id=>fx.threads.get(id).thread
  hub.psmTurns=id=>({data:[{id:'t',status:'completed',items:[{id:'i',type:'agentMessage',text:id==='worker-a'?'USB HUB 掉线':'蓝牙配对'}]}],nextCursor:null})
  await router.psm.control({action:'enable'})
  await router.psm.sync.running
  await router.send({requestId:'psm-question-test',text:'USB 掉线是那次设备失联'})
  const [hit]=(await fx.tool('psm_search',{query:'USB 掉线'})).value
  assert.equal(hit.threadId,'worker-a')
  assert.equal((await fx.tool('psm_get',{ref:hit.ref})).value.text,'USB HUB 掉线')
  const proposed=await fx.tool('psm_save',{kind:'alias',projectId:'alpha-project',threadId:'worker-a',
    value:'设备失联',evidenceRef:hit.ref,confirmation:'request'})
  assert.equal(proposed.value.status,'needs_confirmation')
  const [card]=router.read().clarifications
  await router.confirm({id:card.id,revision:card.revision,candidateId:card.candidates[0].id})
  let [alias]=await router.psm.search({query:'设备失联'})
  assert.equal(alias.level,'user_confirmed')
  assert.equal(fx.submitted.length,0)
  await router.psm.control({action:'rebuild',confirmed:true})
  await router.psm.sync.running
  assert.equal((await router.psm.search({query:'设备失联'}))[0].revision,1)
  await router.psm.correct({projectId:'alpha-project',threadId:'worker-b',entryId:alias.ref.slice(6),revision:1,value:'设备失联'})
  assert.equal((await router.psm.search({query:'设备失联'}))[0].threadId,'worker-b')
  assert.equal(router.store.list('psm-revision').length,2)
  const project=router.projects.get('alpha-project')
  router.projects.clear()
  assert.deepEqual(await router.psm.search({query:'掉线'}),[])
  await assert.rejects(router.psm.get(hit.ref))
  router.projects.set(project.id,project)
  await router.psm.control({action:'purge',projectId:project.id,confirmed:true})
  await router.psm.sync.running
  assert.deepEqual(await router.psm.search({query:'设备失联'}),[])
  assert.equal(router.store.list('psm-revision').length,0)
  assert.ok(fx.threads.has('worker-a'))
})

test('primary upgrade waits for real pending work, commits one pointer and routes both channels to it',async t=>{
  const fx=await fixture(t),r=fx.router
  r.psm.preference.enabled=true
  r.app.policyVersion=2
  const old=r.session.id,app=r.app
  app.request=async(_,{threadId})=>({thread:{id:threadId,cwd:app.cwd,status:{type:'idle'}}})
  let starts=0
  app.start=async()=>{starts++;return {thread:{id:'psm-primary',cwd:app.cwd}}}
  r.store.wxSave('binding',{id:'active',state:'bound',body:'binding-fixture'})
  r.store.put('task','unfinished',{id:'unfinished',status:'awaiting_input',routerThreadId:old})
  r.upgrade.check()
  assert.equal(starts,0)
  r.store.put('task','unfinished',{id:'unfinished',status:'completed',routerThreadId:old})
  r.store.wxSave('in',{id:'inflight',state:'pending'})
  r.upgrade.check()
  assert.equal(starts,0)
  r.store.wxSave('in',{id:'inflight',state:'done'})
  r.upgrade.check()
  const web=r.send({text:'Web input',requestId:'after-switch-web'})
  await r.upgrade.running
  await web
  r.admit({text:'WeChat input',requestId:'after-switch-phone'},{generation:'test'})
  assert.equal(starts,1)
  assert.equal(r.store.get('session','active').id,'psm-primary')
  for(const key of ['after-switch-phone','after-switch-web'])assert.equal(r.store.get('message','user:'+key).routerThreadId,'psm-primary')
  assert.equal(r.store.wxRead('binding','active').body,'binding-fixture')
  assert.equal(r.store.get('router-history',old).id,old)
  assert.equal(r.store.get('psm-upgrade',old).phase,'committed')
})

test('prepared and unacknowledged upgrades recover conservatively across restart',async t=>{
  const fx=await fixture(t)
  const old=fx.router.session.id
  fx.router.store.put('psm-upgrade',old,{phase:'starting'})
  await fx.restart()
  const r=fx.router
  r.psm.preference.enabled=true
  r.app.policyVersion=2
  r.app.start=()=>assert.fail('must never create another replacement here')
  r.app.request=async(_,{threadId})=>({thread:{id:threadId,cwd:r.app.cwd,status:{type:'idle'}}})
  r.upgrade.check();await r.upgrade.running
  assert.equal(r.session.id,old)
  assert.equal(r.upgrade.error,'创建结果待核对')
  r.store.put('psm-upgrade',old,{phase:'prepared',newId:'known-target'})
  r.store.db.prepare('INSERT INTO router_receipts VALUES(?,?,?,?,?,?,?,?)').run('dispatch',old,'worker','turn',1,'pending',null,Date.now()+100000)
  r.upgrade.check();assert.equal(r.upgrade.running,null)
  r.store.db.exec("UPDATE router_receipts SET state='delivered'")
  r.upgrade.check();await r.upgrade.running
  assert.equal(r.session.id,'known-target')
  await fx.restart()
  assert.equal(fx.router.session.id,'known-target')
  assert.ok(fx.router.store.get('router-history',old))
})

test('an unregistered project is indexed privately until a real access choice; searching never dispatches',async t=>{
  const fx=await fixture(t,{discover:true}),r=fx.router
  fx.hub.psmThreads=({archived})=>({data:archived?[]:[fx.threads.get('worker-a').thread],nextCursor:null})
  fx.hub.psmMetadata=id=>fx.threads.get(id).thread
  fx.hub.psmTurns=()=>({data:[{id:'turn',items:[{id:'i',type:'agentMessage',text:'USB历史证据'}]}],nextCursor:null})
  await r.psm.control({action:'enable'});await r.psm.sync.running
  assert.equal((await r.psm.status()).indexed,1)
  await r.send({requestId:'psm-authorize-project',text:'查找历史会话'})
  assert.deepEqual((await fx.tool('psm_search',{query:'USB'})).value,[])
  const [p]=(await fx.tool('list_projects',{})).value
  assert.equal((await fx.tool('psm_get',{ref:'project:'+p.id})).value.status,'needs_confirmation')
  const [card]=r.read().clarifications
  await r.confirm({id:card.id,revision:card.revision,candidateId:p.id})
  const [hit]=(await fx.tool('psm_search',{query:'USB'})).value
  assert.equal(hit.projectId,p.id)
  assert.equal(hit.resumeCandidate,false)
  assert.equal(r.projects.has(p.id),false)
  assert.equal((await fx.tool('psm_get',{ref:hit.ref})).value.text,'USB历史证据')
  assert.equal(fx.submitted.length,0)
  assert.equal(fx.threads.size,2)
})

test('a directory move with native thread continuity preserves memory; same-name replacement gets a fresh identity',async t=>{
  const fx=await fixture(t),r=fx.router
  const worker=fx.threads.get('worker-a')
  fx.hub.psmThreads=({archived})=>({data:archived?[]:[worker.thread],nextCursor:null})
  fx.hub.psmMetadata=()=>worker.thread
  fx.hub.psmTurns=()=>({data:[{id:'turn',items:[{id:'item',type:'agentMessage',text:'项目历史'}]}],nextCursor:null})
  await r.psm.control({action:'enable'});await r.psm.sync.running
  const original=r.store.get('psm-thread',worker.thread.id).uid
  const moved=fx.cwd+'-moved'
  await rename(fx.cwd,moved)
  worker.thread.cwd=moved
  r.projects=await loadRouterProjects([{id:'alpha-project',name:'Alpha',cwd:moved}],r.directory)
  r.psm.sync.refresh();await r.psm.sync.running
  assert.equal((await r.psm.allowed()).get(original)?.cwd,moved)
  assert.equal((await r.psm.search({query:'项目历史'}))[0].threadId,worker.thread.id)
  await mkdir(fx.cwd)
  r.projects=await loadRouterProjects([{id:'alpha-project',name:'Alpha',cwd:fx.cwd}],r.directory)
  worker.thread.cwd=fx.cwd
  r.psm.sync.refresh();await r.psm.sync.running
  assert.deepEqual(await r.psm.search({query:'项目历史'}),[])
  assert.match(await r.psm.targetIssue(r.projects.get('alpha-project'),worker.thread.id),/身份/)
  assert.equal((await r.psm.sync.db.call('source',worker.thread.id)).state,'missing')
})

test('a corrupt derived file degrades PSM alone and explicit L1 rebuild restores confirmed associations',async t=>{
  const fx=await fixture(t),r=fx.router
  fx.hub.psmThreads=()=>({data:[],nextCursor:null})
  await r.psm.control({action:'enable'})
  await r.psm.sync.running
  const uid=r.psm.identity(r.projects.get('alpha-project'))
  r.psm.apply({id:'alias',uid,projectId:'alpha-project',kind:'alias',value:'设备控制',previous:0,state:'active'},'user_confirmed','settings-test')
  await r.psm.control({action:'disable'})
  await writeFile(join(r.directory,'psm-index.sqlite'),'invalid sqlite database')
  await r.psm.control({action:'enable'})
  assert.equal((await r.psm.status()).phase,'failed')
  assert.equal(r.read().phase,'ready')
  await r.send({requestId:'fallback-lookup-test',text:'查看项目'})
  assert.equal((await fx.tool('list_projects',{})).success,true)
  await r.psm.control({action:'rebuild',confirmed:true});await r.psm.sync.running
  assert.equal((await r.psm.search({query:'设备控制'}))[0].level,'user_confirmed')
})
