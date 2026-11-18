# Router MVP

Router 是工作台内的独立对话入口。它用专用 Codex App Server 管理对话，通过七个固定的动态工具检索已登记项目和会话、发起调度、查询状态和请求中断。Worker 保留自己的线程、项目上下文与原生审批。用户可在 Router 和原工作台之间切换。

## 访问和执行边界

- Web 沿用工作台实例的认证。待确认项只有在界面确认后才按保存的目标与原始文本继续。明确目标需要源消息中的名称、ID 或已确认绑定，且候选分数达到 90 分并领先至少 15 分。中断必须在界面另行确认。
- Router 和 Worker 使用各自的 App Server。Router 运行在独立的工作目录及 `CODEX_HOME`，其部署启动器通过摘要校验。专用 App Server 通过 `router/capabilities` 表明固定工具策略版本和精确名单。工作台拒绝启动未报告此策略的进程。
- 专用构建在 Codex Core 工具注册层为每个新建或恢复的会话应用白名单。其外部 JSON-RPC 入口仅允许初始化、模型列表和必要的线程回合操作。部署沙箱独立限制文件、进程和网络。
- Worker 派发只传原始用户文字、线程及关联 ID，检查登记项目、有效 cwd、审批人、审批策略、网络和沙箱范围。可写项目的自动选择也需界面确认。Worker 0.169.1 和 0.170.0 均已通过队列和权限验收。权限未知、审批自动同意或工作目录不符合登记时，任务拒绝交接。
- Worker 自己的执行及审批仍走原工作台。Router 工具没有对应的通用 HTTP 调用入口。

## 准备和启用

1. 用临时位置取得 OpenAI Codex 的 `rust-v0.169.1` 发布源码。保留其 Apache-2.0 许可证和 notices。运行 `node scripts/prepare-router-codex.mjs /path/to/codex-rust-v0.169.1`，在该副本的 `codex-rs` 目录用 Rust 1.95.0 执行 `cargo build -p codex-cli --bin codex`。本机 GNU 链接器内存不足时，使用 Clang 驱动 Rust 工具链自带的 LLD 完成链接。发布 tarball 的 workspace 版本为 0.169.1，Cargo 会在该副本中同步锁文件内原为 0.0.0 的 workspace 版本。
2. 在部署者维护的目录放置专用构建产物 `codex-router`，用 `sha256sum codex-router > codex-router.sha256` 记录摘要。用 `install -m 0755` 安装 `scripts/router-launcher.sh`。启动器与摘要所在目录只允许可信部署者修改。
3. 提供该目录下的 `model.netns`，指向一个独立于工作台宿主的 Linux 网络命名空间。由部署网络策略仅开放所用 Codex 账号或模型提供方及必要的 DNS，隔离宿主 RPC、内网服务及其他出口。服务身份须具备进入该命名空间的授权。参考启动器在此网络命名空间内用 Bubblewrap 建立挂载与进程隔离。
4. 把专用 Codex 账号、配置和历史放在 `<stateDir>/router/codex-home`。首次登录使用同版本的原版 CLI 和专用目录，由部署者完成。启用后服务会在缺失时自动生成受限的 `config.toml`。可以按部署环境选择 provider，保留禁用插件、MCP、hooks、网页搜索和遥测的设置。启动器只挂载 Router 自己的状态、只读配置和只读工作目录。业务 SQLite 和 Worker daemon socket 所在路径不提供给 Router。
5. 在应用 JSON 里添加 `router`。示例中的模型、目录及摘要由部署者用实际值替换，工作台会在启用时查 `model/list` 并验证每个候选的推理强度。

```json
{
  "router": {
    "enabled": true,
    "launcher": "/opt/codex-router/router-launcher.sh",
    "launcherSha256": "<实际启动器的 64 位小写 SHA-256>",
    "models": [
      { "model": "gpt-6.1-terra", "effort": "low" }
    ],
    "projects": [
      {
        "id": "example",
        "name": "项目名称",
        "cwd": "/absolute/path/to/worker-project",
        "aliases": ["项目别名"],
        "sandbox": "read-only"
      }
    ]
  }
}
```

新电脑使用 `config.portable.json` 时，部署完上述 Router 运行组件后，用同一个运行账号和状态目录执行 `npm start -- --config config.portable.json --register-router-launcher /绝对路径/launch.sh`。命令自动记录启动器路径和摘要，服务下次启动时加载。已有 Codex 会话中的项目自动列出，首次使用前在面板确认项目目录。授权以只读方式保存，重启后复用。路径或目录身份变化时需重新确认。专用运行组件未安装时，普通工作台可独立使用。

Router 默认关闭；启用且省略 `models` 时默认使用 GPT-6.1 Terra（`gpt-6.1-terra`，`low`）。显式配置 `models` 时按数组顺序选择第一个已验证组合，不会自动替换成未配置的模型。模型与推理强度仍须通过账号目录验证。恢复已有 Router 线程时也应用所选模型，保留会话历史。项目列表可为空。项目策略默认 `read-only`，可显式设为 `workspace-write`。可写 Worker 的有效策略必须把写入限制在项目目录，禁用临时目录的额外写权限和网络访问，并由用户审批。项目路径必须是已存在的目录，与 Router 状态目录分离。

## 任务、恢复和停用

任务与已落盘的用户确认保存在 `stateDir/router/router.sqlite`。同一状态目录只允许一个调度实例。任务开始前写入提交意图，再交接给 Worker 的原生队列。提交结果丢失时以 `clientUserMessageId` 和原生队列 ID 对账。队列条目移出后预留回合历史可见的时间，再把缺少关联证据的任务标为待核对。未知结果暂停该线程的 Router 队列，操作者可打开相应会话核对，然后明确关闭待核对任务。关闭保留原记录和审计事件。

SSE 通过 `router/changed` 提示前端刷新快照，重启后从 SQLite 读取。审批等待由 Worker 原生审批事件驱动，审批从 Worker 页面处理。原生队列已接收的条目可能在工作台停止后由 App Server 继续执行。关闭 `router.enabled` 暂停未交接的任务并保留历史，重新启用后先按原记录对账。

当前范围为 MVP。定时任务、微信 iLink、外部事件收件箱和自动模型唤醒属于后续阶段。

## 验证

本机通过 166 项 Node 测试、构建、类型检查、安装包测试和 15 项浏览器测试。专用 App Server 和真实账号闭环分别见 [Router A1](acceptance/router-a1.md) 与 [Router A2](acceptance/router-a2.md)。生产环境的网络策略和目标 Worker 需在部署时核验。
