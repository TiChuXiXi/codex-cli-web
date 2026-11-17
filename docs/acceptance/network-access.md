# IP 白名单免登录部署

日期：2026-11-17。用户明确指定白名单只有 192.168.1.80；已按该配置重启服务。

- 地址：http://192.168.1.182:8787
- 配置：config.lan.json，authMode=network，allowedClients=["192.168.1.80"]。
- 启动：node bin/codex-web-ui.mjs --config config.lan.json。
- 前端 buildId：547d1529ef391859。
- 服务端和 firewalld 的运行时/永久规则均只放行 .80 访问 8787；此前 192.168.1.0/24 的 8787 规则已移除。
- 白名单外的本机来源实际请求返回 403，伪造 X-Forwarded-For: 192.168.1.80 仍为 403。
- 已确认服务监听 0.0.0.0:8787，并连接现有 Codex daemon；重启未停止共享 daemon。

验证：build、typecheck、143/143 单元/集成测试通过；E2E 6 项通过，另1项视觉采集按默认开关跳过。新浏览器案例验证允许来源无凭证、无 Cookie 直接进入工作台和发送/刷新，且没有登出按钮；精确 .80 匹配、IPv4-mapped IPv6、CIDR、非法配置、伪造头、Host/Origin 及所有通道的拒绝行为由 client-access.test.mjs 验证。正向集成浏览器夹具单独允许测试回环地址，实际部署没有额外放行回环。

本机不在当前白名单，不能用本机正向访问代替 .80 客户端实测。请在 192.168.1.80 打开上述地址验证实际内网端到端连接。

后续编辑 config.lan.json 的 allowedClients 后重启；如扩大名单，同时同步 firewalld 的精确来源规则。
