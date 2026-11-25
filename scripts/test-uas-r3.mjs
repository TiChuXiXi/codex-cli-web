// Opt-in Linux protocol experiment. The outer network namespace has loopback only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { join, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { WebSocketServer } from 'ws'
import { connectAppServer, waitFor, assistantMessage } from '../test/fixtures/router-app-server.mjs'
import { r3Catalog } from '../test/fixtures/uas-r3-catalog.mjs'
import { dynamicTools, routerNamespace, toolNames } from '../server/router/tools.js'

const [binary, model = 'gpt-5.4'] = process.argv.slice(2)
assert.ok(['gpt-5.4', 'gpt-6.1-sol'].includes(model))
assert.ok(binary && isAbsolute(binary), 'pass the absolute path of the official native executable')
const hash = createHash('sha256')
for await (const chunk of createReadStream(binary)) hash.update(chunk)
const sha256 = hash.digest('hex')
assert.equal(sha256, '28c24ad7fb3bf29c95cd66a12e72d2219f06170efefae8b02002ceb50e2866b9')
const net = await readlink('/proc/self/ns/net')
if (!process.env.R3_PARENT_NS) {
  const child = spawnSync('/usr/bin/unshare', ['--net', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL',
    '--', process.execPath, fileURLToPath(import.meta.url), binary, model], {
    stdio: 'inherit', timeout: 150000, env: { PATH: '/usr/bin:/bin', R3_PARENT_NS: net },
  })
  if (child.error) throw child.error
  process.exitCode = child.status ?? 1
} else {
  assert.notEqual(net, process.env.R3_PARENT_NS)
  assert.deepEqual(JSON.parse(execFileSync('/usr/sbin/ip', ['-j', 'link'])).map(i => i.ifname), ['lo'])
  execFileSync('/usr/sbin/ip', ['link', 'set', 'lo', 'up'])
  const scenarios = []
  for (const mode of ['ws', 'sse', 'catalog-control', 'auth-tool-control', 'guard-sse', 'guard-drift', 'expired-token']) {
    const approved = '5505003c7daf6ad808028ec906176ac4bc4210b69076b4644cd96efe20e46fad'
    scenarios.push(await experiment(mode, approved))
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, model, sha256, network: ['lo'],
    actualAccount: false, inferenceProvider: 'official built-in openai routed to local fixture', scenarios }, null, 2))
}

function token(exp) {
  const payload = { exp, email: 'test@example.invalid',
    'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-r3', chatgpt_plan_type: 'plus' } }
  return 'e30.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.fixture'
}

function digestTools(tools) {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex')
}

