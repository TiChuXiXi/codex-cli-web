// Read-only observer for the operator-driven real-phone acceptance run.
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

async function observe() {
  const env = process.env
  if (env.WECHAT_LIVE !== '1' || !env.WECHAT_TEST_ORIGIN || !env.WECHAT_TEST_PROJECT || !env.WECHAT_TEST_ACCOUNT) {
    throw new Error('需要 WECHAT_LIVE=1、WECHAT_TEST_ORIGIN、测试项目 ID WECHAT_TEST_PROJECT 和测试账号备注 WECHAT_TEST_ACCOUNT')
  }
  const origin = new URL(env.WECHAT_TEST_ORIGIN)
  if (!(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(origin.hostname))) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('请指定 HTTPS 或回环工作台地址')
  if (!stdin.isTTY) throw new Error('真机验收需要在交互终端核对手机收件')
  const headers = { 'content-type':'application/json','x-codex-request':'1' }
  if (env.WECHAT_TEST_ACCESS_TOKEN) {
    const response = await fetch(new URL('/auth/login',origin), {method:'POST',redirect:'error',headers,
      body:JSON.stringify({token:env.WECHAT_TEST_ACCESS_TOKEN}),signal:AbortSignal.timeout(10000)})
    const cookie = response.headers.get('set-cookie')
    if (!response.ok || !cookie) throw new Error('测试工作台登录失败')
    headers.cookie = cookie.split(';')[0]
  }
  async function read(method) {
    const response = await fetch(new URL('/codex-cli/' + method,origin), { method:'POST', redirect:'error', headers,
      body:JSON.stringify({type:'client-request',method,rpcId:randomUUID(),payload:{}}),signal:AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('测试工作台读取失败：' + response.status)
    const {result} = await response.json()
    if (!result?.ok) throw new Error('测试接口不可用：' + method)
    return result.value
  }
  const project = env.WECHAT_TEST_PROJECT
  const started = Date.now()
  const tag = 'wx-test-' + randomBytes(5).toString('hex')
  const hello = tag + ' 手机已连接'
  const follow = tag + ' 刚才的任务结果是什么？'
  const deadline = started + 30 * 60000
  const cards = new Set()
  const handled = new Set()
  const phoneInput = (m,text) => m.role === 'user' && m.label === '你 · 微信' && m.text === text
  stdout.write('测试工作台 ' + origin.origin + '，测试项目 ' + project + '，测试账号 ' + env.WECHAT_TEST_ACCOUNT + '\n' +
    '1. 用指定账号扫码绑定，从微信发送「' + hello + '」。\n' +
    '2. 在 Web Router 向该项目派工，要求 Worker 请求一次原生命令审批和一次原生选项输入。关闭 Web 页面。\n' +
    '3. 在手机完成两项待办、收到任务结果后，发送「' + follow + '」。\n')
  while (Date.now() < deadline) {
    const [snapshot,channel] = await Promise.all([read('router/read'),read('wechat/status')])
    if (!snapshot.enabled) throw new Error('测试实例未启用 Router')
    const tasks = snapshot.tasks.filter(task => task.projectId === project && task.createdAt >= started)
    const taskIds = new Set(tasks.map(task => task.id))
    for (const entry of snapshot.interactions) if (taskIds.has(entry.dispatchId)) cards.add(entry.method)
    for (const message of snapshot.messages) {
      if (message.label === '你 · 微信' && taskIds.has(message.dispatchId) && message.interactionMethod) handled.add(message.interactionMethod)
    }
    const completed = tasks.some(task => task.status === 'completed')
    if (channel.canNotify && channel.lastSent >= started && completed &&
        snapshot.messages.some(m => phoneInput(m,hello)) && snapshot.messages.some(m => phoneInput(m,follow)) &&
        handled.has('item/commandExecution/requestApproval') && handled.has('item/tool/requestUserInput')) {
      const prompt = createInterface({input:stdin,output:stdout})
      try {
        if ((await prompt.question('请核对同一微信确实收到 Worker 结果和追问答复、Web 历史一致。全部符合请输入 PASS：')).trim() !== 'PASS') throw new Error('手机收件未确认')
      } finally { prompt.close() }
      stdout.write('已记录指定实例的人工收件确认和原生回传，项目 ' + project + '，任务数 ' + tasks.length + '。\n')
      return
    }
    await sleep(1000)
  }
  throw new Error('30 分钟内未收齐证据。观测到 ' + cards.size + ' 类待办，已核对 ' + handled.size + ' 类微信响应。')
}

observe().catch(error => { console.error(error.message); process.exitCode = 1 })
