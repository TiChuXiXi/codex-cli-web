import * as React from 'react'
import { Icon } from '../components/Icon'
import type { Api } from '../rpc'
import type { AccessSettings } from '../../../shared/contracts'
import { VersionsPanel } from './VersionsPanel'
import { RouterSettings } from './RouterSettings'
import { WorkerSettings } from './WorkerSettings'
import './settings.css'

export function SettingsPage({api,onClose,onDirtyChange,routerEnabled}:{api:Api;onClose:()=>void;onDirtyChange:(dirty:boolean)=>void;routerEnabled:boolean}) {
  const [tab,setTab]=React.useState<'versions'|'access'|'worker'|'router'>('versions')
  const [workerDirty,setWorkerDirty]=React.useState(false)
  const [visitedWorker,setVisitedWorker]=React.useState(false)
  const [accessDirty,setAccessDirty]=React.useState(false)
  const [routerDirty,setRouterDirty]=React.useState(false)
  const [visitedRouter,setVisitedRouter]=React.useState(false)
  React.useEffect(()=>{onDirtyChange(accessDirty||routerDirty||workerDirty);return()=>onDirtyChange(false)},[accessDirty,routerDirty,workerDirty,onDirtyChange])
  React.useEffect(()=>{if(tab==='worker')setVisitedWorker(true)},[tab])
  React.useEffect(()=>{if(tab==='router')setVisitedRouter(true)},[tab])
  React.useEffect(()=>{
    const previous=document.activeElement
    document.getElementById('settings-tab-versions')?.focus()
    return()=>{if(previous instanceof HTMLElement && previous.isConnected)previous.focus()}
  },[])
  return <section className="codex-settings" aria-label="应用设置">
    <header className="settings-page-header">
      <p>工作台设置</p>
      <button type="button" className="dsh-codex-button" onClick={onClose}><Icon name="arrowLeft" size={15}/>返回工作台</button>
    </header>
    <nav className="settings-nav" role="tablist" aria-label="设置分类">
      {([{id:'versions',label:'版本与更新',icon:'download'},{id:'access',label:'访问白名单',icon:'shield'},{id:'worker',label:'Worker',icon:'settings'},{id:'router',label:'中枢',icon:'orbit'}] as const).filter(entry=>entry.id!=='router'||routerEnabled).map((entry,index,entries)=>
        <button key={entry.id} type="button" role="tab" id={'settings-tab-'+entry.id} aria-controls={'settings-panel-'+entry.id} aria-selected={tab===entry.id} tabIndex={tab===entry.id?0:-1} onClick={()=>setTab(entry.id)} onKeyDown={event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||event.nativeEvent.isComposing)return
          event.preventDefault()
          const target=event.key==='Home'?entries[0]:event.key==='End'?entries.at(-1)!:entries[(index+(event.key==='ArrowRight'?1:entries.length-1))%entries.length]
          setTab(target.id);document.getElementById('settings-tab-'+target.id)?.focus()
        }}><Icon name={entry.icon} size={17}/>{entry.label}</button>)}
    </nav>
    <div id="settings-panel-versions" role="tabpanel" aria-labelledby="settings-tab-versions" hidden={tab!=='versions'}>
      <VersionsPanel api={api}/>
    </div>
    <div id="settings-panel-access" role="tabpanel" aria-labelledby="settings-tab-access" hidden={tab!=='access'}>
      <WhitelistSettings api={api} onDirtyChange={setAccessDirty}/>
    </div>
    <div id="settings-panel-worker" role="tabpanel" aria-labelledby="settings-tab-worker" hidden={tab!=='worker'}>
      {visitedWorker && <WorkerSettings api={api} onDirtyChange={setWorkerDirty}/>}
    </div>
    {routerEnabled && <div id="settings-panel-router" role="tabpanel" aria-labelledby="settings-tab-router" hidden={tab!=='router'}>
      {visitedRouter && <RouterSettings api={api} onDirtyChange={setRouterDirty}/>}
    </div>}
  </section>
}
function messageOf(error:unknown){return error instanceof Error?error.message:'请求失败，请重试'}

