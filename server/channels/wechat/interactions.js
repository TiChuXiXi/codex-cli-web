import { renderExpression } from '../../../shared/router-expression.js'
import { clarificationLabel } from '../../../shared/router-presentation.js'
import { approvalDetails } from '../../../shared/approval-details.js'
import { describeWorkerSettings } from '../../router/projects.js'
import { createHash, randomBytes } from 'node:crypto'

const command = 'item/commandExecution/requestApproval'
const file = 'item/fileChange/requestApproval'
const permission = 'item/permissions/requestApproval'
const input = 'item/tool/requestUserInput'
const elicitation = 'mcpServer/elicitation/request'
const decisionMethods = new Set([command, file, permission])
const allow = /^(?:1|允许本次|允许|同意|批准)$/
const deny = /^(?:2|拒绝|不同意)$/
const normalize = text => text.normalize('NFKC').trim().toLowerCase().replace(/[。.!！]$/, '').trim()

function choiceIndex(text, labels, partial = false) {
  const answer = normalize(text)
  const number = /^(?:第\s*)?([1-9]\d*|[一二三四])\s*(?:个|项)?$/.exec(answer)
  if (number) {
    const index = /^\d+$/.test(number[1]) ? Number(number[1]) - 1 : '一二三四'.indexOf(number[1])
    return index < labels.length ? index : -1
  }
  const key = answer.replace(/^(?:继续使用|继续用|使用|选择|选)\s*/, '').replace(/\s*(?:那个|那项)$/, '').trim()
  if (!key) return -1
  const normalized = labels.map(normalize)
  const exact = normalized.flatMap((label, i) => label === key ? [i] : [])
  if (exact.length) return exact.length === 1 ? exact[0] : -2
  if (!partial || key.length < 2) return -1
  const hits = normalized.flatMap((label, i) => label.includes(key) ? [i] : [])
  return hits.length === 1 ? hits[0] : hits.length ? -2 : -1
}

function choiceTitle(item, candidate) {
  if (item.kind === 'session') {
    const title = candidate.phoneTitle || '历史会话'
    const crossProject = item.candidates.some(other => other.projectId !== candidate.projectId)
    return crossProject && candidate.project ? candidate.project + ' · ' + title : title
  }
  return candidate.name
}

function selectedIndex(item, text) {
  if (item.candidates.length === 1 && /^(确定|确认)$/.test(text)) return 0
  return choiceIndex(text, item.candidates.map(c => choiceTitle(item, c)), true)
}

export function ambiguousChoice(card, text) {
  return card?.type === 'choice' && selectedIndex(card.item, text) === -2
}

