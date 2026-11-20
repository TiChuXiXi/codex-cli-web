export const deliveryStates = {
  queued: '已排队',
  deferred: '已排队，等待交付',
  delivering: '正在提交',
  delivered: 'App Server 已接收',
  unknown: '交付结果待核对',
  failed: '交付失败',
  cancelled: '已取消',
}

const deliveryDetails = {
  delivered: '尚不能确认指令已执行。',
  queued: '等待交付给执行助手。',
  deferred: '等待可交付时机。',
}

export function deliveryFact(target, state, command) {
  let evidence
  if (command?.historyAt) evidence = '投递依据：原生历史已核对。'
  else if (command?.ackAt) evidence = '投递依据：原生端已确认接收。'
  const warning = command?.method === 'steer' && command.turnOutcome === 'interrupted'
    ? '所属回合已中断，指令执行情况未确认。' : undefined
  return { kind: state, target, evidence, warning, status: deliveryStates[state] ?? '请查看任务记录', detail: deliveryDetails[state] }
}

export function terminalFact(target, task) {
  const status = { completed: '回合已结束', failed: '任务失败', interrupted: '执行中断' }[task.status] ?? '状态待核对'
  const result = [...new Set([task.error, task.finalReply || task.summary].filter(Boolean))].join('\n')
  return {
    kind: task.status, target, status, hasResult: Boolean(result), result: result || '暂时没有可核实的结果说明。',
    verification: task.executionStatus === 'completed' && task.turnId ? '已核对执行助手的回合终态。' : undefined,
  }
}

function chatExample({ identity, personality, presentation }, channel) {
  const greeting = { restrained: '', balanced: '你好。', warm: '很高兴见到你。' }[personality.warmth]
  const introduction = identity.selfReference + '是' + identity.name + '。'
  const question = { calm: '你想先聊什么？', relaxed: '我们先聊哪件事？', lively: '从哪件事聊起？' }[personality.liveliness]
  const help = '可以帮你找项目、查进展。'
  const parts = personality.directness === 'direct' ? [greeting + help, introduction, question] : [greeting + introduction, help, question]
  if (presentation.verbosity !== 'concise') parts.push('也可以一起看看手头的任务。')
  if (presentation.verbosity === 'detailed') parts.push('告诉我项目名称，就能从相关工作聊起。')
  return parts.join(personality.directness === 'detailed' || channel === 'wechat' ? '\n' : '')
}

export function renderExpression(fact, profile, channel = 'web') {
  if (fact.kind === 'approval') return '【需要审批】' + fact.target + '\n' + fact.detail
  if (fact.kind === 'chat') return chatExample(profile, channel)

  const { warmth, liveliness, directness } = profile.personality
  const policy = profile.presentation
  const routine = !fact.warning && ['queued', 'delivered', 'deferred', 'running', 'completed'].includes(fact.kind)
  const lead = routine && warmth === 'warm' ? '好的，' : ''
  let line = fact.target + '：' + fact.status + '。'
  if (routine && ['queued','running','delivered'].includes(fact.kind)) {
    const state = fact.kind === 'delivered' ? '已由目标会话接收' : fact.status
    const end = liveliness === 'relaxed' && fact.kind === 'queued' ? '了。' : '。'
    line = directness === 'direct' ? state + '，目标是「' + fact.target + '」。' : '「' + fact.target + '」的任务' + state + end
  }
  const resultFirst = fact.kind === 'completed' && fact.hasResult
  const parts = resultFirst ? [lead + fact.target + '：' + fact.result] : [lead + line]
  if (fact.warning) parts.push(fact.warning)
  if (fact.result && !resultFirst) parts.push(fact.result)
  if (fact.detail && (!routine || policy.dispatchFeedback === 'standard')) parts.push(fact.detail)
  if (fact.verification && policy.completionStyle === 'result_and_verification') parts.push(fact.verification)
  if (fact.evidence && policy.technicalDetail !== 'on_demand') parts.splice(policy.technicalDetail === 'technical_first' ? 1 : parts.length, 0, fact.evidence)
  if (fact.background && policy.verbosity !== 'concise') parts.push(fact.background)
  if (routine && directness === 'detailed' && parts.length > 1) return parts.map((part, i) => (i + 1) + '. ' + part).join('\n')
  return parts.join('\n')
}

// The source is already restricted to text eligible for this channel.
// Approval cards use their separate complete, fingerprint-checked delivery path.
export function wechatParts(text,mode,limit=1200) {
  const chars=Array.from(text)
  if(chars.length<=limit)return [text]
  const more='（完整内容请在工作台的对应对话中查看。）'
  if(mode!=='full_segmented') {
    const excerpt=chars.slice(0,limit-more.length-1).join('')
    const end=Math.max(excerpt.lastIndexOf('。'),excerpt.lastIndexOf('\n'))
    const summary=end>excerpt.length/3?excerpt.slice(0,end+1):excerpt
    return [summary.trimEnd()+'\n'+more]
  }
  const parts=[]
  for(let i=0;i<Math.min(chars.length,limit*3);i+=limit)parts.push(chars.slice(i,i+limit).join(''))
  if(chars.length>limit*3)parts[2]=Array.from(parts[2]).slice(0,limit-more.length-1).join('')+'\n'+more
  return parts
}
