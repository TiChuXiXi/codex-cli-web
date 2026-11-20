import * as React from 'react'
import type { ModelOption, RouterExpressionSettings } from '../../../shared/contracts'
import type { Api } from '../rpc'
import { PsmSettings } from './PsmSettings'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import { useT } from '../i18n'
import { SelectMenu } from '../components/SelectMenu'

import { defaultProfile,profileSettings,validateProfile,dimensions,policies } from '../../../shared/router-presentation.js'
import { RouterExpressionPreview } from './RouterExpressionPreview'
import { RouterPersonalityEditor } from './RouterPersonalityEditor'

interface Defaults extends RouterExpressionSettings {
  expressionError?: string
  models: ModelOption[]
  model: { model: string; effort: string }
  projectRoot: string
  revision: number
}

const incompatibleService = 'Web 服务尚未返回结构化人格设置。请重启到新版 Web 服务后再次保存，当前修改已保留。'

function readDefaults(value: Defaults, requireProfile: boolean): Defaults {
  if (value?.expressionError) throw new Error(value.expressionError)
  if (requireProfile && value?.profileVersion !== 1) throw new Error(incompatibleService)
  if (!value?.model || !Array.isArray(value.models) || !Number.isSafeInteger(value.revision)) {
    throw new Error('中枢设置回包不完整，请重试。')
  }
  return { ...value, ...profileSettings(value) } as Defaults
}

