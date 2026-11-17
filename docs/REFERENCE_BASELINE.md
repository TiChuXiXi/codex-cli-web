# 参考基线

- 来源：https://github.com/TiChuXiXi/dsh-codex-cli.git
- 完整提交：48590b624d011d8036d412c31c8f5f319410eecb
- 提交说明：fix: distinguish selected message text from bubble backgrounds
- 获取方式：从本机已有参考仓库读取，确认 HEAD 与上述提交一致，已跟踪源码无改动。未跟踪压缩包保留原样。
- 新项目目录独立；不复制 client.js、node_modules、DSH 入口或 Cordis 配置。
- 源到目标完整文件映射见 migration-map.json；业务服务与前端组件复制迁移后独立维护。
- 测试取自本地未跟踪 test/，不声称来自上游 Git。providers/go-quota 两组引用基线不存在文件，未带入。标题测试中的多提供商预期改为当前 OpenAI 路径；见 DEVIATIONS.md。
- 来源 LICENSE 和 THIRD_PARTY_NOTICES.md 已迁入；dockkit 保留原 PROVENANCE/LICENSE。
- 原仓库 AGENTS.md 的插件构建要求仅适用于原仓库，独立工程不生成 ModuleLoader 包装。
