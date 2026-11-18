# Router A2 真实账号验收

2026-11-18，使用当前已登录的 Codex 账号，在 Linux aarch64 上以 `gpt-6.2-sol`、`low` 完成真实模型闭环。Router 使用专用 App Server 0.169.1，Worker 使用原版 App Server 0.169.1，两者通过工作台的 RouterService 和 CodexHub 连接。

| 验收项 | 结果 |
|---|---|
| 纯聊天 | 3.53 秒收到指定回复，未产生任务。 |
| 动态工具与新建派发 | 9.18 秒内收到 `list_projects` 和 `dispatch_task` 的真实调用，并派发到登记的临时项目。 |
| Worker 完成 | 回合完成，原始指令对应的 `clientUserMessageId` 在历史中恰好出现一次。Worker 回复指定文本，Router 任务保留该回复。未触发审批，回合中没有命令、文件变更或 MCP 调用，临时项目仍为空。 |
| 续接已有 Worker | 11.69 秒内收到 `list_sessions` 和 `dispatch_task` 的真实调用。同一 Worker 线程新增独立回合，该任务的关联 ID 在历史中恰好出现一次。续接同样未触发审批或执行工具，临时项目仍为空。 |
| 状态查询 | 4.26 秒内收到 `get_task_status` 的真实调用。 |
| 重启恢复 | 工作台重新打开后恢复同一 Router 线程，两项 Worker 任务均保留完成状态。 |

验收脚本为 Router 和 Worker 建立各自的临时 `HOME` 与 `CODEX_HOME`。只读取已登录账号的有效访问令牌，测试目录没有可用的刷新令牌，结束后清理。临时 Worker 设置了只读沙箱和纯文本验收指令。两次早期试验发现部分 Worker 回合仍会生成 MCP 调用记录，因此以带明确纯文本指令、通过回合历史核查的最后一次结果为准。`gpt-6.1-terra` 在当前账号的模型目录可选，未通过本次完整闭环。

## 复现

以已授权的测试账号运行。脚本只接收绝对路径和模型参数。

```sh
CODEX_WEB_ROUTER_A2=1 \
CODEX_WEB_CODEX_PATH="$(command -v codex)" \
CODEX_WEB_ROUTER_POLICY_PATH=/absolute/path/to/codex-router \
CODEX_WEB_ROUTER_AUTH_HOME=/absolute/path/to/logged-in-codex-home \
CODEX_WEB_ROUTER_LIVE_MODEL=gpt-6.2-sol \
CODEX_WEB_ROUTER_LIVE_EFFORT=low \
node scripts/test-router-live.mjs
```

A2 使用私有 stdio 进程和模型服务连接。启动器的挂载隔离、固定工具名单和拒绝行为由 [A1](router-a1.md) 验证。生产启用须按 [部署说明](../ROUTER.md) 配置并现场核验模型网络命名空间、Worker 项目和共享 daemon 竞争。
