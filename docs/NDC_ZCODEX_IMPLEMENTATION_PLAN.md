# zcodex npm 正式发行与生命周期管理实施计划

本计划配合 [NDC 设计](NDC_ZCODEX_DESIGN.md) 使用。用户通过 npm 全局安装预构建的 Codex CLI Web，再用 `zcodex` 管理工作台。Codex CLI 由用户独立安装和登录。继续使用现有 Node 服务、Web、Router、Worker、RCC、PSM、微信 iLink 和 RIP，保留 `/codex-cli` RPC、SSE、认证、取消和队列语义。沿用仓库及 Web 产品名称。

首发目标为 Linux x64、Linux arm64 和纯原生 Windows x64。**Windows 的专用 Router 及其依赖功能必须通过原生验收，WSL 方案不计入。** macOS 暂不列入首发范围。部署不要求 Electron、Tauri、Docker、PM2 或开机自启。

## 2026-11-25 运行时发行目标修订

新开发以 B 为目标。每个平台资格记录绑定同一份受保护的官方 Codex 原生程序、角色、传输和部署身份。候选 tarball 保留已登记的 C 启动与恢复资源。冻结新增定制 Rust 平台构建和下载链。工作台升级、Codex 官方安装升级和管理员部署身份配置分别执行。现有 C 制品、此前单平台验收及其适用范围继续保留；下文涉及专用构建、LPAC 代理和 `router/capabilities` 的历史进度属于 C。B 的正式放行按 R3 的逐平台矩阵。统一 `verify` 和 Web 验证入口仍在设计阶段。[R3 资格、安装及回退方案](ROUTER_UNIFIED_APP_SERVER_R3.md)

## 2026-11-21 本地候选进度

Windows x64 已纳入首发。当前私有候选为 `zcodex@0.1.0-rc.1`，使用 npm 全局 shim 和独立前缀验证 Windows 原生、WSL/Linux x64 及 Linux arm64 的安装、后台启停、更新、恢复和卸载。Linux arm64 同版复验通过浏览器和真实 Worker，专用 Router 通过策略 v2 检查，真实回合及升级后的主线程恢复仍待模型出口可用后复验。公开发布前还需从干净机器验证签名 Router 制品和安装链。实测范围见[生命周期验收记录](acceptance/ndc-lifecycle.md)。

## 1. 发行准备度与包名（规划时基线）

