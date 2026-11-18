import { HubError } from '../codex/hub.js'
import { workerPermissions, workerModes } from '../../shared/worker-options.js'

export const routerNamespace = 'codex_web_router'

const fields = {
  query: { type: 'string', maxLength: 512 },
  limit: { type: 'integer', minimum: 1, maximum: 25 },
  projectId: { type: 'string', minLength: 1, maxLength: 2048 },
  threadId: { type: 'string', minLength: 1, maxLength: 128 },
  candidateThreadIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, minItems: 2, maxItems: 4, uniqueItems: true },
  title: { type: 'string', minLength: 1, maxLength: 120 },
  instruction: { type: 'string', minLength: 1, maxLength: 12000 },
  requestId: { type: 'string', minLength: 1, maxLength: 128 },
  mode: { type: 'string', enum: ['new', 'resume', 'enqueue'] },
  dispatchId: { type: 'string', minLength: 1, maxLength: 128 },
  reason: { type: 'string', maxLength: 512 },
  workerModel: { type: 'string', minLength: 1, maxLength: 128 },
  workerEffort: { type: 'string', minLength: 1, maxLength: 32 },
  workerPermission: { type: 'string', enum: workerPermissions },
  executionMode: { type: 'string', enum: workerModes },
}

const definitions = {
  list_projects: ['查找已登记与自动发现的项目。requiresApproval 为 true 的项目需用户先授权。', [], ['query', 'limit']],
  list_sessions: ['按名称、预览和最近活动检索 Worker。省略 projectId 可跨项目查找，省略 query 可浏览最近会话。', [], ['projectId', 'query', 'limit']],
  get_session: ['读取一个候选会话的有限摘要。', ['threadId'], []],
  create_session: ['创建项目会话。projectId 可为已有项目 ID、new:新项目名，或需要克隆的 HTTPS Git 仓库地址。', ['projectId'], ['title']],
  dispatch_task: ['目标明确时传 projectId 和 threadId（新建仅传 projectId）。确有歧义时传 2–4 个 candidateThreadIds 和 reason。用户选择时引用原 requestId。可指定 Worker 的模型、思考强度、会话权限和计划/执行模式。', ['instruction', 'mode', 'requestId'], ['projectId', 'threadId', 'candidateThreadIds', 'reason','workerModel','workerEffort','workerPermission','executionMode']],
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
  // Older Codex threads retain the original schema with just an instruction string.
  if (name === 'dispatch_task' && typeof args.instruction === 'string' && args.instruction.startsWith('@worker ')) {
    let options
    try { options = JSON.parse(args.instruction.slice(8)) } catch { throw bad() }
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['workerModel','workerEffort','workerPermission','executionMode'].includes(key))) throw bad()
    args = { ...args, ...options }
  }
  if (schema.required.some(key => !Object.hasOwn(args, key))) throw bad()
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw bad()
    const spec = schema.properties[key]
    if (spec.type === 'array') {
      if (!Array.isArray(value) || value.length < spec.minItems || value.length > spec.maxItems ||
          new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) throw bad()
    } else if (spec.type === 'integer') {
      if (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum) throw bad()
    } else if (typeof value !== 'string' || (spec.minLength && value.trim().length < spec.minLength) ||
      (spec.maxLength && value.length > spec.maxLength) || (spec.enum && !spec.enum.includes(value))) {
      throw bad()
    }
  }
  if (name === 'dispatch_task') {
    if (args.candidateThreadIds) {
      if (args.mode === 'new' || args.threadId) throw bad()
    } else if (!args.projectId || (args.mode === 'new' && args.threadId)) throw bad()
  }
  return args
}