export const approvalFingerprint = request => createHash('sha256')
  .update(JSON.stringify([request.instanceId, request.dispatchId, request.method, request.params])).digest('hex')

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
  const selfName = router.presentation?.().selfName
  for (const item of router.store.list('clarification')) {
    if (item.status !== 'pending' || item.expiresAt <= Date.now() || (item.routerThreadId && item.routerThreadId !== router.session?.id) ||
        (!item.candidates.length && item.kind !== 'projectRoot')) continue
    const key = 'choice:' + item.id + ':' + item.revision
    result.set(key, { key, type: item.kind === 'projectRoot' ? 'root' : 'choice', item, label: clarificationLabel(item, selfName) })
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

export function renderCard(card, index = 0) {
  const label = card.type === 'choice' && card.item.semanticChoice ? '你想继续哪个任务？' : card.label
  const prefix = '【' + (card.type === 'approval' ? '需要审批' : '当前待办') + '】' + String(label).replace(/^Worker · /,'')
  let body
  if (card.type === 'approval') {
    const details = approvalDetails(card.request)
    body = [details.text, details.allow && '1 允许本次', details.deny && '2 拒绝',
      details.cancel && (details.deny ? '3 取消' : '2 取消')].filter(Boolean).join('\n')
  } else if (card.type === 'elicitation') {
    body = [card.request.params.message?.slice(0, 1600), '可回复“拒绝”或“取消”。'].filter(Boolean).join('\n')
  } else if (card.type === 'root') {
    body = '请回复新项目父目录的绝对路径，或回复“取消”。确认后会保存为默认目录并继续等待此设置的项目。'
  } else if (card.type === 'choice') {
    const item = card.item
    body = item.candidates.map((candidate, i) => {
      const details = item.kind === 'session' ? candidate.phoneSummary : candidate.summary
      return (i + 1) + '. ' + [choiceTitle(item, candidate), details].filter(Boolean).join(' · ')
    }).join('\n')
    if (item.kind === 'session' && item.candidates.some(c => c.pendingProject || c.grant || c.settingsReview)) {
      body += '\n选定后会展示需要确认的权限。'
    }
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
  const content = card.type === 'approval' ? renderExpression({kind:'approval',target:String(label).replace(/^Worker · /,''),detail:body}) : prefix + '\n' + body
  return content + '\n发“下一个”可暂缓，发“待办”可回看。另发任务用“任务：…”'
}

export async function answerCard(router, card, text, values, origin) {
  if (card.type === 'root') {
    if (text === '取消') {
      await router.confirm({ id: card.item.id, revision: card.item.revision }, true)
      return { done: true, summary: '已取消' }
    }
    if (values.length && text === '确认设置') {
      await router.setupProjectRoot({ projectRoot: values[0], clarification: card.item.id, revision: card.item.revision,
        waitingIds: values[1] })
      return { done: true, summary: '已设置默认目录，正在继续原请求' }
    }
    if (!text.startsWith('/')) return { hint: '请回复绝对路径或“取消”。' }
    const waiting = router.store.list('clarification').filter(c => c.kind === 'projectRoot' && c.status === 'pending')
    return { answers: [text, waiting.map(c => c.id).sort()], hint: '默认父目录将设为 ' + text + '。将继续：' +
      waiting.map(c => c.intent.projectId).join('、') + '。回复“确认设置”或“取消”。' }
  }
  if (card.type === 'choice') {
    const item = card.item
    const cancel = ['取消','都不是'].includes(text)
    const authorized = values.length && text === '确认授权'
    const candidate = authorized ? item.candidates.find(c => c.id === values[0]) : item.candidates[selectedIndex(item, text)]
    if (!candidate && !cancel) return { hint: '请回复唯一的候选编号或“都不是”。' }
    if (candidate && !authorized && (candidate.settingsReview || candidate.grant || (candidate.pendingProject && item.kind !== 'psmAccess'))) {
      const scope = [candidate.pendingProject && '授权使用项目 ' + candidate.pendingProject.cwd, candidate.settingsReview,
        candidate.grant && '沿用 ' + describeWorkerSettings(candidate.grant.settings) + '，之后相同设置可直接续接'].filter(Boolean)
      return { answers: [candidate.id], hint: '已选 ' + choiceTitle(item, candidate) + '。\n' +
        scope.join('；') + '。回复“确认授权”或“取消”。' }
    }
    const result = await router.confirm({ id: item.id, revision: item.revision, candidateId: candidate?.id }, cancel)
    return { done: true, dispatchId: result?.id && router.store.get('task', result.id)?.id,
      interactionMethod: cancel ? 'clarification/cancel' : 'clarification/' + item.kind, summary: cancel ? (text === '都不是' ? '已取消这次选择。请补充项目名称或任务线索。' : '已取消') :
      '已选择 ' + choiceTitle(item, candidate) }
  } else if (card.type === 'elicitation') {
    if (!['拒绝','取消'].includes(text)) return { hint: '此 MCP 请求支持拒绝或取消。' }
    const { dispatchId, instanceId } = card.request
    router.respond({ dispatchId, instanceId, response: { action: text === '取消' ? 'cancel' : 'decline', content: null, _meta: null } })
    return { done: true, summary: '已' + text + ' MCP 请求' }
  } else if (card.type === 'approval') {
    const { method, params, dispatchId, instanceId } = card.request
    const yes = allow.test(text)
    const details = approvalDetails(card.request)
    if (details.cancel && (text === '取消' || text === (details.deny ? '3' : '2'))) {
      router.respond({dispatchId,instanceId,response:{decision:'cancel'}})
      return {done:true,receiptEvidence:{decision:'cancel'},summary:'已取消本次请求'}
    }
    if (!(yes ? details.allow : deny.test(text) && details.deny)) return { hint: '请按当前审批卡显示的选项回答。' }
    const response = method === permission ? { scope: 'turn', permissions: yes ? params.permissions ?? {} : {} } :
      { decision: yes ? 'accept' : 'decline' }
    router.respond({ dispatchId, instanceId, response })
    return { done: true, receiptEvidence: { decision: yes ? 'allowOnce' : 'deny' }, summary: yes ? '已允许本次请求' : '已拒绝本次请求' }
  } else {
    const list = questions(card)
    const q = list[values.length]
    if (!q) return { hint: '该问题已失效。' }
    const labels = (q.options ?? []).map(opt => opt.label)
    const selected = labels[choiceIndex(text, labels)]
    if (!q.isSecret && labels.length && !selected && /^[0-9]+$/.test(text)) return { hint: '请回复有效的选项编号或填写自定义答案。' }
    const answers = [...values, q.isSecret ? text : selected ?? text]
    if (answers.length < list.length) return { answers, hint: renderCard(card, answers.length) }
    if (card.type === 'input') {
      router.respond({ dispatchId: card.request.dispatchId, instanceId: card.request.instanceId,
        response: { answers: Object.fromEntries(list.map((question, i) => [question.id, { answers: [answers[i]] }])) } })
    } else await router.answerQuestion({ id: card.message.id, text: list.map((q,i) => q.question + '\n' + answers[i]).join('\n\n') }, origin)
    // Only public, predefined options can be included in a receipt. Never copy
    // secret or free-form user input into the automatic Router turn.
    const choices = list.flatMap((question, i) => {
      if (question.isSecret || !question.options?.some(option => option.label === answers[i])) return []
      return [{ question: question.question?.slice(0, 240), selected: answers[i].slice(0, 120) }]
    }).slice(0, 8)
    return { done: true, receiptEvidence: { choices },
      ...(card.type === 'question' && { interactionMethod: 'worker/question', questionId: card.message.id }),
      ...(card.type === 'question' && { hint: '回答已排队，可在工作台的任务列表查看交付状态。' }),
      summary: list.some(q => q.isSecret) ? '已提交私密回答' : '已回答：' + answers.join('、') }
  }
}

export function matchesShortAnswer(card, text, index) {
  if (card.type === 'elicitation') return ['拒绝','取消'].includes(text)
  if (card.type === 'approval') return allow.test(text) || deny.test(text) || ['3','取消'].includes(text)
  if (card.type === 'root') return text.startsWith('/') || ['确认设置','取消'].includes(text)
  if (card.type === 'choice') return ['取消','都不是','确认授权'].includes(text) || selectedIndex(card.item, text) >= 0
  const q = questions(card)[index]
  return !!q && choiceIndex(text, (q.options ?? []).map(opt => opt.label)) >= 0
}