// Lab-only HTTP validator. The only upstream is the local fixture; response bytes stream untouched.
function requestGate(approved, origin, stats) {
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== '/v1/responses' || req.method !== 'POST') return res.writeHead(404).end()
      const encoding = req.headers['content-encoding']
      if (encoding && encoding !== 'zstd') return res.writeHead(415).end()
      const parts = []
      let total = 0
      for await (const part of req) {
        total += part.length
        if (total > 2 * 1024 * 1024) return res.writeHead(413).end()
        parts.push(part)
      }
      const bytes = Buffer.concat(parts)
      const request = JSON.parse(encoding ? zstdDecompressSync(bytes, { maxOutputLength: 2 * 1024 * 1024 }) : bytes)
      if (request.model !== model || digestTools(request.tools) !== approved) {
        stats.rejected++
        return res.writeHead(403, { 'content-type':'application/json' }).end('{"error":{"message":"unqualified model request"}}')
      }
      const upstream = httpRequest(origin + '/v1/responses', {method:'POST', headers:{
        'content-type':'application/json', 'content-length': bytes.length, ...(encoding && { 'content-encoding': encoding }), authorization: req.headers.authorization,
        'chatgpt-account-id': req.headers['chatgpt-account-id'] }})
      res.once('close', () => upstream.destroy())
      upstream.on('error', () => res.destroy())
      upstream.on('response', async incoming => {
        res.writeHead(incoming.statusCode, { 'content-type': incoming.headers['content-type'] ?? 'application/octet-stream' })
        try { await pipeline(incoming, res) } catch { incoming.destroy() }
      })
      stats.forwarded++
      upstream.end(bytes)
    } catch { res.writeHead(400).end() }
  })
  server.on('upgrade', (_req, socket) => {
    stats.upgradesDeclined++
    socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  return server
}

async function experiment(mode, approved) {
  const root = await mkdtemp('/var/tmp/zcodex-r3-test-')
  const home = join(root, 'home'), cwd = join(root, 'workspace')
  const catalog = r3Catalog(model, mode === 'catalog-control' || mode === 'guard-drift')
  const expected = toolNames.map(n => routerNamespace + '/' + n).sort()
  const report = { mode, catalogSha256: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'), refresh: 0, authenticatedRequests: 0, websocketHandshakes: 0, remoteCatalogReads: 0,
    requests: [], streamedBeforeCompletion: false }
  const now = Math.floor(Date.now() / 1000)
  const fresh = token(now + 3600)
  const expiredAtStartup = mode === 'expired-token'
  const initial = token(now + (expiredAtStartup ? -3600 : 1800))
  let compacting = false, app, gate, id = 0
  const sockets = new WebSocketServer({ noServer: true })
  const errors = [], paths = []
  function checkAuth(headers) {
    assert.equal(headers.authorization === 'Bearer ' + fresh, true, 'official client must use refreshed credential')
    assert.equal(headers['chatgpt-account-id'] === 'synthetic-r3', true, 'synthetic account not selected')
    report.authenticatedRequests++
  }
  async function reply(body, wire, send, end) {
    const responseId = 'resp_r3_' + ++id
    const itemId = 'msg_r3_' + id
    const emit = (type, fields) => send({ type, ...fields })
    const inventory = (body.tools ?? []).flatMap(t => t.type === 'namespace' ?
      t.tools.map(f => t.name + '/' + f.name) : [t.name ?? t.type]).sort()
    const trigger = (body.input ?? []).some(i => i.type === 'compaction_trigger')
    const prewarm = body.generate === false
    report.requests.push({ wire, prewarm, trigger, toolDigest: digestTools(body.tools ?? []), count: inventory.length, extras: inventory.filter(n => !expected.includes(n)),
      missing: expected.filter(n => !inventory.includes(n)), previous: Boolean(body.previous_response_id) })
    emit('response.created', { response: { id: responseId } })
    if (!prewarm) {
      if (!compacting) {
        const message = assistantMessage('r3-ok')
        emit('response.output_item.added', { item: { id: itemId, ...message, content: [] } })
        emit('response.output_text.delta', { item_id: itemId, delta: 'r3-ok', output_index: 0, content_index: 0 })
        if (!report.streamedBeforeCompletion) {
          await waitFor(app.events, e => e.method === 'item/agentMessage/delta' && e.params.delta === 'r3-ok', 'live text delta')
          report.streamedBeforeCompletion = true
        }
        emit('response.output_item.done', { item: { id: itemId, ...message } })
      } else {
        assert.ok(trigger, 'remote compaction must request compaction_trigger')
        emit('response.output_item.done', { item: { id: itemId, type: 'compaction', encrypted_content: 'synthetic-summary' } })
      }
    }
    emit('response.completed', { response: { id: responseId, usage: { input_tokens: 6, output_tokens: 1, total_tokens: 7 } } })
    end()
  }
  const handle = async (req, res) => {
    try {
      paths.push(req.method + ' ' + req.url.split('?')[0])
      if (req.method === 'POST' && req.url === '/oauth/token') {
        let json = ''
        for await (const chunk of req) json += chunk
        const fields = JSON.parse(json)
        assert.equal(fields.grant_type, 'refresh_token')
        assert.equal(fields.refresh_token === 'r3-synthetic-refresh', true)
        report.refresh++
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          access_token: fresh, refresh_token: 'r3-synthetic-rotated', id_token: fresh }))
        return
      }
      if (req.method === 'GET' && req.url?.split('?')[0].endsWith('/accounts/check')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accounts: [{
          id: 'synthetic-r3', plan_type: 'plus', account_routing_override: 'NO_CONSTRAINT', workspace_backend_origin: 'https://chatgpt.com'
        }], account_ordering: ['synthetic-r3'] }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        if (req.url?.includes('/models')) report.remoteCatalogReads++
        res.writeHead(404).end()
        return
      }
      checkAuth(req.headers)
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let bytes = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'zstd') bytes = zstdDecompressSync(bytes)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      await reply(JSON.parse(bytes), 'sse', e => res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n'), () => res.end())
    } catch (err) { errors.push(err.message); res.destroy() }
  }
  const server = createServer(handle)
  server.on('upgrade', (req, socket, head) => {
    report.websocketHandshakes++
    if (req.url !== '/v1/responses' || mode === 'sse') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    try {
      checkAuth(req.headers)
      sockets.handleUpgrade(req, socket, head, ws => {
        ws.on('error', e => errors.push(e.message))
        ws.on('message', async raw => {
          try { await reply(JSON.parse(raw), 'websocket', e => ws.send(JSON.stringify(e)), () => {}) }
          catch (err) { errors.push(err.message); ws.close() }
        })
      })
    } catch (err) { errors.push(err.message); socket.destroy() }
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    let inference = base
    if (mode.startsWith('guard-')) {
      report.guard = { forwarded: 0, rejected: 0, upgradesDeclined: 0 }
      gate = requestGate(approved, base, report.guard)
      await new Promise(resolve => gate.listen(0, '127.0.0.1', resolve))
      inference = 'http://127.0.0.1:' + gate.address().port
    }
    for (const path of [home, cwd]) await mkdir(path, { mode: 0o700 })
    await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      id_token: initial, access_token: initial, account_id: 'synthetic-r3', refresh_token: 'r3-synthetic-refresh' },
      last_refresh: new Date((now - (expiredAtStartup ? 864000 : 0)) * 1000).toISOString() }), {mode: 0o600})
    await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog), {mode: 0o444})
    await writeFile(join(home, 'config.toml'), [
      'model=' + JSON.stringify(model), 'cli_auth_credentials_store="file"', 'web_search="disabled"',
      'model_catalog_json=' + JSON.stringify(join(root, 'catalog.json')),
      'openai_base_url=' + JSON.stringify(inference + '/v1'), 'chatgpt_base_url=' + JSON.stringify(base + '/backend-api'),
      '[analytics]', 'enabled=false', '[features]', 'apps=false', 'plugins=false',
    ].join('\n'))
    const connect = () => connectAppServer({ command: binary, args: ['--strict-config'], cwd,
      env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: home, TMPDIR: root, CODEX_REFRESH_TOKEN_URL_OVERRIDE: base + '/oauth/token' } })
    try { app = await connect() }
    catch (err) {
      if (!expiredAtStartup || !err.message.includes('application network permission was revoked') || report.refresh !== 1) throw err
      const state = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
      assert.equal(state.tokens.refresh_token === 'r3-synthetic-rotated', true)
      report.restartBeforeInitialize = true
      app = await connect()
    }
    // Read-only recheck after the native auth manager publishes a new generation.
    let account
    report.requestedRefresh = !expiredAtStartup
    try { account = await app.request('account/read', { refreshToken: report.requestedRefresh }) }
    catch (err) {
      if (err.message !== 'workspace routing discovery failed') throw err
      await delay(200)
      account = await app.request('account/read', { refreshToken: false })
      report.accountReadRechecked = true
    }
    report.accountMode = account.account?.type
    assert.equal(report.accountMode, 'chatgpt')
    const stored = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    report.rotationStored = stored.tokens?.refresh_token === 'r3-synthetic-rotated'
    assert.ok(report.rotationStored)
    const settings = { cwd, model, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      config: { 'agents.enabled': false, 'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false,
        'skills.bundled.enabled': false, 'skills.include_instructions': false, 'features.shell_tool': false,
        ...(mode === 'auth-tool-control' ? {} : { 'features.image_generation': false }), 'features.view_image': false, 'features.hooks': false, 'features.goals': false, 'features.multi_agent_v2': false } }
    const { thread } = await app.request('thread/start', { ...settings, dynamicTools })
    async function finish(method) {
      const index = app.events.length
      await app.request(method, method === 'turn/start' ? { threadId: thread.id, input: [{ type: 'text', text: 'r3 fixture' }] } : { threadId: thread.id })
      for (let i = 0; i < 1500; i++) {
        if (errors.length) throw Error(errors.join(', '))
        const event = app.events.slice(index).find(e => e.method === 'turn/completed' && e.params.threadId === thread.id)
        if (event) {
          assert.equal(event.params.turn.status, mode === 'guard-drift' ? 'failed' : 'completed', event.params.turn.error?.message)
          return
        }
        await delay(15)
      }
      throw Error('timed out waiting for ' + method)
    }
    await finish('turn/start')
    if (mode === 'guard-drift') {
      assert.ok(report.guard.rejected > 0 && report.guard.upgradesDeclined > 0)
      assert.equal(report.guard.forwarded, 0)
      assert.equal(report.requests.length, 0)
      return report
    }
    if (['ws', 'sse', 'guard-sse'].includes(mode)) {
      compacting = true
      await finish('thread/compact/start')
      compacting = false
      await finish('turn/start')
      assert.ok(report.requests.some(r => r.trigger))
    }
    assert.equal(report.refresh, 1)
    assert.equal(report.remoteCatalogReads, 0)
    assert.ok(report.streamedBeforeCompletion)
    const samples = report.requests.filter(r => !r.prewarm && !r.trigger)
    assert.ok(samples.length)
    for (const sample of samples) {
      assert.deepEqual(sample.missing, [])
      if (mode === 'catalog-control') assert.deepEqual(sample.extras, ['clock/curr_time', 'clock/sleep'])
      else if (mode === 'auth-tool-control') assert.deepEqual(sample.extras, ['image_gen/imagegen'])
      else {
        assert.deepEqual(sample.extras, [])
        assert.equal(sample.toolDigest, approved)
      }
      assert.equal(sample.wire, ['sse','guard-sse'].includes(mode) ? 'sse' : 'websocket')
    }
    if (gate) assert.ok(report.guard.forwarded === 3 && report.guard.upgradesDeclined > 0)
    return report
  } catch (error) {
    console.error({ mode, paths, errors, report, diagnostics: app?.stderr?.replace(/eyJ[\w.-]+/g, '[redacted]').slice(-2500) })
    throw error
  } finally {
    app?.close()
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
    if (gate) {
      gate.closeAllConnections()
      await new Promise(resolve => gate.close(resolve))
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
