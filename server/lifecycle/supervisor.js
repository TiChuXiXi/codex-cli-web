import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { bootstrap } from '../bootstrap.js'
import { loadConfig } from '../config.js'
import { readAccessToken } from '../auth.js'
import { createLogger } from '../logger.js'
import { digest, fault, jsonFile, lock, matches, save, sign, windows } from './common.js'

const [bindingPath, boot] = process.argv.slice(2)
const instance = await jsonFile(bindingPath)
const { directory, stateDir, configFile, log } = instance
const release = lock(join(directory, 'service.sqlite'))
const recordPath = join(directory, 'running.json')
const socket = windows ? '\\\\.\\pipe\\zcodex-' + boot : '/tmp/zcodex-' + digest(directory + boot).slice(0,40) + '.sock'
const record = {boot, pid:process.pid, socket, secret:randomBytes(32).toString('hex')}
const nonces = new Map()
let app, closing, controlServer
const {version} = await jsonFile(new URL('../../package.json', import.meta.url))

function writeLog(line) {
  if (existsSync(log) && statSync(log).size + Buffer.byteLength(line) > 10 * 1024 * 1024) {
    for (let n=4; n>=0; n--) {
      const from = n ? log + '.' + n : log
      if (existsSync(from)) renameSync(from, log + '.' + (n+1))
    }
  }
  appendFileSync(log, line + '\n', {mode:0o600})
}

function state() {
  const worker = app.hub.status()
  return {pid:process.pid, version, origin:app.origin, instanceId:instance.id, boot, startedAt:record.startedAt,
    worker:{phase:worker.phase, kind:worker.kind || null, approvals:worker.pendingApprovals},
    router:app.router ? {phase:app.router.phase, policy:app.router.app?.policyVersion ?? null} : {phase:'disabled'}}
}

async function stop() {
  if (closing) return closing
  closing = (async () => {
    try {
      await app?.close()
      if (controlServer?.listening) await new Promise(resolve => controlServer.close(resolve))
      if ((await jsonFile(recordPath))?.boot === boot) await unlink(recordPath)
    } finally { release() }
  })()
  return closing
}

async function handle(req, res) {
  let nonce, value
  try {
    if (req.method !== 'POST' || req.url !== '/') throw fault(6, '无效管理请求')
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 2048) throw fault(6, '请求过大') }
    const data = JSON.parse(body)
    const {action, yes, time, mac} = data
    nonce = data.nonce
    const now = Date.now()
    for (const [key, expiry] of nonces) if (expiry < now) nonces.delete(key)
    if (typeof nonce !== 'string' || nonce.length !== 36 || !Number.isSafeInteger(time) || Math.abs(now-time)>15000 ||
        nonces.has(nonce) || !matches(mac,sign(record.secret,boot,action,yes,nonce,time))) throw fault(6,'无效管理凭据')
    nonces.set(nonce,time+15000)
    value = state()
    if (['stop','maintenance'].includes(action)) {
      if (action === 'maintenance' && (app.followups.hasPending() || app.router?.upgrade?.pending() ||
          (value.worker.kind === 'stdio' && value.worker.phase === 'ready' && await app.hub.psmWorkerBusy())))
        throw fault(6, '仍有处于执行、审批或对账中的工作，请在完成后重试')
      if (yes !== true && (value.worker.kind === 'stdio' || value.worker.approvals)) throw fault(6,'停止私有 Worker 需要 --yes')
      // Quiesce synchronously at the same boundary as the final admission check.
      const done = stop()
      done.catch(() => { process.exitCode=1 })
    } else if (action !== 'status') throw fault(2,'未知管理操作')
  } catch (error) {
    value = {pid:process.pid, code:error.exitCode || 1, error:error.exitCode ? error.message : '无法核实服务状态'}
  }
  res.setHeader('Connection','close')
  res.end(JSON.stringify({value, mac:sign(record.secret,boot,nonce,value)}))
}

try {
  const config = await loadConfig({stateDir, configFile})
  const token = config.authMode === 'token' ? await readAccessToken(config) : null
  const logger = createLogger(config.logLevel, [token], writeLog)
  app = await bootstrap(config, {logger})
  controlServer = createServer((req,res) => { handle(req,res).catch(() => res.destroy()) })
  controlServer.requestTimeout = 5000
  if (!windows) process.umask(0o077)
  await new Promise((resolve,reject) => { controlServer.once('error',reject); controlServer.listen(socket,resolve) })
  record.startedAt = new Date().toISOString()
  await save(recordPath,record)
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => stop().catch(() => { process.exitCode=1 }))
} catch (error) {
  await save(join(directory,'startup-error.json'), {boot,code:error.code === 'EADDRINUSE' ? 4 : 1,
    error:error.code === 'EADDRINUSE' ? 'Web 端口已被占用' : '服务启动失败：' + (error.code || error.name)})
  await stop()
  process.exitCode=1
}
