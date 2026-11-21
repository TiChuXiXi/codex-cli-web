import {test,expect,type Page} from '@playwright/test'
async function mockVersions(page:Page) {
  const actions:string[]=[]
  const check={cli:{version:'0.167.0',raw:'codex-cli 0.167.0'},daemon:{appServerVersion:'0.167.0'},latest:{version:'0.169.0',source:'fixture'},updateAvailable:true,install:{context:'npm',executable:'/fixture/codex',updateAction:null,cachedLatest:null},doctor:{overallStatus:'ok',codexVersion:'0.167.0',checks:[],updates:null},checkedAt:1794910000000}
  const intercept=async(route:any)=>{
    const message=route.request().postDataJSON()
    const endpoint=message.method
    actions.push(endpoint)
    const value=endpoint==='versions/check'?check:endpoint==='versions/job'?{jobId:'fixture-job',kind:'update',status:'done',command:'fixture update',exitCode:0,lines:['Fixture complete']}:{jobId:'fixture-job'}
    await route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}})})
  }
  await page.route('**/codex-cli/versions/*',intercept)
  await page.route('**/codex-cli/daemon/action',intercept)
  return actions
}
async function open(page:Page,network=false) {
  await page.goto(network?'http://127.0.0.1:18788/':'/')
  if(!network) {
    await page.getByLabel('访问凭证',{exact:true}).fill('fixture-access-token-only-for-tests')
    await page.getByRole('button',{name:'登录工作台',exact:true}).click()
  }
  await expect(page.locator('.dsh-codex-root')).toBeVisible()
  await page.getByRole('button',{name:'设置',exact:true}).first().click()
  await expect(page.getByRole('region',{name:'应用设置'})).toBeVisible()
}
test('settings contains the migrated update, daemon confirmation and rollback flows',async({page})=>{
  const actions=await mockVersions(page)
  await open(page)
  await expect(page.getByRole('heading',{name:'版本与更新',exact:true})).toBeVisible()
  await expect(page.getByText('zcodex update --check',{exact:true})).toBeVisible()
  await expect(page.locator('.dsh-codex-versions[role=dialog]')).toHaveCount(0)
  await expect(page.locator('.versions-update')).toContainText('0.169.0')
  await page.locator('.versions-update-actions button.primary').click()
  await expect.poll(()=>actions.includes('versions/update')).toBe(true)
  await expect(page.locator('.versions-task.is-done')).toBeVisible()
  await page.getByRole('button',{name:'重启',exact:true}).click()
  expect(actions.includes('daemon/action')).toBe(false)
  await page.locator('.versions-confirm').getByRole('button',{name:'取消',exact:true}).click()
  expect(actions.includes('daemon/action')).toBe(false)
  await page.getByRole('button',{name:'重启',exact:true}).click()
  await page.locator('.versions-confirm button.primary').click()
  await expect.poll(()=>actions.includes('daemon/action')).toBe(true)
  await expect(page.locator('.versions-task.is-done')).toBeVisible()
  await page.locator('.versions-advanced summary').click()
  await page.locator('.versions-rollback input').fill('0.167.0')
  await page.locator('.versions-rollback button[type=submit]').click()
  await expect.poll(()=>actions.includes('versions/rollback')).toBe(true)
  await page.getByRole('button',{name:'返回工作台',exact:true}).click()
  await expect(page.getByRole('region',{name:'应用设置'})).toHaveCount(0)
})
test('whitelist editing persists, rejects invalid IPs and reloads the actual saved values',async({page})=>{
  await mockVersions(page);await open(page)
  await page.getByRole('tab',{name:'访问白名单',exact:true}).click()
  await expect(page.getByRole('heading',{name:'访问白名单',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'添加 IP',exact:true}).click()
  await page.getByLabel('允许访问的 IP 1',{exact:true}).fill('192.168.1.80')
  await page.getByRole('button',{name:'保存白名单',exact:true}).click()
  await expect(page.getByRole('status')).toContainText('白名单已保存并立即生效')
  await page.reload()
  await page.getByRole('button',{name:'设置',exact:true}).first().click()
  await page.getByRole('tab',{name:'访问白名单',exact:true}).click()
  await expect(page.getByLabel('允许访问的 IP 1',{exact:true})).toHaveValue('192.168.1.80')
  await page.getByRole('button',{name:'添加 IP',exact:true}).click()
  await page.getByLabel('允许访问的 IP 2',{exact:true}).fill('invalid-ip')
  await page.getByRole('button',{name:'保存白名单',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('无效白名单')
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'重新加载',exact:true}).click()
  await expect(page.getByLabel('允许访问的 IP 1',{exact:true})).toHaveValue('192.168.1.80')
  await expect(page.getByLabel('允许访问的 IP 2',{exact:true})).toHaveCount(0)
})
test('removing your own IP prompts before saving and can be cancelled',async({page})=>{
  await mockVersions(page);await open(page,true)
  await page.getByRole('tab',{name:'访问白名单',exact:true}).click()
  await expect(page.getByLabel('允许访问的 IP 1',{exact:true})).toHaveValue('127.0.0.1')
  await page.getByLabel('允许访问的 IP 1',{exact:true}).fill('192.168.1.80')
  await page.getByRole('button',{name:'保存白名单',exact:true}).click()
  await expect(page.getByText('当前 IP 将失去访问权限',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'取消',exact:true}).click()
  await expect(page.getByText('当前 IP 将失去访问权限',{exact:true})).toHaveCount(0)
  const response=await page.request.post('http://127.0.0.1:18788/codex-cli/settings/read',{headers:{'x-codex-request':'1'},data:{type:'client-request',rpcId:'verify-cancel',method:'settings/read',payload:{}}})
  expect((await response.json()).result.value.allowedClients).toEqual(['127.0.0.1'])
})
test('settings page stays usable at desktop and mobile sizes in both themes',async({page},info)=>{
  await mockVersions(page);await open(page,true)
  await page.emulateMedia({reducedMotion:'reduce'})
  for(const [width,height] of [[1440,900],[390,844]])for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height})
    const root=page.locator('.dsh-codex-root')
    if(await root.getAttribute('data-codex-theme')!==theme)await page.getByRole('button',{name:theme==='dark'?'切换深色模式':'切换浅色模式',exact:true}).click()
    for(const tab of ['版本与更新','访问白名单']){
      await page.getByRole('tab',{name:tab,exact:true}).click()
      await page.screenshot({path:info.outputPath(width+'-'+theme+'-'+(tab==='版本与更新'?'versions':'access')+'.png'),animations:'disabled'})
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false)
    }
  }
})

