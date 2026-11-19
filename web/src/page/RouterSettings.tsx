import * as React from 'react'
import type { ModelOption } from '../../../shared/contracts'
import type { Api } from '../rpc'
import { PsmSettings } from './PsmSettings'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import { useT } from '../i18n'

interface Defaults {
  models: ModelOption[]
  model: { model: string; effort: string }
  projectRoot: string
  revision: number
}

export function RouterSettings({ api, onDirtyChange }: { api: Api; onDirtyChange: (value: boolean) => void }) {
  const t = useT()
  const [saved, setSaved] = React.useState<Defaults | null>(null)
  const [draft, setDraft] = React.useState<Defaults | null>(null)
  const [browse, setBrowse] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const dirty = !!(draft && saved && (draft.projectRoot !== saved.projectRoot || draft.model.model !== saved.model.model || draft.model.effort !== saved.model.effort))
  React.useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  React.useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const load = React.useCallback(async () => {
    try {
      const value = await api<Defaults>('router/settings/read')
      setSaved(value); setDraft(value); setError(''); setMessage('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败') }
  }, [api])
  React.useEffect(() => { void load() }, [load])
  const edit = (value: Defaults) => { setDraft(value); setMessage(''); setError('') }
  const save = async () => {
    if (!draft || !dirty || saving) return
    setSaving(true); setError('')
    try {
      const { model, projectRoot, revision } = draft
      const value = await api<Defaults>('router/settings/save', { model, projectRoot, revision })
      setDraft(value); setSaved(value); setMessage('中枢设置已保存')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setSaving(false) }
  }
  const levels = draft?.models.find(entry => entry.id === draft.model.model)?.supportedReasoningEfforts ?? []
  return <section className="settings-access">
    <header><h2>中枢默认设置</h2><p>会话选择「默认模型」时使用这里的模型和思考强度。</p></header>
    {draft && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className="settings-router-fields" disabled={saving}>
        <label>默认模型<select value={draft.model.model} onChange={e => {
          const option = draft.models.find(row => row.id === e.target.value)!
          const choices = option.supportedReasoningEfforts ?? []
          const effort = choices.some(row => row.reasoningEffort === draft.model.effort) ? draft.model.effort :
            choices.find(row => row.reasoningEffort === option.defaultReasoningEffort)?.reasoningEffort ?? choices[0]?.reasoningEffort ?? ''
          edit({ ...draft, model: { model: option.id, effort } })
        }}>{draft.models.map(option => <option key={option.id} value={option.id}>{option.displayName}</option>)}</select></label>
        <label>默认思考强度<select value={draft.model.effort} onChange={e => edit({ ...draft, model: { ...draft.model, effort: e.target.value } })}>
          {levels.map(level => <option key={level.reasoningEffort} value={level.reasoningEffort}>{t('composer.effort.' + level.reasoningEffort)}</option>)}
        </select></label>
        <div className="settings-router-root"><label htmlFor="router-project-root">新项目父目录</label>
          <div><input id="router-project-root" value={draft.projectRoot} onChange={e => edit({ ...draft, projectRoot: e.target.value })}/>
            <button type="button" className="dsh-codex-button" onClick={() => setBrowse(true)}>浏览目录</button></div>
          <small>新建和克隆的项目会分别存入此目录下的独立文件夹。</small>
        </div>
      </fieldset>
      <div className="settings-form-actions"><button type="submit" className="settings-primary" disabled={!dirty || saving || !levels.length}>保存中枢设置</button></div>
    </form>}
    {error && <p role="alert" className="settings-message is-error">{error} <button className="dsh-codex-button" onClick={() => void load()}>重新加载</button></p>}
    {message && <p role="status" className="settings-message is-success">{message}</p>}
    <PsmSettings api={api}/>
    <DirectoryPickerDialog open={browse} api={api} selectParent onClose={() => setBrowse(false)} onPick={async path => {
      if (draft) edit({ ...draft, projectRoot: path }); setBrowse(false)
    }}/>
  </section>
}
