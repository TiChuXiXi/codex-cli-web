import * as React from 'react'
import { createPortal } from 'react-dom'
import type { EffortOption, ModelOption } from '../../../shared/contracts'
import { Icon } from '../components/Icon'
import { useT } from '../i18n'

export type ModelMenu = null | 'root' | 'model'

const FALLBACK_EFFORTS: EffortOption[] = [
  { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
  { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
  { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  { reasoningEffort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
  { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
]

export function ModelPicker({ models, model, effort, menu, setMenu, onModelChange, onEffortChange, onToggle, usingDefault = model === '', disabled = false }: {
  models: ModelOption[]
  model: string
  effort: string
  menu: ModelMenu
  setMenu: (value: ModelMenu) => void
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  usingDefault?: boolean
  disabled?: boolean
  onToggle?: () => void
}) {
  const t = useT()
  const trigger = React.useRef<HTMLButtonElement>(null)
  const card = menu && trigger.current?.closest('.dsh-codex-composer-card')
  React.useEffect(() => {
    if (!menu) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menu, setMenu])
  const currentModel = models.find((entry) => entry.id === model)
  const modelLabel = currentModel?.displayName ?? (model === '' ? t('composer.defaultModel') : model)
  const efforts = currentModel?.supportedReasoningEfforts?.length
    ? currentModel.supportedReasoningEfforts
    : FALLBACK_EFFORTS
  const defaultEffort = currentModel?.defaultReasoningEffort ?? null
  const effortIndex = Math.max(0, efforts.findIndex(option => option.reasoningEffort === (effort || defaultEffort)))
  const level = efforts[effortIndex]?.reasoningEffort ?? effort
  const key = 'composer.effort.' + level
  const effortLabel = t(key) === key ? level : t(key)
  const effortProgress = efforts.length > 1 ? effortIndex / (efforts.length - 1) * 100 : 0

  return <>
    <button
      type="button"
      ref={trigger}
      className="dsh-codex-model-trigger"
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={menu !== null}
      title={`${modelLabel} · ${effortLabel}`}
      onClick={() => {
        setMenu(menu === null ? 'root' : null)
        onToggle?.()
      }}
    >
      <Icon name="model" size={16}/>
      <span className="dsh-codex-model-label">{modelLabel}</span>
      <span className="dsh-codex-model-effort">· {effortLabel}</span>
      <Icon name="chevronDown" size={16}/>
    </button>
    {card && createPortal(
      <>
        <div className="dsh-codex-menu-backdrop" onPointerDown={() => setMenu(null)} />
        <div className="dsh-codex-menu" role="menu">
          {menu === 'root' ? (
            <>
              <button type="button" className="dsh-codex-menu-cell" onClick={() => setMenu('model')}>
                <span className="dsh-codex-menu-cell-label">{t('composer.model')}</span>
                <strong className="dsh-effort-current" aria-label={t('composer.effort')}>{effortLabel}</strong>
                <span className="dsh-codex-menu-cell-value">{modelLabel}</span>
                <Icon name="chevronRight" size={16}/>
              </button>
              <div className="dsh-effort-inline">
                <div className="dsh-effort-track" style={{'--effort-progress': effortProgress + '%', '--effort-offset': (13 - effortProgress * .26) + 'px', '--effort-color': `hsl(211 82% ${42 + effortProgress * .18}%)`} as React.CSSProperties}>
                  <div className="dsh-effort-fill"/>
                  <div className="dsh-effort-dots" aria-hidden="true">{efforts.map((option, index) => <i key={option.reasoningEffort} className={index < effortIndex ? 'is-active' : ''}/>)}</div>
                  <span className="dsh-effort-thumb" aria-hidden="true"/>
                  <input type="range" min={0} max={Math.max(0, efforts.length - 1)} step={1}
                    disabled={disabled || efforts.length < 2} value={effortIndex}
                    aria-label={t('composer.effort')} aria-valuetext={effortLabel}
                    onChange={event => onEffortChange(efforts[Number(event.target.value)].reasoningEffort)}/>
                </div>
              </div>
            </>
          ) : null}

          {menu === 'model' ? (
            <>
              <button type="button" className="dsh-codex-menu-back" onClick={() => setMenu('root')}><Icon name="chevronLeft" size={16}/>{t('composer.model')}</button>
              <div className="dsh-codex-menu-list model-name-list">
                {models.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    disabled={disabled}
                    role="menuitemradio"
                    aria-checked={entry.id === model && !usingDefault}
                    className={`dsh-codex-menu-item ${entry.id === model && !usingDefault ? 'selected' : ''}`}
                    onClick={() => {
                      onModelChange(entry.id)
                      setMenu('root')
                    }}
                  >
                    <span className="dsh-codex-menu-check">{entry.id === model && !usingDefault ? <Icon name="check" size={16}/> : null}</span>
                    <span className="dsh-codex-menu-meta">
                      <span className="dsh-codex-menu-name">{entry.displayName}</span>

                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  disabled={disabled}
                  role="menuitemradio"
                  aria-checked={usingDefault}
                  className={`dsh-codex-menu-item ${usingDefault ? 'selected' : ''}`}
                  onClick={() => {
                    onModelChange('')
                    setMenu('root')
                  }}
                >
                  <span className="dsh-codex-menu-check">{usingDefault ? <Icon name="check" size={16}/> : null}</span>
                  <span className="dsh-codex-menu-meta">
                    <span className="dsh-codex-menu-name">{t('composer.defaultModel')}</span>
                  </span>
                </button>
              </div>
            </>
          ) : null}

        </div>
      </>, card
    )}
  </>
}
