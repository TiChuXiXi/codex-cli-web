// Explicitly opt in. Uses the installed CLI and its existing managed ChatGPT login.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { connectAppServer } from '../test/fixtures/router-app-server.mjs'
import { r3Catalog } from '../test/fixtures/uas-r3-catalog.mjs'
import { dynamicTools } from '../server/router/tools.js'

assert.equal(process.env.ZCODEX_R3_LIVE, '1', 'requires explicit current-account authorization')
const [binary, candidateFlag] = process.argv.slice(2)
const candidate = candidateFlag === '--candidate'
assert.ok(!candidateFlag || candidate)
assert.ok(binary && isAbsolute(binary))
const home = process.env.CODEX_HOME || join(homedir(), '.codex')
const tmp = await mkdtemp('/var/tmp/zcodex-r3-account-')
const mode = process.env.ZCODEX_R3_MODEL || 'gpt-6.1-sol'
const telemetryPath = '/' + randomUUID()
const evidence = { platform: process.platform, arch: process.arch,
  cli: execFileSync(binary, ['--version'], {encoding:'utf8'}).trim(), currentHome: true,
  ephemeral: false, model: mode, submitted: [], websocketRequestObserved: false, naturalRefresh: 'unverified' }
const collector = createServer(async (request, response) => {
  if (request.url !== telemetryPath || request.method !== 'POST') return response.writeHead(404).end()
  try {
    let length = 0
    const chunks = []
    for await (const chunk of request) {
      length += chunk.length
      if (length > 4 * 1024 * 1024) return response.writeHead(413).end()
      chunks.push(chunk)
    }
    const data = JSON.parse(Buffer.concat(chunks))
    for (const resource of data.resourceLogs ?? []) for (const scope of resource.scopeLogs ?? []) {
      for (const rec of scope.logRecords ?? []) {
        const attrs = Object.fromEntries((rec.attributes ?? []).map(a => [a.key, a.value?.stringValue ?? a.value?.boolValue]))
        if (attrs['event.name'] === 'codex.websocket_request' && String(attrs.success) === 'true')
          evidence.websocketRequestObserved = true
      }
    }
    response.writeHead(200, { 'content-type':'application/json' }).end('{}')
  } catch { response.writeHead(400).end() }
})
let app
try {
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + collector.address().port + telemetryPath
  const config = await readFile(join(home, 'config.toml'), 'utf8')
  const names = [...config.matchAll(/^\s*\[mcp_servers\.([a-zA-Z0-9_-]+)\]/gm)].map(match => match[1])
  const catalog = r3Catalog(mode)
  const catalogFile = join(tmp, 'catalog.json')
  await writeFile(catalogFile, JSON.stringify(catalog), { mode: 0o400 })
  const opts = [...(candidate ? ['sqlite_home=' + JSON.stringify(tmp), 'log_dir=' + JSON.stringify(tmp)] : []), 'model_catalog_json=' + JSON.stringify(catalogFile), 'project_doc_max_bytes=0', 'web_search="disabled"',
    'features.shell_tool=false','features.view_image=false','features.image_generation=false','features.apps=false',
    'features.hooks=false','features.plugins=false','features.multi_agent_v2=false','features.goals=false',
    'agents.enabled=false','tools.update_plan.enabled=false','tools.experimental_request_user_input.enabled=false',
    'skills.include_instructions=false','skills.bundled.enabled=false','memories.use_memories=false','memories.generate_memories=false',
    'analytics.enabled=false','otel.log_user_prompt=false','otel.trace_exporter="none"','otel.metrics_exporter="none"',
    'otel.exporter={otlp-http={endpoint=' + JSON.stringify(endpoint) + ',protocol="json",headers={}}}',
    ...names.map(n => 'mcp_servers.' + n + '.enabled=false')]
  // A new binary must not run SQLite migrations or update files in the existing Home.
  // The bind is read-only at the same absolute path. The account and network are the host's.
  if (candidate) {
    await mkdir(join(tmp, 'cli-tmp'), { mode: 0o700 })
    await copyFile(join(home, 'installation_id'), join(tmp, 'installation_id'))
    const h = createHash('sha256')
    for await (const part of createReadStream(binary)) h.update(part)
    assert.equal(h.digest('hex'), '28c24ad7fb3bf29c95cd66a12e72d2219f06170efefae8b02002ceb50e2866b9')
  }
  app = await connectAppServer({ command: candidate ? '/usr/bin/bwrap' : binary, cwd: '/',
    prefix: candidate ? ['--die-with-parent','--ro-bind','/','/','--dev','/dev','--proc','/proc','--bind',tmp,tmp,'--bind',join(tmp,'cli-tmp'),join(home,'tmp'),
      '--bind',join(tmp,'installation_id'),join(home,'installation_id'),'--',binary] : [],
    env: candidate ? { ...process.env, TMPDIR:tmp } : process.env,
    args: ['--stdio', '--strict-config', ...opts.flatMap(o => ['-c', o])] })
  const { process: server } = await app.request('server/diagnostics', {})
  assert.ok(Number.isSafeInteger(server?.id) && server.id > 0)
  const digest = createHash('sha256')
  for await (const part of createReadStream('/proc/' + server.id + '/exe')) digest.update(part)
  evidence.runningSha256 = digest.digest('hex')
  const read = await app.request('account/read', { refreshToken: false })
  assert.equal(read.account?.type, 'chatgpt')
  evidence.authMode = read.account.type
  const started = await app.request('thread/start', { model: mode, modelProvider: 'openai', cwd: '/', ephemeral: true,
    baseInstructions: 'Respond only to the synthetic test.', developerInstructions: 'Use no tools. Return the requested marker only.',
    environments: [], sandbox: 'read-only', approvalPolicy: 'never', dynamicTools })
  assert.equal(started.thread.ephemeral, true)
  evidence.ephemeral = true
  assert.equal(started.modelProvider, 'openai')
  assert.equal(started.sandbox.type, 'readOnly')
  const { data } = await app.request('mcpServerStatus/list', { threadId: started.thread.id })
  assert.ok(data.every(s => Object.keys(s.tools ?? {}).length === 0), 'active MCP tools')
  evidence.instructionSourceCount = started.instructionSources?.length ?? null
  // Current user-level instructions may describe personal data. No workspace history may enter the check.
  const sources = started.instructionSources ?? []
  for (const path of sources) {
    assert.ok(path === join(home, 'AGENTS.md') || path === join(home, 'AGENTS.override.md'), 'unexpected instruction source')
    // The operator can allow a previously reviewed user preference by its digest.
    const text = await readFile(path, 'utf8')
    assert.equal(createHash('sha256').update(text).digest('hex'), process.env.ZCODEX_R3_INSTRUCTIONS_SHA256, 'unreviewed global instructions')
  }
  app.rpc.onServerRequest(() => ({ success:false, contentItems:[{ type:'inputText', text:'Tools unavailable in account check' }] }))
  const marker = 'UAS-R3-' + randomUUID().slice(0,8)
  const operations = [['turn/start','Return exactly ' + marker], ['thread/compact/start']]
  if (!candidate) operations.push(['turn/start','Repeat the exact marker from the first user message.'])
  for (const [method, input] of operations) {
    const index = app.events.length
    const step = { method }
    evidence.submitted.push(step)
    await app.request(method, { threadId: started.thread.id, ...(input && { input:[{type:'text',text:input}] }) })
    const until = Date.now() + 100000
    let terminal
    while (Date.now() < until) {
      terminal = app.events.slice(index).find(e => e.method === 'turn/completed' && e.params.threadId === started.thread.id)
      if (terminal) break
      await delay(50)
    }
    assert.ok(terminal, 'turn timeout')
    step.status = terminal.params.turn.status
    step.itemTypes = terminal.params.turn.items.map(i=>i.type)
    const messages = app.events.slice(index)
    step.compactionItem = messages.some(e => e.method === 'item/completed' && e.params.item?.type === 'contextCompaction')
    step.deltas = messages.filter(e => e.method === 'item/agentMessage/delta').length
    if (step.status !== 'completed') {
      const error = terminal.params.turn.error
      step.errorKind = typeof error?.codexErrorInfo === 'string' ? error.codexErrorInfo : Object.keys(error?.codexErrorInfo ?? {})[0]
      throw Error('native turn failed')
    }
    if (input) {
      step.marker = messages.some(e => e.method === 'item/completed' && e.params.item?.type === 'agentMessage' && e.params.item.text.trim() === marker)
      assert.ok(step.marker && step.deltas)
    } else assert.ok(step.itemTypes.includes('contextCompaction') || messages.some(e=>e.method==='item/completed' && e.params.item?.type==='contextCompaction'))
  }
  await delay(5500)
} catch (error) {
  // Raw provider and startup errors may include account details or routing data.
  evidence.failure = error.message === 'native turn failed' ? error.message :
    (evidence.submitted.length === 0 ? 'preflight or startup failed' : 'protocol check failed')
  process.exitCode = 1
} finally {
  app?.close()
  collector.closeAllConnections()
  await new Promise(resolve => collector.close(resolve))
  await rm(tmp, { recursive:true, force:true })
  console.log(JSON.stringify(evidence, null, 2))
}
