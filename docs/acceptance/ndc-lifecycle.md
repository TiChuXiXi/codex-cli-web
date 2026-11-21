# zcodex 本地 npm 候选验收

2026-11-21，候选版本 `0.1.0-rc.1`。Windows 原生 x64 和 WSL Ubuntu 24.04 x64 安装了同一份 npm tarball。Windows 使用 Node 24.22.3，WSL 使用 Node 24.22.0，两边各有独立的 npm 全局前缀、配置、状态目录和测试项目。仓库清单保留 `private: true`。

| 场景 | Windows x64 | WSL/Linux x64 |
|---|---|---|
| 全局安装和入口 | 实际 npm 安装，cmd shim 运行生命周期，PowerShell shim 读取版本 | 实际 npm 安装，使用全局 bin |
| 启动、重启和停止 | 后台就绪、重复启动、重启、重复停止通过 | 同左 |
| Web 和终端 | 凭证登录、静态资源、真实 PowerShell PTY、私有 stdio Worker 通过 | 凭证登录、静态资源、真实 Bash PTY、私有 stdio Worker 通过 |
| 更新 | 本地 registry 检查 latest，运行中替换并重新启动，停机替换后继续停机 | 同左 |
| 更新失败与拒绝 | 端口占用拒绝；Worker 执行中拒绝替换；损坏 Web 候选触发回滚，恢复旧版和服务 | 同左 |
| 卸载、重装 | 从运行中和停机状态自卸载，shim 和包目录移除，重装读回凭证、用户文件和 SQLite 记录 | 同左 |
| 专用 Router 和浏览器 | 真实模型执行 list_projects，升级后 policy v2 就绪，主线程 ID 相同，页面显示原回复 | 同左 |

测试使用仅在回环地址提供的 `zcodex@latest`。升级目标 `0.1.0` 是本次验证专用的本地版本。故障版本 `0.1.1` 故意损坏 Web 入口。常规用例的 Worker 使用私有协议夹具。Router 真实用例显式启用并使用已授权账号、临时项目及各自平台的启动器。

## 复验

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e -- test/e2e/settings.spec.ts
npm run test:package
```

`test:package` 构建本地 tarball，也可使用 `npm run test:package -- <候选包.tgz>` 指定被测包。测试临时前缀和状态路径包含空格和中文。真实浏览器路径由 `scripts/lifecycle-router-check.mjs` 验证，启用它需要 `CODEX_WEB_LIFECYCLE_ROUTER_LIVE=1`，以及受信任的启动器、SHA-256、独立测试凭据来源、模型和推理强度。

## 制品和范围

- 候选 tarball SHA-256 为 `41155614bc2896c0f9d219602958bdcb302a1702c1b98531ba7f217eba3ad94e`。Web build ID 为 `c31d62e4ad0fa6f5`。
- npm pack 完整性值为 `sha512-FASvnBnhmffx1IyuCzglyn2F9pwgkHMyOv/4+2EpSV9BfFSjK2j1ot1yLam1tLLqo+ixnVDgfJUjKTjLf3UfuQ==`。包大小为 1,601,419 字节，含 89 个条目，已检查 CLI、维护助手、Web 入口、许可证和第三方 notices。
- Windows 沙箱恢复主线程时，原生路径解析对历史文件返回拒绝访问。专用构建在系统拒绝解析 DOS 路径时，打开已有历史文件，核对句柄的规范 NT 路径与受信任 Codex Home 下的目标位置，核对成功才继续。实测启动器 SHA-256 为 `88f539f94f39430b24a8132b1d38291c1c9addda2d62d3921615cce72da035bd`，配套核心 SHA-256 为 `f7864d09405f2f3283ba52d77d72943ea0805eef720e59af3df35e263c3fe713`。
- 数据库验收覆盖同一 schema 的版本替换与历史保留。激活新版后遇到异常会保留操作记录供核对，跨 schema 恢复、首次干净机器部署、Linux arm64 同版生命周期、签名 Router 制品、Windows 外部共享 daemon 和完整视觉矩阵仍待验收。微信真机由维护者另测。尚未公开发布。
