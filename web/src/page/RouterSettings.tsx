import * as React from 'react'
import type { ModelOption } from '../../../shared/contracts'
import type { Api } from '../rpc'
import { PsmSettings } from './PsmSettings'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import { useT } from '../i18n'

import { defaultPresentation } from '../../../shared/router-presentation.js'

const voiceFields = [
  ['displayName','助手名称',32], ['selfName','自称',32], ['personality','人格描述',320],
  ['style','语言风格',240], ['wechatStyle','微信表达偏好',320],
] as const

interface Defaults {
  presentation: Record<typeof voiceFields[number][0] | 'brevity',string> &
    { typing:boolean; processingSeconds:number; stageSeconds:number }
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
  const dirty = !!(draft && saved && (draft.projectRoot !== saved.projectRoot || draft.model.model !== saved.model.model || draft.model.effort !== saved.model.effort ||
    JSON.stringify(draft.presentation) !== JSON.stringify(saved.presentation)))
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
      const current = { ...value,presentation:{...defaultPresentation,...value.presentation} }
      setSaved(current); setDraft(current); setError(''); setMessage('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败') }
  }, [api])
  React.useEffect(() => { void load() }, [load])
  const edit = (value: Defaults) => { setDraft(value); setMessage(''); setError('') }
  const save = async () => {
    if (!draft || !dirty || saving) return
    setSaving(true); setError('')
    try {
      const { model, projectRoot, revision, presentation } = draft
      const value = await api<Defaults>('router/settings/save', { model, projectRoot, revision, presentation })
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
      <fieldset className="settings-router-fields" disabled={saving}>
        <legend>助手与表达</legend>
        {voiceFields.map(([key,label,max]) => <label key={key}>{label}
          <input maxLength={max} required value={draft.presentation[key]}
            onChange={e => edit({...draft,presentation:{...draft.presentation,[key]:e.target.value}})}/>
        </label>)}
        <label>回复详略<select value={draft.presentation.brevity}
          onChange={e => edit({...draft,presentation:{...draft.presentation,brevity:e.target.value}})}>
          {['简洁','适中','详细'].map(v=><option key={v}>{v}</option>)}
        </select></label>
      </fieldset>
      <fieldset className="settings-router-fields" disabled={saving}>
        <legend>微信处理反馈</legend>
        <label><input type="checkbox" checked={draft.presentation.typing}
          onChange={e => edit({...draft,presentation:{...draft.presentation,typing:e.target.checked}})}/>显示“正在输入”</label>
        <label>开始提示前等待（秒）<input type="number" min={1} max={60} required value={draft.presentation.processingSeconds}
          onChange={e => edit({...draft,presentation:{...draft.presentation,processingSeconds:Number(e.target.value)}})}/></label>
        <label>阶段提醒前等待（秒）<input type="number" min={draft.presentation.processingSeconds} max={600} required value={draft.presentation.stageSeconds}
          onChange={e => edit({...draft,presentation:{...draft.presentation,stageSeconds:Number(e.target.value)}})}/></label>
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
