import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { bootstrap } from '../server/bootstrap.js'
import { loadConfig } from '../server/config.js'
if(process.env.CODEX_WEB_LIVE!=='1')throw new Error('请显式设置 CODEX_WEB_LIVE=1；默认只验证隔离 stdio 握手，不调用模型')
const root=await mkdtemp(join(tmpdir(),'codex-live-'))
const command=process.env.CODEX_WEB_CODEX_PATH || 'codex'
const config=await loadConfig({port:0,stateDir:join(root,'state'),accessToken:'live-smoke-local-only-token',transport:'stdio',codexPath:command,codexHome:process.env.CODEX_WEB_LIVE_HOME || join(root,'codex'),logLevel:'warn'})
if(!process.env.CODEX_WEB_LIVE_HOME)await mkdir(config.codex.codexHome,{recursive:true})
const app=await bootstrap(config)
try{
  for(let i=0;i<150 && app.hub.status().phase!=='ready';i++)await new Promise(r=>setTimeout(r,100))
  const status=app.hub.status()
  if(status.phase!=='ready')throw new Error('真实 Codex 未连接：'+status.error)
  const report={date:new Date().toISOString(),cli:execFileSync(command,['--version'],{encoding:'utf8'}).trim(),transport:status.kind,handshake:'passed',modelRound:'not-run',isolatedHome:!process.env.CODEX_WEB_LIVE_HOME}
  if(process.env.CODEX_WEB_LIVE_SEND==='1'){
    if(!process.env.CODEX_WEB_LIVE_HOME)throw new Error('模型冒烟需显式提供已登录的 CODEX_WEB_LIVE_HOME')
    const thread=await app.hub.newThread({cwd:root,ephemeral:true})
    let finish
    const done=new Promise(resolve=>{finish=resolve})
    const off=app.bus.subscribe(event=>{if(event.type==='turn/completed'&&event.threadId===thread.id)finish(event.payload)})
    try{
      await app.hub.startTurn({threadId:thread.id,text:'Reply with exactly: SMOKE_OK',cwd:root,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}})
      const result=await Promise.race([done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('模型回合超时')),60000);timer.unref()})])
      report.modelRound=result?.turn?.status || result?.status || 'completed-event'
    }finally{off()}
  }
  await mkdir(new URL('../docs/acceptance/',import.meta.url),{recursive:true})
  await writeFile(new URL('../docs/acceptance/live.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report))
}finally{await app.close();await rm(root,{recursive:true,force:true})}
