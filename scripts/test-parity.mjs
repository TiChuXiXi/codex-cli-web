import { build } from 'esbuild'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixture, FIXTURE_TOKEN } from '../test/fixtures/start-app.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const reference=resolve(process.env.REFERENCE_REPO || resolve(root,'../dsh-codex-cli'))
const baseline='48590b624d011d8036d412c31c8f5f319410eecb'
if(execFileSync('git',['-C',reference,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==baseline)throw new Error('Reference HEAD differs from locked baseline')
if(execFileSync('git',['-C',reference,'diff','--name-only','HEAD'],{encoding:'utf8'}).trim())throw new Error('Reference tracked source has changes')
const folder=await mkdtemp(join(tmpdir(),'codex-parity-'))
const output=resolve(root,'docs/acceptance/parity')
await mkdir(output,{recursive:true})
const referenceEntry=`
import * as React from 'react'
import {createRoot} from 'react-dom/client'
import {ConsolePage} from ${JSON.stringify(reference+'/src/client/page/ConsolePage.tsx')}
import {installStyles} from ${JSON.stringify(reference+'/src/client/styles.ts')}
import {api} from ${JSON.stringify(root+'web/src/api.ts')}
installStyles()
createRoot(document.getElementById('root')).render(<ConsolePage api={api}/>)
`
await writeFile(join(folder,'reference.tsx'),referenceEntry)
const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'))
const alias=Object.fromEntries(Object.keys(pkg.dependencies).map(name=>[name,resolve(root,'node_modules',name)]))
const result=await build({entryPoints:[join(folder,'reference.tsx')],bundle:true,format:'esm',platform:'browser',target:'es2022',jsx:'automatic',write:false,outdir:folder,loader:{'.module.css':'local-css'},alias,define:{__CODEX_BUNDLE_CSS__:'""',__CODEX_CLIENT_BUILD_ID__:'"reference"','process.env.NODE_ENV':'"production"'}})
const referenceJS=result.outputFiles.find(f=>f.path.endsWith('.js')).text
const referenceCSS=result.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n')
const app=await startFixture()
const browser=await chromium.launch({args:['--no-sandbox']})
const reports=[]
try {
  for(const [width,height]of [[1440,900],[1280,800],[768,1024],[390,844]])for(const theme of ['light','dark']) {
    const images=[]
    for(const variant of ['reference','target']) {
      const context=await browser.newContext({viewport:{width,height},locale:'zh-CN',timezoneId:'Asia/Shanghai',colorScheme:theme,reducedMotion:'reduce'})
      const response=await context.request.post(app.origin+'/auth/login',{headers:{'x-codex-request':'1'},data:{token:FIXTURE_TOKEN}})
      if(!response.ok())throw new Error('Fixture login failed')
      const page=await context.newPage()
      await page.addInitScript(theme=>{
        localStorage.setItem('dsh-codex-last-thread','fixture-thread')
        localStorage.setItem('dsh-codex-theme',theme)
      },theme)
      await page.clock.setFixedTime(new Date('2026-11-17T09:00:00Z'))
      if(variant==='reference') {
        await page.route('**/assets/main.js',route=>route.fulfill({contentType:'text/javascript',body:referenceJS}))
        await page.route('**/assets/main.css',route=>route.fulfill({contentType:'text/css',body:referenceCSS}))
      }
      await page.goto(app.origin)
      await page.locator('textarea').waitFor({state:'visible'})
      await page.waitForFunction(()=>document.querySelector('.dsh-codex-root')?.getAttribute('data-codex-theme')===localStorage.getItem('dsh-codex-theme'))
      // Only the explicitly replaced host-exit control is masked. Layout remains measurable.
      await page.locator('.dsh-codex-root[data-codex-theme]').waitFor()
      await page.getByText('Fixture Model',{exact:false}).first().waitFor({timeout:5000})
      const image=await page.screenshot({path:join(output,width+'-'+theme+'-'+variant+'.png'),animations:'disabled',mask:[page.locator('.dsh-codex-sidebar-exit')]})
      images.push(PNG.sync.read(image))
      await context.close()
    }
    const [a,b]=images,diff=new PNG({width,height})
    const pixels=pixelmatch(a.data,b.data,diff.data,width,height,{threshold:0.1})
    await writeFile(join(output,width+'-'+theme+'-diff.png'),PNG.sync.write(diff))
    const ratio=pixels/(width*height)
    reports.push({width,height,theme,pixels,ratio})
    console.log(width+' '+theme+': '+pixels+' changed pixels ('+(ratio*100).toFixed(3)+'%)')
  }
  await writeFile(join(output,'report.json'),JSON.stringify({baseline,threshold:0.1,allowedRatio:0.001,mask:'host exit control only',scenarios:reports},null,2)+'\n')
  if(reports.some(r=>r.ratio>0.001))throw new Error('Visual parity exceeds 0.1%; inspect the diff images')
}finally{await browser.close();await app.close();await rm(folder,{recursive:true,force:true})}
