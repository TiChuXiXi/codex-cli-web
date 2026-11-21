import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { checkRouterLauncher } from './launcher.js'
import { save } from '../lifecycle/common.js'
import { prepareWindowsRouterDirectory } from './windows-access.js'

export async function registerRouter(stateDir,path,expected) {
  const launcher=await realpath(path)
  await checkRouterLauncher(launcher,{register:true})
  const launcherSha256=createHash('sha256').update(await readFile(launcher)).digest('hex')
  if(expected && expected.toLowerCase()!==launcherSha256) throw new Error('启动器 SHA-256 与预期不符')
  if(process.platform==='win32') await prepareWindowsRouterDirectory(stateDir)
  else await mkdir(stateDir,{recursive:true,mode:0o700})
  await save(join(stateDir,'router-installation.json'),{enabled:true,launcher,launcherSha256})
}
