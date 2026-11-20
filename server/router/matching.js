const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim()
const tokens = value => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2)

function containsName(text, name) {
  if (name === '' || !text.includes(name)) return false
  const start = text.indexOf(name)
  const end = start + name.length
  if (/^[\p{Script=Han}]/u.test(name) || /[\p{Script=Han}]$/u.test(name)) return true
  return !/[a-z0-9_]/i.test(text[start - 1] ?? '') && !/[a-z0-9_]/i.test(text[end] ?? '')
}

export function rankCandidates(entries, query, { original = query, now = Date.now() } = {}) {
  const needle = normalize(query)
  const source = normalize(original)
  const queryTokens = tokens(needle)
  return entries.map(entry => {
    const names = [entry.id, entry.name, ...(entry.aliases ?? [])].map(normalize).filter(Boolean)
    const explicit = names.some(name => containsName(source, name))
    const exact = names.includes(needle)
    const nameTokens = tokens(names.join(' '))
    const namesMatch = needle && (names.some(name => name.includes(needle)) ||
      queryTokens.some(token => nameTokens.includes(token)))
    const summary = normalize(entry.summary)
    const summaryMatch = queryTokens.some(token => summary.includes(token))
    const recent = Number.isFinite(entry.updatedAt) && now - entry.updatedAt < 7 * 86400000
    const reasons = []
    if (explicit) reasons.push('原文明确提到')
    if (namesMatch && !explicit) reasons.push('名称或别名匹配')
    if (summaryMatch) reasons.push('摘要匹配')
    if (recent) reasons.push('近期活动')
    const score = explicit ? 100 : (exact ? 85 : namesMatch ? 60 : 0) +
      (summaryMatch ? 10 : 0) + (recent ? 5 : 0)
    return { ...entry, score, reasons, explicit }
  }).filter(entry => !needle || entry.score > 5)
    .sort((left, right) => right.score - left.score ||
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.id.localeCompare(right.id))
}

// Match a whole clarification answer. Punctuation separating words in a project
// name can be typed as spaces on a phone. Multiple matches remain ambiguous.
export function targetLabelMatches(text, names) {
  const key = value => normalize(value).replace(/[\s_-]+/gu, ' ')
  const label = normalize(text).replace(/[。！!]$/, '').trim()
  const bare = label.replace(/(?:这个|那个)?(?:项目|会话|任务)$/, '').trim()
  return names.some(name => name && [key(label), key(bare)].includes(key(name)))
}

export function routerControl(text) {
  const line = text.trim().replace(/[。！!？?]+$/, '')
  if (/^(?:(?:请)?(?:切换到?|进入|开启|改为)聊天模式|接下来我们聊聊[，, ]*不要执行|先别派发[，, ]*我想讨论一下)$/.test(line)) return { type:'mode', mode:'chat' }
  if (/^(?:(?:请)?(?:切换到?|进入|开启|改为)任务模式|开始处理任务)$/.test(line)) return { type:'mode', mode:'task' }
  if (/^(当前|查看|查询)(交互)?模式$/.test(line)) return { type:'mode' }
  if (/^(?:请\s*)?(?:(?:查看|查询|列出)\s*)?(?:当前(?:的)?\s*)?项目列表$/.test(line) ||
      /^(?:请\s*)?(?:查看|查询|列出)\s*(?:(?:当前(?:的)?\s*)?(?:所有|全部)(?:的)?\s*|当前(?:的)?\s*)项目$/.test(line))
    return { type:'projects' }
  if (/^(?:查看|列出)?(?:当前)?任务列表$/.test(line)) return { type:'list' }
  if (/^(?:当前|查看|查询)(?:对话)?焦点$/.test(line)) return { type:'focus' }
  const redirect = /^(?:这个|刚才(?:那个|的)?任务|上一条)(?:应该|应当|应)?(?:交给|发给)\s*(.+)$/.exec(line)
  if (redirect) return {type:'redirect',target:redirect[1]}
  const focus = /^(?:切换到\s*(.+?)|接下来给\s*(.+?)\s*发消息)$/.exec(line)
  if (focus) return { type:'focus', target:focus[1] || focus[2] }
  if (/^(?:请)?(?:取消|停止|撤销|中断)\s*(?:指令|任务)\s*#\d+$/.test(line)) return { type:'stop',target:line }
  if (/^(?:(?:刚才)?(?:发错了|派错了)[，, ]*(?:停下|停止)?|不是让你改代码[，, ]*我只是问问|(?:请)?(?:停下|停止|中断|撤销|取消)(?:刚才的?(?:指令|任务))?|.{1,80}(?:先停下|先停止))$/.test(line))
    return { type:'stop', target:line, correction:/错|只是问问/.test(line) }
  if (/^(?:查看|查询).{1,100}(?:的)?(?:任务)?(?:状态|进度)$/.test(line) || /^.{1,80}(?:任务|会话)的?(?:状态|进度)(?:如何|怎样)?$/.test(line))
    return { type:'status', target:line }
  return null
}

// Only unqualified continuations with a known grammatical subject skip model resolution.
export function plainContinuation(text) {
  return /^(?:请)?(?:继续|继续执行|继续上面的任务|(?:那|那要|那应该)?(?:怎么修|怎么改|怎么解决|为什么|还有哪些问题|还有吗)|(?:请)?(?:你)?检查一下这个实现(?:方式)?是否合理|测试完(?:记得)?恢复自动\s*IP|(?:先)?(?:不要|不用|无需)(?:修改|配置|设置)\s*(?:DNS|网口|手动\s*IPv4))[。！？，!? ]*$/iu.test(text.trim())
}

export function namedWorkers(rows, text) {
  const source = normalize(text)
  const hint = /(?:切换到|接下来给|继续|让|给|查询|查看)?\s*([^，。！？、]{1,48}?)(?:那个|这个)(?:任务|项目|会话)?/.exec(source)?.[1]?.replace(/^(?:切换到|接下来给|继续|让|给|查询|查看)\s*/, '').trim()
  const matches = values => values.filter(row => row.names.some(name => containsName(source,normalize(name)) ||
    (hint && [...hint].length >= 2 && normalize(name).includes(hint))))
  const threads = matches(rows.map(r => ({ ...r, threadMatch:true, names:[r.threadId,r.threadName].filter(Boolean) })))
  return threads.length ? threads : matches(rows.map(r => ({ ...r, names:[r.projectId,r.project,...(r.aliases ?? [])].filter(Boolean) })))
}
