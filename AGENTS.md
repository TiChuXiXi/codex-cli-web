# 开发约定

项目为独立 Codex CLI Web 工作台，不依赖 DSH/Cordis。参考基线、38 项范围和验收限制见 docs/REFERENCE_BASELINE.md、FEATURE_MATRIX.md、ACCEPTANCE.md。

- 文件操作优先 filesystem MCP；仅在不支持、失败或无权限时降级并说明原因。代码符号检索优先语义工具，字面量搜索使用 rg。
- 修改前检查 git 状态，保留已有改动。原 dsh-codex-cli 仓库只读，不修改其源码或 client.js。
- server 为 Node ESM JavaScript，web 为 React/TypeScript，shared 为边界契约和共享限制。ESM 相对导入带 .js。
- 沿用锁定 UI、组件和样式覆盖顺序；不随意更换交互或依赖。改动差异同步 docs/DEVIATIONS.md。
- 保持 /codex-cli RPC 信封、SSE、错误、取消和队列语义；所有业务通道都必须经过认证栅栏。
- 前端修改运行 build、typecheck 和相关浏览器检查；业务修改运行相关单元/集成测试。新测试不得被忽略或仅放在原仓库。
- Git/文件/PTY 测试使用临时夹具。普通测试禁止真实模型调用、升级、回滚或管理外部共享 daemon；live 测试须显式设置开关与目标。
- npm 使用 package-lock.json；预构建资源由 build 生成，不手工修改 dist。
- 不将基线截图局部通过、模拟通过或代码迁移当成 38 项全部最终验收通过。真实账号、版本写操作和完整视觉矩阵的未执行项须明确记录。
- 保留来源许可证和第三方 notices。提交、推送和公开发布仅按用户明确要求执行。
