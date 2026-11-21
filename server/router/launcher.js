import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { checkWindowsLauncher } from './windows-access.js'

export async function checkRouterLauncher(path, { register = false } = {}) {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Router 启动器必须是可执行文件')
  if (process.platform !== 'win32') {
    if (!(info.mode & 0o111) || (register && (info.mode & 0o022))) {
      throw new Error('Router 启动器必须可执行且其他用户不可写')
    }
    return
  }
  if (extname(path).toLowerCase() !== '.exe') throw new Error('Windows Router 需要原生 .exe 启动器')
  await checkWindowsLauncher(path)
}

export function launcherEnvironment(home, directory) {
  const env = { HOME: home, CODEX_ROUTER_CONFIG_DIR: directory }
  if (process.platform !== 'win32') return { ...env, PATH: '/usr/bin:/bin' }
  // The trusted supervisor needs its Windows profile to create the AppContainer.
  // It supplies a separate restricted environment to the Router.
  const systemRoot = process.env.SystemRoot
  for (const key of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { ...env, SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32') }
}

