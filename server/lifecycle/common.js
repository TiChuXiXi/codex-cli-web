import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { request } from 'node:http'
import { mkdir, readFile, rename, stat, unlink, writeFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareWindowsRouterDirectory } from '../router/windows-access.js'

export const windows = process.platform === 'win32'
export const fault = (code, message) => Object.assign(new Error(message), { exitCode: code })
export const digest = value => createHash('sha256').update(value).digest('hex')

export async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function save(path, data) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(data) + '\n', {flag:'wx', mode:0o600})
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

export async function privateDirectory(path) {
  if (windows) await prepareWindowsRouterDirectory(path)
  else {
    await mkdir(path, { recursive:true, mode:0o700 })
    const info = await stat(path)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) || await realpath(path) !== path)
      throw fault(6, '管理目录必须是当前用户独占的真实目录：' + path)
  }
}

export function locations(root) {
  const modules = dirname(root)
  const prefix = windows ? dirname(modules) : dirname(dirname(modules))
  const globalInstall = basename(modules) === 'node_modules' && basename(root) === 'zcodex' &&
    (windows || basename(dirname(modules)) === 'lib')
  const stateHome = resolve(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'))
  const key = digest(windows ? root.toLowerCase() : root).slice(0, 32)
  const manager = join(stateHome, 'zcodex-installs', key)
  return { root, prefix, globalInstall, manager, binding:join(manager,'instance.json'), journal:join(manager,'maintenance.json') }
}

export function lock(path) {
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
  catch (error) { db.close(); if (error.errcode === 5) throw fault(4, '另一个实例或操作持有锁：' + path); throw error }
  return () => db.close()
}

export function held(path) {
  try { lock(path)(); return false } catch (e) { if (e.exitCode === 4) return true; throw e }
}

export function sign(secret, ...parts) {
  return createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex')
}
export function matches(a, b) {
  return typeof a === 'string' && /^[0-9a-f]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export async function control(record, action, yes = false) {
  const nonce = randomUUID(), time = Date.now()
  const body = JSON.stringify({action, yes, nonce, time, mac:sign(record.secret, record.boot, action, yes, nonce, time)})
  return await new Promise((resolve, reject) => {
    const req = request({socketPath:record.socket, path:'/', method:'POST', agent:false,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, res => {
      let text = ''
      res.setEncoding('utf8').on('data', chunk => { text += chunk; if (text.length > 16384) req.destroy(new Error('管理响应过大')) })
      res.once('error', reject)
      res.once('end', () => {
        try {
          const {value, mac} = JSON.parse(text)
          if (!matches(mac, sign(record.secret, record.boot, nonce, value)) || value.pid !== record.pid)
            throw fault(4, '实例身份校验失败')
          if (value.error) throw fault(value.code, value.error)
          resolve(value)
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(action==='maintenance'?60000:5000, () => req.destroy(fault(5, '管理握手超时')))
    req.once('error', reject)
    req.end(body)
  })
}
