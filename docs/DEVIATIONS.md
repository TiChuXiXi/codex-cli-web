# 差异与文档冲突

## 允许的独立外壳差异

- 新增 Node CLI、HTTP、静态资源、配置、认证、登录和登出。
- 服务代码整理为 server，前端整理为 web，共用契约和限制放 shared；完整映射见 migration-map.json。
- React 由应用显式提供；不再使用 DSH slots/layout/locale/connection/ModuleLoader。
- 原宿主返回入口改为同位置“退出 Web 登录”；视觉对比只屏蔽该控件。
- runtime 从新工程文件生成 buildId/instanceId；前端请求地址统一通过 URL helper。

## 新项目修复

- 严格 TypeScript 检查修正了 Ref 初值、词典索引、turn.durationMs、BlobPart、品牌 ID 和 cloneElement props 类型。
- Hub 在初始化失败或关闭期间释放已打开传输，重连等待支持取消，初始化期间 stop 不再遗漏私有子进程。
- 版本服务增加子进程、fetch 和计时器清理，并为探测与作业传递显式 CODEX_HOME。版本作业使用 close 事件结束失败状态，修复 spawn 失败永久 running；Linux 子进程组在退出时终止，包含挂起的诊断进程。新增 test/versions.test.mjs 覆盖。
- SSE hello 增加应用 instanceId；实例变化或序号回退触发 resync，重新拉取当前详情与队列。新增 epoch 单元测试。
- 浏览器相关 ID 兼容显式配置的 HTTP 局域网 origin，使用 getRandomValues 兜底。

## 文档冲突与失效测试

W-02：验收手册写“删除移入 .dsh-trash”，但锁定源码 WorkspaceService.remove 调用 rm(...,{recursive:true})，本地 workspace 测试亦验证永久删除。按照“用户明确要求 > 锁定源码 > 同提交有效测试 > README/历史资料”优先级，本项目保留永久删除，未新增回收站。此项人工验收必须确认实际语义。

本地 providers.test.mjs、go-quota.test.mjs 引用的 provider-hub.js/providers.js 不在锁定源码中，未迁入。thread-titles.test.mjs 的多提供商断言亦与当前固定 OpenAI 源码不符，改为验证实际可达 OpenAI 标题流程；不通过实现额外提供商来满足旧测试。

## 尚不能宣称完成的验证

真实 Codex 0.169.0 的隔离 stdio 握手已执行，报告见 acceptance/live.json。未执行使用真实账号的模型回合、CLI 升级/回滚、外部 daemon 管理及与原插件共享 CODEX_HOME 并发操作。

受控视觉对比先覆盖空会话工作台；复杂工具组、长消息、菜单、附件、文件/Git/终端等全部子场景仍需继续补齐受控金样。普通 E2E 与截图采集不等于全部 38 项人工验收。

## 2026-11-17 用户追加：IP 白名单免登录

用户明确取消内网登录凭证，并指定当前白名单只有 192.168.1.80。增加 authMode=network 和 allowedClients（精确 IPv4/IPv6 或 CIDR），默认 token 模式保持原行为。部署配置为 config.lan.json；network 模式不读取/生成访问凭证、不签发 Cookie，隐藏登出入口。白名单校验在静态页面及全部业务通道之前执行，使用真实 TCP 对端，保留 Host/Origin 和写请求同源检查。

来源名单变更需重启服务；允许网段和其他 IP 是可配置能力，不表示当前已放行。新增 test/client-access.test.mjs 和 test/e2e/network-access.spec.ts。原压缩包中强制 Web 登录的要求已由本次用户指令覆盖。

## 用户追加：设置页面与白名单管理

新增工作台“设置”页面，将原 VersionsDialog 的检查更新、升级、回滚、守护进程管理及体检迁为 VersionsPanel 页内内容；原入口改为设置，保留原业务 API 和活动回合保护。新增“访问白名单”分类，支持逐行添加、删除、校验、保存和重新加载；显示实际对端 IP，移除当前 IP 需明确确认，未保存离开有提示。

新增 settings/read、settings/whitelist 两个认证 RPC。保存有 revision 冲突检查，白名单原子写入所用应用配置（无配置文件时写 state-dir/settings.json），更新内存过滤器并关闭被移除 IP 的活动连接。CLI/环境覆盖白名单时页面只读，避免保存后无效。旧版本弹窗文件已移除。

当前服务器 config.lan.json 开启 settingsFirewall，由服务以显式配置的 zone/destination/当前端口同步精确来源 rich rules 的运行时和永久规则。只操作对应白名单规则，不 reload 全局防火墙；同步或落盘失败会回滚已执行步骤并保留旧内存配置。模拟测试不执行真实升级/daemon 管理，也不调用服务器 firewalld。

## 2026-11-18 Router A1 验证

本机 Codex 0.169.1 使用临时私有 stdio 进程及回环模型夹具，验证了动态工具注册和回传、线程恢复、受测内置工具禁用及原子空闲启动。新增独立实验脚本和协议测试，生产工具白名单与宿主隔离待验收。详见 [Router A1 验证](acceptance/router-a1.md)。

## Router 工作台扩展

新增可选 Router 入口与 SQLite 状态区，权限边界由专用 Codex 工具白名单、私有启动器和 Node 调度网关共同执行。Worker 派发使用原生空闲队列并保留现有手动工作台、RPC 信封和 SSE。默认关闭。详见 [Router MVP](ROUTER.md)。
