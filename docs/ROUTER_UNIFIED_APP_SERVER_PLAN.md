# UAS 实施决定与验收记录

2026-11-25，feature/router，基线 d904d30。**本轮选择过渡架构 C。** 官方 Worker 升级后的派发兼容可以独立交付。A 和 B 的 Router 权限验收均未放行，继续保留定制 Router、原启动器及主会话恢复入口。工作区开始时唯一的未跟踪文件是用户提供的设计文档。

## P0 环境与依据

本机 Linux arm64、Node 24.19.0。默认命令为 `/root/.nvm/versions/node/v24.19.0/bin/codex`，报告 codex-cli 0.170.0。另从官方 npm 注册表取 `@openai/codex@0.172.0-linux-arm64`，仅将平台二进制解包到临时目录。两个版本均启动真实 App Server。每次使用临时 HOME、CODEX_HOME、cwd、SQLite、只开放 lo 的网络命名空间和本地 Responses 夹具。探针按场景重启自己的子进程，daemon 场景使用临时 Unix socket。实验没有读取部署中的认证文件或连接线上 daemon。

核对了 0.170.0 上游检出（29eb79e9866b3262a777fdf8195c1b9e63684c91）、0.172.0 标记的 ThreadStartParams/ThreadResumeParams，以及目标二进制生成的 experimental schema。thread/start 的 model、cwd、approvalPolicy、sandbox、permissions、config、environments、dynamicTools 有不同用途。检查到的公开启动参数中没有与本仓库定制策略等价的不可变精确工具集合。权限 profile、dynamicTools 和 selectedCapabilityRoots 各自不能证明该性质。0.170.0 的 initialize 实测返回 userAgent、codexHome、platformFamily、platformOs，没有返回 Worker RCC 方法的行为能力表。server/diagnostics 的进程 ID 可用于核对本地实际运行的二进制。参见[官方 0.172.0 Thread 定义](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)和[官方 diagnostics 定义](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server-protocol/src/protocol/v2/diagnostics.rs)。

对照当前实现，prepare-router-codex 注入 ToolPolicy 和 RPC 方法限制，app-server.js 检查启动器摘要、策略版本和准确名单，tools.js 的当前策略有 12 个工具，仍有较早策略的兼容检查。RCC 由 RouterStore 和 Dispatcher 管理，PSM 的派生索引、RIP 配置、共享待办及微信绑定另有既有存储。历史资料分别见 [Router 隔离](acceptance/router-a1.md)、[RCC 与真机](acceptance/rcc-unified.md)、[PSM](acceptance/psm.md)、[RIP](acceptance/router-rip.md) 和 [npm 生命周期](acceptance/ndc-lifecycle.md)。

## 决策证据

| 范围 | 实测观察 | 结论 |
|---|---|---|
| A · 单进程 3 Thread | 同时保持一个受限 Router 和两个 Worker 的模型请求未完成，三个输入标记各自只出现在自己的请求里。两个 Worker 分别返回不同 cwd、模型、high/low 和 workspaceWrite/readOnly，三个终态均按 threadId 和 turnId 命中。Router 仍只有其夹具工具 | 已验证该组合下的上下文与配置独立；高权限样本最高为 workspace-write |
| Router 工具与重启 | 注册的动态工具有 started、call、completed 和回传，错误参数由网关拒绝。冷恢复同一落盘 Thread 后重新调用成功。未落盘空 Thread 的冷恢复被拒绝。进程断开时旧的未应答调用没有重放 | 已实测，不能用它代替正向强制名单 |
| 内置工具 | 受限配置下的 11 类合成工具调用收到 unsupported/unknown 类错误，未触发客户端工具或审批，MCP 服务列表为空。只读沙箱对照在开启内置特性后仍向模型提供 shell、PTY、图像、子 Agent 等 | 已实测禁用样本；没有证明新内置工具、间接执行和所有未来配置都会被同一策略封锁 |
| 同 HOME 的其他客户端 | 第二个私有进程在活动写者持有 Thread 时收到 active writer 错误。原进程退出后，不同 clientInfo.name 的客户端成功恢复相同 Thread，sandbox 仍为 readOnly | 写者互斥与持久化起作用；Thread 身份独占及官方 CLI/Desktop 的不可变角色约束没有证据 |
| B · 独立官方进程和挂载 | Bubblewrap 中不能读取模拟 Worker 文件和工作台库，Worker socket 不可见，工作区和配置只读，私有状态可写。把生产 12 个动态工具和第 13 个只读夹具一起注册，额外工具进入模型目录，运行完成并收到结果 | 操作系统隔离有效，官方运行时没有在此配置下强制当前生产工具名单。对照还接受了通用 fs RPC。这是保留 C 的直接依据 |
| 队列 | 空线程接单、忙时拒绝强制启动、自动消费、精确删除和跨进程恢复通过。stdio 恢复后按旧队列 ID 启动；Unix socket 的 0.172.0 在 resume 时已自动消费，历史均仅有一条匹配消息。同一活动 Thread 中，相同 clientUserMessageId 连续 add 得到两个条目 | 已交接或 ACK 不明只对账。恢复时按原 ID 查队列及历史，不重新 add |
| Steer、审批与输入 | 0.172.0 运行中连续补充得到 3 个 ACK 和 3 条历史、1 个终态回执；审批和输入等待各 1 ACK、1 历史。审批等待中 ACK 后中断得到 1 ACK、0 补充历史、1 个中断回执。A 的提交挂起 30 秒时 B/C 先完成 | 私有 stdio 和临时 socket 的 Worker 链路实测。Router 目标选择与模型输出为夹具 |
| 仍未覆盖 | 极高权限 Worker、压缩及切换后的所有权限组合、任意间接执行、通向真实宿主服务的网络规则、CLI/Desktop 多客户端身份保证及共享生产 daemon 竞争 | A/B 均无上线依据。B 若增加可信代理，须单独证明各客户端路径均受其约束，并重新跑完整负向矩阵 |

