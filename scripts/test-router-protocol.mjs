import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { DaemonTransport } from '../server/codex/transport/daemon.js'
import { runningBinaryDigest } from '../server/codex/worker-protocol.js'
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import {
  assistantMessage, connectAppServer, dynamicCall, dynamicTools, fixtureToolHandler,
  namespace, startResponsesFixture, toolName, waitFor,
} from '../test/fixtures/router-app-server.mjs'

const textInput = text => [{ type: 'text', text, text_elements: [] }]
const startParams = cwd => ({ cwd, approvalPolicy: 'never', sandbox: 'read-only', environments: [] })

const queueOnly = process.argv.includes('--queue-only')
const daemon = process.argv.includes('--daemon-fixture')
const rccOnly = process.argv.includes('--rcc-p0') || queueOnly
const command = process.env.CODEX_WEB_CODEX_PATH
if (process.env.CODEX_WEB_ROUTER_A1 !== '1' || !command || !isAbsolute(command)) {
  throw new Error('Set CODEX_WEB_ROUTER_A1=1 and CODEX_WEB_CODEX_PATH to an absolute Codex executable path')
}

const currentNetns = await readlink('/proc/self/ns/net')
if (!process.env.ROUTER_A1_PARENT_NETNS) {
  const child = spawnSync('/usr/bin/unshare', [
    '--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL',
    '--', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], {
    env: {
      CODEX_WEB_ROUTER_A1: '1',
      CODEX_WEB_CODEX_PATH: command,
      ROUTER_A1_PARENT_NETNS: currentNetns,
      ...(process.env.CODEX_WEB_ROUTER_NATIVE_PATH ? { CODEX_WEB_ROUTER_NATIVE_PATH: process.env.CODEX_WEB_ROUTER_NATIVE_PATH } : {}),
      ...(process.env.CODEX_WEB_ROUTER_POLICY_PATH ? { CODEX_WEB_ROUTER_POLICY_PATH: process.env.CODEX_WEB_ROUTER_POLICY_PATH } : {}),
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    },
    stdio: 'inherit',
    timeout: 120_000,
  })
  if (child.error) throw child.error
  process.exitCode = child.status ?? 1
} else {
  assert.notEqual(currentNetns, process.env.ROUTER_A1_PARENT_NETNS)
  const links = JSON.parse(execFileSync('/usr/sbin/ip', ['-json', 'link', 'show'], { encoding: 'utf8' }))
  assert.deepEqual(links.map(link => link.ifname), ['lo'])
  execFileSync('/usr/sbin/ip', ['link', 'set', 'lo', 'up'])
  await run()
}

