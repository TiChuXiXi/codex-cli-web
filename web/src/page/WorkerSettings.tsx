import * as React from 'react'
import { workerModes, workerPermissions } from '../../../shared/worker-options.js'
import type { ModelOption } from '../../../shared/contracts'
import type { Api } from '../rpc'
import { useT } from '../i18n'
import { SelectMenu } from '../components/SelectMenu'

type Defaults = { defaultModel: string; defaultEffort: string; defaultPermission: string; defaultExecutionMode: string; revision: string }

export function WorkerSettings({api, onDirtyChange}: {api: Api; onDirtyChange: (dirty: boolean) => void}) {
  const t = useT()
  const [models,setModels] = React.useState<ModelOption[]>([])
  const [saved,setSaved] = React.useState<Defaults>()
  const [draft,setDraft] = React.useState<Defaults>()
  const [error,setError] = React.useState('')
  const [message,setMessage] = React.useState('')
  const [busy,setBusy] = React.useState(false)
  const dirty = !!draft && JSON.stringify(saved) !== JSON.stringify(draft)
  React.useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty,onDirtyChange])
  React.useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue='' }
    window.addEventListener('beforeunload',warn)
    return () => window.removeEventListener('beforeunload',warn)
  },[dirty])
  const load = React.useCallback(async () => {
    try {
      const [options,value] = await Promise.all([api<ModelOption[]>('models/list'),api<Defaults>('settings/worker/read')])
      setModels(options);setSaved(value);setDraft(value);setError('');setMessage('')
    } catch(e) { setError(e instanceof Error ? e.message : '无法读取 Worker 设置') }
  },[api])
  React.useEffect(() => { void load() },[load])
  const edit = (patch: Partial<Defaults>) => { if (draft) setDraft({...draft,...patch});setMessage('');setError('') }
  const save = async () => {
    if (!dirty || busy) return
    setBusy(true)
    try {
      const value = await api<Defaults>('settings/worker/save',draft)
      setDraft(value);setSaved(value);setMessage('Worker 默认设置已保存');setError('')
    } catch(e) { setError(e instanceof Error ? e.message : '保存失败') }
    finally { setBusy(false) }
  }
  const levels = models.find(m => m.id === draft?.defaultModel)?.supportedReasoningEfforts ?? []
  return <section className="settings-access"><header><h2>Worker 默认设置</h2>
    <p>新会话使用这些设置。Router 派发时可为单个任务指定模型、思考强度、权限和执行模式。</p></header>
    {draft && <form onSubmit={e=>{e.preventDefault();void save()}}><fieldset disabled={busy} className="settings-router-fields">
      <label>默认模型<SelectMenu label="默认模型" value={draft.defaultModel} options={models.map(m=>({value:m.id,label:m.displayName}))} onChange={value=>{
        const m=models.find(row=>row.id===value)!
        const levels=m.supportedReasoningEfforts ?? []
        edit({defaultModel:m.id,defaultEffort:levels.some(x=>x.reasoningEffort===draft.defaultEffort)?draft.defaultEffort:m.defaultReasoningEffort || levels[0]?.reasoningEffort || ''})
      }} /></label>
      <label>默认思考强度<SelectMenu label="默认思考强度" value={draft.defaultEffort} onChange={value=>edit({defaultEffort:value})} options={levels.map(x=>({value:x.reasoningEffort,label:t('composer.effort.'+x.reasoningEffort)}))} /></label>
      <label>新会话权限<SelectMenu label="新会话权限" value={draft.defaultPermission} onChange={value=>edit({defaultPermission:value})} options={[{value:'inherit',label:'沿用项目或 Codex 配置'},...workerPermissions.map(x=>({value:x,label:t('permission.'+x)}))]} /></label>
      {draft.defaultPermission==='full' && <small>完全访问允许 Worker 在工作区外修改文件、访问网络并免审批执行命令。</small>}
      <label>默认执行模式<SelectMenu label="默认执行模式" value={draft.defaultExecutionMode} onChange={value=>edit({defaultExecutionMode:value})} options={workerModes.map(x=>({value:x,label:x==='plan'?'计划模式':'普通执行'}))} /></label>
      </fieldset><div className="settings-form-actions"><button className="settings-primary" disabled={!dirty||busy||!levels.length}>保存 Worker 设置</button></div></form>}
    {error && <p role="alert">{error} <button className="dsh-codex-button" onClick={()=>void load()}>重新加载</button></p>}
    {message && <p role="status">{message}</p>}
  </section>
}
