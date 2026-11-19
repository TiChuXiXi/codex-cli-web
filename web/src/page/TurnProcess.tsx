import * as React from 'react'
import { Icon } from '../components/Icon'
import { useT } from '../i18n'
import './turn-process.css'

export function TurnProcess({ label, onExpand, children }: {
  label?: string
  onExpand: () => void
  children: React.ReactNode
}) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const bodyId = React.useId()
  const processLabel = t('turn.process')
  return <div className="dsh-codex-turn-process">
    <button type="button" className="dsh-codex-turn-process-toggle" aria-expanded={open} aria-controls={bodyId}
      aria-label={label ? processLabel + ' · ' + label : processLabel}
      onClick={() => {
        if (!open) onExpand()
        setOpen(!open)
      }}>
      {label || processLabel}
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
    </button>
    <div id={bodyId} className="dsh-codex-turn-process-body" hidden={!open}>
      {open && children}
    </div>
  </div>
}
