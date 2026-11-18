export const workerPermissions = ['read', 'ask', 'approve', 'full']
export const workerModes = ['default', 'plan']

export function permissionPayload(permission, confined = false) {
  if (permission === 'full') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
  if (permission === 'read') return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  return {
    approvalPolicy: 'on-request', approvalsReviewer: permission === 'approve' ? 'auto_review' : 'user',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: permission === 'approve',
      excludeTmpdirEnvVar: confined, excludeSlashTmp: confined },
  }
}
