# zcodex 首发验证 · Web 端

2026-11-21，从同一份工作区在 Windows 10 Pro x64 19045 和 WSL Ubuntu 24.04 x64 运行。Windows 使用非提权进程。浏览器测试使用 Chromium、现有账号的短期访问凭证和临时创建的项目，模型为 `gpt-6.2-sol`，推理强度为 `low`。

Windows 在干净的工作区副本用 Node 24.22.3 完成 `npm ci`、类型检查和 `npm pack`。Windows 与 WSL 分别用 `npm install -g --prefix` 安装同一个 `codex-cli-web-0.1.0.tgz`，两端现有的 `codex-web-ui --help` 均可执行。安装包的 SHA-256 为 `666a5f83d5e475cf47626c8e6f6b099181f5f67b4c40cadfd02e7befd8a5deed`，Web build ID 为 `9d716aa37cc99dfa`。Windows 安装后的 `.cmd` 入口成功登记了专用启动器的实际哈希。

| 入口 | 验证过程 | 结果 |
| --- | --- | --- |
| Windows 原生 Worker | Web 登录，认证 RPC 创建私有 stdio 会话，打开会话，在输入框提交第二条消息，刷新并重新打开会话 | 两条真实回答均包含各自的随机标记 |
| Windows 原生专用 Router | 从锁定源码构建 Windows App Server，非提权启动 LPAC 子进程，在安装包的中枢输入框请求列出项目 | 策略 v2 和 12 项工具校验通过，实际 `list_projects` 回答本轮随机项目名，刷新后保留，派工数为零 |
| WSL Linux Worker | 同一浏览器用例，私有 stdio 连接，使用本机现有模型代理 | 通过 |
| WSL Linux 专用 Router | 从 `rust-v0.169.1` 构建策略 v2，通过独立网络命名空间启动，在中枢输入框请求列出项目 | 服务验证 12 个工具，模型调用 `list_projects` 后返回本轮随机项目名，刷新后可读，派工数为零 |

`node --test test/router-*.test.mjs` 在 Windows 和 WSL 均通过 96 项，涵盖协议、服务、模型选择、展示、启动器和 Worker Hub。夹具使用独立临时目录。

## Windows 首发成本

原生 Web 路径已走通。Windows 侧新增工作集中在专用 Router。LPAC 检查需要用 Windows 文件句柄确认私有目录，为 SQLite 创建容器内的临时目录，并处理上游读取宿主名失败的情况。宿主通过私有管道提供到 `chatgpt.com:443` 的连接，TLS 由子进程校验，模型响应通过 HTTPS 流式返回。本轮使用本机已有的 HTTP CONNECT 代理，未验证无代理或企业代理环境。

最终 Windows 候选从首轮直接使用 HTTPS SSE。从启动 Web 到真实工具调用、应答、刷新及清理，单次实测 22.8 秒。对应 `launcher.exe` 的 SHA-256 为 `88f539f94f39430b24a8132b1d38291c1c9addda2d62d3921615cce72da035bd`，`router-core.exe` 为 `fa7a5fefab6d5c82f0a6d4b12166c3626806ee118aab3696cd6a7322e0b674b1`。[实验启动器、源码补丁和构建说明](../../scripts/windows-router-probe/README.md)

该实验使用了独立提供的原生启动器和核心二进制。按一名熟悉本仓库及 Windows 原生开发的工程师估算，在公共 `zcodex` 生命周期功能之外，Windows 再预留 **4–8 人日**：约 1–2 人日整理可重复构建和签名制品，约 1–2 人日处理直连及代理差异，约 2–4 人日验证干净机器、权限边界、进程回收和升级时的文件占用。估算以现有 x64 实验为基础，签名凭据、CI 机器准备及审批等待另计。

本机已备好源码和依赖后，首次 Windows 调试构建耗时 14 分 25 秒，WSL Linux 构建耗时 8 分 49 秒。Windows 调试版核心约 289 MiB，Web tarball 约 1.51 MiB。正式安装的下载量需用优化构建及压缩制品重新测量。

## 复测

在有开发依赖且已构建 Web 的工作区运行 `npm run test:web:live`。普通 Worker 用例使用 `npm run test:web:live -- --worker`。测试启动独立的本机 HTTP 服务，使用动态端口、临时状态库和私有 Worker。每次运行从指定账号复制短期访问凭证，临时副本不含刷新令牌，结束时清理。

| 环境变量 | 取值 |
| --- | --- |
| `CODEX_WEB_ROUTER_WEB_LIVE` | 须显式设为 `1` |
| `CODEX_WEB_CODEX_PATH` | 可执行 Worker 的绝对路径 |
| `CODEX_WEB_ROUTER_AUTH_HOME` | 已授权测试账号的 Codex 主目录，含 `auth.json` |
| `CODEX_WEB_ROUTER_LIVE_MODEL`、`CODEX_WEB_ROUTER_LIVE_EFFORT` | 账号可用的模型与推理强度 |
| `CODEX_WEB_ROUTER_LAUNCHER`、`CODEX_WEB_ROUTER_LAUNCHER_SHA256` | 专用 Router 启动器的绝对路径及受信任的 SHA-256。普通 Worker 用例可省略 |
| `CODEX_WEB_TEST_CHROMIUM` | 可选，显式指定 Chromium 路径 |
| `CODEX_WEB_TEST_PACKAGE_ROOT` | 可选，指向从 tarball 安装的包目录。服务和 Web 资源取自安装包，浏览器测试依赖留在工作区 |

微信继续使用原有 iLink 接入，本轮真机收发由操作者另验。Windows 测试直接运行 `.exe`，测试机同时装有 WSL。无 WSL 的干净 Windows 机器、正式 `zcodex` 命令、升级与回滚、卸载、Linux arm64、完整视觉矩阵和 38 项最终验收仍按 NDC 计划单独跟踪。
