import * as React from 'react'
import type { Api } from '../rpc'

interface Status {
  enabled: boolean
  paused?: boolean
  phase: string
  total?: number
  indexed?: number
  projects?: number
  pending?: number
  failed?: number
  lastSynced?: number
  error?: string
  migration?: string
  policy?: number
}
interface Entry {
  id: string
  kind: string
  value: string
  revision: number
  level: string
  threadId?: string
}
interface Profile {
  projects: { id: string; name: string }[]
  entries: Entry[]
}
const phases: Record<string, string> = {
  disabled: '已关闭',
  waiting: '等待 Worker 连接',
  discovering: '正在发现会话',
  indexing: '正在索引消息',
  paused: '已暂停',
  idle: '等待同步',
  failed: '同步失败',
}
export function PsmSettings({ api }: { api: Api }) {
  const [status, setStatus] = React.useState<Status>()
  const [profile, setProfile] = React.useState<Profile>()
  const [project, setProject] = React.useState('')
  const [draft, setDraft] = React.useState<{entry:Entry;target:string;thread:string;text:string}>()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [refresh, update] = React.useReducer((n) => n + 1, 0)
  React.useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const next = await api<Status>('router/psm/status')
        if (active) setStatus(next)
      } catch (e) {
        if (active) setError(String(e))
      }
      if (active) timer = setTimeout(() => void load(), 3000)
    }
    void load()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, refresh])
  React.useEffect(() => {
    let active = true
    if (status?.enabled)
      void api<Profile>('router/psm/profile', { projectId: project })
        .then((value) => {
          if (active) setProfile(value)
        })
        .catch((e) => {
          if (active) setError(String(e))
        })
    return () => {
      active = false
    }
  }, [api, project, refresh, status?.enabled])
  async function act(action: string) {
    const confirmed =
      action === 'rebuild'
        ? window.confirm('重新建立 L1 消息索引？已确认记忆将保留。')
        : action === 'purge'
          ? window.confirm('彻底清除此项目的 PSM 索引与记忆，并停止再次索引？原始项目和会话将保留。')
          : false
    if ((action === 'rebuild' || action === 'purge') && !confirmed) return
    setBusy(true)
    setError('')
    try {
      setStatus(await api<Status>('router/psm/control', { action, projectId: project, confirmed }))
      update()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  async function correct(entry: Entry, remove = false) {
    const value = remove ? entry.value : draft?.text
    if (!value?.trim() || (remove && !window.confirm('撤销这条语义记忆？'))) return
    setBusy(true)
    setError('')
    try {
      await api('router/psm/correct', {
        projectId: remove ? project : draft?.target,
        ...(!remove && {threadId:draft?.thread.trim() || null}),
        entryId: entry.id,
        revision: entry.revision,
        value,
        remove,
      })
      setDraft(undefined)
      update()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const button = (action: string, label: string) => (
    <button type="button" className="dsh-codex-button" disabled={busy} onClick={() => void act(action)}>
      {label}
    </button>
  )
  return (
    <section className="settings-access" aria-label="项目与会话记忆">
      <header>
        <h2>项目与会话记忆</h2>
      </header>
      {status && (
        <>
          <p role="status">
            {phases[status.phase] ?? status.phase}
            {status.enabled && (
              <>
                {' '}
                · {status.projects ?? 0} 个项目 · 已索引 {status.indexed ?? 0}/{status.total ?? 0} 个会话 · 待同步{' '}
                {status.pending ?? 0} · 失败 {status.failed ?? 0}
              </>
            )}
            {status.lastSynced && <> · 最近同步 {new Date(status.lastSynced).toLocaleString()}</>}
          </p>
          {status.enabled && status.policy === 1 && (
            <p>当前服务器上的中枢程序仅支持旧版工具。升级中枢程序后，即可在对话中搜索历史、保存和纠正项目记忆。</p>
          )}
          {status.enabled && status.policy === 2 && status.migration !== 'ready' && (
            <p>{status.migration === 'waiting' ? '等待中枢空闲后切换会话' : status.migration}</p>
          )}
          {button(status.enabled ? 'disable' : 'enable', status.enabled ? '关闭 PSM' : '启用 PSM')}
          {status.enabled && (
            <>
              {button(status.paused ? 'resume' : 'pause', status.paused ? '恢复索引' : '暂停索引')}
              {!status.paused && (
                <>
                  {button('sync', '增量同步')}
                  {!!status.failed || status.phase === 'failed' ? button('retry', '重试失败项') : null}
                </>
              )}
              {button('rebuild', '重建 L1 索引')}
              <p>
                <label>
                  项目档案{' '}
                  <select value={project} onChange={(e) => {setProject(e.target.value);setDraft(undefined);setProfile(undefined)}}>
                    <option value="">选择项目</option>
                    {profile?.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </p>
              {project && (
                <>
                  <ul>
                    {profile?.entries.map((entry) => (
                      <li key={entry.id}>
                        {entry.value} · {entry.level === 'user_confirmed' ? '用户确认' : 'Router 推断'}
                        <button type="button" disabled={busy} onClick={() => setDraft({entry,target:project,thread:entry.threadId ?? '',text:entry.value})}>
                          纠正
                        </button>
                        <button type="button" disabled={busy} onClick={() => void correct(entry, true)}>
                          撤销
                        </button>
                      </li>
                    ))}
                  </ul>
                  {draft && <form onSubmit={event=>{event.preventDefault();void correct(draft.entry)}}>
                    <fieldset className="settings-router-fields" disabled={busy}>
                      <label>记忆内容<input required maxLength={1200} value={draft.text} onChange={event=>setDraft({...draft,text:event.target.value})}/></label>
                      <label>目标项目<select value={draft.target} onChange={event=>setDraft({...draft,target:event.target.value,thread:''})}>
                        {profile?.projects.filter(p=>!p.id.startsWith('source:')).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                      </select></label>
                      <label>关联会话 ID（项目记忆可留空）<input value={draft.thread} onChange={event=>setDraft({...draft,thread:event.target.value})}/></label>
                    </fieldset>
                    <button type="submit" disabled={busy}>保存纠正</button>
                    <button type="button" onClick={()=>setDraft(undefined)}>取消</button>
                  </form>}
                  {button('purge', '彻底清除此项目 PSM 数据')}
                </>
              )}
            </>
          )}
        </>
      )}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </section>
  )
}