test('returning from settings preserves a conversation draft and warns about unsaved whitelist changes',async({page})=>{
  await mockVersions(page)
  await page.goto('/')
  await page.getByLabel('访问凭证',{exact:true}).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button',{name:'登录工作台',exact:true}).click()
  await page.locator('.dsh-codex-tree-project').first().click()
  await page.getByText('验收会话',{exact:true}).first().click()
  await page.locator('textarea').first().fill('设置页往返草稿')
  await page.getByRole('button',{name:'设置',exact:true}).first().click()
  await page.getByRole('tab',{name:'访问白名单',exact:true}).click()
  await page.getByRole('button',{name:'添加 IP',exact:true}).click()
  await page.locator('.settings-ip-row input').last().fill('192.168.1.91')
  page.once('dialog',dialog=>dialog.dismiss())
  await page.getByRole('button',{name:'返回工作台',exact:true}).click()
  await expect(page.getByRole('region',{name:'应用设置'})).toBeVisible()
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'返回工作台',exact:true}).click()
  await expect(page.locator('textarea').first()).toHaveValue('设置页往返草稿')
})

test('version job polling reports unknown status and recovers without repeating an update',async({page},info)=>{
  await page.clock.install({time:new Date('2026-11-17T09:00:00Z')})
  await page.clock.pauseAt(new Date('2026-11-17T09:00:01Z'))
  const actions=await mockVersions(page)
  let queries=0
  await page.route('**/codex-cli/versions/job',async route=>{
    queries++
    if(queries<3){await route.fulfill({status:503,contentType:'application/json',body:'{}'});return}
    const message=route.request().postDataJSON()
    await route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value:{jobId:'fixture-job',kind:'update',status:'done',command:'fixture update',exitCode:0,lines:['Fixture complete']}}})})
  })
  await open(page)
  await page.locator('.versions-update-actions button.primary').click()
  await expect(page.locator('.versions-task.is-running')).toBeVisible()
  for(let attempt=0;attempt<3;attempt++) {
    const response=page.waitForResponse(response=>response.url().endsWith('/versions/job'))
    await page.clock.runFor(1000)
    await response
    if(attempt===0) {
      await expect(page.getByRole('alert')).toContainText('任务状态读取失败，正在重试')
      await expect(page.locator('.versions-task')).toContainText('状态待确认')
      await page.screenshot({path:info.outputPath('settings-job-retry.png')})
    }
  }
  await expect(page.locator('.versions-task.is-done')).toBeVisible({timeout:10000})
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(actions.filter(endpoint=>endpoint==='versions/update')).toHaveLength(1)
})
test('reload confirms before discarding whitelist edits and cancellation preserves the draft',async({page},info)=>{
  await mockVersions(page);await open(page)
  await page.getByRole('tab',{name:'访问白名单',exact:true}).click()
  await page.getByRole('button',{name:'添加 IP',exact:true}).click()
  const input=page.locator('.settings-ip-row input').last()
  await input.fill('192.168.1.92')
  page.once('dialog',dialog=>dialog.dismiss())
  await page.getByRole('button',{name:'重新加载',exact:true}).click()
  await expect(input).toHaveValue('192.168.1.92')
  await page.screenshot({path:info.outputPath('settings-unsaved.png')})
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'重新加载',exact:true}).click()
  await expect(page.locator('.settings-ip-row input').last()).not.toHaveValue('192.168.1.92')
})
