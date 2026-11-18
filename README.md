# Codex CLI Web

独立运行的 Codex CLI 工作台。功能与界面迁移自 TiChuXiXi/dsh-codex-cli 的固定提交，保留项目、会话、队列、审批、文件、Git、终端、技能和版本管理，不需要 DSH 或 Cordis。

## 启动

当前为本地开发版本，尚未公开发布 npm 包。已验证 Linux arm64、Node 24.19.0；需要 Git 和可用的 Codex CLI。

```bash
npm ci
npm run build
npm start
```

默认访问 http://127.0.0.1:8787。在另一终端运行以下命令查看本机 Web 访问凭证：

```bash
node bin/codex-web-ui.mjs --print-access-token
```

访问凭证以 0600 权限保存在应用状态目录的 access-token 文件中，默认目录为 `~/.local/state/codex-cli-web`，支持 XDG_STATE_HOME。使用了 --state-dir 或 --config 时，查看凭证时应传入同样参数。凭证不会作为启动日志输出。

Web 登录与 Codex 登录分开；Codex 登录使用 `codex login`。默认 transport=auto，优先连接 daemon，失败回退私有 stdio。仅需私有连接时：

```bash
node bin/codex-web-ui.mjs --transport stdio --port 8787
```

## 新电脑部署

使用 `npm start -- --config config.portable.json` 启动。这个文件只需要两个选项：

- `accessScope` 填 `local` 仅本机访问，填 `lan` 开启内网 IP 访问。启动日志会显示已检测到的内网访问地址。
- `lanPasswordless` 填 `true` 允许白名单设备免登录，仅在 `lan` 下生效。首次请在服务器本机打开 `http://127.0.0.1:8787`，在「设置 → 访问白名单」中添加访问设备。面板自动保存名单，其他设备默认拒绝。未开启免登录时，Web 凭证自动生成。

端口、状态目录和默认模型使用内置默认值。Router 需要先安装专用 App Server。安装后注册启动器即可自动生成配置，工作目录由已有 Codex 会话发现。详见 [Router MVP](docs/ROUTER.md)。

## 旧服务器部署的内网免登录与 IP 白名单

当前服务器使用 `config.lan.json`，只允许 `192.168.1.80` 免登录访问：

```bash
npm start -- --config config.lan.json
```

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "publicOrigin": "http://192.168.1.182:8787",
  "authMode": "network",
  "allowedClients": ["192.168.1.80"]
}
```

在工作台点击“设置 → 访问白名单”，可添加或移除 IP，保存后立即生效并持久化。当前部署已启用 settingsFirewall 同步，保存也会同步 firewalld 的运行时和永久规则。直接编辑配置文件时仍需重启服务。可以填写多个精确 IP，或明确网段，例如 `["192.168.1.80", "192.168.1.81"]`、`["192.168.1.0/24"]`；这些仅是配置示例，当前实际只允许 .80。未启用 settingsFirewall 的部署仍需自行同步外部防火墙。

network 模式不需要访问凭证或会话 Cookie，界面不显示登录和退出入口；白名单同时保护页面、RPC、SSE、上传、下载和终端。来源 IP 使用 TCP 连接的实际对端，不信任 X-Forwarded-For/Forwarded。Host/Origin 校验仍生效。若需要本机访问，必须显式将本机使用的来源 IP 加入名单；当前名单不包含本机地址。移除当前访问 IP 时，设置页会要求确认；确认后当前设备失去访问权限。

不指定 authMode 时仍默认使用原 token 登录模式。也可使用 --auth-mode network --allowed-clients 192.168.1.80，或 CODEX_WEB_AUTH_MODE / CODEX_WEB_ALLOWED_CLIENTS 环境变量。network 模式缺少有效白名单会拒绝启动。

## 配置

优先级：CLI > CODEX_WEB_* 环境变量 > --config 指定的 JSON > 默认值。Codex Home 按显式 codexHome > CODEX_HOME > Codex 默认目录解析。应用不会为自己的配置改写 Codex 配置文件。

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "transport": "auto",
  "sessionTtlMs": 43200000,
  "git": {"allowWrite": true, "allowPush": true, "allowDangerous": true},
  "logLevel": "info"
}
```

支持 --host、--port、--config、--state-dir、--codex-path、--codex-home、--transport、--git-write、--allowed-hosts、--allowed-origins、--public-origin、--auth-mode、--allowed-clients、--log-level，完整帮助运行 --help。

环境变量包括 CODEX_WEB_HOST、PORT、CONFIG、STATE_DIR、ACCESS_TOKEN、CODEX_PATH、CODEX_HOME、TRANSPORT、GIT_WRITE、ALLOWED_HOSTS、ALLOWED_ORIGINS、PUBLIC_ORIGIN、AUTH_MODE、ALLOWED_CLIENTS、SESSION_TTL_MS、LOG_LEVEL；均需完整的 CODEX_WEB_ 前缀。列表使用逗号分隔；访问凭证至少 16 字符。

