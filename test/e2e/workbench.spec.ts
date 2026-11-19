import { test, expect } from '@playwright/test'
async function login(page:any) {
  await page.goto('/')
  await page.getByLabel('访问凭证',{exact:true}).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button',{name:'登录工作台',exact:true}).click()
  await expect(page.locator('.dsh-codex-root')).toBeVisible()
}
async function selectThread(page:any) {
  const project=page.locator('.dsh-codex-tree-project').first()
  await expect(project).toBeVisible()
  if(await project.getAttribute('aria-expanded')!=='true')await project.click()
  await page.getByText('验收会话',{exact:true}).first().click()
  await expect(page.locator('textarea').first()).toBeVisible()
}
test('login, conversation streaming, queue, refresh and logout',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  await login(page)
  await selectThread(page)
  const input=page.locator('textarea').first()
  await input.fill('你好，独立工作台');await input.press('Enter')
  await expect(page.getByText('已收到：你好，独立工作台',{exact:false}).last()).toBeVisible()
  await input.fill('慢速消息');await input.press('Enter')
  await expect(page.locator('.dsh-codex-running-bar')).toBeVisible()
  await expect(input).toHaveValue('')
  await input.fill('排队消息');await input.press('Enter')
  await expect(page.getByText('已收到：排队消息',{exact:false}).last()).toBeVisible({timeout:15000})
  await page.reload()
  await expect(page.getByText('已收到：排队消息',{exact:false}).last()).toBeVisible()
  await page.getByRole('button',{name:'退出 Web 登录'}).click()
  await expect(page.getByLabel('访问凭证',{exact:true})).toBeVisible()
  expect(errors).toEqual([])
})
test('Worker shows activity inline until completion and restores it on demand', async ({ page }, info) => {
  await login(page)
  await selectThread(page)
  const input = page.locator('textarea').first()
  await input.fill('请触发过程面板')
  await input.press('Enter')
  const panel = page.getByRole('button', { name: /执行过程.*用时/ })
  const commentary = page.getByText('正在检查过程夹具', { exact: true })
  const answer = page.getByText('过程夹具最终回答', { exact: true })
  const answerRow = page.locator('.dsh-codex-message.assistant').filter({ has: answer })
  const toolToggle = page.getByRole('button', { name: /执行了 2 条命令/ })
  const expectAligned = async (expanded: boolean) => {
    await expect(toolToggle).toHaveAttribute('aria-expanded', String(expanded))
    const [toolBox, answerBox] = await Promise.all([toolToggle.boundingBox(), answerRow.boundingBox()])
    expect(toolBox!.x).toBeCloseTo(answerBox!.x, 0)
    expect(toolBox!.width).toBeCloseTo(answerBox!.width, 0)
  }
  await expect(commentary).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expect(answer).toBeVisible()
  await expect(panel).toHaveAttribute('aria-expanded', 'false')
  await expect(commentary).toBeHidden()
  expect(await panel.evaluate(element => element.compareDocumentPosition(
    [...document.querySelectorAll('.dsh-codex-message')].find(message => message.textContent?.includes('过程夹具最终回答'))!,
  ) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy()
  await page.screenshot({ path: info.outputPath('worker-process-closed.png') })
  await panel.press('Enter')
  await expect(commentary).toBeVisible()
  await expectAligned(false)
  await toolToggle.click()
  await expectAligned(true)
  await page.locator('summary').getByText('echo process-fixture', { exact: true }).click()
  await expect(page.getByText('过程夹具命令输出')).toBeVisible()
  await expect(answer).toBeVisible()
  await answer.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('worker-process-open.png') })
  await page.reload()
  await expect(panel).toHaveAttribute('aria-expanded', 'false')
  await expect(commentary).toBeHidden()
  await expect(answer).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.click()
  await expectAligned(false)
  await toolToggle.click()
  await expectAligned(true)
  await toolToggle.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('worker-process-mobile.png') })
})

