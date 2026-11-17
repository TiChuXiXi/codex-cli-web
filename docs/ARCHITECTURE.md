# 架构

浏览器 React 工作台 → 同源 HTTP RPC/SSE/上传下载 → 独立 Node 服务 → Hub/JSON-RPC → daemon 或 stdio → Codex app-server。文件、Git、PTY、版本服务在 Node 侧运行。

server/bootstrap.js 装配认证、事件总线、Hub、队列、工作区、Git、终端、版本、路由与静态服务；返回 await close()。server/config.js 处理应用配置，Codex 业务默认值保留在 codex/config.js。浏览器不持有 Codex 凭据，不开放任意 Codex RPC。

原 /codex-cli/* 信封及错误码保持，包含 Git 扩展路由。独立认证为 POST /auth/login（{token}，成功设置 Cookie，返回 {authenticated,expiresAt}）、GET /auth/session 和 POST /auth/logout。GET /healthz 只报告进程存活。SSE hello 额外携带 host instanceId，不改变事件主体或 Last-Event-ID 语义。

状态归属：Codex 保存历史；Node 内存保存队列、pending、SSE 缓冲、watcher 和 PTY；浏览器保持源有 localStorage/sessionStorage 语义。队列自动调度不依赖浏览器存活。原子流式上传、真实路径校验和 Git 写开关保留。

默认同源且仅监听 loopback；使用 Cookie、Host/Origin 精确白名单、写请求同源校验和登录失败限流。凭证不进入 bundle、URL 或启动日志。部署反向代理通过 publicOrigin 明确外部 origin，不根据任意转发头推断。

关闭：停止接单和监听 → 关闭 SSE/上传及认证响应 → 停止队列调度、文件观察、PTY、Git、版本作业 → await Hub.stop() → 释放总线和 HTTP 连接。CLI 为整个关闭设置最终期限。共享 daemon 不主动 stop。

完整端点与逐项状态以 docs/spec/03-代码逻辑位置与比对指南.md 和 FEATURE_MATRIX.md 为准。

设置服务：SettingsService 提供受同一认证栅栏保护的 settings/read 和 settings/whitelist。read 返回 authMode、allowedClients、真实 clientIp、revision、editable/lockedReason、firewallManaged；不返回凭证、配置文件路径或任意原始配置。whitelist 请求为 {allowedClients, revision, confirmSelfRemoval?}，成功即时生效并持久化。错误包含 invalid、conflict、locked、self-removal、storage、firewall。来源、Host/Origin 和写请求同源校验保持。

settingsFirewall 为服务端部署配置，形如 {enabled:true,zone:"public",destination:"192.168.1.182"}，端口取当前应用监听端口。页面只编辑名单，不能通过 API 选择配置文件路径、firewall zone 或命令。启用时 firewalld 同步失败会阻止保存，落盘失败会回滚相应规则；未启用时页面说明外部防火墙需自行管理。