默认仅开放 loopback。局域网例子：

```bash
node bin/codex-web-ui.mjs --host 0.0.0.0 --public-origin http://192.168.1.20:8787
```

地址为部署示例，替换为服务器实际地址。Host/Origin 使用精确白名单，不支持通配符。公开 origin 与后端地址不同的反向代理应保留公开 Host；若健康检查使用后端 Host，将其显式加入 allowedHosts。HTTPS 代理须配置 https:// 开头的 publicOrigin，使登录 Cookie 带 Secure。应用不信任任意 X-Forwarded-* 头。SSE 代理应关闭缓冲并允许长连接；上传代理限制需支持 500 MiB 及较长传输时间。首版仅支持根路径部署。

单一已认证操作者能够访问服务端目录和 Shell；Codex 的会话权限、Web 认证和 Git 写开关分别生效。退出登录会关闭该会话的活动请求；后台待发送队列继续由服务调度。

## 设置页面

从工作台左下角齿轮或底部“设置”进入：

- “版本与更新”：检查更新、CLI 升级/回滚、守护进程管理、体检和任务输出。状态查询失败会提示状态待确认并继续重试，不重复发起更新。
- “访问白名单”：显示当前访问 IP 和访问模式，支持添加、移除、校验、保存与重新加载。保存立即生效且持久化；并发修改有冲突提示。移除当前 IP、放弃未保存更改均需确认。
- 当前部署启用 `settingsFirewall`，保存名单时同步对应 firewalld rich rules，包含运行时和永久规则；失败时保留原配置。页面不会修改其他端口或防火墙区域。
- 如果名单由 CLI 或环境变量覆盖，设置页只读并说明原因。未传应用配置文件时，页面设置保存到应用 state-dir/settings.json。

当前服务以 systemd 临时单元 `codex-cli-web.service` 运行，可用 `systemctl restart codex-cli-web` 重启。该单元不随终端退出而停止；未设置机器重启后自动启动。

## 检查与测试

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run test:visual
REFERENCE_REPO=/path/to/locked/dsh-codex-cli npm run test:parity
npm pack
npm run test:package -- ./codex-cli-web-0.1.0.tgz
```

默认自动测试使用临时文件/Git 仓库及模拟 Codex，无需模型账号。PTY 测试需要平台的 @lydell/node-pty 原生包；安装时不要省略 optional dependencies。E2E 测试端口为 18787。

test:visual 采集四种尺寸、深浅主题的截图和溢出检查；test:parity 则直接构建锁定参考源码，在相同服务/夹具下与目标界面对比，当前场景与屏蔽规则见报告。两者不代表全部功能场景已完成视觉验收。

真实 Codex 的隔离握手测试：

```bash
CODEX_WEB_LIVE=1 npm run test:live
```

默认使用临时 CODEX_HOME，仅初始化协议。若需真实模型回合，显式设置 CODEX_WEB_LIVE_SEND=1 和已登录的 CODEX_WEB_LIVE_HOME；该操作会调用模型。升级、回滚、daemon 写操作通过界面主动触发，不混入常规测试。

## 状态与故障排查

- Codex 未连接：Web 页面仍可打开；检查 codex 可执行路径、CODEX_HOME、transport 和“设置 → 版本与更新”。
- 登录失效：重新输入 Web 访问凭证；服务重启会清空 Web 会话。
- 请求 403：核对 publicOrigin、Host/Origin 白名单和代理转发配置。脚本写请求需带 Origin 或 X-Codex-Request: 1，以及有效 Cookie。
- 终端不可用：检查 optional PTY 包是否安装，以及 Linux Bash 是否存在。
- SIGINT/SIGTERM 会关闭本应用资源和私有 stdio；不会主动停止外部共享 daemon。
- 队列、事件缓冲及 PTY 属于服务内存态，重启后清空；Codex 历史继续由 Codex 保存。草稿使用 sessionStorage，不跨设备同步。
- 文件删除沿用锁定源码的永久删除行为；压缩包手册中“移入 .dsh-trash”的描述与源码不一致，详见差异记录。

实现映射与尚未完成的验收见 [功能矩阵](docs/FEATURE_MATRIX.md)、[验收记录](docs/ACCEPTANCE.md)。不要将“已迁移”解释为 38 项全部通过。

## 来源

参考提交：48590b624d011d8036d412c31c8f5f319410eecb。项目及带入代码遵循 MIT 等原许可证，详见 LICENSE、THIRD_PARTY_NOTICES.md 和 vendor/dsh-dockkit/PROVENANCE.md。

## Router

Router 提供独立的 Codex 对话、候选确认和 Worker 调度。默认关闭。专用 App Server 的构建、隔离与启用方式见 [Router MVP](docs/ROUTER.md)。
