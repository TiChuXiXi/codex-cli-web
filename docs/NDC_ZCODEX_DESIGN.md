# NDC：zcodex npm 发行与 CLI 生命周期管理设计

## 1. 背景与目的

codex-cli-web 已有 Node.js 服务入口 `bin/codex-web-ui.mjs`、前端构建、`prepack`、`test:package`、Router/Worker、RCC、PSM、微信 iLink 和 RIP。当前源码基线 `package.json` 为 `codex-cli-web@0.1.0`、`private:true`、`bin.codex-web-ui`、Node `>=24.19.0`。README 仍以 `npm ci && npm run build && npm start` 为主要部署方式。源码部署不适合正式分发，用户不应自行拉取仓库或构建前端。

本项目要提供 npm 全局安装后的 **zcodex** 命令，管理本机服务的初始化、后台启动、停止、状态、日志、检查、更新和卸载。保持 Web/Router/Worker/PSM/RCC/iLink/RIP 既有架构，不引入 Electron/Tauri、Docker、PM2 强制依赖或另一套任务系统。

## 2. 产品命名和发布边界

- CLI 固定为 `zcodex`，仓库名和产品 UI 不改，Router 的“中枢”人格名称不改。
- npm 包名优先 `zcodex`，**发布前实际核实注册表可用性**；不可用时采用有权限的 scope 包，但 `bin` 仍为 `zcodex`。不得声称名称已被注册或已发布。
- npm 包版本使用 SemVer；Git tag、npm 包、应用 `--version`、前端版本一致；明确 prerelease、latest dist-tag 和回滚策略。
- Node 运行时由用户安装，遵守当前 engines；npm 安装不执行 Codex 登录或自动升级 Codex。
- 目标第一版 Linux x64/arm64、Windows x64；macOS 视实际测试结果支持。每个平台独立测试 optional native dependency。

## 3. 用户体验和命令契约

```bash
npm install -g zcodex       # 包名如需 scope 则替换安装名，命令不变
zcodex init
zcodex start
zcodex status
zcodex logs -f
zcodex open
zcodex doctor
zcodex restart
zcodex update
zcodex stop
zcodex uninstall
```

| 命令 | 语义与要求 |
|---|---|
| `zcodex --help`, `--version` | 无需启动服务，列出用法及当前 CLI 包版本 |
| `init` | 幂等初始化配置/数据目录，检查 Node、Codex CLI、Router 专用 App Server、权限、端口、状态目录；交互式设置默认本地监听，非交互场景提供明确参数；不覆盖既有数据 |
| `start` | 后台启动，返回服务真实就绪状态、PID、地址；已运行则不重复启动；失败返回非零码及日志位置 |
| `stop` | 对确认属于本安装实例的服务优雅停机，超时才提供明确的强制选项；默认不取消或中断外部 Worker |
| `restart` | 先停后启，核对新实例健康；避免双实例和端口争用 |
| `status` | 输出 CLI/服务版本、运行状态、PID、监听地址、健康状态、数据目录、Codex/Router 依赖诊断摘要；支持 `--json` |
| `logs` | 查看应用日志，`-f` 跟随，支持 `--lines`；敏感信息脱敏，不泄露 token、微信凭据 |
| `doctor` | 检查 Node engines、平台、Codex 路径/版本/登录状态（只读）、Router 专用运行时、状态目录权限、端口/健康、可选 PTY；失败分级并给出修复指引 |
| `open` | 打开本机 URL；无 GUI/SSH 环境打印地址；不得把访问凭据直接放在 URL 或终端日志中 |
| `update` | **只更新 zcodex 应用包**，不升级 Codex CLI；检查 npm 包版本和来源、升级前安全检查、优雅停止、外部辅助进程执行 npm 更新、健康验证、恢复运行状态；失败时说明恢复/回滚边界 |
| `uninstall` | 默认停止服务并通过外部 npm 进程卸载全局包，**保留数据**；`--purge` 必须二次确认，非交互模式要求额外明确授权；卸载后不留下自启动服务 |

命令应支持 `--config`、`--state-dir` 等与现有服务一致的定位参数，避免同一机器多实例误操作；明确多实例识别、默认实例和命名实例是否为第一版范围。CLI 命令输出简洁、稳定，交互和非交互模式均可用；成功/失败退出码可靠。

## 4. 进程管理与生命周期

