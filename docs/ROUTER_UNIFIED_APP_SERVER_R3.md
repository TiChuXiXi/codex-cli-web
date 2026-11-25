# UAS-R3　双官方运行时的认证、部署及正式迁移计划

2026-11-25 · Linux arm64 · Node 24.19.0 · 工作树基线 d904d30，含既有未提交改动。

**B 作为正式目标，模型连接首选官方原生路径。** 官方 0.172.0 在当前已登录的 ChatGPT 账号上，通过工作台测试客户端、私有 stdio 和临时 Thread 完成了流式回复和一次手动压缩。官方遥测记录到了成功的 WebSocket 请求。整个真实请求链路没有引入 zcodex 模型协议代理。0.170.0 还完成了压缩后跨 Turn 复述随机标记。可以进入适配器详细设计，现有生产 Router 继续使用 C，生产切换仍有下列放行条件。[真实账号记录](acceptance/uas-r3/chatgpt-live.json)

| 决策 | 本轮证据 | 到正式启用还差什么 |
|---|---|---|
| 原生认证和模型出口 | 当前登录复用成功；0.172.0 本地夹具证明官方客户端能轮换并使用新凭据，WebSocket 和 HTTP/SSE 均能完成回复、远端压缩协议和下一 Turn | 当前真实令牌离到期超过 24 小时。独立服务账号的首次登录、自然到期、刷新失败后的恢复及真实部署出站规则待验 |
| 原生工具约束 | 固定实际二进制、模型目录、配置和账户模式后，0.172.0 夹具中普通采样、预热、前台压缩及后续采样都发出已核验的 12 项工具 | 对云管理配置热更新、后台压缩、冷恢复及扩展注册全路径实施变更检测。无法证明所有可变输入已受控的配置组合不能登记为原生合格 |
| 强隔离 B | R2 的真实全权限 Worker 负测复跑通过。R3 补测在保留原 Worker 身份的情况下，控制和 Router 账号均无法读取 Worker 的私有历史标记 | 服务管理器、用户侧 Worker 桥接、项目工具降权、管理员凭证及跨账号迁移须在正式入口联测 |
| 轻量模型出口 | 仅校验出站请求并逐字节转发 SSE，正常流程转发 3 次；目录漂移时上游收到 0 次 | 仅有本地夹具签收。若某组合需要线上核验，再对该组合单独验收。保留 C，不开发完整 Responses 或 WebSocket 协议代理 |

## 1. 真实账号做了什么

用户明确授权使用当前账号、当前网络和环境。PATH 上的 CLI 为 0.170.0，原生账号类型为 `chatgpt`，实际使用官方内置 `openai` provider 和已有代理设置。成功的模型是当前环境配置的 `gpt-6.1-sol`。两个版本均新建 ephemeral Thread，cwd 为 `/`，不加载项目历史，不给模型执行项目工具。检查了活动 MCP 工具为空；当前 Home 的一份全局工具偏好按内容摘要核对。请求的业务内容仅为随机测试标记。没有执行登录、登出或强制刷新。观测客户端只保留脱敏结果，账户、Thread、Turn、鉴权头和原始响应内容均未写入证据文件。

| 实际二进制 | 提交的模型操作 | 结果 |
|---|---:|---|
| 已安装 0.170.0，gpt-5.4 | 1 | 终态 failed，0 个文本增量。初版探针只保留终态，无法判定失败原因或推断账号无权使用此模型 |
| 已安装 0.170.0，gpt-6.1-sol | 3 | 收到 8 个增量并准确回复标记；手动压缩完成且收到 contextCompaction；下一 Turn 收到 8 个增量并准确复述标记 |
| 官方候选 0.172.0，gpt-6.1-sol | 2 | 收到 8 个增量并准确回复标记；手动压缩终态 completed，有独立 contextCompaction 项完成通知 |
| 合计 | **6** | 两个成功运行的版本均从官方本机遥测读到成功的 WebSocket request。没有按每个压缩事件独立解密或抓包 |

