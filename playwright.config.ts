import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir:'test/e2e',fullyParallel:false,workers:1,timeout:30000,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:18787',viewport:{width:1440,height:900},locale:'zh-CN',timezoneId:'Asia/Shanghai',trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:{args:['--no-sandbox']}},
  webServer:{command:'node test/fixtures/browser-server.mjs',url:'http://127.0.0.1:18787/healthz',reuseExistingServer:false,timeout:20000},
})
