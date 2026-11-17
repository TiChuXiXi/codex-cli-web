# 界面继承约定

模式：Operate。视觉权威为锁定提交的 ConsolePage、styles.ts、workbench-styles.ts、SidebarWorkspace 以及 vendor/dsh-dockkit；历史 shots 仅辅助参考。

保留基础样式后叠加 WORKBENCH_CSS 的顺序。保留 --codex-*、--dsw-* 和 .dsh-codex-root，不依赖外部 DSH 注入。左栏默认 280px，范围 260–420px；右栏恢复宽度 480px，范围 320–1100px。窄屏按现有 768px 断点行为执行，canSplit=false。

复用现有字体栈、Lucide 图标、浅深主题、组件边框、圆角、菜单和主题动画。消息间距由容器 gap 与末尾 Markdown margin 清零共同控制。审批、队列、附件、文件和终端状态不得用占位组件替换。

独立登录沿用界面字体，使用同一蓝色体系中满足白字对比度的 #3264cd 登录按钮；工作台原操作色保持不变，表单标签、错误、等待、禁用与键盘焦点明确。原“返回 DeepSeek Harness”所在位置改为“退出 Web 登录”，作为独立宿主允许差异。

受控对比使用四种视口、两种主题，精确规则与阈值记录在 docs/acceptance/parity/report.json。不得以历史截图替代受控金样，也不得将空会话的通过扩展为全部复杂场景通过。