目标版本直接执行官方平台包内原生文件。它与当前 CLI 共享账号、Home 原路径及宿主网络。为避免新版本升级用户原生 SQLite，候选进程只读访问现有文件，临时 SQLite、日志、CLI 辅助目录和 installation_id 工作副本可写。第一次只读启动在初始化前退出，共提交 0 次模型操作。定位出需要可写的辅助路径后重新启动成功。进程结束后删除这些临时文件。0.170.0 在现有环境正常启动，原生 CLI 可以维护自身缓存；本轮未操作工作台生产库、微信或共享 daemon。[实测摘要](acceptance/uas-r3/chatgpt-live.json) · [显式开启的真实账号探针](../scripts/test-uas-r3-account.mjs)

**证据的限度。** 真实压缩的直接观察是官方前台 compact RPC、完成通知和终态；0.170.0 还验证了压缩后上下文可用。固定版源码为内置 OpenAI provider 选择 remote compaction V2。线上的压缩请求体未被 zcodex 检视。夹具中则实际收到 `compaction_trigger`，返回合成 compaction item，再观察下一 Turn。真实 SSE 强制回退、后台自动压缩、真实提供方失败恢复、第三方 OpenAI-compatible 服务均未验收。真实账号在两个版本运行过，并不自动给任意其他模型、provider 或平台授予资格。[官方 provider 能力实现](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/model-provider/src/capabilities.rs) · [V2 压缩实现](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/compact_remote_v2.rs)

## 2. 为什么先用原生连接

