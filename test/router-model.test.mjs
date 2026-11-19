import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectRouterApp, normalizeRouterConfig } from '../server/router/app-server.js'
import { routerNamespace, toolNames } from '../server/router/tools.js'

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
  t.after(() => rm(root, { recursive: true, force: true }))
  const launcher = join(root, 'launcher.cjs')
  const source = '#!' + process.execPath + '\n' + `
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  let result = { params }
  if (method === 'router/capabilities') result = { policyVersion: 2, tools: ${JSON.stringify(toolNames.map(name => routerNamespace + '/' + name))} }
  if (method === 'model/list') result = { data: [{ model: 'gpt-6.1-terra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { model: 'other', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
})
`
  await writeFile(launcher, source)
  await chmod(launcher, 0o700)
  const config = normalizeRouterConfig({ enabled: true, launcher,
    launcherSha256: createHash('sha256').update(source).digest('hex') })
  const app = await connectRouterApp({ config, directory: root, onEvent() {}, onTool() {}, onClose() {} })
  t.after(() => app.close())
  assert.equal(app.selected.model, 'gpt-6.1-terra')
  assert.equal((await app.start()).params.model, 'gpt-6.1-terra')
  const resumed = (await app.resume('previous-sol-thread')).params
  assert.equal(resumed.model, 'gpt-6.1-terra')
  assert.equal(resumed.threadId, 'previous-sol-thread')
  assert.equal(resumed.approvalPolicy, 'never')
  const sent = (await app.send('previous-sol-thread', 'hello', 'request-id-1234')).params
  assert.equal(sent.model, 'gpt-6.1-terra')
  assert.equal(sent.effort, 'high')
  assert.match(sent.input[0].text, /当前 Router requestId/)
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
  assert.deepEqual(receipt.sandboxPolicy, { type: 'readOnly', networkAccess: false })
})
