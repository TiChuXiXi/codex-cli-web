import * as React from 'react'
import { randomId } from '../randomId'
import type { Api } from '../rpc'
import { ProjectRootDialog } from './ProjectRootDialog'

export function NewProjectDialog({ api, onCreated, onExisting, onClose }: {
  api: Api; onCreated: (cwd: string, threadId: string) => void; onExisting: () => void; onClose: () => void
}) {
  const [value, setValue] = React.useState('')
  const [root, setRoot] = React.useState<string | null>(null)
  const [settingRoot, setSettingRoot] = React.useState(false)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const request = React.useRef({ value: '', id: '' })
  React.useEffect(() => {
    api<{ projectRoot: string }>('router/settings/read').then(s => setRoot(s.projectRoot)).catch(e => setError(e.message))
  }, [api])
  const input = value.trim()
  const clone = input.startsWith('https://')
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!input || busy) return
    if (request.current.value !== input) request.current = { value: input, id: randomId() }
    setBusy(true); setError('')
    try {
      const data = await api<{ cwd: string; threadId: string }>('router/projects/create',
        { requestId: request.current.id, ...(clone ? { repository: input } : { name: input }) })
      onCreated(data.cwd, data.threadId)
    } catch (e) { setError(e instanceof Error ? e.message : '新建项目失败') }
    finally { setBusy(false) }
  }
  if (settingRoot) return <ProjectRootDialog api={api} onClose={() => setSettingRoot(false)}
    onSaved={path => { setRoot(path); setSettingRoot(false) }}/>
  return <div className="dsh-codex-dialog-backdrop">
    <form className="dsh-codex-dialog dsh-codex-picker" role="dialog" aria-modal="true" aria-label="新建项目"
      onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose() }}>
      <header className="dsh-codex-dialog-head">新建项目</header>
      <label>项目名称或 HTTPS 仓库地址
        <input className="dsh-codex-search" style={{ width: '100%' }} value={value} onChange={e => setValue(e.target.value)} disabled={busy} autoComplete="off"/>
      </label>
      <p className="dsh-codex-hint">新项目父目录　{root === '' ? <button type="button" className="dsh-codex-button"
        onClick={() => setSettingRoot(true)}>设置父目录</button> : root ?? '正在读取…'}</p>
      {error && <p className="dsh-codex-dialog-error" role="alert">{error}</p>}
      <div className="dsh-codex-dialog-actions">
        <button type="button" className="dsh-codex-button" onClick={onExisting} disabled={busy}>使用已有目录</button>
        <button type="button" className="dsh-codex-button" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="dsh-codex-button primary" disabled={!root || !input || busy}>{busy ? '创建中…' : clone ? '克隆并打开' : '创建并打开'}</button>
      </div>
    </form>
  </div>
}
