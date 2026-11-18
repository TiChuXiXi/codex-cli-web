# 功能映射与验收状态

基线：48590b624d011d8036d412c31c8f5f319410eecb。38 项代码均已迁入；此表不将源码迁移或局部测试等同于完整人工验收。每项包含的全部子场景见 spec/02，证据和限制见 ACCEPTANCE.md。

目标提交：尚未创建提交。当前版本 0.1.0；实际构建 ID 见 dist/web/build.json。

| 编号 | 功能 | 目标模块/符号 | 已有自动证据 | 完整验收 |
|---|---|---|---|---|
| UI-01 | 工作台布局 | `web/src/page/ConsolePage.tsx`、`web/src/page/FocusSidebar.tsx`、`web/src/styles.ts`、`web/src/workbench-styles.ts`；ConsolePage / FocusSidebar / CSS / WORKBENCH_CSS。 | `test/appearance.test.mjs` | 待逐项验收 |
| UI-02 | 主题、移动端与基础交互 | `web/src/appearance.ts`、`web/src/useAppearance.ts`、`web/src/components/DialogFocus.ts`、`web/src/components/Icon.tsx`、`web/src/components/SelectMenu.tsx`、`web/src/components/Toast.tsx`；initialTheme / revealCircle / useAppearance / useDialogFocus / Icon / SelectMenu。 | `test/appearance.test.mjs` | 待逐项验收 |
| P-01 | 项目选择与目录创建 | `web/src/page/ProjectPickerDialog.tsx`、`web/src/page/DirectoryPickerDialog.tsx`、`web/src/page/ConsolePage.tsx`、`server/services/fs.js`；ProjectPickerDialog / DirectoryPickerDialog / checkDirectory / listDirectory / createDirectory。 | `test/fs.test.mjs` | 待逐项验收 |
| P-02 | 项目排序与展开 | `web/src/page/FocusSidebar.tsx`、`web/src/page/projectOrder.ts`；FocusSidebar / projectOrder 模块。 | `test/project-order.test.mjs` | 待逐项验收 |
| P-03 | 会话搜索与分页 | `web/src/page/ConsolePage.tsx`、`web/src/page/FocusSidebar.tsx`、`web/src/page/ThreadRow.tsx`、`server/codex/hub.js`；THREAD_PAGE / loadThreads / threadsOwner / CodexHub.listThreads / CodexHub.projects。 | `test/thread-recovery.test.mjs` | 待逐项验收 |
| P-04 | 选择恢复、运行状态与未读 | `web/src/page/ConsolePage.tsx`、`web/src/page/ThreadRow.tsx`、`web/src/running-time.ts`、`web/src/utils.ts`；LAST_THREAD_KEY / VIEWED_TURNS_KEY / activeTurnIdOf / upsertThread。 | `test/thread-recovery.test.mjs`、`test/running-time.test.mjs` | 待逐项验收 |
| P-05 | 会话操作菜单 | `web/src/page/ThreadActions.tsx`、`web/src/page/ThreadRowMenu.tsx`、`web/src/page/ConsolePage.tsx`、`server/codex/hub.js`；ThreadActions / ThreadRowMenu / renameThread / archiveThread / forkThread / exportThread / deleteThread。 | `test/thread-recovery.test.mjs` | 待逐项验收 |
| P-06 | 后台自动标题 | `server/services/thread-titles.js`、`server/codex/hub.js`、`web/src/utils.ts`；ThreadTitles.track / notification / #generate / isHidden / parseTitle / threadTitle。 | `test/thread-titles.test.mjs` | 待逐项验收 |
| C-01 | 输入、发送、草稿与历史 | `web/src/page/Composer.tsx`、`web/src/drafts.ts`、`web/src/page/ConsolePage.tsx`、`web/src/page/ThreadView.tsx`；Composer.submit / onKeyDown / readDraft / saveDraft / send。 | `test/followups.test.mjs` | 待逐项验收 |
| C-02 | 模型与推理强度 | `web/src/page/Composer.tsx`、`web/src/page/ThreadView.tsx`、`web/src/page/ConsolePage.tsx`、`server/codex/hub.js`；ModelOption / FALLBACK_EFFORTS / getThreadSettings / models / startTurn。 | `test/thread-recovery.test.mjs` | 待逐项验收 |
| C-03 | 权限模式 | `web/src/permissions.ts`、`web/src/page/Composer.tsx`、`web/src/page/ThreadView.tsx`、`server/services/followups.js`；permissionPayload / choosePermission / updatePermissions。 | `test/followups.test.mjs` | 待逐项验收 |
| C-04 | 斜杠命令与计划模式 | `web/src/page/Composer.tsx`、`web/src/page/ConsolePage.tsx`、`web/src/page/ThreadView.tsx`、`server/codex/hub.js`；COMMANDS / runCommand / planMode / startTurn / compactThread / setGoal。 | `test/thread-recovery.test.mjs` | 待逐项验收 |
| C-05 | 文件引用与技能 | `web/src/page/Composer.tsx`、`web/src/components/SkillPicker.tsx`、`web/src/skills.ts`、`server/services/skills.js`、`server/codex/hub.js`；skillQuery / filterSkills / hasSkill / loadSkills / chooseSkill / chooseFile / resolveSkillInputs。 | `test/skills.test.mjs` | 待逐项验收 |
| C-06 | 对话附件和进度卡片 | `web/src/uploads.ts`、`web/src/page/Composer.tsx`、`web/src/components/UploadingAttachment.tsx`、`server/services/uploads.js`、`shared/limits.js`；uploadFile / MAX_UPLOAD_BYTES / uploadFiles / saveUploadStream。 | `test/uploads.test.mjs`、`test/routes.test.mjs` | 待逐项验收 |
| C-07 | 消息与 Markdown | `web/src/page/ItemCard.tsx`、`web/src/markdown.tsx`、`web/src/markdownTokens.ts`、`web/src/components/MermaidDiagram.tsx`、`web/src/components/MessageCopyButton.tsx`、`web/src/components/ImageViewer.tsx`、`web/src/fileTypes.ts`；ItemCard / Markdown / LocalFileLink / CodeBlock / downloadsOnClick。 | `test/markdown-links.test.mjs`、`test/message-stream.test.mjs`、`test/file-types.test.mjs` | 待逐项验收 |
| C-08 | 工具组与消息活动 | `web/src/page/ToolGroup.tsx`、`web/src/page/ItemCard.tsx`、`web/src/activity-status.ts`、`web/src/utils.ts`、`server/codex/hub.js`；groupActivity / isActivity / isInvisible / ToolGroup / activityStatus / activityCounts / compactItem。 | `test/activity-status.test.mjs`、`test/message-stream.test.mjs` | 待逐项验收 |
| C-09 | 消息分页、滚动与运行时间 | `web/src/page/ThreadView.tsx`、`web/src/page/ConsolePage.tsx`、`web/src/running-time.ts`、`web/src/utils.ts`、`server/codex/hub.js`；TURN_PAGE / loadOlder / ThreadView 滚动 effects / runningStartedAt / getThread。 | `test/running-time.test.mjs`、`test/message-stream.test.mjs`、`test/thread-recovery.test.mjs` | 待逐项验收 |
| C-10 | 上下文使用与压缩 | `web/src/components/ContextUsage.tsx`、`web/src/context-usage.ts`、`server/services/context-usage.js`、`web/src/page/ItemCard.tsx`、`server/codex/hub.js`；contextUsage / readContextUsage / compactThread / contextCompaction 分支。 | `test/context-usage.test.mjs` | 待逐项验收 |
| Q-01 | 后端待发送队列 | `server/services/followups.js`、`web/src/page/FollowupList.tsx`、`web/src/page/ConsolePage.tsx`；FollowupQueue.enqueue / #locked / #kick / #sync / #release / FollowupList。 | `test/followups.test.mjs` | 待逐项验收 |
| Q-02 | 队列编辑、引导和暂停恢复 | `server/services/followups.js`、`web/src/page/FollowupList.tsx`、`web/src/page/ThreadView.tsx`；FollowupQueue.action / pause / #event / steerTurn / FollowupList。 | `test/followups.test.mjs` | 待逐项验收 |
| A-01 | 执行审批 | `web/src/page/ApprovalCard.tsx`、`server/codex/hub.js`、`server/codex/jsonrpc.js`；ApprovalStack / ApprovalCard / respondApproval / pendingApprovals / defaultApprovalResponse / SKIP_RESPONSE。 | `test/jsonrpc.test.mjs`、`test/thread-recovery.test.mjs` | 待逐项验收 |
| A-02 | 同步多题与私密输入 | `web/src/page/QuestionForm.tsx`、`web/src/page/ApprovalCard.tsx`；QuestionForm / InputCard / InputQuestion / onSubmit 答案结构。 | `test/questions.test.mjs` | 待逐项验收 |
| A-03 | 异步 Agent 提问 | `web/src/page/ItemCard.tsx`、`web/src/page/QuestionForm.tsx`、`web/src/page/ThreadView.tsx`；AsyncQuestions / defaultFirst / answerQuestion / openQuestionIds。 | `test/questions.test.mjs` | 待逐项验收 |
| W-01 | 右侧多标签工作区 | `web/src/sidebar/SidebarWorkspace.tsx`、`web/src/sidebar/state.ts`、`web/src/sidebar/focus.ts`、`web/src/sidebar/composition.ts`、`vendor/dsh-dockkit/PROVENANCE.md`；SidebarWorkspace / Workspace / DockLayout / restoreLayout / layoutKey / canSplit。 | `test/sidebar.test.mjs` | 待逐项验收 |
| W-02 | 文件树、搜索与上下文菜单 | `web/src/sidebar/FilesPane.tsx`、`web/src/sidebar/FileContextMenu.tsx`、`web/src/sidebar/workspace-events.ts`、`server/services/workspace.js`；FilesPane / Directory / WorkspaceService.register / target / search / upload / remove / observe / release。 | `test/workspace.test.mjs`、`test/sidebar.test.mjs` | 待逐项验收 |
| W-03 | 文档、图片、HTML 预览与下载 | `web/src/sidebar/DocumentPane.tsx`、`web/src/sidebar/codeHighlight.tsx`、`web/src/components/ImageViewer.tsx`、`web/src/components/FileDownloadButton.tsx`、`web/src/fileTypes.ts`、`server/services/workspace.js`；DocumentPane / FileDocumentPane / downloadsOnClick / WorkspaceService.text / bytes / downloadInfo / download。 | `test/workspace.test.mjs`、`test/file-types.test.mjs`、`test/routes.test.mjs` | 待逐项验收 |
| W-04 | 交互式终端 | `web/src/sidebar/TerminalPane.tsx`、`web/src/sidebar/terminal.css`、`server/services/terminal.js`；TerminalPane / TerminalService.open / read / write / resize / close / dispose。 | `test/terminal.test.mjs`、`test/routes.test.mjs` | 待逐项验收 |
| G-01 | Git 总览与仓库初始化 | `web/src/sidebar/GitPane.tsx`、`server/services/git.js`；GitPane / repo/info / repo/snapshot / repo/init / ensureWorkdir / parseStatus。 | `test/git.test.mjs` | 待逐项验收 |
| G-02 | Git 变更、暂存和提交 | `web/src/sidebar/GitPane.tsx`、`server/services/git.js`、`web/src/sidebar/gitStyles.ts`；stage / unstage / diff / commit / changePaths / requireWrite。 | `test/git.test.mjs` | 待逐项验收 |
| G-03 | Git 提交图与详情 | `web/src/sidebar/GitPane.tsx`、`web/src/sidebar/gitGraph.ts`、`server/services/git.js`；graphRows / parseCommitList / log / show / show/file。 | `test/git-graph.test.mjs`、`test/git.test.mjs` | 待逐项验收 |
| G-04 | Git 分支、远程及同步 | `web/src/sidebar/GitPane.tsx`、`server/services/git.js`；checkout / branch/create / branch/delete / merge / remote/add / remote/remove / fetch / pull / call。 | `test/git.test.mjs` | 待逐项验收 |
| G-05 | Git 推送与凭据 | `web/src/sidebar/gitPush.ts`、`web/src/sidebar/GitPane.tsx`、`server/services/git.js`；branchPushState / resolvePushTarget / push / credential/approve / redactArgv / redactText。 | `test/git-push.test.mjs`、`test/git.test.mjs` | 待逐项验收 |
| G-06 | Git 贮藏、危险操作与记录 | `web/src/sidebar/GitPane.tsx`、`server/services/git.js`；stash / stash/show / discard / revert / cherry-pick / reset / console/list / console/clear / requireDangerous。 | `test/git.test.mjs` | 待逐项验收 |
| V-01 | 版本、配额和健康状态 | `web/src/page/VersionsPanel.tsx`、`web/src/page/versionsStyles.ts`、`web/src/page/FocusSidebar.tsx`、`server/services/versions.js`；VersionsDialog / QuotaPopover / quotaSummary / VersionService.check / update / rollback / doctor / job。 | `test/versions.test.mjs`；真实版本写操作未执行 | 待逐项验收 |
| V-02 | 守护进程控制 | `web/src/page/VersionsPanel.tsx`、`server/services/versions.js`、`server/codex/transport/index.js`；VersionService.daemonAction / #assertNoActiveTurns / startDaemon / openCodexTransport。 | `test/thread-recovery.test.mjs` | 待逐项验收 |
| R-01 | Codex 协议与传输恢复 | `server/codex/jsonrpc.js`、`server/codex/transport/index.js`、`server/codex/transport/daemon.js`、`server/codex/transport/stdio.js`、`server/codex/hub.js`；JsonRpcClient / openCodexTransport / DaemonTransport / StdioTransport / CodexHub.#run / #connect / startTurnWithResume。 | `test/jsonrpc.test.mjs`、`test/thread-recovery.test.mjs` | 待逐项验收 |
| R-02 | 事件流一致性 | `server/services/events.js`、`server/api/routes.js`、`web/src/events.ts`、`web/src/utils.ts`、`web/src/page/ConsolePage.tsx`；EventBus.publish / publishDelta / flushDeltas / since / handleEvents / openEventStream / applyDetailEvent。 | `test/events.test.mjs`、`test/message-stream.test.mjs`、`test/routes.test.mjs`、`test/stream-epoch.test.mjs` | 待逐项验收 |
| R-03 | 独立宿主、认证与资源清理 | `server/bootstrap.js`、`server/api/routes.js`、`server/runtime.js`、`web/src/main.tsx`、`scripts/build.mjs`、`cordis.patch.yml`；参考 apply 装配与清理；createRoutes 信任边界；新项目自行实现 bootstrap/auth/standalone mount。 | `test/routes.test.mjs`、`test/host.test.mjs` | 待逐项验收 |

补充浏览器证据：test/e2e/workbench.spec.ts 覆盖登录、对话/队列/刷新/登出、审批、主题与右栏；test:visual 采集四种尺寸两种主题，test:parity 对比锁定源码空会话工作台。复杂视觉、真实账号和版本写操作未被这些测试替代。

源码到目标文件的完整映射见 migration-map.json；无独立提交时以构建 ID 与测试报告对应，不填虚构提交号。

## Router 扩展

Router 独立验收覆盖对话、候选确认、派发、队列、审批等待、状态回放和 Worker 跳转。原基线 38 项的验收边界保持独立。验证见 [Router 记录](acceptance/router-a1.md) 和 [部署文档](ROUTER.md)。
