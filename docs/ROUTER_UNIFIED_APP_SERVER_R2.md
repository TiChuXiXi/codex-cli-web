# UAS-R2　官方 App Server 与可信控制层可行性

2026-11-25，feature/router，基线 d904d30 加本次会话开始时的工作树。

**推荐架构 B：两个官方 App Server 使用同一份受保护的官方可执行文件。** Router 使用工作台独占的私有 stdio、独立身份边界、文件视图和模型出口。Worker 继续通过 CodexHub 使用自己的连接。Linux arm64 的推荐依据是分账号和独立网络命名空间的 B-uid 实验。只把 Router 换成官方二进制、只隔离 Router 进程，均不足以获得该结果。

这是下一步正式设计的选择。现有部署继续运行 C。真实账号出口、生产安装权限、其他平台和数据切换尚需放行。若部署者无法隔离可执行全权限命令的 Worker 与控制层，应保留原架构并明确该部署的同账号风险；定制 Core 本身也不能保护同账号可改写的宿主文件。本轮改动限于研究脚本、报告和证据。

## 1. 哪条边界决定选择

| 对照 | 官方进程及连接 | 全权限 Worker 对私有合成标记的写权限 | PSM 收录 Router / Worker | 对架构的影响 |
|---|---|---|---|---|
| A | 一个官方 App Server，一个私有实验 Unix socket，两个逻辑客户端 | 有 | 是 / 是 | 共享端点的另一个客户端可读取 Router Thread；外置 Router cwd 也进入原有发现路径 |
| A-registry | 同 A，在 PSM 的列表、元数据、历史入口加 Worker 身份过滤 | 有 | 否 / 是 | 修复索引归属有效，宿主文件和共享端点的权限仍然存在 |
| B | 官方 Worker socket + 官方 Router 私有 stdio，Router 用 Bubblewrap | 有 | 否 / 是 | Router 看不见 Worker Home、socket 和工作台库；同账号高权限 Worker 对控制侧仍有写权限 |
| B-uid | 同 B，Worker 使用独立无特权 UID，Router 使用独立网络命名空间和固定模型出口 | 无 | 否 / 是 | 两边的隔离均有观察结果，Worker 的 dangerFullAccess、审批、用户输入和结果回执继续工作 |

写权限测量是实际 Worker 的原生命令对一次性 0600 标记进行权限检查。实验没有读取或改写真实控制数据。A 的 PSM 反例特意使用独立的、位于 Router 状态目录之外的 cwd；生产状态目录本身已有路径排除。这个反例说明 cwd 无法承担历史和当前角色登记。四次实验均只生成 1 个业务任务、1 条对应原生历史和 1 份 Worker 终态回执。[A](acceptance/uas-r2/A.json) · [A-registry](acceptance/uas-r2/A-registry.json) · [B](acceptance/uas-r2/B.json) · [B-uid](acceptance/uas-r2/B-uid.json)

## 2. 威胁模型和 R1 结论修订

控制代码、经认证并明确授权的管理操作、管理员管理的安装和已验证的官方运行时属于信任边界内。用户文本、历史、项目内容、PSM 证据、模型供应方产生的调用、普通 Web/微信请求、Worker 和 Worker 项目里的程序都需要约束。认证用户取得的是某个业务操作的权限；管理运行时配置和密钥需要独立授权。

R1 的第 13 个工具实验由**可信客户端**提交额外定义，夹具成功调用它。这证明注册端拥有授予能力的权力。R2 使用生产的 12 项定义和独立的策略摘要，只让可信适配器构造注册请求；随后让协议夹具在模型输出中提出未注册工具和注册工具调用。官方运行时返回拒绝，服务端调用记录中两者都是零次。此结果修正了把 Core 缺少项目名单直接等同于模型能够提权的推论。

冷恢复也需按主体分析。R1 的客户端有相同 CODEX_HOME 的访问权。R2 的受信客户端在恢复请求中明确设置 on-request 和 low，官方回包报告了相应值和 readOnly。故权限配置属于可信客户端可管理的状态。需要控制的是谁能接入、读到哪个 Home、代表哪个角色以及发送什么 RPC。另一个应用自称不同的 clientInfo.name 不能提供访问控制。[R1/R2 基线复测](acceptance/uas-r2/protocol-control.json) · [R2 恢复结果](acceptance/uas-r2/B-uid.json)

