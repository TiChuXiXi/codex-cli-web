import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { control, fault, held, jsonFile } from './common.js'

export async function status(instance) {
  const base = {instanceId:instance.id,stateDir:instance.stateDir,log:instance.log}
  if (!held(join(instance.directory,'service.sqlite'))) return {...base,state:'stopped'}
  const record = await jsonFile(join(instance.directory,'running.json'))
  if (!record) throw fault(4,'服务持有实例锁，管理握手尚未就绪')
  let value
  try { value = await control(record,'status') } catch { throw fault(4,'服务持有实例锁，无法验证控制通道') }
  if (value.instanceId !== instance.id || value.boot !== record.boot) throw fault(4,'实例身份冲突')
  const health = await fetch(value.origin+'/healthz',{redirect:'error',signal:AbortSignal.timeout(3000)})
    .then(async r=>r.ok && (await r.json()).ok===true).catch(()=>false)
  return {...base,...value,health,state:health && ['ready','disabled'].includes(value.router.phase) ? 'running' : 'degraded'}
}

export async function start(loc,instance) {
  const current = await status(instance)
  if (current.state !== 'stopped') return current
  const boot = randomUUID()
  const child = spawn(process.execPath,[join(loc.root,'server/lifecycle/supervisor.js'),loc.binding,boot],
    {cwd:instance.directory, detached:true, windowsHide:true, stdio:'ignore'})
  let spawnError
  child.once('error', e => {spawnError=e})
  child.unref()
  const deadline = Date.now()+45000
  while (Date.now()<deadline) {
    const error = await jsonFile(join(instance.directory,'startup-error.json'))
    if (error?.boot === boot) throw fault(error.code,error.error)
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw fault(1,'后台进程启动失败')
    const record = await jsonFile(join(instance.directory,'running.json'))
    if(record?.boot === boot) {
      const result = await status(instance)
      if (!['starting','connecting'].includes(result.router?.phase)) return result
    }
    await sleep(120)
  }
  throw fault(5,'等待 Web 和 Router 就绪超时')
}

export async function stop(instance,yes,maintenance=false,force=false) {
  const was = await status(instance)
  if(was.state === 'stopped') return was
  const record = await jsonFile(join(instance.directory,'running.json'))
  if (record?.boot !== was.boot) throw fault(4,'停止前实例已改变')
  await control(record,maintenance?'maintenance':'stop',yes)
  const deadline = Date.now()+30000
  while (held(join(instance.directory,'service.sqlite'))) {
    if (Date.now()>deadline) {
      if(force) throw fault(4,'无法验证用于强制终止的系统进程句柄，已保留实例记录')
      throw fault(5,'服务未在 30 秒内停止，保留实例记录')
    }
    await sleep(100)
  }
  return {state:'stopped',instanceId:instance.id,stateDir:instance.stateDir}
}

export async function logs(instance,lines,follow,output) {
  let lastSize=0, lastIdentity
  do {
    try {
      const info=await stat(instance.log)
      const identity=String(info.ino)+':'+String(info.birthtimeMs)
      const content=await readFile(instance.log)
      if (lastIdentity === undefined) output(content.toString().trimEnd().split('\n').slice(-lines).join('\n')+'\n')
      else if (identity!==lastIdentity || info.size<lastSize) output(content.toString())
      else if (content.length>lastSize) output(content.subarray(lastSize).toString())
      lastIdentity=identity
      lastSize=content.length
    } catch(e) { if(e.code!=='ENOENT') throw e }
    if(follow) await sleep(500)
  } while(follow)
}
