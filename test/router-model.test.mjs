import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectRouterApp, normalizeRouterConfig } from '../server/router/app-server.js'
import { routerNamespace, toolNames } from '../server/router/tools.js'
import { prepareWindowsRouterDirectory } from '../server/router/windows-access.js'

test('only Router defaults to Terra; explicit candidates remain authoritative', () => {
  const base = { enabled: true, launcher: '/fixture/router', launcherSha256: 'a'.repeat(64) }
  assert.deepEqual(normalizeRouterConfig(base).models, [{ model: 'gpt-6.1-terra', effort: 'high' }])
  const models = [{ model: 'fixture-custom', effort: 'medium' }]
  assert.deepEqual(normalizeRouterConfig({ ...base, models }).models, models)
  assert.deepEqual(normalizeRouterConfig(), { enabled: false })
  assert.throws(() => normalizeRouterConfig({ ...base, models: [] }), /候选模型/)
})

test('Router validates Terra and applies it to new, resumed and subsequent turns', async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-model-'))
  let app
  t.after(async () => {
    app?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const windows = process.platform === 'win32'
  const launcher = windows ? join(root, 'bin', 'launcher.exe') : join(root, 'launcher.cjs')
  const source = '#!' + process.execPath + '\n' + `
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  let result = { params }
  if (method === 'router/capabilities') result = { policyVersion: 2, tools: ${JSON.stringify(toolNames.map(name => routerNamespace + '/' + name))} }
  if (method === 'model/list') result = { data: [{ model: 'gpt-6.1-terra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { model: 'other', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
  if (method === 'turn/start' && params.outputSchema) {
    const turn = {id:'intent-test',status:'completed',items:[{type:'agentMessage',text:JSON.stringify({
      operation:'read',view:'overview',scope:'all',projects:[],topic:'',status:'any',page:1,work:''})}]}
    if (params.clientUserMessageId !== 'router-intent:test-query-123' || params.outputSchema.additionalProperties !== false ||
        params.threadId !== 'previous-sol-thread' || !params.additionalContext['workspace-operation']) process.exit(2)
    process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:params.threadId,turn}})+'\\n')
    result={turn:{id:turn.id,status:'inProgress'}}
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
})
`
  if (windows) {
    await prepareWindowsRouterDirectory(join(root, 'bin'))
    await copyFile(process.execPath, launcher)
    // Node invoked with the fixture directory executes its index.js entry point.
    await writeFile(join(root, 'index.js'), source)
  } else {
    await writeFile(launcher, source)
    await chmod(launcher, 0o700)
  }
  const config = normalizeRouterConfig({ enabled: true, launcher,
    launcherSha256: createHash('sha256').update(await readFile(launcher)).digest('hex') })
  app = await connectRouterApp({ config, directory: root, onEvent() {}, onTool() {}, onClose() {} })
  assert.equal(app.selected.model, 'gpt-6.1-terra')
  assert.equal((await app.start()).params.model, 'gpt-6.1-terra')
  const resumed = (await app.resume('previous-sol-thread')).params
  assert.equal(resumed.model, 'gpt-6.1-terra')
  assert.equal(resumed.threadId, 'previous-sol-thread')
  assert.equal(resumed.approvalPolicy, 'never')
  const intent = await app.classify('previous-sol-thread','这些项目都是干啥的','test-query-123',{})
  assert.equal(intent.view,'overview')
  const sent = (await app.send('previous-sol-thread', 'hello', 'request-id-1234')).params
  assert.equal(sent.model, 'gpt-6.1-terra')
  assert.equal(sent.effort, 'high')
  assert.match(sent.input[0].text, /当前 Router requestId/)
  const inboxId = 'wx-' + 'a'.repeat(64)
  const phone = (await app.send('previous-sol-thread', '原问题', inboxId, {channel:'wechat'})).params
  assert.equal(phone.clientUserMessageId, inboxId)
  assert.match(phone.input[0].text, /当前 Router requestId: current\]/)
  assert.ok(!phone.input[0].text.includes(inboxId))
  const context = sent.additionalContext?.['router-instructions']
  assert.equal(context?.kind, 'application')
  assert.equal(context.value, resumed.developerInstructions)
  assert.match(context.value, /create_session.*new:项目名.*HTTPS/)
  const requestId = 'router-receipt:fixture-batch:1'
  assert.equal(app.resolveSelection({ model: 'other', effort: 'high' }), null)
  app.select(app.resolveSelection({ model: 'other', effort: 'low' }))
  const receipt = (await app.send('previous-sol-thread', 'Worker receipt fixture', requestId, { workerReceipt: true })).params
  assert.equal(receipt.threadId, 'previous-sol-thread')
  assert.equal(receipt.model, 'other')
  assert.equal(receipt.effort, 'low')
  app.select(null)
  assert.equal(app.selected.effort, 'high')
  assert.equal(receipt.clientUserMessageId, requestId)
  assert.equal(receipt.input[0].text, 'Worker receipt fixture')
  assert.equal(receipt.additionalContext, undefined)
  const presentation = {displayName:'南桥',selfName:'我',personality:'温和',style:'直接',brevity:'简洁',wechatStyle:'短句'}
  for (const channel of ['web','wechat','receipt']) {
    const params = (await app.send(receipt.threadId,'hello','voice-scope-1234',{presentation,channel,workerReceipt:channel==='receipt'})).params
    assert.equal(params.threadId,receipt.threadId)
    assert.deepEqual(params.sandboxPolicy,receipt.sandboxPolicy)
    assert.equal(params.approvalPolicy,receipt.approvalPolicy)
    const voice = params.additionalContext['router-voice'].value
    assert.match(voice,/南桥/)
    assert.equal(voice.includes('微信表达'),channel==='wechat')
    assert.equal(Boolean(params.additionalContext['router-instructions']),channel!=='receipt')
  }
  assert.deepEqual(receipt.sandboxPolicy, { type: 'readOnly', networkAccess: false })
})
