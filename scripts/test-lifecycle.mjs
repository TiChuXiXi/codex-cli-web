import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { npmClient } from '../server/lifecycle/npm.js'

const exec=promisify(execFile)
if(![4,5].includes(process.argv.length)) throw Error('Usage: node scripts/test-lifecycle.mjs OLD.tgz STABLE.tgz [BROKEN.tgz]')
const [oldPath,nextPath,brokenPath]=process.argv.slice(2).map(p=>resolve(p))
const root=await realpath(await mkdtemp(join(tmpdir(),'zcodex-qa-')))
const prefix=join(root,'全局 prefix'), state=join(root,'工作区 state'), config=join(root,'config.json')
const windows=process.platform==='win32'
const shim=join(prefix,windows?'zcodex.cmd':'bin/zcodex')
const winPs=windows?join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'):null
const registry=createServer()
let installed=false
const oldPkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url)))
const client=await npmClient(root)
const next=await client.manifest(nextPath), old=await client.manifest(oldPath)
let latest=next
const archives=new Map([[next.version,await readFile(nextPath)]])
const broken=brokenPath && await client.manifest(brokenPath)
if(broken) archives.set(broken.version,await readFile(brokenPath))
assert.equal(old.name,oldPkg.name)
assert.ok(client.semver.gt(next.version,old.version))
await new Promise(r=>registry.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+registry.address().port
registry.on('request',(req,res)=>{
  if(req.url==='/zcodex') {
    res.setHeader('Content-Type','application/json')
    res.setHeader('Cache-Control','no-store')
    const versions=Object.fromEntries([next,broken].filter(Boolean).map(pkg=>[pkg.version,{...pkg,
      dist:{tarball:origin+'/'+pkg.version,integrity:'sha512-'+createHash('sha512').update(archives.get(pkg.version)).digest('base64')}}]))
    res.end(JSON.stringify({name:'zcodex','dist-tags':{latest:latest.version},versions}))
  } else if(archives.has(req.url.slice(1))) res.end(archives.get(req.url.slice(1)))
  else {res.writeHead(302,{location:'https://registry.npmjs.org'+req.url});res.end()}
})
const env={...process.env,XDG_STATE_HOME:join(root,'manager'),npm_config_registry:origin,
  npm_config_userconfig:join(root,'npmrc'),NO_PROXY:'localhost,127.0.0.1',
  PATH:dirname(process.execPath)+delimiter+process.env.PATH}
for(const key of Object.keys(env)) if(key.startsWith('CODEX_WEB_')) delete env[key]
await writeFile(env.npm_config_userconfig,'')
const packageRoot=join(prefix,windows?'node_modules':'lib/node_modules','zcodex')
async function cli(args,code=0,{powershell=false}={}) {
  let command=shim, argv=args
  if(windows && powershell) {
    command=winPs;argv=['-NoProfile','-ExecutionPolicy','Bypass','-File',join(prefix,'zcodex.ps1'),...args]
  } else if(windows) {
    // Arguments in this fixture are constants and fixture-owned paths.
    command=process.env.ComSpec
    argv=['/d','/s','/c','""'+shim+'" '+args.map(a=>'"'+a+'"').join(' ')+'"']
  }
  let stdout,stderr,actual
  try {
    const pending=exec(command,argv,{cwd:root,env,windowsHide:true,windowsVerbatimArguments:windows&&!powershell,timeout:120000})
    pending.child.stdin.end()
    ;({stdout,stderr}=await pending)
    actual=0
  } catch(e) {({stdout,stderr,code:actual}=e)}
  assert.equal(actual,code,args[0]+' expected '+code+', got '+actual+' '+stderr+' '+stdout)
  return (stdout||stderr).trim()
}
const query=async (args,code=0)=>JSON.parse(await cli([...args,'--json'],code))
const rpc=async (url,cookie,method,payload)=> {
  const r=await fetch(url+'/codex-cli/'+method,{method:'POST',headers:{cookie,'x-codex-request':'1','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:'lifecycle',method,payload})})
  const msg=await r.json()
  assert.ok(msg.result?.ok,method+' '+JSON.stringify(msg.result?.error))
  return msg.result.value
}
async function web(instance,version) {
  assert.equal(instance.state,'running')
  assert.equal(instance.version,version)
  assert.equal((await fetch(instance.origin+'/healthz').then(r=>r.json())).ok,true)
  assert.match(await fetch(instance.origin).then(r=>r.text()),/id="root"/)
  const token=(await readFile(join(state,'access-token'),'utf8')).trim()
  const login=await fetch(instance.origin+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({token})})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const terminal=await rpc(instance.origin,cookie,'terminal/open',{cwd:root})
  await rpc(instance.origin,cookie,'terminal/close',{sessionId:terminal.sessionId})
  for(let n=0;n<30;n++) {
    if((await query(['status'])).worker?.kind==='stdio') return
    await sleep(100)
  }
  assert.fail('private fixture Worker not connected')
}
async function installOld() {
  await client.npm(['install','--global','--prefix',prefix,'--ignore-scripts','--prefer-offline','--no-audit','--no-fund',oldPath])
  installed=true
}
try {
  await installOld()
  assert.equal(await cli(['--version']),old.version)
  if(windows) assert.equal(await cli(['--version'],0,{powershell:true}),old.version)
  await writeFile(config,JSON.stringify({stateDir:state,port:0,transport:'stdio',codexPath:process.execPath,codexHome:join(root,'worker-home')}))
  const init=await query(['init','--config',config,'--non-interactive'])
  assert.equal((await query(['init'])).instanceId,init.instanceId)
  await writeFile(join(state,'zcodex-service','app-server'),[
    "const readline=require('node:readline');",
    "readline.createInterface({input:process.stdin}).on('line',line=>{const {method,id}=JSON.parse(line);if(id!==undefined)",
    "console.log(JSON.stringify({id,result:method==='initialize'?{userAgent:'fixture/0.169.1'}:method==='thread/read'?{thread:{id:'busy',status:{type:'active'}}}:{data:method==='thread/loaded/list'&&require('node:fs').existsSync('busy.flag')?['busy']:[],nextCursor:null}}))});",
  ].join('\n'))
  if(process.env.CODEX_WEB_LIFECYCLE_ROUTER_LIVE==='1') {
    const {checkInstalledRouter}=await import('./lifecycle-router-check.mjs')
    await checkInstalledRouter({root,state,config,query,old,next})
    assert.equal((await query(['uninstall','--yes'])).state,'uninstalled')
    installed=false
  } else {
    await checkOffline()
  }
} catch(error) {
  if(process.env.CODEX_WEB_LIFECYCLE_ROUTER_LIVE==='1') {
    const log=await readFile(join(state,'zcodex-service','service.log'),'utf8').catch(()=>'')
    for(const row of log.split('\n').filter(Boolean)) {
      const {message}=JSON.parse(row)
      if(message.startsWith('Router startup validation failed:')) console.error(message)
    }
  }
  throw error
} finally {
  if(installed) await cli(['stop','--yes']).catch(()=>{})
  registry.closeAllConnections()
  await new Promise(r=>registry.close(r))
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})
}


async function checkOffline() {
  const sentinel=join(state,'preserved.txt'), marker=randomUUID()
  await writeFile(sentinel,marker)
  const token=await readFile(join(state,'access-token'),'utf8')
  const originalConfig=await readFile(config,'utf8')
  await cli(['uninstall','--yes','--purge','--confirm-purge','wrong-instance'],6)
  assert.equal(await cli(['--version']),old.version)
  await writeFile(config,JSON.stringify({...JSON.parse(originalConfig),port:registry.address().port}))
  await cli(['start'],4)
  assert.equal((await query(['status'])).state,'stopped')
  await writeFile(config,originalConfig)
  const dbDir=join(state,'router')
  await mkdir(dbDir,{mode:0o700})
  const database=join(dbDir,'router.sqlite')
  const fixtureDb=new DatabaseSync(database)
  fixtureDb.exec('CREATE TABLE continuity(value TEXT); PRAGMA user_version=4')
  fixtureDb.prepare('INSERT INTO continuity VALUES(?)').run(marker)
  fixtureDb.close()
  const started=await query(['start'])
  await web(started,old.version)
  assert.equal((await query(['start'])).pid,started.pid)
  await cli(['stop'],6)
  const restarted=await query(['restart','--yes'])
  assert.notEqual(restarted.boot,started.boot)
  assert.equal((await query(['update','--check'])).target,next.version)
  await web(restarted,old.version)
  const busy=join(state,'zcodex-service','busy.flag')
  await writeFile(busy,'test')
  await cli(['update','--yes'],6)
  assert.equal((await query(['status'])).boot,restarted.boot)
  await unlink(busy)
  if(broken) {
    latest=broken
    await cli(['update','--yes'],1)
    assert.equal(await cli(['--version']),old.version)
    await web(await query(['status']),old.version)
    latest=next
  }
  assert.equal((await query(['update','--yes'])).state,'running')
  await web(await query(['status']),next.version)
  assert.equal(await cli(['--version']),next.version)
  assert.equal((await query(['stop','--yes'])).state,'stopped')
  assert.equal((await query(['stop'])).state,'stopped')
  assert.equal((await query(['uninstall','--yes'])).state,'uninstalled')
  installed=false
  await assert.rejects(access(shim))
  assert.equal(await readFile(sentinel,'utf8'),marker)
  assert.equal(await readFile(join(state,'access-token'),'utf8'),token)
  const after=new DatabaseSync(database,{readOnly:true})
  assert.equal(after.prepare('SELECT value FROM continuity').get().value,marker)
  after.close()
  await installOld()
  assert.equal((await query(['status'])).state,'stopped')
  assert.equal((await query(['update','--yes'])).state,'stopped')
  assert.equal(await cli(['--version']),next.version)
  await web(await query(['start']),next.version)
  assert.equal((await query(['uninstall','--yes'])).state,'uninstalled')
  installed=false
  await assert.rejects(access(shim))
  await assert.rejects(access(packageRoot))
  assert.equal(await readFile(sentinel,'utf8'),marker)
  assert.equal(await readFile(join(state,'access-token'),'utf8'),token)
  console.log(JSON.stringify({platform:process.platform,from:old.version,to:next.version,shim:true,web:true,
    pty:true,worker:'private fixture',restart:true,portConflict:true,busyRefusal:true,rollback:!!broken,
    runningUpdate:true,stoppedUpdate:true,uninstall:true,preserved:true}))
}
