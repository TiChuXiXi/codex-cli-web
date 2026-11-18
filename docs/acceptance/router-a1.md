# Router A1 协议与隔离验证

2026-11-18，仓库基线 `24ca643a968a76fc10da45c147f39184733d1700`，本机 App Server `0.169.1`，Linux aarch64，Node `24.19.0`。

**本机离线门槛通过。已验证动态工具、正向七工具白名单、原子空闲启动、宿主挂载隔离及工作台适配器。真实账号与目标部署各自验收。**

## 环境和复现

使用目标 CLI 启动真实 stdio App Server。脚本创建只有 loopback 的 Linux 网络命名空间、单独的 PID 命名空间、临时工作目录和干净的 `HOME` / `CODEX_HOME`。App Server 的唯一模型端点为同一命名空间内的 Responses SSE 夹具。该夹具记录模型请求中的工具清单，以固定输出验证协议。基础实验与后续挂载隔离实验分别验证协议和宿主能力。

```sh
CODEX_WEB_ROUTER_A1=1 \
CODEX_WEB_CODEX_PATH="$(command -v codex)" \
node scripts/test-router-protocol.mjs
```

脚本要求 Linux 的 `unshare`、`ip` 和命名空间支持。退出码 `2` 表示基础实验已完成并输出结构化结果，仍缺少挂载或已编译策略的证据。断言或环境错误以失败退出。普通 `npm test` 只运行内存 JSON-RPC 夹具，无需目标二进制或命名空间。普通测试和浏览器的 MVP 结果见下文。

## 实测结果

| 项目 | 结果 |
|---|---|
| 实验 schema | 目标二进制生成的 schema 包含动态工具和原子队列字段。未声明 `experimentalApi` 的连接收到拒绝。重复工具名也被拒绝。 |
| 工具闭环 | `thread/start` 注册 `router_a1/lookup_fixture`。App Server 发出 started item、`item/tool/call` 和 completed item。原始 RPC ID 对应的 `inputText` 出现在下一次模型请求中。非法实参被测试网关拒绝，且错误回传给模型。 |
| 空线程与落盘 | `thread/start` 已分配 rollout 路径，文件尚不存在。首轮前查询回合历史被拒绝；重启后空线程不能恢复。完成首轮后，同一 thread ID、cwd 和动态工具在私有 stdio 进程重启后恢复。 |
| 断线 | 工具结果未返回时关闭私有 stdio 进程。冷恢复未重发旧 `callId`，同一线程可创建新回合并调用工具。重复 RPC ID 映射、基于 `callId` 的夹具去重、跨线程拒绝和迟到回复抑制由普通自动测试覆盖。共享 daemon 或存活服务器的重订阅语义待测。 |
| 工具可见性 | 受限配置下，初启、续轮、恢复和拒绝后的所有捕获请求合并只有 `router_a1/lookup_fixture`。同期的只读沙箱与空环境对照重新开启内置工具后，模型清单出现 `exec_command`、`write_stdin` 等工具。 |
| 执行层拒绝 | 模拟模型提出 11 个未注册工具名的空参数请求，App Server 均返回不支持，且未发出面向客户端的工具请求或审批。样本覆盖 shell、PTY、补丁、图像读取、MCP 资源、子代理、目标、交互提问和权限申请。线程级 `mcpServerStatus/list` 返回零个 MCP 服务。 |
| 原子空闲启动 | `thread/queue/add` 接受尚无首条用户消息的 Worker 线程，并在空闲时自动启动。Worker 忙时，`thread/queue/start` 返回 active/pending 错误并保留原队列条目。活动回合完成后自动启动独立新回合。 |
| 队列恢复 | 待发送条目及原队列 ID 跨私有 App Server 重启存在。仅 `thread/resume` 时条目仍保留；随后用 `thread/queue/start` 显式启动。历史中对应的 `clientUserMessageId` 恰好出现一次。 |

测试配置使用无 MCP 的私有配置、`environments: []`、只读沙箱、`approvalPolicy: never`，关闭 shell、Apps、插件、hooks、网页搜索、图片查看、目标、计划工具、内置提问和代理。具体配置与样本由脚本固定。

## 实施影响与待验证项

- **生命周期。** 只拿到 `thread/start` 返回的路径时应记录为待落盘。检测到历史落盘后才将会话标记为可跨重启恢复。已有回合的未决工具调用在重启后按业务记录对账；不能依赖 App Server 重发。
- **队列交接。** 原生 `queue/add` 已经可能使工作启动。仅在服务器完成目标、授权及幂等检查并接受调度后才提交给原生队列。已提交的条目可由 App Server 自动调度，应用关闭后不能把它视为仍在本地暂停。应用持久队列需要明确划分未提交、已交接和已开始三种状态。
- **部署验证。** 原版 App Server 的公开协议缺少正向工具白名单。专用构建在线程启动及恢复时注入 `ToolPolicy`，Node 启动时检查准确的七个工具名称。目标部署仍需核验模型出口策略与共享 Worker 客户端的竞争。 [内部 ToolPolicy](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/ext/extension-api/src/tool_policy.rs) · [原生队列处理](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)
- **A1 实验范围。** A1 使用模拟模型和临时 Worker 项目。共享 daemon、版本写操作和真实账号测试独立于这份离线证据。

## 补充验证

设置 `CODEX_WEB_ROUTER_NATIVE_PATH` 为原版静态原生二进制的绝对路径可运行 Bubblewrap 挂载实验。实验已验证 Router 进程可以读取自己的只读工作区并写入自己的持久状态，不能修改受保护的工作区和配置，无法看见 Worker 文件、应用数据库或 Worker Unix socket 路径。动态工具闭环在这个文件系统视图内仍能完成。

设置 `CODEX_WEB_ROUTER_POLICY_PATH` 为专用构建二进制可运行正向白名单验证。已用重新启用的内置能力、Code Mode Only 和额外注册的动态工具作对照。启动和恢复后的精确清单均为七个工具，非白名单调用和通用 JSON-RPC 被拒绝。工作台适配器对接、真实 Worker Hub 的权限校验、队列交接及回合历史关联也已通过。可写 Worker 返回的有效策略限制临时目录及额外写入路径，只读项目策略拒绝该 Worker。工作台实际使用的 Worker 0.170.0 也通过相同的原生队列、权限检查和历史关联测试。