async function run() {
  const root = await mkdtemp('/tmp/codex-router-a1-')
  const open = new Set()
  let model
  try {
    const home = join(root, 'home')
    const codexHome = join(root, 'codex')
    const cwd = join(root, 'workspace')
    const tmp = join(root, 'tmp')
    await Promise.all([home, codexHome, cwd, tmp].map(path => mkdir(path)))
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      TMPDIR: tmp,
      PATH: process.env.PATH,
    }
    const version = execFileSync(command, ['--version'], { env, cwd, encoding: 'utf8' }).trim()
    const schema = join(root, 'schema')
    execFileSync(command, ['app-server', 'generate-json-schema', '--experimental', '--out', schema], { env, cwd })
    const schemas = [['v2/ThreadQueueStartParams.json', ['threadId', 'queuedSubmissionId']]]
    if (!rccOnly) schemas.push(
      ['v2/ThreadStartParams.json', ['dynamicTools', 'environments']],
      ['DynamicToolCallParams.json', ['threadId', 'turnId', 'callId', 'namespace', 'tool', 'arguments']],
      ['DynamicToolCallResponse.json', ['success', 'contentItems']],
    )
    for (const [filename, keys] of schemas) {
      const shape = JSON.parse(await readFile(join(schema, filename), 'utf8'))
      for (const key of keys) assert.ok(Object.hasOwn(shape.properties, key), filename + ' is missing ' + key)
    }
    model = await startResponsesFixture()
    await writeFile(join(codexHome, 'config.toml'), [
      'model = "router-fixture"',
      'model_provider = "router_fixture"',
      'web_search = "disabled"',
      '[analytics]',
      'enabled = false',
      '[model_providers.router_fixture]',
      'name = "Router A1 fixture"',
      'base_url = "' + model.url + '/v1"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '[tools.update_plan]',
      'enabled = false',
      '[tools.experimental_request_user_input]',
      'enabled = false',
      '[agents]',
      'enabled = false',
      '[features]',
      'shell_tool = false',
      'apps = false',
      'plugins = false',
      'hooks = false',
      'goals = false',
      'view_image = false',
      'multi_agent_v2 = false',
      '',
    ].join('\n'), { mode: 0o600 })
    let connectionNumber = 0
    let previousExit
    const connect = async (options = {}) => {
      let child
      let app
      try {
        if (rccOnly && daemon) {
          await previousExit
          const socketPath = join(root, 'probe-' + ++connectionNumber + '.sock')
          child = spawn(command, ['app-server', '--listen', 'unix://' + socketPath, '--strict-config'],
            { cwd, env, stdio: 'ignore', detached: true })
          const exited = new Promise(resolve => child.once('close', resolve))
          for (let attempt = 0; attempt < 250; attempt++) {
            if (await stat(socketPath).catch(() => null)) break
            if (child.exitCode !== null) throw new Error('私有协议服务器提前退出')
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          app = await connectAppServer({ transport: new DaemonTransport({ socketPath }), ...options })
          const disconnect = app.close
          app.close = () => {
            disconnect()
            // The recovery fixture simulates loss of its own server during a held turn.
            // Include the npm launcher and its native child in this private process group.
            if (child.exitCode === null && !child.signalCode) process.kill(-child.pid, 'SIGKILL')
            previousExit = exited
          }
        } else {
          app = await connectAppServer({ command, env, cwd, args: ['--strict-config'], ...options })
        }
      } catch (error) {
        child?.kill()
        throw error
      }
      open.add(app)
      return app
    }
    const close = app => {
      app.close()
      open.delete(app)
    }

    const report = { cli: version, network: 'private loopback only', generatedExperimentalSchema: true }
    const app = rccOnly ? await connect() : await checkRouter()
    async function checkRouter() {
      const noExperimental = await connect({ experimentalApi: false })
      await assert.rejects(noExperimental.request('thread/start', { cwd, dynamicTools }), /experimental/i)
      close(noExperimental)

      let app = await connect()
      report.userAgent = app.info.userAgent
      await assert.rejects(app.request('thread/start', {
        ...startParams(cwd),
        dynamicTools: [{ ...dynamicTools[0], tools: [...dynamicTools[0].tools, ...dynamicTools[0].tools] }],
      }), /duplicate/i)

      const { thread } = await app.request('thread/start', { ...startParams(cwd), dynamicTools })
      assert.equal(thread.cwd, cwd)
      const initialHistory = await app.request('thread/turns/list', { threadId: thread.id }).then(
        value => ({ turnCount: value.data.length }),
        error => ({ error: error.message.replaceAll(thread.id, '<threadId>') }),
      )
      report.freshThread = { pathIssued: Boolean(thread.path), fileExists: await rolloutExists(thread.path), initialHistory }

      const toolReads = []
      registerTool(app, thread.id, toolReads)
      const offset = model.requests.length
      model.enqueue(dynamicCall('a1-first'), assistantMessage('First fixture done.'))
      const first = await turn(app, thread.id, 'first fixture')
      checkToolEvents(app, thread.id, first.id, 'a1-first', true)
      assert.match(JSON.stringify(model.requests[offset + 1].input), /ROUTER_A1_FIXTURE_RESULT/)
      assert.deepEqual(toolReads, ['fixture'])
      report.initialToolInventory = toolInventory(model.requests[offset])
      assert.ok(report.initialToolInventory.includes(namespace + '/' + toolName))

      model.enqueue(dynamicCall('a1-invalid', { key: 'other' }), assistantMessage('Rejected arguments.'))
      const invalid = await turn(app, thread.id, 'invalid arguments fixture')
      checkToolEvents(app, thread.id, invalid.id, 'a1-invalid', false)
      assert.match(JSON.stringify(model.requests.at(-1).input), /Invalid fixture arguments/)
      assert.deepEqual(toolReads, ['fixture'])
      report.dynamicRoundTrip = 'success and model-visible argument rejection'

      const stored = await app.request('thread/read', { threadId: thread.id, includeTurns: false })
      assert.ok(await rolloutExists(stored.thread.path), 'first user turn should materialize a rollout')
      const empty = await app.request('thread/start', { ...startParams(cwd), dynamicTools })
      close(app)
      if (process.argv.includes('--uas')) {
        const peer = await connect({ clientName: 'uas-peer' })
        try {
          const snapshot = await peer.request('thread/resume', { threadId: thread.id, excludeTurns: true })
          assert.equal(snapshot.thread.id, thread.id)
          assert.equal(snapshot.sandbox.type, 'readOnly')
          report.coldPeer = { distinctClient: true, sameThread: true, sandbox: snapshot.sandbox.type }
        } finally { close(peer) }
      }
      app = await connect()
      report.freshThread.coldEmptyResume = await app.request('thread/resume', {
        threadId: empty.thread.id, excludeTurns: true,
      }).then(
        value => ({ sameThread: value.thread.id === empty.thread.id }),
        error => ({ error: error.message.replaceAll(empty.thread.id, '<threadId>') }),
      )
      const resumed = await app.request('thread/resume', { threadId: thread.id, excludeTurns: true })
      assert.equal(resumed.thread.id, thread.id)
      assert.equal(resumed.thread.cwd, cwd)
      const beforeResume = model.requests.length
      registerTool(app, thread.id, toolReads)
      model.enqueue(dynamicCall('a1-resumed'), assistantMessage('Resume fixture done.'))
      const continued = await turn(app, thread.id, 'after app server restart')
      checkToolEvents(app, thread.id, continued.id, 'a1-resumed', true)
      assert.deepEqual(toolReads, ['fixture', 'fixture'])
      report.resume = { sameThread: true, toolRoundTrip: true, inventory: toolInventory(model.requests[beforeResume]) }
      report.rejectedToolCalls = await checkDisabledCalls(app, thread.id, model)
      const mcp = await app.request('mcpServerStatus/list', { threadId: thread.id })
      assert.deepEqual(mcp.data, [])
      report.mcpServerCount = mcp.data.length

      const pendingReply = Promise.withResolvers()
      app.rpc.onServerRequest(({ method, params }) => {
        assert.equal(method, 'item/tool/call')
        assert.equal(params.callId, 'a1-pending')
        return pendingReply.promise
      })
      model.enqueue(dynamicCall('a1-pending'))
      const interrupted = await app.request('turn/start', { threadId: thread.id, input: textInput('hold a tool response') })
      assert.ok(interrupted.turn.id)
      await waitFor(app.events, entry => entry.method === 'item/tool/call' && entry.params.callId === 'a1-pending', 'pending dynamic request')
      close(app)
      pendingReply.resolve({ success: true, contentItems: [{ type: 'inputText', text: 'Late fixture reply.' }] })
      app = await connect()
      await app.request('thread/resume', { threadId: thread.id, excludeTurns: true })
      registerTool(app, thread.id, toolReads)
      model.enqueue(dynamicCall('a1-after-pending'), assistantMessage('Tool after restart done.'))
      const afterPending = await turn(app, thread.id, 'after restart with unfinished dynamic tool')
      checkToolEvents(app, thread.id, afterPending.id, 'a1-after-pending', true)
      assert.notEqual(afterPending.id, interrupted.turn.id)
      assert.equal(app.events.some(entry => entry.method === 'item/tool/call' && entry.params.callId === 'a1-pending'), false)
      assert.deepEqual(toolReads, ['fixture', 'fixture', 'fixture'])
      report.pendingToolRestart = { oldCallReplayed: false, newTurnUsable: true }

      report.restrictedInventory = [...new Set(model.requests.flatMap(toolInventory))].sort()

      const naive = await app.request('thread/start', {
        ...startParams(cwd), ephemeral: true, dynamicTools,
        config: {
          'features.shell_tool': true, 'features.view_image': true, 'features.goals': true,
          'agents.enabled': true, 'tools.experimental_request_user_input.enabled': true,
        },
      })
      model.enqueue(assistantMessage('Inventory control.'))
      await turn(app, naive.thread.id, 'read-only control')
      report.readOnlyControlInventory = toolInventory(model.requests.at(-1))
      assert.ok(report.readOnlyControlInventory.includes('exec_command'))
      assert.ok(report.readOnlyControlInventory.includes('write_stdin'))

      if (process.argv.includes('--uas')) {
        report.sharedThreads = await checkSharedThreads({ app, connect, close, cwd, root, model, thread })
      }
      return app
    }
    const record = rccOnly ? { format: 1, version: version.replace(/^codex-cli /, ''), platform: process.platform,
      arch: process.arch, transport: daemon ? 'daemon' : 'stdio', sha256: await runningBinaryDigest(app.rpc),
      queue: true, steer: !queueOnly } : null
    report.queue = await checkQueue({ app, close, connect, cwd, model })
    // Candidate is private to this fixture. Export it only after the Worker assertions pass.
    const reportPath = join(root, 'candidate.json')
    if (record) await writeFile(reportPath, JSON.stringify({ workerProtocol: record }))
    report.workerHub = await checkWorkerHub({ command, root, env, reportPath: rccOnly ? reportPath : '' })
    if (rccOnly) {
      if (!queueOnly) assert.ok(report.workerHub.controls.parallel, 'P0 requires the complete Steer and parallel delivery probes')
      assert.deepEqual(model.unexpected, [])
      console.log(JSON.stringify({ cli: version, network: report.network, queue: report.queue,
        controls: report.workerHub.controls, workerProtocol: record, rccP0Passed: !queueOnly }, null, 2))
      return
    }
    const nativePath = process.env.CODEX_WEB_ROUTER_NATIVE_PATH
    if (nativePath) {
      assert.ok(isAbsolute(nativePath))
      report.hostIsolation = await checkHostIsolation({ nativePath, connect, close, env, root, cwd, model })
    }
    const policyPath = process.env.CODEX_WEB_ROUTER_POLICY_PATH
    if (policyPath) {
      assert.ok(isAbsolute(policyPath))
      report.compiledPolicy = await checkCompiledPolicy({ policyPath, connect, close, cwd, model, root, env })
    }
    assert.equal(model.remaining, 0)
    assert.deepEqual(model.unexpected, [])

    const allowed = namespace + '/' + toolName
    report.unexpectedRouterTools = report.restrictedInventory.filter(name => name !== allowed)
    report.onlyRouterTools = report.unexpectedRouterTools.length === 0
    report.a1Passed = Boolean(report.onlyRouterTools && report.hostIsolation && report.compiledPolicy)
    report.remainingGate = report.a1Passed
      ? 'Offline capabilities verified. Deployment network and account validation remain external.'
      : 'Pass both the isolated host fixture and the compiled positive tool policy checks.'
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.a1Passed ? 0 : 2
  } finally {
    for (const app of open) app.close()
    await model?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function checkWorkerHub({ command, root, env, reportPath }) {
  const { CodexHub } = await import('../server/codex/hub.js')
  const { normalizeConfig } = await import('../server/codex/config.js')
  const { StdioTransport } = await import('../server/codex/transport/stdio.js')
  const { EventBus } = await import('../server/services/events.js')
  const { workerDispatchIssue } = await import('../server/router/projects.js')
  const cwd = join(root, 'worker-mvp')
  const codexHome = join(root, 'worker-mvp-codex')
  await Promise.all([mkdir(cwd), mkdir(codexHome)])
  const fixture = await startResponsesFixture()
  await writeFile(join(codexHome, 'config.toml'), [
    'model = "gpt-5.4"',
    'openai_base_url = "' + fixture.url + '/v1"',
    'web_search = "disabled"',
    '[analytics]', 'enabled = false',
    '[features]', 'apps = false', 'plugins = false', '',
  ].join('\n'))
  const bus = new EventBus()
  const events = []
  bus.subscribe(event => events.push(event))
  const kind = daemon ? 'daemon' : 'stdio'
  const socketPath = join(root, 'worker.sock')
  const workerEnv = { ...env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'offline-fixture' }
  const child = daemon ? spawn(command, ['app-server', '--listen', 'unix://' + socketPath, '--strict-config'],
    { env: workerEnv, cwd, stdio: 'ignore' }) : null
  const hub = new CodexHub({
    config: normalizeConfig({ codexHome, codexPath: command, transport: kind, workerProtocolReport: reportPath }),
    bus,
    openTransport: async () => {
      const transport = daemon ? new DaemonTransport({ socketPath }) : new StdioTransport({
        command, args: ['app-server', '--stdio', '--strict-config'], cwd, env: workerEnv,
      })
      await transport.open()
      return { transport, kind, socketPath: daemon ? socketPath : null }
    },
  })
  try {
    hub.start()
    await waitFor(events, event => event.type === 'connection' && event.payload.phase === 'ready', 'Worker Hub initialization')
    const thread = await hub.newThread({
      cwd, sandbox: 'read-only', approvalPolicy: 'on-request',
    }, { routerWorker: true })
    const firstRead = await hub.routerReadWorker(thread.id)
    assert.deepEqual(firstRead.turns, [])
    await hub.openThread(thread.id)
    assert.equal(workerDispatchIssue({ cwd, sandbox: 'read-only' }, await hub.routerWorkerSettings(thread.id)), null)
    const clientId = 'router-worker-hub-fixture'
    fixture.enqueue(assistantMessage('Worker Hub fixture OK.'))
    const submission = await hub.routerAddWorkerMessage(thread.id, clientId, 'Verify the router worker connection; reply only.')
    assert.equal(submission.clientUserMessageId, clientId)
    const user = await waitFor(events, event => event.type === 'item/upsert' &&
      event.threadId === thread.id && event.payload.item?.clientId === clientId, 'Worker Hub correlation event')
    await waitFor(events, event => event.type === 'turn/completed' && event.threadId === thread.id &&
      event.turnId === user.turnId && event.payload.turn.status === 'completed', 'Worker Hub completion')
    const final = await hub.routerReadWorker(thread.id)
    assert.equal(final.turns.filter(turn => turn.items.some(item => item.clientId === clientId)).length, 1)
    assert.equal(fixture.remaining, 0)
    assert.deepEqual(fixture.unexpected, [])
    const writable = await hub.newThread({ cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request' }, { routerWorker: true })
    const writableSettings = await hub.routerWorkerSettings(writable.id)
    assert.equal(writableSettings.sandbox?.type, 'workspaceWrite')
    assert.equal(workerDispatchIssue({ cwd, sandbox: 'workspace-write' }, writableSettings), null)
    assert.ok(workerDispatchIssue({ cwd, sandbox: 'read-only' }, writableSettings))
    if (reportPath) assert.equal(hub.status().workerProtocol.source, 'fixture')
    const controls = hub.status().workerProtocol.steer
      ? await checkControls({ hub, bus, fixture, root, cwd, threadId: thread.id, events })
      : { skipped: 'Unverified Steer version' }
    return { controls, newWorker: true, verifiedSettings: true, queued: true, completed: true, historyCorrelated: true, workspaceWriteBounded: true }
  } catch (error) {
    error.message += '\nRecent Worker Hub events: ' + JSON.stringify(
      events.slice(-8).map(event => ({ type: event.type, payload: event.payload }))).slice(-3000)
    throw error
  } finally {
    await hub.stop()
    child?.kill()
    bus.dispose()
    await fixture.close()
  }
}

// Only target selection is scripted. The input FIFO, tool guard, SQLite, Dispatcher,
// Hub, private Worker and its native approvals and history use the workbench paths.
async function checkControls({ hub, bus, fixture, root, cwd, threadId, events }) {
  const { RouterService } = await import('../server/router/service.js')
  const { FollowupQueue } = await import('../server/services/followups.js')
  const followups = new FollowupQueue({ hub, bus })
  const router = new RouterService({ hub, bus, followups, stateDir: join(root, 'rcc'),
    config: { enabled: true, projects: [{ id: 'rcc', name: 'RCC', cwd, sandbox: 'read-only' }] },
    wakePolicy: { mergeMs: 60000 }, connect: async ({ directory }) => {
      const workspace = join(directory, 'workspace')
      return { cwd: workspace, selected: { model: 'fixture' },
        classify: async () => ({ operation: 'work', scope: 'unspecified', projects: [], view: 'none',
          topic: '', status: 'any', page: 1, work: '' }),
        start: async () => ({ thread: { id: 'rcc-router', cwd: workspace } }),
        send: async (_id, _text, requestId) => ({ turn: { id: 'source-' + requestId } }),
        close() {} }
    } })
  // Observe the commit notification and the actual Hub call on a monotonic clock.
  const committed = new Map()
  const incoming = new Map()
  const native = new Map()
  const stop = bus.subscribe(e => {
    if (e.type === 'router/changed' && e.payload?.type === 'task.queued' && !committed.has(e.payload.id)) {
      committed.set(e.payload.id, performance.now())
    }
  })
  const steer = hub.steerTurn.bind(hub)
  hub.steerTurn = async params => {
    const sent = performance.now()
    const result = await steer(params)
    native.set(params.clientUserMessageId, { sent, ack: performance.now() })
    return result
  }
  async function send(text, options = {}) {
    const requestId = 'rcc-protocol-' + text
    const arrived = performance.now()
    await router.send({ requestId, text })
    const turnId = router.active.turnId
    const result = await router.onTool({ namespace: 'codex_web_router', tool: 'dispatch_task',
      threadId: router.session.id, turnId, callId: requestId,
      arguments: { requestId, projectId: 'rcc', threadId, mode: 'resume', instruction: text, ...options } })
    assert.ok(result.success, JSON.stringify(result))
    const task = JSON.parse(result.contentItems[0].text)
    assert.equal(task.status, 'queued', JSON.stringify(task))
    router.onEvent('turn/completed', { threadId: router.session.id, turn: { id: turnId, status: 'completed' } })
    incoming.set(task.id, arrived)
    return task.id
  }
  async function until(read, description) {
    for (let i = 0; i < 500; i++) {
      const result = read()
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('RCC timeout ' + description + ' ' + JSON.stringify(router.read().tasks))
  }
  const latency = []
  const report = {}
  let release
  try {
    router.start()
    await router.opening
    assert.equal(router.phase, 'ready')
    router.setMode({mode:'task',revision:router.routing().modeRevision})
    for (const scenario of ['running', 'approval', 'input', 'interrupt']) {
      const isInput = scenario === 'input'
      const tool = isInput ? 'request_user_input' : 'exec_command'
      const args = isInput ? { questions: [{ id: 'q', header: 'Choice', question: 'Choose', options: [
        { label: 'One', description: 'First option' }, { label: 'Two', description: 'Second option' }] }] }
        : { cmd: 'pwd', sandbox_permissions: 'require_escalated', justification: 'Allow the fixture to print its temporary cwd?' }
      const offset = fixture.requests.length
      fixture.enqueue(scenario === 'running' ? () => new Promise(resolve => {
        release = () => resolve(assistantMessage('running response'))
      }) : { type: 'function_call', name: tool, call_id: 'call-' + scenario, arguments: JSON.stringify(args) })
      if (scenario !== 'interrupt') fixture.enqueue(assistantMessage('Worker fixture finished'))
      const owner = await send('start-' + scenario, isInput ? { executionMode: 'plan' } : {})
      const card = await until(() => scenario === 'running' ? release : router.read().interactions.find(r => r.dispatchId === owner), scenario)
      const ownerTurn = await until(() => router.getTask(owner).turnId, 'owner turn')
      const ids = []
      for (let i = 0; i < (scenario === 'running' ? 3 : 1); i++) ids.push(await send('extra-' + scenario + '-' + i))
      await until(() => ids.every(id => router.getTask(id).delivery.ackAt), 'Steer acknowledgement')
      if (scenario === 'running') {
        for (const id of ids) {
          const admitted = incoming.get(id)
          const queued = committed.get(id)
          const { sent, ack } = native.get(id)
          assert.ok(admitted <= queued && queued <= sent && sent <= ack)
          latency.push([queued - admitted, sent - queued, ack - sent, ack - admitted].map(ms => Number(ms.toFixed(2))))
        }
        release()
      } else {
        assert.ok(router.read().interactions.some(r => r.instanceId === card.instanceId), 'original pending instance changed: ' + scenario)
        assert.equal(card.method, isInput ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval')
        if (scenario === 'interrupt') {
          const stop = router.requestStop(owner,{requestId:'rcc-stop-native',text:'纠正误派'},true)
          const card = router.store.get('clarification',stop.id)
          await router.confirm({id:stop.id,revision:card.revision,candidateId:owner})
        }
        else router.respond({ dispatchId: owner, instanceId: card.instanceId,
          response: isInput ? { answers: { q: { answers: ['One'] } } } : { decision: 'accept' } })
      }
      const end = await waitFor(events, e => e.type === 'turn/completed' && e.turnId === ownerTurn, scenario + ' terminal')
      const history = (await hub.routerReadWorker(threadId)).turns.find(t => t.id === ownerTurn)
      const hits = history.items.filter(i => ids.includes(i.clientId)).map(i => i.clientId)
      const expected = scenario === 'interrupt' ? [] : ids
      assert.deepEqual(hits, expected)
      const messages = history.items.filter(item => item.type === 'userMessage')
      assert.deepEqual(messages.map(item => item.content.map(part => part.text)), [
        ['start-' + scenario],
        ...expected.map((_, i) => ['extra-' + scenario + '-' + i]),
      ])
      assert.equal(end.payload.turn.status, scenario === 'interrupt' ? 'interrupted' : 'completed')
      const modelInputs = JSON.stringify(fixture.requests.slice(offset).map(body => body.input))
      for (let i = 0; i < ids.length; i++) assert.equal(modelInputs.includes('extra-' + scenario + '-' + i), scenario !== 'interrupt')
      if (scenario !== 'interrupt') await until(() => ids.every(id => router.getTask(id).delivery.historyAt), 'stored history evidence')
      else assert.equal(router.getTask(ids[0]).delivery.historyAt, undefined)
      const receipts = router.store.db.prepare('SELECT count(*) AS n FROM router_receipts WHERE worker_turn_id=?').get(ownerTurn).n
      assert.equal(receipts, 1)
      for (const id of ids) assert.equal(router.getTask(id).receiptStatus, null)
      if (scenario === 'interrupt') await until(()=>router.store.get('stop',owner)?.state==='interrupted','verified interrupt outcome')
      report[scenario] = { acknowledgements: ids.length, historyItems: hits.length, receipts, turnStatus: history.status }
    }
    if (rccOnly) {
      const newThread = () => hub.newThread({ cwd, sandbox: 'read-only', approvalPolicy:'on-request' }, {routerWorker:true})
      const b = await newThread()
      const c = await newThread()
      const add = hub.routerAddWorkerMessage.bind(hub)
      const observed = new Map()
      let heldAt
      hub.routerAddWorkerMessage = async (target, ...params) => {
        if (target === threadId) {
          heldAt = performance.now()
          await new Promise(resolve => setTimeout(resolve, 30000))
        }
        const ack = await add(target, ...params)
        observed.set(target, performance.now() - heldAt)
        return ack
      }
      try {
        fixture.enqueue(...Array.from({ length: 3 }, () => assistantMessage('parallel fixture finished')))
        const aId = await send('parallel-a')
        await until(() => heldAt, 'A held at Hub')
        const bId = await send('parallel-b', { threadId: b.id })
        const cId = await send('parallel-c', { threadId: c.id })
        await until(() => [bId,cId].every(id => router.getTask(id).status === 'completed'), 'B and C completed while A held')
        assert.equal(router.getTask(aId).delivery.state, 'delivering')
        await new Promise(resolve => setTimeout(resolve, Math.max(0, heldAt + 30000 - performance.now())))
        await until(() => router.getTask(aId).status === 'completed', 'A completed after hold')
        for (const [target, id] of [[threadId,aId],[b.id,bId],[c.id,cId]]) {
          const detail = await hub.routerReadWorker(target)
          assert.equal(detail.turns.flatMap(t => t.items.filter(i => i.clientId === id)).length, 1)
        }
        report.parallel = { holdMs:30000, ackAfterHoldStartMs:[threadId,b.id,c.id].map(id => Number(observed.get(id).toFixed(2))) }
      } finally { delete hub.routerAddWorkerMessage }
    }
    assert.deepEqual(fixture.unexpected, [])
    assert.equal(fixture.remaining, 0)
    const quantiles = latency[0].map((_, col) => {
      const sorted = latency.map(row => row[col]).sort((a,b) => a-b)
      return { p50: sorted[1], p95: sorted[2] }
    })
    return { ...report, timingColumns: ['admitToCommit','commitToRpc','rpcToAck','admitToAck'], milliseconds: latency, quantiles }
  } finally {
    release?.()
    await router.close()
    followups.dispose()
    stop()
    delete hub.steerTurn
  }
}

async function checkSharedThreads({ app, connect, close, cwd, root, model, thread }) {
  const workers = []
  for (const [index, sandbox] of ['workspace-write', 'read-only'].entries()) {
    const path = join(root, 'parallel-' + index)
    await mkdir(path)
    const result = await app.request('thread/start', { cwd: path, sandbox, approvalPolicy: 'never',
      model: 'fixture-worker-' + index, config: { model_reasoning_effort: index ? 'low' : 'high' } })
    assert.equal(result.cwd, path)
    assert.equal(result.model, 'fixture-worker-' + index)
    assert.equal(result.reasoningEffort, index ? 'low' : 'high')
    assert.equal(result.sandbox.type, index ? 'readOnly' : 'workspaceWrite')
    workers.push(result.thread)
  }
  const participants = [thread, ...workers]
  const gate = Promise.withResolvers()
  const markers = participants.map((_, i) => 'uas-parallel-input-' + i)
  try {
    model.enqueue(...participants.map(() => async () => {
      await gate.promise
      return assistantMessage('parallel OK')
    }))
    const turns = await Promise.all(participants.map(({ id }, i) => app.request('turn/start',
      { threadId: id, input: textInput(markers[i]) })))
    for (const [i, marker] of markers.entries()) {
      const body = await waitFor(model.requests,
        request => JSON.stringify(request.input).includes(marker), marker)
      const input = JSON.stringify(body.input)
      assert.deepEqual(markers.filter(other => input.includes(other)), [marker])
      if (i === 0) assert.deepEqual(toolInventory(body), [namespace + '/' + toolName])
    }
    gate.resolve()
    await Promise.all(turns.map(({ turn }, i) => completedTurn(app, participants[i].id, turn.id)))
  } finally { gate.resolve() }
  const peer = await connect()
  try {
    const peerResume = await peer.request('thread/resume', { threadId: thread.id, excludeTurns: true })
      .then(result => {
        assert.equal(result.thread.id, thread.id)
        return 'accepted'
      }, error => {
        assert.match(error.message, /already has an active writer/)
        return 'active writer rejected'
      })
    return { concurrent: participants.length, distinctInputs: true, routerInventoryStable: true,
      workerSandboxes: ['workspaceWrite', 'readOnly'], peerResume }
  } finally { close(peer) }
}

async function checkHostIsolation({ nativePath, connect, close, env, root, cwd, model }) {
  const config = join(env.CODEX_HOME, 'config.toml')
  const workspaceFixture = join(cwd, 'router-fixture.txt')
  const outside = join(root, 'outside')
  await mkdir(outside)
  const worker = join(outside, 'worker.txt')
  const database = join(outside, 'workbench.sqlite')
  const socketPath = join(outside, 'worker.sock')
  await Promise.all([
    writeFile(workspaceFixture, 'router fixture'),
    writeFile(worker, 'worker fixture'),
    writeFile(database, 'database fixture'),
  ])
  const socket = createServer()
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(socketPath, resolve)
  })
  let app
  try {
    app = await connect({
      command: '/usr/bin/bwrap',
      prefix: [
        '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
        '--cap-drop', 'ALL', '--die-with-parent', '--new-session',
        '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
        '--ro-bind', nativePath, '/codex-fixture',
        '--ro-bind', env.HOME, env.HOME,
        '--ro-bind', cwd, cwd,
        '--bind', env.CODEX_HOME, env.CODEX_HOME,
        '--ro-bind', config, config,
        '--bind', env.TMPDIR, env.TMPDIR,
        '--chdir', cwd,
        '--', '/codex-fixture',
      ],
      env: { ...env, PATH: '/nonexistent' },
    })
    const fixture = await app.request('fs/readFile', { path: workspaceFixture })
    assert.equal(Buffer.from(fixture.dataBase64, 'base64').toString(), 'router fixture')
    const contents = Buffer.from('write check').toString('base64')
    for (const path of [worker, database]) {
      await assert.rejects(app.request('fs/readFile', { path }), /not found|no such file/i)
    }
    await assert.rejects(app.request('fs/getMetadata', { path: socketPath }), /not found|no such file/i)
    for (const path of [workspaceFixture, config]) {
      await assert.rejects(app.request('fs/writeFile', { path, dataBase64: contents }), /read.only|permission denied/i)
    }
    const stateFile = join(env.CODEX_HOME, 'test-write')
    await app.request('fs/writeFile', { path: stateFile, dataBase64: contents })
    assert.equal(await readFile(stateFile, 'utf8'), 'write check')
    const toolReads = []
    const { dynamicTools: productionTools } = await import('../server/router/tools.js')
    const started = await app.request('thread/start', { ...startParams(cwd), dynamicTools: [...productionTools, ...dynamicTools] })
    registerTool(app, started.thread.id, toolReads)
    model.enqueue(dynamicCall('a1-mounted'), assistantMessage('Mounted Router tool call done.'))
    const completed = await turn(app, started.thread.id, 'mounted Router fixture')
    checkToolEvents(app, started.thread.id, completed.id, 'a1-mounted', true)
    assert.deepEqual(toolReads, ['fixture'])
    return { hidden: ['worker workspace', 'application database', 'worker socket path'],
      workspaceReadOnly: true, configReadOnly: true, privateStateWritable: true, dynamicRoundTrip: true,
      additionalFixtureToolAccepted: true, inventory: toolInventory(model.requests.at(-1)) }
  } finally {
    if (app) close(app)
    await new Promise(resolve => socket.close(resolve))
  }
}

async function checkCompiledPolicy({ policyPath, connect, close, cwd, model, root, env }) {
  const { dynamicTools: declared, toolNames, routerNamespace } = await import('../server/router/tools.js')
  const expected = toolNames.map(name => routerNamespace + '/' + name).sort()
  const args = ['--strict-config', '--enable', 'shell_tool', '--enable', 'view_image', '--enable', 'goals',
    '--enable', 'code_mode_only', '-c', 'features.code_mode.direct_only_tool_namespaces=["codex_web_router"]']
  let app = await connect({ command: policyPath, args })
  try {
    const policy = await app.request('router/capabilities', {})
    assert.deepEqual([...policy.tools].sort(), expected)
    assert.equal(policy.policyVersion, 2)
    await assert.rejects(app.request('fs/readFile', { path: join(cwd, 'synthetic.txt') }), /Unsupported Router method/)
    await assert.rejects(app.request('command/exec', {}), /Unsupported Router method/)
    const started = await app.request('thread/start', {
      ...startParams(cwd),
      dynamicTools: [...declared, ...dynamicTools],
    })
    const threadId = started.thread.id
    async function checkRound(callId) {
      app.rpc.onServerRequest(request => {
        assert.equal(request.method, 'item/tool/call')
        assert.equal(request.params.namespace, routerNamespace)
        assert.equal(request.params.tool, 'list_projects')
        return { success: true, contentItems: [{ type: 'inputText', text: 'router policy fixture' }] }
      })
      model.enqueue({
        type: 'function_call', name: 'list_projects', namespace: routerNamespace,
        call_id: callId, arguments: '{}',
      }, assistantMessage('Policy fixture done.'))
      const from = model.requests.length
      await turn(app, threadId, 'check the explicit compiled policy')
      assert.deepEqual([...new Set(model.requests.slice(from).flatMap(toolInventory))].sort(), expected)
    }
    await checkRound('compiled-initial')
    const blocked = [
      { callId: 'blocked-compiled-exec', name: 'exec_command' },
      { callId: 'blocked-compiled-dynamic', name: toolName, namespace },
    ]
    for (const entry of blocked) {
      const from = app.events.length
      model.enqueue({
        type: 'function_call', name: entry.name, call_id: entry.callId, arguments: '{}',
        ...(entry.namespace ? { namespace: entry.namespace } : {}),
      }, assistantMessage('Compiled policy rejection.'))
      await turn(app, threadId, 'check the compiled denial')
      const result = model.requests.at(-1).input.find(item =>
        item.call_id === entry.callId && item.type === 'function_call_output')
      assert.match(JSON.stringify(result?.output), /unsupported (?:call|tool)|unknown tool|tool .*not found/i)
      assert.ok(app.events.slice(from).every(event => event.method !== 'item/tool/call'))
    }
    close(app)
    app = await connect({ command: policyPath, args })
    const resumed = await app.request('thread/resume', { threadId, excludeTurns: true })
    assert.equal(resumed.thread.id, threadId)
    await checkRound('compiled-resumed')
    const catalog = await app.request('model/list', { limit: 100 })
    const advertised = catalog.data?.find(item => item.supportedReasoningEfforts?.length)
    assert.ok(advertised, 'Fixture catalog has no supported model')
    await checkRouterAdapter({ policyPath, root, model, env, advertised, routerNamespace })
    return { version: policy.policyVersion, tools: expected, forbiddenRpcRejected: true,
      forbiddenToolCallsRejected: blocked.length, survivedRestart: true, workbenchAdapter: true }
  } finally {
    close(app)
  }
}

async function checkRouterAdapter({ policyPath, root, model, env, advertised, routerNamespace }) {
  const { connectRouterApp } = await import('../server/router/app-server.js')
  const directory = join(root, 'workbench-adapter')
  const codexHome = join(directory, 'codex-home')
  await mkdir(codexHome, { recursive: true })
  await writeFile(join(codexHome, 'config.toml'), await readFile(join(env.CODEX_HOME, 'config.toml')))
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const launcher = join(directory, 'launcher')
  const script = '#!/bin/sh\nexport CODEX_HOME=' + quote(codexHome) + '\nexec ' +
    quote(policyPath) + ' app-server --stdio --strict-config\n'
  await writeFile(launcher, script, { mode: 0o700 })
  const events = []
  const calls = []
  const app = await connectRouterApp({
    config: {
      launcher,
      launcherSha256: createHash('sha256').update(script).digest('hex'),
      models: [{ model: advertised.model, effort: advertised.supportedReasoningEfforts[0].reasoningEffort }],
    },
    directory,
    onClose() {},
    onEvent(method, params) { events.push({ method, params }) },
    onTool(params) {
      calls.push(params)
      return { success: true, contentItems: [{ type: 'inputText', text: 'adapter fixture' }] }
    },
  })
  try {
    const { thread } = await app.start()
    model.enqueue({
      type: 'function_call', name: 'list_projects', namespace: routerNamespace,
      call_id: 'adapter-fixture', arguments: '{}',
    }, assistantMessage('Adapter fixture done.'))
    const { turn } = await app.send(thread.id, '查询登记项目', 'router-adapter-fixture')
    await waitFor(events, event => event.method === 'turn/completed' && event.params.turn.id === turn.id, 'real adapter turn')
    assert.deepEqual(calls.map(call => [call.threadId, call.turnId, call.tool]), [[thread.id, turn.id, 'list_projects']])
    assert.match(JSON.stringify(model.requests.at(-1).input), /adapter fixture/)
  } finally {
    app.close()
  }
}

async function rolloutExists(path) {
  if (!path) return false
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function registerTool(app, threadId, toolReads) {
  let activeTurnId
  app.rpc.onNotification((method, params) => {
    if (method === 'turn/started' && params.threadId === threadId) activeTurnId = params.turn.id
  })
  app.rpc.onServerRequest(fixtureToolHandler({
    threadId,
    turnId: () => activeTurnId,
    lookup: key => { toolReads.push(key); return 'ROUTER_A1_FIXTURE_RESULT' },
  }))
}

async function turn(app, threadId, text) {
  const { turn: started } = await app.request('turn/start', { threadId, input: textInput(text), effort: 'low', environments: [] })
  return completedTurn(app, threadId, started.id)
}

async function completedTurn(app, threadId, turnId) {
  const event = await waitFor(app.events, entry =>
    entry.method === 'turn/completed' && entry.params.threadId === threadId && entry.params.turn.id === turnId,
  'completed fixture turn ' + turnId)
  assert.equal(event.params.turn.status, 'completed', JSON.stringify(event.params.turn))
  return event.params.turn
}

function checkToolEvents(app, threadId, turnId, callId, success) {
  const indexOf = (method, predicate) => app.events.findIndex(entry => {
    const params = entry.params
    return entry.method === method && params.threadId === threadId && params.turnId === turnId && predicate(params)
  })
  const started = indexOf('item/started', params => params.item.type === 'dynamicToolCall' && params.item.id === callId)
  const called = indexOf('item/tool/call', params => params.callId === callId && params.namespace === namespace && params.tool === toolName)
  const completed = indexOf('item/completed', params =>
    params.item.type === 'dynamicToolCall' && params.item.id === callId && params.item.success === success)
  assert.ok(started >= 0 && started < called && called < completed, 'Expected dynamic tool start, request and completion in order')
}

function toolInventory(request) {
  assert.ok(Array.isArray(request.tools), 'Expected a model-facing tools list')
  return request.tools.flatMap(tool => tool.type === 'namespace'
    ? tool.tools.map(child => tool.name + '/' + child.name)
    : [tool.name ?? tool.type]).sort()
}

async function checkDisabledCalls(app, threadId, model) {
  const names = [
    'exec_command', 'write_stdin', 'apply_patch', 'view_image',
    'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates',
    'multi_agent_v1/spawn_agent', 'create_goal', 'request_user_input', 'request_permissions',
  ]
  for (const fullName of names) {
    const [first, second] = fullName.split('/')
    const callId = 'disabled-' + (second ?? first)
    const from = app.events.length
    model.enqueue({
      type: 'function_call',
      name: second ?? first,
      ...(second ? { namespace: first } : {}),
      call_id: callId,
      arguments: '{}',
    }, assistantMessage('Denied fixture call.'))
    await turn(app, threadId, 'check disabled tool ' + fullName)
    const result = model.requests.at(-1).input.find(item => item.call_id === callId && item.type === 'function_call_output')
    assert.ok(result, 'Missing refusal result for ' + fullName)
    assert.match(JSON.stringify(result.output), /unsupported (?:call|tool)|unknown tool|tool .*not found/i, fullName)
    assert.ok(app.events.slice(from).every(entry =>
      entry.id === undefined || entry.method === undefined), 'Unexpected client request for ' + fullName)
  }
  return names
}

async function checkQueue({ app, close, connect, cwd, model }) {
  const { thread } = await app.request('thread/start', startParams(cwd))
  const add = (client, clientUserMessageId) => client.request('thread/queue/add', {
    threadId: thread.id, clientUserMessageId, input: textInput(clientUserMessageId),
  })
  const readQueue = client => client.request('thread/queue/list', { threadId: thread.id })
  const waitForUser = (client, clientId) => waitFor(client.events, entry =>
    entry.method === 'item/started' && entry.params.threadId === thread.id &&
    entry.params.item.type === 'userMessage' && entry.params.item.clientId === clientId,
  'user message ' + clientId)
  const release = Promise.withResolvers()
  model.enqueue(async () => {
    await release.promise
    return assistantMessage('First queued fixture done.')
  })
  try {
    const first = await add(app, 'a1-queue-fresh')
    assert.equal(first.queuedSubmission.clientUserMessageId, 'a1-queue-fresh')
    const firstEvent = await waitForUser(app, 'a1-queue-fresh')
    const cancelled = await add(app,'rcc-withdraw-before-start')
    assert.equal((await app.request('thread/queue/delete',{threadId:thread.id,queuedSubmissionId:cancelled.queuedSubmission.id})).deleted,true)
    assert.ok(!(await readQueue(app)).data.some(q=>q.id===cancelled.queuedSubmission.id))
    const duplicateA = await add(app, 'duplicate-fixture-id')
    const duplicateB = await add(app, 'duplicate-fixture-id')
    const duplicateIds = new Set([duplicateA.queuedSubmission.id, duplicateB.queuedSubmission.id])
    for (const queuedSubmissionId of duplicateIds) {
      assert.equal((await app.request('thread/queue/delete', { threadId: thread.id, queuedSubmissionId })).deleted, true)
    }
    const second = await add(app, 'a1-queue-busy')
    await assert.rejects(app.request('thread/queue/start', {
      threadId: thread.id, queuedSubmissionId: second.queuedSubmission.id,
    }), /already has an active or pending turn/i)
    assert.equal((await readQueue(app)).data[0].clientUserMessageId, 'a1-queue-busy')

    model.enqueue(assistantMessage('Second queued fixture done.'))
    release.resolve()
    const secondEvent = await waitForUser(app, 'a1-queue-busy')
    assert.notEqual(secondEvent.params.turnId, firstEvent.params.turnId)
    await completedTurn(app, thread.id, firstEvent.params.turnId)
    await completedTurn(app, thread.id, secondEvent.params.turnId)
    assert.deepEqual((await readQueue(app)).data, [])

    const stopped = Promise.withResolvers()
    let pendingAfterResume
    let explicitStart = false
    model.enqueue(async () => {
      await stopped.promise
      return assistantMessage('Interrupted queue test.')
    })
    try {
      const held = await app.request('turn/start', { threadId: thread.id, input: textInput('hold for restart') })
      assert.ok(held.turn.id)
      await waitFor(model.requests, body => JSON.stringify(body.input).includes('hold for restart'), 'held model request')
      const pending = await add(app, 'a1-queue-persisted')
      assert.equal((await readQueue(app)).data[0].id, pending.queuedSubmission.id)
      close(app)
      app = await connect()
      const recovered = await readQueue(app)
      assert.equal(recovered.data[0].id, pending.queuedSubmission.id)
      model.enqueue(assistantMessage('Recovered queued fixture done.'))
      await app.request('thread/resume', { threadId: thread.id, excludeTurns: true })
      pendingAfterResume = (await readQueue(app)).data.some(entry => entry.id === pending.queuedSubmission.id)
      let started
      if (pendingAfterResume) {
        try {
          started = await app.request('thread/queue/start', {
            threadId: thread.id, queuedSubmissionId: pending.queuedSubmission.id,
          })
          explicitStart = true
        } catch (error) {
          // A socket server may claim this exact submission between list and start.
          if (error.code !== -32600 || !/active|not found|pending/i.test(error.message)) throw error
        }
      }
      const recoveredEvent = await waitForUser(app, 'a1-queue-persisted')
      if (started) assert.equal(recoveredEvent.params.turnId, started.turn.id)
      await completedTurn(app, thread.id, recoveredEvent.params.turnId)
      const history = await app.request('thread/turns/list', { threadId: thread.id, itemsView: 'full' })
      assert.equal(history.data.filter(turn => turn.items.some(item => item.clientId === 'a1-queue-persisted')).length, 1)
      assert.deepEqual((await readQueue(app)).data, [])
    } finally {
      stopped.resolve()
    }
    return {
      duplicateClientIdEntries: duplicateIds.size,
      acceptedBeforeFirstUserMessage: true,
      busyStartRejected: true,
      autoDrainsAfterActiveTurn: true,
      survivedRestart: true,
      resumeAloneLeftQueuePending: pendingAfterResume,
      explicitQueueStartAfterResume: explicitStart,
      clientUserMessageIdFoundOnceInHistory: true,
    }
  } finally {
    release.resolve()
  }
}
