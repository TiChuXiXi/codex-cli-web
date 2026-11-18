import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createClientFilter } from './client-access.js'
import { normalizeConfig } from './codex/config.js'
import { normalizeRouterConfig } from './router/app-server.js'

const fields = {authMode:'AUTH_MODE',allowedClients:'ALLOWED_CLIENTS',publicOrigin:'PUBLIC_ORIGIN',host:'HOST',port:'PORT',stateDir:'STATE_DIR',accessToken:'ACCESS_TOKEN',codexPath:'CODEX_PATH',codexHome:'CODEX_HOME',transport:'TRANSPORT',logLevel:'LOG_LEVEL',allowedHosts:'ALLOWED_HOSTS',allowedOrigins:'ALLOWED_ORIGINS',sessionTtlMs:'SESSION_TTL_MS',gitWrite:'GIT_WRITE'}
const flags = {'auth-mode':'authMode','allowed-clients':'allowedClients','public-origin':'publicOrigin','host':'host','port':'port','config':'configFile','state-dir':'stateDir','codex-path':'codexPath','codex-home':'codexHome','transport':'transport','log-level':'logLevel','allowed-hosts':'allowedHosts','allowed-origins':'allowedOrigins','git-write':'gitWrite','register-router-launcher':'registerRouterLauncher'}
export function parseArgs(args) {
  const out = {}
  for (let i=0;i<args.length;i++) {
    const arg=args[i]
    if (arg==='--help' || arg==='-h') {out.help=true;continue}
    if (arg==='--print-access-token') {out.printAccessToken=true;continue}
    const [flag,inline]=arg.replace(/^--/,'').split('=',2)
    if (!arg.startsWith('--') || !flags[flag]) throw new Error('未知参数：'+arg)
    const value=inline ?? args[++i]
    if (value===undefined || value.startsWith('--')) throw new Error('参数缺少值：--'+flag)
    out[flags[flag]]=value
  }
  return out
}
export async function loadConfig(cli={}, env=process.env) {
  const configFile=cli.configFile ?? env.CODEX_WEB_CONFIG
  let file={}
  if(configFile) {
    try { file=JSON.parse(await readFile(resolve(configFile),'utf8')) }
    catch { throw new Error('无法读取或解析应用 JSON 配置') }
    if(!file || Array.isArray(file) || typeof file!=='object') throw new Error('应用配置必须为 JSON 对象')
  }
  const fromEnv={}
  for(const [key,name] of Object.entries(fields)) if(env['CODEX_WEB_'+name]!==undefined) fromEnv[key]=env['CODEX_WEB_'+name]
  const config={authMode:'token',allowedClients:[],host:'127.0.0.1',port:8787,stateDir:join(env.XDG_STATE_HOME || join(homedir(),'.local/state'),'codex-cli-web'),logLevel:'info',sessionTtlMs:12*60*60*1000,...file,...fromEnv,...cli}
  if(config.accessScope!==undefined) {
    if(!['local','lan'].includes(config.accessScope))throw new Error('accessScope 必须为 local 或 lan')
    config.host=cli.host ?? fromEnv.host ?? (config.accessScope==='lan'?'0.0.0.0':'127.0.0.1')
  }
  config.stateDir=resolve(config.stateDir)
  config.configFile=configFile?resolve(configFile):undefined
  config.allowedClientsLocked=cli.allowedClients!==undefined || fromEnv.allowedClients!==undefined
  if(config.lanPasswordless!==undefined) {
    if(typeof config.lanPasswordless!=='boolean')throw new Error('lanPasswordless 必须为布尔值')
    if(cli.authMode===undefined && fromEnv.authMode===undefined)
      config.authMode=config.accessScope==='lan' && config.lanPasswordless?'network':'token'
  }
  config.localWhitelistSetup=config.accessScope==='lan' && config.lanPasswordless===true && config.authMode==='network'
  if(!configFile || config.accessScope!==undefined) {
    try {
      const persisted=JSON.parse(await readFile(join(config.stateDir,'settings.json'),'utf8'))
      if(!persisted || Array.isArray(persisted) || typeof persisted!=='object')throw new Error('invalid settings')
      if(!config.allowedClientsLocked && persisted.allowedClients!==undefined)config.allowedClients=persisted.allowedClients
    } catch(error) {if(error.code!=='ENOENT')throw new Error('无法读取持久化白名单设置')}
  }
  config.port=Number(config.port)
  if(!Number.isInteger(config.port)||config.port<0||config.port>65535) throw new Error('端口必须是 0–65535 的整数')
  if(typeof config.host!=='string'||!config.host.trim()||/[\s/]/.test(config.host)) throw new Error('无效监听地址')
  if(!['auto','daemon','stdio'].includes(config.transport ?? 'auto')) throw new Error('transport 必须为 auto、daemon 或 stdio')
  config.sessionTtlMs=Number(config.sessionTtlMs)
  if(!Number.isFinite(config.sessionTtlMs)||config.sessionTtlMs<1000||config.sessionTtlMs>7*86400000) throw new Error('sessionTtlMs 必须为 1000–604800000')
  for(const key of ['allowedHosts','allowedOrigins','allowedClients']) {
    const value=config[key] ?? []
    config[key]=typeof value==='string'?value.split(',').map(s=>s.trim()).filter(Boolean):value
    if(!Array.isArray(config[key])||config[key].some(x=>typeof x!=='string'||!x||x.includes('*'))) throw new Error(key+' 必须为字符串列表，不支持通配符')
  }
  if(!['token','network'].includes(config.authMode)) throw new Error('auth-mode 必须为 token 或 network')
  createClientFilter(config.allowedClients)
  if(config.authMode==='network' && !config.localWhitelistSetup && !config.allowedClients.length) throw new Error('network 模式必须显式设置 allowedClients 白名单')
  if(config.gitWrite!==undefined) {
    if(![true,false,'true','false'].includes(config.gitWrite)) throw new Error('git-write 必须为 true 或 false')
    config.git={...config.git,allowWrite:config.gitWrite===true||config.gitWrite==='true'}
  }
  if(config.publicOrigin) {
    const url=new URL(config.publicOrigin)
    if(!['http:','https:'].includes(url.protocol)||url.origin!==config.publicOrigin)throw new Error('public-origin 必须为完整 HTTP(S) origin，不带路径')
  }
  config.codex=normalizeConfig(config)
  try {
    const saved=JSON.parse(await readFile(join(config.stateDir,'worker-defaults.json'),'utf8'))
    for (const key of ['defaultModel','defaultEffort','defaultPermission','defaultExecutionMode']) {
      if (typeof saved[key]==='string') config.codex[key]=saved[key]
    }
  } catch(error) { if(error.code!=='ENOENT') throw new Error('无法读取 Worker 默认设置') }
  if(config.router===undefined && config.accessScope!==undefined && !cli.registerRouterLauncher) {
    try {
      config.router=JSON.parse(await readFile(join(config.stateDir,'router-installation.json'),'utf8'))
    } catch(error) {
      if(error.code!=='ENOENT')throw new Error('无法读取 Router 安装记录')
    }
  }
  config.router=normalizeRouterConfig(config.router)
  config.stateDir=resolve(config.stateDir)
  if(config.accessToken!==undefined&&(typeof config.accessToken!=='string'||config.accessToken.length<16)) throw new Error('访问凭证至少需要 16 个字符')
  return config
}
