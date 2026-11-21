import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, parseArgs } from '../server/config.js'
import { readAccessToken } from '../server/auth.js'
import { checkWindowsPrivateFile, prepareWindowsRouterDirectory } from '../server/router/windows-access.js'
import { startFixture, FIXTURE_TOKEN } from './fixtures/start-app.mjs'
async function login(app,token=FIXTURE_TOKEN) {
  return fetch(app.origin+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({token})})
}
async function fixture(t,options) {const app=await startFixture(options);t.after(()=>app.close());return app}
function rpc(app,cookie,method,payload={}) {return fetch(app.origin+'/codex-cli/'+method,{method:'POST',headers:{cookie,'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({type:'client-request',rpcId:'host-test',method,payload})})}

test('application config priority, validation and Codex defaults',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'config-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'config.json');await writeFile(path,JSON.stringify({port:10001,transport:'stdio',git:{allowWrite:true}}))
  const c=await loadConfig({configFile:path,port:'10003'},{CODEX_WEB_PORT:'10002',CODEX_WEB_GIT_WRITE:'false'})
  assert.equal(c.port,10003);assert.equal(c.codex.transport,'stdio');assert.equal(c.git.allowWrite,false)
  assert.equal(c.codex.approvalTimeoutMs,600000);assert.equal(c.codex.eventBufferSize,5000)
  for(const invalid of [{port:'nan'},{transport:'invalid'},{gitWrite:'maybe'},{allowedHosts:['*']},{sessionTtlMs:0}])await assert.rejects(loadConfig(invalid,{}))
  assert.deepEqual(parseArgs(['--port','9999','--transport=stdio']),{port:'9999',transport:'stdio'})
  assert.throws(()=>parseArgs(['--port']))
})
test('portable LAN mode permits local whitelist setup without changing the two-option config',async t=>{
  const preferences={accessScope:'lan',lanPasswordless:true}
  const app=await fixture(t,{persistedConfig:preferences})
  const read=await (await rpc(app,'','settings/read')).json()
  assert.deepEqual(read.result.value.allowedClients,[])
  const saved=await (await rpc(app,'','settings/whitelist',{
    allowedClients:['192.0.2.41'],revision:read.result.value.revision
  })).json()
  assert.equal(saved.result.value.disconnecting,false)
  assert.deepEqual(JSON.parse(await readFile(join(app.root,'application.json'),'utf8')),preferences)
  const loaded=await loadConfig({configFile:join(app.root,'application.json'),stateDir:join(app.root,'state')},{})
  assert.deepEqual(loaded.allowedClients,['192.0.2.41'])
  assert.equal((await rpc(app,'','status')).status,200)
  const proxy=await fetch(app.origin+'/auth/session',{headers:{'x-forwarded-for':'192.0.2.41'}})
  assert.equal(proxy.status,403)
})
test('registering a trusted launcher generates portable Router installation metadata',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'router-install-'))
  t.after(()=>rm(parent,{recursive:true,force:true}))
  const stateDir=process.platform==='win32'?join(await realpath(parent),'state'):parent
  if(process.platform==='win32') await prepareWindowsRouterDirectory(stateDir)
  const configFile=join(stateDir,'preferences.json')
  const windows=process.platform==='win32'
  const launcher=join(stateDir,windows?'private/launcher.exe':'launcher')
  await writeFile(configFile,JSON.stringify({accessScope:'local',lanPasswordless:false}))
  if(windows) {
    await prepareWindowsRouterDirectory(join(stateDir,'private'))
    await copyFile(join(process.env.SystemRoot,'System32','whoami.exe'),launcher)
  } else await writeFile(launcher,'#!/bin/sh\nexit 99\n',{mode:0o700})
  const cli=fileURLToPath(new URL('../bin/codex-web-ui.mjs',import.meta.url))
  await promisify(execFile)(process.execPath,[cli,'--config',configFile,'--state-dir',stateDir,'--register-router-launcher',launcher])
  const config=await loadConfig({configFile,stateDir},{})
  assert.equal(config.router.enabled,true)
  assert.equal(config.router.launcher,await realpath(launcher))
  assert.match(config.router.launcherSha256,/^[a-f0-9]{64}$/)
  assert.deepEqual(config.router.projects,[])
  if(windows) await checkWindowsPrivateFile(join(stateDir,'router-installation.json'))
  else assert.equal((await stat(join(stateDir,'router-installation.json'))).mode & 0o777,0o600)
})
test('generated access credential persists with owner-only permissions',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'credential-'));t.after(()=>rm(parent,{recursive:true,force:true}))
  const stateDir=join(await realpath(parent),'state')
  const a=await readAccessToken({stateDir}),b=await readAccessToken({stateDir})
  assert.equal(a,b);assert.ok(a.length>=32)
  if(process.platform==='win32') await checkWindowsPrivateFile(join(stateDir,'access-token'))
  else assert.equal((await stat(join(stateDir,'access-token'))).mode&0o777,0o600)
})
test('all business channels reject anonymous and cross-origin access',async t=>{
  const app=await fixture(t)
  for(const [path,method]of [['status','POST'],['events','GET'],['router/read','POST'],['router/send','POST'],['router/clarifications/confirm','POST'],['workspace/download','GET'],['upload/file','POST'],['terminal/open','POST']]) {
    const response=await fetch(app.origin+'/codex-cli/'+path,{method,headers:{'x-codex-request':'1'}})
    assert.equal(response.status,401,path)
  }
  const response=await login(app);assert.equal(response.status,200)
  const cookie=response.headers.get('set-cookie').split(';')[0]
  const bad=await fetch(app.origin+'/codex-cli/status',{method:'POST',headers:{cookie,origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'})
  assert.equal(bad.status,403)
  const noCsrf=await fetch(app.origin+'/codex-cli/status',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})
  assert.equal(noCsrf.status,403)
  const badHost=await new Promise((resolve,reject)=>{const req=httpRequest(app.origin+'/healthz',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()});assert.equal(badHost,403)
})
test('login, session, logout and login throttling',async t=>{
  const app=await fixture(t)
  const response=await login(app),header=response.headers.get('set-cookie'),cookie=header.split(';')[0]
  assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/)
  assert.equal((await (await fetch(app.origin+'/auth/session',{headers:{cookie}})).json()).authenticated,true)
  assert.equal((await (await rpc(app,cookie,'status')).json()).result.value.phase,'ready')
  await fetch(app.origin+'/auth/logout',{method:'POST',headers:{cookie,'x-codex-request':'1'}})
  assert.equal((await rpc(app,cookie,'status')).status,401)
  for(let i=0;i<5;i++)assert.equal((await login(app,'bad')).status,401)
  assert.equal((await login(app)).status,429)
})
test('static SPA, MIME and API fallback boundaries',async t=>{
  const app=await fixture(t)
  const home=await fetch(app.origin+'/');assert.equal(home.status,200);assert.match(await home.text(),/id="root"/)
  const js=await fetch(app.origin+'/assets/main.js');assert.match(js.headers.get('content-type'),/javascript/)
  assert.equal((await fetch(app.origin+'/assets/missing.js')).status,404)
  assert.equal((await fetch(app.origin+'/auth/missing')).status,404)
  assert.equal((await fetch(app.origin+'/%2ehidden')).status,403)
  assert.deepEqual(await (await fetch(app.origin+'/healthz')).json(),{ok:true})
})
test('RPC envelope, method mismatch and full Git service routing',async t=>{
  const app=await fixture(t),response=await login(app),cookie=response.headers.get('set-cookie').split(';')[0]
  const status=await(await rpc(app,cookie,'status')).json();assert.equal(status.rpcId,'host-test');assert.equal(status.type,'server-response')
  const git=await(await rpc(app,cookie,'git/repo/info',{cwd:app.root})).json();assert.equal(git.result.ok,true)
  const bad=await fetch(app.origin+'/codex-cli/status',{method:'POST',headers:{cookie,'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({type:'client-request',rpcId:'bad',method:'threads/list',payload:{}})})
  assert.equal(bad.status,400)
})
test('service closes active SSE and real PTY, releases watches and restarts with a new instance',async t=>{
  const app=await fixture(t),response=await login(app),cookie=response.headers.get('set-cookie').split(';')[0]
  const stream=await fetch(app.origin+'/codex-cli/events',{headers:{cookie}}),reader=stream.body.getReader()
  await reader.read()
  const terminal=await(await rpc(app,cookie,'terminal/open',{cwd:app.root})).json()
  assert.equal(terminal.result.ok,true)
  const workspace=await(await rpc(app,cookie,'workspace/open',{cwd:app.root})).json()
  const id=workspace.result.value.workspaceId
  const watch=await(await rpc(app,cookie,'workspace/watch',{workspaceId:id,path:'.'})).json()
  assert.equal(watch.result.ok,true)
  assert.ok(app.terminal.count>0);assert.ok(app.workspace.watchCount>0)
  await Promise.all([app.close(),app.close()])
  assert.equal(app.terminal.count,0);assert.equal(app.workspace.watchCount,0)
  assert.equal(app.hub.status().phase,'stopped')
  await reader.cancel()
  const next=await fixture(t);assert.notEqual(next.runtime().hostInstanceId,app.runtime().hostInstanceId)
})
test('session expiration also terminates existing SSE access',async t=>{
  const app=await fixture(t,{sessionTtlMs:1000}),response=await login(app),cookie=response.headers.get('set-cookie').split(';')[0]
  const stream=await fetch(app.origin+'/codex-cli/events',{headers:{cookie}}),reader=stream.body.getReader()
  await reader.read()
  await new Promise(r=>setTimeout(r,2200))
  assert.equal((await rpc(app,cookie,'status')).status,401)
  await assert.rejects(async()=>{while(!(await reader.read()).done){}})
})
