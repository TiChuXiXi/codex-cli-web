import { randomBytes } from 'node:crypto'

const command = 'item/commandExecution/requestApproval'
const file = 'item/fileChange/requestApproval'
const permission = 'item/permissions/requestApproval'
const input = 'item/tool/requestUserInput'
const elicitation = 'mcpServer/elicitation/request'
const decisionMethods = new Set([command, file, permission])
const allow = /^(?:1|允许|同意|批准)$/
const deny = /^(?:2|拒绝|不同意)$/
const indexOfChoice = (text, labels) => {
  if (/^[1-9]\d*$/.test(text)) {
    const index = Number(text) - 1
    return index < labels.length ? index : -1
  }
  const answer = text.replace(/[。.!！]$/, '').trim()
  for (const choice of [answer, answer.replace(/^(?:继续使用|继续用|使用|选择)\s*/, '')]) {
    if (labels.filter(label => label === choice).length === 1) return labels.indexOf(choice)
  }
  return -1
}

export function liveCards(router) {
  const result = new Map()
  for (const request of router.dispatcher.interactions()) {
    if (request.method !== input && request.method !== elicitation && !decisionMethods.has(request.method)) continue
    const key = 'native:' + request.instanceId
    result.set(key, { key, type: request.method === input ? 'input' : request.method === elicitation ? 'elicitation' : 'approval', request, label: request.worker })
  }
  for (const message of router.store.messagesWithStatus('pending').filter(row => row.questions?.length)) {
    const key = message.id
    result.set(key, { key, type: 'question', message, label: message.label })
  }
  for (const item of router.store.list('clarification')) {
    if (item.status !== 'pending' || item.expiresAt <= Date.now() || !item.candidates.length) continue
    const key = 'choice:' + item.id + ':' + item.revision
    result.set(key, { key, type: 'choice', item, label: item.label })
  }
  return result
}

export function shortCode(store) {
  let code
  do { code = randomBytes(4).toString('hex').toUpperCase() } while (store.wxRead('card', code))
  return code
}

export function questions(card) {
  if (card.type === 'input') return card.request.params.questions ?? []
  return card.message.questions.map((q, index) => ({ id: String(index), question: q.title,
    options: q.options?.map(label => ({ label })), isOther: true }))
}

function approvalDetails({ method, params }) {
  let scope
  if (method === command && params.command) scope = '执行命令\n' + params.command
  if (method === file && (params.grantRoot || params.cwd || params.reason)) {
    scope = '文件变更授权范围：' + (params.grantRoot || params.cwd || '当前变更')
  }
  if (method === permission && params.permissions) scope = '本回合权限：' + JSON.stringify(params.permissions)
  if (!scope) return null
  const details = [scope, params.cwd && '目录：' + params.cwd, params.reason, '1 允许本次　2 拒绝'].filter(Boolean).join('\n')
  return details.length <= 3200 ? details : null
}

export function renderCard(card, index = 0) {
  const prefix = '【' + (card.type === 'approval' ? '需要审批' : '当前待办') + '】' + card.label
  let body
  if (card.type === 'approval') {
    body = approvalDetails(card.request)
    if (!body) {
      return prefix + '\n完整请求请在 Web 查看。也可回复“拒绝”或“下一个”。'
    }
  } else if (card.type === 'elicitation') {
    body = [card.request.params.message?.slice(0, 1600), '可回复“拒绝”或“取消”。'].filter(Boolean).join('\n')
  } else if (card.type === 'choice') {
    body = card.item.candidates.map((c, i) => (i + 1) + '. ' + [c.project, c.name, c.summary].filter(Boolean).join(' · ')).join('\n')
    body += '\n可直接回复选项序号、名称或“取消”。'
  } else {
    const list = questions(card)
    const q = list[index]
    if (!q) return prefix + '\n问题已变更，请刷新工作台。'
    body = ['第 ' + (index + 1) + '/' + list.length + ' 题', q.question,
      ...(q.options ?? []).map((opt, i) => (i + 1) + '. ' + opt.label + (opt.description ? ' · ' + opt.description : '')),
      q.options?.length ? '可直接回复选项序号或名称。' : '直接发送你的答案。',
      q.isSecret && '私密输入：微信聊天会保留你发出的文字。'].filter(Boolean).join('\n')
  }
  return prefix + '\n' + body + '\n发“下一个”可暂缓，发“待办”可回看。另发任务用“任务：…”'
}

export async function answerCard(router, card, text, values) {
  if (card.type === 'choice') {
    const item = card.item
    const candidate = item.candidates[indexOfChoice(text, item.candidates.map(c => c.name))]
    if (!candidate && text !== '取消') return { hint: '请回复候选编号或“取消”。' }
    await router.confirm({ id: item.id, revision: item.revision, candidateId: candidate?.id }, text === '取消')
    return { done: true, summary: candidate ? '已选择 ' + candidate.name : '已取消' }
  } else if (card.type === 'elicitation') {
    if (!['拒绝','取消'].includes(text)) return { hint: '此 MCP 请求支持拒绝或取消。' }
    const { dispatchId, instanceId } = card.request
    router.respond({ dispatchId, instanceId, response: { action: text === '取消' ? 'cancel' : 'decline', content: null, _meta: null } })
    return { done: true, summary: '已' + text + ' MCP 请求' }
  } else if (card.type === 'approval') {
    const { method, params, dispatchId, instanceId } = card.request
    if (!allow.test(text) && !deny.test(text)) return { hint: '请明确回复允许或拒绝。' }
    const yes = allow.test(text)
    if (yes && !approvalDetails(card.request)) return { hint: '请在 Web 查看完整请求后审批。' }
    const response = method === permission ? { scope: 'turn', permissions: yes ? params.permissions ?? {} : {} } :
      { decision: yes ? 'accept' : 'decline' }
    router.respond({ dispatchId, instanceId, response })
    return { done: true, summary: yes ? '已允许本次请求' : '已拒绝本次请求' }
  } else {
    const list = questions(card)
    const q = list[values.length]
    if (!q) return { hint: '该问题已失效。' }
    const labels = (q.options ?? []).map(opt => opt.label)
    const selected = labels[indexOfChoice(text, labels)]
    if (!q.isSecret && labels.length && !selected && /^[0-9]+$/.test(text)) return { hint: '请回复有效的选项编号或填写自定义答案。' }
    const answers = [...values, q.isSecret ? text : selected ?? text]
    if (answers.length < list.length) return { answers, hint: renderCard(card, answers.length) }
    if (card.type === 'input') {
      router.respond({ dispatchId: card.request.dispatchId, instanceId: card.request.instanceId,
        response: { answers: Object.fromEntries(list.map((question, i) => [question.id, { answers: [answers[i]] }])) } })
    } else await router.answerQuestion({ id: card.message.id, text: list.map((q,i) => q.question + '\n' + answers[i]).join('\n\n') })
    return { done: true, summary: list.some(q => q.isSecret) ? '已提交私密回答' : '已回答：' + answers.join('、') }
  }
}

export function matchesShortAnswer(card, text, index) {
  if (card.type === 'elicitation') return ['拒绝','取消'].includes(text)
  if (card.type === 'approval') return allow.test(text) || deny.test(text)
  if (card.type === 'choice') return text === '取消' || indexOfChoice(text, card.item.candidates.map(c => c.name)) >= 0
  const q = questions(card)[index]
  return !!q && indexOfChoice(text, (q.options ?? []).map(opt => opt.label)) >= 0
}
