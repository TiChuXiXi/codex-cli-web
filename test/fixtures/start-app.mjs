import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrap } from '../../server/bootstrap.js'
import { loadConfig } from '../../server/config.js'
import { StdioTransport } from '../../server/codex/transport/stdio.js'
export const FIXTURE_TOKEN='fixture-access-token-only-for-tests'
export async function startFixture(overrides={}) {
  const root=await mkdtemp(join(tmpdir(),'codex-web-test-'))
  await writeFile(join(root,'示例.md'),'# 验收文档\n\n文件预览正常。\n')
  await writeFile(join(root,'preview.html'),'<h1>HTML fixture</h1>')
  await exec('git',['init',root])
  await exec('git',['-C',root,'add','示例.md','preview.html'])
  await exec('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture'])
  const {persistedConfig,openRouterApp,...startup}=overrides
  let configFile
  if(persistedConfig) {
    configFile=join(root,'application.json')
    await writeFile(configFile,JSON.stringify(persistedConfig))
  }
  const config=await loadConfig({port:0,stateDir:join(root,'state'),accessToken:FIXTURE_TOKEN,logLevel:'silent',transport:'stdio',codexHome:join(root,'codex'),...startup,...(configFile?{configFile}:{})},{})
  let transport
  const app=await bootstrap(config,{openRouterApp,openTransport:async()=>{
    transport=new StdioTransport({command:process.execPath,args:[fileURLToPath(new URL('./mock-codex.mjs',import.meta.url))],env:{...process.env,MOCK_WORKSPACE:root},logger:{warn(){},info(){}}})
    await transport.open()
    return {transport,kind:'stdio',socketPath:null}
  }})
  for(let i=0;i<200&&app.hub.status().phase!=='ready';i++)await new Promise(r=>setTimeout(r,10))
  if(app.hub.status().phase!=='ready'){await app.close();await rm(root,{recursive:true,force:true});throw new Error('Mock did not connect')}
  const close=async()=>{await app.close();await rm(root,{recursive:true,force:true})}
  return {...app,root,close}
}
