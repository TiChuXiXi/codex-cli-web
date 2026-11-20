export const defaultPresentation = Object.freeze({
  displayName: '中枢', selfName: '我', personality: '专业、温和、做事利落。',
  style: '自然交流，直接回答，少用内部术语。', brevity: '简洁',
  wechatStyle: '短句；先说结果或需要我决定的事项。命令、目录和选项按实际内容保留。',
  typing: true, processingSeconds: 3, stageSeconds: 15,
})

const permissions = {
  psmAccess: { legacy: '允许 Router 阅读此项目的会话历史？', action: '读取这个项目的会话历史' },
  project: { legacy: '允许 Router 使用此项目并继续当前任务？', action: '使用这个项目继续当前任务' },
  session: { legacy: '允许 Router 按这个会话的现有权限续接？', action: '沿用这个会话的现有权限继续任务' },
}

export function clarificationLabel(item, selfName = defaultPresentation.selfName) {
  const prompt = permissions[item.kind]
  // Older pending cards only stored the built-in title. Preserve custom questions verbatim.
  if (prompt && (item.permissionQuestion || (!item.semanticChoice && item.label === prompt.legacy))) {
    return '可以让' + selfName + prompt.action + '吗？'
  }
  return item.label
}