**认证归属。** 正式适配器应使用官方 managed ChatGPT 身份。让官方进程处理登录、存储、令牌轮换和重连，控制层只消费账号种类、可用性及需重新认证的状态。需要登录时，在认证管理入口显式触发官方浏览器或设备码流程；后台服务应使用有权限的 Router 身份和可在服务重启后取用的私有凭据存储。登录链接或设备码只给发起操作的管理员。业务工具不开放账户、配置或任意 RPC。Worker 原有登录与 Home 留在原用户下。禁止把会轮换的同一份 refresh token 复制成两个独立写者；同一订阅用于两个独立登录时还需要检查授权、注销影响与云端历史可见性。[官方认证说明](https://developers.openai.com/codex/auth) · [App Server 认证接口](https://developers.openai.com/codex/app-server)

**实际工具集合的两个输入。** 固定 SHA-256 的 0.172.0 分别用 gpt-5.4 和真实账号选用的 gpt-6.1-sol 运行 7 个本地场景，共 14 组，网络命名空间只有 loopback，模型端、账号路由和令牌端均为测试夹具。使用生产的 `dynamicTools`、官方内置 provider、受限 Thread，配置静态 `model_catalog_json`。在正常场景，夹具观察到远端模型目录读取数为 0。测试端对完整出站 `tools` 的序列化内容计算 SHA-256，基线为 `5505003c7daf6ad808028ec906176ac4bc4210b69076b4644cd96efe20e46fad`。两个模型在受限配置下得到相同工具指纹；gpt-6.1-sol 使用与同版真实账号探针一致的静态目录，目录文件 SHA-256 为 `b6cf79c149f3f4f6943634efbd0a8c17b47e9530bbeb30894c6293dd7e6d7b77`。正式报告还须绑定服务端定义、参数校验和授权逻辑。[gpt-5.4 请求和目录](acceptance/uas-r3/native.json) · [gpt-6.1-sol 同目录验证](acceptance/uas-r3/account-model.json)

| 同一官方二进制上的改变 | 实际结果 | 正式要求 |
|---|---|---|
| 固定受限目录；禁用图像生成、Shell、图像读取、子 Agent、hooks、plugins 等；保留 12 个 Router 函数 | WS 预热、普通 Turn、compact、下一 Turn 目录均为 12；HTTP/SSE 回退的三次请求亦为 12 | 模型 ID、目录内容、认证模式、provider、feature、实验开关、配置来源和工具定义全部纳入资格 |
| 仅在模型目录声明 `clock` | 请求出现 `clock/curr_time`、`clock/sleep`，共 14 项 | 控制面拥有只读静态目录及其全部父路径；拒绝未知模型、模型回退及未验证的运行时选模 |
| 保留受限目录，去掉 `features.image_generation=false` | ChatGPT 模式请求出现 `image_gen/imagegen`，共 13 项。未调用图像生成 | 受限策略显式关闭此项；自定义 provider 的夹具结果不能代替 managed ChatGPT 验证 |
| 模拟现有凭据，经 `account/read(refreshToken:true)` 请求刷新 | 官方客户端向本地 token 端点提交 refresh grant，保存轮换结果，并在后续模型连接使用新凭据和预期账号头 | 真实到期需另做观察；生产业务不得用强制刷新来探测资格 |
| 以已到期的合成 access token 启动，不请求强制刷新 | 两个模型均由官方逻辑刷新一次并保存新值。首次初始化遇到 application network permission was revoked；确认轮换已落盘后重新启动无业务状态的实验进程，原生读账号、WS 请求及流式回复成功 | 正式恢复要区分“初始化尚未成功”与“业务指令的接收结果不明”。仅前者可有界重启，后者走 RCC 对账 |
| 夹具逐段传输回复 | WS 和 SSE 均在上游结束前收到 `item/agentMessage/delta`；HTTP 场景由服务器明确拒绝 Upgrade 后触发原生回退 | 服务端消费官方流式事件，保持取消及断线语义 |

源代码中的静态模型管理器及按 ModelInfo 组装工具的代码与这两个目录对照相符。另检查了 `PreModelRequest`。该版本传给 hook 的有采样种类、模型及请求身份，其中没有完整工具目录；不能把此 hook 当作逐请求目录鉴权器。[静态模型管理器](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/models-manager/src/manager.rs) · [工具集合组装](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/tools/spec_plan.rs) · [采样 hook 实现](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/hook_runtime/sampling.rs)

**原生出口的放行范围。** 管理员保护的命名策略为每个模型固定元数据、设置和生产工具定义；只允许可信适配器创建及恢复 Router Thread。每一代连接核对实际可执行文件、有效配置、账号模式、模型目录、扩展和策略来源。禁止用户、项目或历史配置参与 Router 的模型、工具及出口选择。系统或云托管配置必须继续遵守，变动或无法读出时暂停接纳新回合，收束在途操作并重新资格验证。夹具中的账号设置请求返回缺省结果。尚需证明活跃回合中远端设置、可加载扩展、模型变更、恢复与后台压缩也无法使能力扩大；若无法在下一次采样前冻结或强制约束这些输入，单凭启动时检查不能放行该组合。RCC 中已提交的副作用保留原身份进行对账。

网络上优先让官方进程自己完成 TLS、OAuth 和 WebSocket，部署侧按目标限制出站，保留端到端 TLS；覆盖账号工作区发现、受管要求、登录与刷新、模型请求及压缩。允许的区域域名及企业代理随实际部署签收，重定向、DNS、IPv4/IPv6、私网和本地服务必须受出口策略约束。透明转发加密字节的连接器仅能提供目的地边界；它看不到 TLS 内的工具清单。官方 `application.network` 有按域名约束应用连接的协议定义，仍需在相应平台验证 HTTP、WebSocket、刷新与重定向路径，与 OS 出站和私有挂载一起验收。本轮真实账号走现有宿主网络，未在真实封闭网络内完成登录。[应用网络要求](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server-protocol/src/protocol/v2/application.rs) · [配置参考](https://developers.openai.com/codex/config-reference)

**轻量出口备选。** 若某组合必须逐请求检查，先限于已验证的 HTTP/SSE Responses。原型只接收固定 POST 路由、固定模型和已审工具指纹；对 zstd 请求同时限制压缩前后体积，校验后把原请求字节发往固定本地上游，响应由流管道原样转发。Upgrade 返回 426，由官方客户端处理回退。正向转发三次，夹具在上游未结束前等到了 App Server 的文本增量；漂移对照中，上游零次，入口实际拒绝了六次同类请求，说明 SDK 自带重试必须纳入失败预算。正式版还需涵盖允许的顶层字段、HTTP 状态、鉴权头和目的地、取消背压、错误、并发、后台压缩，以及认证信息在代理侧的保护。需要 WS 且不能采用原生约束的配置保留 C。没有引入完整协议代理的依据。[脚本](../scripts/test-uas-r3.mjs) · [轻量出口记录](acceptance/uas-r3/native.json)

## 3. 保留原 Worker 身份的部署方案

| 主体 | 持有和执行 | 需要验证的隔离 |
|---|---|---|
| 管理员/安装器 | 签收的官方原生文件、Node、zcodex 代码、运行时依赖、服务定义、静态策略和资格报告的信任根 | 检查真实路径及每级父目录、更新助手、npm shim、依赖查找路径、ACL/补充组。用户可写的 nvm 或 npm 前缀不能直接充当强隔离安装位置 |
| 原有 Worker 用户 | 继续使用原项目、CODEX_HOME、原生 Thread、CLI/Desktop 和现有 daemon；文件、Git、PTY、项目命令与 Worker 侧历史查询在此身份执行 | 控制层不读取整个用户 Home；由用户侧的窄接口交还已授权项目的历史或动作结果。daemon 按实际进程身份/传输核验。Worker 提供的数据和通知均按不可信输入处理 |
| zcodex 控制服务 | 独立非特权服务账号；私有状态、RCC、PSM、微信密钥、渠道游标、Web 会话和 Router 主指针 | 服务私有目录、IPC、日志、备份不可由 Worker 打开或修改。向用户侧桥接时校验项目和请求实例，桥接端验证控制服务身份。服务不继承管理员权限，不在项目内加载模块或执行脚本 |
| Router 官方进程 | 另一受限身份或经签收的等效 OS 权限域；私有 stdio、自己的 Home、官方凭据存储、空工作目录和经核验的模型出口 | 仅官方认证模块可使用 Router 凭据。模型没有通用文件、RPC 或网络工具；Router OS 视图排除 Worker、控制库、iLink 密钥和管理 socket；只写私有运行状态，目录与策略不可改写 |

**真实 OS 证据。** R3 在临时文件树先创建 Worker 用户私有历史标记，再引入另外两种有效 UID；账号均清空补充组。Worker 保持对原标记的读写，标记的 inode、属主、权限及内容摘要相同。三种身份只可读写各自的私有标记，均不能改写安装标记及其父目录。管理员预建 socket 后，Worker 身份持有监听 FD 并从已接入的控制客户端读取到正确的 SO_PEERCRED；Router 尝试连接被拒。另复跑 R2 B-uid，使用同一原生文件、真实 `dangerFullAccess` Worker 和原生审批，得到 1 个任务、1 条 Worker 历史，Router 结束时 0 份回执、Worker 结束后 1 份。R3 账号实测和分 UID 夹具在不同运行中完成，不能合并为“三个实际服务身份已在生产登录并闭环”的证据。[R3 宿主权限](acceptance/uas-r3/identity.json) · [R2 B-uid 本轮复测](acceptance/uas-r3/b-uid.json)

**两个部署等级。** 个人安装保持现有体验，`doctor` 明示“同账号 Worker 可以读取或改写控制状态”。在现有硬性要求下，个人同 UID + 全权限 Worker 不能开启 B 的强隔离标志，也不自动把 Worker 降权。C 可继续作为兼容入口；C 对同账号宿主文件也无保护。强隔离安装由管理员一次性准备受保护前缀、服务身份和服务管理器，日常启动、诊断和复验由普通用户完成。建议 `init` 生成可审阅的部署描述和缺项清单，安装和角色变更由明确管理操作执行。需要操作控制面的管理浏览器、管理员令牌和维护入口也须与 Worker 的进程、文件及浏览器凭据隔离；仅监听 localhost 或选择现有 network 免登录模式不能承担此边界。

当前开发宿主进程以 root 运行。可以保留无特权 Worker 的原 UID；若实际 Worker 就是宿主 root、具备 sudo 无密码或可操作特权容器接口，则普通服务 UID 无法阻止其读取控制面。该部署需另设受保护主机/虚拟机边界，或经用户批准变更 Worker 身份并验证历史与授权。不能把本机的真实 ChatGPT 测试签收为强隔离生产部署。一个共享高权限 Worker 账号下的不同项目也没有天然的宿主级相互隔离。

## 4. 正式适配器逐文件实施顺序

以下均为待审查的实施计划。正式入口应通过现有 RouterService 使用官方适配器；P1 Worker 兼容修复保留。

| 顺序及文件 | 改动和必须通过的入口回归 |
|---|---|
| 1　`server/config.js`、`server/router/launcher.js`、`server/lifecycle/{preflight,doctor,supervisor}.js`、既有平台启动器 | 登记 C / B 选择、应用/Worker/Router 身份、保护前缀和固定配置。运行前核对二进制句柄、ACL、有效身份、私有 IPC 与网络。实际同 UID、可写祖先、环境继承或权限变化均能触发拒绝。共享 daemon 不由复验作业管理 |
| 2　`server/bootstrap.js`、`server/services/{fs,git,terminal,workspace,skills}.js`、`server/codex/hub.js`、`server/codex/transport/` | 先解决降权执行。当前 TerminalService 启 shell，fs 服务能启项目命令，Git 也会启子进程。迁移服务 UID 前把这些操作及 Worker 侧元数据读取放在 Worker 身份；通过窄桥接复用现有服务，禁止任意控制侧命令、路径、环境变量或句柄透传。正式测试 PTY 自报 UID、项目读写和控制状态不可见 |
| 3　`server/router/app-server.js`、新增 `server/router/official-app-server.js`、`server/router/tools.js` | 保留原 C 策略握手；新增同接口的 B 适配器，只提供受控的 start/resume/turn/compact/read 操作。构造固定配置及工具定义，启动及恢复后核对资格、权限、模型身份和角色。分类器、RIP 与回执 Turn 也受策略覆盖；回执工具保持更紧的批次权限 |
| 4　`server/router/{store,service,register}.js`、`server/codex/hub.js` | 事务记录角色、运行时、Thread、连接代次；依连接/Thread/Turn/请求实例处理调用。对同 callId 不同参数、未知角色、Worker 冒用、过期通知失败关闭；无活动 Turn 不执行。验证断开时原生审批/用户输入不会交给下一代连接 |
| 5　`server/router/{dispatcher,wake,psm,psm-sync,psm-index,psm-migration}.js`、`server/channels/wechat/{channel,delivery,interactions}.js` | 在现有路径加角色判断；Router 和历史 Router 不可作派发目标或 PSM 来源；Router 终态不生成 Worker 回执。保持单个 Dispatcher、项目授权、RIP、待办与 iLink 的业务入口。验证恶意参数、授权变化、重复投递、丢 ACK、unknown 屏障及重启对账 |
| 6　`server/codex/worker-protocol.js`、`server/services/versions.js`、`bin/zcodex.mjs`、`web/src/page/VersionsPanel.tsx`、认证 RPC 路由及 shared 契约 | 提供下节的统一验证和版本状态。UI 测试版本错配、缺少权限、失败报告、恢复和重复点击；CLI 保留 verify-worker 兼容入口 |
| 7　`scripts/test-router-protocol.mjs`、`test/router-service.test.mjs`、`test/uas-state-copy.test.mjs`、平台安装/恢复测试 | 将研究断言迁移到产品正式入口。覆盖静态目录漂移、账号模式、云策略变更、注册/调用校验、原生 shell 禁用、压缩、恢复、角色隔离，以及授权后的真实手机闭环。每个平台分别从最终 tarball 验收 |

## 5. 统一资格、升级及发行体验

设计的 `zcodex verify` 默认识别已配置实例，分别显示 **PATH 候选**、**实际 Worker**、**实际 Router**、两者是否同一合格构建以及各自的能力。支持选择角色和传输；现有 `verify-worker` 的参数、退出语义和已有签收继续兼容。Linux 从经过端点/对端验证的进程身份取得 `/proc/PID/exe`，核对进程启动时间、运行文件及部署归属，不能只相信对端自报 PID 或 npm shim。Windows 用受信进程句柄、创建时间、原生映像和受保护路径做等效校验；做不到则报告未知。

登记键至少包含 OS/架构、原生文件摘要/来源、协议/探针版本、角色和 stdio/daemon；Router 另绑定工具定义与模型侧指纹、静态目录、认证模式、provider/模型、配置来源、适配器/策略摘要、隔离器及部署身份条件。Worker 单列 queue/steer、审批/输入、ACK 后中断及 unknown 的行为。报告中分开记录隔离夹具、安装权限、本机真实认证及平台验收。身份检查与登录状态要在本实例重检；不能通过导入另一台机器的 JSON 获得本机权限证明。发布签收由受信发布者验证来源；本机作业只允许服务控制的探针从真实结果登记。报告写私有目录、原子替换，保留资格失效原因和审计记录。拒绝从 Worker 可写目录直接激活任意报告。

安装/升级后先只读识别；完整命中则复用，策略或摘要有变化只验证缺失维度。未命中时允许管理员在 Web 版本页启动与 CLI 相同的隔离作业；根据角色、摘要和传输合并重复作业，仅接受预选的受保护原生文件。生成临时 Home、数据库、项目、本地模型夹具和独立 App Server。隔离不可用或失败时显示原因，可重验或选择已合格构建。PATH 已更新而 daemon 仍旧时分别显示两者，作业成功后下一代连接再次核实；不得擅自重启共享 daemon。未知 Router 不接新业务；Worker 无已验 queue/steer 时继续已有降级和 unknown 对账机制。不能在真实用户回合追加消息或依据成功的转发 ACK 自动重发。本轮重新执行现有 stdio verify-worker，通过 queue 和 steer。[Worker 行为报告](acceptance/uas-r3/worker.json)

NDC 新发行工作集中在官方程序来源、受保护安装、资格验证、隔离启动和干净环境 tarball。冻结新增定制 Rust 平台构建，保留已登记 C 资源与恢复路径。工作台 npm 包与官方 Codex 分别升级；管理员保护的前缀不能由普通 npm 生命周期脚本替换。最终包应在无编译链机器验证安装、升级、回滚和卸载保留数据。本轮仅更新发行设计和实施计划。[NDC 设计](NDC_ZCODEX_DESIGN.md) · [NDC 实施计划](NDC_ZCODEX_IMPLEMENTATION_PLAN.md)

## 6. 数据保护、切换和回退

1. **先盘点和备份。** 保留 Worker 系统身份、原 CODEX_HOME、Thread ID；核对 Router 当前与历史 ID、RCC 意图/副作用/unknown、PSM、RIP、项目授权、设置和渠道焦点。冻结新的 Router 工作，停在可审计边界；记录在途 Worker、审批实例、微信绑定代次、inbox/outbox、密钥及游标。SQLite 在线备份包含已提交 WAL。校验完整性、业务主键和加密凭据实际可解密，把备份放在 Worker 无法读取的位置。
2. **身份迁移先演练。** 在副本上保留密钥与绑定原值，验证跨 UID/SID 后服务可解密、可写 WAL、可获取排他锁，Worker 无权读或替换副本。旧明文备份、环境变量、父目录或管理员浏览器凭据仍暴露时，不能声称完成边界迁移。新身份无法解密、原生历史不可达或有外部活动写者时停止切换。微信重新扫码不能作为恢复策略。
3. **追加式切换。** 保留旧定制 Router 历史与启动入口，将旧 ID 标记为历史只读，可经原授权的历史查询访问。新建官方 Router Thread，经资格、授权、重启恢复验收后，事务切换主指针及连接代次。用迁移 ID 和唯一约束实现重复执行；指针切换前崩溃只回收未激活实例。新旧 Router 不得并行消费同一个业务队列。禁止修改官方内部历史文件；PSM 和 RCC 保留原 Worker ID。
4. **回退 C。** 先暂停新回合，收束 B，保留其已生成历史和真实投递事实，再原子恢复旧适配器/主指针并递增代次。对已提交的 Worker 指令只查队列和原生历史，unknown 按原规则阻塞。核对微信已发、已收和游标后才恢复消费。切换后有新事实时禁止整体覆盖旧快照；已失去原生实例的审批明确失效，不能代替用户作答。正式前需在副本演练双次迁移、各阶段断电及回退，再对现有测试绑定做真机签收。本轮只执行了现有 WAL 副本回归和一次性夹具。[既有副本测试](../test/uas-state-copy.test.mjs)

## 7. 平台放行和剩余阻塞

| 平台 | 当前证据 | 下一次放行条件 |
|---|---|---|
| Linux arm64 | 两版真实 ChatGPT；0.172.0 两个模型共 14 组本地请求实验；真实有效 UID、socket 对端、挂载及 R2 B-uid 复跑 | 在实际非 root 服务管理器和最终安装前缀联测，证明 Worker 身份保持、控制端不执行项目程序、真实网络策略内认证、刷新、配置变化和崩溃恢复 |
| Linux x64 | 本轮未运行 | 对该架构实际原生文件核验摘要、namespace、UID/组、只读安装、相同协议与真实认证 |
| WSL | 本轮未运行 | 按发行版和 WSL 版本分别测试；WSL2 服务身份、DrvFs/Windows 互操作、宿主凭据/进程/网络、daemon 并用及重启后隔离 |
| 原生 Windows | 本轮未运行 | 控制服务及 Router 服务 SID、独立配置文件/凭据库、Worker 原登录会话、ACL/管道/句柄继承、受限令牌、出站策略、Job Object、npm 更新锁及服务身份解密。跨 SID 的密钥迁移需单独演练 |

**进入正式迁移前的阻塞。** 已有真实登录的复用、原生 WebSocket 请求和前台压缩的基本可行性已取得证据。真实自然到期刷新、首次服务登录、后台压缩、有效配置更新过程、第三方 provider、正式 Worker 身份桥接与 Web 管理凭据隔离仍待验证。真实账号模型 gpt-6.1-sol 的同一静态目录也通过夹具对照；线上 TLS 载荷未观测。替换成正式模型目录、接入组织策略或改变服务身份后，仍须按完整资格键复验。现有绑定的微信真机和跨账号数据切换也未验收。未满足某部署的必需条件时维持 C 并显示原因。

## 8. 复现与验收记录

Linux arm64 离线验证使用来自 `@openai/codex@0.172.0-linux-arm64` 的原生文件，SHA-256 为 `28c24ad7fb3bf29c95cd66a12e72d2219f06170efefae8b02002ceb50e2866b9`。本地实验需要 Node 24.19、已安装项目依赖、Linux namespace、iproute2 和切换测试 UID 的权限。账号探针独立于常规测试，必须显式提供授权标志和原生文件或当前 CLI 的绝对路径；真实账号不作为升级后的自动探测步骤。

```sh
node scripts/test-uas-r3.mjs "$OFFICIAL_CODEX" gpt-5.4
node scripts/test-uas-r3.mjs "$OFFICIAL_CODEX" gpt-6.1-sol
python3 scripts/test-uas-r3-identity.py
node scripts/test-uas-r2.mjs "$OFFICIAL_CODEX" B-uid
node bin/zcodex.mjs verify-worker --codex "$OFFICIAL_CODEX" --transport stdio
TMPDIR=/var/tmp npm test
```

本轮 Node 测试 **307 通过、0 失败、0 跳过**。研究脚本、分 UID 测试、B-uid 及 verify-worker 的退出码均为 0；真实账号的失败尝试保留在单独记录。没有替换生产 Router、改动既有项目授权、迁移生产 SQLite、操作微信绑定或发布 npm。正式适配器、统一验证命令和 Web 按钮留待审查后实施。[运行清单](acceptance/uas-r3/run.json) · [真实账号探针](../scripts/test-uas-r3-account.mjs) · [UID 实验脚本](../scripts/test-uas-r3-identity.py)
