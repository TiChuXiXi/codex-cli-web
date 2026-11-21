import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('../',import.meta.url))
const temporary=await mkdtemp(join(tmpdir(),'zcodex-tarballs-'))
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const supplied=process.argv.slice(2).map(v=>resolve(v))
try {
  if(supplied.length < 2) {
    execFileSync(process.execPath,[join(root,'scripts/pack-lifecycle-fixtures.mjs'),temporary],{stdio:'inherit'})
    if(!supplied.length) supplied.push(join(temporary,'zcodex-'+version+'.tgz'))
    supplied.push(join(temporary,'zcodex-0.1.0.tgz'),join(temporary,'zcodex-0.1.1.tgz'))
  }
  execFileSync(process.execPath,[join(root,'scripts/test-lifecycle.mjs'),...supplied],{stdio:'inherit'})
} finally { await rm(temporary,{recursive:true,force:true,maxRetries:5}) }
