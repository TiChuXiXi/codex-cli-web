# 产品约定

独立 Codex CLI Web 工作台，服务于单一可信操作者，在浏览器管理服务端的 Codex 会话、文件、Git 和终端。完整产品需求为 docs/spec/ 中的 38 项功能。

用户确认首版直接整理为 server/web/shared。视觉与交互固定继承参考提交 48590b624d011d8036d412c31c8f5f319410eecb 的可达 ConsolePage 和 SidebarWorkspace；不进行新视觉设计。新增外壳为启动、登录、认证、配置和关闭流程。

首版平台 Linux、Node 24.19.0，npm CLI 携带静态资源。无 DSH/Cordis 运行依赖。数据不新建数据库，Codex 历史由 Codex 管理。多租户、Docker和单二进制不在首版范围。用户追加授权新增设置页，包含版本与更新、IP 白名单管理；名单保存需即时生效并持久化。
