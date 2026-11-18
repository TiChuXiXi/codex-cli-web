import { expect, test } from '@playwright/test'

test('Router restores a choice, confirms only the selected Worker and opens it from task status', async ({ page }, info) => {
  let pending = true
  let accepted = false
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
    if (request.method === 'router/read') value = {
      enabled: true, phase: 'ready', error: null, model: null, busy: false, messages, latestEventId: accepted ? 1 : 0,
      clarifications: pending ? [{ id: 'clarify-1', revision: 1, kind: 'session', label: '选择目标会话', candidates: [
        { id: 'another-thread', name: '之前的改动', project: '验收项目' },
        { id: 'fixture-thread', name: '验收会话', project: '验收项目', reasons: ['近期活动'] },
      ] }] : [],
      tasks: accepted ? [{ id: 'task-1', project: '验收项目', threadId: 'fixture-thread',
        status: 'awaiting_approval', updatedAt: Date.now(), summary: null, error: null }] : [],
    }
    await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } } })
  })
  await page.goto('/')
  await page.getByLabel('访问凭证', { exact: true }).fill('fixture-access-token-only-for-tests')
  await page.getByRole('button', { name: '登录工作台' }).click()
  await page.getByRole('button', { name: 'Router', exact: true }).click()
  await page.getByRole('textbox', { name: '给 Router 发送消息' }).fill('继续之前的修改')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('继续之前的修改', { exact: true })).toBeVisible()
  if (process.env.VISUAL === '1') await page.screenshot({ path: info.outputPath('router-desktop-light.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '切换深色模式' }).click()
  await expect(page.locator('.dsh-codex-root')).toHaveAttribute('data-codex-theme', 'dark')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
  if (process.env.VISUAL === '1') await page.screenshot({ path: info.outputPath('router-mobile-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await page.getByRole('button', { name: 'Router', exact: true }).click()
  const choice = page.getByRole('region', { name: '选择目标会话' })
  await choice.getByRole('listitem').filter({ hasText: '验收会话' }).getByRole('button', { name: '选择' }).click()
  expect(confirmation).toEqual({ id: 'clarify-1', revision: 1, candidateId: 'fixture-thread' })
  await expect(choice).toHaveCount(0)
  await page.getByRole('button', { name: '任务 · 有更新', exact: true }).click()
  await expect(page.getByText('等待你的审批', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '打开会话处理审批' }).click()
  await expect(page.locator('.dsh-codex-workbench-header h1')).toHaveText('验收会话')
  await expect(page.getByRole('region', { name: 'Router' })).toHaveCount(0)
})
