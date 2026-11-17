import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadConfig} from '../server/config.js'
import {createAuth} from '../server/auth.js'
import {SettingsService} from '../server/services/settings.js'
import {createSettingsFirewall} from '../server/services/settings-firewall.js'
import {HubError} from '../server/codex/hub.js'
import {startFixture,FIXTURE_TOKEN} from './fixtures/start-app.mjs'
const peer=ip=>({socket:{remoteAddress:ip},headers:{host:'localhost','x-codex-request':'1'},method:'POST'})
async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'settings-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const path=join(root,'app.json')
  await writeFile(path,JSON.stringify({authMode:'network',allowedClients:['192.168.1.80'],port:8787,arbitraryPreserved:'yes'}))
  const config=await loadConfig({configFile:path,stateDir:join(root,'state')},{})
  const applied=[],calls=[]
  const service=new SettingsService({config,auth:{setAllowedClients:(...args)=>applied.push(args)},firewall:{enabled:true,async update(old,next){calls.push({old:[...old],next:[...next]});return async()=>{calls.push('rollback')}}},...options})
  t.after(()=>service.dispose())
  return {root,path,config,service,applied,calls,context:{request:peer('192.168.1.80'),response:{}}}
}
test('settings persist validated whitelist, preserve unrelated config and reload after restart',async t=>{
  const f=await fixture(t),before=f.service.read(f.context.request)
  const next=await f.service.update({revision:before.revision,allowedClients:['192.168.1.80','192.168.1.81','192.168.1.81']},f.context)
  assert.equal(next.saved,true);assert.equal(next.disconnecting,false);assert.notEqual(next.revision,before.revision)
  assert.deepEqual(next.allowedClients,['192.168.1.80','192.168.1.81'])
  assert.equal(next.firewallManaged,true);assert.equal(next.clientIp,'192.168.1.80')
  assert.equal(JSON.parse(await readFile(f.path,'utf8')).arbitraryPreserved,'yes')
  const restarted=await loadConfig({configFile:f.path},{})
  assert.deepEqual(restarted.allowedClients,next.allowedClients)
  assert.deepEqual(f.applied[0][0],next.allowedClients)
})
test('invalid, empty or stale whitelist never changes disk, firewall or live rules',async t=>{
  const f=await fixture(t),revision=f.service.revision(),before=await readFile(f.path,'utf8')
  for(const allowedClients of [[],[''],['not-an-ip'],['192.168.1.80/33']])await assert.rejects(f.service.update({revision,allowedClients},f.context),e=>e.code==='codex-cli/settings-invalid')
  await assert.rejects(f.service.update({revision:'stale',allowedClients:['192.168.1.80']},f.context),e=>e.code==='codex-cli/settings-conflict')
  assert.equal(await readFile(f.path,'utf8'),before);assert.equal(f.calls.length,0);assert.equal(f.applied.length,0)
})
test('concurrent tabs use revisions so a late save cannot overwrite a newer whitelist',async t=>{
  const f=await fixture(t),revision=f.service.revision()
  const results=await Promise.allSettled([f.service.update({revision,allowedClients:['192.168.1.80','192.168.1.81']},f.context),f.service.update({revision,allowedClients:['192.168.1.80','192.168.1.82']},f.context)])
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected')
  assert.equal(results[1].reason.code,'codex-cli/settings-conflict')
  assert.deepEqual(JSON.parse(await readFile(f.path)).allowedClients,['192.168.1.80','192.168.1.81'])
})
test('removing the current peer requires explicit confirmation including mapped IPv4',async t=>{
  const f=await fixture(t),revision=f.service.revision()
  const payload={revision,allowedClients:['192.168.1.81']}
  await assert.rejects(f.service.update(payload,f.context),e=>e.code==='codex-cli/settings-self-removal')
  const result=await f.service.update({...payload,confirmSelfRemoval:true},f.context)
  assert.equal(result.disconnecting,true)
  assert.deepEqual(f.config.allowedClients,['192.168.1.81'])
})
test('disk failure rolls firewall back, keeps old live rules and cleans the temporary file',async t=>{
  const f=await fixture(t,{renameFile:async()=>{throw new Error('read only')}}),before=await readFile(f.path,'utf8')
  await assert.rejects(f.service.update({revision:f.service.revision(),allowedClients:['192.168.1.80','192.168.1.81']},f.context),e=>e.code==='codex-cli/settings-storage')
  assert.equal(await readFile(f.path,'utf8'),before);assert.equal(f.applied.length,0)
  assert.equal(f.calls.at(-1),'rollback')
  assert.equal((await readdir(f.root)).some(name=>name.endsWith('.tmp')),false)
})
test('firewall failure keeps configuration and access unchanged',async t=>{
  const f=await fixture(t,{firewall:{enabled:true,async update(){throw new HubError('codex-cli/settings-firewall','unavailable')}}}),before=await readFile(f.path,'utf8')
  await assert.rejects(f.service.update({revision:f.service.revision(),allowedClients:['192.168.1.80','192.168.1.81']},f.context),e=>e.code==='codex-cli/settings-firewall')
  assert.equal(await readFile(f.path,'utf8'),before);assert.equal(f.applied.length,0)
})
test('external configuration edits are detected rather than overwritten',async t=>{
  const f=await fixture(t)
  await writeFile(f.path,JSON.stringify({...f.config,allowedClients:['192.168.1.90']}))
  await assert.rejects(f.service.update({revision:f.service.revision(),allowedClients:['192.168.1.80','192.168.1.81']},f.context),e=>e.code==='codex-cli/settings-conflict')
  assert.equal(f.applied.length,0)
})
test('persistent fallback settings work without an application config and CLI overrides lock editing',async t=>{
  const root=await mkdtemp(join(tmpdir(),'settings-fallback-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const config=await loadConfig({stateDir:root},{})
  const service=new SettingsService({config,auth:{setAllowedClients(){}}});t.after(()=>service.dispose())
  await service.update({revision:service.revision(),allowedClients:['192.168.1.80']},{request:peer('127.0.0.1')})
  const restored=await loadConfig({stateDir:root,authMode:'network'},{})
  assert.deepEqual(restored.allowedClients,['192.168.1.80'])
  const locked=await loadConfig({stateDir:root,authMode:'network',allowedClients:['192.168.1.90']},{})
  const lockedService=new SettingsService({config:locked,auth:{setAllowedClients(){}}});t.after(()=>lockedService.dispose())
  assert.equal(lockedService.read(peer('192.168.1.90')).editable,false)
  await assert.rejects(lockedService.update({revision:lockedService.revision(),allowedClients:['192.168.1.90']},{request:peer('192.168.1.90')}),e=>e.code==='codex-cli/settings-locked')
})
test('removed peers lose active streams while the save response can finish',async t=>{
  const auth=createAuth({authMode:'network',allowedClients:['192.168.1.80','192.168.1.81'],allowedHosts:[],allowedOrigins:[]})
  t.after(()=>auth.dispose());auth.setOrigin('http://localhost')
  function response(){const res=new EventEmitter();res.destroyed=false;res.destroy=()=>{res.destroyed=true;res.emit('close')};return res}
  const old=response(),saving=response(),kept=response()
  auth.attach(peer('192.168.1.80'),old);auth.attach(peer('192.168.1.80'),saving);auth.attach(peer('192.168.1.81'),kept)
  auth.setAllowedClients(['192.168.1.81'],saving)
  assert.equal(old.destroyed,true);assert.equal(saving.destroyed,false);assert.equal(kept.destroyed,false)
  assert.equal(auth.requestRejection(peer('192.168.1.80')),403)
  assert.equal(auth.requestRejection(peer('192.168.1.81')),undefined)
})
test('managed firewall changes only its explicit rich rules and rolls partial updates back',async()=>{
  const calls=[]
  const firewall=createSettingsFirewall({enabled:true,zone:'public',destination:'192.168.1.182',port:8787},async args=>{calls.push(args);if(calls.length===3)throw new Error('failure')})
  await assert.rejects(firewall.update(['192.168.1.80'],['192.168.1.81']),e=>e.code==='codex-cli/settings-firewall')
  assert.equal(calls.length,5)
  assert.ok(calls[0].at(-1).startsWith('--add-rich-rule='))
  assert.ok(calls[1].includes('--permanent'))
  assert.ok(calls.slice(3).every(args=>args.at(-1).startsWith('--remove-rich-rule=')))
  assert.ok(calls.every(args=>args.at(-1).includes('port="8787"')))
})
test('settings endpoints share authentication and saving updates the real service',async t=>{
  const app=await startFixture();t.after(()=>app.close())
  const post=(method,payload={},cookie='')=>fetch(app.origin+'/codex-cli/'+method,{method:'POST',headers:{cookie,'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({type:'client-request',rpcId:'settings-api',method,payload})})
  assert.equal((await post('settings/read')).status,401)
  const login=await fetch(app.origin+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({token:FIXTURE_TOKEN})})
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const before=(await(await post('settings/read',{},cookie)).json()).result.value
  const result=(await(await post('settings/whitelist',{revision:before.revision,allowedClients:['192.168.1.80']},cookie)).json()).result
  assert.equal(result.ok,true);assert.deepEqual(result.value.allowedClients,['192.168.1.80'])
})

test('a previously admitted queued save cannot restore access after its peer has been removed',async t=>{
  const f=await fixture(t)
  let revoked=false
  f.service.auth.requestRejection=()=>revoked?403:undefined
  f.service.auth.setAllowedClients=()=>{revoked=true}
  const nextRevision=createHash('sha256').update(JSON.stringify(['192.168.1.81'])).digest('hex').slice(0,20)
  const results=await Promise.allSettled([
    f.service.update({revision:f.service.revision(),allowedClients:['192.168.1.81'],confirmSelfRemoval:true},f.context),
    f.service.update({revision:nextRevision,allowedClients:['192.168.1.80']},f.context),
  ])
  assert.equal(results[0].status,'fulfilled')
  assert.equal(results[1].status,'rejected')
  assert.equal(results[1].reason.code,'codex-cli/settings-forbidden')
  assert.deepEqual(JSON.parse(await readFile(f.path)).allowedClients,['192.168.1.81'])
})
