#!/usr/bin/env node
import { parseArgs, loadConfig } from '../server/config.js'
import { readAccessToken } from '../server/auth.js'
import { registerRouter } from '../server/router/register.js'
import { bootstrap } from '../server/bootstrap.js'
try {
  const args=parseArgs(process.argv.slice(2))
  if(args.help) {
    console.log('codex-web-ui [--host 127.0.0.1] [--port 8787] [--config file]\n  --state-dir path --codex-path path --codex-home path\n  --transport auto|daemon|stdio --git-write true|false\n  --allowed-hosts host:port --allowed-origins https://host\n  --auth-mode token|network --allowed-clients IP[,IP/CIDR]\n  --log-level debug|info|warn|error|silent\n  --register-router-launcher path  生成 Router 安装记录后退出\n  --print-access-token  显式显示本机访问凭证后退出')
  }else {
    const config=await loadConfig(args)
    if(args.registerRouterLauncher) {
      await registerRouter(config.stateDir,args.registerRouterLauncher)
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
