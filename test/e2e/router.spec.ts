import { expect, test } from '@playwright/test'
import type { RouterSnapshot } from '../../shared/contracts'

test('new project opens the Router permission confirmation when the Worker default needs authorization', async ({ page }) => {
  let pending = false
  await page.route('**/codex-cli/status', async route => {
    const response = await route.fetch()
    const json = await response.json()
    json.result.value.router = { enabled: true, phase: 'ready' }
    await route.fulfill({ response, json })
  })
  await page.route('**/codex-cli/router/**', async route => {
    const { rpcId, method } = route.request().postDataJSON()
    let value: unknown
    if (method === 'router/settings/read') value = { projectRoot: '/fixture/projects' }
    if (method === 'router/projects/create') {
      pending = true
      value = { cwd: '/fixture/projects/示例', status: 'needs_confirmation' }
    }
    if (method === 'router/read') value = {
      enabled: true, phase: 'ready', error: null, model: null, busy: false, messages: [],
      clarifications: pending ? [{ id: 'worker-permission', revision: 1, kind: 'workerPermission',
        label: '允许此任务使用指定的 Worker 权限？',
        candidates: [{ id: 'allow', name: '示例 · 工作区写入，按需审批' }],
      }] : [],
      tasks: [],
    }
    await route.fulfill({ json: { type: 'server-response', rpcId, result: { ok: true, value } } })
  })
  await page.goto('/')
  await page.getByLabel('访问凭证', { exact: true }).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button', { name: '登录工作台' }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建项目' })
  await dialog.getByLabel('项目名称或 HTTPS 仓库地址').fill('示例')
  await dialog.getByRole('button', { name: '创建并打开' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: 'Router', exact: true })
    .getByText('允许此任务使用指定的 Worker 权限？')).toBeVisible()
})

test('Router shows the before-and-after settings and requires confirmation for a Worker restart', async ({ page }) => {
  let confirmation: unknown
  await page.route('**/codex-cli/status', async route => {
    const response = await route.fetch()
    const json = await response.json()
    json.result.value.router = { enabled: true, phase: 'ready' }
    await route.fulfill({ response, json })
  })
  await page.route('**/codex-cli/router/**', async route => {
    const { rpcId, method, payload } = route.request().postDataJSON()
    if (method === 'router/clarifications/confirm') confirmation = payload
    const value = method === 'router/read' ? {
      enabled: true, phase: 'ready', error: null, model: null, busy: false, messages: [], tasks: [],
      clarifications: confirmation ? [] : [{ id: 'settings', revision: 2, kind: 'workerSettings',
        label: '确认修改设置并继续当前 Worker 任务？', candidates: [{ id: 'allow', name: '验收项目 · 验收会话',
          summary: '当前：Sol / medium / 只读。更改后：Sol / high / 工作区写入。会中断当前回合，在同一会话中继续原任务。' }] }],
    } : {}
    await route.fulfill({ json: { type: 'server-response', rpcId, result: { ok: true, value } } })
  })
  await page.goto('/')
  await page.getByLabel('访问凭证', { exact: true }).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button', { name: '登录工作台' }).click()
  await page.getByRole('button', { name: '中枢 Router', exact: true }).click()
  const card = page.getByRole('region', { name: '确认修改设置并继续当前 Worker 任务？' })
  await expect(card).toContainText('Sol / medium / 只读')
  await expect(card).toContainText('Sol / high / 工作区写入')
  expect(confirmation).toBeUndefined()
  await card.getByRole('button', { name: '确认设置' }).click()
  await expect(card).toBeHidden()
  expect(confirmation).toEqual({ id: 'settings', revision: 2, candidateId: 'allow' })
})