type Conflict = {path:string[]; mine:unknown; latest:unknown}
function fieldLabel(path:string[]) {
  const labels:Record<string,string>={...Object.fromEntries(Object.entries({...dimensions,...policies}).map(([k,v])=>[k,v.label])),name:'助手名称',selfReference:'自称',preset:'人格预设',customExpression:'额外表达偏好',model:'模型',projectRoot:'新项目父目录',typing:'正在输入',stageSeconds:'阶段提醒',processingSeconds:'开始提示'}
  return labels[path.at(-1)!] ?? '原有表达偏好'
}
function putPath(target:Defaults,path:string[],value:unknown) {
  const parent=path.slice(0,-1).reduce((obj,key)=>obj[key],target as any)
  if(value===undefined) delete parent[path.at(-1)!]
  else parent[path.at(-1)!]=value
}
function rebase(saved:Defaults,draft:Defaults,latest:Defaults) {
  const merged=structuredClone(latest)
  const conflicts:Conflict[]=[]
  function visit(base:any,local:any,remote:any,path:string[]) {
    if(local && typeof local==='object' && path[0]!=='model') {
      for(const key of new Set([...Object.keys(base ?? {}),...Object.keys(local)]))visit(base?.[key],local[key],remote?.[key],[...path,key])
    } else if(JSON.stringify(local)!==JSON.stringify(base)) {
      if(JSON.stringify(remote)!==JSON.stringify(base) && JSON.stringify(local)!==JSON.stringify(remote))
        conflicts.push({path,mine:local,latest:remote})
      putPath(merged,path,local)
    }
  }
  for(const k of ['model','projectRoot','profile','wechatProcessing','legacyExpression'] as const)visit(saved[k],draft[k],latest[k],[k])
  return {merged,conflicts}
}
export function RouterSettings({ api, onDirtyChange }: { api: Api; onDirtyChange: (value: boolean) => void }) {
  const t = useT()
  const [saved, setSaved] = React.useState<Defaults | null>(null)
  const [draft, setDraft] = React.useState<Defaults | null>(null)
  const [browse, setBrowse] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const supportsProfile = React.useRef(false)
  const [conflicts,setConflicts]=React.useState<Conflict[]>([])
  const dirty = !!(draft && saved && (draft.projectRoot !== saved.projectRoot || draft.model.model !== saved.model.model || draft.model.effort !== saved.model.effort ||
    ['profile','wechatProcessing','legacyExpression'].some(k=>JSON.stringify(draft[k as keyof Defaults])!==JSON.stringify(saved[k as keyof Defaults]))))
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
      const current = readDefaults(value, false)
      supportsProfile.current = value.profileVersion === 1
      setSaved(current); setDraft(current); setError(''); setMessage('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败') }
  }, [api])
  React.useEffect(() => { void load() }, [load])
  const edit = (value: Defaults) => { setDraft(value); setMessage(''); setError('') }
  const save = async () => {
    if (!draft || !saved || !dirty || saving || conflicts.length) return
    setSaving(true); setError('')
    try {
      const { model, projectRoot, revision, profileVersion, profile, wechatProcessing, legacyExpression } = draft
      // A legacy process serves the rebuilt UI but silently ignores structured fields.
      // Check again on retry so an upgrade can complete without discarding the draft.
      if (!supportsProfile.current) {
        readDefaults(await api<Defaults>('router/settings/read'), true)
        supportsProfile.current = true
      }
      const value = await api<Defaults>('router/settings/save', { model, projectRoot, revision, profileVersion, profile, wechatProcessing, legacyExpression })
      supportsProfile.current = value?.profileVersion === 1
      const confirmed = readDefaults(value, true)
      if (confirmed.revision !== revision + 1 || JSON.stringify(confirmed.profile) !== JSON.stringify(validateProfile(profile))) {
        throw new Error('服务端未确认本次人格设置，当前修改已保留。')
      }
      setDraft(confirmed); setSaved(confirmed); setMessage('中枢设置已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
      if ((cause as {code?:string})?.code==='codex-cli/router-stale') {
        try {
          const latest=readDefaults(await api<Defaults>('router/settings/read'), true)
          const {merged,conflicts}=rebase(saved,draft,latest)
          setSaved(latest);setDraft(merged);setConflicts(conflicts)
          setError('设置已在其他位置更新。请核对保留的修改后再保存。')
        } catch (error) { setError(error instanceof Error ? error.message : '无法读取最新设置。草稿已保留，请重试。') }
      }
    }
    finally { setSaving(false) }
  }
  const levels = draft?.models.find(entry => entry.id === draft.model.model)?.supportedReasoningEfforts ?? []
  return <section className="settings-access rip-settings">
    <header><h2>助手与表达</h2><p>设置中枢的称呼和交流方式，在示例中查看变化。</p></header>
    {draft && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="rip-layout"><fieldset disabled={saving || conflicts.length>0}><RouterPersonalityEditor profile={draft.profile} legacyExpression={draft.legacyExpression} onChange={update=>edit({...draft,...update})}/></fieldset>
        <RouterExpressionPreview profile={draft.profile}/></div>
      <h3>中枢默认设置</h3>
      <fieldset className="settings-router-fields" disabled={saving || conflicts.length>0}>
        <label>默认模型<SelectMenu label="默认模型" value={draft.model.model} options={draft.models.map(option=>({value:option.id,label:option.displayName}))} onChange={value => {
          const option = draft.models.find(row => row.id === value)!
          const choices = option.supportedReasoningEfforts ?? []
          const effort = choices.some(row => row.reasoningEffort === draft.model.effort) ? draft.model.effort :
            choices.find(row => row.reasoningEffort === option.defaultReasoningEffort)?.reasoningEffort ?? choices[0]?.reasoningEffort ?? ''
          edit({ ...draft, model: { model: option.id, effort } })
        }} /></label>
        <label>默认思考强度<SelectMenu label="默认思考强度" value={draft.model.effort} onChange={value => edit({ ...draft, model: { ...draft.model, effort: value } })} options={levels.map(level=>({value:level.reasoningEffort,label:t('composer.effort.' + level.reasoningEffort)}))} /></label>
        <div className="settings-router-root"><label htmlFor="router-project-root">新项目父目录</label>
          <div><input id="router-project-root" value={draft.projectRoot} onChange={e => edit({ ...draft, projectRoot: e.target.value })}/>
            <button type="button" className="dsh-codex-button" onClick={() => setBrowse(true)}>浏览目录</button></div>
          <small>新建和克隆的项目会分别存入此目录下的独立文件夹。</small>
        </div>
      </fieldset>
      <fieldset className="settings-router-fields" disabled={saving || conflicts.length>0}>
        <legend>微信处理反馈</legend>
        <label className="settings-checkbox"><input type="checkbox" checked={draft.wechatProcessing.typing}
          onChange={e => edit({...draft,wechatProcessing:{...draft.wechatProcessing,typing:e.target.checked}})}/>显示“正在输入”</label>
        <label>开始提示前等待（秒）<input type="number" min={1} max={60} required value={draft.wechatProcessing.processingSeconds}
          onChange={e => edit({...draft,wechatProcessing:{...draft.wechatProcessing,processingSeconds:Number(e.target.value)}})}/></label>
        <label>阶段提醒前等待（秒）<input type="number" min={draft.wechatProcessing.processingSeconds} max={600} required value={draft.wechatProcessing.stageSeconds}
          onChange={e => edit({...draft,wechatProcessing:{...draft.wechatProcessing,stageSeconds:Number(e.target.value)}})}/></label>
      </fieldset>
      <div className="rip-save">
        {!!conflicts.length && <div role="alert">{conflicts.map(c=><div key={c.path.join('.')}><strong>{fieldLabel(c.path)}</strong>
          {[['保留我的',c.mine],['使用最新',c.latest]].map(([label,value])=><button type="button" key={String(label)} onClick={()=>{
            const next=structuredClone(draft);putPath(next,c.path,value);setDraft(next);setConflicts(conflicts.filter(x=>x!==c))
          }}>{String(label)} · {typeof value==='object'?JSON.stringify(value):String(value ?? '空')}</button>)}</div>)}</div>}
        <div className="rip-save-actions"><span role="status">{dirty?'有未保存的修改':message || '已保存'}</span>
        <button type="button" disabled={saving || !!conflicts.length} onClick={()=>edit({...draft,profile:defaultProfile(),legacyExpression:{}})}>恢复默认</button>
        <button type="button" disabled={saving || !dirty && !conflicts.length} onClick={()=>{if(saved)edit(saved);setConflicts([])}}>取消修改</button>
        <button type="submit" className="settings-primary" disabled={!dirty || saving || !!conflicts.length || !levels.length}>{saving?'保存中…':'保存'}</button></div>
        {error && <p role="alert">{error}</p>}
      </div>
    </form>}
    {!draft && error && <p role="alert">{error} <button onClick={()=>void load()}>重试</button></p>}
    <PsmSettings api={api}/>
    <DirectoryPickerDialog open={browse} api={api} selectParent onClose={() => setBrowse(false)} onPick={async path => {
      if (draft) edit({ ...draft, projectRoot: path }); setBrowse(false)
    }}/>
  </section>
}
