import { readFile, mkdir, open, rename, unlink, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createClientFilter } from '../client-access.js'
import { HubError } from '../codex/hub.js'
import { createSettingsFirewall } from './settings-firewall.js'

const fail=(code,message,details={})=>new HubError('codex-cli/settings-'+code,message,details)
export class SettingsService {
  #queue=Promise.resolve()
  #disposed=false
  constructor({config,auth,renameFile=rename,firewall=createSettingsFirewall({...config.settingsFirewall,port:config.port})}) {
    this.config=config
    this.auth=auth
    this.firewall=firewall
    this.renameFile=renameFile
    this.path=config.configFile || join(config.stateDir,'settings.json')
  }
  revision(){return createHash('sha256').update(JSON.stringify(this.config.allowedClients)).digest('hex').slice(0,20)}
  read(request) {
    return {
      authMode:this.config.authMode,
      allowedClients:[...this.config.allowedClients],
      clientIp:request.socket.remoteAddress ?? null,
      revision:this.revision(),
      editable:!this.config.allowedClientsLocked,
      lockedReason:this.config.allowedClientsLocked?'白名单由启动参数或环境变量指定，请先移除该覆盖配置。':null,
      firewallManaged:this.firewall.enabled,
    }
  }
  update(payload, context) {
    const operation=this.#queue.then(()=>this.#save(payload,context))
    this.#queue=operation.catch(()=>{})
    return operation
  }
  async #save(payload,{request,response}) {
    if(this.#disposed)throw fail('stopped','服务正在关闭')
    if(this.auth.requestRejection?.(request)!==undefined)throw fail('forbidden','当前请求已失去访问权限')
    if(this.config.allowedClientsLocked)throw fail('locked','启动参数或环境变量覆盖了白名单，无法从页面保存')
    if(payload?.revision!==this.revision())throw fail('conflict','白名单已被其他页面修改，请重新加载后再保存')
    if(!Array.isArray(payload.allowedClients) || payload.allowedClients.length>256 || payload.allowedClients.some(ip=>typeof ip!=='string'))
      throw fail('invalid','请填写有效的 IP 或 CIDR，最多 256 项')
    const next=[...new Set(payload.allowedClients.map(value=>value.trim()))]
    if(!next.length || next.some(ip=>!ip))throw fail('invalid','白名单至少需要一个有效 IP 或 CIDR')
    let allowed
    try{allowed=createClientFilter(next)}catch(error){throw fail('invalid',error.message)}
    if(this.config.authMode==='network' && !allowed(request.socket.remoteAddress) && payload.confirmSelfRemoval!==true)
      throw fail('self-removal','保存后，当前访问 IP 将不再被允许。确认后当前连接会断开。')
    let file={},mode=0o600
    try {
      const info=await lstat(this.path)
      if(info.isSymbolicLink() || !info.isFile())throw fail('storage','配置文件必须是普通文件')
      file=JSON.parse(await readFile(this.path,'utf8'))
      if(!file || Array.isArray(file) || typeof file!=='object')throw fail('storage','配置文件不是有效 JSON 对象')
      mode=info.mode & 0o777
      const diskClients=typeof file.allowedClients==='string'?file.allowedClients.split(',').map(value=>value.trim()).filter(Boolean):file.allowedClients
      if(diskClients && JSON.stringify(diskClients)!==JSON.stringify(this.config.allowedClients))
        throw fail('conflict','配置文件已被外部修改，请重启服务加载后再保存')
    } catch(error) {
      if(error.code!=='ENOENT') {
        if(error instanceof HubError)throw error
        throw fail('storage','无法读取白名单配置文件')
      }
    }
    await mkdir(dirname(this.path),{recursive:true,mode:0o700})
    const temporary=this.path+'.'+randomUUID()+'.tmp'
    let rollback
    try {
      const handle=await open(temporary,'wx',mode)
      try {await handle.writeFile(JSON.stringify({...file,allowedClients:next},null,2)+'\n');await handle.sync()}finally{await handle.close()}
      if(this.#disposed)throw fail('stopped','服务正在关闭')
      rollback=await this.firewall.update(this.config.allowedClients,next)
      await this.renameFile(temporary,this.path)
    } catch(error) {
      await unlink(temporary).catch(()=>{})
      if(rollback)await rollback()
      if(error instanceof HubError)throw error
      throw fail('storage','白名单保存失败，原配置已保留')
    }
    this.auth.setAllowedClients(next,response)
    this.config.allowedClients=next
    return {...this.read(request),saved:true,disconnecting:this.config.authMode==='network' && !allowed(request.socket.remoteAddress)}
  }
  async dispose(){this.#disposed=true;await this.#queue}
}