test('Router restores a choice and handles the selected Worker approval in chat', async ({ page }, info) => {
  let pending = true
  let accepted = false
  let workerFinished = false
  let confirmation: unknown
  const messages: { id: string, role: string, text: string, status: string }[] = []
  await page.route('**/codex-cli/status', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.result.value.router = { enabled: true, phase: 'ready' }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/codex-cli/router/**', async route => {
    const request = route.request().postDataJSON()
    let value: unknown = {}
    if (request.method === 'router/send') {
      messages.push({ id: 'user-1', role: 'user', text: request.payload.text, status: 'completed' })
    }
    if (request.method === 'router/clarifications/confirm') {
      confirmation = request.payload
      pending = false
      accepted = true
    }
    if (request.method === 'router/interactions/respond') {
      expect(request.payload).toEqual({ dispatchId: 'task-1', instanceId: 'instance-1', response: { decision: 'accept' } })
      workerFinished = true
    }
    if (request.method === 'router/read') value = {
      enabled: true, phase: 'ready', error: null, model: null, busy: false, displayName: '南桥', messages, latestEventId: accepted ? 1 : 0,
      clarifications: pending ? [{ id: 'clarify-1', revision: 1, kind: 'session', label: '选择目标会话', candidates: [
        { id: 'another-thread', name: '之前的改动', project: '验收项目' },
        { id: 'fixture-thread', name: '验收会话', project: '验收项目', reasons: ['近期活动'] },
      ] }] : [],
      tasks: accepted ? [{ id: 'task-1', project: '验收项目', threadId: 'fixture-thread',
        status: workerFinished ? 'completed' : 'awaiting_approval',
        receiptStatus: workerFinished ? 'unknown' : null, updatedAt: Date.now(), summary: null, error: null }] : [],
      interactions: accepted && !workerFinished ? [{ requestId: 7, instanceId: 'instance-1', dispatchId: 'task-1',
        method: 'item/commandExecution/requestApproval', params: { command: 'touch approved.txt', cwd: '/fixture' },
        worker: '验收项目 · 验收会话', instruction: '创建验收标记' }] : [],
    }
    await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } } })
  })
  await page.goto('/')
  await page.getByLabel('访问凭证', { exact: true }).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button', { name: '登录工作台' }).click()
  await page.getByRole('button', { name: '中枢 Router', exact: true }).click()
  await page.getByRole('textbox', { name: '给南桥发送消息' }).fill('继续之前的修改')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('继续之前的修改', { exact: true })).toBeVisible()
  if (process.env.VISUAL === '1') await page.screenshot({ path: info.outputPath('router-desktop-light.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  const header = page.locator('.dsh-codex-workbench-header')
  const title = await header.getByRole('heading', { name: 'Router' }).boundingBox()
  const tabs = await header.getByRole('navigation', { name: 'Router 视图' }).boundingBox()
  expect(tabs!.x).toBeGreaterThanOrEqual(title!.x + title!.width)
  expect(Math.abs(tabs!.y + tabs!.height / 2 - title!.y - title!.height / 2)).toBeLessThan(2)
  await page.getByRole('button', { name: '切换深色模式' }).click()
  await expect(page.locator('.dsh-codex-root')).toHaveAttribute('data-codex-theme', 'dark')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
  if (process.env.VISUAL === '1') await page.screenshot({ path: info.outputPath('router-mobile-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await page.getByRole('button', { name: '中枢 Router', exact: true }).click()
  const choice = page.getByRole('region', { name: '选择目标会话' })
  await choice.getByRole('listitem').filter({ hasText: '验收会话' }).getByRole('button', { name: '选择' }).click()
  expect(confirmation).toEqual({ id: 'clarify-1', revision: 1, candidateId: 'fixture-thread' })
  await expect(choice).toHaveCount(0)
  await page.getByRole('button', { name: '任务 · 有更新', exact: true }).click()
  await expect(page.getByText('等待你的审批', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '在对话中处理' }).click()
  const card = page.getByRole('region', { name: '验收项目 · 验收会话' })
  await expect(card.getByText('touch approved.txt')).toBeVisible()
  await card.getByRole('button', { name: '允许', exact: true }).click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: '中枢 Router', exact: true }).click()
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.getByText('任务回执待核对', { exact: true })).toBeVisible()
  await expect(page.getByText('Worker 回合已结束', { exact: false })).toBeVisible()
})

test('Router shares message rendering, keyboard input, drafts and stream scrolling', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const Native = window.EventSource
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        window.addEventListener('fixture-router-update', () => this.onmessage?.call(this,
          new MessageEvent('message', { data: JSON.stringify({ type: 'router/changed', payload: {} }) })))
      }
    }
  })
  let busy = false
  let fail = true
  const ids: string[] = []
  const messages: RouterSnapshot['messages'] = [{ id: 'agent-1', role: 'assistant', status: 'completed',
    text: '| 会话名称 | 会话 ID |\n| --- | --- |\n| 已有会话 | `session-1` |\n\n```js\nconst total = 1 + 1\n```' }]
  await page.route('**/codex-cli/status', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.result.value.router = { enabled: true, phase: 'ready' }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/codex-cli/router/**', async route => {
    const request = route.request().postDataJSON()
    if (request.method === 'router/send') {
      ids.push(request.payload.requestId)
      if (fail) {
        fail = false
        await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId,
          result: { ok: false, error: { code: 'fixture-failure', message: '发送失败，请重试' } } } })
        return
      }
      if (busy) messages.push({ id: 'queued', role: 'user', status: 'queued', text: request.payload.text })
      else {
        messages.push({ id: 'user-1', role: 'user', status: 'completed', text: request.payload.text, turnId: 'turn-1', durationMs: 155000 })
        messages.push({ id: 'progress', role: 'assistant', status: 'completed', text: '正在检索会话', turnId: 'turn-1', phase: 'commentary' })
        messages.push({ id: 'tool', role: 'assistant', status: 'completed', text: '', turnId: 'turn-1', tool: { name: 'list_sessions', status: 'completed', outcome: { success: true } } })
        messages.push({ id: 'tool-2', role: 'assistant', status: 'completed', text: '', turnId: 'turn-1', tool: { name: 'list_projects', status: 'failed', outcome: { success: false, code: 'fixture-error' } } })
        messages.push({ id: 'stream', role: 'assistant', status: 'streaming', text: '正在生成结果', turnId: 'turn-1', phase: 'final_answer' })
        busy = true
      }
    }
    const value = request.method === 'router/read'
      ? { enabled: true, phase: 'ready', error: null, model: 'gpt-6.1-terra', effort: 'high',
          models: [{ id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], busy, activeTurnId: busy ? 'turn-1' : undefined, messages,
          clarifications: [], tasks: [], latestEventId: 0 } : {}
    await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } } })
  })
  await page.goto('/')
  await page.getByLabel('访问凭证', { exact: true }).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button', { name: '登录工作台' }).click()
  await page.getByRole('button', { name: '中枢 Router', exact: true }).click()
  const router = page.getByRole('region', { name: 'Router', exact: true })
  const input = page.getByRole('textbox', { name: '给助手发送消息' })
  const send = router.getByRole('button', { name: '发送', exact: true })
  await expect(router.getByRole('table')).toBeVisible()
  await expect(router.locator('pre')).toContainText('const total = 1 + 1')
  await expect(router.getByText('GPT-6.1 Terra', { exact: true })).toBeVisible()
  await input.fill('第一行')
  await input.press('Shift+Enter')
  await input.press('a')
  await expect(input).toHaveValue('第一行\na')
  expect(ids).toHaveLength(0)
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  expect(ids).toHaveLength(0)
  await input.dispatchEvent('compositionend')
  await input.fill('重试消息')
  await input.press('Enter')
  await expect(router.getByRole('alert')).toHaveText('发送失败，请重试')
  await expect(input).toHaveValue('重试消息')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(ids[1])
  await expect(send).toBeDisabled()
  await expect(router.getByRole('status')).toContainText('助手 正在回复')
  await input.fill('排在下一轮')
  await send.click()
  await expect(router.getByText('已排队', {exact:true})).toBeVisible()
  await input.fill('尚未发送的草稿')
  await expect(send).toBeEnabled()

  const log = router.getByRole('log')
  const panel = log.getByRole('button', { name: /执行过程.*用时/ })
  const progress = log.getByText('正在检索会话', { exact: true })
  const tool = log.getByRole('button', { name: /调用了 2 个工具/ })
  await expect(panel).toHaveCount(0)
  await expect(progress).toBeVisible()
  await expect(tool).toBeVisible()
  const update = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-router-update')))
  }
  messages.find(message => message.id === 'stream')!.text = Array.from({ length: 60 }, (_, i) => '流式消息第 ' + i + ' 行').join('\n\n')
  await update()
  await expect(log).toContainText('流式消息第 59 行')
  await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(33)
  await log.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  await expect(router.getByRole('button', { name: '回到底部' })).toBeVisible()
  messages.find(message => message.id === 'stream')!.text += '\n\n新增尾部内容'
  await update()
  await expect(log).toContainText('新增尾部内容')
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(0)
  await router.getByRole('button', { name: '回到底部' }).click()
  await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(33)
  const currentInput = messages.find(message => message.id === 'user-1')!
  currentInput.status = 'unknown'
  busy = false
  await update()
  await expect(log.getByText('消息结果待核对')).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expect(progress).toBeVisible()
  currentInput.status = 'completed'
  messages.find(message => message.id === 'stream')!.status = 'completed'
  await update()
  await expect(send).toBeEnabled()
  await expect(panel).toHaveAttribute('aria-expanded', 'false')
  await expect(progress).toBeHidden()
  await expect(tool).toBeHidden()
  await expect(log).toContainText('新增尾部内容')
  await panel.click()
  await expect(progress).toBeVisible()
  await expect(tool).toBeVisible()
  await tool.click()
  await log.locator('summary').getByText('tool / list_projects', { exact: true }).click()
  await expect(log.getByText(/fixture-error/)).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Router', exact: true })).toBeVisible()
  await expect(input).toHaveValue('尚未发送的草稿')
  await expect(panel).toHaveAttribute('aria-expanded', 'false')
  await expect(progress).toBeHidden()
  await log.evaluate(el => { el.scrollTop = 0 })
  await page.screenshot({ path: info.outputPath('router-chat-desktop.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '切换深色模式' }).click()
  await expect(router.getByRole('table')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({ path: info.outputPath('router-chat-mobile-dark.png'), animations: 'disabled' })
  await panel.click()
  await expect(progress).toBeVisible()
  await expect(tool).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({ path: info.outputPath('router-process-mobile-dark.png'), animations: 'disabled' })
  expect(errors).toEqual([])
})

test('WeChat settings bind locally, show the first-message boundary and independently toggle incoming tasks', async ({page}) => {
  const state = {phase:'unbound',hasBinding:false,owner:null as string|null, qr:null as string|null,loginId:null as string|null,
    results:true,decisions:true,canNotify:false,lastReceived:null,lastSent:null,pending:0,unknown:0,failed:0}
  await page.route('**/codex-cli/status',async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.result.value.router = {enabled:true,phase:'ready'}
    await route.fulfill({response,json:body})
  })
  await page.route('**/codex-cli/wechat/**',async route => {
    const {method,payload,rpcId} = route.request().postDataJSON()
    if (method==='wechat/bind') Object.assign(state,{phase:'waiting_scan',qr:'https://example.invalid/fixture-qr',loginId:'fixture'})
    if (method==='wechat/preferences') Object.assign(state,payload)
    if (method==='wechat/disconnect') state.phase='disconnected'
    await route.fulfill({json:{type:'server-response',rpcId,result:{ok:true,value:state}}})
  })
  await page.goto('/')
  await page.getByLabel('访问凭证',{exact:true}).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button',{name:'登录工作台'}).click()
  await page.getByRole('button',{name:'设置',exact:true}).first().click()
  await page.getByRole('tab',{name:'微信接入'}).click()
  await page.getByRole('button',{name:'扫码绑定'}).click()
  await expect(page.getByRole('img',{name:'使用本人微信扫描绑定二维码'})).toHaveAttribute('src',/^data:image\/gif;base64,/)
  Object.assign(state,{phase:'connected',hasBinding:true,qr:null,loginId:null,owner:'••••wechat'})
  await expect(page.getByText(/请先在微信发一句话/)).toBeVisible()
  const actionGroup = page.locator('.settings-actions')
  await expect(actionGroup).toHaveCSS('column-gap','8px')
  const disconnect = await page.getByRole('button',{name:'断开连接'}).boundingBox()
  const unbind = await page.getByRole('button',{name:'解除绑定'}).boundingBox()
  expect(unbind!.x - (disconnect!.x + disconnect!.width)).toBeGreaterThanOrEqual(8)
  const results = page.getByRole('checkbox',{name:'任务结果'})
  await expect(results).toBeChecked()
  await results.uncheck()
  await expect(results).not.toBeChecked()
  await expect(page.getByRole('checkbox',{name:'审批及决策'})).toBeChecked()
  await page.getByRole('button',{name:'断开连接'}).click()
  await expect(page.getByRole('button',{name:'恢复连接'})).toBeVisible()
})

test('Router settings expose PSM progress, pause, resume and distinct rebuild controls',async ({page})=>{
  let enabled=false,paused=false
  const actions:string[]=[]
  await page.route('**/codex-cli/status',async route=>{
    const response=await route.fetch(),body=await response.json()
    body.result.value.router={enabled:true,phase:'ready'}
    await route.fulfill({response,json:body})
  })
  await page.route('**/codex-cli/router/**',async route=>{
    const {rpcId,method,payload}=route.request().postDataJSON()
    let value:unknown={}
    if(method==='router/settings/read') value={models:[],model:{model:'test',effort:'medium'},projectRoot:'',revision:0}
    if(method==='router/psm/profile')value={projects:[{id:'p',name:'aaa'}],entries:[]}
    if(method==='router/psm/control') {
      actions.push(payload.action)
      if(payload.action==='enable')enabled=true
      paused=payload.action==='pause'
    }
    if(method==='router/psm/status'||method==='router/psm/control')value={
      enabled,paused,policy:1,phase:enabled?(paused?'paused':'indexing'):'disabled',indexed:1,total:2,pending:1,projects:1}
    await route.fulfill({json:{type:'server-response',rpcId,result:{ok:true,value}}})
  })
  await page.goto('/')
  await page.getByLabel('访问凭证',{exact:true}).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button',{name:'登录工作台'}).click()
  await page.getByRole('button',{name:'设置',exact:true}).first().click()
  await page.getByRole('tab',{name:'中枢',exact:true}).click()
  for (const name of ['人格描述','语言风格','微信表达偏好']) {
    const field = page.getByRole('textbox',{name})
    await expect(field).toHaveJSProperty('tagName','TEXTAREA')
    await field.fill('第一行\n第二行')
    await expect(field).toHaveValue('第一行\n第二行')
  }
  const typing = page.getByRole('checkbox',{name:'显示“正在输入”'})
  await expect(typing).toHaveCSS('width','18px')
  await typing.uncheck()
  await expect(typing).not.toBeChecked()
  const panel=page.getByRole('region',{name:'项目与会话记忆'})
  await panel.getByRole('button',{name:'启用 PSM'}).click()
  const actionsBox = panel.locator('.settings-psm-actions')
  await expect(actionsBox).toHaveCSS('column-gap','8px')
  await page.screenshot({path:'test-results/router-settings-desktop.png', animations:'disabled'})
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({path:'test-results/router-settings-mobile.png', animations:'disabled'})
  await expect(panel).toContainText('已索引 1/2')
  await expect(panel).toContainText('当前服务器上的中枢程序仅支持旧版工具')
  await panel.getByRole('button',{name:'暂停索引'}).click()
  await expect(panel).toContainText('已暂停')
  await panel.getByRole('button',{name:'恢复索引'}).click()
  page.once('dialog',dialog=>dialog.accept())
  await panel.getByRole('button',{name:'重建 L1 索引'}).click()
  await expect.poll(()=>actions).toEqual(['enable','pause','resume','rebuild'])
})

test('a delivery barrier shows its blocking command and closes only after human confirmation', async ({ page }) => {
  let closed = false
  await page.route('**/codex-cli/status', async route => {
    const response = await route.fetch()
    const json = await response.json()
    json.result.value.router = { enabled: true, phase: 'ready' }
    await route.fulfill({ response, json })
  })
  await page.route('**/codex-cli/router/**', async route => {
    const { method, rpcId, payload } = route.request().postDataJSON()
    if (method === 'router/tasks/dismiss-unknown') {
      expect(payload).toEqual({ dispatchId: 'lost', updatedAt: 1000, confirmed: true })
      closed = true
    }
    const value = method === 'router/read' ? {
      enabled: true, phase: 'ready', busy: false, messages: [], interactions: [], clarifications: [], tasks: [
        { id: 'lost', project:'RCC', status: closed ? 'failed' : 'unknown', updatedAt:1000,
          delivery:{ seq:41, state:'unknown', checks:5, lastCheckAt:1000, closedAt:closed ? 1001 : undefined } },
        { id:'next', project:'RCC', status:'queued', updatedAt:1000, delivery:{seq:42, state:'queued', blockedBy: closed ? undefined : 41} },
      ],
    } : {}
    await route.fulfill({ json:{type:'server-response', rpcId, result:{ok:true, value}} })
  })
  await page.goto('/')
  await page.getByLabel('访问凭证', { exact:true }).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button', { name:'登录工作台' }).click()
  await page.getByRole('button', { name:'中枢 Router', exact:true }).click()
  await page.getByRole('button', { name:'任务', exact:true }).click()
  await expect(page.getByText(/指令 #41.*已核对 5 次/)).toBeVisible()
  await expect(page.getByText(/等待前序指令 #41 核对/)).toBeVisible()
  await page.getByRole('button', {name:'已核对，关闭任务'}).click()
  expect(closed).toBe(false)
  await page.getByRole('button', {name:'确认关闭'}).click()
  await expect(page.getByText(/交付待核对记录已关闭/)).toBeVisible()
  await expect(page.getByText('App Server 已接收')).toHaveCount(0)
})

test('mode and correction stay available without exposing automatic task selection', async ({ page }) => {
  let mode = 'chat', revision = 0, stopped = false
  await page.route('**/codex-cli/status', async route => {
    const response = await route.fetch()
    const json = await response.json()
    json.result.value.router = { enabled: true, phase: 'ready' }
    await route.fulfill({ response, json })
  })
  await page.route('**/codex-cli/router/**', async route => {
    const { rpcId, method, payload } = route.request().postDataJSON()
    if (method === 'router/mode') {
      expect(payload).toEqual({ mode: 'task', revision })
      mode = 'task'
      revision++
    }
    if (method === 'router/tasks/stop') {
      expect(payload).toEqual({ dispatchId:'job-b', updatedAt:100, correction:true })
      stopped = true
    }
    const value = method === 'router/read' ? {
      enabled:true, phase:'ready', messages:[], tasks:[{id:'job-b',projectId:'bbb',project:'bbb',threadId:'thread-b',status:'running',updatedAt:100}],
      routing:{mode, modeRevision:revision, focusRevision:1, focus:{projectId:'bbb',threadId:'thread-b'}},
      clarifications:stopped ? [{id:'stop',kind:'interrupt',label:'确认停止 bbb',revision:1,candidates:[{id:'job-b',name:'确认停止'}]}] : [],
    } : {}
    await route.fulfill({ json:{type:'server-response', rpcId, result:{ok:true,value}} })
  })
  await page.goto('/')
  await page.getByLabel('访问凭证', { exact: true }).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button', { name:'登录工作台' }).click()
  await page.getByRole('button', { name:'中枢 Router', exact:true }).click()
  await page.getByRole('button', { name:'聊天模式 · 切换到任务模式' }).click()
  await expect(page.getByRole('button', { name:'任务模式 · 切换到聊天模式' })).toBeVisible()
  await page.getByRole('button', { name:'任务', exact:true }).click()
  await expect(page.getByRole('heading', { name:'bbb' })).toBeVisible()
  await expect(page.getByText(/焦点/)).toHaveCount(0)
  await page.getByRole('button', { name:'纠正误派' }).click()
  await expect(page.getByRole('region', { name:'确认停止 bbb' })).toBeVisible()
})