原始脱敏输出见 [0.170.0 Router](acceptance/uas-router-0.170.0.json)、[0.172.0 Router](acceptance/uas-router-0.172.0.json) 和 [0.172.0 Worker 双传输](acceptance/uas-worker-0.172.0.json)。Router 探针退出 2 表示强制策略门槛未通过；详情中 onlyRouterTools 只表示受限初始清单，hostIsolation.inventory 另有 13 工具对照。模拟模型没有使用真实账号推理。

## P1 已实施

根因之一已从代码复核。旧 supportsQueue 对 0.169.1 放行，并与 supportsSteer 一样只另认 0.170.0 或特定传输的 0.171.0。对其他版本，submit 只写 error 后返回，任务始终 queued。用户部署中具体任务是否还受授权或 unknown 顺序屏障影响，没有线上证据。

| 文件 | 已完成的改动 |
|---|---|
| server/codex/worker-protocol.js、verified-worker-protocols.json、config.js | 使用维护者的隔离验证记录，核对版本、平台、架构、传输、运行中进程的 SHA-256。包含本机实测的 0.172.0 官方 Linux arm64 二进制，保留旧版本已验收能力。应用顶层 workerProtocolReport 可以安装其他构建的私有报告。显式报告不匹配时关闭对应派发能力 |
| server/codex/hub.js | 每次握手在进入 ready 前重新核验。只读 diagnostics 和 /proc 取实际运行文件，避免将 PATH 中的 CLI 当成已连接 daemon。断开清理能力状态 |
| server/router/dispatcher.js | 分别决定 queue 与 steer。队列单项通过可等待空闲再交接。尚未提交且无匹配证据时落明确失败与恢复说明。明确的方法缺失和无活动回合可安全处置，丢 ACK/超时仍进入原有 unknown。核对前后连接，避免将旧连接的验收用于新连接。历史查询、审批答复和已关联回合的中断继续使用各自原生接口 |
| scripts/test-router-protocol.mjs、test/fixtures/router-app-server.mjs | 增加并行 Thread、外部客户端、挂载内工具清单、重复队列 ID、队列单项、私有 Unix socket 和实际二进制证据。修复旧探针漏掉当前意图分类适配的问题，未修改产品分类逻辑。候选能力文件只存在于夹具目录，断言成功才输出报告 |
| bin/zcodex.mjs、package.json、server/lifecycle/supervisor.js | verify-worker 在实例初始化前即可运行，探针与依赖夹具进入 tarball。运行中 status/doctor 报告 Worker 实际版本、传输和能力来源。管理共享 daemon 的既有所有权规则继续生效 |
| test/router-service.test.mjs、test/worker-protocol.test.mjs、test/uas-state-copy.test.mjs | 覆盖未知版本、同一报告的单项能力、摘要/传输/版本不符及断线、无原生提交的明确失败和状态副本复开 |
| README.md、docs/ROUTER.md、docs/DEVIATIONS.md | 记录安装升级后的核验命令、人工安装报告、诊断及本轮架构差异 |

连接仅在运行平台支持取得被验收进程的实际摘要时采用新报告。Linux /proc 不可见、映射到不同 PID 命名空间或无读取权限时核验可能失败。历史版本记录属于既有兼容路径，没有追加未验证的 Windows/macOS 支持声明。尚没有官方的通用行为能力协商。新构建仍需跑隔离验收，不能仅凭方法名、版本号或报错格式推断跨重启和去重语义。

## P2–P5 的放行条件与逐文件实施顺序