优先使用 Node 标准库实现轻量后台管理；不要仅凭 PID 文件。状态至少包含实例标识、启动时间、PID、可执行文件/入口路径、配置及状态目录、服务监听信息。停止前验证进程身份；健康检查必须使用应用已有的安全可用接口或新增**不泄露业务数据**的最小本地检查，不能绕过 Web 认证。Linux/macOS 使用适当的 detached/stdio 机制；Windows 单独验证 detached、信号、子进程树和文件锁行为。

后台服务日志落在独立数据/日志目录，提供轮转和保留策略。并发 start/stop/restart/update 使用跨进程锁或等效原子机制，处理异常退出、PID 复用、陈旧状态文件、端口被其他程序占用、孤儿子进程及重启恢复。默认不注册开机自启，不强制 systemd/Windows Service；如果检测到用户现有 systemd 管理实例，应提示冲突而不是抢占。

优雅停机应停止新请求、关闭微信收件及 outbox、持久化 RCC 队列状态、关闭 SQLite、释放端口和订阅；**不能声称停机等于中断 Worker**。重启后依靠现有 RCC/PSM/微信恢复机制对账，避免重复派发或重复通知。停机超时需报告真实状态。

## 5. 数据、配置与安全

程序安装目录不可写入运行数据。沿用项目现有 state-dir 和 `CODEX_WEB_*`、CLI > 环境变量 > JSON > 默认值优先级；不能悄悄把已有用户的 `~/.local/state/codex-cli-web` 改到新路径。新安装可选择明确的默认路径；若计划迁移，必须给出兼容发现、备份、一次性迁移和回滚方案，且用户确认后执行。

持久化内容包括 SQLite（Router/PSM/RCC）、微信绑定及加密密钥、访问凭据、配置、日志、任务/通知记录。npm 更新、普通卸载默认保留。`--purge` 明确列出会清除哪些内容，以及不会删除 Codex 自身历史或项目源码。配置文件和凭据使用平台适合的私有权限；默认监听 `127.0.0.1`、保持现有 token/白名单安全策略，绝不默认开放 LAN 或免登录。

## 6. Codex CLI 与 Router 运行时

UAS-R3 后，发行目标为 Router 与 Worker 共同使用一份受保护的官方 Codex，两者各有资格记录、进程和连接。普通 npm 安装不编译 Rust。管理员在强隔离部署中一次性保护安装、服务身份和控制端点；现有定制启动器及已验证制品用于 C 的兼容和回退。以下专用运行时准备条款继续适用于 C。[发行计划修订](NDC_ZCODEX_IMPLEMENTATION_PLAN.md) · [UAS-R3](ROUTER_UNIFIED_APP_SERVER_R3.md)

Codex CLI 是独立依赖：`init`/`doctor` 检测，不隐式安装/升级、改写用户 Codex Home 或执行登录。专用 Router App Server 的安装/准备流程必须先审查 `scripts/prepare-router-codex.mjs`、`scripts/router-launcher.sh` 和部署平台兼容性，判断 npm tarball 中是否包含准备脚本需要的全部源码/资源、是否依赖 Rust 构建工具、能否在无仓库环境使用。无法支持的平台应清楚标记 Router 不可用，而不是工作台整体假启动成功。可以引导用户明确执行准备步骤，但不得悄悄下载执行不可信二进制。

## 7. npm 打包与发布

审查并调整 `package.json` 的 `private`、`name`、`bin`、`files`、`engines`、`prepack`、依赖和许可；发布 tarball 包含运行所需的 `bin/server/shared/dist/web`、配置、声明及 Router 运行时准备所需资源。构建在 CI/发布前完成；安装时不应编译前端，也不应依赖仓库的 devDependencies。检查 optional `@lydell/node-pty` 的平台适配和降级。排除测试数据、用户状态、密钥、开发缓存和无关大文件。发布前执行 `npm pack --dry-run`、`npm pack`、`test:package`，再在隔离的干净 Node 环境 `npm install -g <tarball>` 验证。

发布建议先手动批准的 GitHub Actions：类型检查、单测、构建、打包、跨平台安装冒烟、版本一致性、校验发布内容、npm 发布；凭证采用最小权限和适合的 npm 可信发布方式。禁止把仓库的 `private:true` 直接删除后自动发布而未经审查。README 分开写开发部署和 npm 用户安装，提供 Windows PowerShell、Linux bash 的实际命令。

