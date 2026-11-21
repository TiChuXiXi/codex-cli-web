import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'

const env = process.env
const worker = env.CODEX_WEB_CODEX_PATH
const authHome = env.CODEX_WEB_ROUTER_AUTH_HOME
const launcher = env.CODEX_WEB_ROUTER_LAUNCHER
const launcherSha256 = env.CODEX_WEB_ROUTER_LAUNCHER_SHA256
const model = env.CODEX_WEB_ROUTER_LIVE_MODEL
const effort = env.CODEX_WEB_ROUTER_LIVE_EFFORT
const workerOnly = process.argv.includes('--worker')
assert.ok(env.CODEX_WEB_ROUTER_WEB_LIVE === '1' && [worker, authHome, ...(workerOnly ? [] : [launcher])].every(p => p && isAbsolute(p))
  && (workerOnly || /^[a-f0-9]{64}$/.test(launcherSha256 ?? '')) && model && effort,
  'Specify the live switch, absolute Worker, auth and launcher paths, trusted launcher hash, model and effort')

// Keep the browser driver outside the package being tested.
const packageRoot = env.CODEX_WEB_TEST_PACKAGE_ROOT
if (packageRoot) assert.ok(isAbsolute(packageRoot), 'Expected an absolute path to the installed package')
const server = packageRoot ? pathToFileURL(join(packageRoot, 'server') + '/') : new URL('../server/', import.meta.url)
const { bootstrap } = await import(new URL('bootstrap.js', server))
const { loadConfig } = await import(new URL('config.js', server))