本轮没有把宿主 root 主动修改系统视作攻击。相反，若 Worker 命令天然继承控制服务的有效 UID、补充组、可写安装路径或管理套接字，这些是**部署赋予普通程序的权限**。Thread ID、提示词和 Node 内部鉴权均不能撤销它们。正式部署可保留现有账号作为 Worker 账号，将工作台状态和控制程序置于独立服务身份及管理员保护的安装目录，避免迁移 Worker 历史。等效的强制访问控制也可作为单独验收的方案。

## 3. 条件、方法和证据等级

本机 PATH 中的 CLI 是 0.170.0；核对 npm 官方 registry 时 latest 为 0.172.0。本轮使用官方 Linux arm64 平台包的原生文件，SHA-256 为 `28c24ad7fb3bf29c95cd66a12e72d2219f06170efefae8b02002ceb50e2866b9`。研究脚本先核摘要，使用私有 HOME、CODEX_HOME、临时项目、SQLite、模型端点和新 PID/网络命名空间。B-uid 为使测试 UID 可执行该文件，将文件一次性暂存为管理员拥有的可执行文件。Worker 执行它，Router 只读挂载同一个源文件；脚本核对 Worker 实际 exe 的设备号与 inode。无 Rust 构建、安装升级、共享生产 daemon 管理或真实账号操作。[运行清单](acceptance/uas-r2/run.json) · [研究脚本](../scripts/test-uas-r2.mjs)

