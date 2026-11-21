import { isAbsolute, parse, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { HubError } from '../codex/hub.js'
import { permissionPayload } from '../../shared/worker-options.js'

const safeSandbox = new Set(['read-only', 'workspace-write'])
const identity = ({ dev, ino }) => String(dev) + ':' + String(ino)
export const shortText = (value, max = 320) => typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, max) : ''

function containsPath(parent, child) {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}

export async function loadRouterProjects(config, directory) {
  const projects = new Map()
  const roots = new Set()
  for (const entry of config) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ||
        typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120 ||
        typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd) || projects.has(entry.id) ||
        (entry.resumeExistingPermissions !== undefined && typeof entry.resumeExistingPermissions !== 'boolean') ||
        (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some(alias =>
          typeof alias !== 'string' || !alias.trim() || alias.length > 120)))) {
      throw new Error('Router 项目登记格式无效或项目 ID 重复')
    }
    const cwd = await realpath(entry.cwd)
    const info = await stat(cwd, { bigint: true })
    const sandboxLimit = entry.sandbox ?? 'read-only'
    if (!info.isDirectory() || roots.has(cwd) || cwd === parse(cwd).root ||
        containsPath(directory, cwd) || containsPath(cwd, directory) ||
        !safeSandbox.has(sandboxLimit)) {
      throw new Error('Router 项目路径重复、与 Router 状态目录相交或沙箱无效')
    }
    roots.add(cwd)
    projects.set(entry.id, {
      id: entry.id, name: entry.name, aliases: entry.aliases ?? [], cwd, identity: identity(info), birth: String(info.birthtimeNs), sandbox: sandboxLimit,
      resumeExistingPermissions: entry.resumeExistingPermissions === true,
    })
  }
  return projects
}

export async function checkProject(project) {
  if (!project) throw new HubError('codex-cli/router-project', '仅可调度登记项目')
  let valid = false
  try {
    const info = await stat(project.cwd, { bigint: true })
    valid = await realpath(project.cwd) === project.cwd && identity(info) === project.identity &&
      (!project.birth || project.birth === String(info.birthtimeNs))
    if (valid && !project.birth) project.birth = String(info.birthtimeNs)
  } catch {}
  if (!valid) throw new HubError('codex-cli/router-project', '项目目录已改变，需要重新核验')
  return project
}

export async function checkThread(project, thread, routerThreadId) {
  if (!thread || thread.id === routerThreadId || thread.archived === true ||
      thread.ephemeral === true || thread.parentThreadId || typeof thread.cwd !== 'string') {
    throw new HubError('codex-cli/router-thread', '目标会话不可调度')
  }
  let belongs = false
  try { belongs = await realpath(thread.cwd) === project.cwd } catch {}
  if (!belongs) throw new HubError('codex-cli/router-thread', '目标会话不属于登记项目')
  return thread
}

export function workerIdentityIssue(project, settings) {
  if (settings?.cwd !== project.cwd) return 'Worker 的工作目录与登记项目不一致'
  const sandbox = settings.sandbox
  if (!['dangerFullAccess', 'workspaceWrite', 'readOnly'].includes(sandbox?.type) ||
      !['never', 'on-request', 'on-failure', 'untrusted'].includes(settings.approvalPolicy) ||
      !['user', 'auto_review'].includes(settings.approvalsReviewer)) return '无法核实 Worker 当前执行配置'
  return null
}

export function workerDispatchIssue(project, settings, { existing = false, grant } = {}) {
  const invalid = workerIdentityIssue(project, settings)
  if (invalid) return invalid
  if (existing && (project.resumeExistingPermissions ||
      (grant?.identity === project.identity && isDeepStrictEqual(grant.settings, settings)))) return null
  const sandbox = settings.sandbox
  const issues = []
  if (settings.approvalPolicy !== 'on-request' || settings.approvalsReviewer !== 'user') {
    issues.push('Worker 必须启用按需审批，并由用户审批')
  }
  if (sandbox?.type === 'workspaceWrite' && project.sandbox !== 'workspace-write') {
    issues.push('项目登记为只读，所选 Worker 已启用工作区写入')
  } else if (sandbox?.type !== 'readOnly' && sandbox?.type !== 'workspaceWrite') {
    issues.push('所选 Worker 的沙箱不受 Router 支持，请选择只读或受限的工作区写入会话')
  } else if (sandbox.networkAccess !== false || (sandbox.type === 'workspaceWrite' &&
      (sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true ||
        !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some(root => root !== project.cwd)))) {
    issues.push('所选 Worker 的网络或写入范围超出项目权限')
  }
  return issues.length ? issues.join('。') : null
}

export function workerSettingsStamp({ cwd, sandbox, approvalPolicy, approvalsReviewer, model, effort, collaborationMode }) {
  return { cwd, sandbox, approvalPolicy, approvalsReviewer, model, effort, executionMode: collaborationMode?.mode ?? 'default' }
}

export function workerPermissionMatches(project, settings, permission) {
  if (workerIdentityIssue(project, settings)) return false
  const expected = permissionPayload(permission, true)
  const sandbox = settings.sandbox
  if (settings.approvalPolicy !== expected.approvalPolicy ||
      settings.approvalsReviewer !== expected.approvalsReviewer || sandbox.type !== expected.sandboxPolicy.type) return false
  if (sandbox.type === 'workspaceWrite') {
    return sandbox.networkAccess === expected.sandboxPolicy.networkAccess &&
      sandbox.excludeTmpdirEnvVar === true && sandbox.excludeSlashTmp === true &&
      Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.every(root => root === project.cwd)
  }
  return sandbox.type !== 'readOnly' || sandbox.networkAccess === false
}

export function describeWorkerSettings({ sandbox, approvalPolicy, approvalsReviewer }) {
  const access = { readOnly: '只读', workspaceWrite: '工作区写入', dangerFullAccess: '完全访问' }
  const policy = { never: '免审批', 'on-request': '按需审批', 'on-failure': '失败时审批', untrusted: '不可信操作需审批' }
  const details = [access[sandbox.type], policy[approvalPolicy]]
  if (approvalsReviewer === 'auto_review') details.push('自动审查')
  if (sandbox.networkAccess) details.push('可联网')
  if (sandbox.writableRoots?.length) details.push('可写目录 ' + sandbox.writableRoots.join('、'))
  if (sandbox.type === 'workspaceWrite' && (!sandbox.excludeTmpdirEnvVar || !sandbox.excludeSlashTmp)) details.push('可写临时目录')
  return details.join('，')
}
