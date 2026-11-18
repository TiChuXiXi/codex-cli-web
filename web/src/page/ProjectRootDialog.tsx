import * as React from 'react'
import type { Api } from '../rpc'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import { Icon } from '../components/Icon'
import './project-root-dialog.css'

export function ProjectRootDialog({ api, initialSetup = false, onClose, onSaved }: {
  api: Api; initialSetup?: boolean; onClose: () => void; onSaved: (path: string) => void
}) {
  const [path, setPath] = React.useState('')
  const [browse, setBrowse] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const id = React.useId()
  const editPath = (value: string) => { setPath(value); setError('') }
  const submit = async (defer: boolean) => {
    if (busy || (!defer && !path.trim())) return
    if (defer && !initialSetup) { onClose(); return }
    setBusy(true); setError('')
    try {
      const result = await api<{ projectRoot: string }>('router/settings/project-root',
        defer ? { defer: true } : { projectRoot: path.trim() })
      if (defer) onClose()
      else onSaved(result.projectRoot)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '设置父目录失败') }
    finally { setBusy(false) }
  }
  if (browse) return <DirectoryPickerDialog api={api} open selectParent onClose={() => setBrowse(false)}
    onPick={async value => { editPath(value); setBrowse(false) }}/>
  return <div className="dsh-codex-dialog-backdrop">
    <form role="dialog" aria-modal="true" aria-label="设置默认新项目父目录" aria-describedby={id+'-intro'} className="project-root-dialog"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); void submit(true) } }}
      onSubmit={event => { event.preventDefault(); void submit(false) }}>
      <div className="project-root-body">
        <header className="project-root-heading">
          <span className="project-root-mark"><Icon name="folderPlus" size={22}/></span>
          <div><h2>新项目默认位置</h2><p id={id+'-intro'}>中枢会在这里创建或克隆项目。</p></div>
        </header>
        <label htmlFor={id}>新项目父目录</label>
        <div className="project-root-field">
          <input id={id} value={path} placeholder="输入工作台上的绝对路径" autoComplete="off" spellCheck={false}
            aria-describedby={id+'-hint'} disabled={busy} onChange={e => editPath(e.target.value)}/>
          <button type="button" aria-label="浏览目录" disabled={busy} onClick={() => setBrowse(true)}>
            <Icon name="folderOpen" size={16}/>浏览
          </button>
        </div>
        <p className="project-root-hint" id={id+'-hint'}>以后可在「设置 → 中枢」中更改。</p>
        {error && <p className="project-root-error" role="alert"><Icon name="circleAlert" size={15}/>{error}</p>}
      </div>
      <footer className="project-root-actions">
        <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void submit(true)}>稍后设置</button>
        <button type="submit" className="dsh-codex-button primary" disabled={!path.trim() || busy}>保存位置</button>
      </footer>
    </form>
  </div>
}