## 8. 更新与卸载安全

`zcodex update` 必须考虑 npm 全局安装权限、registry、代理、scope、dist-tag、运行中的 CLI 自替换、Windows 文件占用、Node 版本变化、用户数据 schema 前进兼容性。优先外部辅助进程执行 npm 更新，不能让正在被替换的 CLI 进程继续依赖自身文件。默认只查稳定版；支持 `--check`；升级前判断 RCC 在途/unknown、微信待办、正在执行的 Worker 和 Router 主会话状态，按真实风险提示/阻止或要求明确确认。不能简单因为有 Worker 在执行就永远禁止更新：应定义安全停机与恢复边界。

数据库升级前按需备份，说明 schema 不可逆时无法仅靠 `npm install` 回滚。升级失败需恢复原服务或明确保持停止并提供可操作的恢复指引，绝不谎报成功。`uninstall` 的自卸载也需要外部辅助进程；`--purge` 不能删除用户 Codex Home、工作项目或其他实例的数据。

## 9. 建议逐阶段实施

- **P0：npm 包可安装**：打包结构、`zcodex` bin、init/doctor、运行路径/数据兼容、Linux/Windows 干净安装冒烟；用户无需源码或构建。
- **P1：服务生命周期**：start/stop/restart/status/logs/open、进程身份、锁、健康、异常退出、后台日志；真实 Router/RCC/微信重启恢复。
- **P2：更新卸载与发布**：update/uninstall、跨平台辅助进程、版本/备份/恢复、GitHub Actions npm 发行、文档和验收。

如果源码依赖要求不同顺序，先说明再调整。每阶段必须独立测试、明确未验证事项。

## 10. 验收标准

1. 干净 Linux x64/arm64 和 Windows x64 环境，在符合 engines 的 Node 下，从 **实际 npm tarball** 安装成功，不拉取源码、不执行前端构建。
2. `zcodex --help/--version/init/doctor/start/status/logs -f/open/stop/restart` 行为与文档一致；非交互模式和退出码可测。
3. 连续两次 `start` 不产生两个服务；陈旧 PID、PID 复用、端口占用、并发操作均安全失败或正确恢复。
4. 启动后 Web 可登录；已有 Codex CLI 可连接；专用 Router 的依赖检查和可用性准确；RCC、PSM、微信 iLink 在受支持平台正常工作。
5. Worker 正在运行/等待审批时停止工作台，重启后恢复待办与队列，不重复派发；明确记录 Worker 本身是否继续执行。
6. `update --check` 只检查应用版本；更新不会升级 Codex CLI；更新后用户配置、PSM、RCC、微信绑定及凭据保留。
7. 更新中断、npm 失败、健康检查失败和 schema 变化均有明确恢复行为；不可逆升级前有备份与提示。
8. `uninstall` 默认保留数据；`--purge` 二次确认且绝不删除用户项目、Codex Home 或其他实例。
9. 默认仅 loopback，认证正常；日志、status、doctor、安装输出不泄露凭据。
10. 发布包不包含开发私密文件，版本、npm 包和 CLI 版本一致；相关单测、typecheck、build、pack、package-test、跨平台冒烟通过。

## 11. 交给 Codex 的执行要求

**本轮先只读审查并输出计划，不直接编码或发布 npm。** 逐一检查当前 `package.json`、`bin/codex-web-ui.mjs`、`server` 启停与关闭流程、状态目录、`scripts/test-package.mjs`、`scripts/prepare-router-codex.mjs`、`scripts/router-launcher.sh`、现有设置页版本管理及 Windows/Linux 兼容性。

请提交：①当前发行准备度与缺口；② npm 包名与 CLI 映射、是否存在命名占用；③ CLI 命令契约及错误码；④进程生命周期、锁、健康与安全关闭方案；⑤数据目录兼容与升级方案；⑥ Router 专用 App Server 打包可用性；⑦更新卸载辅助进程与失败恢复；⑧逐文件实施计划；⑨跨平台测试矩阵、发布 CI 方案；⑩风险与必须先验证的协议/平台假设。计划完成后等待确认。

**最终判断标准：用户只需安装 npm 包，之后用 `zcodex` 管理整个工作台；任何启停、更新或卸载都不应悄悄损坏已有工作、状态或凭据。**
