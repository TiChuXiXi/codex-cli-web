import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, dirname } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { CodexHub } from '../server/codex/hub.js'
import { normalizeConfig } from '../server/codex/config.js'
import { StdioTransport } from '../server/codex/transport/stdio.js'
import { EventBus } from '../server/services/events.js'
import { FollowupQueue } from '../server/services/followups.js'
import { RouterService } from '../server/router/service.js'

const stock = process.env.CODEX_WEB_CODEX_PATH
const policy = process.env.CODEX_WEB_ROUTER_POLICY_PATH
const legacyPolicy = process.env.CODEX_WEB_ROUTER_LEGACY_POLICY_PATH
const authHome = process.env.CODEX_WEB_ROUTER_AUTH_HOME
const model = process.env.CODEX_WEB_ROUTER_LIVE_MODEL
const effort = process.env.CODEX_WEB_ROUTER_LIVE_EFFORT
if (process.env.CODEX_WEB_ROUTER_A2 !== '1' ||
    ![stock, policy, authHome].every(path => typeof path === 'string' && isAbsolute(path)) ||
    !model || !effort || !/^gpt-[a-zA-Z0-9.-]+$/.test(model) ||
    !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) {
  throw new Error('A2 requires explicit authorization, absolute binary/auth paths, model and effort')
}

