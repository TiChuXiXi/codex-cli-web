import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { HubError } from '../codex/hub.js'

const safeSandbox = new Set(['read-only', 'workspace-write'])
const identity = ({ dev, ino }) => String(dev) + ':' + String(ino)
export const shortText = (value, max = 320) => typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, max) : ''

export async function loadRouterProjects(config, directory) {
  const projects = new Map()
  const roots = new Set()
  for (const entry of config) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ||
        typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120 ||
        typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd) || projects.has(entry.id) ||
        (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some(alias =>
          typeof alias !== 'string' || !alias.trim() || alias.length > 120)))) {
      throw new Error('Router 项目登记格式无效或项目 ID 重复')
    }
    const cwd = await realpath(entry.cwd)
    const info = await stat(cwd, { bigint: true })
    const sandboxLimit = entry.sandbox ?? 'read-only'
    if (!info.isDirectory() || roots.has(cwd) || cwd === directory || cwd === '/' ||
        cwd.startsWith(directory + '/') || directory.startsWith(cwd + '/') ||
        !safeSandbox.has(sandboxLimit)) {
      throw new Error('Router 项目路径重复、与 Router 状态目录相交或沙箱无效')
    }
    roots.add(cwd)
    projects.set(entry.id, {
      id: entry.id, name: entry.name, aliases: entry.aliases ?? [], cwd, identity: identity(info), sandbox: sandboxLimit,
    })
  }
  return projects
}

export async function checkProject(project) {
  if (!project) throw new HubError('codex-cli/router-project', '仅可调度登记项目')
  let valid = false
  try {
    valid = await realpath(project.cwd) === project.cwd &&
      identity(await stat(project.cwd, { bigint: true })) === project.identity
  } catch {}
  if (!valid) throw new HubError('codex-cli/router-project', '项目目录已改变，需要重新核验')
  return project
}

export async function checkThread(project, thread, routerThreadId) {
  if (!thread || thread.id === routerThreadId || thread.archived === true ||
      thread.ephemeral === true || typeof thread.cwd !== 'string') {
    throw new HubError('codex-cli/router-thread', '目标会话不可调度')
  }
  let belongs = false
  try { belongs = await realpath(thread.cwd) === project.cwd } catch {}
  if (!belongs) throw new HubError('codex-cli/router-thread', '目标会话不属于登记项目')
  return thread
}

export function canDispatch(project, settings) {
  const sandbox = settings?.sandbox
  return settings?.cwd === project.cwd && settings.approvalPolicy === 'on-request' && settings.approvalsReviewer === 'user' &&
    sandbox?.networkAccess === false &&
    (sandbox.type === 'readOnly' ||
      (sandbox.type === 'workspaceWrite' && project.sandbox === 'workspace-write' &&
        sandbox.excludeTmpdirEnvVar === true && sandbox.excludeSlashTmp === true &&
        Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.every(root => root === project.cwd)))
}
