# 当前实现与验收记录

日期：2026-11-17。项目版本 0.1.0，前端 buildId：8f6a62ed944b8dac。尚未创建目标 Git 提交，未发布 npm 包。

完整 38 项实现已按源到目标映射迁入；当前结论是“可独立运行并通过以下技术验证”，不是“全部功能子场景已经最终验收”。逐项范围见 FEATURE_MATRIX.md 和原规格。

## 已执行

| 检查 | 结果与证据 |
|---|---|
| npm ci | 通过，独立 package-lock；不复制原 node_modules |
| npm run build | 通过，独立 ESM/CSS 和预构建前端 |
| npm run typecheck | 通过，严格 TypeScript 检查，含 vendored 组件 |
| npm test | **138/138 通过**，无跳过；日志 acceptance/unit.log |
| npm run test:visual | **6/6 通过**，包含对话、队列、审批、主题、登录恢复、文档、HTML、真实 PTY 保留及 Git 面板；日志 acceptance/browser.log |
| 响应式截图 | 1440×900、1280×800、768×1024、390×844，各浅深主题；截图 acceptance/screenshots |
| 受控参考源码对比 | 同一个模拟后端与固定夹具，8 个空会话工作台组合均 **0 像素差异**；报告 acceptance/parity/report.json，reference/target/diff 截图均保留 |
| 独立 UI 复核 | 登录表单三项问题已修复，复核 resolved；ship 仅限定该三项，见 acceptance/UI_REVIEW.md |
| 真实 Codex 协议 | Codex CLI **0.169.0**，临时隔离 CODEX_HOME，stdio 初始化握手通过；acceptance/live.json |
| npm pack / dry-run | 通过；分发清单 acceptance/package.json、package-dry-run.json，无 DSH/Cordis、测试夹具、上传文件、凭据或开发 node_modules |
| 生产安装烟测 | 临时目录安装实际 tarball、仅生产依赖，直接运行安装后的 CLI，页面、认证、原生 PTY、SIGTERM 通过；acceptance/package-smoke.log |
| 原仓库保护 | 已跟踪源码无差异；保留原来唯一未跟踪的 codex-web-ui-spec-20261117.zip |
| git diff --check | 无错误；新仓库尚无提交，未将此检查当作所有未跟踪文件的差异证明 |

运行环境为 Linux arm64，Node 24.19.0、npm 11.17.0；浏览器测试使用 Playwright 下载的 Chromium。该验证不代表 Windows/macOS 支持。

## 已覆盖的关键边界

单元/集成包括 500 MiB 原始二进制上传、失败取消清理、真实 Bash PTY 与子进程关闭、临时 Git 仓库危险操作、不同名上游推送、队列快速完成竞态、断线暂停、权限更新、SSE 重放与实例识别、审批以及隐藏标题会话隔离。

新增宿主验证覆盖所有传输入口的认证、非法 Host/Origin、写请求防护、限流、Cookie、会话失效、静态路由边界、活动 SSE/PTY/watcher 清理及重启实例变化。版本服务另验证 CODEX_HOME、活动作业和挂起诊断取消、启动失败状态完成。

## 尚未完成的最终验收

- 使用真实已登录 Codex 账号的模型回合和完整业务闭环：**未执行**。现有真实测试只证明指定版本的初始化握手。
- CLI 升级/回滚、外部 daemon 的 start/stop/restart/update：**未执行**，不会混入普通测试或触碰现有共享实例。
- 与原插件共享 CODEX_HOME 的并发操作：**未执行**。
- 38 项中所有菜单、异常、同步/异步多题私密问答、附件状态、工具组、长消息、文件/Git/浮动窗口等完整视觉金样矩阵：**尚未逐项验收**。八组零差异只覆盖空会话工作台，不扩展结论。
- 干净设备实装：当前为当前主机上的隔离生产安装测试，未宣称更换设备验证。
- 真实版本兼容范围、代理部署和局域网环境：只记录实测结果，不因提供配置能力而宣称全面兼容。

上述未执行项不得填写“通过”。完成正式发布前，继续按 spec/02 的子场景逐项登记环境、操作、目标提交、截图/日志及差异；缺少账号或环境时记“阻塞”。文件永久删除与手册回收站描述冲突已在 DEVIATIONS.md 单列。

## 后续设置页变更

用户追加的设置页、更新迁移和即时白名单管理已交付；最新验证为155项自动测试通过、13项E2E通过。初次验收表保留其历史构建与证据；本次范围、截图及限制见 [设置页验证](acceptance/settings/RESULTS.md)。