test('subagent activity expands in place and reconciles parallel updates', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('test-subagent-resync', () => this.onmessage?.call(this, new MessageEvent('message', {
          data: JSON.stringify({ seq: 0, ts: Date.now(), type: 'resync', payload: {} }),
        })))
      }
    }
  })
  await login(page)
  await selectThread(page)
  const input = page.locator('textarea').first()
  await input.fill('请触发子代理执行')
  await input.press('Enter')
  const kepler = page.getByRole('region', { name: '子代理 · Kepler' })
  const lorentz = page.getByRole('region', { name: '子代理 · Lorentz' })
  const expand = (name: string) => page.getByRole('button', { name: new RegExp('子代理 · ' + name) })
  await expect(kepler).toContainText('执行中')
  await expect(lorentz).toContainText('执行中')
  await expand('Kepler').focus()
  await expand('Kepler').press('Enter')
  await expand('Lorentz').click()
  await expect(kepler.getByText('Kepler 开始检查')).toBeVisible()
  await expect(lorentz.getByText('Lorentz 开始检查')).toBeVisible()
  await kepler.getByRole('button', { name: /加载更早/ }).click()
  await expect(kepler.getByText('Kepler 较早的记录 3')).toBeVisible()

  const resync = page.waitForRequest(request => request.url().endsWith('/threads/subagent/get') && !request.postDataJSON().payload.metadataOnly)
  await page.evaluate(() => window.dispatchEvent(new Event('test-subagent-resync')))
  await resync
  await expect(kepler.getByText('Kepler 执行结果')).toHaveCount(1)
  await expect(lorentz.getByText('Lorentz 执行结果')).toBeVisible({ timeout: 9000 })
  await expect(kepler).toContainText('已完成')
  await expect(lorentz).toContainText('已完成')
  await expect(kepler.getByText('Lorentz 执行结果')).toHaveCount(0)
  await expect(lorentz.getByText('Kepler 执行结果')).toHaveCount(0)
  await kepler.getByText('echo kepler-fixture', { exact: true }).first().click()
  await expect(kepler.getByText('Kepler 命令输出')).toBeVisible()
  await lorentz.getByText('fixture / snapshot', { exact: true }).click()
  await expect(lorentz.getByText(/Lorentz 工具输出/)).toBeVisible()
  await kepler.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('subagents-desktop.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.getByRole('button', { name: /执行过程/ }).last().click()
  await expect(expand('Kepler')).toHaveAttribute('aria-expanded', 'false')
  await expect(lorentz).toContainText('已完成')
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click()
  await expect(page.locator('.dsh-codex-root')).toHaveAttribute('data-codex-theme', 'dark')
  await expand('Kepler').click()
  await expect(kepler.getByText('Kepler 执行结果')).toBeVisible()
  await expect(kepler).toContainText('已完成')
  const width = await kepler.evaluate(card => ({
    viewport: window.innerWidth, left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right,
  }))
  expect(width.left).toBeGreaterThanOrEqual(0)
  expect(width.right).toBeLessThanOrEqual(width.viewport)
  await kepler.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('subagents-mobile.png') })
})

test('Worker updates permission, model, and effort from a native thread settings event', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('fixture-worker-settings', event => this.onmessage?.call(this, new MessageEvent('message', {
          data: JSON.stringify({ seq: 100, ts: Date.now(), type: 'thread/settings', threadId: 'fixture-thread',
            payload: { settings: (event as CustomEvent).detail } }),
        })))
      }
    }
  })
  await login(page)
  await selectThread(page)
  await expect(page.getByRole('button', { name: '会话权限：需要审批', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-worker-settings', { detail: {
    approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, model: 'router-selected-model', effort: 'high',
  } })))
  await expect(page.getByRole('button', { name: '会话权限：只读', exact: true })).toBeVisible()
  await expect(page.locator('.dsh-codex-model-trigger')).toContainText('router-selected-model')
  await expect(page.locator('[data-meta=effort]')).toContainText('high')
})

