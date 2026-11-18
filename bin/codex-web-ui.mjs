#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, loadConfig } from '../server/config.js'
import { readAccessToken } from '../server/auth.js'
import { bootstrap } from '../server/bootstrap.js'
try {
  const args=parseArgs(process.argv.slice(2))
  if(args.help) {
    console.log('codex-web-ui [--host 127.0.0.1] [--port 8787] [--config file]\n  --state-dir path --codex-path path --codex-home path\n  --transport auto|daemon|stdio --git-write true|false\n  --allowed-hosts host:port --allowed-origins https://host\n  --auth-mode token|network --allowed-clients IP[,IP/CIDR]\n  --log-level debug|info|warn|error|silent\n  --register-router-launcher path  生成 Router 安装记录后退出\n  --print-access-token  显式显示本机访问凭证后退出')
  }else {
    const config=await loadConfig(args)
    if(args.registerRouterLauncher) {
      const launcher=await realpath(args.registerRouterLauncher)
      const info=await stat(launcher)
      if(!info.isFile() || !(info.mode & 0o111) || (info.mode & 0o022))throw new Error('Router 启动器必须可执行且其他用户不可写')
      const launcherSha256=createHash('sha256').update(await readFile(launcher)).digest('hex')
      await mkdir(config.stateDir,{recursive:true,mode:0o700})
      const manifest=join(config.stateDir,'router-installation.json')
      const temporary=manifest+'.'+randomUUID()+'.tmp'
      try {
        await writeFile(temporary,JSON.stringify({enabled:true,launcher,launcherSha256},null,2)+'\n',{flag:'wx',mode:0o600})
        await rename(temporary,manifest)
      } finally {await unlink(temporary).catch(()=>{})}
      console.info('Router 安装信息已保存')
    }else if(args.printAccessToken)console.log(await readAccessToken(config))
    else {
      const app=await bootstrap(config)
      console.info(config.authMode==='network'?'已启用 IP 白名单免登录访问。Codex 登录请使用 codex login。':'Web 登录凭证保存在应用 state-dir；使用 --print-access-token 单独查看。Codex 登录请使用 codex login。')
      let stopping=false
      const stop=async()=>{if(stopping)return;stopping=true;const deadline=setTimeout(()=>process.exit(1),5000);try{await app.close()}finally{clearTimeout(deadline)}}
      process.once('SIGINT',stop);process.once('SIGTERM',stop)
    }
  }
}catch(error){console.error(error.message);process.exitCode=1}
