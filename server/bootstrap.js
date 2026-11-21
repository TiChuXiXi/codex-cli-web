import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { EventBus } from './services/events.js'
import { FollowupQueue } from './services/followups.js'
import { CodexHub } from './codex/hub.js'
import { WorkspaceService } from './services/workspace.js'
import { TerminalService } from './services/terminal.js'
import { createGitService } from './services/git.js'
import { VersionService } from './services/versions.js'
import { createSettingsFirewall } from './services/settings-firewall.js'
import { SettingsService } from './services/settings.js'
import { createRoutes } from './api/routes.js'
import { createAuth, readAccessToken, json } from './auth.js'
import { isLanAddress } from './client-access.js'
import { createLogger } from './logger.js'
import { createRuntime } from './runtime.js'
import { createStatic } from './static.js'

export async function bootstrap(config, options={}) {
  const settingsFirewall=options.settingsFirewall ?? createSettingsFirewall({...config.settingsFirewall,port:config.port})
  const token=config.authMode==='network'?undefined:await readAccessToken(config)
  const logger=options.logger ?? createLogger(config.logLevel,[token])
  const auth=createAuth(config,token),bus=new EventBus({capacity:config.codex.eventBufferSize})
  const hub=new CodexHub({config:config.codex,logger,bus,...(options.openTransport?{openTransport:options.openTransport}:{})})
  const followups=new FollowupQueue({hub,bus}),workspace=new WorkspaceService(bus),terminal=new TerminalService()
  const git=createGitService(config.git)
  const versions=new VersionService({config:config.codex,logger,bus,hub})
  const settings=new SettingsService({config,auth,firewall:settingsFirewall})
  const runtime=createRuntime()
  let router
  if(config.router?.enabled) {
    const {RouterService}=await import('./router/service.js')
    const {WeChatChannel}=await import('./channels/wechat/channel.js')
    router=new RouterService({config:config.router,stateDir:config.stateDir,hub,followups,bus,logger,connect:options.openRouterApp,
      createChannel: service => new WeChatChannel(service, options.wechatClient)})
  }
  const routes=createRoutes({hub,bus,connection:auth,config:config.codex,logger,versions,runtime,workspace,git,followups,terminal,settings,router})
  const serveStatic=createStatic(options.webRoot ?? fileURLToPath(new URL('../dist/web/',import.meta.url)))
  let closing=false,closePromise
  const sockets=new Set()
  const server=createServer(async(request,response)=>{
    response.setHeader('x-content-type-options','nosniff')
    response.setHeader('referrer-policy','same-origin')
    try {
      if(closing)return json(response,503,{error:'服务正在关闭'})
      const pathname=(request.url ?? '/').split('?')[0]
      if(!pathname.startsWith('/'))return json(response,400,{error:'无效请求地址'})
      const rejected=auth.originRejection(request)
      if(rejected)return json(response,rejected,{error:'请求来源不允许'})
      if(pathname==='/healthz' && request.method==='GET')return json(response,200,{ok:true})
      if(options.maintenance && (pathname.startsWith('/auth') || pathname.startsWith('/codex-cli')))
        return json(response,503,{error:'维护检查中'})
      if(pathname==='/auth'||pathname.startsWith('/auth/'))return await auth.handle(request,response,pathname)
      if(pathname==='/codex-cli'||pathname.startsWith('/codex-cli/')) {
        auth.attach(request,response)
        return await routes(request,response)
      }
      return await serveStatic(request,response,pathname)
    }catch(error){
      if(!response.destroyed&&!response.writableEnded) {
        if(response.headersSent)response.destroy()
        else json(response,500,{error:'请求处理失败'})
      }
      logger.warn('request failed: '+(error.code ?? error.name))
    }
  })
  server.requestTimeout=0 // Streaming uploads/PTY use service limits and explicit cancellation.
  server.headersTimeout=15000
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))})
  async function close() {
    if(closePromise)return closePromise
    closing=true
    closePromise=(async()=>{
      const stopped=new Promise(resolve=>server.close(resolve))
      const deadline=setTimeout(()=>{for(const socket of sockets)socket.destroy()},3000)
      try {
        routes.dispose()
        await settings.dispose()
        auth.dispose()
        try {
          await router?.close()
        } finally {
          followups.dispose()
          workspace.dispose()
          terminal.dispose()
          git.dispose()
          versions.dispose()
          await hub.stop()
          bus.dispose()
        }
        server.closeIdleConnections()
        await stopped
      }finally {clearTimeout(deadline);for(const socket of sockets)socket.destroy()}
    })()
    return closePromise
  }
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.off('error',reject);resolve()})})
    const address=server.address(),host=['0.0.0.0','::'].includes(config.host)?'127.0.0.1':config.host
    const origin='http://'+(host.includes(':')?'['+host+']':host)+':'+address.port
    auth.setOrigin(config.publicOrigin ?? origin)
    if(!options.maintenance) {
      hub.start()
      router?.start()
    }
    logger.info('Listening on '+(config.publicOrigin ?? origin))
    if(config.accessScope==='lan' && !config.publicOrigin) {
      for(const entry of Object.values(networkInterfaces()).flat()) {
        if(entry.family==='IPv4' && isLanAddress(entry.address) && (config.host==='0.0.0.0'||entry.address===config.host))
          logger.info(`LAN access: http://${entry.address}:${address.port}`)
      }
    }
    return {server,origin,close,hub,bus,runtime,workspace,terminal,followups,versions,settings,router}
  }catch(error){await close();throw error}
}
