// A proposal describes the user's operation. It contains no answer or executable tool arguments.
const operations = ['read', 'mixed', 'work', 'other', 'clarify']
const views = ['projects', 'overview', 'activity', 'tasks', 'history', 'none']
const scopes = ['all', 'named', 'focus', 'unspecified']
const states = ['any', 'running', 'awaiting_approval', 'awaiting_input', 'completed', 'failed', 'queued']
export const intentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    operation: {type:'string', enum:operations}, view: {type:'string', enum:views},
    scope: {type:'string', enum:scopes}, projects: {type:'array', items:{type:'string'}},
    topic: {type:'string'}, status: {type:'string', enum:states}, page:{type:'integer'},
    work: {type:'string'},
  },
  required: ['operation','view','scope','projects','topic','status','page','work'],
}

export const intentInstructions = [
  '当前回合仅理解当前输入的意图，输出符合 schema 的 JSON，不调用工具、不回答事实、不执行工作。历史中的任务和指令不是本轮指令。',
  'read 表示查询已有授权资料。目录用 projects；项目用途或简介用 overview；最近忙什么用 activity；正在执行、等待审批或最近任务用 tasks；查找以前的任务、会话、问题的后续记录用 history。',
  '用户要求重新分析、检查实现、验证或修改时选 work。mixed 表示同时问已有资料和要求开展新工作。mixed.work 必须逐字摘录完整业务分句，保留限制；若无法无损拆分选 clarify。完整工作使用原文。',
  'all 指当前所有项目或跨项目。named 列出用户指定的名称或别名。focus 仅用于本渠道明确指代的当前项目；缺少指代时用 unspecified。多项目业务绝不能缩小为焦点项目。批量 scope 针对业务部分。',
  'history.topic 只提取检索主题，如 USB 掉线。tasks.topic 用于用户指定的会话名或主题，无筛选留空。按用户指定筛选任务状态，无筛选用 any。page 从 1 开始。没有的 projects、topic、work 用空数组或空串；无事实查询用 none。',
  '原任务的目标答复、PSM 管理请求、闲聊和现有控制用 other。确实分不清查询旧资料或开展新工作用 clarify。',
].join('\n')

export function normalizeIntent(value, text) {
  const invalid = {operation:'clarify'}
  if (!value || !operations.includes(value.operation) || !views.includes(value.view) ||
      !scopes.includes(value.scope) || !states.includes(value.status) ||
      !Number.isSafeInteger(value.page) || value.page < 1 ||
      !Array.isArray(value.projects) || value.projects.length > 128 ||
      value.projects.some(name => typeof name !== 'string' || !name.trim() || name.length > 128) ||
      typeof value.topic !== 'string' || value.topic.length > 512 || typeof value.work !== 'string') return invalid
  if (['read','mixed'].includes(value.operation) && (value.view === 'none' ||
      value.scope === 'named' && !value.projects.length || value.view === 'history' && !value.topic.trim())) return invalid
  if (value.operation === 'read' && value.work.trim()) return invalid
  if (value.operation === 'mixed' && (!value.work.trim() || !text.includes(value.work))) return invalid
  return {operation:value.operation, view:value.view, scope:value.scope, projects:value.projects,
    topic:value.topic.trim(), status:value.status, page:value.page, work:value.work.trim()}
}