const root = await realpath(await mkdtemp(join(tmpdir(), 'zcodex-web-live-')))
let app, browser
try {
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-\d+(?:-\d+)+/)?.[0]
    assert.ok(sid, 'Cannot determine test directory owner')
    execFileSync('icacls.exe', [root, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'])
  }
  const stateDir = join(root, 'state')
  const routerHome = join(stateDir, 'router', 'codex-home')
  const workerHome = join(root, 'worker-home')
  const projectRoot = join(root, 'projects')
  const projectName = 'test-' + randomUUID().slice(0, 8)
  const cwd = join(projectRoot, projectName)
  const credentialHomes = workerOnly ? [workerHome] : [routerHome, workerHome]
  for (const path of [...credentialHomes, cwd]) await mkdir(path, { recursive: true, mode: 0o700 })

  const auth = JSON.parse(await readFile(join(authHome, 'auth.json'), 'utf8'))
  const { id_token, account_id, access_token } = auth.tokens ?? {}
  assert.ok(auth.auth_mode === 'chatgpt' && access_token && account_id && id_token, 'Expected an authorized ChatGPT test account')
  const expires = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url')).exp
  assert.ok(expires > Date.now() / 1000 + 300, 'Test access token expires within five minutes')
  const snapshot = { auth_mode: 'chatgpt', tokens: { account_id, access_token, id_token, refresh_token: '' },
    last_refresh: new Date().toISOString() }
  for (const home of credentialHomes) {
    await writeFile(join(home, 'auth.json'), JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' })
  }
  await writeFile(join(workerHome, 'config.toml'), [
    'cli_auth_credentials_store = "file"', 'sandbox_mode = "read-only"', 'approval_policy = "never"',
    'web_search = "disabled"', '[features]', 'shell_tool = false', 'plugins = false', 'hooks = false',
  ].join('\n'), { mode: 0o600, flag: 'wx' })
  const accessToken = randomUUID()
  const config = await loadConfig({ stateDir, host: '127.0.0.1', port: 0, accessToken, authMode: 'token',
    transport: 'stdio', codexPath: worker, codexHome: workerHome,
    defaultModel: model, defaultEffort: effort,
    router: { enabled: !workerOnly, launcher, launcherSha256, projectRoot, models: [{model, effort}],
      projects: [{ id: 'smoke', name: projectName, cwd, sandbox: 'read-only' }] } }, {})
  app = await bootstrap(config)
  browser = await chromium.launch({ executablePath: env.CODEX_WEB_TEST_CHROMIUM || undefined })
  const page = await browser.newPage()
  await page.goto(app.origin)
  await page.getByLabel('访问凭证', { exact: true }).fill(accessToken)
  await page.getByRole('button', { name: '登录工作台', exact: true }).click()
  if (workerOnly) {
    await expect.poll(() => app.hub.status().phase, { timeout: 30000 }).toBe('ready')
    const rpc = async (method, payload) => {
      const response = await page.request.post(app.origin + '/codex-cli/' + method, {
        headers: { 'x-codex-request': '1' }, data: { type: 'client-request', rpcId: randomUUID(), method, payload },
      })
      const body = await response.json()
      assert.ok(body.result?.ok, method + ': ' + (body.result?.error?.message ?? response.status()))
      return body.result.value
    }
    await expect(page.locator('.dsh-codex-root')).toBeVisible()
    const thread = await rpc('threads/new', { cwd, model, effort, approvalPolicy: 'never', sandbox: 'read-only' })
    const expected = 'WEB_' + randomUUID().slice(0, 8)
    await rpc('turns/start', { threadId: thread.id, cwd, model, effort, text: 'Reply only with ' + expected + '. Use no tools.',
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    await expect.poll(async () => {
      const view = await rpc('threads/get', { threadId: thread.id })
      const turns = view.turns ?? view.thread?.turns ?? []
      return turns.some(turn => turn.items.some(item => item.type === 'agentMessage' && item.text?.includes(expected)))
    }, { timeout: 120000 }).toBe(true)
    const threadName = 'worker-' + randomUUID().slice(0, 8)
    await rpc('threads/rename', { threadId: thread.id, name: threadName })
    const openThread = async () => {
      const sidebar = page.getByRole('complementary', { name: '项目与会话' })
      await sidebar.getByRole('searchbox').fill(threadName)
      await sidebar.locator('.dsh-codex-thread-name').filter({ hasText: threadName }).click()
    }
    await page.reload()
    await openThread()
    await expect(page.locator('.dsh-codex-message.assistant').getByText(expected, { exact: true })).toBeVisible()
    const followup = 'UI_' + randomUUID().slice(0, 8)
    const composer = page.locator('.dsh-codex-composer-input:visible')
    await composer.fill('Reply only with ' + followup + '. Use no tools.')
    await composer.press('Enter')
    const answer = page.locator('.dsh-codex-message.assistant').getByText(followup, { exact: true })
    await expect(answer).toBeVisible({ timeout: 120000 })
    await page.reload()
    await openThread()
    await expect(answer).toBeVisible()
    console.log(JSON.stringify({ platform: process.platform, model, effort, worker: 'stdio', webLogin: true,
      composerReply: true, retainedAfterReload: true }))
  } else {
    await app.router.opening
    const state = app.router.read()
    assert.equal(state.phase, 'ready', state.error || 'Router failed to initialize')
    assert.equal(app.router.app.policyVersion, 2, 'Release acceptance requires Router policy v2')
    await page.getByRole('button', { name: '中枢 Router', exact: true }).click()
    const composer = page.getByRole('region', { name: 'Router', exact: true }).getByRole('textbox')
    await composer.fill('请调用 list_projects 工具读取已登记项目，用一行回复唯一项目的完整名称。')
    await composer.press('Enter')
    const log = page.getByRole('log', { name: 'Router 对话' })
    await expect(log.getByText(projectName, { exact: false }).last()).toBeVisible({ timeout: 120000 })
    await expect.poll(() => app.router.read().messages.some(m => m.role === 'assistant' && m.status === 'completed' && m.text.includes(projectName)),
      { timeout: 30000 }).toBe(true)
    assert.ok(app.router.store.list('tool-call').some(row => row.tool === 'list_projects'), 'Missing real list_projects call')
    assert.equal(app.router.read().tasks.length, 0)
    await page.reload()
    if (!await log.isVisible()) await page.getByRole('button', { name: '中枢 Router', exact: true }).click()
    await expect(log.getByText(projectName, { exact: false }).last()).toBeVisible()
    console.log(JSON.stringify({ platform: process.platform, model, effort, policyVersion: app.router.app.policyVersion,
      webLogin: true, tool: 'list_projects', answered: true, retainedAfterReload: true }))
  }
} finally {
  try { await browser?.close() } finally {
    try { await app?.close() } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
  }
}

