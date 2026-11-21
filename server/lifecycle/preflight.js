// Probe the replacement in its own process before enabling any business channels.
import { bootstrap } from '../bootstrap.js'
import { loadConfig } from '../config.js'
import { connectRouterApp } from '../router/app-server.js'
import { join } from 'node:path'
import { jsonFile } from './common.js'

const instance=await jsonFile(process.argv[2])
const config=await loadConfig({configFile:instance.configFile,stateDir:instance.stateDir})
const probe={...config,host:'127.0.0.1',port:0,publicOrigin:undefined,allowedHosts:[],authMode:'token',accessToken:'maintenance-local-probe'}
const app=await bootstrap(probe,{maintenance:true})
let router
try {
  const response=await fetch(app.origin+'/healthz',{signal:AbortSignal.timeout(3000)})
  if(!response.ok || !(await response.json()).ok) throw Error('Web preflight failed')
  const page=await fetch(app.origin,{signal:AbortSignal.timeout(3000)})
  if(!page.ok || !(await page.text()).includes('id="root"')) throw Error('Web assets unavailable')
  if(config.router.enabled) {
    router=await connectRouterApp({config:config.router,directory:join(instance.stateDir,'router'),
      onEvent(){},onClose(){},onTool(){throw Error('Maintenance preflight has no tools')}})
    if(router.policyVersion!==2) throw Error('Router policy v2 required')
  }
} finally { router?.close(); await app.close() }
