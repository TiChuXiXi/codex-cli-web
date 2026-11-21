import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fault, windows } from './common.js'

const run = promisify(execFile)
export async function npmClient(cwd) {
  const candidates = []
  if (process.env.npm_execpath?.endsWith('npm-cli.js')) candidates.push(process.env.npm_execpath)
  for (const dir of [dirname(process.execPath), ...(process.env.PATH || '').split(delimiter).filter(Boolean)]) {
    if (windows) candidates.push(join(dir,'node_modules','npm','bin','npm-cli.js'))
    else {
      try { candidates.push(await realpath(join(dir,'npm'))) } catch {}
    }
  }
  let cli
  for (const path of candidates) {
    if (!path.endsWith('npm-cli.js')) continue
    try { await access(path); cli=resolve(path); break } catch {}
  }
  if (!cli) throw fault(3,'找不到 npm-cli.js，请安装 npm 并检查 PATH')
  const require = createRequire(cli)
  const semver = require('semver')
  const pacote = require('pacote')
  async function npm(args) {
    try {
      const {stdout} = await run(process.execPath,[cli,...args],{cwd,windowsHide:true,timeout:300000,maxBuffer:4*1024*1024})
      return stdout.trim()
    } catch (error) {
      const code = String(error.stderr || '').match(/(?:code|errno)\s+([A-Z][A-Z0-9_]+)/)?.[1]
      throw fault(1,'npm ' + args[0] + ' 失败' + (code ? ' ('+code+')' : '；请查看 npm 本机日志'))
    }
  }
  return {npm,semver,manifest:path=>pacote.manifest(path)}
}