test('next-turn settings stay after the current Worker reply and survive reload', async ({ page }) => {
  await login(page)
  await selectThread(page)
  const input = page.locator('textarea').first()
  await input.fill('请触发审批')
  await input.press('Enter')
  const allow = page.getByRole('button', { name: '允许', exact: true })
  await expect(allow).toBeVisible()

  await page.getByRole('button', { name: '会话权限：需要审批', exact: true }).click()
  await page.getByRole('menu').getByText('替我审批', { exact: true }).click()
  await expect(page.getByText('当前回合权限：需要审批。下一轮权限：替我审批。')).toBeVisible()
  await page.locator('.dsh-codex-model-trigger').click()
  await page.getByRole('menu').getByRole('button', { name: /模型/ }).click()
  await page.getByRole('menuitemradio', { name: '默认模型' }).click()
  await page.keyboard.press('Escape')

  const content = page.locator('.dsh-codex-message-content')
  const finalReply = content.getByText('审批已处理。', { exact: true })
  const notices = content.locator(':scope > .dsh-codex-divider').filter({ hasText: '下一轮生效' })
  const expected = ['权限已切换为替我审批（下一轮生效）', '模型已切换为 默认模型（下一轮生效）']
  await expect(notices).toHaveText(expected)
  await expect(content.locator(':scope > :last-child')).toHaveText(expected[1])
  await allow.click()
  await expect(finalReply).toBeVisible()
  const process = content.getByRole('button', { name: /执行过程/ }).last()
  await expect(process).toHaveAttribute('aria-expanded', 'false')
  await expect(notices).toHaveText(expected)
  await expect(content.locator(':scope > :last-child')).toHaveText(expected[1])

  await input.fill('设置后的下一轮')
  await input.press('Enter')
  await expect(content.getByText(/已收到：设置后的下一轮/)).toBeVisible()
  await page.reload()
  await expect(notices).toHaveText(expected)
  const ordered = content.locator(':scope > :is(.dsh-codex-message, .dsh-codex-divider)')
    .filter({ hasText: /审批已处理。|下一轮生效|已收到：设置后的下一轮/ })
  await expect(ordered).toHaveText([/审批已处理。/, ...expected, /已收到：设置后的下一轮/])
})
test('multi-question reply advances before sending all answers',async({page})=>{
  await login(page)
  await selectThread(page)
  const input=page.locator('textarea').first()
  await input.fill('请触发多题提问')
  await input.press('Enter')

  const form=page.locator('.dsh-codex-agent-questions').last()
  await expect(form.getByRole('group',{name:'使用哪个环境？'})).toBeVisible()
  await form.getByRole('radio',{name:'生产环境',exact:true}).check()
  await form.getByRole('button',{name:'下一题',exact:true}).click()
  await expect(form.getByRole('group',{name:'使用哪种输出？'})).toBeVisible()

  await form.getByRole('radio',{name:'完整',exact:true}).check()
  await form.getByRole('button',{name:'上一题',exact:true}).click()
  await expect(form.getByRole('radio',{name:'生产环境',exact:true})).toBeChecked()
  await form.getByRole('button',{name:'下一题',exact:true}).press('Enter')
  await expect(form.getByRole('radio',{name:'完整',exact:true})).toBeChecked()

  const reply=page.waitForRequest(request=>/\/turns\/(submit|steer)$/.test(request.url()))
  await form.getByRole('button',{name:'提交',exact:true}).click()
  expect((await reply).postDataJSON().payload.text).toBe('使用哪个环境？\n生产环境\n\n使用哪种输出？\n完整')
  await expect(form.getByText('此提问已结束',{exact:true})).toBeVisible()
})
test('themes, responsive navigation and file workbench',async({page})=>{
  await login(page);await selectThread(page)
  await page.getByRole('button',{name:'切换深色模式',exact:true}).click()
  await expect(page.locator('.dsh-codex-root')).toHaveAttribute('data-codex-theme','dark')
  await page.getByRole('button',{name:'切换浅色模式',exact:true}).click()
  await expect(page.locator('.dsh-codex-root')).toHaveAttribute('data-codex-theme','light')
  await page.getByRole('button',{name:'右侧面板',exact:true}).click()
  await expect(page.locator('.codex-sidebar')).toBeVisible()
})
test('responsive evidence in both themes',async({page},testInfo)=>{
  test.skip(!process.env.VISUAL,'Run with npm run test:visual')
  await login(page);await selectThread(page)
  for(const [width,height]of [[1440,900],[1280,800],[768,1024],[390,844]]) {
    await page.setViewportSize({width,height})
    for(const theme of ['light','dark']) {
      await page.evaluate(t=>localStorage.setItem('dsh-codex-theme',t),theme)
      await page.reload()
      // Toggle through the real control when the stored key differs from baseline.
      const root=page.locator('.dsh-codex-root')
      if(await root.getAttribute('data-codex-theme')!==theme)await page.getByRole('button',{name:theme==='dark'?'切换深色模式':'切换浅色模式',exact:true}).click()
      await expect(root).toHaveAttribute('data-codex-theme',theme)
      await page.screenshot({path:testInfo.outputPath(width+'-'+theme+'.png'),animations:'disabled'})
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)
      expect(overflow).toBe(false)
    }
  }
})

