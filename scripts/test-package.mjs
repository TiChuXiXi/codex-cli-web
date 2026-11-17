import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
const exec=promisify(execFile)
const tar=resolve(process.argv[2] || 'codex-cli-web-0.1.0.tgz')
const folder=await mkdtemp(join(tmpdir(),'codex-package-'))
let child
try {
  await exec('npm',['install','--prefix',folder,'--omit=dev','--no-audit','--no-fund',tar],{timeout:120000,maxBuffer:1024*1024})
  const packageRoot=join(folder,'node_modules/codex-cli-web')
  const pkg=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'))
  if(pkg.peerDependencies?.['@deepseek-ai/cordis']||pkg.dependencies?.['@deepseek-ai/cordis'])throw new Error('Cordis dependency found')
  child=spawn(join(folder,'node_modules/.bin/codex-web-ui'),['--port','0','--state-dir',join(folder,'state'),'--transport','stdio','--codex-path','/nonexistent-codex'],{cwd:folder,env:{...process.env,CODEX_WEB_ACCESS_TOKEN:'packaged-install-fixture-token'},stdio:['ignore','pipe','pipe']})
  let log=''
  const origin=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Package startup timeout')),10000)
    child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/Listening on (http:\/\/[^"\s]+)/);if(match){clearTimeout(timeout);resolve(match[1])}})
    child.once('error',reject)
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Package exited early: '+code))})
  })
  const home=await fetch(origin+'/')
  if(!home.ok||!(await home.text()).includes('id="root"'))throw new Error('Packaged static frontend missing')
  const response=await fetch(origin+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({token:'packaged-install-fixture-token'})})
  if(!response.ok)throw new Error('Packaged authentication failed')
  const cookie=response.headers.get('set-cookie').split(';')[0]
  const terminalResponse=await fetch(origin+'/codex-cli/terminal/open',{method:'POST',headers:{cookie,'x-codex-request':'1','content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'package-pty',method:'terminal/open',payload:{cwd:folder}})})
  const terminal=await terminalResponse.json()
  if(!terminal.result?.ok)throw new Error('Packaged PTY failed: '+terminal.result?.error?.code)
  console.log('PASS: isolated production-only npm install, executable CLI, frontend, authentication, native PTY and graceful SIGTERM')
  const exit=new Promise(resolve=>child.once('exit',resolve))
  child.kill('SIGTERM')
  const code=await Promise.race([exit,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Package did not close')),7000).unref())])
  if(code!==0)throw new Error('Package shutdown exit code: '+code)
}finally{child?.kill('SIGKILL');await rm(folder,{recursive:true,force:true})}