function WhitelistSettings({api,onDirtyChange}:{api:Api;onDirtyChange:(dirty:boolean)=>void}) {
  const [settings,setSettings]=React.useState<AccessSettings|null>(null)
  const [entries,setEntries]=React.useState<string[]>([])
  const [loading,setLoading]=React.useState(true)
  const [saving,setSaving]=React.useState(false)
  const [error,setError]=React.useState('')
  const [success,setSuccess]=React.useState('')
  const [confirmation,setConfirmation]=React.useState<string[]|null>(null)
  const [disconnected,setDisconnected]=React.useState(false)
  const alive=React.useRef(true)
  const saved=React.useRef(false)
  const normalized=entries.map(value=>value.trim()).filter(Boolean)
  const dirty=settings!==null && JSON.stringify(normalized)!==JSON.stringify(settings.allowedClients)
  React.useEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false)},[dirty,onDirtyChange])
  React.useEffect(()=>{
    if(!dirty)return
    const before=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''}
    window.addEventListener('beforeunload',before)
    return()=>window.removeEventListener('beforeunload',before)
  },[dirty])
  const load=React.useCallback(async()=>{
    setLoading(true);setError('');setConfirmation(null)
    try {
      const value=await api<AccessSettings>('settings/read')
      if(!alive.current)return
      setSettings(value);setEntries(value.allowedClients)
    }catch(error){if(alive.current)setError(messageOf(error))}
    finally{if(alive.current)setLoading(false)}
  },[api])
  React.useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false}},[load])
  const save=async(confirmSelfRemoval=false)=>{
    if(saved.current || !settings)return
    saved.current=true;setSaving(true);setError('');setSuccess('')
    const allowedClients=confirmSelfRemoval && confirmation?confirmation:normalized
    try {
      const next=await api<AccessSettings & {disconnecting:boolean}>('settings/whitelist',{allowedClients,revision:settings.revision,confirmSelfRemoval})
      if(!alive.current)return
      setSettings(next);setEntries(next.allowedClients);setConfirmation(null)
      setDisconnected(next.disconnecting)
      setSuccess(next.disconnecting?'已保存。当前 IP 已移出白名单，请从仍在名单中的设备访问。':'白名单已保存并立即生效。'+(next.firewallManaged?'服务器防火墙已同步。':''))
    }catch(error){
      if(!alive.current)return
      if((error as {code?:string}).code==='codex-cli/settings-self-removal')setConfirmation(allowedClients)
      else setError(messageOf(error))
    }finally{saved.current=false;if(alive.current)setSaving(false)}
  }
  const change=(index:number,value:string)=>{setEntries(previous=>previous.map((entry,i)=>i===index?value:entry));setError('');setSuccess('');setConfirmation(null)}
  return <section className="settings-access" aria-labelledby="settings-access-title">
    <header><h2 id="settings-access-title">访问白名单</h2><p>管理能够访问工作台的客户端 IP。保存后立即生效，服务重启后仍会保留。</p></header>
    {loading && !settings?<p role="status" className="settings-loading">正在读取访问设置…</p>:null}
    {settings && <>
      <dl className="settings-access-facts">
        <div><dt>访问模式</dt><dd>{settings.authMode==='network'?'IP 白名单 · 免登录':'登录凭证'}</dd></div>
        <div><dt>当前访问 IP</dt><dd><code>{settings.clientIp ?? '未知'}</code></dd></div>
      </dl>
      {settings.authMode!=='network'?<p className="settings-notice">当前使用登录凭证模式。此名单将在启用 IP 白名单模式后用于访问控制。</p>:null}
      {settings.lockedReason?<p className="settings-notice">{settings.lockedReason}</p>:null}
      <form onSubmit={event=>{event.preventDefault();void save()}} aria-busy={saving}>
        <fieldset disabled={saving || !settings.editable || disconnected}>
          <legend>允许访问的 IP 或网段</legend>
          <p className="settings-field-help">支持单个 IP（如 192.168.1.80）或 CIDR 网段，每行一项。</p>
          <div className="settings-ip-list">
            {entries.map((entry,index)=><div className="settings-ip-row" key={index}>
              <label className="settings-sr-only" htmlFor={'allowed-ip-'+index}>允许访问的 IP {index+1}</label>
              <input id={'allowed-ip-'+index} value={entry} onChange={event=>change(index,event.target.value)} autoComplete="off" spellCheck={false} placeholder="例如 192.168.1.80"/>
              <button type="button" className="settings-remove" aria-label={'移除 IP '+(index+1)} onClick={()=>{setEntries(previous=>previous.filter((_,i)=>i!==index));setConfirmation(null);setSuccess('')}}><Icon name="trash" size={17}/></button>
            </div>)}
          </div>
          <button type="button" className="dsh-codex-button" disabled={entries.length>=256} onClick={()=>{setEntries(previous=>[...previous,'']);setConfirmation(null)}}><Icon name="plus" size={15}/>添加 IP</button>
        </fieldset>
        <p className="settings-field-help">{settings.firewallManaged?'保存时会同步服务器防火墙。':'若服务器另有防火墙规则，也需允许新增 IP 访问此端口。'}</p>
        <div className="settings-form-actions">
          <button type="submit" className="settings-primary" disabled={saving||loading||!dirty||!normalized.length||!settings.editable||disconnected}>{saving?'正在保存…':'保存白名单'}</button>
          <button type="button" className="dsh-codex-button" disabled={saving||loading||disconnected} onClick={()=>{if(dirty && !window.confirm('重新加载会放弃未保存的白名单更改，确定继续吗？'))return;setSuccess('');void load()}}>重新加载</button>
        </div>
      </form>
    </>}
    {error?<p className="settings-message is-error" role="alert">{error}{!settings?<button type="button" className="dsh-codex-button" onClick={()=>void load()}>重试</button>:null}</p>:null}
    {confirmation?<div className="settings-confirm" role="alert"><strong>当前 IP 将失去访问权限</strong><p>保存后，此设备的请求会被拒绝。请确认可以从其他白名单设备访问。</p><div><button type="button" className="dsh-codex-button" onClick={()=>setConfirmation(null)} disabled={saving}>取消</button><button type="button" className="settings-primary" onClick={()=>void save(true)} disabled={saving}>确认保存并断开当前访问</button></div></div>:null}
    {success?<p className="settings-message is-success" role="status">{success}</p>:null}
  </section>
}
