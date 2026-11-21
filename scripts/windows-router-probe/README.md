# Windows x64 专用 Router 的 Web 验证程序

该目录记录本机用于浏览器测试的构建输入。可执行文件属于实验制品。目前仅支持 ChatGPT 账号、chatgpt.com:443 和本机已有的 HTTP CONNECT 上游代理。

1. 取 openai/codex 提交 c376cf7396eff83ce4c6ac61b9553df142e7a0be（rust-v0.169.1）至 codex/。运行 node ../prepare-router-codex.mjs codex，然后在 codex 目录用 git apply 应用 codex-windows.patch。
2. 取与上游 Cargo.lock 校验和一致的 reqwest 0.12.28 及 gethostname 1.1.0 源码，分别放入与 codex 平级的 reqwest-012-broker 和 hostname-broker。在各自目录用 git apply 应用 reqwest-windows.patch 和 hostname-windows.patch。
3. 在 codex/codex-rs/Cargo.toml 现有的 [patch.crates-io] 下增加两项，把 reqwest 和 gethostname 分别指向 ../../reqwest-012-broker 和 ../../hostname-broker。本次使用 x86_64-pc-windows-msvc、Rust 1.95.0、Visual Studio 2022 C++ 工具链以及上游所需的 libclang。在 VS x64 开发者命令环境，从 codex/codex-rs 执行 cargo build -p codex-app-server --bin codex-app-server。本机调试构建使用 CARGO_PROFILE_DEV_DEBUG=0。
4. 编译宿主，在 MinGW-w64 x64 环境执行下方命令。将生成的 launcher.exe、重命名为 router-core.exe 的 codex-app-server.exe、仅含受信本机代理端口号的 proxy-port.txt 放在同一个当前用户独占写权限的目录。
5. 使用工作台仓库的 scripts/test-web-router-live.mjs 和 docs/acceptance/ndc-web.md 测试。设置显式 live 开关、Worker 路径、测试账号目录、模型、推理强度、launcher.exe 的绝对路径及可信 SHA-256。测试创建和删除专用状态目录。不要将已有服务的状态目录作为实验目录。

```sh
g++ -std=c++20 -static -municode -Os launcher.cpp -o launcher.exe -luserenv -ladvapi32 -lole32 -lws2_32
```

可分发版本仍需签名制品清单、覆盖核心二进制及代理配置的完整性检查、不同 Windows 版本的权限负向测试，以及异常终止后的配置文件和进程回收验证。

升级后读取同一条 Router 对话需要应用当前 `codex-windows.patch` 中的 thread-store 修改。它通过已打开历史文件的规范 NT 路径确认文件身份，适配 LPAC 下的 DOS 路径解析限制。对应核心及启动器摘要见[生命周期验收记录](../../docs/acceptance/ndc-lifecycle.md)。
