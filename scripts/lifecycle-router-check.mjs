import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, expect } from '@playwright/test'

export async function checkInstalledRouter({root,state,config,query,old,next}) {
  const env=process.env
  const launcher=env.CODEX_WEB_ROUTER_LAUNCHER, hash=env.CODEX_WEB_ROUTER_LAUNCHER_SHA256
  const model=env.CODEX_WEB_ROUTER_LIVE_MODEL, effort=env.CODEX_WEB_ROUTER_LIVE_EFFORT
  const auth=env.CODEX_WEB_ROUTER_AUTH_HOME
  assert.ok(env.CODEX_WEB_LIFECYCLE_ROUTER_LIVE==='1' && launcher && isAbsolute(launcher) &&
    auth && isAbsolute(auth) && /^[a-f0-9]{64}$/.test(hash) && model && effort,'Missing explicit live target')
  await query(['init','--config',config,'--prepare-router',launcher,'--sha256',hash])
  const name='release-'+randomUUID().slice(0,10), projectRoot=join(root,'projects'), project=join(projectRoot,name)
  const routerHome=join(state,'router','codex-home')
  await mkdir(project,{recursive:true})
  await mkdir(routerHome,{recursive:true,mode:0o700})
  const {tokens,auth_mode}=JSON.parse(await readFile(join(auth,'auth.json'),'utf8'))
  assert.equal(auth_mode,'chatgpt')
  const {id_token,account_id,access_token}=tokens
  assert.ok(id_token && account_id && JSON.parse(Buffer.from(access_token.split('.')[1],'base64url')).exp>Date.now()/1000+300)
  await writeFile(join(routerHome,'auth.json'),JSON.stringify({auth_mode,tokens:{id_token,account_id,access_token,refresh_token:''},
    last_refresh:new Date().toISOString()}),{flag:'wx',mode:0o600})
  const file=join(state,'router-installation.json')
  const manifest=JSON.parse(await readFile(file,'utf8'))
  assert.equal(manifest.launcherSha256,hash)
  await writeFile(file,JSON.stringify({...manifest,projectRoot,models:[{model,effort}],projects:[{id:'qa',name,cwd:project,sandbox:'read-only'}]}))
  const token=(await readFile(join(state,'access-token'),'utf8')).trim()
  const browser=await chromium.launch({executablePath:env.CODEX_WEB_TEST_CHROMIUM || undefined})
  const page=await browser.newPage()
  async function login(url) {
    await page.goto(url)
    await page.getByLabel('访问凭证',{exact:true}).fill(token)
    await page.getByRole('button',{name:'登录工作台',exact:true}).click()
    if(!await page.getByRole('log',{name:'Router 对话'}).isVisible())
      await page.getByRole('button',{name:'中枢 Router',exact:true}).click()
  }
  async function history(url) {
    const r=await page.request.post(url+'/codex-cli/router/read',{headers:{'x-codex-request':'1'},
      data:{type:'client-request',rpcId:randomUUID(),method:'router/read',payload:{}}})
    const body=await r.json()
    assert.ok(body.result?.ok)
    return body.result.value
  }
  try {
    const before=await query(['start'])
    assert.equal(before.router.policy,2)
    assert.equal(before.version,old.version)
    await login(before.origin)
    const input=page.getByRole('region',{name:'Router',exact:true}).getByRole('textbox')
    await input.fill('请调用 list_projects 工具，用一行回复唯一登记项目的完整名称。')
    await input.press('Enter')
    await expect.poll(async()=> (await history(before.origin)).messages.some(m=>m.role==='assistant'&&m.status==='completed'&&m.text.includes(name)),
      {timeout:120000}).toBe(true)
    const initial=await history(before.origin)
    assert.ok(initial.primaryThreadId)
    const db=new DatabaseSync(join(state,'router','router.sqlite'),{readOnly:true})
    try { assert.ok(db.prepare("SELECT 1 FROM router_records WHERE kind='tool-call' AND json_extract(value,'$.tool')='list_projects'").get()) }
    finally {db.close()}
    assert.equal((await query(['update','--yes'])).state,'running')
    const after=await query(['status'])
    assert.equal(after.version,next.version)
    assert.equal(after.router.policy,2)
    await login(after.origin)
    const resumed=await history(after.origin)
    assert.equal(resumed.primaryThreadId,initial.primaryThreadId)
    assert.ok(resumed.messages.some(m=>m.role==='assistant'&&m.status==='completed'&&m.text.includes(name)))
    await expect(page.getByRole('log',{name:'Router 对话'}).getByText(name,{exact:false}).last()).toBeVisible()
    assert.equal(resumed.tasks.length,0)
    console.log(JSON.stringify({platform:process.platform,realRouter:2,tool:'list_projects',from:old.version,to:next.version,
      sameThread:true,browserHistory:true}))
  } finally {await browser.close()}
}
