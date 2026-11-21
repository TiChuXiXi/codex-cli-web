import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveCodexCommand, resolveCodexHome } from '../codex/transport/index.js'
import { daemonSocketPath } from '../codex/transport/daemon.js'

const run=promisify(execFile)

export async function diagnose(config) {
  const codexPath=resolveCodexCommand(config.codex)
  const home=resolveCodexHome(config.codex)
  const options={env:{...process.env,CODEX_HOME:home},windowsHide:true,timeout:5000,maxBuffer:16384}
  const [version,login,pty]=await Promise.allSettled([
    run(codexPath,['--version'],options),
    run(codexPath,['login','status'],options),
    import('@lydell/node-pty'),
  ])
  const codexVersion=version.status==='fulfilled' ? version.value.stdout.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] : null
  return {node:process.versions.node,platform:process.platform,architecture:process.arch,
    transport:config.codex.transport,codexPath,codexVersion:codexVersion || null,
    loginConfirmed:login.status==='fulfilled',daemonSocketPresent:!!daemonSocketPath(home),
    routerEnabled:config.router.enabled,ptyAvailable:pty.status==='fulfilled'}
}
