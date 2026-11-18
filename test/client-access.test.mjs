import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientFilter } from '../server/client-access.js'
import { createAuth } from '../server/auth.js'
import { loadConfig } from '../server/config.js'
import { startFixture } from './fixtures/start-app.mjs'

test('exact peer IP whitelist accepts only 192.168.1.80, including mapped IPv4',()=>{
  const allowed=createClientFilter(['192.168.1.80'])
  assert.equal(allowed('192.168.1.80'),true)
  assert.equal(allowed('::ffff:192.168.1.80'),true)
  for(const ip of ['192.168.1.81','192.168.1.182','127.0.0.1','::1','10.0.0.80',undefined,'invalid'])assert.equal(allowed(ip),false)
})
test('client filters support explicit IPv4/IPv6 CIDRs and fail on invalid configuration',async()=>{
  const allowed=createClientFilter(['192.168.1.0/24','2001:db8::/64'])
  assert.equal(allowed('192.168.1.80'),true)
  assert.equal(allowed('192.168.2.80'),false)
  assert.equal(allowed('2001:db8::8'),true)
  assert.equal(allowed('2001:db9::8'),false)
  for(const entry of ['*','localhost','192.168.1.80/33','192.168.1.80/','::1/129','192.168.1.80/24/1',''])assert.throws(()=>createClientFilter([entry]))
  await assert.rejects(loadConfig({authMode:'network'},{}))
  await assert.rejects(loadConfig({authMode:'none'},{}))
  const config=await loadConfig({authMode:'network'},{CODEX_WEB_ALLOWED_CLIENTS:'192.168.1.80'})
  assert.deepEqual(config.allowedClients,['192.168.1.80'])
})
test('network access retains Host/Origin checks and never trusts forwarded peer headers',async t=>{
  const config=await loadConfig({authMode:'network',allowedClients:['192.168.1.80']},{})
  const auth=createAuth(config)
  t.after(()=>auth.dispose())
  auth.setOrigin('http://192.168.1.182:8787')
  const request=(ip,headers={})=>({socket:{remoteAddress:ip},method:'POST',headers:{host:'192.168.1.182:8787','x-codex-request':'1',...headers}})
  assert.equal(auth.requestRejection(request('192.168.1.80')),undefined)
  assert.equal(auth.requestRejection(request('::ffff:192.168.1.80')),undefined)
  assert.equal(auth.requestRejection(request('192.168.1.81',{'x-forwarded-for':'192.168.1.80',forwarded:'for=192.168.1.80'})),403)
  assert.equal(auth.requestRejection(request('192.168.1.80',{origin:'http://attacker.invalid'})),403)
})
test('portable LAN mode validates the connected interface, peer and same-origin host',async t=>{
  const config=await loadConfig({accessScope:'lan',lanPasswordless:true,allowedClients:['192.168.1.80']},{})
  const auth=createAuth(config)
  t.after(()=>auth.dispose())
  auth.setOrigin('http://127.0.0.1:8787')
  const request=(remoteAddress,localAddress,host,origin='http://'+host)=>({
    socket:{remoteAddress,localAddress,localPort:8787},method:'POST',headers:{host,origin},
  })
  assert.equal(auth.requestRejection(request('192.168.1.80','192.168.1.182','192.168.1.182:8787')),undefined)
  assert.equal(auth.requestRejection(request('192.168.1.81','192.168.1.182','192.168.1.182:8787')),403)
  assert.equal(auth.requestRejection(request('192.168.1.80','192.168.1.182','127.0.0.1:8787')),403)
  assert.equal(auth.requestRejection(request('192.168.1.80','192.168.1.182','192.168.1.182:8787','http://192.168.1.180:8787')),403)
  assert.equal(auth.requestRejection(request('192.168.1.80','203.0.113.1','203.0.113.1:8787')),403)
})
test('allowed peer can use UI, RPC, SSE, download and native PTY without a Cookie',async t=>{
  const app=await startFixture({authMode:'network',allowedClients:['127.0.0.1']})
  t.after(()=>app.close())
  const session=await fetch(app.origin+'/auth/session')
  assert.equal(session.headers.get('set-cookie'),null)
  assert.deepEqual(await session.json(),{authenticated:true,authMode:'network'})
  assert.equal((await fetch(app.origin+'/')).status,200)
  const rpc=async(method,payload={})=>{
    const response=await fetch(app.origin+'/codex-cli/'+method,{method:'POST',headers:{'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({type:'client-request',rpcId:'network-test',method,payload})})
    const result=(await response.json()).result
    assert.equal(result.ok,true,method)
    return result.value
  }
  assert.equal((await rpc('status')).phase,'ready')
  const workspace=await rpc('workspace/open',{cwd:app.root})
  const download=await fetch(app.origin+'/codex-cli/workspace/download?'+new URLSearchParams({workspaceId:workspace.workspaceId,path:'示例.md'}))
  assert.match(await download.text(),/验收文档/)
  const terminal=await rpc('terminal/open',{cwd:app.root})
  await rpc('terminal/close',{sessionId:terminal.sessionId})
  const controller=new AbortController()
  const stream=await fetch(app.origin+'/codex-cli/events',{signal:controller.signal})
  assert.equal(stream.status,200)
  await stream.body.getReader().read()
  controller.abort()
})
test('non-whitelisted peer is rejected on every channel even with spoofed forwarding headers',async t=>{
  const app=await startFixture({authMode:'network',allowedClients:['192.168.1.80']})
  t.after(()=>app.close())
  for(const [path,method]of [['/','GET'],['/healthz','GET'],['/auth/session','GET'],['/auth/login','POST'],['/codex-cli/status','POST'],['/codex-cli/events','GET'],['/codex-cli/workspace/download','GET'],['/codex-cli/upload/file','POST'],['/codex-cli/terminal/open','POST']]){
    const response=await fetch(app.origin+path,{method,headers:{'x-codex-request':'1','x-forwarded-for':'192.168.1.80'}})
    assert.equal(response.status,403,path)
  }
})