- **真实官方协议与宿主实测**涵盖 CPU 上实际运行的官方程序、动态调用、工具结果回传、原生命令、Linux UID、文件与 socket 权限、namespace、真实 Hub、RouterService、RCC、PSM 和 SQLite。
- **本地模型夹具**提供确定的 Responses SSE 和故意越界的调用。分类器固定返回 work；实际选模质量、自然语言分类质量、真实供应方鉴权和全部流式事件类型均未验收。RIP 及微信沿用现有业务栈，本轮没有运行真实微信。
- **源码与协议定义**用于确定可配置入口。官方 ThreadStartParams 提供 config、sandbox、permissions、environments 和 dynamicTools；ThreadResumeParams 可接受新设置。官方配置定义有 skills.include_instructions、skills.bundled、hooks、plugins、mcp_servers 等。源码中存在字段不代表所有平台上都已经强制隔离。[固定版本 Thread 协议](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) · [固定版本配置定义](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/config.schema.json) · [官方 App Server 文档](https://developers.openai.com/codex/app-server)
- 另跑现有 `--uas` 和 `verify-worker` 以核对对照组。前者退出 2，符合 R1 要求提供定制策略的旧门槛；结构化结果记录了官方受限配置、11 类拒绝和受信客户端额外注册对照。后者针对 stdio 退出 0。R2 的业务派发实际使用隔离 Unix socket。已有 Worker 签收记录继续有效。[旧门槛输出](acceptance/uas-r2/protocol-control.json) · [Worker 复测](acceptance/uas-r2/worker-stdio.json)

## 4. 控制层放在哪里

**可信客户端 RPC。** 客户端能调用线程管理、历史、文件或配置等服务接口。研究适配器单独构造 start、resume 和 turn/start，业务读取接口仅接受两种读取方法和相应参数字段。测试拒绝了在读取请求中附加模型覆盖，以及用读取接口发送 settings/update。正式实现还应绑定连接代次、角色、目标 ID 和方法专属的字段值。调试用的裸 RPC 仅在研究脚本中使用，生产 Web、微信和模型工具都不能获得这样的透传入口。

**模型工具。** 模型接收运行时生成的目录和上下文。控制端用 production dynamicTools 生成定义，按所有定义内容核对，改名、增加工具或改变 additionalProperties 都不能通过原型注册入口。模型发出的调用仍须过 router/tools.js 的 validateTool 和 RouterService.onTool。实测发现，官方模型侧 schema 会省略部分字符串长度约束；输入长度、枚举、项目身份、授权、调用预算和副作用幂等仍由服务端强制。

**间接能力。** 一个合法的 get_session 或 get_task_status 可以把不可信历史带回模型。本轮让 Worker 回执包含夹具指令，确认其确实进入 Router 后续模型输入，再由夹具提出额外调用。未注册工具被拒绝，回执 Turn 试图 dispatch_task 也被现有批次权限拒绝。Worker 原始结果、授权数据和报告展示应分别实施出站过滤。合法工具产生后续动作时继续调用现有授权和 Dispatcher，禁止增加通用执行、任意路径读取或任意 RPC 参数。

**运行时升级与意外内置能力。** 离线二进制资格验证和运行时请求检查覆盖不同时间点。原型将本地 Responses 的模型出口置于可信侧，在交给模型前检查准确的 namespace、名称集合、函数类型及参数结构。对照线程由测试方显式打开官方 update_plan，实际生成的模型请求被拒绝，该 Turn 失败，额外转发请求数为 0。受控手动压缩允许空目录，后续普通 Turn 恢复完整核验。曾使用“每个请求都必须带 12 工具”的试验规则，压缩收到 403；分清受控压缩后四个场景均完成并通过下一轮核验。[漂移与压缩记录](acceptance/uas-r2/B-uid.json)

这个出口目前是本地 Responses 测试端点，限制请求体大小和路由。它没有实现生产的 ChatGPT 登录、WebSocket、远端压缩或任意供应方回包解析。模型输出的拒绝证据来自官方执行层及动态工具网关。出站目录核对发生在模型请求处，无法阻止请求之前执行的宿主 hook。正式方案必须同时控制可加载的配置、hooks、Skills、MCP、插件、网络和实际二进制；未受支持的 provider/路由应关闭官方 Router 入口。

## 5. 正向、负向及生命周期矩阵

| 场景 | 实验操作与结果 | 证据边界 |
|---|---|---|
| 三 Thread 并发 | 一个 Worker 使用 gpt-5.4、low、readOnly、on-request；另一个使用 gpt-6.2-sol、high、dangerFullAccess、never。二者的 cwd 不同。高权限 Worker 的回合保持活动，同时 Router 等待结束、目标 Worker 等待审批 | 四种配置均达成重叠。模型名与强度是实际协议设置，生成内容来自夹具 |
| 动态查询与派发 | 模型调用 list_projects 成功，通过真实 item/tool/call 执行 dispatch_task，RouterService 与现有 Dispatcher 提交队列；原 Worker 历史按任务 ID 计数为 1 | 端到端到达现有业务入口，没有第二套派发器 |
| 审批与输入 | 原生命令审批由 Router 待办按 dispatchId、instanceId 作答，同一 Worker Turn 的 requestUserInput 选择 One。Worker 回合完成后回执读取该批结果 | 真实协议、夹具操作待办；没有实际微信或 Desktop UI |
| 终态及结果 | Router 自己的转接回合结束时回执数为 0，目标 Worker 完成后为 1；不相关高权限 Worker 随后结束仍为 1。回执状态 delivered | 此处 delivered 指 Router 回执，不能解释为手机已收件 |
| 第 13 个工具 | 可信客户端额外注册为正向对照；注册原型拒绝增加定义和变更 schema。模型提出 fixture_extra、register_tool，官方两项都拒绝；网关实调次数为 0 | 原型使用生产定义；当前生产注册仍走原有 C |
| 参数、项目和角色 | list_projects 添加路径参数被拒；外部项目 Thread 读取失败、自读及向 Router 自派发失败。注入带 Worker threadId 的网关调用返回 outsideRouterTurn，过期网关返回 staleConnection | Thread 角色注入是服务端负测；未冒充桌面程序发起实际侵入 |
| 原生能力 | 受限 Router 对合法无害的 pwd 工具请求和将客户端 thread/read 当作模型工具的请求均拒绝；Worker 仍能走原生命令审批。R1 同版复测覆盖 PTY、apply_patch、图像读取、MCP 资源、子 Agent、提问与权限工具等 11 类拒绝 | 不包含枚举未知漏洞或任意间接执行的完整证明 |
| MCP | Worker 配置一个只返回标记的本地 stdio MCP，工具 marker 在 Worker 服务目录中。A 按线程禁用这个已知服务，状态列表仍有服务名，但工具目录没有 marker；B 的 Router Home 里没有该条目 | 服务器名称、模型目录和实际工具执行应分开测量；任意第三方 MCP 未签收 |
| Skills、hooks、插件、网页搜索 | Worker 请求里出现 Worker 私有 Skill 标记，Router 请求中没有。Router 关闭自动技能说明和 bundled skills，受限配置关闭 hooks/apps/plugins，禁用 web_search。普通回合目录只有 12 项 | Skill 标记有实测对照。未知插件、各种 hook 触发时机和系统级策略叠加未逐项动态覆盖 |
| 配置和恢复 | 独占适配器拒绝未授权 RPC 方法和额外覆盖字段。原连接关闭后重新建立连接，受信客户端以相同 Thread 恢复，官方接受管理员指定的新审批和努力程度。B 的冷恢复遇过 active writer，在明确拒绝后有界等待原写者释放 | 仅重试尚未被接受的 resume；业务请求不能据此重试。A 的重连保留原 daemon，B 重启私有进程 |
| 压缩、切换、漂移 | 同一 Thread 手动 compact 完成，下一 Turn 通过目录核对。新建替换 Thread 通过核对；启用额外内置工具的线程被出口隔离 | 这是协议层替换 Thread，未执行数据库主指针迁移。远端压缩与自动压缩路径待测 |
| PSM 与旧角色 | A 对照在外置 cwd 收录 Router；仅接受实验中明确创建的 Worker ID 后，Router 排除，Worker 正常收录。B 天然从独立 Worker Home 发现 | A 的研究名单为进程内数据；正式历史角色登记必须持久并处理重启 |
| 异常和重复交付 | 复测 Worker queue 与 Steer，连续补充 3 ACK/3 历史；审批等待中 ACK 后中断仍可为 0 补充历史。全量 Node 测试覆盖 unknown、重复入站、旧卡和恢复 | 沿用 RCC 的事务、幂等键、按 Worker 排序及有界对账。没有以切换通道或重放来修复丢 ACK |

四个场景的 JSON 包含逐次网关调用、原生权限、回执计数、PSM、生命周期和漂移结果。脚本的断言同时检查了与原任务关联的结果文本和应答身份。[单进程对照](acceptance/uas-r2/A.json) · [单进程角色过滤](acceptance/uas-r2/A-registry.json) · [普通双进程](acceptance/uas-r2/B.json) · [隔离双进程](acceptance/uas-r2/B-uid.json)

## 6. 外部客户端、网络和安装所有权

| 主体 | 已观察到的边界 | 产品含义 |
|---|---|---|
| 受信管理员 | 可在能访问的运行时恢复 Thread 并指定新的配置 | 作为显式管理操作审计；业务消息无此权限 |
| 拥有同一共享端点的客户端 | A 中第二客户端能正常 thread/read 读取 Router Thread 元数据。R1 的另一个活动写者被拒绝，冷恢复成功 | 写者互斥不能赋予角色保密性。单进程若改为工作台独占控制，应重新设计 CLI/Desktop 与原生会话并用体验 |
| 普通 Worker | B 的 Worker 端客户端通过自己的 Home 恢复 Router ID 被拒；独立 UID 的全权限 Worker 对控制侧标记也没有写权限 | 只分进程或只把 Router Home chmod 0700，在相同有效 UID 下不能建立反向保护 |
| 无关外部 UID | B-uid 中 UID 65533 连接受保护的实验 Worker socket 在握手前得到 EACCES；Router 使用私有 stdio | 服务账号、Worker 账号、其他用户要有不同的实际权限；不可把 IPC 暴露给未经授权的本地客户端 |
| Router 模型 | 独立挂载视图中，看不见 Worker Home、socket 和 router.sqlite。B-uid 的 Router 网络命名空间只含 lo，唯一设置的模型通道是固定目的的中继；中继进程及 Unix 路径位于 Router 视图外 | 正式安装要保护控制目录、应用代码、实际二进制和全部父目录，模型出口要与工作台管理端口隔离 |
| CLI/Desktop 用户 | 本轮跑的是实际协议客户端，未启动官方 Desktop 或交互式 CLI | B 可保留用户自己的 Worker daemon/Home 供原生客户端使用；私有 Router 不对它们暴露。原生 Worker 端点上的不同用户属于哪个信任域仍需部署者明确 |

同一高权限 Worker 账号下多个项目之间并不会凭空获得宿主级隔离。工作台的项目授权约束通过工作台发出的请求。若还要抵御一个项目中的全权限程序直接访问另一个项目的原生 Worker 资源，需要把这些项目分配到不同主机权限域。B-uid 没有证明单个共享 Worker daemon 能提供跨租户隔离。

## 7. 最小可信控制层及业务影响

1. **运行时和角色登记。** 复用 RouterStore 保存运行时身份、连接代次、Thread ID、当前/历史/内部 Router 标记和 Worker 来源，启动后先核验再接纳事件。以实际创建或可信历史归属登记 Worker，未知 ID 无副作用。列表分页、按 ID 读取、PSM 增量事件、子会话和归档历史都需要覆盖。
2. **注册与调用。** 复用 tools.js 的规范定义以及 service.js 对活跃回合、namespace、callId、参数、调用预算、项目与回执批次的校验。每次注册构造新定义。调用实例的原始参数摘要要参与重复请求核验，发生同 callId 不同内容时隔离并留审计；不能把以前的成功结果交给不同调用。
3. **可信 RPC 与事件分发。** Router 适配器只导出有固定参数构造器的方法。请求实例、回复和通知都绑定连接、Thread、Turn 和原始请求身份。带副作用的未知事件不走默认 Worker 路径。Web 和 iLink 仍通过认证业务入口；普通 Worker 沿用 Hub 的原生审批、输入和取消。
4. **交付和历史。** 服务端决定任务模式、焦点、权限、确认与原文；RCC 的持久意图、unknown 屏障、历史查证和回执去重原样复用。RIP 负责表达，不能扩大工具。PSM 只消费经过登记的 Worker。微信继续使用既有密钥、generation、cursor 和 in/out 事实。
5. **资格验证。** 将实测行为绑定到二进制摘要、平台、策略及配置摘要、传输、可用模型通道和隔离器。每次重连核对实际执行文件，工作台升级或配置变化重新资格验证。能力无法核实时进入可见的隔离状态，继续保留查询、核对与恢复入口。

## 8. 若批准 B，正式迁移的逐文件顺序

| 次序与文件 | 正式改造及放行条件 |
|---|---|
| 1　server/router/launcher.js、scripts/router-launcher.sh、server/config.js、server/lifecycle/doctor.js | 增加可选官方 Router 配置与平台探测，验证实际 UID/组、可改写父目录、文件 ACL、进程所有权、模型出口及私有 Home。守旧配置继续走已登记的定制启动器。先在真实部署形态证明 Worker 无法改写控制面 |
| 2　server/router/tools.js、app-server.js | 抽出可信定义和配置构造，新增经过资格验证的官方适配器，保留定制适配器。禁用原始 RPC 透传，实现真实账号模型目录、分类、RIP 上下文、压缩、恢复与流式错误处理。测试 provider 异常项、版本新增工具、配置层和 hook 启动阶段 |
| 3　server/router/store.js、server/codex/hub.js、transport/、server/router/service.js | 版本化角色登记，先恢复角色再分发事件。核对请求实例、回包归属、过期代次、断线中的审批和进程所有权。保留 Worker 原 ID；停止工作台只停止自有进程 |
| 4　server/router/dispatcher.js、wake.js、psm.js、psm-sync.js、psm-migration.js | 对所有候选、已知 ID 和派生索引统一检查角色。将本轮成功的“Router 完成零 Worker 回执”“一条历史一份回执”“历史 Router 不进 PSM”变为正常入口回归。对在途任务跨重启测试 |
| 5　server/bootstrap.js、channels/wechat/、shared/、Web 设置与版本页面 | 双渠道恢复同一主指针与各自焦点，显示资格状态及恢复原因。经授权使用已有测试绑定完成手机任务、补充、审批、输入与重启收件。不改变 RIP 或现有授权流程 |
| 6　bin/zcodex.mjs、server/lifecycle/、package.json、安装与版本文档 | 包管理分别诊断官方安装、运行中的 Worker、Router 隔离器和报告。最终 tarball 在无源码/构建工具的环境验收。正式支持期内保留 prepare-router-codex、旧启动器和恢复说明；待迁移、平台与真机签收后再定清理计划 |

**数据保护与回退。** 优先保留 Worker 的现有 OS 身份、Home 和授权。用服务端 API 维护“旧定制 Router 只读历史 + 新官方 Router Thread”，保留旧指针及原始历史。切换前冻结新工作、收束 Router、盘点 Worker 在途、unknown、审批、PSM 同步、微信 inbox/outbox 与游标。在副本上以 SQLite 在线备份覆盖已提交 WAL，连同配置、PSM、密钥和历史验证完整性、解密、行数与业务身份，重复迁移并注入各阶段故障。先准备和验收新 Thread，再事务切主指针，维护模式核对后恢复。出现新外部投递或消息后保留新事实做对账，禁止用旧快照覆盖它们。无法安全恢复的原生审批实例明确失效。本轮只使用新建夹具，R1 的数据库副本演练不能代替 B 的迁移验收。[R1 数据保护方案](ROUTER_UNIFIED_APP_SERVER_PLAN.md)

## 9. 平台、发行体验和剩余门槛

| 环境 | 验证状态与下一门槛 |
|---|---|
| Linux arm64 | B-uid 的官方协议、同一可执行文件、真实分 UID、私有挂载/网络及本地 Responses 模型出口已实测。需在目标发行包和服务管理器下验证最小权限、认证、升级换档和崩溃回收；实验需要特权来建立 namespace 和测试 UID，不能据此要求工作台长期以 root 运行 |
| Linux x64 | 未执行。需该架构二进制摘要、Bubblewrap/namespace 功能探测、同一全链路和最终 tarball |
| WSL | 未执行。需在具体 WSL2 发行版验证命名空间、挂载、Windows 互操作、宿主路径/凭据与网络可见性。WSL 与原生 Windows 分别签收 |
| 原生 Windows | 未执行。官方二进制可减少定制 Rust 构建；独立服务身份、状态与安装 ACL、进程及命名管道访问、受限令牌和网络出口仍需 Windows 原生方案和负向实测。普通同用户子进程不足以承担 B-uid 的边界 |

**verify-worker 的演进建议。** 保留现有版本、架构、实际运行二进制 SHA-256、传输和隔离行为报告。安装后可先做只读诊断，分别显示 PATH 的 CLI 和连接中 daemon 的版本与身份；命中已有合格记录即可使用。新构建可提供认证管理入口发起一个隔离作业，预选实际传输和可信可执行文件，按摘要/传输合并重复作业，成功后原子登记管理员私有报告并在下一代连接重新核验。Web 可显示 queue、steer 各自状态、失败原因和恢复入口。新作业不能向真实项目发送探测，不得唤起生产 daemon 来测试。只通过 queue 时继续已有延迟策略，unknown 继续对账。以上是设计，本轮没有增加一键按钮或改动自动升级。

**正式放行尚缺的证据**包括：现有真实账号能否在受限模型出口下保持登录/令牌刷新、流式协议和供应方切换；外部 Desktop 与工作台同时操作和崩溃后的多写者恢复；系统级及项目配置叠加、hooks、插件、间接执行与非标准供应方返回的完整覆盖；持久登记和待办跨重启；目标平台 ACL；以及微信已有绑定的真机闭环。Linux 原型中的中继只承载本地 HTTP 夹具，出口校验目前会缓冲响应，不能作为正式流式转发器发布。若现有账号路径不能安全接入、或者平台无法保护安装与控制目录，该部署保留 C。上游若提供可验证的每 Thread 有效工具清单、不可放宽的角色权限上限，以及可绑定到调用主体的连接/恢复授权，可降低 B 的适配成本，也值得重新评估 A。

## 10. 复现与停止点

在有 Linux user/net/PID namespace、Bubblewrap、ip、nsenter 和 Python 3 的隔离测试机上，使用上述官方平台包中的原生文件。B-uid 还需建立独立 UID 的权限。脚本仅接受固定摘要。以下路径变量指向解包的原生文件。

```sh
node scripts/test-uas-r2.mjs "$R2_CODEX" A
node scripts/test-uas-r2.mjs "$R2_CODEX" A-registry
node scripts/test-uas-r2.mjs "$R2_CODEX" B
node scripts/test-uas-r2.mjs "$R2_CODEX" B-uid
node bin/zcodex.mjs verify-worker --codex "$R2_CODEX" --transport stdio
npm test
```

四种原型均退出 0。全量 Node 测试 307 项通过，失败和跳过均为 0。无前端或生产代码改动，本轮没有用构建、截图或上一轮真机结果代替上述协议验收。没有迁移状态、操作真实微信、提交、推送或发布 npm。本轮在研究报告处停止，正式迁移待审查。
