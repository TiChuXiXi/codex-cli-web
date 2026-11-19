/** 审批与用户输入卡片：服务端请求在这里落地成人能看懂的按钮。 */

import { approvalDetails } from '../../../shared/approval-details.js'
import * as React from 'react'
import { useT } from '../i18n'
import type { PendingApproval } from '../types'
import { QuestionForm } from './QuestionForm'

export interface ApprovalStackProps {
  approvals: PendingApproval[]
  onRespond: (requestId: string | number, response: any, instanceId: string) => Promise<void>
}

export function ApprovalStack({ approvals, onRespond }: ApprovalStackProps) {
  if (approvals.length === 0) return null
  return (
    <div className="dsh-codex-approvals">
      {approvals.map((approval) => (
        <ApprovalCard key={approval.instanceId} approval={approval} onRespond={onRespond} />
      ))}
    </div>
  )
}

export function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: PendingApproval
  onRespond: (requestId: string | number, response: any, instanceId: string) => Promise<void>
}) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const params = approval.params ?? {}
  const details = approvalDetails(approval)

  const respond = async (response: any) => {
    if (busy) return
    setBusy(true)
    try {
      await onRespond(approval.requestId, response, approval.instanceId)
    } catch {
      // ConsolePage reports the error; keep the request available for retry.
    } finally {
      setBusy(false)
    }
  }

  if (approval.method === 'item/tool/requestUserInput') {
    return <InputCard approval={approval} onRespond={response => onRespond(approval.requestId, response, approval.instanceId)} />
  }

  if (approval.method === 'item/commandExecution/requestApproval') {
    return (
      <Shell title={t('approval.command')} busy={busy}>
        <pre className="dsh-codex-command">{details?.text}</pre>
        <Actions>
          <button type="button" className="dsh-codex-button primary" disabled={busy || !details?.allow} onClick={() => void respond({ decision: 'accept' })}>
            {t('approval.allow')}
          </button>
          <button type="button" className="dsh-codex-button" disabled={busy || !details?.session} onClick={() => void respond({ decision: 'acceptForSession' })}>
            {t('approval.allowSession')}
          </button>
          {details?.deny && <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void respond({ decision: 'decline' })}>
            {t('approval.deny')}
          </button>}
          {details?.cancel && <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void respond({ decision: 'cancel' })}>
            {t('approval.cancel')}
          </button>}
        </Actions>
      </Shell>
    )
  }

  if (approval.method === 'item/fileChange/requestApproval') {
    return (
      <Shell title={t('approval.file')} busy={busy}>
        <pre className="dsh-codex-pre">{details?.text}</pre>
        <Actions>
          <button type="button" className="dsh-codex-button primary" disabled={busy || !details?.allow} onClick={() => void respond({ decision: 'accept' })}>
            {t('approval.allow')}
          </button>
          <button type="button" className="dsh-codex-button" disabled={busy || !details?.session} onClick={() => void respond({ decision: 'acceptForSession' })}>
            {t('approval.allowSession')}
          </button>
          {details?.deny && <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void respond({ decision: 'decline' })}>
            {t('approval.deny')}
          </button>}
          {details?.cancel && <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void respond({ decision: 'cancel' })}>
            {t('approval.cancel')}
          </button>}
        </Actions>
      </Shell>
    )
  }

  if (approval.method === 'item/permissions/requestApproval') {
    return (
      <Shell title={t('approval.permissions')} busy={busy}>
        <pre className="dsh-codex-pre">{details?.text}</pre>
        <Actions>
          <button
            type="button"
            className="dsh-codex-button primary"
            disabled={busy || !details?.allow}
            onClick={() => void respond({ permissions: params.permissions ?? {}, scope: 'turn' })}
          >
            {t('approval.allowTurn')}
          </button>
          <button
            type="button"
            className="dsh-codex-button"
            disabled={busy || !details?.allow}
            onClick={() => void respond({ permissions: params.permissions ?? {}, scope: 'session' })}
          >
            {t('approval.allowSession')}
          </button>
          <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void respond({ permissions: {}, scope: 'turn' })}>
            {t('approval.deny')}
          </button>
        </Actions>
      </Shell>
    )
  }

  return (
    <Shell title={t('approval.elicitation')} busy={busy}>
      <pre className="dsh-codex-pre">{JSON.stringify(params, null, 2)}</pre>
      <Actions>
        <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void respond({ action: 'decline', content: null, _meta: null })}>
          {t('approval.deny')}
        </button>
        <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void respond({ action: 'cancel', content: null, _meta: null })}>
          {t('approval.cancel')}
        </button>
      </Actions>
    </Shell>
  )
}

function InputCard({ approval, onRespond }: {
  approval: PendingApproval
  onRespond: (response: any) => Promise<void>
}) {
  const t = useT()
  const questions = Array.isArray(approval.params?.questions) ? approval.params.questions : []
  return <Shell title={t('approval.input')} busy={false}>
    <QuestionForm questions={questions} onSubmit={values => onRespond({
      answers: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { answers: [value] }])),
    })} />
  </Shell>
}

function Shell({ title, busy, children }: { title: string, busy: boolean, children: React.ReactNode }) {
  return (
    <section className={`dsh-codex-approval ${busy ? 'busy' : ''}`}>
      <header className="dsh-codex-approval-head">
        <span className="dsh-codex-dot warn pulse" />
        <strong>{title}</strong>
      </header>
      {children}
    </section>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="dsh-codex-approval-actions">{children}</div>
}
