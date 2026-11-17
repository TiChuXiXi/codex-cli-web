import * as React from 'react'
import type { ThreadTokenUsage } from '../types'
import { contextUsage } from '../context-usage'
import { useT } from '../i18n'

export function ContextUsage({ usage }: { usage?: ThreadTokenUsage | null }) {
  const t = useT()
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const anchor = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('keydown', dismiss)
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('pointerdown', outside)
    }
  }, [open])
  const { used, limit, percent } = contextUsage(usage)
  const number = (value: number) => value.toLocaleString()
  const summary = percent === null ? t('context.unknown') : t('context.percent', { percent })
  const tokens = used === null ? t('context.noData') : limit === null
    ? t('context.used', { used: number(used) })
    : t('context.tokens', { used: number(used), limit: number(limit) })

  return (
    <div ref={anchor} className="dsh-codex-context-usage"
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}
    >
      <button type="button" className="dsh-codex-context-trigger"
        aria-label={t('context.title') + '：' + summary + '，' + tokens}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen(true)}
        data-level={percent !== null && percent >= 90 ? 'high' : undefined}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.5" opacity="0.22" />
          {percent !== null && <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.5"
            pathLength="100" strokeDasharray={percent + ' 100'} transform="rotate(-90 10 10)" />}
          {percent === null && <circle cx="10" cy="10" r="1.5" fill="currentColor" />}
        </svg>
      </button>
      {open && <div className="dsh-codex-context-tooltip" role="tooltip" id={id}>
        <span>{t('context.title')}</span>
        <strong>{summary}</strong>
        <span>{tokens}</span>
        {used !== null && limit === null && <span>{t('context.limitUnknown')}</span>}
        <small>{t('context.snapshot')}</small>
      </div>}
    </div>
  )
}