const root = await mkdtemp('/tmp/codex-router-a2-')
const events = new EventBus()
let hub, followups, router
let stage = 'auth'
const report = { model, effort }
let currentMessage
try {
  const input = JSON.parse(await readFile(join(authHome, 'auth.json'), 'utf8'))
  const { id_token, access_token, account_id } = input.tokens ?? {}
  assert.equal(input.auth_mode, 'chatgpt')
  assert.ok(id_token && access_token && account_id, 'Current account has no reusable access token')
  const expires = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url')).exp
  assert.ok(Number.isFinite(expires) && expires > Date.now() / 1000 + 300, 'Current account access token is about to expire')
  const snapshot = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token, access_token, account_id, refresh_token: '' },
    last_refresh: new Date().toISOString(),
  })
  const stateDir = join(root, 'web')
  const routerRoot = join(stateDir, 'router')
  const routerHome = join(routerRoot, 'codex-home')
  const workerHome = join(root, 'worker-codex')
  const workerShellHome = join(root, 'worker-home')
  const project = join(root, 'worker-project')
  await Promise.all([routerHome, workerHome, workerShellHome, project].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  for (const home of [routerHome, workerHome]) {
    await writeFile(join(home, 'auth.json'), snapshot, { flag: 'wx', mode: 0o600 })
  }
  await writeFile(join(workerHome, 'config.toml'), [
    'cli_auth_credentials_store = "file"',
    'model = "' + model + '"',
    'model_reasoning_effort = "' + effort + '"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'developer_instructions = "This is an isolated text-only acceptance fixture. Reply with exactly ROUTER_WORKER_OK. Do not call tools or inspect files."',
    '[analytics]', 'enabled = false',
    '[agents]', 'enabled = false',
    '[features]', 'apps = false', 'plugins = false', 'hooks = false', 'shell_tool = false',
    'goals = false', 'view_image = false', 'multi_agent_v2 = false',
    '[tools.update_plan]', 'enabled = false',
    '[tools.experimental_request_user_input]', 'enabled = false', '',
  ].join('\n'), { flag: 'wx', mode: 0o600 })
  const proxy = Object.fromEntries(['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]))
  const launcher = join(root, 'router-launcher')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const proxyExports = Object.entries(proxy).map(([key, value]) => 'export ' + key + '=' + quote(value))
  if (legacyPolicy && (!isAbsolute(legacyPolicy) || process.env.CODEX_WEB_PSM_LIVE!=='1')) throw Error('Legacy upgrade requires an explicit PSM target')
  const launchFor = binary => ['#!/bin/sh', 'export CODEX_HOME=' + quote(routerHome), ...proxyExports,
    'exec ' + quote(binary) + ' app-server --stdio --strict-config', ''].join('\n')
  const launch=launchFor(legacyPolicy || policy)
  await writeFile(launcher, launch, { flag: 'wx', mode: 0o700 })
  const audit = []
  events.subscribe(event => {
    if (event.type === 'approval/requested' || event.type === 'turn/completed') audit.push(event)
  })

  stage = 'private-app-servers'
  hub = new CodexHub({
    bus: events,
    config: normalizeConfig({ transport: 'stdio', codexHome: workerHome, codexPath: stock }),
    openTransport: async () => {
      const transport = new StdioTransport({
        command: stock, cwd: project, args: ['app-server', '--stdio', '--strict-config'],
        env: { ...proxy, HOME: workerShellHome, CODEX_HOME: workerHome,
          PATH: dirname(process.execPath) + ':/usr/bin:/bin' },
      })
      await transport.open()
      return { transport, kind: 'stdio', socketPath: null }
    },
  })
  followups = new FollowupQueue({ hub, bus: events })
  const settings = {
    enabled: true, launcher, launcherSha256: createHash('sha256').update(launch).digest('hex'),
    models: [{ model, effort }],
    projects: [{ id: 'router-acceptance', name: 'Router验收项目', cwd: project, sandbox: 'read-only' }],
  }
  hub.start()
  router = new RouterService({ config: settings, stateDir, hub, followups, bus: events })
  router.start()
  await poll(() => hub.status().phase === 'ready' && router.status().phase !== 'connecting', 45000)
  assert.equal(router.status().phase, 'ready', 'Policy validation or real account model selection failed')
  assert.equal(router.read().model, model)

  stage = 'plain-chat'
  const chat = await message('仅回复 ROUTER_CHAT_OK。不要调用任何工具。')
  assert.match(chat.text, /ROUTER_CHAT_OK/)
  assert.deepEqual(router.read().tasks, [])
  report.chat = { result: 'passed', ms: chat.ms }

  stage = 'dispatch'
  const reply = await message('请在 Router验收项目中新建 Worker 会话并派发这个任务：仅回复 ROUTER_WORKER_OK。' +
    '这是纯文本验收。Worker 不读取文件、不运行命令、不调用任何工具。')
  const toolNames = router.store.list('tool-call').map(call => call.tool)
  report.dispatch = { result: 'checking', ms: reply.ms, tools: [...new Set(toolNames)] }
  assert.ok(toolNames.includes('list_projects'), 'Router did not call list_projects')
  assert.ok(toolNames.includes('dispatch_task'), 'Router did not call dispatch_task')
  const task = fixtureTask(reply.requestId)
  report.dispatch.result = 'passed'

  stage = 'worker-text-only'
  const completed = await poll(() => {
    const current = router.getTask(task.id)
    return ['completed', 'failed', 'unknown', 'awaiting_approval', 'interrupted'].includes(current.status) ? current : null
  }, 90000)
  report.worker = { result: 'checking', status: completed.status, error: completed.error ?? null }
  if (completed.status === 'failed' && completed.threadId) {
    const detail = await hub.routerReadWorker(completed.threadId).catch(() => null)
    report.worker.turnStatus = detail?.turns.find(turn => turn.id === completed.turnId)?.status ?? null
  }
  assert.equal(completed.status, 'completed', 'Worker did not finish without approval')
  assert.equal(audit.filter(event => event.type === 'approval/requested').length, 0)
  const detail = await hub.routerReadWorker(completed.threadId)
  const linked = detail.turns.filter(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === task.id))
  assert.equal(linked.length, 1)
  assert.equal(linked[0].id, completed.turnId)
  const executionItems = linked[0].items.filter(item => ['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type))
  const answer = linked[0].items.findLast(item => item.type === 'agentMessage')?.text ?? ''
  report.worker.executionItems = [...new Set(executionItems.map(item => item.type))]
  report.worker.failedExecutionItems = executionItems.filter(item => item.status === 'failed').length
  report.worker.historyItemTypes = [...new Set(linked[0].items.map(item => item.type))]
  report.worker.replyMatched = /ROUTER_WORKER_OK/.test(answer)
  report.worker.summaryMatched = /ROUTER_WORKER_OK/.test(completed.summary ?? '')
  assert.equal(executionItems.length, 0, 'Worker history contained execution items')
  assert.deepEqual(await readdir(project), [])
  assert.equal(report.worker.replyMatched, true, 'Worker history did not contain the expected reply')
  assert.equal(report.worker.summaryMatched, true, 'Router task did not contain the expected reply')
  report.worker = { result: 'passed', status: completed.status, historyMatches: linked.length }

  stage = 'resume-worker'
  const callCount = router.store.list('tool-call').length
  const followup = await message('请把这条纯文本验收任务交回刚才回复 ROUTER_WORKER_OK 的原 Worker 会话：' +
    '由 Worker 再回复一次相同结果。Worker 不需要使用工具。')
  const followupTools = router.store.list('tool-call').slice(0, -callCount).map(call => call.tool)
  assert.ok(followupTools.includes('dispatch_task'), 'Router did not dispatch to an existing Worker')
  const resumed = fixtureTask(followup.requestId)
  const resumedResult = await poll(() => {
    const current = router.getTask(resumed.id)
    return ['completed', 'failed', 'unknown', 'awaiting_approval', 'interrupted'].includes(current.status) ? current : null
  }, 90000)
  assert.equal(resumedResult.status, 'completed', 'Existing Worker did not complete')
  assert.equal(resumedResult.threadId, completed.threadId)
  assert.notEqual(resumedResult.turnId, completed.turnId)
  assert.match(resumedResult.summary ?? '', /ROUTER_WORKER_OK/)
  const resumedHistory = await hub.routerReadWorker(resumedResult.threadId)
  const resumedTurns = resumedHistory.turns.filter(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === resumed.id))
  assert.equal(resumedTurns.length, 1)
  assert.equal(resumedTurns[0].id, resumedResult.turnId)
  assert.ok(resumedTurns[0].items.every(item => !['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)),
    'Existing Worker history contained execution items')
  assert.equal(audit.filter(event => event.type === 'approval/requested').length, 0)
  assert.deepEqual(await readdir(project), [])
  report.resumeWorker = { result: 'passed', ms: followup.ms, sameThread: true, separateTurn: true, historyMatches: resumedTurns.length }

  stage = 'query-status'
  const status = await message('请使用 get_task_status 查询以下本次验收的任务 ID ' + resumed.id + ' 的结果，只报告实际状态。')
  assert.ok(router.store.list('tool-call').some(call => call.tool === 'get_task_status'), 'Router did not call get_task_status')
  report.status = { result: 'passed', ms: status.ms }

  if(process.env.CODEX_WEB_PSM_LIVE==='1') {
    stage='psm-history'
    if (legacyPolicy) {
      stage='psm-upgrade'
      const oldPrimary=router.session.id
      assert.equal(router.app.policyVersion,1)
      await router.close()
      const upgraded=launchFor(policy)
      await writeFile(launcher,upgraded,{mode:0o700})
      settings.launcherSha256=createHash('sha256').update(upgraded).digest('hex')
      router=new RouterService({config:settings,stateDir,hub,followups,bus:events})
      router.start()
      await router.opening
      assert.equal(router.session.id,oldPrimary)
      assert.equal(router.app.policyVersion,2)
      await router.psm.control({action:'enable'})
      await poll(()=>router.session.id!==oldPrimary,90000)
      assert.ok((await router.history({threadId:oldPrimary})).messages.length)
      assert.equal(router.store.get('psm-upgrade',oldPrimary).phase,'committed')
      report.psmUpgrade={oldHistoryReadable:true,primaryChanged:true}
      stage='psm-history'
    } else await router.psm.control({action:'enable'})
    await router.psm.sync.running
    const hits=await router.psm.search({query:'ROUTER_WORKER_OK'})
    const raw=hits.find(hit=>hit.ref.startsWith('msg:') && hit.threadId===completed.threadId)
    assert.ok(raw,'Missing original Worker text')
    const verified=await router.psm.get(raw.ref)
    assert.match(verified.text,/ROUTER_WORKER_OK/)
    const known=new Set(router.store.list('tool-call').map(call=>call.at))
    await message('只查询历史：请用 psm_search 检索 ROUTER_WORKER_OK，选一条 msg: 消息引用用 psm_get 回源验证，然后告诉我 Worker 回复了什么。不要派发。')
    const calls=router.store.list('tool-call').filter(c=>!known.has(c.at))
    assert.ok(calls.some(c=>c.tool==='psm_search') && calls.some(c=>c.tool==='psm_get'))
    assert.equal(router.store.list('task').length,2)
    report.psm={realHistory:true,rawMessageVerified:true,routerSearchAndRead:true}
  }

  stage = 'restart'
  const threadId = router.session.id
  await router.close()
  router = new RouterService({ config: settings, stateDir, hub, followups, bus: events })
  router.start()
  await poll(() => router.status().phase !== 'connecting', 45000)
  assert.equal(router.status().phase, 'ready')
  assert.equal(router.session.id, threadId)
  assert.equal(router.getTask(task.id).status, 'completed')
  assert.equal(router.getTask(resumed.id).status, 'completed')
  report.restart = { result: 'passed', sameThread: true, retainedTasks: 2 }
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.log(JSON.stringify({
    ...report, failedStage: stage, error: error.code ?? error.name,
    reason: error instanceof assert.AssertionError ? error.message.split('\n')[0] :
      error.message === 'Live acceptance timeout' ? '等待验收结果超时' : '连接或协议未达到预期结果',
    ...(currentMessage ? { messageStatus: router?.read().messages.find(item => item.id === currentMessage)?.status } : {}),
  }, null, 2))
  process.exitCode = 1
} finally {
  await Promise.allSettled([router?.close(), hub?.stop()])
  followups?.dispose()
  events.dispose()
  // Give both private stdio children time to release their state after transport shutdown.
  await pause(2100)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function fixtureTask(requestId) {
  assert.ok(!router.store.list('clarification').some(row => row.requestId === requestId),
    'Unambiguous task requested an extra confirmation')
  const task = router.store.list('task').find(item => item.requestId === requestId)
  assert.ok(task, 'Router did not hand off the authorized fixture task')
  assert.equal(task.projectId, 'router-acceptance')
  return task
}

async function message(text) {
  const before = new Set(router.read().messages.map(item => item.id))
  const start = Date.now()
  const requestId = randomUUID()
  const receipt = await router.send({ requestId, text })
  currentMessage = receipt.id
  const completed = await poll(() => {
    const state = router.read()
    const user = state.messages.find(item => item.id === receipt.id)
    return user && !state.busy ? state : null
  }, 90000)
  const user = completed.messages.find(item => item.id === receipt.id)
  assert.equal(user.status, 'completed', 'Router turn did not complete')
  const answer = completed.messages.filter(item => item.role === 'assistant' && !before.has(item.id)).at(-1)
  assert.ok(answer, 'Router did not return an assistant message')
  return { requestId, text: answer.text, ms: Date.now() - start }
}

async function poll(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (let value; Date.now() < deadline;) {
    value = check()
    if (value) return value
    await pause(100)
  }
  throw new Error('Live acceptance timeout')
}