- 2026-11-20 查询公共 npm registry，`zcodex` 和备用候选 `@tichuxixi/zcodex` 都返回 HTTP 404。首选 `zcodex`，进入发布审批前复查。若无法取得无 scope 名称，发行账号须先确认备用 scope 的公开发布权限。两种包名均映射到 `zcodex`。404 只说明查询时无可见公开包，名称保留与发布权限须由维护者核实。[公共 registry 查询](https://registry.npmjs.org/zcodex) · [npm 命名规则](https://docs.npmjs.com/package-name-guidelines/)
- 当前包为 `codex-cli-web@0.1.0`，`private: true`，Node 要求 `>=24.19.0`。现有 `prepack` 构建前端，允许清单包含主要运行目录。`test:package` 从 tarball 安装到临时本地前缀，验证前台启动、Web 登录、PTY 与 `SIGTERM`。正式发行还需验证全局 shim、原生 Windows、专用 Router 和自更新。
- `bin/codex-web-ui.mjs` 已加载配置并调用 `bootstrap()`，以信号触发关闭，入口有 5 秒硬退出期限。`/healthz` 只提供存活信息。关闭时并行停止 Router 和 Hub，Router 派发器仍需借助 Hub 完成收束，须调整并验证停机顺序。
- Router 准备脚本覆盖上游 `rust-v0.169.1` 源码。现有 tarball 包含脚本，但缺少可运行制品。Linux 启动器依赖 `nsenter`、Bubblewrap 和独立网络命名空间。Windows 还需验证原生 Codex npm shim、daemon 发现，并替换 PTY 的 `/bin/bash` 假设。设置页的版本任务操作 `@openai/codex` 及其 daemon，工作台自更新使用独立入口。

## 2. CLI 契约

`--config <file>` 与 `--state-dir <dir>` 复用现有配置解析。v1 每个用户的每个 npm 全局安装前缀管理一个实例，实例标识绑定规范化后的状态目录。可以选用既有目录。切换目录须在旧实例停止后显式重新绑定，其他命令遇到定位不一致时报冲突。前台源码入口和既有 systemd 实例仍由原方式管理。

| 命令 | 行为 |
|---|---|
| `--help` / `--version` | 无需初始化。输出用法或 npm 包版本。 |
| `init` | 幂等创建实例记录和缺失配置，默认 `127.0.0.1:8787`、token 认证。TTY 可确认配置，`--non-interactive` 采用显式参数和默认值。检查目录、端口及依赖，保留既有文件。`--prepare-router` 显式校验并登记预构建组件，支持本地资产。 |
| `start` | 后台启动，验证实例身份与 Web 就绪，返回 PID、实际地址和依赖状态。健康实例重复启动返回成功。已配置 Router 验证失败时返回非零，分别报告 Web 和 Router 状态。 |
| `stop [--force] [--yes]` | 停止已验证的本实例。已停止时返回成功。默认等待 30 秒，超时报告真实状态。`--force` 只在等待超时后作用于能以 OS 句柄确认的自有进程。若停止可能中断私有 stdio Worker，则要求确认，非交互须显式 `--yes`。 |
| `restart [--yes]` | 在同一操作锁内按原启动定位停旧启新。停机失败时结束操作，新实例须重新通过就绪检查。 |
| `status [--json]` | 输出 CLI/服务版本、运行状态、PID、实际地址、健康、状态目录、日志路径及 Worker/Router 摘要。区分停止、启动中、运行、降级、关闭中、冲突及身份待确认。 |
| `logs [-f] [--lines N]` | 默认最近 100 行。轮转后继续跟随，服务停止后仍可查阅。 |
| `doctor [--json]` | 只读检查 Node、平台、Codex 路径与版本、登录、Worker 传输、Router 策略与隔离、权限、端口、健康和可选 PTY。探针无法确认时给出原因与修复入口。 |
| `verify`（B 计划） | 复用当前身份的只读诊断，分角色匹配实际二进制与资格；缺失项可运行隔离验证。既有 `verify-worker` 继续有效。 |
| `open` | 打开已验证的本机 Web 地址。SSH、无 GUI 或打开失败时打印地址。URL 不携带凭据，文档说明如何安全读取首次登录凭据。 |
| `update [--check] [--yes]` | `--check` 只查询工作台稳定 `latest`。实际升级锁定精确版本，同步返回结果，恢复升级前的运行或停止状态。Codex CLI、daemon 和独立 Router 组件沿用当前版本。 |
| `uninstall [--purge] [--yes]` | 优雅停止后卸载当前前缀的包，默认保留数据。`--purge` 展示逐项清单并要求两次确认，非交互须同时提供 `--yes --confirm-purge <实例ID>`。 |

退出码固定为 `0` 成功或幂等完成，`1` 操作失败，`2` 用法或配置错误，`3` 必需依赖缺失或已启用组件降级，`4` 锁、端口、身份或归属冲突，`5` 超时，`6` 安全条件不满足或确认被拒，`7` 升级或卸载需要恢复，`130` 用户中断。查询到已停止状态时 `status` 返回 `0`。结构化输出提供稳定的 `code` 字段，详细诊断写 stderr。

## 3. 逐文件实施计划

| 阶段 | 文件 | 实施内容 |
|---|---|---|
| P0 | `package.json`、`package-lock.json`、`scripts/build.mjs` | 添加 `zcodex` bin，保留 `codex-web-ui` 前台兼容入口和 `npm start`。同步候选名称、锁文件、许可证和允许清单，审计包来源和可选原生依赖。构建期生成 Web 资产。包版本驱动 CLI、服务握手和 Web 版本，前端 build ID 独立保留。开发清单保留 `private: true`，发行 CI 在临时副本显式生成可发布清单。 |
| P0 | `bin/zcodex.mjs`、`bin/codex-web-ui.mjs`、`server/config.js`、新增 `server/lifecycle/` | 实现帮助、版本、`init`、`doctor`，共用配置解析、凭据路径和启动器登记逻辑。安装目录只读。原入口继续用于源码部署和前台诊断。 |
| P0 | `scripts/test-package.mjs`、`scripts/prepare-router-codex.mjs`、`scripts/router-launcher.sh` | B 用干净前缀分别验证官方原生文件、受保护的安装和平台隔离器，记录摘要、来源与许可证。对已有 C 资产执行恢复冒烟。 |
| P1 | `server/lifecycle/`、`server/bootstrap.js`、`server/logger.js` | 完成后台监督、锁、私有控制通道、健康及就绪、启停、浏览器打开、日志脱敏和轮转。复用 `bootstrap()` 与 `/healthz`。 |
| P1 | `server/router/app-server.js`、`server/router/service.js`、`server/router/dispatcher.js`、`server/channels/wechat/channel.js` | 复用 Router stdio 和能力协商，接入原生 Windows 启动器。收束 Router 回合、RCC、PSM 和微信任务后关闭数据库。覆盖重启对账、审批恢复与结果不明场景。 |
| P1 | 新增 `native/windows/`，修改 `server/codex/transport/index.js`、`server/codex/transport/stdio.js`、`server/services/terminal.js` | 验证 Windows 服务隔离、自有进程监督及官方原生模型连接。验证 Codex `.exe`、npm shim、daemon 及 stdio。PTY 使用 Windows 原生 shell。 |
| P2 | 新增 `server/lifecycle/maintenance.mjs`，修改 `server/router/store.js`、`server/router/psm-index.js`、`web/src/page/VersionsPanel.tsx` | 实现包外更新卸载助手、恢复记录、SQLite 版本预检与备份。设置页标明原操作面向 Codex CLI，展示工作台版本并提示使用 `zcodex update --check`。 |
| P0–P2 | `.github/workflows/npm-release.yml`、`README.md`、`docs/ROUTER.md`、`docs/ACCEPTANCE.md`、`docs/DEVIATIONS.md`、`THIRD_PARTY_NOTICES.md` | 编写候选构建与审批流程、Bash/PowerShell 安装说明、运行依赖、状态接管、备份恢复及分平台验证结果。保留上游许可证和 notices。 |

P0 以三平台干净环境安装候选包并启动前台服务为验收点。P1 以三平台后台生命周期和专用 Router 闭环为验收点。P2 以自更新、自卸载、故障恢复和待审批发行制品为验收点。

## 4. 进程、Router 与数据安全

### 进程身份、锁和就绪

使用两个 SQLite 锁文件，分别保护安装前缀的变更操作和状态目录的服务存活权。进程退出后由 OS 释放锁。后台监督进程通过 Unix socket 或当前 Windows 用户私有的命名管道接受控制请求。私有实例记录包含随机启动标识、PID、OS 创建标记、Node 和入口路径、规范化配置与状态目录、包版本及实际监听地址。控制握手核对实例标识、随机 challenge 和进程身份，再探测该实例的 `/healthz`。`--port 0` 返回实际绑定地址。未经验证的监听者、旧版前台进程和 systemd 服务由原管理者先停机。取得相应锁且确认实例退出后才清理陈旧记录。

Linux 使用 detached 启动、重定向 stdio 和 `unref`，强制结束使用校验过的 `pidfd`。Windows 使用独立进程、原生进程句柄和 Job Object 回收工作台自有子进程。无法可信获取句柄时，`--force` 返回冲突。日志写入状态目录，单文件 10 MiB，保留最近五个归档。写入前过滤 token、cookie、微信凭据和原始子进程敏感输出，`logs -f` 在轮转后重新定位。

### 优雅停机与恢复

先停止接收新请求、微信入站和新派发。Hub 保持连接，供正在处理的 RCC 和微信任务收束并落库。无法确认提交或发送结果时沿用 `unknown` 和恢复对账。随后关闭 PSM、SQLite、订阅、Hub 自有连接与端口。外部 daemon Worker 只断开工作台连接。私有 stdio Worker 和专用 Router 子进程由本实例回收。实测分别记录 Worker 执行、等待审批、微信重复投递及异常退出后的恢复结果。

### 专用 Router 发行与原生 Windows 隔离

B 的 tarball 提供工作台、资格验证入口及经过签收的平台启动资源。部署时解析独立安装的官方 Codex 原生文件，核验来源、祖先目录权限和实际运行摘要。官方升级后重新匹配 Router 与 Worker 两份行为记录。迁移期 `zcodex init --prepare-router` 继续支持登记已有 C 制品用于恢复。

Windows B 要求验证服务 SID、受限 Router、Worker 原账号、私有管道、进程树回收和经授权的原生模型出口。Linux B 要求验证服务身份、挂载、进程及出口。平台可采取不同机制，须分别证明实际边界。C 保持原有启动器和策略握手。原生 Windows 的 B 验收继续作为该平台正式发行门槛。[Windows LPAC](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)

### 数据目录和配置兼容

沿用 `CLI > CODEX_WEB_* > JSON > 默认值`、现有便携配置规则，以及 `$XDG_STATE_HOME/codex-cli-web` 和 `~/.local/state/codex-cli-web` 默认路径解析。Windows 也保留当前路径解析。既有状态目录原地使用。修补 Router 登记只在特定便携配置下加载的缺口，显式 Router JSON 优先。Unix 使用私有权限位，Windows 验证当前用户 ACL。

升级和普通卸载保留 SQLite、RCC/PSM、配置、微信绑定及加密密钥、凭据、日志和 Router 独立状态。`--purge` 仅处理本实例拥有且在清单列出的工作台数据，拒绝符号链接、junction、归属冲突和路径越界。外部配置、用户与 Router 的 Codex Home、项目和其他实例受保护。

### 更新、卸载与失败恢复

包外助手置于当前用户私有目录，按已验证的 npm 全局前缀、包名及精确版本操作，沿用对应 registry、scope 和代理。先检查权限、目标 Node engines、目标与已安装 Router 的兼容性，缓存并验证新旧 tarball，再停机。使用 Windows 实际 npm shim 验证 CLI 能释放安装目录句柄、等待助手并收到最终退出码。遇到占用有限次重试。启动参数和必要环境走私有通道。凭据不得进入参数、操作日志或恢复记录。

升级和卸载在锁内复核在途工作。活跃 Router 回合、正在提交的 RCC/微信操作或活跃私有 Worker 未到安全点时退出。外部 Worker 继续执行、等待审批或已落库 `unknown` 时输出摘要并要求确认。停机后只读检查 SQLite `user_version`，当前 Router 库为 v4、PSM 索引为 v1。涉及 schema 变化时制作包含 WAL 已提交数据的一致备份，在副本上验证迁移和完整性。

以持久操作记录推进替换、验证及恢复。新版本在维护模式验证 Web、数据库与 Router，通过后恢复派发及微信收发。恢复外部副作用前失败时装回旧包并按需恢复一致快照。恢复派发或发件后出错时保留新数据及操作记录，按兼容性进入人工恢复，避免覆盖新数据或重复发送。卸载成功后才执行已确认的 purge，部分失败由独立助手报告剩余项目与恢复命令。

## 5. 测试、发布与风险

| 环境 | 验收范围 |
|---|---|
| Linux x64、Linux arm64 | 分别从最终 tarball 全局安装，验证 CLI、Web 登录、Worker daemon/stdio、PTY、真实 Linux Router 启动器与隔离、RCC/PSM/微信恢复、升级和卸载。 |
| 原生 Windows x64 | 在无 WSL 环境通过 PowerShell 和 `cmd.exe` 验证真实 npm shim，覆盖空格与中文路径、浏览器打开、Windows PTY、原生 Codex 传输、受限令牌/出站策略/Job Object、文件占用、自更新和自卸载。专用 Router、RCC、PSM、微信及 RIP 须通过闭环。 |
| 三平台故障矩阵 | 并发启停、PID 复用、陈旧状态、伪健康响应、端口占用、启动或停机中崩溃、孤儿子进程、轮转与脱敏。验证运行中与已停机升级、npm 权限及网络/代理异常、替换中断、schema 不兼容、健康失败、备份恢复、purge 路径保护和缺少可选 PTY 时的降级。 |

**真实 tarball 安装。** CI 执行 typecheck、单测、build、相关浏览器测试、`npm pack --dry-run`、`npm pack` 与 `test:package`。消费环境只接收最终 tarball、Node/npm、隔离的全局前缀和测试夹具。通过 `npm install -g <tarball>` 检查实际 shim、Web 静态资源、B 的官方运行时资格和 C 的已登记恢复制品，无需仓库、开发依赖、前端或 Rust 构建工具。常规测试使用临时目录、隔离 registry 和协议夹具。真实模型、独立 Codex 账号及微信真机通过显式 live 开关与专用目标验收。

**版本与审批。** 首个候选 `0.1.0-rc.1` 对应 Git tag `v0.1.0-rc.1` 与 npm `next`。稳定候选从 `v0.1.0` 构建并重新验证，发布候选附包内容清单、SHA-512 和跨平台验收记录。审批 job 提交同一制品。首次包名领取由维护者授权操作，后续采用 npm OIDC、stage-only 权限、受保护环境、维护者 2FA 审批与 provenance。发行故障可将 `latest` 指回已有且受支持的稳定制品，schema 变化需同时提供兼容及恢复说明。[npm staged publishing](https://docs.npmjs.com/staged-publishing/) · [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

**正式发行门槛。** 实测原生 Windows Router 的身份与访问边界、已签收的模型出口、Worker daemon 传输和异常退出后的进程树回收。验证 Windows 原生 npm shim 的替换文件占用与退出码、Linux arm64 运行时 ABI、RCC/微信停机顺序及重新对账、旧 SQLite 数据和未知回执恢复。验收记录逐平台标注结果，单列未执行的真实账号、版本写操作和完整视觉矩阵。任何必验平台未通过时保持候选状态。

实施按 P0 → P1 → P2 推进，各阶段独立验收。计划入库与推送仅记录实施方案，npm 发行须另行经过发布审批。
