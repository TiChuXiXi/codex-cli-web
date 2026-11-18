import { execFile } from 'node:child_process'
import { mkdir, realpath, rmdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { HubError } from '../codex/hub.js'

const run = promisify(execFile)
const invalid = message => new HubError('codex-cli/router-project', message)

export async function projectParent(path, stateDir) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw invalid('请输入工作台上的绝对目录路径')
  const root = resolve(path)
  const state = resolve(stateDir)
  if (root === resolve(root, '..') || root === state || root.startsWith(state + sep)) throw invalid('请选择工作台状态目录以外的项目父目录')
  // Check the closest existing ancestor before creating anything beneath it.
  let ancestor = root
  while (true) {
    try {
      if (await realpath(ancestor) !== ancestor || !(await stat(ancestor)).isDirectory()) throw invalid('请选择真实目录')
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      ancestor = resolve(ancestor, '..')
    }
  }
  return root
}

export function newProjectTarget(target) {
  let name, repository
  if (target.startsWith('new:')) name = target.slice(4)
  else {
    let url
    try { url = new URL(target) } catch { throw invalid('仓库地址无效') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.slice(1)) {
      throw invalid('请输入不含凭证的 HTTPS Git 仓库地址')
    }
    repository = url.href.replace(/\/$/, '')
    name = basename(new URL(repository).pathname).replace(/\.git$/i, '')
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,99}$/u.test(name) || /[. ]$/.test(name)) throw invalid('项目名须为单个目录名')
  return { name, repository }
}

export async function makeProject(root, { name, repository }, stateDir) {
  await projectParent(root, stateDir)
  const cwd = join(root, name)
  if (cwd === stateDir || stateDir.startsWith(cwd + sep)) throw invalid('项目目录与工作台状态目录重叠')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (await realpath(root) !== root) throw invalid('项目父目录已变化')
  try { await mkdir(cwd, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw invalid('该目录已存在，请使用已有项目或选择其他名称')
    throw invalid('无法在指定父目录中新建项目')
  }
  if (repository) {
    try {
      await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=120',
        'clone', '--no-recurse-submodules', '--', repository, '.'],
        { cwd, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https' } })
    } catch {
      await rmdir(cwd).catch(() => {})
      throw invalid('克隆失败，请核对仓库地址、网络或服务账号的 Git 访问权限')
    }
  }
  return cwd
}