test('login connection failure has a working retry and clears only the connection error',async({page},testInfo)=>{
  let unavailable=true
  await page.route('**/auth/session',route=>unavailable?route.abort():route.continue())
  await page.goto('/')
  await expect(page.getByRole('alert')).toHaveText('无法连接服务，请检查服务状态后重试。')
  await expect(page.getByRole('button',{name:'重试连接',exact:true})).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('login-error.png')})
  unavailable=false
  await page.getByRole('button',{name:'重试连接',exact:true}).click()
  await expect(page.getByRole('button',{name:'重试连接',exact:true})).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByLabel('访问凭证',{exact:true}).fill('incorrect-token')
  await page.getByRole('button',{name:'登录工作台',exact:true}).click()
  await expect(page.getByRole('alert')).toHaveText('访问凭证不正确')
  await page.screenshot({path:testInfo.outputPath('login-credential-error.png')})
  await page.reload()
  await expect(page.getByLabel('访问凭证',{exact:true})).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('login-desktop.png')})
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:testInfo.outputPath('login-mobile.png')})
})

test('file preview, HTML sandbox, terminal retention and Git workbench',async({page},testInfo)=>{
  await login(page);await selectThread(page)
  await page.getByRole('button',{name:'右侧面板',exact:true}).click()
  const sidebar=page.locator('.codex-sidebar')
  await expect(sidebar).toBeVisible()
  await sidebar.getByText('示例.md',{exact:true}).first().dblclick()
  await expect(sidebar.getByRole('heading',{name:'验收文档',exact:true})).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('document.png')})
  await sidebar.getByRole('tab',{name:/工作区文件/}).click()
  await sidebar.getByText('preview.html',{exact:true}).first().click()
  const frame=sidebar.locator('iframe')
  await expect(frame).toHaveAttribute('sandbox','allow-scripts allow-forms')
  await expect(sidebar.frameLocator('iframe').getByRole('heading',{name:'HTML fixture'})).toBeVisible()
  await sidebar.getByRole('button',{name:'新建标签页',exact:true}).click()
  const terminalOpened=page.waitForResponse(response=>response.url().endsWith('/terminal/open'))
  await sidebar.getByRole('button',{name:/运行命令/}).click()
  const terminal=(await (await terminalOpened).json()).result.value
  const request=async(method:string,payload:any={})=>{
    const response=await page.request.post('/codex-cli/'+method,{headers:{'x-codex-request':'1'},data:{type:'client-request',rpcId:'browser-check',method,payload}})
    return (await response.json()).result.value
  }
  const shell=sidebar.locator('.xterm-helper-textarea').first()
  await shell.focus()
  await shell.pressSequentially("export E2E_KEEP=retained; printf 'E2E_TERMINAL_OK\\n'")
  await shell.press('Enter')
  await expect.poll(async()=>String((await request('terminal/read',{sessionId:terminal.sessionId,cursor:0})).data)).toContain('E2E_TERMINAL_OK')
  await sidebar.getByRole('button',{name:'收起右侧面板',exact:true}).click()
  await page.getByRole('button',{name:'右侧面板',exact:true}).click()
  expect((await request('status')).runtime.terminalSessionCount).toBe(1)
  await sidebar.getByRole('button',{name:'新建标签页',exact:true}).click()
  await sidebar.getByRole('button',{name:/查看分支与变更/}).click()
  await expect(sidebar.getByRole('tab',{name:'历史',exact:true})).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('git.png')})
  await sidebar.getByRole('tab',{name:/终端/}).first().click()
  expect((await request('status')).runtime.terminalSessionCount).toBe(1)
  await shell.focus();await shell.pressSequentially('echo $E2E_KEEP');await shell.press('Enter')
  await expect.poll(async()=>String((await request('terminal/read',{sessionId:terminal.sessionId,cursor:0})).data)).toMatch(/retained\r?\n/)
  await page.screenshot({path:testInfo.outputPath('terminal.png')})
})
