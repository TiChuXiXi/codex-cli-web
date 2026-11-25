#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { loadConfig } from '../server/config.js'
import { bound, init } from '../server/lifecycle/instance.js'
import { fault, jsonFile, locations, lock, privateDirectory } from '../server/lifecycle/common.js'
import { logs, start, status, stop } from '../server/lifecycle/process.js'
import { maintain, prepareHelper } from '../server/lifecycle/maintenance.js'

const root=dirname(dirname(fileURLToPath(import.meta.url)))
const {version}=await jsonFile(join(root,'package.json'))
const help = [
  'zcodex '+version,
  'init [--config FILE] [--state-dir DIR] [--non-interactive]',
  'start | stop [--yes] | restart [--yes] | status | doctor | open',
  'verify-worker --codex PATH --transport stdio|daemon [--queue-only]  (Linux)',
  'logs [--lines N] [-f]',
  'update [--check | --yes | --recover --yes]',
  'uninstall --yes [--purge --confirm-purge INSTANCE_ID]',
  '使用 --json 输出机器可读结果，--version 查看安装版本。',
].join('\n')

async function main() {
  let parsed
  try { parsed=parseArgs({allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},json:{type:'boolean'},
    config:{type:'string'},'state-dir':{type:'string'},'non-interactive':{type:'boolean'},
    yes:{type:'boolean',short:'y'},check:{type:'boolean'},recover:{type:'boolean'},purge:{type:'boolean'},
    'confirm-purge':{type:'string'},lines:{type:'string'},follow:{type:'boolean',short:'f'},
    force:{type:'boolean'},'prepare-router':{type:'string'},sha256:{type:'string'},
    codex:{type:'string'},transport:{type:'string'},'queue-only':{type:'boolean'},
  }}) } catch(e) {throw fault(2,e.message)}
  const opts=parsed.values
  if(opts.version) {console.log(version); return}
  if(opts.help || !parsed.positionals.length) {console.log(help); return}
  const [command,...extra]=parsed.positionals
  const allowed={init:['non-interactive','prepare-router','sha256'],start:[],stop:['yes','force'],restart:['yes'],
    status:[],logs:['lines','follow'],doctor:[],open:[],update:['check','yes','recover'],uninstall:['yes','purge','confirm-purge'],
    'verify-worker':['codex','transport','queue-only']}
  if(!Object.hasOwn(allowed,command) || extra.length || Object.keys(opts).some(k=>!['json','config','state-dir',...allowed[command]].includes(k)))
    throw fault(2,'命令或选项有误，请查看 zcodex --help')
  const args={command,yes:!!opts.yes,configFile:opts.config,stateDir:opts['state-dir'],check:!!opts.check,
    purge:!!opts.purge,confirmPurge:opts['confirm-purge'],recover:!!opts.recover}
  if((args.check && args.recover) || (args.confirmPurge && !args.purge)) throw fault(2,'选项组合无效')
  if (command === 'verify-worker') {
    if (process.platform !== 'linux') throw fault(3, '隔离协议探针需要 Linux 命名空间')
    if (!isAbsolute(opts.codex ?? '') || !['stdio', 'daemon'].includes(opts.transport))
      throw fault(2, '请指定 --codex 绝对路径和 --transport stdio 或 daemon')
    const flags = [opts['queue-only'] ? '--queue-only' : '--rcc-p0']
    if (opts.transport === 'daemon') flags.push('--daemon-fixture')
    const probe = spawnSync(process.execPath, [join(root, 'scripts/test-router-protocol.mjs'), ...flags], {
      stdio: 'inherit', env: { PATH: process.env.PATH, CODEX_WEB_ROUTER_A1: '1', CODEX_WEB_CODEX_PATH: opts.codex },
    })
    if (probe.error) throw probe.error
    process.exitCode = probe.status ?? 1
    return
  }
  const loc=locations(await realpath(root))
  const emit = value => console.log(JSON.stringify({code:0,...value},null,opts.json?0:2))
  if(command==='init') {
    await privateDirectory(loc.manager)
    const release=lock(join(loc.manager,'operation.sqlite'))
    try {
      if((opts['prepare-router'] || opts.sha256) && (!opts['prepare-router'] || !/^[a-f0-9]{64}$/i.test(opts.sha256 || '')))
        throw fault(2,'本地专用启动器需要 --prepare-router PATH 和受信任的 --sha256 HEX')
      const instance=await init(loc,args)
      if(opts['prepare-router']) {
        const {registerRouter}=await import('../server/router/register.js')
        if((await status(instance)).state!=='stopped') throw fault(4,'请先停止实例再更换启动器')
        await registerRouter(instance.stateDir,opts['prepare-router'],opts.sha256)
      }
      emit({state:'initialized',instanceId:instance.id,stateDir:instance.stateDir,config:instance.configFile})
    } finally {release()}
    return
  }
  const instance=await bound(loc,args)
  if(!args.yes && process.stdin.isTTY && ['update','uninstall','stop','restart'].includes(command) && !opts.check) {
    const prompt=createInterface({input:process.stdin,output:process.stderr})
    try {args.yes=/^(y|yes)$/i.test(await prompt.question('确认执行 '+command+'？ [y/N] '))} finally {prompt.close()}
    if(!args.yes) throw fault(6,'操作已取消')
  }
  if(command==='update' || command==='uninstall') {
    if(args.check) {emit(await maintain(loc,instance,args)); return}
    const folder=await prepareHelper(loc)
    const child=spawnSync(process.execPath,[join(folder,'server/lifecycle/maintenance-runner.js'),JSON.stringify(args)],
      {cwd:folder,windowsHide:true,stdio:'inherit'})
    if(child.error) throw child.error
    process.exitCode=child.status ?? 1
    if(process.exitCode!==7) await rm(folder,{recursive:true,force:true,maxRetries:5})
    else console.error('核对记录后的包外恢复命令：node "'+join(folder,'server/lifecycle/maintenance-runner.js')+'" --recover --yes')
    return
  }
  if(command==='logs') {
    const lines=Number(opts.lines ?? 100)
    if(!Number.isInteger(lines)||lines<1||lines>100000) throw fault(2,'--lines 须为正整数，最多 100000')
    await logs(instance,lines,opts.follow,text=>process.stdout.write(text))
    return
  }
  const mutate=['start','stop','restart'].includes(command)
  const release=mutate?lock(join(loc.manager,'operation.sqlite')):()=>{}
  try {
    if(mutate && command!=='stop' && await jsonFile(loc.journal)) throw fault(7,'存在未完成的维护操作')
    let value
    if(command==='start') value=await start(loc,instance)
    if(command==='restart') {await stop(instance,args.yes);value=await start(loc,instance)}
    if(command==='stop') value=await stop(instance,args.yes,false,opts.force)
    if(!value) value=await status(instance)
    if(command==='open') {
      if(!value.health) throw fault(3,'工作台尚未就绪')
      const binary=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open'
      if(process.platform==='win32'||process.env.DISPLAY||process.env.WAYLAND_DISPLAY || process.platform==='darwin') {
        const child=spawn(binary,[value.origin],{detached:true,stdio:'ignore',windowsHide:true})
        child.on('error',()=>{});child.unref()
      }
      console.log(value.origin);return
    }
    if(command==='doctor') {
      const config=await loadConfig({stateDir:instance.stateDir,configFile:instance.configFile})
      const {diagnose}=await import('../server/lifecycle/doctor.js')
      value={...value,...await diagnose(config)}
    }
    const code=value.state==='degraded' || (command==='doctor' && !value.codexVersion)?3:0
    process.exitCode=code
    console.log(JSON.stringify({code,cliVersion:version,...value},null,opts.json?0:2))
  } finally {release()}
}
try {await main()} catch(error) {
  process.exitCode=error.exitCode || 1
  console.error(JSON.stringify({code:process.exitCode,error:error.message}))
}
