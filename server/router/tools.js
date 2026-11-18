import { HubError } from '../codex/hub.js'

export const routerNamespace = 'codex_web_router'

const fields = {
  query: { type: 'string', maxLength: 512 },
  limit: { type: 'integer', minimum: 1, maximum: 25 },
  projectId: { type: 'string', minLength: 1, maxLength: 128 },
  threadId: { type: 'string', minLength: 1, maxLength: 128 },
  title: { type: 'string', minLength: 1, maxLength: 120 },
  instruction: { type: 'string', minLength: 1, maxLength: 12000 },
  requestId: { type: 'string', minLength: 1, maxLength: 128 },
  mode: { type: 'string', enum: ['new', 'resume', 'enqueue'] },
  dispatchId: { type: 'string', minLength: 1, maxLength: 128 },
  reason: { type: 'string', maxLength: 512 },
}

const definitions = {
  list_projects: ['查找已登记与自动发现的项目。requiresApproval 为 true 的项目需用户先授权。', [], ['query', 'limit']],
  list_sessions: ['查找 Worker 会话。先定位项目，再查询该项目下的会话。', [], ['projectId', 'query', 'limit']],
  get_session: ['读取一个候选会话的有限摘要。', ['threadId'], []],
  create_session: ['在已登记项目中创建空会话。可能需要用户在界面确认。', ['projectId'], ['title']],
  dispatch_task: ['提交一项 Worker 任务。使用当前回合发给你的 requestId。同一请求只提交一次。', ['projectId', 'instruction', 'mode', 'requestId'], ['threadId']],
  get_task_status: ['读取任务的真实进展及结果。', ['dispatchId'], []],
  interrupt_task: ['为关联任务请求用户确认中断，由用户在界面确认。', ['dispatchId'], ['reason']],
}

const schemas = Object.fromEntries(Object.entries(definitions).map(([name, [description, required, optional]]) => [name, {
  type: 'function',
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries([...required, ...optional].map(field => [field, fields[field]])),
    required,
    additionalProperties: false,
  },
}]))

export const toolNames = Object.keys(schemas)
export const dynamicTools = [{
  type: 'namespace',
  name: routerNamespace,
  description: '管理这个工作台中已登记项目的会话及任务。',
  tools: Object.values(schemas),
}]

export const toolResult = (success, value) => ({
  success,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
})

export function validateTool(name, args) {
  const schema = Object.hasOwn(schemas, name) ? schemas[name].inputSchema : null
  const bad = () => new HubError('codex-cli/router-bad-tool', 'Router 工具名或参数无效')
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) throw bad()
  if (schema.required.some(key => !Object.hasOwn(args, key))) throw bad()
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw bad()
    const spec = schema.properties[key]
    if (spec.type === 'integer') {
      if (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum) throw bad()
    } else if (typeof value !== 'string' || (spec.minLength && value.trim().length < spec.minLength) ||
      (spec.maxLength && value.length > spec.maxLength) || (spec.enum && !spec.enum.includes(value))) {
      throw bad()
    }
  }
  if (name === 'dispatch_task' && ((args.mode === 'new') === Boolean(args.threadId))) throw bad()
  return args
}