| 阶段 | 文件及实施顺序 | 本轮状态 |
|---|---|---|
| P2 | hub.js、transport/ 先建立连接代次身份，store.js 增加持久角色登记，再由 app-server.js、service.js、tools.js 核验 Router 回合。dispatcher.js、wake.js、psm.js、psm-sync.js 排除当前及历史 Router 和内部 Thread；身份不明先隔离事件。最后才接入共享连接 | 安全门槛阻塞。现有专用进程继续隔离事件与工具 |
| P3 | store.js、psm-migration.js、service.js、bootstrap.js 在维护窗口做版本化预检、备份、准备新 Thread、核对后原子切换主指针。保留旧 CODEX_HOME 的只读查询及授权；Worker 历史沿用原 ID | C 直接沿用原库和主指针，未引入 UAS 数据迁移器。已做独立数据库副本演练 |
| P4 | channels/wechat/channel.js、delivery.js、interactions.js 核对同 generation、相同 cursor、in/out 与卡片身份。用同一已有测试绑定分别验证迁移前后手机收件、补充、审批、原生输入和重启恢复 | 真实测试绑定未授权。旧验收中 BBB-17、BBB-18、审批和水果题属于旧部署，不计入本轮 |
| P5 | config.js、bootstrap.js、bin/zcodex.mjs、lifecycle/ 保留认证和状态路径。P2–P4 签收后才调整 prepare-router-codex.mjs、router-launcher.sh 和发行清单。若选 B，保留必要的 OS 启动隔离 | 本轮仅交付兼容检查、诊断和配套 npm 文件；专用运行时仍需部署 |
| P6 | unit、Playwright、协议、tarball、原生平台和手机分别签收 | 见下表 |

### 数据迁移与回退

1. 目前 C 的应用更新没有新的 schema 或历史转换，重启沿用原配置、Worker CODEX_HOME、Router 主指针、router.sqlite、psm-index.sqlite 和 wechat.key。主机会话文件保留在其原位置。
2. 将来切换前，先从实际配置解析运行目录，记录运行时、schema、主指针、Worker 归属、授权和文件身份。暂停接纳新工作，收束 Router 及 iLink 出站，盘点在途 RCC、延迟回执、审批和原生输入。不能归属的外部 Worker 或结果不明的发送应延后切换。
3. 在静止状态备份配置、状态目录、密钥及历史，SQLite 使用在线 backup 包含已提交 WAL。验证完整性、关键行数、主指针、幂等键、加密绑定可解密、PSM 修订和历史可读。新 Thread 先在维护模式登记角色并验证工具策略，记录阶段、旧新指针和迁移版本，在事务中切换。恢复后先只读检查，再开启投递。
4. 副本测试用合成 v3 库和测试密钥，复制包含已提交数据的 SQLite 快照，执行现有 v3→v4 升级，两次打开保留 Worker ID、dispatch-key、单条 unknown 记录和同一暂停绑定的加密内容、代次、游标。模拟无外部副作用时恢复 v3 快照，integrity_check 为 ok。测试没有打开用户状态库，也没有物理迁移官方历史。
5. 切换后产生过原生投递或微信发送，回退程序需保留当前库和已产生的事实，按同一队列 ID、Turn、历史或渠道记录对账，必要时人工核对。过期的审批实例标记失效，恢复时重新读取原生当前请求。旧快照仅适合无新外部副作用的恢复窗口。

## 复现与本轮签收

部署者命令见 [Router 升级说明](ROUTER.md)。仓库内可执行：

```sh
CODEX_WEB_ROUTER_A1=1 CODEX_WEB_CODEX_PATH=/absolute/path/to/official-codex \
  CODEX_WEB_ROUTER_NATIVE_PATH=/absolute/path/to/native-codex node scripts/test-router-protocol.mjs --uas
node bin/zcodex.mjs verify-worker --codex /absolute/path/to/official-codex --transport stdio
node bin/zcodex.mjs verify-worker --codex /absolute/path/to/official-codex --transport daemon
npm test
npm run typecheck
npm run build
NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 npm run test:e2e
npm run test:package
```

| 环境或验收项 | 本轮结果 |
|---|---|
| Linux arm64 | 0.170.0 与 0.172.0 官方协议验证，0.172.0 实际 Worker 派发、双传输及软件包生命周期。原生 CLI 登录与真实模型未执行 |
| 自动化 | 307 项 Node 测试通过，0 失败、0 跳过；typecheck、build 通过。Playwright 默认 28 通过、1 视觉用例按开关跳过，启用 VISUAL 后该用例单独通过 |
| npm | 临时注册表与本地 tarball 验证安装、PTY、重启、升级、失败回退、普通卸载保留状态。另用 npm pack 生成 rc.1，从独立目录和空安装前缀离线全局安装，在仓库外直接用包内 verify-worker 对 0.172.0 运行 daemon --queue-only，退出 0；报告 queue=true、steer=false、历史匹配一次。未正式发布 |
| 原生 Windows x64 | 本轮未执行。缺原生平台和对应隔离验证器，Linux 的 /proc 证据不适用 |
| Linux x64 | 本轮未执行。不得套用 arm64 指纹或成功记录 |
| WSL | 本轮未执行。命名空间、网络及部署行为需在实际发行版核验 |
| 微信真实闭环 | 本轮未执行。没有指定可操作的真实测试账号、已有绑定及手机。合成绑定成功解密仅验证数据连续性 |
| 生产 | 未改生产配置、账号、密钥、历史、运行中服务或官方安装。未提交、推送或发布 |
