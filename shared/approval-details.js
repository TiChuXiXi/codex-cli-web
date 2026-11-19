// Only native request fields and the exact associated item may describe an approval.
const command = 'item/commandExecution/requestApproval'
const file = 'item/fileChange/requestApproval'
const permission = 'item/permissions/requestApproval'
const value = input => typeof input === 'string' && input.trim() ? input : ''
const object = input => input && typeof input === 'object' && !Array.isArray(input)
const format = input => typeof input === 'string' ? input : JSON.stringify(input, null, 2)

export function approvalDetails({ method, params = {} }) {
  const lines = []
  let complete = false
  if (method === command) {
    const network = params.networkApprovalContext
    if (network) lines.push('网络访问：' + format(network))
    if (value(params.command)) lines.push('执行命令\n' + params.command)
    if (params.additionalPermissions) lines.push('附加权限：' + format(params.additionalPermissions))
    complete = Boolean((value(params.command) && value(params.cwd)) || value(network?.host))
  } else if (method === file) {
    if (value(params.grantRoot)) lines.push('文件变更授权范围：' + params.grantRoot)
    if (Array.isArray(params.changes) && params.changes.length && params.changes.every(change => value(change?.path))) {
      for (const change of params.changes) lines.push('文件变更：' + change.path + (change.kind ? ' · ' + format(change.kind) : ''))
      complete = true
    }
    complete ||= Boolean(value(params.grantRoot))
  } else if (method === permission) {
    if (object(params.permissions) && Object.keys(params.permissions).length) {
      lines.push('本次权限范围：' + format(params.permissions))
      complete = true
    }
  } else return null
  if (value(params.cwd)) lines.push('目录：' + params.cwd)
  lines.push('用途：' + (value(params.reason) || '请求方未提供'))
  if (!complete) lines.push('缺少可核实的操作或授权范围，暂时只能拒绝或稍后查看。')
  const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : null
  return { text: lines.join('\n'), complete,
    allow: complete && (!decisions || decisions.includes('accept')),
    session: complete && (!decisions || decisions.includes('acceptForSession')),
    deny: !decisions || decisions.includes('decline'), cancel: Boolean(decisions?.includes('cancel')) }
}
