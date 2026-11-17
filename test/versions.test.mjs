import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {VersionService} from '../server/services/versions.js'
async function make(t,command) {
  const root=await mkdtemp(join(tmpdir(),'codex-version-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const executable=join(root,'fake-codex')
  await writeFile(executable,"#!/usr/bin/env node\n"+command);await chmod(executable,0o700)
  const events=[]
  const service=new VersionService({config:{codexPath:executable,codexHome:join(root,'explicit-home')},logger:{info(){}},bus:{publish:(type,payload)=>events.push({type,payload})},hub:{listThreads:async()=>({data:[]})}})
  t.after(()=>service.dispose())
  return {service,events,root}
}
async function wait(predicate) {for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.fail('job did not finish')}
test('version diagnostics pass the configured CODEX_HOME',async t=>{
  const f=await make(t,'console.log(JSON.stringify({overallStatus:"ok",checks:{installation:{details:{"install context":process.env.CODEX_HOME}}}}))')
  const doctor=await f.service.doctor()
  assert.equal(doctor.install.context,join(f.root,'explicit-home'))
})
test('version disposal terminates active jobs and rejects subsequent operations',async t=>{
  const f=await make(t,'setInterval(()=>{},1000)')
  const job=await f.service.update()
  assert.equal(f.service.job(job.jobId).status,'running')
  f.service.dispose()
  await wait(()=>f.service.job(job.jobId).status!=='running')
  await assert.rejects(f.service.update(),error=>error.code==='codex-cli/stopped')
})
test('spawn errors finish version jobs instead of leaving a permanent running state',async t=>{
  const f=await make(t,'')
  f.service.config.codexPath=join(f.root,'missing-executable')
  const job=await f.service.update()
  await wait(()=>f.service.job(job.jobId).status!=='running')
  assert.equal(f.service.job(job.jobId).status,'error')
  assert.ok(f.events.some(event=>event.type==='version/done'))
})

test('service disposal cancels pending diagnostics as well as version jobs',async t=>{
  const f=await make(t,'setInterval(()=>{},1000)')
  const diagnostic=f.service.doctor()
  const rejected=assert.rejects(diagnostic,error=>error.code==='codex-cli/doctor-failed')
  await new Promise(r=>setTimeout(r,40))
  f.service.dispose()
  await rejected
})
