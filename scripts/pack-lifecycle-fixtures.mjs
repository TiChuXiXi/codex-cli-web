// Build two real local packages so npm's stable dist-tag can change without publishing.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { npmClient } from '../server/lifecycle/npm.js'

const root=fileURLToPath(new URL('../',import.meta.url))
if(!process.argv[2]) throw Error('Usage: node scripts/pack-lifecycle-fixtures.mjs OUTPUT_DIRECTORY')
const output=resolve(process.argv[2])
await mkdir(output,{recursive:true})
const {npm}=await npmClient(output)
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
for (const version of [manifest.version,'0.1.0','0.1.1']) {
  const stage=await mkdtemp(join(tmpdir(),'zcodex-pack-'))
  try {
    for(const path of manifest.files.filter(p=>p!=='dist/web')) {
      await mkdir(dirname(join(stage,path)),{recursive:true})
      await cp(join(root,path),join(stage,path),{recursive:true})
    }
    await writeFile(join(stage,'package.json'),JSON.stringify({...manifest,version},null,2))
    execFileSync(process.execPath,[join(root,'scripts/build.mjs'),stage,version],{stdio:'inherit'})
    if(version==='0.1.1') await writeFile(join(stage,'dist/web/index.html'),'<html>Incomplete test candidate</html>')
    const [result]=JSON.parse(await npm(['pack',stage,'--ignore-scripts','--json','--pack-destination',output]))
    console.log(result.filename,result.integrity)
  } finally {await rm(stage,{recursive:true,force:true})}
}
